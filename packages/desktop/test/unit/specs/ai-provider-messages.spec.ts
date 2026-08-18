import { describe, expect, it } from 'vitest'
import { preciseEditTool, serializeProviderMessages } from 'main_renderer/ai/providerMessages'

describe('AI provider image message serialization', () => {
  const messages = [
    {
      role: 'user' as const,
      content: 'Read this screenshot.',
      images: [{ mimeType: 'image/png', data: 'aGVsbG8=' }]
    }
  ]

  it('defines a provider-neutral precise edit tool schema', () => {
    expect(preciseEditTool.name).toBe('submit_markdown_edits')
    expect(preciseEditTool.parameters).toMatchObject({
      type: 'object',
      required: ['status', 'summary', 'edits']
    })
  })

  it('keeps the existing plain-text wire shape', () => {
    expect(serializeProviderMessages('openai-chat-completions', [{ role: 'user', content: 'Hello' }])).toEqual([
      { role: 'user', content: 'Hello' }
    ])
    expect(serializeProviderMessages('anthropic-messages', [{ role: 'assistant', content: 'Hi' }])).toEqual([
      { role: 'assistant', content: 'Hi' }
    ])
  })

  it('serializes OpenAI-compatible images before text', () => {
    expect(serializeProviderMessages('openai-chat-completions', messages)).toEqual([
      {
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=', detail: 'auto' } },
          { type: 'text', text: 'Read this screenshot.' }
        ]
      }
    ])
  })

  it('serializes Anthropic base64 images before text', () => {
    expect(serializeProviderMessages('anthropic-messages', messages)).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' }
          },
          { type: 'text', text: 'Read this screenshot.' }
        ]
      }
    ])
  })

  it('serializes rendered PDF pages as images for both providers', () => {
    const result = serializeProviderMessages('openai-chat-completions', [{
      role: 'user',
      content: 'Read these PDF pages.',
      images: [
        { mimeType: 'image/png', data: 'cGFnZS0x' },
        { mimeType: 'image/png', data: 'cGFnZS0y' }
      ]
    }])
    expect(result[0]).toMatchObject({
      content: [
        { type: 'image_url' },
        { type: 'image_url' },
        { type: 'text', text: 'Read these PDF pages.' }
      ]
    })
    expect(JSON.stringify(result)).not.toMatch(/file_data|input_file|application\/pdf/)
    expect(serializeProviderMessages('anthropic-messages', [{
      role: 'user',
      content: 'Read these PDF pages.',
      images: [{ mimeType: 'image/png', data: 'cGFnZS0x' }]
    }])).toMatchObject([{
      content: [{ type: 'image' }, { type: 'text', text: 'Read these PDF pages.' }]
    }])
  })

  it('places rendered PDF context before the user text', () => {
    const result = serializeProviderMessages('openai-chat-completions', [{
      role: 'user',
      content: 'Summarize the document.',
      attachmentContext: 'These images are rendered pages from report.pdf. Selected pages, in order: 1, 3.'
    }])
    expect(result).toEqual([{
      role: 'user',
      content: 'These images are rendered pages from report.pdf. Selected pages, in order: 1, 3.\n\nSummarize the document.'
    }])
  })

  it('replays configured reasoning separately for compatible providers', () => {
    expect(serializeProviderMessages('openai-chat-completions', [{
      role: 'assistant',
      content: 'Done',
      reasoning: 'Plan'
    }], 'reasoning_content', true)).toEqual([{
      role: 'assistant',
      content: 'Done',
      reasoning_content: 'Plan'
    }])

    expect(serializeProviderMessages('anthropic-messages', [{
      role: 'assistant',
      content: 'Done',
      reasoning: 'Plan'
    }], undefined, true)).toEqual([{
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Plan' },
        { type: 'text', text: 'Done' }
      ]
    }])
  })
})
