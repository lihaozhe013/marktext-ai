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

  it('separates OpenAI reasoning fields from content', async() => {
    const result = await consumeProviderStream(
      'openai-chat-completions',
      streamFrom([
        'data: {"choices":[{"delta":{"reasoning_content":"Plan first.","content":"Done"}}]}\n\n',
        'data: [DONE]\n\n'
      ]),
      undefined,
      undefined,
      { field: 'reasoning_content' }
    )

    expect(result.content).toBe('Done')
    expect(result.reasoning).toBe('Plan first.')
  })

  it('filters think tags split across streamed content chunks', async() => {
    const result = await consumeProviderStream(
      'openai-chat-completions',
      streamFrom([
        'data: {"choices":[{"delta":{"content":"<thi"}}]}\n\n',
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'nk>Plan</think>\n# Done' } }] })}\n\n`,
        'data: [DONE]\n\n'
      ]),
      undefined
    )

    expect(result.content).toBe('\n# Done')
    expect(result.reasoning).toBe('Plan')
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

  it('separates Anthropic thinking blocks from text', async() => {
    const result = await consumeProviderStream(
      'anthropic-messages',
      streamFrom([
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Plan"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"Done"}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n'
      ]),
      undefined
    )

    expect(result.content).toBe('Done')
    expect(result.reasoning).toBe('Plan')
  })

  it('assembles a typed Responses stream, summary, response id, and usage', async() => {
    const result = await consumeProviderStream(
      'openai-responses',
      streamFrom([
        'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_1","status":"in_progress"}}\n\n',
        'event: response.reasoning_summary_text.delta\ndata: {"type":"response.reasoning_summary_text.delta","delta":"Plan first."}\n\n',
        'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Done"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_1","status":"completed","output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Plan first."}]},{"type":"message","content":[{"type":"output_text","text":"Done"}]}],"usage":{"input_tokens":12,"output_tokens":3}}}\n\n'
      ]),
      undefined
    )

    expect(result.content).toBe('Done')
    expect(result.reasoning).toBe('Plan first.')
    expect(result.responseId).toBe('resp_1')
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 3 })
  })

  it('assembles Responses function-call argument deltas and rejects incomplete streams', async() => {
    const result = await consumeProviderStream(
      'openai-responses',
      streamFrom([
        'event: response.output_item.added\ndata: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"apply_markdown_edit"}}\n\n',
        'event: response.function_call_arguments.delta\ndata: {"type":"response.function_call_arguments.delta","item_id":"call_1","delta":"{\\"search\\":\\"old\\"}"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_2","status":"completed","output":[{"type":"function_call","call_id":"call_1","name":"apply_markdown_edit","arguments":"{\\"search\\":\\"old\\"}"}]}}\n\n'
      ]),
      undefined
    )
    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'apply_markdown_edit', input: { search: 'old' }, rawInput: '{"search":"old"}' }])

    await expect(consumeProviderStream(
      'openai-responses',
      streamFrom(['event: response.output_text.delta\ndata: {"delta":"partial"}\n\n']),
      undefined
    )).rejects.toThrow('terminal event')
  })

  it('reports a Responses refusal separately from answer content', async() => {
    await expect(consumeProviderStream(
      'openai-responses',
      streamFrom([
        'event: response.refusal.delta\ndata: {"type":"response.refusal.delta","delta":"Not "}\n\n',
        'event: response.refusal.delta\ndata: {"type":"response.refusal.delta","delta":"allowed"}\n\n',
        'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_3","status":"completed","output":[{"type":"message","content":[{"type":"refusal","refusal":"Not allowed"}]}]}}\n\n'
      ]),
      undefined
    )).rejects.toThrow('Provider refusal: Not allowed')
  })

  it('marks max_output_tokens Responses completions as truncated', async() => {
    const result = await consumeProviderStream(
      'openai-responses',
      streamFrom([
        'event: response.incomplete\ndata: {"type":"response.incomplete","response":{"id":"resp_4","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"output":[{"type":"message","content":[{"type":"output_text","text":"Partial"}]}]}}\n\n'
      ]),
      undefined
    )
    expect(result.content).toBe('Partial')
    expect(result.truncated).toBe(true)
    expect(result.finishReason).toBe('incomplete')
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
