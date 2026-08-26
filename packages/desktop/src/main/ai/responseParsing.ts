import type { AiProtocol } from '@shared/types/ai'
import { extractProviderContentParts, normalizeProviderContent, readReasoningField, type ProviderReasoningCompatibility } from './providerReasoning'
import type { ProviderToolCall, ProviderToolDefinition } from './providerMessages'
import type { ProviderUsage } from './providerStream'
import { isRecord } from './utils'

export const extractResponseContent = (
  payload: unknown,
  protocol: AiProtocol,
  compatibility: ProviderReasoningCompatibility
): { content: string; rawContent?: string; reasoning?: string; refusal?: string } => {
  if (!isRecord(payload)) return { content: '' }
  if (protocol === 'openai-responses') {
    const output = Array.isArray(payload.output) ? payload.output : []
    const visible: string[] = []
    const reasoning: string[] = []
    const refusals: string[] = []
    for (const item of output) {
      if (!isRecord(item)) continue
      if (item.type === 'message' && Array.isArray(item.content)) {
        for (const part of item.content) {
          if (!isRecord(part)) continue
          if (part.type === 'output_text' && typeof part.text === 'string') visible.push(part.text)
          else if (part.type === 'refusal' && typeof part.refusal === 'string') refusals.push(part.refusal)
        }
      } else if (item.type === 'reasoning' && Array.isArray(item.summary)) {
        for (const part of item.summary) {
          if (isRecord(part) && part.type === 'summary_text' && typeof part.text === 'string') reasoning.push(part.text)
        }
      }
    }
    if (!visible.length && typeof payload.output_text === 'string') visible.push(payload.output_text)
    return {
      ...normalizeProviderContent(visible.join(''), reasoning.join('\n\n'), compatibility, 'native'),
      ...(refusals.length ? { refusal: refusals.join('\n\n') } : {})
    }
  }
  if (protocol === 'anthropic-messages') {
    const native = extractProviderContentParts(payload, protocol, compatibility)
    if (native.content || native.reasoning) return native
  }
  const choices = payload.choices
  if (Array.isArray(choices)) {
    const message = choices[0]
    if (isRecord(message) && isRecord(message.message)) {
      const content = message.message.content
      const fieldReasoning = readReasoningField(message.message, compatibility.field)
      if (typeof content === 'string') {
        return normalizeProviderContent(content, fieldReasoning, compatibility)
      }
      if (Array.isArray(content)) {
        const visible: string[] = []
        const reasoning: string[] = [fieldReasoning]
        for (const part of content) {
          if (!isRecord(part)) continue
          if (part.type === 'reasoning' || part.type === 'reasoning_text' || part.type === 'thinking') {
            const text = typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : ''
            if (text) reasoning.push(text)
          } else if (typeof part.text === 'string') {
            visible.push(part.text)
          }
        }
        return normalizeProviderContent(visible.join(''), reasoning.filter(Boolean).join('\n\n'), compatibility, 'native')
      }
    }
  }
  const content = payload.content
  if (typeof content === 'string') return normalizeProviderContent(content, readReasoningField(payload, compatibility.field), compatibility)
  if (Array.isArray(content)) {
    const visible: string[] = []
    const reasoning: string[] = [readReasoningField(payload, compatibility.field)]
    for (const part of content) {
      if (!isRecord(part)) continue
      if (part.type === 'reasoning' || part.type === 'reasoning_text' || part.type === 'thinking') {
        const text = typeof part.text === 'string' ? part.text : typeof part.content === 'string' ? part.content : ''
        if (text) reasoning.push(text)
      } else if (typeof part.text === 'string') {
        visible.push(part.text)
      }
    }
    return normalizeProviderContent(visible.join(''), reasoning.filter(Boolean).join('\n\n'), compatibility, 'native')
  }
  return { content: '' }
}

export const isTruncatedResponse = (payload: unknown, protocol: AiProtocol): boolean => {
  if (!isRecord(payload)) return false
  if (protocol === 'openai-responses') {
    const incomplete = isRecord(payload.incomplete_details) ? payload.incomplete_details : undefined
    return payload.status === 'incomplete' || incomplete?.reason === 'max_output_tokens'
  }
  if (protocol === 'anthropic-messages') return payload.stop_reason === 'max_tokens'
  const choices = payload.choices
  if (!Array.isArray(choices) || !isRecord(choices[0])) return false
  return choices[0].finish_reason === 'length'
}

export const extractFinishReason = (payload: unknown, protocol: AiProtocol): string | undefined => {
  if (!isRecord(payload)) return undefined
  if (protocol === 'openai-responses') {
    if (typeof payload.status === 'string') return payload.status
    const incomplete = isRecord(payload.incomplete_details) ? payload.incomplete_details : undefined
    return typeof incomplete?.reason === 'string' ? incomplete.reason : undefined
  }
  if (protocol === 'anthropic-messages') return typeof payload.stop_reason === 'string' ? payload.stop_reason : undefined
  const choices = payload.choices
  if (!Array.isArray(choices) || !isRecord(choices[0])) return undefined
  return typeof choices[0].finish_reason === 'string' ? choices[0].finish_reason : undefined
}

export const extractUsage = (payload: unknown, protocol: AiProtocol): ProviderUsage | undefined => {
  if (!isRecord(payload)) return undefined
  if (protocol === 'openai-responses') {
    const usage = isRecord(payload.usage) ? payload.usage : undefined
    if (!usage) return undefined
    const inputDetails = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : undefined
    const inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
    const outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
    const cachedInputTokens = typeof inputDetails?.cached_tokens === 'number' ? inputDetails.cached_tokens : undefined
    const cacheWriteInputTokens = typeof inputDetails?.cache_write_tokens === 'number' ? inputDetails.cache_write_tokens : undefined
    if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined && cacheWriteInputTokens === undefined) return undefined
    return {
      ...(inputTokens !== undefined ? { inputTokens } : {}),
      ...(outputTokens !== undefined ? { outputTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {})
    }
  }
  const usage = isRecord(payload.usage)
    ? payload.usage
    : protocol === 'anthropic-messages' && isRecord(payload.message) && isRecord(payload.message.usage)
      ? payload.message.usage
      : undefined
  if (!usage) return undefined
  const inputTokens = protocol === 'anthropic-messages'
    ? typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined
    : typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : undefined
  const outputTokens = protocol === 'anthropic-messages'
    ? typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined
    : typeof usage.completion_tokens === 'number' ? usage.completion_tokens : undefined
  const promptDetails = protocol === 'openai-chat-completions' && isRecord(usage.prompt_tokens_details)
    ? usage.prompt_tokens_details
    : undefined
  const cachedInputTokens = protocol === 'anthropic-messages'
    ? typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined
    : typeof promptDetails?.cached_tokens === 'number' ? promptDetails.cached_tokens : undefined
  const cacheWriteInputTokens = protocol === 'anthropic-messages'
    ? typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined
    : undefined
  if (inputTokens === undefined && outputTokens === undefined && cachedInputTokens === undefined && cacheWriteInputTokens === undefined) return undefined
  return {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheWriteInputTokens !== undefined ? { cacheWriteInputTokens } : {})
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

export const extractToolCalls = (payload: unknown, protocol: AiProtocol): ProviderToolCall[] => {
  if (!isRecord(payload)) return []
  if (protocol === 'openai-responses') {
    const output = payload.output
    if (!Array.isArray(output)) return []
    return output
      .filter(isRecord)
      .filter(item => item.type === 'function_call' && typeof item.name === 'string')
      .map(item => {
        const rawInput = typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {})
        const input = parseToolInput(rawInput)
        return {
          id: typeof item.call_id === 'string' ? item.call_id : typeof item.id === 'string' ? item.id : '',
          name: item.name as string,
          input,
          rawInput,
          ...(input === undefined ? { parseError: 'The provider returned invalid JSON tool arguments.' } : {})
        }
      })
  }
  if (protocol === 'anthropic-messages') {
    const content = payload.content
    if (!Array.isArray(content)) return []
    return content
      .filter(isRecord)
      .filter(part => part.type === 'tool_use' && typeof part.name === 'string')
      .map(part => {
        const input = parseToolInput(part.input)
        return {
          id: typeof part.id === 'string' ? part.id : '',
          name: part.name as string,
          input,
          rawInput: typeof part.input === 'string' ? part.input : JSON.stringify(part.input ?? {}),
          ...(input === undefined ? { parseError: 'The provider returned invalid JSON tool arguments.' } : {})
        }
      })
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
        id: typeof call.id === 'string' ? call.id : '',
        name: functionCall && typeof functionCall.name === 'string' ? functionCall.name : '',
        input: parseToolInput(functionCall?.arguments),
        rawInput: typeof functionCall?.arguments === 'string' ? functionCall.arguments : undefined,
        ...(parseToolInput(functionCall?.arguments) === undefined ? { parseError: 'The provider returned invalid JSON tool arguments.' } : {})
      }
    })
    .filter(call => !!call.name)
}

export const parseStrictAgentEnvelope = (content: string, expectedTool: string): ProviderToolCall[] => {
  const normalized = content.trim()
  if (!normalized) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(normalized)
  } catch {
    return []
  }
  if (!isRecord(parsed) || Array.isArray(parsed)) return []
  return [{
    id: `json-agent-${expectedTool}`,
    name: expectedTool,
    input: parsed,
    rawInput: normalized
  }]
}

export const withoutStrictToolSchemas = (tools: ProviderToolDefinition[]): ProviderToolDefinition[] => tools.map(({ strict: _strict, ...tool }) => tool)
