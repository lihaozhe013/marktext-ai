import type {
  AiAttachment,
  AiChatMessage,
  AiChatSession,
  AiEditSummary,
  AiMessageModel,
  AiProgressPhase,
  AiReasoningEffort,
  AiReasoningEffortOverride,
  AiRequestBodyPresetOverride,
  AiResponsesConversationState,
  AiVerbosity,
  AiVerbosityOverride
} from '@shared/types/ai'
import {
  AI_MAX_IMAGE_COUNT
} from '@shared/types/ai'
import { normalizeImageAttachment, normalizePdfAttachment } from './attachments'
import { MAX_CONTEXT_SUMMARY_CHARS } from './contextCompaction'
import {
  isReasoningEffort,
  isValidPresetText,
  isVerbosity,
  legacyReasoningPresetId,
  normalizeModelRef
} from './settingsConfig'
import { isRecord } from './utils'

export const MAX_FAILURE_OUTPUT_CHARS = 200_000
export const MAX_STORED_CHAT_MESSAGES = 100

export const normalizeAttachmentList = (value: unknown): AiAttachment[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const attachments: AiAttachment[] = []
  const ids = new Set<string>()
  for (const item of value.slice(0, AI_MAX_IMAGE_COUNT)) {
    try {
      const attachment = isRecord(item) && item.mimeType === 'application/pdf'
        ? normalizePdfAttachment(item)
        : normalizeImageAttachment(item)
      if (ids.has(attachment.id)) continue
      ids.add(attachment.id)
      attachments.push(attachment)
    } catch {
      // Invalid persisted attachment metadata is ignored without rejecting the chat.
    }
  }
  return attachments.length ? attachments : undefined
}

export const collectAttachmentIds = (messages: AiChatMessage[]): Set<string> => {
  const ids = new Set<string>()
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) ids.add(attachment.id)
  }
  return ids
}

const normalizeMessageModel = (value: unknown): AiMessageModel | undefined => {
  if (!isRecord(value)) return undefined
  if (
    typeof value.connectionId !== 'string' ||
    typeof value.modelId !== 'string' ||
    typeof value.connectionName !== 'string' ||
    typeof value.model !== 'string' ||
    (value.protocol !== 'openai-responses' && value.protocol !== 'openai-chat-completions' && value.protocol !== 'anthropic-messages')
  ) return undefined
  return {
    connectionId: value.connectionId,
    modelId: value.modelId,
    connectionName: value.connectionName,
    model: value.model,
    protocol: value.protocol
  }
}

const normalizeProgress = (value: unknown): AiChatMessage['progress'] | undefined => {
  if (!isRecord(value)) return undefined
  const phases: AiProgressPhase[] = [
    'pdf-rendering',
    'pdf-rendered',
    'attachment-extracting',
    'sending',
    'sent',
    'waiting',
    'compacting',
    'streaming',
    'responded',
    'validating',
    'agent-plan',
    'agent-step',
    'attempt-failed',
    'retrying',
    'fallback',
    'local-processing',
    'completed',
    'failed',
    'partial',
    'cancelled'
  ]
  if (!phases.includes(value.phase as AiProgressPhase)) return undefined
  return {
    phase: value.phase as AiProgressPhase,
    current: typeof value.current === 'number' ? value.current : undefined,
    total: typeof value.total === 'number' ? value.total : undefined,
    attempt: typeof value.attempt === 'number' ? value.attempt : undefined,
    elapsedMs: typeof value.elapsedMs === 'number' ? value.elapsedMs : undefined,
    outputTokens: typeof value.outputTokens === 'number' ? value.outputTokens : undefined,
    outputTokensEstimated: typeof value.outputTokensEstimated === 'boolean' ? value.outputTokensEstimated : undefined,
    inputTokens: typeof value.inputTokens === 'number' ? value.inputTokens : undefined,
    inputTokensEstimated: typeof value.inputTokensEstimated === 'boolean' ? value.inputTokensEstimated : undefined,
    failureCount: typeof value.failureCount === 'number' ? value.failureCount : undefined,
    failureOutput: typeof value.failureOutput === 'string' ? value.failureOutput.slice(0, MAX_FAILURE_OUTPUT_CHARS) : undefined,
    failureOutputTruncated: typeof value.failureOutputTruncated === 'boolean' ? value.failureOutputTruncated : undefined,
    step: typeof value.step === 'number' ? value.step : undefined,
    maxSteps: typeof value.maxSteps === 'number' ? value.maxSteps : undefined,
    successfulSteps: typeof value.successfulSteps === 'number' ? value.successfulSteps : undefined,
    toolFailures: typeof value.toolFailures === 'number' ? value.toolFailures : undefined,
    documentVersion: typeof value.documentVersion === 'number' ? value.documentVersion : undefined,
    stepDescription: typeof value.stepDescription === 'string' ? value.stepDescription.slice(0, 160) : undefined,
    planSummary: typeof value.planSummary === 'string' ? value.planSummary.slice(0, 240) : undefined,
    planStepCount: typeof value.planStepCount === 'number' ? value.planStepCount : undefined,
    planStepDescriptions: Array.isArray(value.planStepDescriptions)
      ? value.planStepDescriptions.filter((item): item is string => typeof item === 'string').slice(0, 8).map(item => item.slice(0, 160))
      : undefined,
    planRevisionCount: typeof value.planRevisionCount === 'number' ? value.planRevisionCount : undefined,
    currentPlanStep: typeof value.currentPlanStep === 'string' ? value.currentPlanStep.slice(0, 80) : undefined,
    stepAddedLines: typeof value.stepAddedLines === 'number' ? value.stepAddedLines : undefined,
    stepRemovedLines: typeof value.stepRemovedLines === 'number' ? value.stepRemovedLines : undefined,
    stepRemovedText: typeof value.stepRemovedText === 'string' ? value.stepRemovedText.slice(0, 16000) : undefined,
    stepAddedText: typeof value.stepAddedText === 'string' ? value.stepAddedText.slice(0, 16000) : undefined,
    cachedInputTokens: typeof value.cachedInputTokens === 'number' ? value.cachedInputTokens : undefined,
    cacheWriteInputTokens: typeof value.cacheWriteInputTokens === 'number' ? value.cacheWriteInputTokens : undefined,
    totalInputTokens: typeof value.totalInputTokens === 'number' ? value.totalInputTokens : undefined,
    totalOutputTokens: typeof value.totalOutputTokens === 'number' ? value.totalOutputTokens : undefined,
    totalCachedInputTokens: typeof value.totalCachedInputTokens === 'number' ? value.totalCachedInputTokens : undefined,
    totalCacheWriteInputTokens: typeof value.totalCacheWriteInputTokens === 'number' ? value.totalCacheWriteInputTokens : undefined,
    failureReason: value.failureReason === 'format' || value.failureReason === 'exact-match' || value.failureReason === 'scope' || value.failureReason === 'truncated' || value.failureReason === 'missing-tool-call' || value.failureReason === 'provider' || value.failureReason === 'capability' || value.failureReason === 'unknown'
      ? value.failureReason
      : undefined
  }
}

export const normalizeMessages = (messages: unknown): AiChatMessage[] => {
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
        reasoning: typeof item.reasoning === 'string' ? item.reasoning : undefined,
        kind: item.kind === 'status' ? 'status' as const : undefined,
        progress: item.kind === 'status' ? normalizeProgress(item.progress) : undefined,
        revisionId: typeof item.revisionId === 'string' ? item.revisionId : undefined,
        editSummary,
        attachments: normalizeAttachmentList(item.attachments),
        model: normalizeMessageModel(item.model)
      }
    })
    .slice(-MAX_STORED_CHAT_MESSAGES)
}

const requestBodyPresetOverrideKey = (value: AiRequestBodyPresetOverride): string =>
  `${value.modelRef.connectionId}\u0000${value.modelRef.modelId}`

const normalizeRequestBodyPresetOverrides = (value: unknown): AiRequestBodyPresetOverride[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const overrides = new Map<string, AiRequestBodyPresetOverride>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const modelRef = normalizeModelRef(item.modelRef)
    if (!modelRef) continue
    let presetId: string | null | undefined
    if (item.presetId === null || item.value === null) presetId = null
    else if (typeof item.presetId === 'string' && isValidPresetText(item.presetId.trim())) presetId = item.presetId.trim()
    else if (typeof item.value === 'string' && isValidPresetText(item.value.trim())) presetId = legacyReasoningPresetId(item.value.trim())
    if (presetId === undefined) continue
    const normalized = { modelRef, presetId }
    overrides.set(requestBodyPresetOverrideKey(normalized), normalized)
  }
  return overrides.size ? Array.from(overrides.values()) : undefined
}

const normalizeReasoningEffortOverrides = (value: unknown): AiReasoningEffortOverride[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const overrides = new Map<string, AiReasoningEffortOverride>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const modelRef = normalizeModelRef(item.modelRef)
    if (!modelRef) continue
    if (item.effort !== null && !isReasoningEffort(item.effort)) continue
    const normalized = { modelRef, effort: item.effort as AiReasoningEffort | null }
    overrides.set(`${modelRef.connectionId}\u0000${modelRef.modelId}`, normalized)
  }
  return overrides.size ? Array.from(overrides.values()) : undefined
}

const normalizeVerbosityOverrides = (value: unknown): AiVerbosityOverride[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const overrides = new Map<string, AiVerbosityOverride>()
  for (const item of value) {
    if (!isRecord(item)) continue
    const modelRef = normalizeModelRef(item.modelRef)
    if (!modelRef) continue
    if (item.verbosity !== null && !isVerbosity(item.verbosity)) continue
    const normalized = { modelRef, verbosity: item.verbosity as AiVerbosity | null }
    overrides.set(`${modelRef.connectionId}\u0000${modelRef.modelId}`, normalized)
  }
  return overrides.size ? Array.from(overrides.values()) : undefined
}

export const normalizeResponsesConversation = (value: unknown): AiResponsesConversationState | undefined => {
  if (!isRecord(value)) return undefined
  const modelRef = normalizeModelRef(value.modelRef)
  if (!modelRef || typeof value.previousResponseId !== 'string' || !value.previousResponseId.trim() || typeof value.anchorMessageId !== 'string' || !value.anchorMessageId.trim()) return undefined
  return {
    modelRef,
    previousResponseId: value.previousResponseId.trim(),
    anchorMessageId: value.anchorMessageId.trim()
  }
}

export const normalizeChatSession = (value: unknown): AiChatSession => {
  if (Array.isArray(value)) return { messages: normalizeMessages(value) }
  if (!isRecord(value)) return { messages: [] }
  const legacyPresetOverrides = Array.isArray(value.reasoningEffortOverrides)
    ? value.reasoningEffortOverrides.filter(item => isRecord(item) && item.effort === undefined)
    : undefined
  return {
    messages: normalizeMessages(value.messages),
    selectedModel: normalizeModelRef(value.selectedModel),
    requestBodyPresetOverrides: normalizeRequestBodyPresetOverrides(value.requestBodyPresetOverrides ?? legacyPresetOverrides),
    reasoningEffortOverrides: normalizeReasoningEffortOverrides(value.reasoningEffortOverrides),
    verbosityOverrides: normalizeVerbosityOverrides(value.verbosityOverrides),
    responsesConversation: normalizeResponsesConversation(value.responsesConversation),
    contextSummary: typeof value.contextSummary === 'string'
      ? value.contextSummary.trim().slice(0, MAX_CONTEXT_SUMMARY_CHARS) || undefined
      : undefined
  }
}
