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
}

interface SseEvent {
  event?: string
  data: string
}

interface OpenAiToolAccumulator {
  name: string
  arguments: string
}

interface AnthropicToolAccumulator {
  name: string
  input: string
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
  state: { truncated: boolean },
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
      const current = tools.get(index) ?? { name: '', arguments: '' }
      const functionValue = isRecord(item.function) ? item.function : undefined
      if (typeof functionValue?.name === 'string') current.name += functionValue.name
      if (typeof functionValue?.arguments === 'string') current.arguments += functionValue.arguments
      tools.set(index, current)
    }
  }
  const finishReason = choice?.finish_reason
  if (finishReason === 'length' || finishReason === 'max_tokens') state.truncated = true
  const payloadUsage = isRecord(payload.usage) ? payload.usage : undefined
  const inputTokens = asNumber(payloadUsage?.prompt_tokens)
  const outputTokens = asNumber(payloadUsage?.completion_tokens)
  if (inputTokens !== undefined || outputTokens !== undefined) {
    usage.value = { inputTokens, outputTokens }
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
  state: { truncated: boolean }
): { content: string; reasoning: string } => {
  const eventType = event.event ?? (typeof payload.type === 'string' ? payload.type : '')
  if (eventType === 'message_start') {
    const message = isRecord(payload.message) ? payload.message : undefined
    const messageUsage = message && isRecord(message.usage) ? message.usage : undefined
    const inputTokens = asNumber(messageUsage?.input_tokens)
    if (inputTokens !== undefined) usage.value = { ...usage.value, inputTokens }
  } else if (eventType === 'content_block_start') {
    const index = asNumber(payload.index) ?? tools.size
    const block = isRecord(payload.content_block) ? payload.content_block : undefined
    if (block?.type === 'tool_use') {
      tools.set(index, {
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
      const tool = tools.get(index) ?? { name: '', input: '' }
      tool.input += delta.partial_json
      tools.set(index, tool)
    }
  } else if (eventType === 'message_delta') {
    const delta = isRecord(payload.delta) ? payload.delta : undefined
    if (delta?.stop_reason === 'max_tokens') state.truncated = true
    const deltaUsage = isRecord(payload.usage) ? payload.usage : undefined
    const outputTokens = asNumber(deltaUsage?.output_tokens)
    if (outputTokens !== undefined) usage.value = { ...usage.value, outputTokens }
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
  const state = { truncated: false }
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
      : [...openAiTools.values()].reduce((total, tool) => total + tool.arguments.length, 0)
    if (protocol === 'anthropic-messages') {
      readAnthropicDelta(event, payload, content, reasoning, anthropicTools, usage, state)
    } else {
      readOpenAiDelta(payload, content, reasoning, openAiTools, usage, state, compatibility)
    }
    const afterToolLength = protocol === 'anthropic-messages'
      ? [...anthropicTools.values()].reduce((total, tool) => total + tool.input.length, 0)
      : [...openAiTools.values()].reduce((total, tool) => total + tool.arguments.length, 0)
    outputCharacters += (content.value.length - beforeContentLength) + (afterToolLength - beforeToolLength)
    reasoningCharacters += reasoning.value.length - beforeReasoningLength
    notify()
  })

  const toolCalls: ProviderToolCall[] = protocol === 'anthropic-messages'
    ? [...anthropicTools.values()]
      .map(tool => ({ name: tool.name, input: parseToolInput(tool.input) }))
      .filter(tool => !!tool.name && tool.input !== undefined)
    : [...openAiTools.values()]
      .map(tool => ({ name: tool.name, input: parseToolInput(tool.arguments) }))
      .filter(tool => !!tool.name && tool.input !== undefined)

  const normalized = normalizeProviderContent(content.value, reasoning.value, compatibility, 'field')
  if (!done && !normalized.content && !toolCalls.length) {
    throw new Error('The provider stream ended without content.')
  }
  return {
    content: normalized.content,
    rawContent: content.value,
    reasoning: normalized.reasoning,
    toolCalls,
    usage: usage.value,
    truncated: state.truncated
  }
}
