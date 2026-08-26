import { serializeProviderMessages, serializeResponsesInput, type ProviderMessage } from './providerMessages'
import { consumeProviderStream, estimateTokenCount, ProviderStreamError } from './providerStream'
import { type ProviderReasoningCompatibility } from './providerReasoning'
import { renderedPdfImageRules } from './prompts'
import { featureLog, requestBodyPresetLog } from './logging'
import { resolveRequestEndpoint } from './providerClient'
import {
  mergeRequestBodyPreset,
  validateResponsesPresetBody
} from './settingsConfig'
import { extractFinishReason, extractResponseContent, extractToolCalls, extractUsage, isTruncatedResponse } from './responseParsing'
import { isRecord } from './utils'
import type { ProviderRequestOptions, ProviderResponse, ResolvedModelTarget } from './types'

export const ANTHROPIC_VERSION = '2023-06-01'
const REQUEST_TIMEOUT_MS = 300_000

export class ProviderRequestError extends Error {
  readonly status: number
  readonly toolRequest: boolean
  readonly providerMessage: string
  readonly providerParam?: string
  readonly providerType?: string
  readonly providerCode?: string
  readonly streamFailure: boolean

  constructor(
    message: string,
    status: number,
    toolRequest: boolean,
    providerMessage = message,
    providerParam?: string,
    metadata: { providerType?: string; providerCode?: string; streamFailure?: boolean } = {}
  ) {
    super(message)
    this.name = 'ProviderRequestError'
    this.status = status
    this.toolRequest = toolRequest
    this.providerMessage = providerMessage
    this.providerParam = providerParam
    this.providerType = metadata.providerType
    this.providerCode = metadata.providerCode
    this.streamFailure = metadata.streamFailure === true
  }
}

export type AgentTransportRejection = 'strict' | 'tools'

export const classifyAgentTransportRejection = (error: unknown): AgentTransportRejection | undefined => {
  if (
    !(error instanceof ProviderRequestError) ||
    !error.toolRequest ||
    (!error.streamFailure && ![400, 404, 422].includes(error.status))
  ) return undefined
  const message = `${error.providerMessage} ${error.providerParam ?? ''} ${error.providerType ?? ''} ${error.providerCode ?? ''}`
  const mentionsTools = /\btools?\b|\btool[_ -]?choice\b|\bparallel[_ -]?tool[_ -]?calls\b|\btool calling\b|\bfunction calling\b/i.test(message)
  const mentionsStrict = /\bstrict\b|function schema|function parameters|schema validation|\bschema\b/i.test(message)
  if (!mentionsTools && !mentionsStrict) return undefined
  const mentionsUnsupported = /unsupported|not support|does not support|unknown|unrecognized|invalid|not allowed|forbidden|rejected|unexpected|cannot|must be|does not accept/i.test(message)
  const explicitToolParameter = /\btools?\b|\btool[_ -]?choice\b|\bparallel[_ -]?tool[_ -]?calls\b|\bstrict\b|\bschema\b/i.test(error.providerParam ?? '')
  if (!mentionsUnsupported && !explicitToolParameter) return undefined
  return mentionsStrict && !mentionsTools ? 'strict' : 'tools'
}

export class AiProviderRequest {
  constructor(private readonly controllers: Map<string, AbortController>) {}

  async request(
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
    const compatibility: ProviderReasoningCompatibility = {
      field: target.model.capabilities?.reasoningField,
      tag: target.model.capabilities?.reasoningTag,
      replay: target.model.capabilities?.replayReasoning
    }
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
      let streaming = options.stream === true
      let includeStreamUsage = streaming && settings.protocol === 'openai-chat-completions'
      let streamFallbackAttempted = false
      let streamFallbackOverride: boolean | undefined
      let removeStreamOptionsForRetry = false
      while (true) {
        const headers: Record<string, string> = {
          accept: streaming ? 'text/event-stream, application/json' : 'application/json',
          'content-type': 'application/json'
        }
        let body: Record<string, unknown>
        const effectiveSystem = messages.some(message => !!message.attachmentContext)
          ? `${system}\n${renderedPdfImageRules}`
          : system
        if (settings.protocol === 'anthropic-messages') {
          headers['x-api-key'] = apiKey
          headers['api-key'] = apiKey
          headers['anthropic-version'] = ANTHROPIC_VERSION
          body = {
            model,
            max_tokens: options.maxTokens ?? 4096,
            system: effectiveSystem,
            messages: serializeProviderMessages(
              settings.protocol,
              messages,
              undefined,
              compatibility.replay
            ),
            ...(streaming ? { stream: true } : {})
          }
          if (options.tools?.length) {
            body.tools = options.tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }))
            body.tool_choice = options.toolChoice === 'auto'
              ? { type: 'auto' }
              : typeof options.toolChoice === 'object'
                ? { type: 'tool', name: options.toolChoice.name }
                : { type: 'any' }
          }
        } else if (settings.protocol === 'openai-responses') {
          headers.authorization = `Bearer ${apiKey}`
          headers['api-key'] = apiKey
          body = {
            model,
            instructions: effectiveSystem,
            input: serializeResponsesInput(messages),
            max_output_tokens: options.maxTokens ?? 8192,
            ...(streaming ? { stream: true } : {}),
            store: options.store ?? false,
            ...(options.previousResponseId ? { previous_response_id: options.previousResponseId } : {})
          }
          if (options.tools?.length) {
            body.tools = options.tools.map(tool => ({
              type: 'function',
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
              ...(tool.strict !== undefined ? { strict: tool.strict } : {})
            }))
            body.tool_choice = options.toolChoice === 'auto'
              ? 'auto'
              : options.toolChoiceStyle === 'allowed-tools' && typeof options.toolChoice === 'object'
                ? {
                  type: 'allowed_tools',
                  mode: 'required',
                  tools: [{ type: 'function', name: options.toolChoice.name }]
                }
                : typeof options.toolChoice === 'object'
                  ? { type: 'function', name: options.toolChoice.name }
                  : 'required'
            if (options.parallelToolCalls !== undefined) body.parallel_tool_calls = options.parallelToolCalls
          }
        } else {
          headers.authorization = `Bearer ${apiKey}`
          // Some OpenAI-compatible gateways, including MiMo Token Plan, document
          // `api-key` instead of the standard Authorization header.
          headers['api-key'] = apiKey
          body = {
            model,
            max_tokens: options.maxTokens ?? 8192,
            messages: [{ role: 'system', content: effectiveSystem }, ...serializeProviderMessages(
              settings.protocol,
              messages,
              compatibility.replay
                ? compatibility.field ?? 'reasoning_content'
                : undefined,
              compatibility.replay
            )],
            ...(streaming ? { stream: true } : {})
          }
          if (includeStreamUsage) body.stream_options = { include_usage: true }
          if (options.tools?.length) {
            body.tools = options.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters, ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } }))
            body.tool_choice = options.toolChoice === 'auto'
              ? 'auto'
              : typeof options.toolChoice === 'object'
                ? { type: 'function', function: { name: options.toolChoice.name } }
                : 'required'
            if (options.parallelToolCalls !== undefined) body.parallel_tool_calls = options.parallelToolCalls
          }
        }
        if (!options.omitRequestBodyPreset && target.requestBodyPreset) {
          if (settings.protocol === 'openai-responses') validateResponsesPresetBody(target.requestBodyPreset.body)
          body = mergeRequestBodyPreset(body, target.requestBodyPreset)
          requestBodyPresetLog(
            'applied presetId=%s presetName=%s topLevelKeys=%s model=%s requestId=%s',
            target.requestBodyPreset.id,
            target.requestBodyPreset.name,
            Object.keys(target.requestBodyPreset.body).join(','),
            model,
            requestId
          )
        }
        if (settings.protocol === 'openai-responses') {
          const responseOptions = target.model.capabilities?.responses
          const reasoning = isRecord(body.reasoning) ? body.reasoning : {}
          const effort = options.omitReasoningEffort
            ? undefined
            : options.reasoningEffort ?? responseOptions?.reasoningEffort
          if (effort) reasoning.effort = effort
          else delete reasoning.effort
          const summary = options.reasoningSummary ?? responseOptions?.reasoningSummary
          if (summary) reasoning.summary = 'auto'
          else delete reasoning.summary
          delete reasoning.generate_summary
          if (Object.keys(reasoning).length) body.reasoning = reasoning
          else delete body.reasoning
          const text = isRecord(body.text) ? { ...body.text } : {}
          const verbosity = options.omitVerbosity
            ? undefined
            : options.verbosity ?? responseOptions?.verbosity
          if (verbosity) text.verbosity = verbosity
          else delete text.verbosity
          if (Object.keys(text).length) body.text = text
          else delete body.text
          body.model = model
          body.instructions = effectiveSystem
          body.input = serializeResponsesInput(messages)
          body.store = options.store ?? false
          if (options.previousResponseId) body.previous_response_id = options.previousResponseId
          else delete body.previous_response_id
          if (streaming) body.stream = true
          else delete body.stream
        }
        if (streamFallbackOverride === false) delete body.stream
        else if (streamFallbackOverride === true) body.stream = true
        if (removeStreamOptionsForRetry) delete body.stream_options
        streaming = body.stream === true
        headers.accept = streaming ? 'text/event-stream, application/json' : 'application/json'
        if (!streaming && includeStreamUsage && !Object.prototype.hasOwnProperty.call(target.requestBodyPreset?.body ?? {}, 'stream_options')) {
          delete body.stream_options
        }
        featureLog(
          'request start protocol=%s endpoint=%s model=%s stream=%s attempt=%s requestId=%s',
          settings.protocol,
          requestEndpoint,
          model,
          streaming,
          options.attempt ?? 1,
          requestId
        )
        options.onWaiting?.()
        const requestStartedAt = Date.now()
        const response = await fetch(requestEndpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          redirect: 'error',
          signal: controller.signal
        })
        const contentType = response.headers?.get('content-type') ?? ''
        featureLog(
          'request headers received status=%s contentType=%s protocol=%s stream=%s elapsedMs=%s requestId=%s',
          response.status,
          contentType.split(';', 1)[0],
          settings.protocol,
          streaming,
          Date.now() - requestStartedAt,
          requestId
        )
        if (response.ok && streaming && contentType.toLowerCase().includes('text/event-stream')) {
          if (!response.body) throw new Error('The provider returned an empty event stream.')
          let streamed: Awaited<ReturnType<typeof consumeProviderStream>>
          try {
            streamed = await consumeProviderStream(settings.protocol, response.body, controller.signal, options.onProgress, compatibility)
          } catch (error) {
            if (!(error instanceof ProviderStreamError)) throw error
            featureLog(
              'provider stream error event=%s type=%s code=%s param=%s toolRequest=%s requestId=%s',
              error.event,
              error.type ?? 'unknown',
              error.code ?? 'unknown',
              error.param ?? 'unknown',
              !!options.tools?.length,
              requestId
            )
            throw new ProviderRequestError(
              `Provider returned a failed Responses stream from ${requestEndpoint}. ${error.message}`,
              response.status,
              !!options.tools?.length,
              error.message,
              error.param,
              { providerType: error.type, providerCode: error.code, streamFailure: true }
            )
          }
          featureLog(
            'request body complete protocol=%s stream=true contentChars=%s outputTokens=%s outputTokensEstimated=%s elapsedMs=%s requestId=%s',
            settings.protocol,
            streamed.content.length,
            streamed.usage?.outputTokens ?? estimateTokenCount(streamed.content),
            streamed.usage?.outputTokens === undefined,
            Date.now() - requestStartedAt,
            requestId
          )
          if (!streamed.content && !streamed.toolCalls.length && !options.allowEmptyToolResponse) throw new Error('The provider returned no text content.')
          return streamed
        }
        const text = await response.text()
        featureLog(
          'request body complete protocol=%s stream=%s contentChars=%s elapsedMs=%s requestId=%s',
          settings.protocol,
          streaming,
          text.length,
          Date.now() - requestStartedAt,
          requestId
        )
        let payload: unknown
        try {
          payload = JSON.parse(text)
        } catch {
          payload = null
        }
        if (!response.ok) {
          const providerError = isRecord(payload) && isRecord(payload.error) ? payload.error : undefined
          const providerMessage = providerError && typeof providerError.message === 'string'
            ? providerError.message
            : `Provider returned HTTP ${response.status}.`
          const providerParam = providerError && typeof providerError.param === 'string' ? providerError.param : undefined
          const explicitlyRejectedStream = /\bstream(?:_options)?\b/i.test(providerMessage)
          const unsupportedStreamStatus = streaming && explicitlyRejectedStream && [400, 404, 405, 415, 422].includes(response.status)
          const hasStreamOptions = Object.prototype.hasOwnProperty.call(body, 'stream_options')
          if (unsupportedStreamStatus && !options.disableStreamFallback && hasStreamOptions && /\bstream_options\b/i.test(providerMessage)) {
            includeStreamUsage = false
            removeStreamOptionsForRetry = true
            featureLog('stream usage option rejected; retrying without usage option requestId=%s', requestId)
            continue
          }
          if (unsupportedStreamStatus && !options.disableStreamFallback && !streamFallbackAttempted && !/\bstream_options\b/i.test(providerMessage)) {
            streamFallbackOverride = false
            streaming = false
            streamFallbackAttempted = true
            featureLog('stream unsupported; falling back to JSON requestId=%s', requestId)
            continue
          }
          const attachmentHint = messages.some(message => !!message.images?.length)
            ? ' The configured model or endpoint may not support image input.'
            : ''
          throw new ProviderRequestError(
            `Provider returned HTTP ${response.status} from ${requestEndpoint}. ${providerMessage}${attachmentHint}`,
            response.status,
            !!options.tools?.length,
            providerMessage,
            providerParam
          )
        }
        const extracted = extractResponseContent(payload, settings.protocol, compatibility)
        const content = extracted.content
        const toolCalls = extractToolCalls(payload, settings.protocol)
        if (settings.protocol === 'openai-responses' && extracted.refusal && !content && !toolCalls.length) {
          throw new Error(`Provider refusal: ${extracted.refusal}`)
        }
        if (!content && !toolCalls.length && !options.allowEmptyToolResponse) throw new Error('The provider returned no text content.')
        const usage = extractUsage(payload, settings.protocol)
        options.onProgress?.({
          outputCharacters: content.length + (extracted.reasoning?.length ?? 0),
          reasoningCharacters: extracted.reasoning?.length ?? 0,
          outputTokens: usage?.outputTokens ?? estimateTokenCount(`${content}${extracted.reasoning ?? ''}`),
          usage,
          firstEvent: true
        })
        return {
          content,
          rawContent: extracted.rawContent ?? content,
          reasoning: extracted.reasoning,
          toolCalls,
          usage,
          truncated: isTruncatedResponse(payload, settings.protocol),
          finishReason: extractFinishReason(payload, settings.protocol),
          ...(settings.protocol === 'openai-responses' && isRecord(payload) && typeof payload.id === 'string'
            ? { responseId: payload.id }
            : {})
        }
      }
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
      const hasAttachments = messages.some(message => !!message.images?.length)
      if (hasAttachments) {
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
}
