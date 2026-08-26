import crypto from 'crypto'
import type {
  AiConnectionInput,
  AiJsonValue,
  AiModelProfile,
  AiModelRef,
  AiReasoningEffort,
  AiReasoningEffortPreference,
  AiReasoningField,
  AiReasoningTag,
  AiRequestBodyPreset,
  AiResponsesModelOptions,
  AiSettings,
  AiVerbosity,
  AiVerbosityPreference
} from '@shared/types/ai'
import type { StoredConnection, StoredKeys, StoredSettings } from './types'
import { isRecord } from './utils'

export const SETTINGS_SCHEMA_VERSION = 8
export const DEFAULT_EDIT_AUTO_RETRY_COUNT = 1
export const MAX_EDIT_AUTO_RETRY_COUNT = 3
export const DEFAULT_EDIT_AGENT_MAX_STEPS = 64
export const MAX_EDIT_AGENT_MAX_STEPS = 128
export const DEFAULT_FAILURE_OUTPUT_AFTER = 1
export const MAX_FAILURE_OUTPUT_AFTER = 3
export const DEFAULT_CONTEXT_MODE = 'recent' as const
export const MAX_REQUEST_BODY_PRESETS = 16
export const MAX_REQUEST_BODY_PRESET_NAME_LENGTH = 64
export const MAX_REQUEST_BODY_PRESET_BYTES = 16 * 1024
export const MAX_REQUEST_BODY_PRESET_DEPTH = 8

export const normalizeEditAutoRetryCount = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_EDIT_AUTO_RETRY_COUNT
  return Math.min(MAX_EDIT_AUTO_RETRY_COUNT, Math.max(0, Math.floor(value)))
}

export const normalizeEditAgentMaxSteps = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_EDIT_AGENT_MAX_STEPS
  return Math.min(MAX_EDIT_AGENT_MAX_STEPS, Math.max(16, Math.floor(value)))
}

export const normalizeFailureOutputAfter = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_FAILURE_OUTPUT_AFTER
  return Math.min(MAX_FAILURE_OUTPUT_AFTER, Math.max(0, Math.floor(value)))
}

export const normalizeContextMode = (value: unknown): StoredSettings['contextMode'] =>
  value === 'summary' ? 'summary' : DEFAULT_CONTEXT_MODE

export const normalizeModelRef = (value: unknown): AiModelRef | undefined => {
  if (!isRecord(value) || typeof value.connectionId !== 'string' || typeof value.modelId !== 'string') return undefined
  if (!value.connectionId || !value.modelId) return undefined
  return { connectionId: value.connectionId, modelId: value.modelId }
}

export const isValidPresetText = (value: string): boolean =>
  !!value && value.length <= MAX_REQUEST_BODY_PRESET_NAME_LENGTH && !Array.from(value).some(character => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })

const isUnsafeJsonKey = (key: string): boolean =>
  key === '__proto__' || key === 'prototype' || key === 'constructor'

const normalizeJsonValue = (value: unknown, depth = 0): AiJsonValue | undefined => {
  if (depth > MAX_REQUEST_BODY_PRESET_DEPTH) return undefined
  if (value === null) return null
  if (typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (Array.isArray(value)) {
    const normalized: AiJsonValue[] = []
    for (const item of value) {
      const next = normalizeJsonValue(item, depth + 1)
      if (next === undefined) return undefined
      normalized.push(next)
    }
    return normalized
  }
  if (!isRecord(value)) return undefined
  const normalized: Record<string, AiJsonValue> = {}
  for (const [key, item] of Object.entries(value)) {
    if (isUnsafeJsonKey(key)) return undefined
    const next = normalizeJsonValue(item, depth + 1)
    if (next === undefined) return undefined
    normalized[key] = next
  }
  return normalized
}

const normalizePresetBody = (value: unknown): Record<string, AiJsonValue> | undefined => {
  if (!isRecord(value) || !Object.keys(value).length) return undefined
  const normalized = normalizeJsonValue(value)
  return isRecord(normalized) && Object.keys(normalized).length ? normalized as Record<string, AiJsonValue> : undefined
}

const presetBodySize = (body: Record<string, AiJsonValue>): number =>
  Buffer.byteLength(JSON.stringify(body), 'utf8')

export const legacyReasoningPresetId = (value: string): string =>
  `legacy-reasoning-effort:${encodeURIComponent(value)}`

const normalizeRequestBodyPreset = (value: unknown): AiRequestBodyPreset | undefined => {
  if (!isRecord(value)) return undefined
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  const body = normalizePresetBody(value.body)
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  if (!isValidPresetText(id) || !isValidPresetText(name) || !body || presetBodySize(body) > MAX_REQUEST_BODY_PRESET_BYTES) return undefined
  return { id, name, body }
}

const normalizeRequestBodyPresetConfig = (value: unknown, strict = false): {
  presets: AiRequestBodyPreset[]
  defaultPresetId?: string
  editAgentPresetId?: string | null
} | undefined => {
  if (!isRecord(value) || !Array.isArray(value.presets)) return undefined
  if (!value.presets.length || value.presets.length > MAX_REQUEST_BODY_PRESETS) return undefined
  const presets: AiRequestBodyPreset[] = []
  const ids = new Set<string>()
  const names = new Set<string>()
  for (let index = 0; index < value.presets.length; index += 1) {
    const preset = normalizeRequestBodyPreset(value.presets[index])
    if (!preset || ids.has(preset.id) || names.has(preset.name.toLocaleLowerCase())) return undefined
    ids.add(preset.id)
    names.add(preset.name.toLocaleLowerCase())
    presets.push(preset)
  }
  const defaultPresetId = value.defaultPresetId
  if (defaultPresetId !== undefined && (typeof defaultPresetId !== 'string' || !ids.has(defaultPresetId))) return undefined
  const configuredEditAgentPresetId = value.editAgentPresetId
  let editAgentPresetId: string | null | undefined
  if (configuredEditAgentPresetId === null) editAgentPresetId = null
  else if (configuredEditAgentPresetId !== undefined) {
    if (typeof configuredEditAgentPresetId !== 'string' || !ids.has(configuredEditAgentPresetId)) {
      if (strict) throw new Error('The edit Agent preset must be empty, null, or reference a configured request body preset.')
    } else {
      editAgentPresetId = configuredEditAgentPresetId
    }
  }
  return {
    presets,
    ...(defaultPresetId !== undefined ? { defaultPresetId } : {}),
    ...(editAgentPresetId !== undefined ? { editAgentPresetId } : {})
  }
}

const normalizeLegacyReasoningEffortConfig = (value: unknown): { options: string[]; defaultValue?: string } | undefined => {
  if (!isRecord(value) || !Array.isArray(value.options)) return undefined
  const options: string[] = []
  for (const item of value.options) {
    if (typeof item !== 'string') return undefined
    const option = item.trim()
    if (!isValidPresetText(option) || options.includes(option)) continue
    options.push(option)
    if (options.length > MAX_REQUEST_BODY_PRESETS) return undefined
  }
  if (!options.length) return undefined
  const defaultValue = value.defaultValue
  if (defaultValue !== undefined && (typeof defaultValue !== 'string' || !options.includes(defaultValue.trim()))) return undefined
  return {
    options,
    ...(defaultValue !== undefined ? { defaultValue: (defaultValue as string).trim() } : {})
  }
}

const migrateLegacyReasoningEffort = (value: unknown): {
  presets: AiRequestBodyPreset[]
  defaultPresetId?: string
} | undefined => {
  const legacy = normalizeLegacyReasoningEffortConfig(value)
  if (!legacy) return undefined
  const presets = legacy.options.map(option => ({
    id: legacyReasoningPresetId(option),
    name: option,
    body: { reasoning_effort: option }
  }))
  return {
    presets,
    ...(legacy.defaultValue ? { defaultPresetId: legacyReasoningPresetId(legacy.defaultValue) } : {})
  }
}

export const mergeRequestBodyPreset = (body: Record<string, unknown>, preset: AiRequestBodyPreset): Record<string, unknown> => {
  const mergeJsonValue = (base: unknown, override: AiJsonValue): unknown => {
    if (!isRecord(base) || !isRecord(override)) return override
    const merged: Record<string, unknown> = { ...base }
    for (const [key, value] of Object.entries(override)) {
      merged[key] = Object.prototype.hasOwnProperty.call(merged, key) ? mergeJsonValue(merged[key], value) : value
    }
    return merged
  }
  return mergeJsonValue(body, preset.body) as Record<string, unknown>
}

export const validateResponsesPresetBody = (body: Record<string, AiJsonValue>): void => {
  const reserved = new Set([
    'model',
    'input',
    'instructions',
    'stream',
    'store',
    'previous_response_id',
    'tools',
    'tool_choice',
    'parallel_tool_calls'
  ])
  const conflict = Object.keys(body).find(key => reserved.has(key))
  const reasoning = isRecord(body.reasoning) ? body.reasoning : undefined
  const reasoningConflict = reasoning && ('effort' in reasoning || 'summary' in reasoning || 'generate_summary' in reasoning)
  const text = body.text
  if (text !== undefined && !isRecord(text)) {
    throw new Error('Responses advanced JSON text must be an object. Use the standard verbosity control for output detail.')
  }
  const verbosityConflict = isRecord(text) && 'verbosity' in text
  if (conflict || reasoningConflict || verbosityConflict) {
    throw new Error('Responses advanced JSON cannot override model input, session state, tools, stream, reasoning effort/summary, or text verbosity. Use the standard controls instead.')
  }
}

export const isReasoningEffort = (value: unknown): value is AiReasoningEffort =>
  value === 'none' || value === 'minimal' || value === 'low' || value === 'medium' || value === 'high' || value === 'xhigh' || value === 'max'

export const isVerbosity = (value: unknown): value is AiVerbosity =>
  value === 'low' || value === 'medium' || value === 'high'

export const isReasoningEffortPreference = (value: unknown): value is AiReasoningEffortPreference =>
  value === 'model-default' || value === 'provider-default' || isReasoningEffort(value)

export const isVerbosityPreference = (value: unknown): value is AiVerbosityPreference =>
  value === 'model-default' || value === 'provider-default' || isVerbosity(value)

const normalizeReasoningEffortPreference = (value: unknown): AiReasoningEffortPreference | undefined =>
  isReasoningEffortPreference(value) ? value : undefined

const normalizeVerbosityPreference = (value: unknown): AiVerbosityPreference | undefined =>
  isVerbosityPreference(value) ? value : undefined

const normalizeResponsesModelOptions = (value: unknown, strict = false): AiResponsesModelOptions | undefined => {
  if (!isRecord(value)) return undefined
  const reasoningEffort = value.reasoningEffort
  const reasoningSummary = value.reasoningSummary
  const verbosity = value.verbosity
  if (reasoningEffort !== undefined && !isReasoningEffort(reasoningEffort)) {
    if (strict) throw new Error('Responses reasoning effort must be a supported effort value or empty.')
    return undefined
  }
  if (reasoningSummary !== undefined && typeof reasoningSummary !== 'boolean') {
    if (strict) throw new Error('Responses reasoning summary must be a boolean.')
    return undefined
  }
  if (verbosity !== undefined && !isVerbosity(verbosity)) {
    if (strict) throw new Error('Responses verbosity must be low, medium, high, or empty.')
    return undefined
  }
  if (reasoningEffort === undefined && reasoningSummary === undefined && verbosity === undefined) return undefined
  return {
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(reasoningSummary !== undefined ? { reasoningSummary } : {}),
    ...(verbosity !== undefined ? { verbosity } : {})
  }
}

const normalizeModelCapabilities = (value: unknown, strict = false): AiModelProfile['capabilities'] => {
  if (!isRecord(value)) return undefined
  const requestBodyPresets = value.requestBodyPresets
  const legacyReasoningEffort = value.reasoningEffort
  const reasoningField = value.reasoningField
  const reasoningTag = value.reasoningTag
  const replayReasoning = value.replayReasoning
  const responses = normalizeResponsesModelOptions(value.responses, strict)
  const normalizedRequestBodyPresets = requestBodyPresets !== undefined
    ? normalizeRequestBodyPresetConfig(requestBodyPresets, strict)
    : legacyReasoningEffort !== undefined
      ? migrateLegacyReasoningEffort(legacyReasoningEffort)
      : undefined
  if (strict && (requestBodyPresets !== undefined || legacyReasoningEffort !== undefined) && !normalizedRequestBodyPresets) {
    throw new Error(`Invalid request body preset configuration. Add between 1 and ${MAX_REQUEST_BODY_PRESETS} unique presets with non-empty JSON objects smaller than ${MAX_REQUEST_BODY_PRESET_BYTES} bytes.`)
  }
  if (
    (reasoningField !== undefined && reasoningField !== 'reasoning' && reasoningField !== 'reasoning_content' && reasoningField !== 'reason_content' && reasoningField !== 'reasoning_text') ||
    (reasoningTag !== undefined && reasoningTag !== 'think' && reasoningTag !== 'thinking' && reasoningTag !== 'analysis' && reasoningTag !== 'reasoning') ||
    (replayReasoning !== undefined && typeof replayReasoning !== 'boolean')
  ) return undefined
  if (normalizedRequestBodyPresets === undefined && responses === undefined && reasoningField === undefined && reasoningTag === undefined && replayReasoning === undefined) return undefined
  return {
    ...(normalizedRequestBodyPresets ? { requestBodyPresets: normalizedRequestBodyPresets } : {}),
    ...(responses ? { responses } : {}),
    ...(reasoningField !== undefined ? { reasoningField: reasoningField as AiReasoningField } : {}),
    ...(reasoningTag !== undefined ? { reasoningTag: reasoningTag as AiReasoningTag } : {}),
    ...(replayReasoning !== undefined ? { replayReasoning } : {})
  }
}

export const normalizeModelProfile = (value: unknown, strict = false): AiModelProfile | undefined => {
  if (!isRecord(value) || typeof value.model !== 'string' || !value.model.trim()) return undefined
  const model = value.model.trim()
  const source = value.source === 'discovered' ? 'discovered' : 'manual'
  return {
    id: typeof value.id === 'string' && value.id ? value.id : `model-${crypto.randomUUID()}`,
    model,
    label: typeof value.label === 'string' && value.label.trim() ? value.label.trim() : model,
    source,
    capabilities: normalizeModelCapabilities(value.capabilities, strict)
  }
}

const normalizeStoredConnection = (value: unknown, index: number): StoredConnection | undefined => {
  if (!isRecord(value)) return undefined
  const protocol = value.protocol === 'anthropic-messages'
    ? 'anthropic-messages'
    : value.protocol === 'openai-responses'
      ? 'openai-responses'
      : 'openai-chat-completions'
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

export const normalizeStoredSettings = (value: unknown): { settings: StoredSettings; legacy: boolean } => {
  if (value === undefined) {
    return {
      settings: {
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        connections: [],
        editAutoRetryCount: DEFAULT_EDIT_AUTO_RETRY_COUNT,
        editAgentMaxSteps: DEFAULT_EDIT_AGENT_MAX_STEPS,
        failureOutputAfter: DEFAULT_FAILURE_OUTPUT_AFTER,
        contextMode: DEFAULT_CONTEXT_MODE
      },
      legacy: false
    }
  }
  if (isRecord(value) && Array.isArray(value.connections)) {
    const connections = value.connections
      .map((connection, index) => normalizeStoredConnection(connection, index))
      .filter((connection): connection is StoredConnection => !!connection)
    const settings: StoredSettings = {
      schemaVersion: SETTINGS_SCHEMA_VERSION,
      connections,
      defaultModel: normalizeModelRef(value.defaultModel),
      lastUsedModel: normalizeModelRef(value.lastUsedModel),
      lastUsedReasoningEffort: normalizeReasoningEffortPreference(value.lastUsedReasoningEffort),
      lastUsedVerbosity: normalizeVerbosityPreference(value.lastUsedVerbosity),
      editAutoRetryCount: normalizeEditAutoRetryCount(value.editAutoRetryCount),
      editAgentMaxSteps: normalizeEditAgentMaxSteps(value.editAgentMaxSteps),
      failureOutputAfter: normalizeFailureOutputAfter(value.failureOutputAfter),
      contextMode: normalizeContextMode(value.contextMode)
    }
    return {
      settings,
      legacy: value.schemaVersion !== SETTINGS_SCHEMA_VERSION || JSON.stringify(value) !== JSON.stringify(settings)
    }
  }

  const legacyValue = isRecord(value) ? value : {}
  const legacyModel = typeof legacyValue.model === 'string' ? legacyValue.model.trim() : ''
  const legacyConnection: StoredConnection = {
    id: 'legacy-default',
    name: 'Default connection',
    protocol: legacyValue.protocol === 'anthropic-messages' ? 'anthropic-messages' : 'openai-chat-completions',
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
        : undefined,
      lastUsedModel: legacyModel
        ? { connectionId: legacyConnection.id, modelId: legacyConnection.models[0].id }
        : undefined,
      lastUsedReasoningEffort: undefined,
      lastUsedVerbosity: undefined,
      editAutoRetryCount: DEFAULT_EDIT_AUTO_RETRY_COUNT,
      editAgentMaxSteps: DEFAULT_EDIT_AGENT_MAX_STEPS,
      failureOutputAfter: DEFAULT_FAILURE_OUTPUT_AFTER,
      contextMode: DEFAULT_CONTEXT_MODE
    },
    legacy: true
  }
}

export const normalizeStoredKeys = (value: unknown, settings: StoredSettings): { keys: StoredKeys; legacy: boolean } => {
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

export const validateConnectionInput = (input: AiConnectionInput): {
  id: string
  name: string
  protocol: AiConnectionInput['protocol']
  endpoint: string
  models: AiModelProfile[]
} => {
  if (input.protocol !== 'openai-responses' && input.protocol !== 'openai-chat-completions' && input.protocol !== 'anthropic-messages') {
    throw new Error('Unsupported AI protocol.')
  }
  const endpoint = validateEndpoint(input.endpoint)
  const name = input.name.trim()
  if (!name) throw new Error('Connection name is required.')
  const models = input.models
    .map(model => normalizeModelProfile({ ...model, model: model.model.trim() }, true))
    .filter((model): model is AiModelProfile => !!model)
  if (input.protocol === 'openai-responses') {
    for (const model of models) {
      for (const preset of model.capabilities?.requestBodyPresets?.presets ?? []) validateResponsesPresetBody(preset.body)
    }
  }
  const dedupedModels = Array.from(new Map(models.map(model => [model.model, model])).values())
  return {
    id: input.id?.trim() || `connection-${crypto.randomUUID()}`,
    name,
    protocol: input.protocol,
    endpoint,
    models: dedupedModels
  }
}

export const validateEndpoint = (endpoint: string): string => {
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

export const hasStoredModelRef = (connections: StoredConnection[], modelRef: AiModelRef | undefined): modelRef is AiModelRef =>
  !!modelRef && connections.some(connection =>
    connection.id === modelRef.connectionId && connection.models.some(model => model.id === modelRef.modelId)
  )

export const firstStoredModelRef = (connections: StoredConnection[]): AiModelRef | undefined => {
  for (const connection of connections) {
    const model = connection.models[0]
    if (model) return { connectionId: connection.id, modelId: model.id }
  }
  return undefined
}

export const toPublicSettings = (settings: StoredSettings, keys: StoredKeys): AiSettings => ({
  defaultModel: settings.defaultModel,
  lastUsedModel: settings.lastUsedModel,
  lastUsedReasoningEffort: settings.lastUsedReasoningEffort,
  lastUsedVerbosity: settings.lastUsedVerbosity,
  contextMode: settings.contextMode,
  editAutoRetryCount: settings.editAutoRetryCount,
  editAgentMaxSteps: settings.editAgentMaxSteps,
  failureOutputAfter: settings.failureOutputAfter,
  connections: settings.connections.map(connection => ({
    ...connection,
    models: connection.models.map(model => ({ ...model })),
    hasApiKey: !!keys[connection.id]
  }))
})

export const resolveRequestBodyPreset = (model: AiModelProfile, override: string | null | undefined): AiRequestBodyPreset | undefined => {
  const config = model.capabilities?.requestBodyPresets
  if (override === undefined) {
    return config?.presets.find(preset => preset.id === config.defaultPresetId)
  }
  if (!config) throw new Error('This model has no request body preset configuration.')
  if (override === null) return undefined
  const preset = config.presets.find(candidate => candidate.id === override)
  if (!preset) throw new Error('The selected request body preset is not configured for this model.')
  return preset
}

export const resolveEditAgentPreset = (model: AiModelProfile, inherited: AiRequestBodyPreset | undefined): AiRequestBodyPreset | undefined => {
  const config = model.capabilities?.requestBodyPresets
  const editAgentPresetId = config?.editAgentPresetId
  if (editAgentPresetId === undefined) return inherited
  if (editAgentPresetId === null) return undefined
  return config?.presets.find(preset => preset.id === editAgentPresetId)
}
