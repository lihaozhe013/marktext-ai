import type {
  AiAttachment,
  AiFailureReason,
  AiModelRef,
  AiProgressEvent,
  AiRenderedPdfPages,
  AiRequest,
  AiResponse
} from '@shared/types/ai'
import { runDocumentEditAgent, type AgentPlanStep } from './documentEditAgent'
import type { ProviderMessage, ProviderToolCall, ProviderToolResult } from './providerMessages'
import {
  buildAnswerSystemPrompt,
  buildAttachmentSourceBriefSystemPrompt,
  buildDocumentPrompt,
  buildRewriteSystemPrompt,
  makePromptToken,
  previousPreciseEditContextMessage,
  previousRewriteContextMessage
} from './prompts'
import { featureLog, requestBodyPresetLog } from './logging'
import { resolveRequestEndpoint } from './providerClient'
import { buildContextMemoryMessage, normalizeContextSummary } from './contextCompaction'
import { estimateTokenCount, type ProviderStreamProgress } from './providerStream'
import {
  isReasoningEffort,
  isVerbosity,
  resolveEditAgentPreset,
  resolveRequestBodyPreset
} from './settingsConfig'
import { MAX_FAILURE_OUTPUT_CHARS, normalizeMessages, normalizeResponsesConversation } from './chatNormalization'
import { parseStrictAgentEnvelope, withoutStrictToolSchemas } from './responseParsing'
import { classifyAgentTransportRejection, ProviderRequestError } from './providerRequest'
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

type RequestState = { settings: StoredSettings; keys: StoredKeys }

type HydratableMessage = {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  attachments?: AiAttachment[]
  toolCalls?: ProviderToolCall[]
  toolResults?: ProviderToolResult[]
}

export interface AiRequestServiceDependencies {
  readSettingsState: () => Promise<RequestState>
  resolveModelTarget: (modelRef: AiModelRef, state?: RequestState) => Promise<ResolvedModelTarget>
  requestProvider: (
    target: ResolvedModelTarget,
    system: string,
    messages: ProviderMessage[],
    requestId: string,
    signal?: AbortSignal,
    options?: ProviderRequestOptions
  ) => Promise<ProviderResponse>
  saveRequestAttachments: (uploads: unknown, documentId: string) => Promise<AiAttachment[]>
  hydrateProviderMessages: (
    messages: HydratableMessage[],
    priorityAttachmentIds?: ReadonlySet<string>,
    renderedPdfPages?: readonly AiRenderedPdfPages[]
  ) => Promise<ProviderMessage[]>
  repairMarkdownResponse: (
    target: ResolvedModelTarget,
    system: string,
    messages: ProviderMessage[],
    generated: ProviderResponse,
    requestId: string,
    signal: AbortSignal | undefined,
    stripOuterFence: boolean,
    strict: boolean,
    providerOptions?: ProviderRequestOptions
  ) => Promise<RepairedMarkdownResult>
  createContextSummary: (
    target: ResolvedModelTarget,
    previousSummary: string | undefined,
    prompt: string,
    mode: AiRequest['mode'],
    outcome: string,
    requestId: string,
    signal: AbortSignal | undefined,
    onResponse: (response: ProviderResponse) => void,
    onProgress: () => void
  ) => Promise<string>
  controllers: Map<string, AbortController>
  toolCapabilities: Map<string, AgentTransportMode>
}

const MAX_CONTEXT_MESSAGES = 10
const MAX_EDIT_CONTEXT_MESSAGES = 4
const MAX_AGENT_DIFF_CHARS = 16_000

const makeFailureOutput = (rawContent: string, content: string, reasoning?: string): { value?: string; truncated: boolean } => {
  const visible = rawContent || content
  const reasoningSuffix = reasoning && !visible.includes(reasoning)
    ? `\n\n[provider reasoning]\n${reasoning}`
    : ''
  const combined = `${visible}${reasoningSuffix}`
  if (!combined) return { truncated: false }
  return {
    value: combined.slice(0, MAX_FAILURE_OUTPUT_CHARS),
    truncated: combined.length > MAX_FAILURE_OUTPUT_CHARS
  }
}

const toMessageModel = (target: ResolvedModelTarget): ResolvedModelTarget['attribution'] => ({ ...target.attribution })

export class AiRequestService {
  private readonly dependencies: AiRequestServiceDependencies
  private readonly controllers: Map<string, AbortController>
  private readonly toolCapabilities: Map<string, AgentTransportMode>

  constructor(dependencies: AiRequestServiceDependencies) {
    this.dependencies = dependencies
    this.controllers = dependencies.controllers
    this.toolCapabilities = dependencies.toolCapabilities
  }

  private readSettingsState(): Promise<RequestState> {
    return this.dependencies.readSettingsState()
  }

  private resolveModelTarget(modelRef: AiModelRef, state?: RequestState): Promise<ResolvedModelTarget> {
    return this.dependencies.resolveModelTarget(modelRef, state)
  }

  private requestProvider(
    target: ResolvedModelTarget,
    system: string,
    messages: ProviderMessage[],
    requestId: string,
    signal?: AbortSignal,
    options: ProviderRequestOptions = {}
  ): Promise<ProviderResponse> {
    return this.dependencies.requestProvider(target, system, messages, requestId, signal, options)
  }

  private saveRequestAttachments(uploads: unknown, documentId: string): Promise<AiAttachment[]> {
    return this.dependencies.saveRequestAttachments(uploads, documentId)
  }

  private hydrateProviderMessages(
    messages: HydratableMessage[],
    priorityAttachmentIds: ReadonlySet<string> = new Set(),
    renderedPdfPages: readonly AiRenderedPdfPages[] = []
  ): Promise<ProviderMessage[]> {
    return this.dependencies.hydrateProviderMessages(messages, priorityAttachmentIds, renderedPdfPages)
  }

  private repairMarkdownResponse(
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
    return this.dependencies.repairMarkdownResponse(target, system, messages, generated, requestId, signal, stripOuterFence, strict, providerOptions)
  }

  private createContextSummary(
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
    return this.dependencies.createContextSummary(target, previousSummary, prompt, mode, outcome, requestId, signal, onResponse, onProgress)
  }

  async request(request: AiRequest, progressSink?: AiProgressSink): Promise<AiResponse> {
    if (!request.requestId || !request.documentId) throw new Error('Invalid AI request.')
    const state = await this.readSettingsState()
    const target = await this.resolveModelTarget(request.modelRef, state)
    if (target.connection.protocol === 'openai-responses' && request.reasoningEffortOverride !== undefined && request.reasoningEffortOverride !== null && !isReasoningEffort(request.reasoningEffortOverride)) {
      throw new Error('Responses reasoning effort is unsupported. Choose a standard effort or Provider default.')
    }
    if (target.connection.protocol === 'openai-responses' && request.verbosityOverride !== undefined && request.verbosityOverride !== null && !isVerbosity(request.verbosityOverride)) {
      throw new Error('Responses verbosity is unsupported. Choose low, medium, high, or Provider default.')
    }
    target.requestBodyPreset = resolveRequestBodyPreset(target.model, request.requestBodyPresetOverride)
    requestBodyPresetLog(
      'resolved presetId=%s override=%s model=%s requestId=%s',
      target.requestBodyPreset?.id ?? 'not-applied',
      request.requestBodyPresetOverride === undefined ? 'model-default' : request.requestBodyPresetOverride ?? 'omit',
      target.model.model,
      request.requestId
    )
    const editTarget: ResolvedModelTarget = {
      ...target,
      requestBodyPreset: resolveEditAgentPreset(target.model, target.requestBodyPreset)
    }
    requestBodyPresetLog(
      'resolved edit agent presetId=%s model=%s requestId=%s',
      editTarget.requestBodyPreset?.id ?? 'not-applied',
      target.model.model,
      request.requestId
    )
    const settings = target.connection
    const currentAttachments = await this.saveRequestAttachments(request.attachments, request.documentId)
    const priorityAttachmentIds = new Set(currentAttachments.map(attachment => attachment.id))
    const contextSummary = normalizeContextSummary(request.contextSummary)
    const normalizedRequestMessages = normalizeMessages(request.messages)
    const historicalMessages = normalizedRequestMessages.filter(message => message.kind !== 'status')
    const historicalAttachmentCount = historicalMessages.reduce((total, message) => total + (message.attachments?.length ?? 0), 0)
    const recentMessages = state.settings.contextMode === 'summary'
      ? (contextSummary
        ? [{ role: 'user' as const, content: buildContextMemoryMessage(contextSummary) }]
        : [])
      : normalizedRequestMessages
        .filter(message => message.kind !== 'status')
        .slice(-(request.mode === 'edit' ? MAX_EDIT_CONTEXT_MESSAGES : MAX_CONTEXT_MESSAGES))
        .map(({ role, mode, content, reasoning, attachments }) => ({
          role,
          content: content || (mode === 'rewrite' ? previousRewriteContextMessage : previousPreciseEditContextMessage),
          reasoning,
          attachments
        }))
    let documentKind = 'unknown'
    if (request.documentId.startsWith('path:')) documentKind = 'path'
    else if (request.documentId.startsWith('tab:')) documentKind = 'tab'
    featureLog(
      'request input mode=%s documentKind=%s markdownChars=%s contextMessages=%s attachmentCount=%s attachmentBytes=%s renderedPdfPageCount=%s requestId=%s',
      request.mode,
      documentKind,
      request.markdown.length,
      recentMessages.length,
      currentAttachments.length,
      currentAttachments.reduce((total, attachment) => total + attachment.byteSize, 0),
      request.renderedPdfPages?.reduce((total, item) => total + item.pages.length, 0) ?? 0,
      request.requestId
    )
    featureLog(
      'context selected mode=%s historicalMessages=%s historicalAttachments=%s providerContextMessages=%s summaryPresent=%s summaryChars=%s historicalContextSuppressed=%s requestId=%s',
      state.settings.contextMode,
      historicalMessages.length,
      historicalAttachmentCount,
      recentMessages.length,
      !!contextSummary,
      contextSummary?.length ?? 0,
      state.settings.contextMode === 'summary',
      request.requestId
    )
    const requestStartedAt = Date.now()
    let lastAttempt = 1
    let lastFailureReason: AiFailureReason | undefined
    let failureCount = 0
    let lastFailureOutput: string | undefined
    let lastFailureOutputTruncated = false
    let totalInputTokens = 0
    let totalOutputTokens = 0
    let totalCachedInputTokens = 0
    let totalCacheWriteInputTokens = 0
    let lastProgressStats: Pick<AiProgressEvent, 'outputTokens' | 'outputTokensEstimated' | 'inputTokens' | 'inputTokensEstimated' | 'streaming' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'totalInputTokens' | 'totalOutputTokens' | 'totalCachedInputTokens' | 'totalCacheWriteInputTokens'> = {
      outputTokens: 0,
      outputTokensEstimated: true,
      streaming: false
    }
    const emitProgress = (
      phase: AiProgressEvent['phase'],
      attempt: number,
      details: Partial<Pick<AiProgressEvent, 'outputTokens' | 'outputTokensEstimated' | 'inputTokens' | 'inputTokensEstimated' | 'streaming' | 'failureReason' | 'failureCount' | 'failureOutput' | 'failureOutputTruncated' | 'step' | 'maxSteps' | 'successfulSteps' | 'toolFailures' | 'documentVersion' | 'stepDescription' | 'stepAddedLines' | 'stepRemovedLines' | 'stepRemovedText' | 'stepAddedText' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'totalInputTokens' | 'totalOutputTokens' | 'totalCachedInputTokens' | 'totalCacheWriteInputTokens' | 'documentId' | 'stepBaseMarkdown' | 'stepMarkdown' | 'planSummary' | 'planStepCount' | 'planStepDescriptions' | 'planRevisionCount' | 'currentPlanStep'>> = {}
    ): void => {
      lastAttempt = Math.max(lastAttempt, attempt)
      const {
        failureReason,
        failureCount: eventFailureCount,
        failureOutput,
        failureOutputTruncated,
        documentId,
        stepBaseMarkdown,
        stepMarkdown,
        stepRemovedText,
        stepAddedText,
        ...stats
      } = details
      if (failureReason) lastFailureReason = failureReason
      lastProgressStats = { ...lastProgressStats, ...stats }
      progressSink?.({
        requestId: request.requestId,
        mode: request.mode,
        phase,
        attempt,
        elapsedMs: Date.now() - requestStartedAt,
        ...lastProgressStats,
        ...(failureReason ? { failureReason } : {}),
        ...(eventFailureCount !== undefined ? { failureCount: eventFailureCount } : {}),
        ...(failureOutput !== undefined ? { failureOutput } : {}),
        ...(failureOutputTruncated !== undefined ? { failureOutputTruncated } : {}),
        ...(documentId !== undefined ? { documentId } : {}),
        ...(stepBaseMarkdown !== undefined ? { stepBaseMarkdown } : {}),
        ...(stepMarkdown !== undefined ? { stepMarkdown } : {}),
        ...(stepRemovedText !== undefined ? { stepRemovedText } : {}),
        ...(stepAddedText !== undefined ? { stepAddedText } : {})
      })
    }
    const rememberProviderResponse = (response: ProviderResponse): void => {
      if (response.usage?.inputTokens !== undefined) totalInputTokens += response.usage.inputTokens
      if (response.usage?.outputTokens !== undefined) totalOutputTokens += response.usage.outputTokens
      if (response.usage?.cachedInputTokens !== undefined) totalCachedInputTokens += response.usage.cachedInputTokens
      if (response.usage?.cacheWriteInputTokens !== undefined) totalCacheWriteInputTokens += response.usage.cacheWriteInputTokens
      lastProgressStats = {
        ...lastProgressStats,
        inputTokens: response.usage?.inputTokens ?? lastProgressStats.inputTokens,
        outputTokens: response.usage?.outputTokens ?? lastProgressStats.outputTokens,
        outputTokensEstimated: response.usage?.outputTokens === undefined,
        totalInputTokens: totalInputTokens || undefined,
        totalOutputTokens: totalOutputTokens || undefined,
        totalCachedInputTokens: totalCachedInputTokens || undefined,
        totalCacheWriteInputTokens: totalCacheWriteInputTokens || undefined,
        streaming: false
      }
      const output = makeFailureOutput(response.rawContent, response.content, response.reasoning)
      if (output.value) {
        lastFailureOutput = output.value
        lastFailureOutputTruncated = output.truncated
      }
    }
    const makeProviderProgress = (attempt: number) => {
      let lastProgressAt = 0
      return {
        onWaiting: () => emitProgress('waiting', attempt, {
          outputTokens: 0,
          outputTokensEstimated: true,
          inputTokens: undefined,
          inputTokensEstimated: undefined,
          streaming: false
        }),
        onProgress: (progress: ProviderStreamProgress): void => {
          const now = Date.now()
          const exactUsage = progress.usage?.outputTokens !== undefined
          if (!progress.firstEvent && !exactUsage && now - lastProgressAt < 150) return
          lastProgressAt = now
          const usage = progress.usage
          emitProgress('streaming', attempt, {
            outputTokens: usage?.outputTokens ?? progress.outputTokens,
            outputTokensEstimated: usage?.outputTokens === undefined,
            inputTokens: usage?.inputTokens,
            inputTokensEstimated: usage?.inputTokens === undefined,
            cachedInputTokens: usage?.cachedInputTokens,
            cacheWriteInputTokens: usage?.cacheWriteInputTokens,
            streaming: true
          })
        }
      }
    }
    const extractAttachmentSourceBrief = async(signal: AbortSignal): Promise<string> => {
      const delimiter = makePromptToken('MT_SOURCE')
      const extractionMessages = await this.hydrateProviderMessages([
        {
          role: 'user',
          content: `TASK ${delimiter}\n${request.prompt}\nEND_TASK ${delimiter}`,
          attachments: currentAttachments
        }
      ], priorityAttachmentIds, request.renderedPdfPages)
      let lastError = 'The attachment source brief was empty.'
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        emitProgress('attachment-extracting', attempt, { streaming: false })
        const result = await this.requestProvider(
          editTarget,
          buildAttachmentSourceBriefSystemPrompt(delimiter),
          extractionMessages,
          request.requestId,
          signal,
          {
            stream: true,
            maxTokens: 3072,
            allowEmptyToolResponse: true,
            omitVerbosity: true,
            attempt,
            ...makeProviderProgress(attempt)
          }
        )
        rememberProviderResponse(result)
        if (!result.truncated && result.content.trim()) {
          const brief = result.content.trim().slice(0, 12000)
          featureLog(
            'attachment source brief ready attempt=%s attachmentCount=%s pageCount=%s chars=%s requestId=%s',
            attempt,
            currentAttachments.length,
            request.renderedPdfPages?.reduce((total, item) => total + item.pages.length, 0) ?? 0,
            brief.length,
            request.requestId
          )
          return brief
        }
        lastError = result.truncated ? 'The attachment source brief was truncated.' : 'The attachment source brief was empty.'
      }
      throw new Error(lastError)
    }
    if (request.mode === 'answer') {
      const promptToken = makePromptToken('MT_CONTEXT')
      const fullMessages = await this.hydrateProviderMessages([
        ...recentMessages,
        { role: 'user', content: buildDocumentPrompt(request.prompt, request.markdown, promptToken), attachments: currentAttachments }
      ], priorityAttachmentIds, request.renderedPdfPages)
      const latestAssistant = normalizedRequestMessages
        .filter(message => message.kind !== 'status' && message.role === 'assistant')
        .at(-1)
      const latestConversationMessage = normalizedRequestMessages
        .filter(message => message.kind !== 'status')
        .at(-1)
      const requestedConversation = normalizeResponsesConversation(request.responsesConversation)
      const canContinueResponsesConversation = settings.protocol === 'openai-responses' &&
        state.settings.contextMode === 'recent' &&
        !!requestedConversation &&
        requestedConversation.modelRef.connectionId === target.ref.connectionId &&
        requestedConversation.modelRef.modelId === target.ref.modelId &&
        !!latestAssistant &&
        latestConversationMessage?.role === 'assistant' &&
        latestAssistant.id === requestedConversation.anchorMessageId
      const messages = canContinueResponsesConversation
        ? await this.hydrateProviderMessages([
          { role: 'user', content: buildDocumentPrompt(request.prompt, request.markdown, promptToken), attachments: currentAttachments }
        ], priorityAttachmentIds, request.renderedPdfPages)
        : fullMessages
      const responseOptions: ProviderRequestOptions = {
        stream: true,
        store: settings.protocol === 'openai-responses' && state.settings.contextMode === 'recent',
        ...(canContinueResponsesConversation && requestedConversation
          ? { previousResponseId: requestedConversation.previousResponseId }
          : {}),
        ...(settings.protocol === 'openai-responses'
          ? request.reasoningEffortOverride === null
            ? { omitReasoningEffort: true }
            : request.reasoningEffortOverride !== undefined
              ? { reasoningEffort: request.reasoningEffortOverride }
              : {}
          : {}),
        ...(settings.protocol === 'openai-responses'
          ? { reasoningSummary: target.model.capabilities?.responses?.reasoningSummary === true }
          : {}),
        ...(settings.protocol === 'openai-responses'
          ? request.verbosityOverride === null
            ? { omitVerbosity: true }
            : request.verbosityOverride !== undefined
              ? { verbosity: request.verbosityOverride }
              : {}
          : {}),
        attempt: 1,
        ...makeProviderProgress(1)
      }
      let result: ProviderResponse
      try {
        result = await this.requestProvider(
          target,
          buildAnswerSystemPrompt(promptToken),
          messages,
          request.requestId,
          undefined,
          responseOptions
        )
      } catch (error) {
        const providerError = error instanceof ProviderRequestError ? error : undefined
        const errorText = providerError ? `${providerError.providerMessage} ${providerError.providerParam ?? ''}` : ''
        const previousIdRejected = canContinueResponsesConversation &&
          !!providerError &&
          [400, 404].includes(providerError.status) &&
          /previous[_ -]?response[_ -]?id|previous response/i.test(errorText)
        if (!previousIdRejected) throw error
        featureLog('responses conversation expired; rebuilding local context requestId=%s', request.requestId)
        result = await this.requestProvider(
          target,
          buildAnswerSystemPrompt(promptToken),
          fullMessages,
          request.requestId,
          undefined,
          { ...responseOptions, previousResponseId: undefined, attempt: 2, ...makeProviderProgress(2) }
        )
      }
      rememberProviderResponse(result)
      if (settings.protocol === 'openai-responses' && result.truncated) {
        throw new Error('The Responses API response was truncated before a complete answer was returned.')
      }
      emitProgress('validating', 1, {
        outputTokens: result.usage?.outputTokens ?? estimateTokenCount(result.content),
        outputTokensEstimated: result.usage?.outputTokens === undefined,
        inputTokens: result.usage?.inputTokens,
        inputTokensEstimated: result.usage?.inputTokens === undefined,
        streaming: false
      })
      const repaired = await this.repairMarkdownResponse(
        target,
        buildAnswerSystemPrompt(promptToken),
        messages,
        result,
        request.requestId,
        undefined,
        false,
        false,
        { ...responseOptions, attempt: 2, ...makeProviderProgress(2) }
      )
      const contextSummaryCandidate = state.settings.contextMode === 'summary'
        ? await this.createContextSummary(
          target,
          contextSummary,
          request.prompt,
          request.mode,
          repaired.content,
          request.requestId,
          undefined,
          rememberProviderResponse,
          () => emitProgress('compacting', 2, { streaming: false })
        )
        : undefined
      featureLog(
        'request content received mode=%s contentChars=%s elapsedMs=%s requestId=%s',
        request.mode,
        result.content.length,
        Date.now() - requestStartedAt,
        request.requestId
      )
      return {
        requestId: request.requestId,
        mode: request.mode,
        content: repaired.content,
        reasoning: repaired.reasoning,
        contextSummaryCandidate,
        recovery: repaired.recovery,
        ...(settings.protocol === 'openai-responses' && responseOptions.store === true && repaired.responseId
          ? { responsesConversationCandidate: { modelRef: target.ref, previousResponseId: repaired.responseId } }
          : {}),
        documentId: request.documentId,
        baseMarkdown: request.markdown,
        model: toMessageModel(target)
      }
    }

    const controller = new AbortController()
    this.controllers.set(request.requestId, controller)
    try {
      const sourceBrief = request.mode === 'edit' && currentAttachments.length
        ? await extractAttachmentSourceBrief(controller.signal)
        : undefined
      if (request.mode === 'rewrite') {
        const promptToken = makePromptToken('MT_CONTEXT')
        const messages = await this.hydrateProviderMessages([
          ...recentMessages,
          { role: 'user', content: buildDocumentPrompt(request.prompt, request.markdown, promptToken), attachments: currentAttachments }
        ], priorityAttachmentIds, request.renderedPdfPages)
        const result = await this.requestProvider(
          target,
          buildRewriteSystemPrompt(promptToken),
          messages,
          request.requestId,
          controller.signal,
          { stream: true, attempt: 1, omitVerbosity: true, ...makeProviderProgress(1) }
        )
        rememberProviderResponse(result)
        if (result.truncated) throw new Error('The model response was truncated before a complete document was returned.')
        emitProgress('validating', 1, {
          outputTokens: result.usage?.outputTokens ?? estimateTokenCount(result.content),
          outputTokensEstimated: result.usage?.outputTokens === undefined,
          inputTokens: result.usage?.inputTokens,
          inputTokensEstimated: result.usage?.inputTokens === undefined,
          streaming: false
        })
        const repaired = await this.repairMarkdownResponse(
          target,
          buildRewriteSystemPrompt(promptToken),
          messages,
          result,
          request.requestId,
          controller.signal,
          true,
          true,
          { stream: true, attempt: 2, omitVerbosity: true, ...makeProviderProgress(2) }
        )
        const markdown = repaired.content
        const contextSummaryCandidate = state.settings.contextMode === 'summary'
          ? await this.createContextSummary(
            target,
            contextSummary,
            request.prompt,
            request.mode,
            'The requested Markdown rewrite was validated successfully.',
            request.requestId,
            controller.signal,
            rememberProviderResponse,
            () => emitProgress('compacting', 2, { streaming: false })
          )
          : undefined
        featureLog(
          'request content received mode=%s contentChars=%s elapsedMs=%s requestId=%s',
          request.mode,
          markdown.length,
          Date.now() - requestStartedAt,
          request.requestId
        )
        return {
          requestId: request.requestId,
          mode: request.mode,
          content: '',
          reasoning: repaired.reasoning,
          contextSummaryCandidate,
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
        sourceBrief,
        contextMessages: recentMessages.map(message => ({ role: message.role, content: message.content, reasoning: 'reasoning' in message ? message.reasoning : undefined })),
        attachments: sourceBrief ? undefined : currentAttachments,
        generateAgent: async(agentRequest) => {
          const capabilityKey = `${settings.protocol}|${resolveRequestEndpoint(settings)}|${target.model.model}`
          const expectedTool = agentRequest.tools[0]?.name ?? 'none'
          const cachedTransport = this.toolCapabilities.get(capabilityKey)
          const maxTokens = expectedTool === 'create_markdown_edit_plan' || expectedTool === 'revise_markdown_edit_plan'
            ? 2048
            : expectedTool === 'apply_markdown_edit' && agentRequest.activeScopeChars > 6000 ? 8192 : 4096
          const messages = await this.hydrateProviderMessages(
            agentRequest.messages,
            sourceBrief ? new Set<string>() : priorityAttachmentIds,
            sourceBrief ? [] : request.renderedPdfPages
          )
          featureLog(
            'edit agent checkpoint phase=%s allowedTool=%s transport=%s version=%s planSteps=%s completedSteps=%s checkpointChars=%s sourceBriefChars=%s activeScopeChars=%s planFingerprint=%s attachmentPages=%s requestId=%s',
            agentRequest.phase,
            expectedTool,
            cachedTransport ?? 'native-strict',
            agentRequest.currentVersion,
            agentRequest.planStepCount,
            agentRequest.completedPlanStepCount,
            agentRequest.checkpointChars,
            agentRequest.sourceBriefChars,
            agentRequest.activeScopeChars,
            agentRequest.planFingerprint ? agentRequest.planFingerprint.length : 0,
            messages.reduce((total, message) => total + (message.images?.length ?? 0), 0),
            request.requestId
          )
          const providerOptions = (transport: AgentTransportMode): ProviderRequestOptions => ({
            stream: true,
            maxTokens,
            allowEmptyToolResponse: true,
            disableStreamFallback: true,
            omitVerbosity: true,
            attempt: agentRequest.attempt ?? 1,
            ...makeProviderProgress(agentRequest.attempt ?? 1),
            ...(transport === 'native-strict'
              ? { tools: agentRequest.tools, toolChoice: { name: expectedTool }, parallelToolCalls: false }
              : transport === 'native-compatible'
                ? { tools: withoutStrictToolSchemas(agentRequest.tools), toolChoice: 'required' as const }
                : transport === 'native-allowed-tools'
                  ? { tools: withoutStrictToolSchemas(agentRequest.tools), toolChoice: { name: expectedTool }, toolChoiceStyle: 'allowed-tools' as const }
                  : {})
          })
          const system = `${agentRequest.system}\nCall exactly one of the supplied editing tools on every turn.`
          const invoke = async(transport: AgentTransportMode): Promise<ProviderResponse> => {
            if (transport === 'json-envelope') {
              const jsonSystem = `${system}\nThe native tool transport is unavailable. Return exactly one JSON object matching this schema, with no Markdown fence, explanation, or extra text:\n${JSON.stringify(agentRequest.tools[0]?.parameters ?? {})}`
              return this.requestProvider(editTarget, jsonSystem, messages, agentRequest.requestId, agentRequest.signal, providerOptions(transport))
            }
            return this.requestProvider(editTarget, system, messages, agentRequest.requestId, agentRequest.signal, providerOptions(transport))
          }
          let transport = cachedTransport ?? 'native-strict'
          let fallbackUsed = false
          const invokeWithFallback = async(start: AgentTransportMode): Promise<{ transport: AgentTransportMode, response: ProviderResponse }> => {
            let current = start
            while (true) {
              try {
                return { transport: current, response: await invoke(current) }
              } catch (error) {
                const rejection = classifyAgentTransportRejection(error)
                if (!rejection) throw error
                const next = current === 'native-strict'
                  ? 'native-compatible'
                  : current === 'native-compatible'
                    ? settings.protocol === 'openai-responses' ? 'native-allowed-tools' : 'json-envelope'
                    : current === 'native-allowed-tools'
                      ? 'json-envelope'
                      : undefined
                if (!next) throw error
                featureLog(
                  'edit agent transport downgrade from=%s to=%s reason=%s requestId=%s',
                  current,
                  next,
                  rejection,
                  request.requestId
                )
                fallbackUsed = true
                current = next
              }
            }
          }
          const invoked = await invokeWithFallback(transport)
          transport = invoked.transport
          const generated = invoked.response
          rememberProviderResponse(generated)
          let toolCalls = generated.toolCalls ?? []
          if (transport === 'json-envelope' && !toolCalls.length) {
            toolCalls = parseStrictAgentEnvelope(generated.content, expectedTool)
          }
          if (fallbackUsed && toolCalls.length && !generated.truncated) {
            this.toolCapabilities.set(capabilityKey, transport)
            featureLog('edit agent transport cached transport=%s requestId=%s', transport, request.requestId)
          }
          featureLog(
            'edit agent response phase=%s transport=%s returnedTools=%s returnedNames=%s finishReason=%s truncated=%s reasoningChars=%s inputTokens=%s outputTokens=%s totalInputTokens=%s totalOutputTokens=%s totalCachedInputTokens=%s requestId=%s',
            agentRequest.phase,
            transport,
            toolCalls.length,
            toolCalls.map(call => call.name).join(',') || 'none',
            generated.finishReason ?? 'none',
            generated.truncated ?? false,
            generated.reasoning?.length ?? 0,
            generated.usage?.inputTokens ?? 'unknown',
            generated.usage?.outputTokens ?? 'unknown',
            lastProgressStats.totalInputTokens ?? 'unknown',
            lastProgressStats.totalOutputTokens ?? 'unknown',
            lastProgressStats.totalCachedInputTokens ?? 'unknown',
            request.requestId
          )
          return {
            content: generated.content,
            rawContent: generated.rawContent,
            reasoning: generated.reasoning,
            toolCalls,
            truncated: generated.truncated,
            finishReason: generated.finishReason,
            usage: generated.usage
          }
        },
        generateWhole: async(agentRequest) => {
          const messages = await this.hydrateProviderMessages(
            agentRequest.messages,
            sourceBrief ? new Set<string>() : priorityAttachmentIds,
            sourceBrief ? [] : request.renderedPdfPages
          )
          featureLog(
            'edit agent whole fallback attempt=%s messageChars=%s requestId=%s',
            agentRequest.attempt ?? 1,
            messages.reduce((total, message) => total + message.content.length, 0),
            request.requestId
          )
          const generated = await this.requestProvider(
            editTarget,
            agentRequest.system,
            messages,
            agentRequest.requestId,
            agentRequest.signal,
            {
              stream: true,
              omitVerbosity: true,
              attempt: agentRequest.attempt ?? 1,
              ...makeProviderProgress(agentRequest.attempt ?? 1)
            }
          )
          rememberProviderResponse(generated)
          return {
            content: generated.content,
            rawContent: generated.rawContent,
            reasoning: generated.reasoning,
            truncated: generated.truncated
          }
        },
        requestId: request.requestId,
        signal: controller.signal,
        maxSteps: state.settings.editAgentMaxSteps,
        onPhase: (phase, attempt) => {
          featureLog('edit agent state transition phase=%s attempt=%s requestId=%s', phase, attempt, request.requestId)
          emitProgress(phase, attempt, {
            streaming: false
          })
        },
        onAgentPlan: (summary: string, steps: AgentPlanStep[], revision: number, successfulSteps: number) => {
          emitProgress('agent-plan', revision + 1, {
            planSummary: summary,
            planStepCount: steps.length,
            planStepDescriptions: steps.slice(0, 8).map(step => step.description),
            planRevisionCount: revision,
            successfulSteps,
            maxSteps: state.settings.editAgentMaxSteps,
            streaming: false
          })
          featureLog('edit agent plan steps=%s revision=%s requestId=%s', steps.length, revision, request.requestId)
        },
        onAgentStep: (step, maxSteps, description, version, beforeMarkdown, markdown, addedLines, removedLines, removedText, addedText) => {
          emitProgress('agent-step', step, {
            step,
            maxSteps,
            successfulSteps: step,
            documentVersion: version,
            stepDescription: description,
            stepAddedLines: addedLines,
            stepRemovedLines: removedLines,
            stepRemovedText: removedText.slice(0, MAX_AGENT_DIFF_CHARS),
            stepAddedText: addedText.slice(0, MAX_AGENT_DIFF_CHARS),
            documentId: request.documentId,
            stepBaseMarkdown: beforeMarkdown,
            stepMarkdown: markdown,
            streaming: false
          })
          featureLog('agent step completed step=%s maxSteps=%s version=%s descriptionChars=%s requestId=%s', step, maxSteps, version, description.length, request.requestId)
        },
        onValidationFailure: diagnostic => {
          failureCount += 1
          const output = makeFailureOutput(diagnostic.response ?? '', diagnostic.response ?? '', diagnostic.reasoning)
          if (output.value) {
            lastFailureOutput = output.value
            lastFailureOutputTruncated = output.truncated
          }
          const failureReason: AiFailureReason = diagnostic.code === 'scope'
            ? 'scope'
            : diagnostic.code === 'exact-match'
              ? 'exact-match'
              : diagnostic.code === 'truncated'
                ? 'truncated'
                : diagnostic.code === 'missing-tool-call'
                  ? 'missing-tool-call'
                  : diagnostic.code === 'capability'
                    ? 'capability'
                    : 'format'
          emitProgress('attempt-failed', diagnostic.attempt, { failureReason, failureCount, toolFailures: failureCount, streaming: false })
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
        },
        onAgentFallback: (reason, attempt) => {
          featureLog('edit agent fallback reason=%s attempt=%s requestId=%s', reason, attempt, request.requestId)
        }
      })
      featureLog(
        'edit agent applied mode=%s completion=%s completedSteps=%s totalSteps=%s attempts=%s operations=%s addedLines=%s removedLines=%s elapsedMs=%s requestId=%s',
        request.mode,
        result.agentCompletion ?? 'complete',
        result.agentCompletedSteps ?? 0,
        result.agentTotalSteps ?? 0,
        result.attempts,
        result.summary.operationCount,
        result.summary.addedLines,
        result.summary.removedLines,
        Date.now() - requestStartedAt,
        request.requestId
      )
      const contextSummaryCandidate = state.settings.contextMode === 'summary' && result.agentCompletion !== 'partial'
        ? await this.createContextSummary(
          target,
          contextSummary,
          request.prompt,
          request.mode,
          result.message || `The requested Markdown edit completed with ${result.summary.operationCount} operation(s).`,
          request.requestId,
          controller.signal,
          rememberProviderResponse,
          () => emitProgress('compacting', result.attempts + 1, { streaming: false })
        )
        : undefined
      return {
        requestId: request.requestId,
        mode: request.mode,
        content: '',
        reasoning: result.reasoning,
        contextSummaryCandidate,
        summary: result.message,
        markdown: result.markdown,
        editSummary: result.summary,
        recovery: result.recovery,
        agentCompletion: result.agentCompletion,
        agentCompletedSteps: result.agentCompletedSteps,
        agentTotalSteps: result.agentTotalSteps,
        documentId: request.documentId,
        baseMarkdown: request.markdown,
        model: toMessageModel(target)
      }
    } catch (error) {
      const cancelled = error instanceof Error && /cancelled|canceled/i.test(error.message)
      if (!cancelled && classifyAgentTransportRejection(error)) lastFailureReason = 'capability'
      const exposeFailureOutput = !cancelled &&
        state.settings.failureOutputAfter > 0 &&
        failureCount >= state.settings.failureOutputAfter &&
        !!lastFailureOutput
      emitProgress(cancelled ? 'cancelled' : 'failed', lastAttempt, {
        streaming: false,
        ...(cancelled
          ? {}
          : {
            failureReason: lastFailureReason ?? 'provider',
            failureCount,
            ...(exposeFailureOutput
              ? { failureOutput: lastFailureOutput, failureOutputTruncated: lastFailureOutputTruncated }
              : {})
          })
      })
      throw error
    } finally {
      this.controllers.delete(request.requestId)
    }
  }
}
