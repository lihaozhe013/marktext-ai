import type {
  AiProtocol,
  AiReasoningField,
  AiReasoningTag
} from '@shared/types/ai'

export interface ProviderReasoningCompatibility {
  field?: AiReasoningField
  tag?: AiReasoningTag
  replay?: boolean
}

export interface ReasoningExtraction {
  content: string
  rawContent?: string
  reasoning?: string
  reasoningSource?: 'field' | 'tag' | 'native'
  onlyReasoning: boolean
}

const REASONING_FIELDS: readonly AiReasoningField[] = [
  'reasoning_content',
  'reasoning',
  'reason_content',
  'reasoning_text'
]

const REASONING_TAGS: readonly AiReasoningTag[] = [
  'think',
  'thinking',
  'analysis',
  'reasoning'
]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const textFromValue = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textFromValue).join('')
  if (!isRecord(value)) return ''
  for (const key of ['text', 'content', 'reasoning_content', 'reason_content', 'reasoning_text']) {
    const text = textFromValue(value[key])
    if (text) return text
  }
  return ''
}

export const readReasoningField = (
  value: unknown,
  preferredField?: AiReasoningField
): string => {
  if (!isRecord(value)) return ''
  const fields = preferredField
    ? [preferredField, ...REASONING_FIELDS.filter(field => field !== preferredField)]
    : REASONING_FIELDS
  for (const field of fields) {
    const text = textFromValue(value[field])
    if (text) return text
  }
  return ''
}

interface Range {
  start: number
  end: number
}

const lineRanges = (value: string): Array<{ start: number; end: number; text: string }> => {
  const result: Array<{ start: number; end: number; text: string }> = []
  let start = 0
  while (start <= value.length) {
    const newline = value.indexOf('\n', start)
    const end = newline < 0 ? value.length : newline
    result.push({ start, end, text: value.slice(start, end) })
    if (newline < 0) break
    start = newline + 1
  }
  return result
}

const fenceAtLine = (line: string): { character: '`' | '~'; length: number } | undefined => {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/)
  if (!match) return undefined
  return { character: match[1][0] as '`' | '~', length: match[1].length }
}

const protectedCodeRanges = (value: string): Range[] => {
  const ranges: Range[] = []
  const lines = lineRanges(value)
  let fence: { character: '`' | '~'; length: number; start: number } | undefined
  for (const line of lines) {
    const marker = fenceAtLine(line.text)
    if (fence) {
      if (marker && marker.character === fence.character && marker.length >= fence.length) {
        ranges.push({ start: fence.start, end: line.end + (line.end < value.length ? 1 : 0) })
        fence = undefined
      }
      continue
    }
    if (marker) fence = { ...marker, start: line.start }
  }
  if (fence) ranges.push({ start: fence.start, end: value.length })

  const isProtected = (index: number): boolean => ranges.some(range => index >= range.start && index < range.end)
  let index = 0
  while (index < value.length) {
    if (isProtected(index) || value[index] !== '`') {
      index += 1
      continue
    }
    let length = 1
    while (value[index + length] === '`') length += 1
    const closing = value.indexOf('`'.repeat(length), index + length)
    if (closing < 0) {
      index += length
      continue
    }
    ranges.push({ start: index, end: closing + length })
    index = closing + length
  }
  return ranges.sort((left, right) => left.start - right.start)
}

const overlapsProtectedRange = (ranges: readonly Range[], start: number, end: number): boolean =>
  ranges.some(range => start < range.end && end > range.start)

const extractTaggedReasoning = (
  value: string,
  preferredTag?: AiReasoningTag
): { content: string; reasoning?: string; extracted: boolean } => {
  const tags = preferredTag
    ? [preferredTag, ...REASONING_TAGS.filter(tag => tag !== preferredTag)]
    : REASONING_TAGS
  const ranges = protectedCodeRanges(value)
  const removals: Range[] = []
  const reasoning: string[] = []
  for (const tag of tags) {
    const opening = new RegExp(`<${tag}\\b[^>]*>`, 'gi')
    const closing = new RegExp(`</${tag}\\s*>`, 'gi')
    let match: RegExpExecArray | null
    while ((match = opening.exec(value))) {
      const start = match.index
      if (overlapsProtectedRange(ranges, start, start + match[0].length)) continue
      const before = start === 0 ? '' : value[start - 1]
      if (before && !/\s/.test(before)) continue
      closing.lastIndex = opening.lastIndex
      const endMatch = closing.exec(value)
      if (!endMatch) continue
      const end = endMatch.index + endMatch[0].length
      const after = value[end]
      if (after && !/\s/.test(after)) continue
      if (overlapsProtectedRange(ranges, start, end)) continue
      reasoning.push(value.slice(opening.lastIndex, endMatch.index).trim())
      removals.push({ start, end })
      opening.lastIndex = end
    }
  }
  if (!removals.length) return { content: value, extracted: false }
  const merged = removals
    .sort((left, right) => left.start - right.start)
    .reduce<Range[]>((result, range) => {
      const previous = result[result.length - 1]
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end)
      else result.push({ ...range })
      return result
    }, [])
  let content = value
  for (const range of [...merged].reverse()) content = `${content.slice(0, range.start)}${content.slice(range.end)}`
  const reasoningText = reasoning.filter(Boolean).join('\n\n')
  return {
    content,
    reasoning: reasoningText || undefined,
    extracted: true
  }
}

export const normalizeProviderContent = (
  content: string,
  fieldReasoning = '',
  compatibility: ProviderReasoningCompatibility = {},
  source: 'field' | 'native' = 'field'
): ReasoningExtraction => {
  const tagged = extractTaggedReasoning(content, compatibility.tag)
  const reasoningParts = [fieldReasoning.trim(), tagged.reasoning?.trim()].filter(Boolean)
  const reasoning = reasoningParts.join('\n\n') || undefined
  return {
    content: tagged.content,
    rawContent: content,
    reasoning,
    reasoningSource: fieldReasoning ? source : tagged.extracted ? 'tag' : undefined,
    onlyReasoning: !tagged.content.trim() && !!reasoning
  }
}

export const extractAnthropicThinkingDelta = (delta: unknown): string => {
  if (!isRecord(delta)) return ''
  if (delta.type === 'thinking_delta') return typeof delta.thinking === 'string' ? delta.thinking : ''
  return ''
}

export const extractProviderContentParts = (
  value: unknown,
  protocol: AiProtocol,
  compatibility: ProviderReasoningCompatibility = {}
): ReasoningExtraction => {
  if (!isRecord(value)) return { content: '', onlyReasoning: false }
  if (protocol === 'anthropic-messages' && Array.isArray(value.content)) {
    const content: string[] = []
    const reasoning: string[] = []
    for (const part of value.content) {
      if (!isRecord(part)) continue
      if (part.type === 'thinking' || part.type === 'redacted_thinking') {
        const text = textFromValue(part.thinking ?? part.data)
        if (text) reasoning.push(text)
      } else {
        const text = textFromValue(part.text)
        if (text) content.push(text)
      }
    }
    return normalizeProviderContent(content.join(''), reasoning.join(''), compatibility, 'native')
  }
  return { content: '', onlyReasoning: false }
}
