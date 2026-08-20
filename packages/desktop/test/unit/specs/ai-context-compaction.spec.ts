import { describe, expect, it } from 'vitest'
import {
  buildContextMemoryMessage,
  buildContextSummaryPrompt,
  buildLocalContextSummary,
  normalizeContextSummary,
  MAX_CONTEXT_SUMMARY_CHARS
} from 'main_renderer/ai/contextCompaction'

describe('AI context compaction', () => {
  it('normalizes and bounds persisted summaries', () => {
    const summary = normalizeContextSummary(`  ${'x'.repeat(MAX_CONTEXT_SUMMARY_CHARS + 100)}  `)
    expect(summary?.length).toBeLessThanOrEqual(MAX_CONTEXT_SUMMARY_CHARS)
    expect(summary).toContain('[truncated]')
  })

  it('builds a data-only rolling summary prompt', () => {
    const prompt = buildContextSummaryPrompt('Keep the API decision.', 'Update the example.', 'edit', 'Updated the example.')
    expect(prompt.system).toContain('current document supplied in later requests is authoritative')
    expect(prompt.content).toContain('Keep the API decision.')
    expect(prompt.content).toContain('Updated the example.')
    expect(prompt.content).not.toContain('DOCUMENT')
  })

  it('wraps memory with a per-request boundary', () => {
    const memory = buildContextMemoryMessage('Use concise Chinese labels.')
    expect(memory).toContain('CONVERSATION_MEMORY MT_MEMORY_')
    expect(memory).toContain('Use concise Chinese labels.')
    expect(memory).toMatch(/END_CONVERSATION_MEMORY MT_MEMORY_[a-f0-9]+$/)
  })

  it('provides a bounded local fallback without document content', () => {
    const fallback = buildLocalContextSummary('Earlier decision.', 'Add a section.', 'rewrite', 'Rewrite validated.')
    expect(fallback).toContain('Earlier decision.')
    expect(fallback).toContain('Rewrite validated.')
    expect(fallback).toContain('current Markdown document is authoritative')
    expect(fallback.length).toBeLessThanOrEqual(MAX_CONTEXT_SUMMARY_CHARS)
  })
})
