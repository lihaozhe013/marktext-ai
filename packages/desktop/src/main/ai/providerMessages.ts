import type { AiProtocol, AiReasoningField } from '@shared/types/ai'

export interface ProviderImage {
  mimeType: string
  data: string
}

export interface ProviderMessage {
  role: 'user' | 'assistant'
  content: string
  reasoning?: string
  images?: ProviderImage[]
  attachmentContext?: string
}

export interface ProviderToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ProviderToolCall {
  name: string
  input: unknown
}

export const preciseEditTool: ProviderToolDefinition = {
  name: 'submit_markdown_edits',
  description: 'Submit validated Markdown edit operations. SEARCH strings must be copied exactly from the current document.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['changed', 'no_changes'] },
      summary: { type: 'string' },
      edits: {
        type: 'array',
        maxItems: 32,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            search: { type: 'string' },
            replace: { type: 'string' }
          },
          required: ['search', 'replace']
        }
      }
    },
    required: ['status', 'summary', 'edits']
  }
}

const toImageDataUrl = (image: ProviderImage): string => `data:${image.mimeType};base64,${image.data}`

export const serializeProviderMessages = (
  protocol: AiProtocol,
  messages: ProviderMessage[],
  reasoningField?: AiReasoningField,
  replayReasoning = false
): Array<Record<string, unknown>> => messages.map(message => {
  const images = message.images ?? []
  const content = message.attachmentContext
    ? `${message.attachmentContext}\n\n${message.content}`
    : message.content
  const shouldReplayReasoning = replayReasoning && message.role === 'assistant' && !!message.reasoning
  const reasoning = reasoningField && shouldReplayReasoning
    ? { [reasoningField]: message.reasoning }
    : {}
  if (!images.length && protocol === 'anthropic-messages' && shouldReplayReasoning) {
    return {
      role: message.role,
      content: [
        { type: 'thinking', thinking: message.reasoning },
        ...(content ? [{ type: 'text', text: content }] : [])
      ]
    }
  }
  if (!images.length) return { role: message.role, content, ...reasoning }
  if (protocol === 'anthropic-messages') {
    const anthropicContent = [
      ...(shouldReplayReasoning ? [{ type: 'thinking', thinking: message.reasoning }] : []),
      ...images.map(image => ({
        type: 'image',
        source: {
          type: 'base64',
          media_type: image.mimeType,
          data: image.data
        }
      })),
      { type: 'text', text: content }
    ]
    return {
      role: message.role,
      content: anthropicContent
    }
  }
  return {
    role: message.role,
    content: [
      ...images.map(image => ({
        type: 'image_url',
        image_url: { url: toImageDataUrl(image), detail: 'auto' }
      })),
      { type: 'text', text: content }
    ],
    ...reasoning
  }
})
