export type AiProtocol = 'openai-chat-completions' | 'anthropic-messages'
export type AiInteractionMode = 'answer' | 'edit' | 'rewrite'
export type AiRecoveryStrategy = 'direct' | 'local-normalization' | 'model-repair' | 'whole-document-fallback'
export type AiModelSource = 'manual' | 'discovered'
export type AiReasoningControl = 'unknown' | 'effort' | 'budget'
export type AiReasoningField = 'reasoning' | 'reasoning_content' | 'reason_content' | 'reasoning_text'
export type AiReasoningTag = 'think' | 'thinking' | 'analysis' | 'reasoning'

export interface AiRecoveryInfo {
  strategy: AiRecoveryStrategy
  attempts: number
  changes?: string[]
  requiresConfirmation?: boolean
  warning?: string
}

export type AiImageMimeType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

export const AI_IMAGE_MIME_TYPES: readonly AiImageMimeType[] = Object.freeze([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif'
])

export const AI_MAX_IMAGE_COUNT = 10
export const AI_MAX_IMAGE_BYTES = 10 * 1024 * 1024
export const AI_MAX_IMAGE_TOTAL_BYTES = 30 * 1024 * 1024
export type AiPdfMimeType = 'application/pdf'

export const AI_PDF_MIME_TYPES: readonly AiPdfMimeType[] = Object.freeze([
  'application/pdf'
])

export const AI_MAX_PDF_BYTES = 20 * 1024 * 1024
export const AI_MAX_PDF_TOTAL_BYTES = 30 * 1024 * 1024
export const AI_PDF_RENDER_DPI = 150
export const AI_PDF_RENDER_MAX_EDGE = 2400

export interface AiImageAttachment {
  id: string
  name: string
  mimeType: AiImageMimeType
  byteSize: number
}

export interface AiImageUpload extends AiImageAttachment {
  data: Uint8Array
}

export interface AiImageData {
  mimeType: AiImageMimeType
  data: Uint8Array
}

export interface AiPdfAttachment {
  id: string
  name: string
  mimeType: AiPdfMimeType
  byteSize: number
  pages?: number[]
}

export interface AiPdfUpload extends AiPdfAttachment {
  data: Uint8Array
}

export interface AiPdfData {
  mimeType: AiPdfMimeType
  data: Uint8Array
}

export interface AiRenderedPdfPages {
  attachmentId: string
  pageNumbers: number[]
  pages: AiImageUpload[]
}

export type AiAttachment = AiImageAttachment | AiPdfAttachment
export type AiAttachmentUpload = AiImageUpload | AiPdfUpload
export type AiAttachmentData = AiImageData | AiPdfData

export interface AiModelCapabilities {
  reasoningControl?: AiReasoningControl
  reasoningField?: AiReasoningField
  reasoningTag?: AiReasoningTag
  replayReasoning?: boolean
}

export interface AiModelProfile {
  id: string
  model: string
  label: string
  source: AiModelSource
  capabilities?: AiModelCapabilities
}

export interface AiConnectionProfile {
  id: string
  name: string
  protocol: AiProtocol
  endpoint: string
  hasApiKey: boolean
  models: AiModelProfile[]
}

export interface AiModelRef {
  connectionId: string
  modelId: string
}

export interface AiSettings {
  connections: AiConnectionProfile[]
  defaultModel?: AiModelRef
  /** Number of protocol repair attempts after the initial edit generation. */
  editAutoRetryCount?: number
  /** Maximum number of successful local agent edits per precise-edit request. */
  editAgentMaxSteps?: number
  /** Number of failed attempts before exposing the final raw model output. */
  failureOutputAfter?: number
}

/** Compatibility alias for renderer code that refers to the AI settings object. */
export type AiConnectionSettings = AiSettings

export interface AiConnectionInput {
  id?: string
  name: string
  protocol: AiProtocol
  endpoint: string
  models: Array<{
    id?: string
    model: string
    label?: string
    source?: AiModelSource
    capabilities?: AiModelCapabilities
  }>
  apiKey?: string
}

/** Compatibility alias retained for callers during the settings migration. */
export type AiConnectionSettingsInput = AiConnectionInput

export interface AiModelListInput {
  connectionId?: string
  protocol: AiProtocol
  endpoint: string
  apiKey?: string
}

export interface AiDiscoveredModel {
  model: string
  label?: string
  ownedBy?: string
}

export interface AiMessageModel {
  connectionId: string
  modelId: string
  connectionName: string
  model: string
  protocol: AiProtocol
}

export type AiProgressPhase =
  | 'pdf-rendering'
  | 'pdf-rendered'
  | 'sending'
  | 'sent'
  | 'waiting'
  | 'streaming'
  | 'responded'
  | 'validating'
  | 'agent-step'
  | 'attempt-failed'
  | 'retrying'
  | 'fallback'
  | 'local-processing'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AiProgressInfo {
  phase: AiProgressPhase
  current?: number
  total?: number
  attempt?: number
  elapsedMs?: number
  outputTokens?: number
  outputTokensEstimated?: boolean
  inputTokens?: number
  inputTokensEstimated?: boolean
  failureReason?: AiFailureReason
  failureCount?: number
  failureOutput?: string
  failureOutputTruncated?: boolean
  step?: number
  maxSteps?: number
  successfulSteps?: number
  toolFailures?: number
  documentVersion?: number
  stepDescription?: string
  stepAddedLines?: number
  stepRemovedLines?: number
  stepRemovedText?: string
  stepAddedText?: string
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
}

export type AiFailureReason = 'format' | 'exact-match' | 'truncated' | 'provider' | 'capability' | 'unknown'

export type AiLiveProgressPhase = 'waiting' | 'streaming' | 'validating' | 'agent-step' | 'attempt-failed' | 'retrying' | 'fallback' | 'completed' | 'failed' | 'cancelled'

export interface AiProgressEvent {
  requestId: string
  mode: AiInteractionMode
  phase: AiLiveProgressPhase
  attempt: number
  elapsedMs: number
  outputTokens: number
  outputTokensEstimated: boolean
  inputTokens?: number
  inputTokensEstimated?: boolean
  streaming: boolean
  failureReason?: AiFailureReason
  failureCount?: number
  failureOutput?: string
  failureOutputTruncated?: boolean
  step?: number
  maxSteps?: number
  successfulSteps?: number
  toolFailures?: number
  documentVersion?: number
  stepDescription?: string
  stepAddedLines?: number
  stepRemovedLines?: number
  stepRemovedText?: string
  stepAddedText?: string
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
  /** The validated agent step snapshot to apply immediately in the renderer. */
  documentId?: string
  stepBaseMarkdown?: string
  stepMarkdown?: string
}

export interface AiChatMessage {
  id: string
  role: 'user' | 'assistant'
  mode: AiInteractionMode
  content: string
  /** Provider reasoning kept separate from the assistant's usable content. */
  reasoning?: string
  createdAt: number
  revisionId?: string
  editSummary?: AiEditSummary
  attachments?: AiAttachment[]
  model?: AiMessageModel
  kind?: 'message' | 'status'
  progress?: AiProgressInfo
}

export interface AiChatSession {
  messages: AiChatMessage[]
  selectedModel?: AiModelRef
}

export interface AiRequest {
  requestId: string
  documentId: string
  mode: AiInteractionMode
  prompt: string
  markdown: string
  messages: AiChatMessage[]
  modelRef: AiModelRef
  attachments?: AiAttachmentUpload[]
  renderedPdfPages?: AiRenderedPdfPages[]
}

export interface AiEditOperationSummary {
  startLine: number
  endLine: number
  addedLines: number
  removedLines: number
  /** The exact changed span in the resulting document, when available. */
  afterStartLine?: number
  afterEndLine?: number
  afterStartOffset?: number
  afterEndOffset?: number
}

export interface AiEditSummary {
  operationCount: number
  addedLines: number
  removedLines: number
  operations: AiEditOperationSummary[]
}

export interface AiResponse {
  requestId: string
  mode: AiInteractionMode
  content: string
  reasoning?: string
  summary?: string
  markdown?: string
  editSummary?: AiEditSummary
  recovery?: AiRecoveryInfo
  documentId: string
  baseMarkdown: string
  model: AiMessageModel
}

export interface AiTestResult {
  ok: boolean
  message: string
}

export interface AiRevisionRequest {
  documentId: string
  beforeMarkdown: string
  afterMarkdown: string
  mode: AiInteractionMode
}

export interface AiPreparedRevision extends AiRevisionRequest {
  revisionId: string
  preparedAt: number
}

export interface AiUndoResult {
  revisionId: string
  documentId: string
  beforeMarkdown: string
  afterMarkdown: string
}
