import crypto from 'crypto'
import path from 'path'
import { registerAiIpcHandlers as registerAiIpcHandlersForService } from './ipc'
import type {
  AiAttachmentData,
  AiChatSession,
  AiConnectionInput,
  AiDiscoveredModel,
  AiModelListInput,
  AiModelRef,
  AiPreparedRevision,
  AiReasoningEffortPreference,
  AiRequest,
  AiResponse,
  AiRevisionRequest,
  AiSettings,
  AiTestResult,
  AiUndoResult,
  AiVerbosityPreference
} from '@shared/types/ai'
import { AiAttachmentService } from './attachmentService'
import type { ProviderMessage } from './providerMessages'
import {
  buildMarkdownFormatRepairPrompt,
  connectionTestSystemPrompt,
  connectionTestUserPrompt
} from './prompts'
import { inspectMarkdown, normalizeGeneratedMarkdown } from './outputRepair'
import { featureLog, connectionLog } from './logging'
import { AiChatStore } from './chatStore'
import { AiRevisionStore } from './revisionStore'
import { AiSettingsService } from './settingsService'
import { resolveModelsEndpoint } from './providerClient'
import { isRecord } from './utils'
import { AiProviderRequest, ANTHROPIC_VERSION } from './providerRequest'
import { AiRequestService } from './requestService'
import type {
  AgentTransportMode,
  AiProgressSink,
  ProviderRequestOptions,
  ProviderResponse,
  RepairedMarkdownResult,
  ResolvedModelTarget,
  StoredKeys,
  StoredSettings
} from './types'
export type {
  AgentTransportMode,
  AiProgressSink,
  ProviderRequestOptions,
  ProviderResponse,
  ProviderToolChoice,
  RepairedMarkdownResult,
  ResolvedModelTarget,
  StoredConnection,
  StoredKeys,
  StoredRevision,
  StoredRevisionState,
  StoredSettings
} from './types'
import {
  resolveRequestBodyPreset,
  validateConnectionInput,
  validateEndpoint
} from './settingsConfig'
import {
  normalizeChatSession,
  normalizeMessages
} from './chatNormalization'
import {
  buildContextSummaryPrompt,
  buildLocalContextSummary,
  normalizeContextSummary
} from './contextCompaction'

// The new protocol fields are additive and remain compatible with the existing
// persisted schema. Keep the version stable so legacy migrations continue to
// preserve their established on-disk contract.
const CHAT_FILE = 'ai-chat.json'
const REVISION_FILE = 'ai-revisions.json'

export class AiService {
  private readonly chatPath: string
  private readonly attachmentService: AiAttachmentService
  private readonly chatStore: AiChatStore
  private readonly revisionStore: AiRevisionStore
  private readonly settingsService: AiSettingsService
  private readonly controllers = new Map<string, AbortController>()
  private readonly providerRequest: AiProviderRequest
  private readonly requestService: AiRequestService
  private readonly toolCapabilities = new Map<string, AgentTransportMode>()

  constructor(userDataPath: string) {
    this.chatPath = path.join(userDataPath, CHAT_FILE)
    this.providerRequest = new AiProviderRequest(this.controllers)
    this.settingsService = new AiSettingsService(userDataPath)
    this.attachmentService = new AiAttachmentService(userDataPath, this.chatPath)
    this.revisionStore = new AiRevisionStore(path.join(userDataPath, REVISION_FILE))
    this.chatStore = new AiChatStore(this.chatPath, {
      normalizeMessages,
      normalizeSession: normalizeChatSession,
      clearPendingAttachments: documentId => this.attachmentService.clearPendingAttachments(documentId),
      pruneAttachments: graceMs => this.pruneAttachments(graceMs),
      onCleanupError: error => featureLog('attachment cleanup skipped reason=%s', error instanceof Error ? error.message : String(error)),
      migrateRevisions: (fromDocumentId, toDocumentId) => this.revisionStore.migrateDocumentIdentity(fromDocumentId, toDocumentId)
    })
    this.requestService = new AiRequestService({
      readSettingsState: () => this.readSettingsState(),
      resolveModelTarget: (modelRef, state) => this.resolveModelTarget(modelRef, state),
      requestProvider: (target, system, messages, requestId, signal, options) => this.requestProvider(target, system, messages, requestId, signal, options),
      saveRequestAttachments: (uploads, documentId) => this.saveRequestAttachments(uploads, documentId),
      hydrateProviderMessages: (messages, priorityAttachmentIds, renderedPdfPages) => this.hydrateProviderMessages(messages, priorityAttachmentIds, renderedPdfPages),
      repairMarkdownResponse: (target, system, messages, generated, requestId, signal, stripOuterFence, strict, providerOptions) => this.repairMarkdownResponse(target, system, messages, generated, requestId, signal, stripOuterFence, strict, providerOptions),
      createContextSummary: (target, previousSummary, prompt, mode, outcome, requestId, signal, onResponse, onProgress) => this.createContextSummary(target, previousSummary, prompt, mode, outcome, requestId, signal, onResponse, onProgress),
      controllers: this.controllers,
      toolCapabilities: this.toolCapabilities
    })
  }

  private readSettingsState(): Promise<{ settings: StoredSettings; keys: StoredKeys }> {
    return this.settingsService.readSettingsState()
  }

  private resolveModelTarget(modelRef: AiModelRef, state?: { settings: StoredSettings; keys: StoredKeys }): Promise<ResolvedModelTarget> {
    return this.settingsService.resolveModelTarget(modelRef, state)
  }

  async getSettings(): Promise<AiSettings> {
    return this.settingsService.getSettings()
  }

  async saveConnection(input: AiConnectionInput): Promise<AiSettings> {
    return this.settingsService.saveConnection(input)
  }

  async deleteConnection(connectionId: string): Promise<AiSettings> {
    return this.settingsService.deleteConnection(connectionId)
  }

  async deleteConnectionKey(connectionId: string): Promise<AiSettings> {
    return this.settingsService.deleteConnectionKey(connectionId)
  }

  async setDefaultModel(modelRef: AiModelRef | null): Promise<AiSettings> {
    return this.settingsService.setDefaultModel(modelRef)
  }

  async setLastUsedModel(modelRef: AiModelRef | null): Promise<AiSettings> {
    return this.settingsService.setLastUsedModel(modelRef)
  }

  async setLastUsedReasoningEffort(preference: AiReasoningEffortPreference | null): Promise<AiSettings> {
    return this.settingsService.setLastUsedReasoningEffort(preference)
  }

  async setLastUsedVerbosity(preference: AiVerbosityPreference | null): Promise<AiSettings> {
    return this.settingsService.setLastUsedVerbosity(preference)
  }

  async reorderConnections(connectionIds: string[]): Promise<AiSettings> {
    return this.settingsService.reorderConnections(connectionIds)
  }

  async setEditAutoRetryCount(retryCount: number): Promise<AiSettings> {
    return this.settingsService.setEditAutoRetryCount(retryCount)
  }

  async setEditAgentMaxSteps(maxSteps: number): Promise<AiSettings> {
    return this.settingsService.setEditAgentMaxSteps(maxSteps)
  }

  async setFailureOutputAfter(failureCount: number): Promise<AiSettings> {
    return this.settingsService.setFailureOutputAfter(failureCount)
  }

  async setContextMode(contextMode: AiSettings['contextMode']): Promise<AiSettings> {
    return this.settingsService.setContextMode(contextMode)
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
        },
        requestBodyPreset: resolveRequestBodyPreset(model, undefined)
      }, connectionTestSystemPrompt, [{ role: 'user', content: connectionTestUserPrompt }], `test-${crypto.randomUUID()}`, undefined, { omitVerbosity: true })
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

  private requestProvider(
    target: ResolvedModelTarget,
    system: string,
    messages: ProviderMessage[],
    requestId: string,
    signal?: AbortSignal,
    options: ProviderRequestOptions = {}
  ): Promise<ProviderResponse> {
    return this.providerRequest.request(target, system, messages, requestId, signal, options)
  }

  private pruneAttachments(...args: Parameters<AiAttachmentService['pruneAttachments']>): ReturnType<AiAttachmentService['pruneAttachments']> {
    return this.attachmentService.pruneAttachments(...args)
  }

  private saveRequestAttachments(...args: Parameters<AiAttachmentService['saveRequestAttachments']>): ReturnType<AiAttachmentService['saveRequestAttachments']> {
    return this.attachmentService.saveRequestAttachments(...args)
  }

  private hydrateProviderMessages(...args: Parameters<AiAttachmentService['hydrateProviderMessages']>): ReturnType<AiAttachmentService['hydrateProviderMessages']> {
    return this.attachmentService.hydrateProviderMessages(...args)
  }

  private async repairMarkdownResponse(
    target: ResolvedModelTarget,
    system: string,
    messages: ProviderMessage[],
    generated: ProviderResponse,
    requestId: string,
    signal: AbortSignal | undefined,
    stripOuterFence: boolean,
    strict: boolean,
    providerOptions: ProviderRequestOptions = {}
  ): Promise<RepairedMarkdownResult> {
    const normalized = normalizeGeneratedMarkdown(generated.content, { stripOuterFence })
    if (!normalized.content.trim()) throw new Error('The model returned an empty document.')
    const inspection = inspectMarkdown(normalized.content)
    if (!inspection.issues.length) {
      return {
        content: normalized.content.trim(),
        reasoning: generated.reasoning,
        responseId: generated.responseId,
        recovery: {
          strategy: normalized.changes.length ? 'local-normalization' : 'direct',
          attempts: 1,
          changes: normalized.changes.length ? normalized.changes : undefined
        }
      }
    }
    const failure = inspection.issues.map(issue => issue.message).join(' ')
    try {
      const continueResponsesConversation = target.connection.protocol === 'openai-responses' && providerOptions.store === true && !strict && !!generated.responseId
      const repairMessages = continueResponsesConversation
        ? [{ role: 'user' as const, content: buildMarkdownFormatRepairPrompt(failure) }]
        : [
          ...messages,
          { role: 'assistant' as const, content: generated.content, reasoning: generated.reasoning },
          { role: 'user' as const, content: buildMarkdownFormatRepairPrompt(failure) }
        ]
      const repaired = await this.requestProvider(
        target,
        system,
        repairMessages,
        requestId,
        signal,
        {
          ...providerOptions,
          ...(continueResponsesConversation
            ? { previousResponseId: generated.responseId, store: true }
            : {})
        }
      )
      const repairedNormalized = normalizeGeneratedMarkdown(repaired.content, { stripOuterFence })
      if (target.connection.protocol === 'openai-responses' && repaired.truncated) {
        throw new Error('The Responses API repair response was truncated before a complete document was returned.')
      }
      const repairedInspection = inspectMarkdown(repairedNormalized.content)
      if (repairedInspection.issues.length) throw new Error(repairedInspection.issues.map(issue => issue.message).join(' '))
      return {
        content: repairedNormalized.content.trim(),
        reasoning: repaired.reasoning ?? generated.reasoning,
        responseId: repaired.responseId ?? generated.responseId,
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
          reasoning: generated.reasoning,
          responseId: generated.responseId,
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

  async readAttachment(documentId: string, attachmentId: string): Promise<AiAttachmentData> {
    return this.attachmentService.readAttachment(documentId, attachmentId)
  }

  private async createContextSummary(
    target: ResolvedModelTarget,
    previousSummary: string | undefined,
    prompt: string,
    mode: AiRequest['mode'],
    outcome: string,
    requestId: string,
    signal: AbortSignal | undefined,
    onResponse: (response: ProviderResponse) => void,
    onProgress: () => void
  ): Promise<string> {
    const fallback = buildLocalContextSummary(previousSummary, prompt, mode, outcome)
    const summaryPrompt = buildContextSummaryPrompt(previousSummary, prompt, mode, outcome)
    let usedFallback = false
    let summaryLength = 0
    onProgress()
    try {
      const generated = await this.requestProvider(
        target,
        summaryPrompt.system,
        [{ role: 'user', content: summaryPrompt.content }],
        requestId,
        signal,
        { stream: false, maxTokens: 512, attempt: 2, omitRequestBodyPreset: true, omitVerbosity: true }
      )
      onResponse(generated)
      const summary = normalizeContextSummary(generated.content)
      if (!summary) throw new Error('The context summary response was empty.')
      summaryLength = summary.length
      return summary
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && /cancelled|canceled/i.test(error.message))) throw error
      usedFallback = true
      summaryLength = fallback.length
      featureLog('context summary fallback reason=%s requestId=%s', error instanceof Error ? error.message : String(error), requestId)
      return fallback
    } finally {
      featureLog(
        'context summary generated mode=%s sourceChars=%s previousSummaryChars=%s summaryChars=%s fallback=%s requestId=%s',
        mode,
        outcome.length,
        previousSummary?.length ?? 0,
        summaryLength,
        usedFallback,
        requestId
      )
    }
  }

  async request(request: AiRequest, progressSink?: AiProgressSink): Promise<AiResponse> {
    return this.requestService.request(request, progressSink)
  }

  cancel(requestId: string): void {
    if (this.controllers.has(requestId)) {
      featureLog('request cancel requested requestId=%s', requestId)
      this.controllers.get(requestId)?.abort()
    }
  }

  async loadChat(documentId: string): Promise<AiChatSession> {
    return this.chatStore.load(documentId)
  }

  async saveChat(documentId: string, session: AiChatSession): Promise<void> {
    return this.chatStore.save(documentId, session)
  }

  async clearChat(documentId: string): Promise<void> {
    return this.chatStore.clear(documentId)
  }

  async cleanupAttachments(): Promise<void> {
    await this.pruneAttachments(0).catch(error => featureLog('attachment cleanup skipped reason=%s', error instanceof Error ? error.message : String(error)))
  }

  async prepareRevision(request: AiRevisionRequest): Promise<AiPreparedRevision> {
    return this.revisionStore.prepare(request)
  }

  async commitRevision(revisionId: string, documentId: string, afterMarkdown: string): Promise<void> {
    return this.revisionStore.commit(revisionId, documentId, afterMarkdown)
  }

  async discardRevision(revisionId: string): Promise<void> {
    return this.revisionStore.discard(revisionId)
  }

  async undoRevision(documentId: string, currentMarkdown: string): Promise<AiUndoResult | null> {
    return this.revisionStore.undo(documentId, currentMarkdown)
  }

  async migrateDocumentIdentity(fromDocumentId: string, toDocumentId: string): Promise<void> {
    return this.chatStore.migrateDocumentIdentity(fromDocumentId, toDocumentId)
  }
}

export const registerAiIpcHandlers = (userDataPath: string): void => {
  const aiService = new AiService(userDataPath)
  registerAiIpcHandlersForService(aiService)
  aiService.cleanupAttachments().catch(error => featureLog('startup attachment cleanup skipped reason=%s', error instanceof Error ? error.message : String(error)))
}
