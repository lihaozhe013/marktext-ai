import { describe, expect, it, vi } from 'vitest'
import {
  documentEditAgentLimits,
  runDocumentEditAgent,
  type DocumentEditAgentRequest,
  type DocumentEditGenerateRequest,
  type DocumentEditValidationDiagnostic,
  type DocumentAgentGenerateRequest
} from 'main_renderer/ai/documentEditAgent'
import type { AiImageAttachment } from '@shared/types/ai'

const request = (
  markdown: string,
  generate: (input: DocumentEditGenerateRequest) => Promise<{ content: string; truncated?: boolean }>,
  options: Pick<DocumentEditAgentRequest, 'onValidationFailure' | 'maxRetries'> = {}
) =>
  runDocumentEditAgent({
    markdown,
    instruction: 'Make the requested change.',
    contextMessages: [],
    requestId: 'test-request',
    signal: new AbortController().signal,
    generate,
    ...options
  })

const responseWith = (system: string, search: string, replace: string): string => {
  const delimiter = system.match(/MT_EDIT_[a-f0-9]+/)?.[0]
  if (!delimiter) throw new Error('The test prompt did not contain an edit delimiter.')
  return [
    `<<<<<<< SEARCH ${delimiter}`,
    search,
    `======= ${delimiter}`,
    replace,
    `>>>>>>> REPLACE ${delimiter}`
  ].join('\n')
}

describe('document edit agent', () => {
  it('executes dependent edits against the evolving virtual document', async() => {
    const steps: Array<Record<string, unknown>> = [
      { version: 0, search: 'alpha', replace: 'beta', description: 'Updated the first word.' },
      { version: 1, search: 'beta', replace: 'gamma', description: 'Refined the updated word.' },
      { version: 2, summary: 'Updated the requested text.' }
    ]
    let turn = 0
    const generateAgent = vi.fn(async(_input: DocumentAgentGenerateRequest) => {
      const step = steps[turn]
      turn += 1
      return {
        content: '',
        toolCalls: [{
          id: `call-${turn}`,
          name: step.summary ? 'finish_markdown_edit' : 'apply_markdown_edit',
          input: step
        }]
      }
    })
    const result = await runDocumentEditAgent({
      markdown: 'alpha',
      instruction: 'Update the text in two dependent steps.',
      contextMessages: [],
      requestId: 'agent-request',
      signal: new AbortController().signal,
      generateAgent,
      maxSteps: 4
    })
    expect(result.markdown).toBe('gamma')
    expect(result.summary.operationCount).toBe(2)
    expect(generateAgent).toHaveBeenCalledTimes(3)
    expect(generateAgent.mock.calls[1][0].messages.some(message => message.toolResults?.[0]?.content.includes('"version":1'))).toBe(true)
  })

  it('returns exact-match tool errors and preserves completed steps', async() => {
    let turn = 0
    const diagnostics: DocumentEditValidationDiagnostic[] = []
    const generateAgent = vi.fn(async() => {
      turn += 1
      if (turn === 1) return { content: '', toolCalls: [{ id: 'bad', name: 'apply_markdown_edit', input: { version: 0, search: 'missing', replace: 'new', description: 'Bad anchor' } }] }
      if (turn === 2) return { content: '', toolCalls: [{ id: 'good', name: 'apply_markdown_edit', input: { version: 0, search: 'old', replace: 'new', description: 'Changed the anchor.' } }] }
      return { content: '', toolCalls: [{ id: 'finish', name: 'finish_markdown_edit', input: { version: 1, summary: 'Changed the anchor.' } }] }
    })
    const result = await runDocumentEditAgent({
      markdown: 'old',
      instruction: 'Change old to new.',
      contextMessages: [],
      requestId: 'agent-repair-request',
      signal: new AbortController().signal,
      generateAgent,
      onValidationFailure: diagnostic => diagnostics.push(diagnostic)
    })
    expect(result.markdown).toBe('new')
    expect(result.summary.operationCount).toBe(1)
    expect(diagnostics[0].code).toBe('exact-match')
    expect(generateAgent).toHaveBeenCalledTimes(3)
  })

  it('applies one exact local replacement and reports changed lines', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => ({
      content: responseWith(input.system, 'old title', 'new title')
    }))

    const result = await request('# old title\n\nKeep this.', generate)

    expect(result.markdown).toBe('# new title\n\nKeep this.')
    expect(result.summary).toEqual({
      operationCount: 1,
      addedLines: 1,
      removedLines: 1,
      operations: [{
        startLine: 1,
        endLine: 1,
        addedLines: 1,
        removedLines: 1,
        afterStartLine: 1,
        afterEndLine: 1,
        afterStartOffset: 2,
        afterEndOffset: 5
      }]
    })
    expect(result.attempts).toBe(1)
  })

  it('retries a non-unique block once and applies the corrected block', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => {
      if (generate.mock.calls.length === 1) return { content: responseWith(input.system, 'old', 'new') }
      return { content: responseWith(input.system, 'old\nold', 'new\nold') }
    })

    const result = await request('old\nold', generate)

    expect(result.markdown).toBe('new\nold')
    expect(result.attempts).toBe(2)
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('keeps current image attachments on a validation repair retry', async() => {
    const attachment: AiImageAttachment = {
      id: 'attachment-test-0001',
      name: 'table.png',
      mimeType: 'image/png',
      byteSize: 8
    }
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => {
      expect(input.messages.find(message => message.role === 'user')?.attachments).toEqual([attachment])
      if (generate.mock.calls.length === 1) return { content: responseWith(input.system, 'old', 'new') }
      return { content: responseWith(input.system, 'old\nold', 'new\nold') }
    })

    const result = await runDocumentEditAgent({
      markdown: 'old\nold',
      instruction: 'Make the requested change.',
      contextMessages: [],
      attachments: [attachment],
      requestId: 'test-request',
      signal: new AbortController().signal,
      generate
    })

    expect(result.attempts).toBe(2)
    expect(generate).toHaveBeenCalledTimes(2)
  })

  it('rejects marker blocks without the request token', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => {
      const delimiter = input.system.match(/MT_EDIT_[a-f0-9]+/)?.[0]
      if (!delimiter) throw new Error('The test prompt did not contain an edit delimiter.')
      return { content: '<<<<<<< SEARCH\nold\n=======\nnew\n>>>>>>> REPLACE' }
    })

    await expect(request('old', generate)).rejects.toThrow('after 2 attempts')
  })

  it('can disable automatic repair retries and fallback generation', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => ({
      content: `${responseWith(input.system, 'missing', 'new')}\nUnexpected explanation`
    }))
    const generateWhole = vi.fn(async() => ({ content: '# new title' }))

    await expect(runDocumentEditAgent({
      markdown: '# old title',
      instruction: 'Update the title.',
      contextMessages: [],
      requestId: 'test-request',
      signal: new AbortController().signal,
      generate,
      generateWhole,
      maxRetries: 0
    })).rejects.toThrow('after 1 attempts')

    expect(generate).toHaveBeenCalledTimes(1)
    expect(generateWhole).not.toHaveBeenCalled()
  })

  it('repairs an un-tokenized divider only when the search is uniquely determined', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => {
      const delimiter = input.system.match(/MT_EDIT_[a-f0-9]+/)?.[0]
      if (!delimiter) throw new Error('The test prompt did not contain an edit delimiter.')
      return {
        content: [
          `<<<<<<< SEARCH ${delimiter}`,
          'old',
          '=======',
          'new',
          `>>>>>>> REPLACE ${delimiter}`
        ].join('\n')
      }
    })

    const result = await request('old', generate)
    expect(result.markdown).toBe('new')
    expect(result.attempts).toBe(1)
  })

  it('uses the complete-document fallback only through an explicit callback', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => ({
      content: `${responseWith(input.system, 'missing', 'new')}\nUnexpected explanation`
    }))
    const generateWhole = vi.fn(async() => ({ content: '# new title' }))

    const result = await runDocumentEditAgent({
      markdown: '# old title',
      instruction: 'Update the title.',
      contextMessages: [],
      requestId: 'test-request',
      signal: new AbortController().signal,
      generate,
      generateWhole
    })

    expect(result.markdown).toBe('# new title')
    expect(result.requiresConfirmation).toBe(true)
    expect(result.recovery?.strategy).toBe('whole-document-fallback')
    expect(generateWhole).toHaveBeenCalledTimes(1)
  })

  it('accepts a validated structured edit response', async() => {
    const generateTool = vi.fn(async() => ({
      content: '',
      toolCalls: [{
        name: 'submit_markdown_edits',
        input: {
          status: 'changed',
          summary: 'Updated the title.',
          edits: [{ search: '# old', replace: '# new' }]
        }
      }]
    }))

    const result = await runDocumentEditAgent({
      markdown: '# old',
      instruction: 'Update the title.',
      contextMessages: [],
      requestId: 'test-request',
      signal: new AbortController().signal,
      generate: vi.fn(),
      generateTool
    })

    expect(result.markdown).toBe('# new')
    expect(result.message).toBe('Updated the title.')
    expect(result.recovery?.strategy).toBe('direct')
  })

  it('validates all blocks before applying multiple edits', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => {
      const delimiter = input.system.match(/MT_EDIT_[a-f0-9]+/)?.[0]
      if (!delimiter) throw new Error('The test prompt did not contain an edit delimiter.')
      return {
        content: [
          `<<<<<<< SEARCH ${delimiter}`,
          'first',
          `======= ${delimiter}`,
          'one',
          `>>>>>>> REPLACE ${delimiter}`,
          `<<<<<<< SEARCH ${delimiter}`,
          'third',
          `======= ${delimiter}`,
          'three',
          `>>>>>>> REPLACE ${delimiter}`
        ].join('\n')
      }
    })

    const result = await request('first\nsecond\nthird', generate)
    expect(result.markdown).toBe('one\nsecond\nthree')
    expect(result.summary.operationCount).toBe(2)
  })

  it('rejects overlapping blocks instead of partially applying them', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => {
      const delimiter = input.system.match(/MT_EDIT_[a-f0-9]+/)?.[0]
      if (!delimiter) throw new Error('The test prompt did not contain an edit delimiter.')
      return {
        content: [
          `<<<<<<< SEARCH ${delimiter}`,
          'alpha',
          `======= ${delimiter}`,
          'one',
          `>>>>>>> REPLACE ${delimiter}`,
          `<<<<<<< SEARCH ${delimiter}`,
          'alpha beta',
          `======= ${delimiter}`,
          'two',
          `>>>>>>> REPLACE ${delimiter}`
        ].join('\n')
      }
    })

    await expect(request('alpha beta', generate)).rejects.toThrow('overlap')
    expect(generate).toHaveBeenCalledTimes(documentEditAgentLimits.maxAttempts)
  })

  it('fails without changing anything after two invalid responses', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => ({
      content: `${responseWith(input.system, 'missing', 'new')}\nUnexpected explanation`
    }))
    const diagnostics: DocumentEditValidationDiagnostic[] = []

    await expect(request('existing', generate, {
      onValidationFailure: diagnostic => diagnostics.push(diagnostic)
    })).rejects.toThrow('after 2 attempts')
    expect(generate).toHaveBeenCalledTimes(documentEditAgentLimits.maxAttempts)
    expect(diagnostics).toHaveLength(documentEditAgentLimits.maxAttempts)
    expect(diagnostics[0]).toMatchObject({
      attempt: 1,
      responseChars: expect.any(Number),
      responseLines: 6,
      summaryMarkers: 0,
      searchMarkers: 1,
      dividerMarkers: 1,
      replaceMarkers: 1
    })
    expect(diagnostics[0].response).toContain('Unexpected explanation')
  })

  it('supports inserting into an empty document and no-op responses', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => ({
      content: responseWith(input.system, '', '# Added')
    }))
    const result = await request('', generate)
    expect(result.markdown).toBe('# Added')
    expect(result.summary.addedLines).toBe(1)

    const noChanges = await request('already done', vi.fn(async(input: DocumentEditGenerateRequest) => {
      const delimiter = input.system.match(/MT_EDIT_[a-f0-9]+/)?.[0]
      return { content: `NO_CHANGES ${delimiter}` }
    }))
    expect(noChanges.markdown).toBe('already done')
    expect(noChanges.summary).toEqual({
      operationCount: 0,
      addedLines: 0,
      removedLines: 0,
      operations: []
    })
  })

  it('returns a one-line model summary and preserves CRLF documents', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => {
      const delimiter = input.system.match(/MT_EDIT_[a-f0-9]+/)?.[0]
      if (!delimiter) throw new Error('The test prompt did not contain an edit delimiter.')
      return {
        content: [
          `<<<<<<< SUMMARY ${delimiter}`,
          'Updated the title.',
          `>>>>>>> SUMMARY ${delimiter}`,
          `<<<<<<< SEARCH ${delimiter}`,
          '# Old title\n\nKeep this.',
          `======= ${delimiter}`,
          '# New title\n\nKeep this.',
          `>>>>>>> REPLACE ${delimiter}`
        ].join('\n')
      }
    })

    const result = await request('# Old title\r\n\r\nKeep this.', generate)
    expect(result.message).toBe('Updated the title.')
    expect(result.markdown).toBe('# New title\r\n\r\nKeep this.')
  })

  it('allows Setext Markdown inside a tokenized SEARCH block', async() => {
    const generate = vi.fn(async(input: DocumentEditGenerateRequest) => ({
      content: responseWith(input.system, 'Title\n=====', 'New title\n---------')
    }))

    const result = await request('Title\n=====\n\nBody', generate)
    expect(result.markdown).toBe('New title\n---------\n\nBody')
  })

  it('rejects truncated model output', async() => {
    const generate = vi.fn(async() => ({ content: '', truncated: true }))
    await expect(request('existing', generate)).rejects.toThrow('truncated')
    expect(generate).toHaveBeenCalledTimes(documentEditAgentLimits.maxAttempts)
  })
})
