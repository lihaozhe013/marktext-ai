import { describe, expect, it } from 'vitest'
import { consumeProviderStream } from 'main_renderer/ai/providerStream'

const streamFrom = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    }
  })
}

describe('provider response streams', () => {
  it('assembles OpenAI text and usage across chunk boundaries', async() => {
    const source = [
      'data: {"choices":[{"delta":{"content":"Hello "}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"world"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n',
      'data: [DONE]\n\n'
    ].join('')
    const progress: number[] = []
    const result = await consumeProviderStream(
      'openai-chat-completions',
      streamFrom([source.slice(0, 31), source.slice(31)]),
      undefined,
      value => progress.push(value.outputCharacters)
    )

    expect(result.content).toBe('Hello world')
    expect(result.toolCalls).toEqual([])
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 })
    expect(progress).toContain(11)
  })

  it('assembles OpenAI tool-call argument deltas', async() => {
    const result = await consumeProviderStream(
      'openai-chat-completions',
      streamFrom([
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"name":"submit_markdown_edits","arguments":"{\\"status\\":\\"changed\\", "}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"summary\\":\\"Done\\",\\"edits\\":[]}"}}]}}]}\n\n',
        'data: [DONE]\n\n'
      ]),
      undefined
    )

    expect(result.toolCalls).toEqual([{
      name: 'submit_markdown_edits',
      input: { status: 'changed', summary: 'Done', edits: [] }
    }])
  })

  it('assembles Anthropic text, tool input, and usage events', async() => {
    const result = await consumeProviderStream(
      'anthropic-messages',
      streamFrom([
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":20}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ready"}}\n\n',
        'event: content_block_start\ndata: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","name":"submit_markdown_edits"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"status\\":\\"no_changes\\",\\"summary\\":\\"No change\\",\\"edits\\":[]}"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":7}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ]),
      undefined
    )

    expect(result.content).toBe('Ready')
    expect(result.toolCalls).toEqual([{
      name: 'submit_markdown_edits',
      input: { status: 'no_changes', summary: 'No change', edits: [] }
    }])
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 7 })
  })

  it('stops promptly when the signal is aborted', async() => {
    const controller = new AbortController()
    const body = new ReadableStream<Uint8Array>({
      async pull(streamController) {
        await new Promise(resolve => setTimeout(resolve, 5))
        streamController.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"x"}}]}\n\n'))
        controller.abort()
      }
    })

    await expect(consumeProviderStream('openai-chat-completions', body, controller.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
