import crypto from 'crypto'
import path from 'path'
import fsPromises from 'fs/promises'
import { BrowserWindow, ipcMain } from 'electron'
import log from 'electron-log'
import type {
  AiChatMessage,
  AiChatSession,
  AiConnectionInput,
  AiDiscoveredModel,
  AiEditSummary,
  AiImageAttachment,
  AiImageMimeType,
  AiMessageModel,
  AiModelListInput,
  AiModelProfile,
  AiModelRef,
  AiProtocol,
  AiRecoveryInfo,
  AiPreparedRevision,
  AiRequest,
  AiResponse,
  AiRevisionRequest,
  AiSettings,
  AiTestResult,
  AiUndoResult
} from '@shared/types/ai'
import { AI_MAX_IMAGE_BYTES, AI_MAX_IMAGE_COUNT, AI_MAX_IMAGE_TOTAL_BYTES } from '@shared/types/ai'
import { runDocumentEditAgent } from './documentEditAgent'
import { AiAttachmentStore, normalizeImageAttachment, normalizeImageUploads, orderAttachmentLocations } from './attachments'
import { preciseEditTool, serializeProviderMessages, type ProviderImage, type ProviderMessage, type ProviderToolCall, type ProviderToolDefinition } from './providerMessages'
import {
  buildAnswerSystemPrompt,
  buildDocumentPrompt,
  buildMarkdownFormatRepairPrompt,
  buildRewriteSystemPrompt,
  connectionTestSystemPrompt,
  connectionTestUserPrompt,
  makePromptToken,
  previousPreciseEditContextMessage,
  previousRewriteContextMessage
} from './prompts'
import { inspectMarkdown, normalizeGeneratedMarkdown } from './outputRepair'

const DEFAULT_PROTOCOL = 'openai-chat-completions' as const
const SETTINGS_SCHEMA_VERSION = 2
const SETTINGS_FILE = 'ai-connection.json'
const KEY_FILE = 'ai-connection-key.json'
const CHAT_FILE = 'ai-chat.json'
const REVISION_FILE = 'ai-revisions.json'
const ANTHROPIC_VERSION = '2023-06-01'
const MAX_CONTEXT_MESSAGES = 10
const REQUEST_TIMEOUT_MS = 300_000
const ATTACHMENT_GRACE_MS = 24 * 60 * 60 * 1000

interface ProviderResponse {
  content: string
  truncated: boolean
  toolCalls?: ProviderToolCall[]
}

interface ProviderRequestOptions {
  tool?: ProviderToolDefinition
}

interface RepairedMarkdownResult {
  content: string
  recovery: AiRecoveryInfo
}

class ProviderRequestError extends Error {
  readonly status: number
  readonly toolRequest: boolean

  constructor(message: string, status: number, toolRequest: boolean) {
    super(message)
    this.name = 'ProviderRequestError'
    this.status = status
    this.toolRequest = toolRequest
  }
}

const normalizeRevisionMarkdown = (value: string): string => value.replace(/[\r\n]+$/, '')

interface StoredConnection {
  id: string
  name: string
  protocol: AiProtocol
  endpoint: string
  models: AiModelProfile[]
}

interface StoredSettings {
  schemaVersion: typeof SETTINGS_SCHEMA_VERSION
  connections: StoredConnection[]
  defaultModel?: AiModelRef
}

type StoredKeys = Record<string, string>

interface ResolvedModelTarget {
  connection: StoredConnection
  model: AiModelProfile
  apiKey: string
  ref: AiModelRef
  attribution: AiMessageModel
}

interface StoredRevision extends AiPreparedRevision {
  status: 'prepared' | 'committed'
  committedAt?: number
}

interface StoredRevisionState {
  revisions: StoredRevision[]
}

const featureLog = (message: string, ...args: unknown[]): void => {
  log.info(`[ai-editor] ${message}`, ...args)
}

const connectionLog = (message: string, ...args: unknown[]): void => {
  log.info(`[ai-connection] ${message}`, ...args)
}

const normalizeAttachmentList = (value: unknown): AiImageAttachment[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const attachments: AiImageAttachment[] = []
  const ids = new Set<string>()
  for (const item of value.slice(0, AI_MAX_IMAGE_COUNT)) {
    try {
      const attachment = normalizeImageAttachment(item)
      if (ids.has(attachment.id)) continue
      ids.add(attachment.id)
      attachments.push(attachment)
    } catch {
      // Invalid persisted attachment metadata is ignored without rejecting the chat.
    }
  }
  return attachments.length ? attachments : undefined
}

const collectAttachmentIds = (messages: AiChatMessage[]): Set<string> => {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) ids.add(attachment.id)
  }
  return ids
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const readJson = async <T>(filePath: string, fallback: T): Promise<T> => {
  try {
    const value: unknown = JSON.parse(await fsPromises.readFile(filePath, 'utf8'))
    return value as T
  } catch {
    return fallback
  }
}

const writeJsonAtomic = async(filePath: string, value: unknown): Promise<void> => {
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fsPromises.writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  })
  try {
    await fsPromises.rename(tempPath, filePath)
  } catch {
    // Windows cannot replace an existing file with rename in every filesystem
    // configuration; keep the same recoverable temp-file path and retry.
    await fsPromises.unlink(filePath).catch(() => undefined)
    await fsPromises.rename(tempPath, filePath)
  }
  try {
    await fsPromises.chmod(filePath, 0o600)
  } catch {
    // chmod is best effort on filesystems that do not expose POSIX modes.
  }
}

const validateEndpoint = (endpoint: string): string => {
  const value = endpoint.trim()
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error('Endpoint must be a complete HTTPS URL.')
  }
  if (url.protocol !== 'https:') {
    throw new Error('Only HTTPS endpoints are supported.')
  }
  if (!url.hostname) {
    throw new Error('Endpoint must include a hostname.')
  }
  return url.toString()
}

const normalizeModelRef = (value: unknown): AiModelRef | undefined => {
  if (!isRecord(value) || typeof value.connectionId !== 'string' || typeof value.modelId !== 'string') return undefined
  if (!value.connectionId || !value.modelId) return undefined
  return { connectionId: value.connectionId, modelId: value.modelId }
}

const normalizeModelCapabilities = (value: unknown): AiModelProfile['capabilities'] => {
  if (!isRecord(value)) return undefined
  const reasoningControl = value.reasoningControl
  if (reasoningControl !== 'unknown' && reasoningControl !== 'effort' && reasoningControl !== 'budget') return undefined
  return { reasoningControl }
}

const normalizeModelProfile = (value: unknown): AiModelProfile | undefined => {
  if (!isRecord(value) || typeof value.model !== 'string' || !value.model.trim()) return undefined
  const model = value.model.trim()
  const source = value.source === 'discovered' ? 'discovered' : 'manual'
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `model-${crypto.randomUUID()}`,
    model,
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : model,
    source,
    capabilities: normalizeModelCapabilities(value.capabilities)
  }
}

const normalizeStoredConnection = (value: unknown, index: number): StoredConnection | undefined => {
  if (!isRecord(value)) return undefined
  const protocol = value.protocol === 'anthropic-messages' ? 'anthropic-messages' : DEFAULT_PROTOCOL
  const endpoint = typeof value.endpoint === 'string' ? value.endpoint : ''
  const models = Array.isArray(value.models)
    ? value.models.map(model => normalizeModelProfile(model)).filter((model): model is AiModelProfile => !!model)
    : []
  const dedupedModels = Array.from(new Map(models.map(model => [model.model, model])).values())
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `connection-${crypto.randomUUID()}`,
    name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : `Connection ${index + 1}`,
    protocol,
    endpoint,
    models: dedupedModels
  }
}

const normalizeStoredSettings = (value: unknown): { settings: StoredSettings; legacy: boolean } => {
  if (value === undefined) {
    return {
      settings: { schemaVersion: SETTINGS_SCHEMA_VERSION, connections: [] },
      legacy: false
    }
  }
  if (isRecord(value) && Array.isArray(value.connections)) {
    const connections = value.connections
      .map((connection, index) => normalizeStoredConnection(connection, index))
      .filter((connection): connection is StoredConnection => !!connection)
    return {
      settings: {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        connections,
        defaultModel: normalizeModelRef(value.defaultModel)
      },
      legacy: value.schemaVersion !== SETTINGS_SCHEMA_VERSION
    }
  }

  const legacyValue = isRecord(value) ? value : {}
  const legacyModel = typeof legacyValue.model === 'string' ? legacyValue.model.trim() : ''
  const legacyConnection: StoredConnection = {
    id: 'legacy-default',
    name: 'Default connection',
    protocol: legacyValue.protocol === 'anthropic-messages' ? 'anthropic-messages' : DEFAULT_PROTOCOL,
    endpoint: typeof legacyValue.endpoint === 'string' ? legacyValue.endpoint : '',
    models: legacyModel
      ? [{ id: 'legacy-default-model', model: legacyModel, label: legacyModel, source: 'manual' }]
      : []
  }
  return {
    settings: {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      connections: [legacyConnection],
      defaultModel: legacyModel
        ? { connectionId: legacyConnection.id, modelId: legacyConnection.models[0].id }
        : undefined
    },
    legacy: true
  }
}

const normalizeStoredKeys = (value: unknown, settings: StoredSettings): { keys: StoredKeys; legacy: boolean } => {
  if (isRecord(value) && !Array.isArray(value)) {
    const keys: StoredKeys = {}
    for (const [connectionId, apiKey] of Object.entries(value)) {
      if (typeof apiKey === 'string' && apiKey.trim()) keys[connectionId] = apiKey.trim()
    }
    return { keys, legacy: false }
  }
  if (typeof value === 'string' && value.trim() && settings.connections[0]) {
    return { keys: { [settings.connections[0].id]: value.trim() }, legacy: true }
  }
  return { keys: {}, legacy: true }
}

const validateConnectionInput = (input: AiConnectionInput): {
  id: string
  name: string
  protocol: AiProtocol
  endpoint: string
  models: AiModelProfile[]
} => {
  if (input.protocol !== 'openai-chat-completions' && input.protocol !== 'anthropic-messages') {
    throw new Error('Unsupported AI protocol.')
  }
  const endpoint = validateEndpoint(input.endpoint)
  const name = input.name.trim()
  if (!name) throw new Error('Connection name is required.')
  const models = input.models
    .map(model => normalizeModelProfile({ ...model, model: model.model.trim() }))
    .filter((model): model is AiModelProfile => !!model)
  const dedupedModels = Array.from(new Map(models.map(model => [model.model, model])).values())
  return {
    id: input.id?.trim() || `connection-${crypto.randomUUID()}`,
    name,
    protocol: input.protocol,
    endpoint,
    models: dedupedModels
  }
}

const resolveRequestEndpoint = (settings: Pick<StoredConnection, 'protocol' | 'endpoint'>): string => {
  const url = new URL(settings.endpoint)
  const pathname = url.pathname.replace(/\/+$/, '')
  if (settings.protocol === 'openai-chat-completions') {
    if (!pathname.endsWith('/chat/completions')) {
      url.pathname = `${pathname}/chat/completions`
    }
  } else if (!pathname.endsWith('/messages')) {
    url.pathname = pathname.endsWith('/v1')
      ? `${pathname}/messages`
      : `${pathname}/v1/messages`
  }
  return url.toString()
}

const resolveModelsEndpoint = (settings: Pick<StoredConnection, 'protocol' | 'endpoint'>): string => {
  const url = new URL(settings.endpoint)
  const pathname = url.pathname.replace(/\/+$/, '')
  if (settings.protocol === 'openai-chat-completions') {
    url.pathname = pathname.endsWith('/chat/completions')
      ? `${pathname.slice(0, -'/chat/completions'.length)}/models`
      : `${pathname}/models`
  } else {
    url.pathname = pathname.endsWith('/messages')
      ? `${pathname.slice(0, -'/messages'.length)}/models`
      : pathname.endsWith('/v1')
        ? `${pathname}/models`
        : `${pathname}/v1/models`
  }
  return url.toString()
}

const toPublicSettings = (settings: StoredSettings, keys: StoredKeys): AiSettings => ({
  defaultModel: settings.defaultModel,
  connections: settings.connections.map(connection => ({
    ...connection,
    models: connection.models.map(model => ({ ...model })),
    hasApiKey: !!keys[connection.id]
  }))
})

const toMessageModel = (target: ResolvedModelTarget): AiMessageModel => ({ ...target.attribution })

const normalizeMessageModel = (value: unknown): AiMessageModel | undefined => {
  if (!isRecord(value)) return undefined
  if (
    typeof value.connectionId !== 'string' ||
    typeof value.modelId !== 'string' ||
    typeof value.connectionName !== 'string' ||
    typeof value.model !== 'string' ||
    (value.protocol !== 'openai-chat-completions' && value.protocol !== 'anthropic-messages')
  ) return undefined
  return {
    connectionId: value.connectionId,
    modelId: value.modelId,
    connectionName: value.connectionName,
    model: value.model,
    protocol: value.protocol
  }
}

const normalizeMessages = (messages: unknown): AiChatMessage[] => {
  if (!Array.isArray(messages)) return []
  return messages
    .filter((item): item is AiChatMessage => {
      if (!isRecord(item)) return false
      return (
        typeof item.id === 'string' &&
        (item.role === 'user' || item.role === 'assistant') &&
        (item.mode === 'answer' || item.mode === 'edit' || item.mode === 'rewrite') &&
        typeof item.content === 'string' &&
        typeof item.createdAt === 'number'
      )
    })
    .map((item) => {
      const summary = item.editSummary
      const editSummary: AiEditSummary | undefined = isRecord(summary) &&
        typeof summary.operationCount === 'number' &&
        typeof summary.addedLines === 'number' &&
        typeof summary.removedLines === 'number' &&
        Array.isArray(summary.operations)
        ? {
          operationCount: summary.operationCount,
          addedLines: summary.addedLines,
          removedLines: summary.removedLines,
          operations: summary.operations.filter(isRecord).filter(operation =>
            typeof operation.startLine === 'number' &&
            typeof operation.endLine === 'number' &&
            typeof operation.addedLines === 'number' &&
            typeof operation.removedLines === 'number'
          ).map(operation => ({
            startLine: operation.startLine as number,
            endLine: operation.endLine as number,
            addedLines: operation.addedLines as number,
            removedLines: operation.removedLines as number,
            afterStartLine: typeof operation.afterStartLine === 'number'
              ? operation.afterStartLine as number
              : operation.startLine as number,
            afterEndLine: typeof operation.afterEndLine === 'number'
              ? operation.afterEndLine as number
              : operation.endLine as number,
            afterStartOffset: typeof operation.afterStartOffset === 'number'
              ? operation.afterStartOffset as number
              : undefined,
            afterEndOffset: typeof operation.afterEndOffset === 'number'
              ? operation.afterEndOffset as number
              : undefined
          }))
        }
        : undefined
      return {
        ...item,
        revisionId: typeof item.revisionId === 'string' ? item.revisionId : undefined,
        editSummary,
        attachments: normalizeAttachmentList(item.attachments),
        model: normalizeMessageModel(item.model)
      }
    })
    .slice(-MAX_CONTEXT_MESSAGES)
}

const normalizeChatSession = (value: unknown): AiChatSession => {
  if (Array.isArray(value)) return { messages: normalizeMessages(value) }
  if (!isRecord(value)) return { messages: [] }
  return {
    messages: normalizeMessages(value.messages),
    selectedModel: normalizeModelRef(value.selectedModel)
  }
}

const extractText = (payload: unknown): string => {
  if (!isRecord(payload)) return ''
  const choices = payload.choices
  if (Array.isArray(choices)) {
    const message = choices[0]
    if (isRecord(message) && isRecord(message.message)) {
      const content = message.message.content
      if (typeof content === 'string') return content
      if (Array.isArray(content)) {
        return content
          .filter(isRecord)
          .map((part) => (typeof part.text === 'string' ? part.text : ''))
          .join('')
      }
    }
  }
  const content = payload.content
  if (Array.isArray(content)) {
    return content
      .filter(isRecord)
      .map((part) => (typeof part.text === 'string' ? part.text : ''))
      .join('')
  }
  return ''
}

const isTruncatedResponse = (payload: unknown, protocol: AiProtocol): boolean => {
  if (!isRecord(payload)) return false
  if (protocol === 'anthropic-messages') return payload.stop_reason === 'max_tokens'
  const choices = payload.choices
  if (!Array.isArray(choices) || !isRecord(choices[0])) return false
  return choices[0].finish_reason === 'length'
}

export class AiService {
  private readonly settingsPath: string
  private readonly keyPath: string
  private readonly chatPath: string
  private readonly revisionPath: string
  private readonly attachmentStore: AiAttachmentStore
  private readonly pendingAttachmentIds = new Map<string, number>()
  private readonly pendingAttachmentDocuments = new Map<string, string>()
  private readonly attachmentMimeTypes = new Map<string, AiImageMimeType>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly toolCapabilities = new Map<string, boolean>()
  private settingsMutation: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE)
    this.keyPath = path.join(userDataPath, KEY_FILE)
    this.chatPath = path.join(userDataPath, CHAT_FILE)
    this.revisionPath = path.join(userDataPath, REVISION_FILE)
    this.attachmentStore = new AiAttachmentStore(userDataPath)
  }

  private queueSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.settingsMutation.then(operation, operation)
    this.settingsMutation = result.then(() => undefined, () => undefined)
    return result
  }

  private async readSettingsState(): Promise<{ settings: StoredSettings; keys: StoredKeys }> {
    const rawSettings = await readJson<unknown>(this.settingsPath, undefined)
    const normalizedSettings = normalizeStoredSettings(rawSettings)
    const rawKeys = await readJson<unknown>(this.keyPath, undefined)
    const normalizedKeys = normalizeStoredKeys(rawKeys, normalizedSettings.settings)
    if (normalizedSettings.legacy || normalizedKeys.legacy) {
      await writeJsonAtomic(this.settingsPath, normalizedSettings.settings)
      await writeJsonAtomic(this.keyPath, normalizedKeys.keys)
      featureLog('legacy connection settings migrated connectionCount=%s', normalizedSettings.settings.connections.length)
    }
    return { settings: normalizedSettings.settings, keys: normalizedKeys.keys }
  }

  private async resolveModelTarget(modelRef: AiModelRef, state?: { settings: StoredSettings; keys: StoredKeys }): Promise<ResolvedModelTarget> {
    const current = state ?? await this.readSettingsState()
    const connection = current.settings.connections.find(item => item.id === modelRef.connectionId)
    if (!connection) throw new Error('The selected AI connection no longer exists.')
    const model = connection.models.find(item => item.id === modelRef.modelId)
    if (!model) throw new Error('The selected AI model no longer exists.')
    const apiKey = current.keys[connection.id] ?? ''
    if (!apiKey) throw new Error(`Configure an API key for connection "${connection.name}" first.`)
    return {
      connection: { ...connection, models: connection.models.map(item => ({ ...item })) },
      model: { ...model },
      apiKey,
      ref: { ...modelRef },
      attribution: {
        connectionId: connection.id,
        modelId: model.id,
        connectionName: connection.name,
        model: model.model,
        protocol: connection.protocol
      }
    }
  }

  async getSettings(): Promise<AiSettings> {
    const { settings, keys } = await this.readSettingsState()
    return toPublicSettings(settings, keys)
  }

  async saveConnection(input: AiConnectionInput): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      connectionLog(
        'save start connectionId=%s protocol=%s endpoint=%s modelCount=%s',
        input.id ?? 'new',
        input.protocol,
        input.endpoint,
        input.models.length
      )
      const connection = validateConnectionInput(input)
      const current = await this.readSettingsState()
      const connections = current.settings.connections.some(item => item.id === connection.id)
        ? current.settings.connections.map(item => item.id === connection.id ? connection : item)
        : [...current.settings.connections, connection]
      const defaultModel = current.settings.defaultModel && connections.some(item =>
        item.id === current.settings.defaultModel?.connectionId &&
        item.models.some(model => model.id === current.settings.defaultModel?.modelId)
      )
        ? current.settings.defaultModel
        : connection.models[0]
          ? { connectionId: connection.id, modelId: connection.models[0].id }
          : undefined
      const settings: StoredSettings = { schemaVersion: SETTINGS_SCHEMA_VERSION, connections, defaultModel }
      const keys = { ...current.keys }
      if (typeof input.apiKey === 'string' && input.apiKey.trim()) keys[connection.id] = input.apiKey.trim()
      await writeJsonAtomic(this.settingsPath, settings)
      await writeJsonAtomic(this.keyPath, keys)
      connectionLog('save succeeded connectionId=%s modelCount=%s', connection.id, connection.models.length)
      return toPublicSettings(settings, keys)
    })
  }

  async deleteConnection(connectionId: string): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      const connections = current.settings.connections.filter(connection => connection.id !== connectionId)
      if (connections.length === current.settings.connections.length) return toPublicSettings(current.settings, current.keys)
      const keys = { ...current.keys }
      delete keys[connectionId]
      const fallbackConnection = connections.find(connection => connection.models.length > 0)
      const defaultModel = current.settings.defaultModel?.connectionId === connectionId
        ? fallbackConnection
          ? { connectionId: fallbackConnection.id, modelId: fallbackConnection.models[0].id }
          : undefined
        : current.settings.defaultModel
      const settings: StoredSettings = { schemaVersion: SETTINGS_SCHEMA_VERSION, connections, defaultModel }
      await writeJsonAtomic(this.settingsPath, settings)
      await writeJsonAtomic(this.keyPath, keys)
      featureLog('connection deleted connectionId=%s', connectionId)
      return toPublicSettings(settings, keys)
    })
  }

  async deleteConnectionKey(connectionId: string): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      const keys = { ...current.keys }
      delete keys[connectionId]
      await writeJsonAtomic(this.keyPath, keys)
      featureLog('connection key deleted connectionId=%s', connectionId)
      return toPublicSettings(current.settings, keys)
    })
  }

  async setDefaultModel(modelRef: AiModelRef | null): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      if (modelRef) {
        try {
          await this.resolveModelTarget(modelRef, current)
        } catch (error) {
          if (!(error instanceof Error && error.message.includes('API key'))) throw error
        }
      }
      const settings: StoredSettings = {
        ...current.settings,
        defaultModel: modelRef ?? undefined
      }
      await writeJsonAtomic(this.settingsPath, settings)
      return toPublicSettings(settings, current.keys)
    })
  }

  async testConnection(input: AiConnectionInput): Promise<AiTestResult> {
    connectionLog(
      'test start connectionId=%s protocol=%s endpoint=%s modelCount=%s',
      input.id ?? 'new',
      input.protocol,
      input.endpoint,
      input.models.length
    )
    try {
      const connection = validateConnectionInput(input)
      const current = await this.readSettingsState()
      const apiKey = input.apiKey?.trim() || (input.id ? current.keys[input.id] : '') || ''
      const model = connection.models[0]
      if (!model) throw new Error('Add at least one model before testing the connection.')
      await this.requestProvider({
        connection,
        model,
        apiKey,
        ref: { connectionId: connection.id, modelId: model.id },
        attribution: {
          connectionId: connection.id,
          modelId: model.id,
          connectionName: connection.name,
          model: model.model,
          protocol: connection.protocol
        }
      }, connectionTestSystemPrompt, [{ role: 'user', content: connectionTestUserPrompt }], `test-${crypto.randomUUID()}`)
      connectionLog('test succeeded connectionId=%s model=%s', connection.id, model.model)
      return { ok: true, message: 'Connection succeeded.' }
    } catch (error) {
      connectionLog('test failed errorName=%s', error instanceof Error ? error.name : 'unknown')
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  async listModels(input: AiModelListInput): Promise<AiDiscoveredModel[]> {
    connectionLog(
      'model discovery start connectionId=%s protocol=%s endpoint=%s',
      input.connectionId ?? 'new',
      input.protocol,
      input.endpoint
    )
    const protocol = input.protocol
    const endpoint = validateEndpoint(input.endpoint)
    const current = await this.readSettingsState()
    const apiKey = input.apiKey?.trim() || (input.connectionId ? current.keys[input.connectionId] : '') || ''
    if (!apiKey) throw new Error('Configure an API key before refreshing models.')
    const requestEndpoint = resolveModelsEndpoint({ protocol, endpoint })
    const headers: Record<string, string> = { accept: 'application/json' }
    if (protocol === 'anthropic-messages') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = ANTHROPIC_VERSION
    } else {
      headers.authorization = `Bearer ${apiKey}`
      headers['api-key'] = apiKey
    }
    const response = await fetch(requestEndpoint, { method: 'GET', headers, redirect: 'error' })
    const text = await response.text()
    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      payload = null
    }
    if (!response.ok) throw new Error(`Model discovery failed with HTTP ${response.status}.`)
    const values = isRecord(payload) && Array.isArray(payload.data)
      ? payload.data
      : isRecord(payload) && Array.isArray(payload.models)
        ? payload.models
        : []
    const models = values.filter(isRecord).map(item => {
      const model = typeof item.id === 'string' ? item.id : typeof item.name === 'string' ? item.name : ''
      return {
        model,
        label: typeof item.display_name === 'string'
          ? item.display_name
          : typeof item.name === 'string' ? item.name : undefined,
        ownedBy: typeof item.owned_by === 'string' ? item.owned_by : undefined
      }
    }).filter(item => !!item.model)
    connectionLog('model discovery succeeded connectionId=%s modelCount=%s', input.connectionId ?? 'new', models.length)
    return models
  }

  private async requestProvider(
    target: ResolvedModelTarget,
    system: string,
    messages: ProviderMessage[],
    requestId: string,
    signal?: AbortSignal,
    options: ProviderRequestOptions = {}
  ): Promise<ProviderResponse> {
    const settings = target.connection
    const model = target.model.model
    const apiKey = target.apiKey
    if (!apiKey) throw new Error('Configure an API key in AI settings first.')
    if (!settings.endpoint || !model) {
      throw new Error('Configure an AI endpoint and model first.')
    }
    const requestEndpoint = resolveRequestEndpoint(settings)
    featureLog(
      'request start protocol=%s endpoint=%s model=%s requestId=%s',
      settings.protocol,
      requestEndpoint,
      model,
      requestId
    )
    const controller = new AbortController()
    const abortFromParent = () => controller.abort()
    if (signal) {
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', abortFromParent, { once: true })
    } else {
      this.controllers.set(requestId, controller)
    }
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      featureLog(
        'request timeout protocol=%s endpoint=%s model=%s requestId=%s timeoutMs=%s',
        settings.protocol,
        requestEndpoint,
        model,
        requestId,
        REQUEST_TIMEOUT_MS
      )
      controller.abort()
    }, REQUEST_TIMEOUT_MS)
    try {
      const headers: Record<string, string> = {
        accept: 'application/json',
        'content-type': 'application/json'
      }
      let body: Record<string, unknown>
      if (settings.protocol === 'anthropic-messages') {
        headers['x-api-key'] = apiKey
        headers['api-key'] = apiKey
        headers['anthropic-version'] = ANTHROPIC_VERSION
        body = { model, max_tokens: 4096, system, messages: serializeProviderMessages(settings.protocol, messages) }
        if (options.tool) {
          body.tools = [{ name: options.tool.name, description: options.tool.description, input_schema: options.tool.parameters }]
          body.tool_choice = { type: 'tool', name: options.tool.name }
        }
      } else {
        headers.authorization = `Bearer ${apiKey}`
        // Some OpenAI-compatible gateways, including MiMo Token Plan, document
        // `api-key` instead of the standard Authorization header.
        headers['api-key'] = apiKey
        body = { model, messages: [{ role: 'system', content: system }, ...serializeProviderMessages(settings.protocol, messages)] }
        if (options.tool) {
          body.tools = [{ type: 'function', function: { name: options.tool.name, description: options.tool.description, parameters: options.tool.parameters } }]
          body.tool_choice = { type: 'function', function: { name: options.tool.name } }
        }
      }
      const response = await fetch(requestEndpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal
      })
      featureLog(
        'request response status=%s protocol=%s endpoint=%s model=%s requestId=%s',
        response.status,
        settings.protocol,
        requestEndpoint,
        model,
        requestId
      )
      const text = await response.text()
      let payload: unknown
      try {
        payload = JSON.parse(text)
      } catch {
        payload = null
      }
      if (!response.ok) {
        const providerMessage = isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === 'string'
          ? payload.error.message
          : `Provider returned HTTP ${response.status}.`
        const visionHint = messages.some(message => !!message.images?.length)
          ? ' The configured model or endpoint may not support image input.'
          : ''
        throw new ProviderRequestError(`Provider returned HTTP ${response.status} from ${requestEndpoint}. ${providerMessage}${visionHint}`, response.status, !!options.tool)
      }
      const content = extractText(payload)
      const toolCalls = extractToolCalls(payload, settings.protocol)
      if (!content && !toolCalls.length) throw new Error('The provider returned no text content.')
      return { content, toolCalls, truncated: isTruncatedResponse(payload, settings.protocol) }
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        if (timedOut) {
          throw new Error(`AI provider request timed out after ${REQUEST_TIMEOUT_MS / 1000} seconds.`)
        }
        featureLog(
          'request cancelled protocol=%s endpoint=%s model=%s requestId=%s',
          settings.protocol,
          requestEndpoint,
          model,
          requestId
        )
        throw new Error('AI request was cancelled.')
      }
      const hasImages = messages.some(message => !!message.images?.length)
      if (hasImages) {
        featureLog(
          'request error name=%s protocol=%s requestId=%s',
          error instanceof Error ? error.name : 'unknown',
          settings.protocol,
          requestId
        )
      } else {
        featureLog(
          'request error name=%s message=%s protocol=%s endpoint=%s model=%s requestId=%s',
          error instanceof Error ? error.name : 'unknown',
          error instanceof Error ? error.message : String(error),
          settings.protocol,
          requestEndpoint,
          model,
          requestId
        )
      }
      throw error
    } finally {
      clearTimeout(timeout)
      if (signal) signal.removeEventListener('abort', abortFromParent)
      else this.controllers.delete(requestId)
    }
  }

  private async pruneAttachments(graceMs = ATTACHMENT_GRACE_MS): Promise<void> {
    const all = await readJson<Record<string, unknown>>(this.chatPath, {})
    const referenced = new Set<string>()
    for (const value of Object.values(all)) {
      for (const id of collectAttachmentIds(normalizeChatSession(value).messages)) referenced.add(id)
    }
    const now = Date.now()
    for (const [id, expiresAt] of this.pendingAttachmentIds) {
      if (expiresAt > now) referenced.add(id)
      else {
        this.pendingAttachmentIds.delete(id)
        this.pendingAttachmentDocuments.delete(id)
        this.attachmentMimeTypes.delete(id)
      }
    }
    await this.attachmentStore.prune(referenced, graceMs)
  }

  private async saveRequestAttachments(uploads: unknown, documentId: string): Promise<AiImageAttachment[]> {
    const normalized = normalizeImageUploads(uploads)
    if (!normalized.length) return []
    const saved = await this.attachmentStore.save(normalized)
    const expiresAt = Date.now() + ATTACHMENT_GRACE_MS
    for (const attachment of saved) {
      this.pendingAttachmentIds.set(attachment.id, expiresAt)
      this.pendingAttachmentDocuments.set(attachment.id, documentId)
      this.attachmentMimeTypes.set(attachment.id, attachment.mimeType)
    }
    featureLog(
      'request attachments saved count=%s bytes=%s',
      saved.length,
      saved.reduce((total, attachment) => total + attachment.byteSize, 0)
    )
    return saved
  }

  private async hydrateProviderMessages(
    messages: Array<{ role: 'user' | 'assistant'; content: string; attachments?: AiImageAttachment[] }>,
    priorityAttachmentIds: ReadonlySet<string> = new Set()
  ): Promise<ProviderMessage[]> {
    const imagesByMessage = new Map<number, ProviderImage[]>()
    const selected = new Set<string>()
    let imageCount = 0
    let totalBytes = 0
    const addAttachment = async(
      index: number,
      attachment: AiImageAttachment,
      required: boolean
    ): Promise<void> => {
      if (selected.has(attachment.id)) return
      if (imageCount >= AI_MAX_IMAGE_COUNT || totalBytes + attachment.byteSize > AI_MAX_IMAGE_TOTAL_BYTES) {
        if (required) throw new Error('The selected images exceed the image context limit.')
        return
      }
      try {
        const stored = await this.attachmentStore.read(attachment.id, attachment.mimeType)
        if (stored.data.byteLength > AI_MAX_IMAGE_BYTES) throw new Error('Image is too large.')
        if (totalBytes + stored.data.byteLength > AI_MAX_IMAGE_TOTAL_BYTES) {
          if (required) throw new Error('The selected images exceed the image context limit.')
          return
        }
        selected.add(attachment.id)
        imageCount += 1
        totalBytes += stored.data.byteLength
        const images = imagesByMessage.get(index) ?? []
        images.push({ mimeType: stored.mimeType, data: Buffer.from(stored.data).toString('base64') })
        imagesByMessage.set(index, images)
      } catch (error) {
        if (required) throw new Error(`The current image attachment could not be read. ${error instanceof Error ? error.message : String(error)}`)
        featureLog('historical image attachment skipped reason=%s', error instanceof Error ? error.message : String(error))
      }
    }

    const ordered = orderAttachmentLocations(messages, priorityAttachmentIds)
    if (ordered.missing.length) throw new Error('The current image attachment was not found.')
    for (const location of ordered.locations) {
      await addAttachment(location.index, location.attachment, location.required)
    }
    return messages.map((message, index) => ({
      role: message.role,
      content: message.content,
      images: imagesByMessage.get(index)
    }))
  }

  private async repairMarkdownResponse(
    target: ResolvedModelTarget,
    system: string,
    messages: ProviderMessage[],
    generated: ProviderResponse,
    requestId: string,
    signal: AbortSignal | undefined,
    stripOuterFence: boolean,
    strict: boolean
  ): Promise<RepairedMarkdownResult> {
    const normalized = normalizeGeneratedMarkdown(generated.content, { stripOuterFence })
    if (!normalized.content.trim()) throw new Error('The model returned an empty document.')
    const inspection = inspectMarkdown(normalized.content)
    if (!inspection.issues.length) {
      return {
        content: normalized.content.trim(),
        recovery: {
          strategy: normalized.changes.length ? 'local-normalization' : 'direct',
          attempts: 1,
          changes: normalized.changes.length ? normalized.changes : undefined
        }
      }
    }
    const failure = inspection.issues.map(issue => issue.message).join(' ')
    try {
      const repaired = await this.requestProvider(
        target,
        system,
        [
          ...messages,
          { role: 'assistant', content: generated.content },
          { role: 'user', content: buildMarkdownFormatRepairPrompt(failure) }
        ],
        requestId,
        signal
      )
      const repairedNormalized = normalizeGeneratedMarkdown(repaired.content, { stripOuterFence })
      const repairedInspection = inspectMarkdown(repairedNormalized.content)
      if (repairedInspection.issues.length) throw new Error(repairedInspection.issues.map(issue => issue.message).join(' '))
      return {
        content: repairedNormalized.content.trim(),
        recovery: {
          strategy: 'model-repair',
          attempts: 2,
          changes: repairedNormalized.changes.length ? repairedNormalized.changes : undefined
        }
      }
    } catch (error) {
      if (!strict) {
        return {
          content: normalized.content.trim(),
          recovery: {
            strategy: normalized.changes.length ? 'local-normalization' : 'direct',
            attempts: 2,
            changes: normalized.changes.length ? normalized.changes : undefined,
            warning: `The response still contains non-standard Markdown: ${error instanceof Error ? error.message : String(error)}`
          }
        }
      }
      throw error
    }
  }

  async readAttachment(documentId: string, attachmentId: string): Promise<{ mimeType: AiImageMimeType; data: Uint8Array }> {
    const all = await readJson<Record<string, unknown>>(this.chatPath, {})
    const messages = normalizeChatSession(all[documentId]).messages
    const metadata = messages.flatMap(message => message.attachments ?? []).find(attachment => attachment.id === attachmentId)
    const mimeType = metadata?.mimeType ?? this.attachmentMimeTypes.get(attachmentId)
    if (!mimeType) throw new Error('Image attachment was not found.')
    return this.attachmentStore.read(attachmentId, mimeType)
  }

  async request(request: AiRequest): Promise<AiResponse> {
    if (!request.requestId || !request.documentId) throw new Error('Invalid AI request.')
    const state = await this.readSettingsState()
    const target = await this.resolveModelTarget(request.modelRef, state)
    const settings = target.connection
    const currentAttachments = await this.saveRequestAttachments(request.attachments, request.documentId)
    const priorityAttachmentIds = new Set(currentAttachments.map(attachment => attachment.id))
    const recentMessages = normalizeMessages(request.messages).map(({ role, mode, content, attachments }) => ({
      role,
      content: content || (mode === 'rewrite' ? previousRewriteContextMessage : previousPreciseEditContextMessage),
      attachments
    }))
    let documentKind = 'unknown'
    if (request.documentId.startsWith('path:')) documentKind = 'path'
    else if (request.documentId.startsWith('tab:')) documentKind = 'tab'
    featureLog(
      'request input mode=%s documentKind=%s markdownChars=%s contextMessages=%s imageCount=%s imageBytes=%s requestId=%s',
      request.mode,
      documentKind,
      request.markdown.length,
      recentMessages.length,
      currentAttachments.length,
      currentAttachments.reduce((total, attachment) => total + attachment.byteSize, 0),
      request.requestId
    )
    if (request.mode === 'answer') {
      const promptToken = makePromptToken('MT_CONTEXT')
      const messages = await this.hydrateProviderMessages([
        ...recentMessages,
        { role: 'user', content: buildDocumentPrompt(request.prompt, request.markdown, promptToken), attachments: currentAttachments }
      ], priorityAttachmentIds)
      const result = await this.requestProvider(
        target,
        buildAnswerSystemPrompt(promptToken),
        messages,
        request.requestId
      )
      const repaired = await this.repairMarkdownResponse(
        target,
        buildAnswerSystemPrompt(promptToken),
        messages,
        result,
        request.requestId,
        undefined,
        false,
        false
      )
      featureLog(
        'request content received mode=%s contentChars=%s requestId=%s',
        request.mode,
        result.content.length,
        request.requestId
      )
      return {
        requestId: request.requestId,
        mode: request.mode,
        content: repaired.content,
        recovery: repaired.recovery,
        documentId: request.documentId,
        baseMarkdown: request.markdown,
        model: toMessageModel(target)
      }
    }

    const controller = new AbortController()
    this.controllers.set(request.requestId, controller)
    try {
      if (request.mode === 'rewrite') {
        const promptToken = makePromptToken('MT_CONTEXT')
        const messages = await this.hydrateProviderMessages([
          ...recentMessages,
          { role: 'user', content: buildDocumentPrompt(request.prompt, request.markdown, promptToken), attachments: currentAttachments }
        ], priorityAttachmentIds)
        const result = await this.requestProvider(
          target,
          buildRewriteSystemPrompt(promptToken),
          messages,
          request.requestId,
          controller.signal
        )
        if (result.truncated) throw new Error('The model response was truncated before a complete document was returned.')
        const repaired = await this.repairMarkdownResponse(
          target,
          buildRewriteSystemPrompt(promptToken),
          messages,
          result,
          request.requestId,
          controller.signal,
          true,
          true
        )
        const markdown = repaired.content
        featureLog(
          'request content received mode=%s contentChars=%s requestId=%s',
          request.mode,
          markdown.length,
          request.requestId
        )
        return {
          requestId: request.requestId,
          mode: request.mode,
          content: '',
          markdown,
          recovery: repaired.recovery,
          documentId: request.documentId,
          baseMarkdown: request.markdown,
          model: toMessageModel(target)
        }
      }

      const result = await runDocumentEditAgent({
        markdown: request.markdown,
        instruction: request.prompt,
        contextMessages: recentMessages,
        attachments: currentAttachments,
        generateTool: async(agentRequest) => {
          const hasImages = agentRequest.messages.some(message => !!message.attachments?.length)
          const capabilityKey = `${settings.protocol}|${resolveRequestEndpoint(settings)}|${target.model.model}|${hasImages ? 'image' : 'text'}`
          if (this.toolCapabilities.get(capabilityKey) === false) return { content: '', toolUnsupported: true }
          const messages = await this.hydrateProviderMessages(agentRequest.messages, priorityAttachmentIds)
          try {
            const generated = await this.requestProvider(
              target,
              `${agentRequest.system}\nWhen the submit_markdown_edits tool is available, call it exactly once with the validated edit object instead of writing the text protocol. Do not emit prose or a text protocol outside the tool call.`,
              messages,
              agentRequest.requestId,
              agentRequest.signal,
              { tool: preciseEditTool }
            )
            this.toolCapabilities.set(capabilityKey, true)
            return { content: generated.content, toolCalls: generated.toolCalls, truncated: generated.truncated }
          } catch (error) {
            if (error instanceof ProviderRequestError && [400, 404, 422].includes(error.status)) {
              this.toolCapabilities.set(capabilityKey, false)
              featureLog('output repair tool capability unavailable protocol=%s model=%s requestId=%s', settings.protocol, target.model.model, agentRequest.requestId)
              return { content: '', toolUnsupported: true }
            }
            throw error
          }
        },
        requestId: request.requestId,
        signal: controller.signal,
        generate: async(agentRequest) => {
          const messages = await this.hydrateProviderMessages(agentRequest.messages, priorityAttachmentIds)
          const generated = await this.requestProvider(
            target,
            agentRequest.system,
            messages,
            agentRequest.requestId,
            agentRequest.signal
          )
          return { content: generated.content, truncated: generated.truncated }
        },
        generateWhole: async(agentRequest) => {
          const messages = await this.hydrateProviderMessages(agentRequest.messages, priorityAttachmentIds)
          const generated = await this.requestProvider(
            target,
            agentRequest.system,
            messages,
            agentRequest.requestId,
            agentRequest.signal
          )
          return { content: generated.content, truncated: generated.truncated }
        },
        onValidationFailure: diagnostic => {
          featureLog(
            'edit agent validation failure attempt=%s code=%s error=%s responseChars=%s responseLines=%s summaryMarkers=%s searchMarkers=%s dividerMarkers=%s replaceMarkers=%s requestId=%s',
            diagnostic.attempt,
            diagnostic.code ?? 'contract',
            diagnostic.error,
            diagnostic.responseChars,
            diagnostic.responseLines,
            diagnostic.summaryMarkers,
            diagnostic.searchMarkers,
            diagnostic.dividerMarkers,
            diagnostic.replaceMarkers,
            request.requestId
          )
        }
      })
      featureLog(
        'edit agent applied mode=%s attempts=%s operations=%s addedLines=%s removedLines=%s requestId=%s',
        request.mode,
        result.attempts,
        result.summary.operationCount,
        result.summary.addedLines,
        result.summary.removedLines,
        request.requestId
      )
      return {
        requestId: request.requestId,
        mode: request.mode,
        content: '',
        summary: result.message,
        markdown: result.markdown,
        editSummary: result.summary,
        recovery: result.recovery,
        documentId: request.documentId,
        baseMarkdown: request.markdown,
        model: toMessageModel(target)
      }
    } finally {
      this.controllers.delete(request.requestId)
    }
  }

  cancel(requestId: string): void {
    if (this.controllers.has(requestId)) {
      featureLog('request cancel requested requestId=%s', requestId)
      this.controllers.get(requestId)?.abort()
    }
  }

  async loadChat(documentId: string): Promise<AiChatSession> {
    const all = await readJson<Record<string, unknown>>(this.chatPath, {})
    return normalizeChatSession(all[documentId])
  }

  async saveChat(documentId: string, session: AiChatSession): Promise<void> {
    const all = await readJson<Record<string, unknown>>(this.chatPath, {})
    const normalized: AiChatSession = {
      messages: normalizeMessages(session.messages),
      selectedModel: normalizeModelRef(session.selectedModel)
    }
    all[documentId] = normalized
    for (const [id, pendingDocumentId] of this.pendingAttachmentDocuments) {
      if (pendingDocumentId === documentId) {
        this.pendingAttachmentIds.delete(id)
        this.pendingAttachmentDocuments.delete(id)
        this.attachmentMimeTypes.delete(id)
      }
    }
    await writeJsonAtomic(this.chatPath, all)
    await this.pruneAttachments(0).catch(error => featureLog('attachment cleanup skipped reason=%s', error instanceof Error ? error.message : String(error)))
  }

  async clearChat(documentId: string): Promise<void> {
    const all = await readJson<Record<string, unknown>>(this.chatPath, {})
    delete all[documentId]
    await writeJsonAtomic(this.chatPath, all)
    await this.pruneAttachments(0).catch(error => featureLog('attachment cleanup skipped reason=%s', error instanceof Error ? error.message : String(error)))
  }

  async cleanupAttachments(): Promise<void> {
    await this.pruneAttachments(0).catch(error => featureLog('attachment cleanup skipped reason=%s', error instanceof Error ? error.message : String(error)))
  }

  private async readRevisions(): Promise<StoredRevisionState> {
    const state = await readJson<StoredRevisionState>(this.revisionPath, { revisions: [] })
    return { revisions: Array.isArray(state.revisions) ? state.revisions : [] }
  }

  async prepareRevision(request: AiRevisionRequest): Promise<AiPreparedRevision> {
    if (!request.documentId) throw new Error('Invalid document identity.')
    const revision: StoredRevision = {
      ...request,
      revisionId: crypto.randomUUID(),
      preparedAt: Date.now(),
      status: 'prepared'
    }
    const state = await this.readRevisions()
    state.revisions.push(revision)
    await writeJsonAtomic(this.revisionPath, state)
    featureLog(
      'revision prepared revisionId=%s beforeChars=%s afterChars=%s',
      revision.revisionId,
      revision.beforeMarkdown.length,
      revision.afterMarkdown.length
    )
    return revision
  }

  async commitRevision(revisionId: string, documentId: string, afterMarkdown: string): Promise<void> {
    const state = await this.readRevisions()
    const revision = state.revisions.find((item) => item.revisionId === revisionId)
    if (!revision || revision.documentId !== documentId) throw new Error('Revision is no longer valid.')
    // Muya may normalize Markdown while applying a replacement. The renderer
    // sends that serialized result back, which is the canonical content for
    // undo and must replace the model's pre-serialization output.
    revision.afterMarkdown = afterMarkdown
    revision.status = 'committed'
    revision.committedAt = Date.now()
    await writeJsonAtomic(this.revisionPath, state)
    featureLog(
      'revision committed revisionId=%s afterChars=%s',
      revisionId,
      afterMarkdown.length
    )
  }

  async discardRevision(revisionId: string): Promise<void> {
    const state = await this.readRevisions()
    const nextRevisions = state.revisions.filter(item => item.revisionId !== revisionId || item.status !== 'prepared')
    if (nextRevisions.length === state.revisions.length) return
    await writeJsonAtomic(this.revisionPath, { revisions: nextRevisions })
    featureLog('revision discarded revisionId=%s', revisionId)
  }

  async undoRevision(documentId: string, currentMarkdown: string): Promise<AiUndoResult | null> {
    const state = await this.readRevisions()
    const revision = [...state.revisions]
      .reverse()
      .find((item) => item.documentId === documentId && item.status === 'committed')
    if (!revision || normalizeRevisionMarkdown(revision.afterMarkdown) !== normalizeRevisionMarkdown(currentMarkdown)) return null
    const inverse: StoredRevision = {
      revisionId: crypto.randomUUID(),
      documentId,
      beforeMarkdown: currentMarkdown,
      afterMarkdown: revision.beforeMarkdown,
      mode: 'edit',
      preparedAt: Date.now(),
      status: 'committed',
      committedAt: Date.now()
    }
    state.revisions.push(inverse)
    await writeJsonAtomic(this.revisionPath, state)
    return {
      revisionId: inverse.revisionId,
      documentId,
      beforeMarkdown: inverse.beforeMarkdown,
      afterMarkdown: inverse.afterMarkdown
    }
  }

  async migrateDocumentIdentity(fromDocumentId: string, toDocumentId: string): Promise<void> {
    if (!fromDocumentId || !toDocumentId || fromDocumentId === toDocumentId) return
    const chats = await readJson<Record<string, unknown>>(this.chatPath, {})
    if (chats[fromDocumentId] !== undefined) {
      chats[toDocumentId] = chats[toDocumentId] ?? chats[fromDocumentId]
      delete chats[fromDocumentId]
      await writeJsonAtomic(this.chatPath, chats)
    }
    const state = await this.readRevisions()
    let changed = false
    for (const revision of state.revisions) {
      if (revision.documentId === fromDocumentId) {
        revision.documentId = toDocumentId
        changed = true
      }
    }
    if (changed) await writeJsonAtomic(this.revisionPath, state)
    await this.pruneAttachments(0).catch(error => featureLog('attachment cleanup skipped reason=%s', error instanceof Error ? error.message : String(error)))
  }
}

const parseToolInput = (value: unknown): unknown => {
  if (isRecord(value)) return value
  if (typeof value !== 'string') return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const extractToolCalls = (payload: unknown, protocol: AiProtocol): ProviderToolCall[] => {
  if (!isRecord(payload)) return []
  if (protocol === 'anthropic-messages') {
    const content = payload.content
    if (!Array.isArray(content)) return []
    return content
      .filter(isRecord)
      .filter(part => part.type === 'tool_use' && typeof part.name === 'string')
      .map(part => ({ name: part.name as string, input: parseToolInput(part.input) }))
      .filter(call => call.input !== undefined)
  }
  const choices = payload.choices
  if (!Array.isArray(choices) || !isRecord(choices[0]) || !isRecord(choices[0].message)) return []
  const toolCalls = choices[0].message.tool_calls
  if (!Array.isArray(toolCalls)) return []
  return toolCalls
    .filter(isRecord)
    .map(call => {
      const functionCall = isRecord(call.function) ? call.function : undefined
      return {
        name: functionCall && typeof functionCall.name === 'string' ? functionCall.name : '',
        input: parseToolInput(functionCall?.arguments)
      }
    })
    .filter(call => !!call.name && call.input !== undefined)
}

export const registerAiIpcHandlers = (userDataPath: string): void => {
  const aiService = new AiService(userDataPath)
  const broadcastSettings = (settings: AiSettings): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      if (!window.isDestroyed()) window.webContents.send('mt::ai-settings-changed', settings)
    }
  }
  ipcMain.handle('mt::ai::get-settings', () => aiService.getSettings())
  ipcMain.handle('mt::ai::save-connection', async(_event, connection: AiConnectionInput) => {
    const saved = await aiService.saveConnection(connection)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::delete-connection', async(_event, connectionId: string) => {
    const saved = await aiService.deleteConnection(connectionId)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::delete-connection-key', async(_event, connectionId: string) => {
    const saved = await aiService.deleteConnectionKey(connectionId)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::set-default-model', async(_event, modelRef) => {
    const saved = await aiService.setDefaultModel(modelRef)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::test-connection', (_event, connection: AiConnectionInput) => aiService.testConnection(connection))
  ipcMain.handle('mt::ai::list-models', (_event, connection: AiModelListInput) => aiService.listModels(connection))
  ipcMain.handle('mt::ai::request', (_event, request: AiRequest) => aiService.request(request))
  ipcMain.on('mt::ai::cancel', (_event, requestId: string) => aiService.cancel(requestId))
  ipcMain.handle('mt::ai::chat-load', (_event, documentId: string) => aiService.loadChat(documentId))
  ipcMain.handle('mt::ai::chat-save', (_event, documentId: string, session: AiChatSession) => aiService.saveChat(documentId, session))
  ipcMain.handle('mt::ai::chat-clear', (_event, documentId: string) => aiService.clearChat(documentId))
  ipcMain.handle('mt::ai::attachment-read', (_event, documentId: string, attachmentId: string) => aiService.readAttachment(documentId, attachmentId))
  ipcMain.handle('mt::ai::revision-prepare', (_event, request: AiRevisionRequest) => aiService.prepareRevision(request))
  ipcMain.handle('mt::ai::revision-commit', (_event, revisionId: string, documentId: string, afterMarkdown: string) => aiService.commitRevision(revisionId, documentId, afterMarkdown))
  ipcMain.handle('mt::ai::revision-discard', (_event, revisionId: string) => aiService.discardRevision(revisionId))
  ipcMain.handle('mt::ai::revision-undo', (_event, documentId: string, currentMarkdown: string) => aiService.undoRevision(documentId, currentMarkdown))
  ipcMain.handle('mt::ai::revision-migrate', (_event, fromDocumentId: string, toDocumentId: string) => aiService.migrateDocumentIdentity(fromDocumentId, toDocumentId))
  aiService.cleanupAttachments().catch(error => featureLog('startup attachment cleanup skipped reason=%s', error instanceof Error ? error.message : String(error)))
  featureLog('IPC handlers registered')
}
