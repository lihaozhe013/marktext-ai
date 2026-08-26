import type {
  AiChatMessage,
  AiModelProfile,
  AiModelRef,
  AiPreparedRevision,
  AiProgressEvent,
  AiReasoningEffort,
  AiRecoveryInfo,
  AiRequestBodyPreset,
  AiSettings,
  AiVerbosity,
  AiProtocol
} from '@shared/types/ai'
import type { ProviderStreamProgress, ProviderUsage } from './providerStream'
import type { ProviderToolCall, ProviderToolDefinition } from './providerMessages'

export interface StoredConnection {
  id: string
  name: string
  protocol: AiProtocol
  endpoint: string
  models: AiModelProfile[]
}

export interface StoredSettings {
  schemaVersion: number
  connections: StoredConnection[]
  defaultModel?: AiModelRef
  lastUsedModel?: AiModelRef
  lastUsedReasoningEffort?: AiSettings['lastUsedReasoningEffort']
  lastUsedVerbosity?: AiSettings['lastUsedVerbosity']
  editAutoRetryCount: number
  editAgentMaxSteps: number
  failureOutputAfter: number
  contextMode: 'recent' | 'summary'
}

export type StoredKeys = Record<string, string>

export interface ResolvedModelTarget {
  connection: StoredConnection
  model: AiModelProfile
  apiKey: string
  ref: AiModelRef
  attribution: NonNullable<AiChatMessage['model']>
  requestBodyPreset?: AiRequestBodyPreset
}

export interface StoredRevision extends AiPreparedRevision {
  status: 'prepared' | 'committed'
  committedAt?: number
}

export interface StoredRevisionState {
  revisions: StoredRevision[]
}

export interface ProviderResponse {
  content: string
  rawContent: string
  reasoning?: string
  truncated: boolean
  toolCalls?: ProviderToolCall[]
  usage?: ProviderUsage
  finishReason?: string
  responseId?: string
}

export type ProviderToolChoice = 'required' | 'auto' | { name: string }

export interface ProviderRequestOptions {
  tools?: ProviderToolDefinition[]
  toolChoice?: ProviderToolChoice
  toolChoiceStyle?: 'named-function' | 'allowed-tools'
  parallelToolCalls?: boolean
  allowEmptyToolResponse?: boolean
  disableStreamFallback?: boolean
  stream?: boolean
  maxTokens?: number
  omitRequestBodyPreset?: boolean
  attempt?: number
  onWaiting?: () => void
  onProgress?: (progress: ProviderStreamProgress) => void
  previousResponseId?: string
  store?: boolean
  reasoningEffort?: AiReasoningEffort
  omitReasoningEffort?: boolean
  reasoningSummary?: boolean
  verbosity?: AiVerbosity
  omitVerbosity?: boolean
}

export type AgentTransportMode = 'native-strict' | 'native-compatible' | 'native-allowed-tools' | 'json-envelope'

export type AiProgressSink = (event: AiProgressEvent) => void

export interface RepairedMarkdownResult {
  content: string
  reasoning?: string
  responseId?: string
  recovery: AiRecoveryInfo
}
