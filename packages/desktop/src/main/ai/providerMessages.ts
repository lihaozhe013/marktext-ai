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
  toolCalls?: ProviderToolCall[]
  toolResults?: ProviderToolResult[]
}

export interface ProviderToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  strict?: boolean
}

export interface ProviderToolCall {
  id?: string
  name: string
  input?: unknown
  rawInput?: string
  parseError?: string
}

export interface ProviderToolResult {
  toolCallId: string
  content: string
  isError?: boolean
}

export type AgentPlanOperation = 'append' | 'prepend' | 'replace'

export const applyMarkdownEditTool: ProviderToolDefinition = {
  name: 'apply_markdown_edit',
  description: 'Apply exactly one planned, precise Markdown replacement inside the current plan step. SEARCH must be copied exactly and uniquely from the current virtual document.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      search: { type: 'string' },
      replace: { type: 'string' },
      description: { type: 'string', maxLength: 160 }
    },
    required: ['search', 'replace', 'description']
  }
}

export const appendMarkdownTool: ProviderToolDefinition = {
  name: 'append_markdown',
  description: 'Append one complete, coherent Markdown block to the end of the current document. Return only the new block, not the existing document.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      markdown: { type: 'string', minLength: 1, maxLength: 16000 },
      description: { type: 'string', maxLength: 160 }
    },
    required: ['markdown', 'description']
  }
}

export const prependMarkdownTool: ProviderToolDefinition = {
  name: 'prepend_markdown',
  description: 'Prepend one complete, coherent Markdown block to the beginning of the current document. Return only the new block, not the existing document.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      markdown: { type: 'string', minLength: 1, maxLength: 16000 },
      description: { type: 'string', maxLength: 160 }
    },
    required: ['markdown', 'description']
  }
}

export const createMarkdownEditPlanTool: ProviderToolDefinition = {
  name: 'create_markdown_edit_plan',
  description: 'Create an ordered plan of independently verifiable Markdown edit steps before applying any edit.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', minLength: 1, maxLength: 240 },
      steps: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 80 },
            description: { type: 'string', minLength: 1, maxLength: 160 },
            intent: { type: 'string', minLength: 1, maxLength: 400 },
            operation: { type: 'string', enum: ['append', 'prepend', 'replace'] },
            startAnchor: { type: ['string', 'null'], maxLength: 1000 },
            endAnchor: { type: ['string', 'null'], maxLength: 1000 },
            dependsOn: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 80 } }
          },
          required: ['id', 'description', 'intent', 'operation', 'startAnchor', 'endAnchor', 'dependsOn']
        }
      }
    },
    required: ['summary', 'steps']
  }
}

export const reviseMarkdownEditPlanTool: ProviderToolDefinition = {
  name: 'revise_markdown_edit_plan',
  description: 'Revise only unfinished Markdown edit steps after the current target or plan becomes invalid; completed steps are immutable.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      reason: { type: 'string', minLength: 1, maxLength: 240 },
      remainingSteps: {
        type: 'array',
        maxItems: 16,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', minLength: 1, maxLength: 80 },
            description: { type: 'string', minLength: 1, maxLength: 160 },
            intent: { type: 'string', minLength: 1, maxLength: 400 },
            operation: { type: 'string', enum: ['append', 'prepend', 'replace'] },
            startAnchor: { type: ['string', 'null'], maxLength: 1000 },
            endAnchor: { type: ['string', 'null'], maxLength: 1000 },
            dependsOn: { type: 'array', maxItems: 32, items: { type: 'string', minLength: 1, maxLength: 80 } }
          },
          required: ['id', 'description', 'intent', 'operation', 'startAnchor', 'endAnchor', 'dependsOn']
        }
      }
    },
    required: ['reason', 'remainingSteps']
  }
}

export const finishMarkdownEditTool: ProviderToolDefinition = {
  name: 'finish_markdown_edit',
  description: 'Finish the Markdown editing task after all requested changes have been applied to the virtual document.',
  strict: true,
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', maxLength: 240 }
    },
    required: ['summary']
  }
}

export const preciseEditTools: ProviderToolDefinition[] = [createMarkdownEditPlanTool, applyMarkdownEditTool, appendMarkdownTool, prependMarkdownTool, reviseMarkdownEditPlanTool, finishMarkdownEditTool]

/** @deprecated Kept for persisted/test callers; the agent uses preciseEditTools. */
export const preciseEditTool: ProviderToolDefinition = {
  name: 'submit_markdown_edits',
  description: 'Submit validated Markdown edit operations.',
  parameters: {
    type: 'object',
    additionalProperties: false,
    properties: {
      status: { type: 'string', enum: ['changed', 'no_changes'] },
      summary: { type: 'string' },
      edits: { type: 'array', maxItems: 32, items: { type: 'object', properties: { search: { type: 'string' }, replace: { type: 'string' } }, required: ['search', 'replace'] } }
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
): Array<Record<string, unknown>> => messages.flatMap((message): Array<Record<string, unknown>> => {
  const images = message.images ?? []
  const content = message.attachmentContext
    ? `${message.attachmentContext}\n\n${message.content}`
    : message.content
  const shouldReplayReasoning = replayReasoning && message.role === 'assistant' && !!message.reasoning
  const reasoning = reasoningField && shouldReplayReasoning
    ? { [reasoningField]: message.reasoning }
    : {}
  const toolCalls = message.toolCalls ?? []
  const toolResults = message.toolResults ?? []
  if (protocol === 'openai-chat-completions' && message.role === 'assistant' && toolCalls.length) {
    return [{
      role: 'assistant',
      content: content || null,
      tool_calls: toolCalls.map(call => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: call.rawInput ?? JSON.stringify(call.input ?? {})
        }
      })),
      ...reasoning
    }]
  }
  if (protocol === 'openai-chat-completions' && toolResults.length) {
    return toolResults.map(result => ({
      role: 'tool',
      tool_call_id: result.toolCallId,
      content: result.content
    }))
  }
  if (!images.length && protocol === 'anthropic-messages' && shouldReplayReasoning) {
    return [{
      role: message.role,
      content: [
        { type: 'thinking', thinking: message.reasoning },
        ...(content ? [{ type: 'text', text: content }] : []),
        ...toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} }))
      ]
    }]
  }
  if (protocol === 'anthropic-messages' && message.role === 'assistant' && toolCalls.length) {
    return [{
      role: 'assistant',
      content: [
        ...(content ? [{ type: 'text', text: content }] : []),
        ...toolCalls.map(call => ({ type: 'tool_use', id: call.id, name: call.name, input: call.input ?? {} }))
      ]
    }]
  }
  if (protocol === 'anthropic-messages' && toolResults.length) {
    return [{
      role: 'user',
      content: [
        ...toolResults.map(result => ({
          type: 'tool_result',
          tool_use_id: result.toolCallId,
          content: result.content,
          ...(result.isError ? { is_error: true } : {})
        })),
        ...(content ? [{ type: 'text', text: content }] : [])
      ]
    }]
  }
  if (!images.length) return [{ role: message.role, content, ...reasoning }]
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
    return [{
      role: message.role,
      content: anthropicContent
    }]
  }
  return [{
    role: message.role,
    content: [
      ...images.map(image => ({
        type: 'image_url',
        image_url: { url: toImageDataUrl(image), detail: 'auto' }
      })),
      { type: 'text', text: content }
    ],
    ...reasoning
  }]
})

const toResponsesImage = (image: ProviderImage): Record<string, unknown> => ({
  type: 'input_image',
  image_url: toImageDataUrl(image),
  detail: 'auto'
})

/**
 * Responses treats messages, function calls, and function outputs as
 * separate input items. Keep this serializer independent from the legacy
 * message serializers so the legacy wire shapes remain unchanged.
 */
export const serializeResponsesInput = (messages: ProviderMessage[]): Array<Record<string, unknown>> => messages.flatMap(message => {
  const content = message.attachmentContext
    ? `${message.attachmentContext}\n\n${message.content}`
    : message.content
  const images = message.images ?? []
  const items: Array<Record<string, unknown>> = []

  if (message.role === 'assistant' && message.toolCalls?.length) {
    for (const call of message.toolCalls) {
      items.push({
        type: 'function_call',
        call_id: call.id,
        name: call.name,
        arguments: call.rawInput ?? JSON.stringify(call.input ?? {})
      })
    }
  }

  if (message.toolResults?.length) {
    for (const result of message.toolResults) {
      items.push({
        type: 'function_call_output',
        call_id: result.toolCallId,
        output: result.content
      })
    }
  }

  if (content || images.length) {
    if (!images.length) {
      items.push({ role: message.role, content })
    } else {
      items.push({
        role: message.role,
        content: [
          ...images.map(toResponsesImage),
          ...(content ? [{ type: 'input_text', text: content }] : [])
        ]
      })
    }
  }

  return items
})
