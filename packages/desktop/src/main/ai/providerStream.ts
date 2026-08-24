import type { AiProtocol } from '@shared/types/ai'
import type { ProviderToolCall } from './providerMessages'
import {
  extractAnthropicThinkingDelta,
  normalizeProviderContent,
  readReasoningField,
  type ProviderReasoningCompatibility
} from './providerReasoning'

export interface ProviderUsage {
  inputTokens?: number
  outputTokens?: number
  cachedInputTokens?: number
  cacheWriteInputTokens?: number
}

export interface ProviderStreamProgress {
  outputCharacters: number
  reasoningCharacters: number
  outputTokens: number
  usage?: ProviderUsage
  firstEvent: boolean
}

export interface ProviderStreamResult {
  content: string
  rawContent: string
  reasoning?: string
  toolCalls: ProviderToolCall[]
  usage?: ProviderUsage
  truncated: boolean
  finishReason?: string
  responseId?: string
}

interface SseEvent {
  event?: string
  data: string
}

interface OpenAiToolAccumulator {
  id: string
  name: string
  arguments: string
}

interface AnthropicToolAccumulator {
  id: string
  name: string
  input: string
}

interface ResponsesToolAccumulator {
  id: string
  name: string
  arguments: string
}

interface ProviderStreamState {
  truncated: boolean
  finishReason?: string
  responseId?: string
  responseStatus?: string
  terminal?: boolean
  error?: string
  refusal?: string
  finalResponse?: Record<string, unknown>
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const asNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined

/**
 * This is intentionally only a display estimate. Providers use model-specific
 * tokenizers, so it must never be used for billing, truncation, or validation.
 */
export const estimateTokenCount = (value: string): number => {
  let asciiCharacters = 0
  let nonAsciiCodePoints = 0
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    if (codePoint <= 0x7f) asciiCharacters += 1
    else nonAsciiCodePoints += 1
  }
  return Math.ceil(asciiCharacters / 4 + nonAsciiCodePoints)
}

const parseJson = (value: string): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

const parseToolInput = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

const parseSseEvents = async(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onEvent: (event: SseEvent) => void
): Promise<void> => {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let eventName: string | undefined
  let eventData: string[] = []

  const dispatch = (): void => {
    if (!eventData.length) {
      eventName = undefined
      return
    }
    onEvent({ event: eventName, data: eventData.join('\n') })
    eventName = undefined
    eventData = []
  }

  const consumeLines = (): void => {
    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex >= 0) {
      let line = buffer.slice(0, newlineIndex)
      buffer = buffer.slice(newlineIndex + 1)
      if (line.endsWith('\r')) line = line.slice(0, -1)
      if (!line) {
        dispatch()
      } else if (line.startsWith(':')) {
        // SSE comments are keep-alive heartbeats.
      } else if (line.startsWith('event:')) {
        eventName = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        eventData.push(line.slice('data:'.length).trimStart())
      }
      newlineIndex = buffer.indexOf('\n')
    }
  }

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('The request was aborted.', 'AbortError')
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      consumeLines()
    }
    buffer += decoder.decode()
    consumeLines()
    if (buffer.trim() || eventData.length) {
      if (buffer.trim()) eventData.push(buffer.trim())
      dispatch()
    }
  } finally {
    reader.releaseLock()
  }
}

const readOpenAiDelta = (
  payload: Record<string, unknown>,
  content: { value: string },
  reasoning: { value: string },
  tools: Map<number, OpenAiToolAccumulator>,
  usage: { value?: ProviderUsage },
  state: ProviderStreamState,
  compatibility: ProviderReasoningCompatibility
): { content: string; reasoning: string } => {
  const choices = Array.isArray(payload.choices) ? payload.choices : []
  const choice = isRecord(choices[0]) ? choices[0] : undefined
  const delta = choice && isRecord(choice.delta) ? choice.delta : undefined
  if (typeof delta?.content === 'string') content.value += delta.content
  const reasoningDelta = readReasoningField(delta, compatibility.field)
  if (reasoningDelta) reasoning.value += reasoningDelta
  if (Array.isArray(delta?.tool_calls)) {
    for (const item of delta.tool_calls) {
      if (!isRecord(item)) continue
      const index = asNumber(item.index) ?? tools.size
      const current = tools.get(index) ?? { id: '', name: '', arguments: '' }
      if (typeof item.id === 'string') current.id = item.id
      const functionValue = isRecord(item.function) ? item.function : undefined
      if (typeof functionValue?.name === 'string') current.name += functionValue.name
      if (typeof functionValue?.arguments === 'string') current.arguments += functionValue.arguments
      tools.set(index, current)
    }
  }
  const finishReason = choice?.finish_reason
  if (typeof finishReason === 'string') state.finishReason = finishReason
  if (finishReason === 'length' || finishReason === 'max_tokens') state.truncated = true
  const payloadUsage = isRecord(payload.usage) ? payload.usage : undefined
  const inputTokens = asNumber(payloadUsage?.prompt_tokens)
  const outputTokens = asNumber(payloadUsage?.completion_tokens)
  const promptDetails = isRecord(payloadUsage?.prompt_tokens_details) ? payloadUsage.prompt_tokens_details : undefined
  const cachedInputTokens = asNumber(promptDetails?.cached_tokens)
  if (inputTokens !== undefined || outputTokens !== undefined) {
    usage.value = {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {})
    }
  }
  return {
    content: typeof delta?.content === 'string' ? delta.content : '',
    reasoning: reasoningDelta
  }
}

const readAnthropicDelta = (
  event: SseEvent,
  payload: Record<string, unknown>,
  content: { value: string },
  reasoning: { value: string },
  tools: Map<number, AnthropicToolAccumulator>,
  usage: { value?: ProviderUsage },
  state: ProviderStreamState
): { content: string; reasoning: string } => {
  const eventType = event.event ?? (typeof payload.type === 'string' ? payload.type : '')
  if (eventType === 'message_start') {
    const message = isRecord(payload.message) ? payload.message : undefined
    const messageUsage = message && isRecord(message.usage) ? message.usage : undefined
    const inputTokens = asNumber(messageUsage?.input_tokens)
    const cachedInputTokens = asNumber(messageUsage?.cache_read_input_tokens)
    const cacheWriteInputTokens = asNumber(messageUsage?.cache_creation_input_tokens)
    if (inputTokens !== undefined || cachedInputTokens !== undefined || cacheWriteInputTokens !== undefined) {
      usage.value = {
        ...usage.value,
        ...(inputTokens !== undefined ? { inputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {})
      }
    }
  } else if (eventType === 'content_block_start') {
    const index = asNumber(payload.index) ?? tools.size
    const block = isRecord(payload.content_block) ? payload.content_block : undefined
    if (block?.type === 'tool_use') {
      tools.set(index, {
        id: typeof block.id === 'string' ? block.id : '',
        name: typeof block.name === 'string' ? block.name : '',
        input: ''
      })
    }
  } else if (eventType === 'content_block_delta') {
    const index = asNumber(payload.index) ?? 0
    const delta = isRecord(payload.delta) ? payload.delta : undefined
    if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
      content.value += delta.text
      return { content: delta.text, reasoning: '' }
    }
    const thinking = extractAnthropicThinkingDelta(delta)
    if (thinking) {
      reasoning.value += thinking
      return { content: '', reasoning: thinking }
    }
    if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const tool = tools.get(index) ?? { id: '', name: '', input: '' }
      tool.input += delta.partial_json
      tools.set(index, tool)
    }
  } else if (eventType === 'message_delta') {
    const delta = isRecord(payload.delta) ? payload.delta : undefined
    if (typeof delta?.stop_reason === 'string') state.finishReason = delta.stop_reason
    if (delta?.stop_reason === 'max_tokens') state.truncated = true
    const deltaUsage = isRecord(payload.usage) ? payload.usage : undefined
    const outputTokens = asNumber(deltaUsage?.output_tokens)
    const cachedInputTokens = asNumber(deltaUsage?.cache_read_input_tokens)
    const cacheWriteInputTokens = asNumber(deltaUsage?.cache_creation_input_tokens)
    if (outputTokens !== undefined || cachedInputTokens !== undefined || cacheWriteInputTokens !== undefined) {
      usage.value = {
        ...usage.value,
        ...(outputTokens !== undefined ? { outputTokens } : {}),
        ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
        ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {})
      }
    }
  }
  return { content: '', reasoning: '' }
}

const readResponsesUsage = (value: unknown): ProviderUsage | undefined => {
  if (!isRecord(value)) return undefined
  const inputTokens = asNumber(value.input_tokens)
  const outputTokens = asNumber(value.output_tokens)
  const inputDetails = isRecord(value.input_tokens_details) ? value.input_tokens_details : undefined
  const cachedInputTokens = asNumber(inputDetails?.cached_tokens)
  const cacheWriteInputTokens = asNumber(inputDetails?.cache_write_tokens)
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined && cacheWriteInputTokens === undefined) return undefined
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {})
  }
}

const readResponsesOutput = (
  response: Record<string, unknown>,
  content: { value: string },
  reasoning: { value: string },
  tools: Map<string, ResponsesToolAccumulator>,
  state: ProviderStreamState,
  usage: { value?: ProviderUsage }
): void => {
  const output = Array.isArray(response.output) ? response.output : undefined
  if (!output) {
    usage.value = readResponsesUsage(response.usage) ?? usage.value
    if (typeof response.id === 'string') state.responseId = response.id
    if (typeof response.status === 'string') {
      state.responseStatus = response.status
      state.finishReason = response.status
    }
    const incomplete = isRecord(response.incomplete_details) ? response.incomplete_details : undefined
    if (response.status === 'incomplete' || incomplete?.reason === 'max_output_tokens') state.truncated = true
    return
  }
  content.value = ''
  reasoning.value = ''
  tools.clear()
  const streamedRefusal = state.refusal
  const finalRefusals: string[] = []
  for (const item of output) {
    if (!isRecord(item)) continue
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isRecord(part)) continue
        if (part.type === 'output_text' && typeof part.text === 'string') content.value += part.text
        else if (part.type === 'refusal' && typeof part.refusal === 'string') finalRefusals.push(part.refusal)
      }
    } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
      for (const part of item.summary) {
        if (!isRecord(part)) continue
        if (part.type === 'summary_text' && typeof part.text === 'string') reasoning.value += part.text
      }
    } else if (item.type === 'function_call' && typeof item.name === 'string') {
      const id = typeof item.call_id === 'string'
        ? item.call_id
        : typeof item.id === 'string' ? item.id : `responses-tool-${tools.size}`
      const rawInput = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
      tools.set(id, { id, name: item.name, arguments: rawInput })
    }
  }
  state.refusal = finalRefusals.length ? finalRefusals.join('\n\n') : streamedRefusal
  if (!content.value && typeof response.output_text === 'string') content.value = response.output_text
  usage.value = readResponsesUsage(response.usage) ?? usage.value
  if (typeof response.id === 'string') state.responseId = response.id
  if (typeof response.status === 'string') {
    state.responseStatus = response.status
    state.finishReason = response.status
  }
  const incomplete = isRecord(response.incomplete_details) ? response.incomplete_details : undefined
  if (response.status === 'incomplete' || incomplete?.reason === 'max_output_tokens') state.truncated = true
}

const readResponsesDelta = (
  event: SseEvent,
  payload: Record<string, unknown>,
  content: { value: string },
  reasoning: { value: string },
  tools: Map<string, ResponsesToolAccumulator>,
  usage: { value?: ProviderUsage },
  state: ProviderStreamState
): { content: string; reasoning: string } => {
  const eventType = event.event ?? (typeof payload.type === 'string' ? payload.type : '')
  if (eventType === 'response.created' || eventType === 'response.in_progress') {
    const response = isRecord(payload.response) ? payload.response : undefined
    if (response) {
      if (typeof response.id === 'string') state.responseId = response.id
      if (typeof response.status === 'string') state.responseStatus = response.status
    }
  } else if (eventType === 'response.output_text.delta') {
    const delta = typeof payload.delta === 'string' ? payload.delta : ''
    content.value += delta
    return { content: delta, reasoning: '' }
  } else if (eventType === 'response.refusal.delta') {
    const delta = typeof payload.delta === 'string' ? payload.delta : ''
    state.refusal = state.refusal ? `${state.refusal}${delta}` : delta
    return { content: '', reasoning: '' }
  } else if (eventType === 'response.reasoning_summary_text.delta' || eventType === 'response.reasoning_text.delta') {
    const delta = typeof payload.delta === 'string' ? payload.delta : ''
    reasoning.value += delta
    return { content: '', reasoning: delta }
  } else if (eventType === 'response.output_item.added' || eventType === 'response.output_item.done') {
    const item = isRecord(payload.item) ? payload.item : undefined
    if (item?.type === 'function_call' && typeof item.name === 'string') {
      const id = typeof item.call_id === 'string'
        ? item.call_id
        : typeof item.id === 'string' ? item.id : `responses-tool-${tools.size}`
      const rawInput = typeof item.arguments === 'string' ? item.arguments : ''
      const current = tools.get(id) ?? { id, name: item.name, arguments: '' }
      current.name = item.name
      if (rawInput) current.arguments = rawInput
      tools.set(id, current)
    }
  } else if (eventType === 'response.function_call_arguments.delta') {
    const id = typeof payload.call_id === 'string'
      ? payload.call_id
      : typeof payload.item_id === 'string' ? payload.item_id : `responses-tool-${tools.size}`
    const current = tools.get(id) ?? { id, name: '', arguments: '' }
    if (typeof payload.name === 'string') current.name = payload.name
    if (typeof payload.delta === 'string') current.arguments += payload.delta
    tools.set(id, current)
  } else if (eventType === 'response.completed' || eventType === 'response.incomplete') {
    state.terminal = true
    const response = isRecord(payload.response) ? payload.response : undefined
    if (response) {
      state.finalResponse = response
      readResponsesOutput(response, content, reasoning, tools, state, usage)
    }
  } else if (eventType === 'response.failed' || eventType === 'response.error' || eventType === 'error') {
    state.terminal = true
    state.finishReason = 'failed'
    const error = isRecord(payload.error) ? payload.error : payload
    state.error = typeof error.message === 'string' ? error.message : 'The Responses API request failed.'
  }
  return { content: '', reasoning: '' }
}

export const consumeProviderStream = async(
  protocol: AiProtocol,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal | undefined,
  onProgress?: (progress: ProviderStreamProgress) => void,
  compatibility: ProviderReasoningCompatibility = {}
): Promise<ProviderStreamResult> => {
  const content = { value: '' }
  const reasoning = { value: '' }
  const usage: { value?: ProviderUsage } = {}
  const openAiTools = new Map<number, OpenAiToolAccumulator>()
  const anthropicTools = new Map<number, AnthropicToolAccumulator>()
  const responsesTools = new Map<string, ResponsesToolAccumulator>()
  const state: ProviderStreamState = { truncated: false }
  let outputCharacters = 0
  let reasoningCharacters = 0
  let firstEvent = true
  let done = false

  const notify = (): void => {
    const exactOutputTokens = usage.value?.outputTokens
    onProgress?.({
      outputCharacters,
      reasoningCharacters,
      outputTokens: exactOutputTokens ?? estimateTokenCount(`${content.value}${reasoning.value}`),
      usage: usage.value,
      firstEvent
    })
    firstEvent = false
  }

  await parseSseEvents(body, signal, (event) => {
    if (event.data === '[DONE]') {
      done = true
      return
    }
    const payload = parseJson(event.data)
    if (!payload) return
    const beforeContentLength = content.value.length
    const beforeReasoningLength = reasoning.value.length
    const beforeToolLength = protocol === 'anthropic-messages'
      ? [...anthropicTools.values()].reduce((total, tool) => total + tool.input.length, 0)
      : protocol === 'openai-responses'
        ? [...responsesTools.values()].reduce((total, tool) => total + tool.arguments.length, 0)
        : [...openAiTools.values()].reduce((total, tool) => total + tool.arguments.length, 0)
    if (protocol === 'anthropic-messages') {
      readAnthropicDelta(event, payload, content, reasoning, anthropicTools, usage, state)
    } else if (protocol === 'openai-responses') {
      readResponsesDelta(event, payload, content, reasoning, responsesTools, usage, state)
    } else {
      readOpenAiDelta(payload, content, reasoning, openAiTools, usage, state, compatibility)
    }
    const afterToolLength = protocol === 'anthropic-messages'
      ? [...anthropicTools.values()].reduce((total, tool) => total + tool.input.length, 0)
      : protocol === 'openai-responses'
        ? [...responsesTools.values()].reduce((total, tool) => total + tool.arguments.length, 0)
        : [...openAiTools.values()].reduce((total, tool) => total + tool.arguments.length, 0)
    outputCharacters += (content.value.length - beforeContentLength) + (afterToolLength - beforeToolLength)
    reasoningCharacters += reasoning.value.length - beforeReasoningLength
    notify()
  })

  if (protocol === 'openai-responses') {
    if (state.error) throw new Error(state.error)
    if (!state.terminal) throw new Error('The Responses API stream ended without a terminal event.')
  }

  const toolCalls: ProviderToolCall[] = protocol === 'anthropic-messages'
    ? [...anthropicTools.values()]
      .map(tool => {
        const input = parseToolInput(tool.input)
        return {
          ...(tool.id ? { id: tool.id } : {}),
          name: tool.name,
          input,
          ...(tool.id ? { rawInput: tool.input } : {}),
          ...(input === undefined ? { parseError: 'The provider returned invalid JSON tool arguments.' } : {})
        }
      })
      .filter(tool => !!tool.name)
    : protocol === 'openai-responses'
      ? [...responsesTools.values()]
        .map(tool => {
          const input = parseToolInput(tool.arguments)
          return {
            ...(tool.id ? { id: tool.id } : {}),
            name: tool.name,
            input,
            ...(tool.id ? { rawInput: tool.arguments } : {}),
            ...(input === undefined ? { parseError: 'The provider returned invalid JSON tool arguments.' } : {})
          }
        })
        .filter(tool => !!tool.name)
      : [...openAiTools.values()]
        .map(tool => {
          const input = parseToolInput(tool.arguments)
          return {
            ...(tool.id ? { id: tool.id } : {}),
            name: tool.name,
            input,
            ...(tool.id ? { rawInput: tool.arguments } : {}),
            ...(input === undefined ? { parseError: 'The provider returned invalid JSON tool arguments.' } : {})
          }
        })
        .filter(tool => !!tool.name)

  const normalized = normalizeProviderContent(content.value, reasoning.value, compatibility, protocol === 'openai-responses' ? 'native' : 'field')
  if (protocol === 'openai-responses' && state.refusal && !normalized.content && !toolCalls.length) {
    throw new Error(`Provider refusal: ${state.refusal}`)
  }
  if (!done && protocol !== 'openai-responses' && !normalized.content && !toolCalls.length) {
    throw new Error('The provider stream ended without content.')
  }
  return {
    content: normalized.content,
    rawContent: content.value,
    reasoning: normalized.reasoning,
    toolCalls,
    usage: usage.value,
    truncated: state.truncated,
    finishReason: state.finishReason,
    ...(state.responseId ? { responseId: state.responseId } : {})
  }
}
