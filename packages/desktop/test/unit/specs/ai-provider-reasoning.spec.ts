import { describe, expect, it } from 'vitest'
import { normalizeProviderContent } from 'main_renderer/ai/providerReasoning'

describe('provider reasoning normalization', () => {
  it('removes block-level think tags without changing the usable content', () => {
    const result = normalizeProviderContent('<think>Plan the edit first.</think>\n# Result')

    expect(result.content).toBe('\n# Result')
    expect(result.reasoning).toBe('Plan the edit first.')
    expect(result.onlyReasoning).toBe(false)
  })

  it('supports configured tags and multiple reasoning blocks', () => {
    const result = normalizeProviderContent(
      '<thinking>First thought.</thinking>\n\n<thinking>Second thought.</thinking>\nAnswer',
      '',
      { tag: 'thinking' }
    )

    expect(result.content).toContain('Answer')
    expect(result.reasoning).toBe('First thought.\n\nSecond thought.')
  })

  it('does not remove tags inside fenced or inline code', () => {
    const value = '```html\n<think>keep this</think>\n```\n\n`<think>also keep this</think>`'
    const result = normalizeProviderContent(value)

    expect(result.content).toBe(value)
    expect(result.reasoning).toBeUndefined()
  })

  it('keeps native reasoning fields separate from visible content', () => {
    const result = normalizeProviderContent('Visible answer', 'Native reasoning', {}, 'field')

    expect(result.content).toBe('Visible answer')
    expect(result.reasoning).toBe('Native reasoning')
    expect(result.reasoningSource).toBe('field')
  })
})
