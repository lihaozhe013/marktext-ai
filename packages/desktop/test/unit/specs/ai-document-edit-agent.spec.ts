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
      {
        version: 0,
        summary: 'Update the text in two dependent steps.',
        steps: [
          { id: 'first', description: 'Update the first word.', intent: 'Change alpha to beta.', startAnchor: 'alpha', dependsOn: [] },
          { id: 'second', description: 'Refine the updated word.', intent: 'Change beta to gamma.', startAnchor: 'beta', dependsOn: ['first'] }
        ]
      },
      { version: 0, planStepId: 'first', search: 'alpha', replace: 'beta', description: 'Updated the first word.' },
      { version: 1, planStepId: 'second', search: 'beta', replace: 'gamma', description: 'Refined the updated word.' },
      { version: 2, summary: 'Updated the requested text.' }
    ]
    let turn = 0
    const appliedSteps: Array<{ addedLines: number; removedLines: number; removedText: string; addedText: string }> = []
    const generateAgent = vi.fn(async(_input: DocumentAgentGenerateRequest) => {
      const step = steps[turn]
      turn += 1
      return {
        content: '',
        toolCalls: [{
          id: `call-${turn}`,
          name: step.steps ? 'create_markdown_edit_plan' : step.summary ? 'finish_markdown_edit' : 'apply_markdown_edit',
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
      maxSteps: 4,
      onAgentStep: (_step, _maxSteps, _description, _version, _before, _after, addedLines, removedLines, removedText, addedText) => {
        appliedSteps.push({ addedLines, removedLines, removedText, addedText })
      }
    })
    expect(result.markdown).toBe('gamma')
    expect(result.summary.operationCount).toBe(2)
    expect(appliedSteps).toEqual([
      { addedLines: 1, removedLines: 1, removedText: 'alpha', addedText: 'beta' },
      { addedLines: 1, removedLines: 1, removedText: 'beta', addedText: 'gamma' }
    ])
    expect(generateAgent).toHaveBeenCalledTimes(3)
    expect(generateAgent.mock.calls[1][0].phase).toBe('ready-to-apply')
    expect(generateAgent.mock.calls[1][0].tools.map(tool => tool.name)).toEqual(['apply_markdown_edit'])
    expect(generateAgent.mock.calls[1][0].messages.at(-1)?.content).toContain('"currentVersion":0')
    expect(generateAgent.mock.calls[1][0].messages.at(-1)?.content.match(/\nalpha\n/g)).toHaveLength(1)
  })

  it('exposes only the tool allowed by the current phase and owns version state', async() => {
    const calls: DocumentAgentGenerateRequest[] = []
    const generateAgent = vi.fn(async(input: DocumentAgentGenerateRequest) => {
      calls.push(input)
      const turn = calls.length
      if (turn === 1) return { content: '', toolCalls: [{ id: 'plan', name: 'create_markdown_edit_plan', input: { summary: 'Change the title.', steps: [{ id: 'title', description: 'Change the title.', intent: 'Change old to new.', startAnchor: 'old', dependsOn: [] }] } }] }
      if (turn === 2) return { content: '', toolCalls: [{ id: 'apply', name: 'apply_markdown_edit', input: { version: 0, planStepId: 'stale-step', search: 'old', replace: 'new', description: 'Changed the title.' } }] }
      return { content: '', toolCalls: [{ id: 'finish', name: 'finish_markdown_edit', input: { version: 99, summary: '' } }] }
    })
    const result = await runDocumentEditAgent({
      markdown: 'old',
      instruction: 'Change the title.',
      contextMessages: [],
      requestId: 'phase-gating-request',
      signal: new AbortController().signal,
      generateAgent
    })

    expect(result.markdown).toBe('new')
    expect(calls.map(call => call.phase)).toEqual(['needs-plan', 'ready-to-apply'])
    expect(calls.map(call => call.tools.map(tool => tool.name))).toEqual([
      ['create_markdown_edit_plan'],
      ['apply_markdown_edit']
    ])
    expect(calls[1].messages.at(-1)?.content).toContain('"currentVersion":0')
    expect(calls.every(call => call.messages.every(message => !message.toolCalls && !message.toolResults))).toBe(true)
  })

  it('does not expose revise after an invalid initial plan', async() => {
    const calls: DocumentAgentGenerateRequest[] = []
    const generateAgent = vi.fn(async(input: DocumentAgentGenerateRequest) => {
      calls.push(input)
      return {
        content: '',
        toolCalls: [{
          id: `bad-${calls.length}`,
          name: calls.length === 1 ? 'create_markdown_edit_plan' : 'revise_markdown_edit_plan',
          input: calls.length === 1
            ? { summary: 'Missing anchor.', steps: [{ id: 'bad', description: 'Bad step.', intent: 'Change old.', startAnchor: '', dependsOn: [] }] }
            : { reason: 'Retry as a revision.', remainingSteps: [] }
        }]
      }
    })

    await expect(runDocumentEditAgent({
      markdown: 'old',
      instruction: 'Change old.',
      contextMessages: [],
      requestId: 'no-revise-before-plan-request',
      signal: new AbortController().signal,
      generateAgent
    })).rejects.toThrow('could not create a valid initial plan')
    expect(calls.every(call => call.tools.map(tool => tool.name).join(',') === 'create_markdown_edit_plan')).toBe(true)
  })

  it('allows deferred anchors and forces revision when the step becomes active', async() => {
    let turn = 0
    const phases: string[] = []
    const generateAgent = vi.fn(async(input: DocumentAgentGenerateRequest) => {
      phases.push(input.phase)
      turn += 1
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'plan',
            name: 'create_markdown_edit_plan',
            input: {
              summary: 'Update both words.',
              steps: [
                { id: 'first', description: 'Update first.', intent: 'Change first to done.', startAnchor: 'first', dependsOn: [] },
                { id: 'second', description: 'Update second.', intent: 'Change the generated word.', startAnchor: '', dependsOn: ['first'] }
              ]
            }
          }]
        }
      }
      if (turn === 2) {
        return { content: '', toolCalls: [{ id: 'apply-1', name: 'apply_markdown_edit', input: { search: 'first', replace: 'generated', description: 'Updated first.' } }] }
      }
      if (turn === 3) {
        return { content: '', toolCalls: [{ id: 'revise', name: 'revise_markdown_edit_plan', input: { reason: 'Resolve the generated target.', remainingSteps: [{ id: 'second', description: 'Update second.', intent: 'Change generated to done.', startAnchor: 'generated', dependsOn: [] }] } }] }
      }
      if (turn === 4) {
        return { content: '', toolCalls: [{ id: 'apply-2', name: 'apply_markdown_edit', input: { search: 'generated', replace: 'done', description: 'Updated second.' } }] }
      }
      return { content: '', toolCalls: [{ id: 'finish', name: 'finish_markdown_edit', input: { summary: '' } }] }
    })

    const result = await runDocumentEditAgent({
      markdown: 'first',
      instruction: 'Update both words.',
      contextMessages: [],
      requestId: 'deferred-anchor-request',
      signal: new AbortController().signal,
      generateAgent
    })

    expect(result.markdown).toBe('done')
    expect(phases).toEqual(['needs-plan', 'ready-to-apply', 'needs-revision', 'ready-to-apply'])
  })

  it('uses a confirmation fallback after two invalid initial plans', async() => {
    let turn = 0
    const generateAgent = vi.fn(async() => {
      turn += 1
      return { content: '', toolCalls: [{ id: `bad-${turn}`, name: 'create_markdown_edit_plan', input: { summary: 'Invalid.', steps: [{ id: `bad-${turn}`, description: 'Invalid.', intent: 'Change old.', startAnchor: '', dependsOn: [] }] } }] }
    })
    const generateWhole = vi.fn(async() => ({ content: 'new' }))
    const result = await runDocumentEditAgent({
      markdown: 'old',
      instruction: 'Change old.',
      contextMessages: [],
      requestId: 'initial-plan-fallback-request',
      signal: new AbortController().signal,
      generateAgent,
      generateWhole
    })

    expect(result.markdown).toBe('new')
    expect(result.requiresConfirmation).toBe(true)
    expect(result.recovery?.strategy).toBe('whole-document-fallback')
    expect(generateWhole).toHaveBeenCalledTimes(1)
  })

  it('returns exact-match tool errors and preserves completed steps', async() => {
    let turn = 0
    const diagnostics: DocumentEditValidationDiagnostic[] = []
    const generateAgent = vi.fn(async() => {
      turn += 1
      if (turn === 1) return { content: '', toolCalls: [{ id: 'plan', name: 'create_markdown_edit_plan', input: { version: 0, summary: 'Change the anchor.', steps: [{ id: 'change', description: 'Change the anchor.', intent: 'Change old to new.', startAnchor: 'old', dependsOn: [] }] } }] }
      if (turn === 2) return { content: '', toolCalls: [{ id: 'bad', name: 'apply_markdown_edit', input: { version: 0, planStepId: 'change', search: 'missing', replace: 'new', description: 'Bad anchor' } }] }
      if (turn === 3) return { content: '', toolCalls: [{ id: 'good', name: 'apply_markdown_edit', input: { version: 0, planStepId: 'change', search: 'old', replace: 'new', description: 'Changed the anchor.' } }] }
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

  it('requires a plan before applying edits', async() => {
    const generateAgent = vi.fn(async() => ({
      content: '',
      toolCalls: [{ id: 'apply', name: 'apply_markdown_edit', input: { version: 0, planStepId: 'missing-plan', search: 'old', replace: 'new', description: 'Change it.' } }]
    }))
    await expect(runDocumentEditAgent({
      markdown: 'old',
      instruction: 'Change it.',
      contextMessages: [],
      requestId: 'plan-required-request',
      signal: new AbortController().signal,
      generateAgent
    })).rejects.toThrow('could not create a valid initial plan')
  })

  it('accepts a large coherent code block when it stays inside its plan scope', async() => {
    const before = '```ts\n' + Array.from({ length: 60 }, (_, index) => `const value${index} = ${index}`).join('\n') + '\n```'
    const after = before.replace('const value0 = 0', 'const value0 = 1')
    const generateAgent = vi.fn(async(_input: DocumentAgentGenerateRequest) => {
      const turn = generateAgent.mock.calls.length
      if (turn === 1) return { content: '', toolCalls: [{ id: 'plan', name: 'create_markdown_edit_plan', input: { version: 0, summary: 'Update the code block.', steps: [{ id: 'code', description: 'Update the code block.', intent: 'Change the first constant.', startAnchor: '```ts', endAnchor: '```', dependsOn: [] }] } }] }
      if (turn === 2) return { content: '', toolCalls: [{ id: 'apply', name: 'apply_markdown_edit', input: { version: 0, planStepId: 'code', search: before, replace: after, description: 'Updated the code block.' } }] }
      return { content: '', toolCalls: [{ id: 'finish', name: 'finish_markdown_edit', input: { version: 1, summary: 'Updated the code block.' } }] }
    })
    const result = await runDocumentEditAgent({
      markdown: before,
      instruction: 'Update the code block.',
      contextMessages: [],
      requestId: 'large-code-request',
      signal: new AbortController().signal,
      generateAgent
    })
    expect(result.markdown).toBe(after)
  })

  it('supports inserting into an empty document with an empty plan anchor', async() => {
    let turn = 0
    const generateAgent = vi.fn(async() => {
      turn += 1
      if (turn === 1) return { content: '', toolCalls: [{ id: 'plan', name: 'create_markdown_edit_plan', input: { version: 0, summary: 'Create the document.', steps: [{ id: 'create', description: 'Create the document.', intent: 'Insert the requested heading.', startAnchor: '', dependsOn: [] }] } }] }
      if (turn === 2) return { content: '', toolCalls: [{ id: 'apply', name: 'apply_markdown_edit', input: { version: 0, planStepId: 'create', search: '', replace: '# Title', description: 'Created the document.' } }] }
      return { content: '', toolCalls: [{ id: 'finish', name: 'finish_markdown_edit', input: { version: 1, summary: 'Created the document.' } }] }
    })
    const result = await runDocumentEditAgent({
      markdown: '',
      instruction: 'Create the document.',
      contextMessages: [],
      requestId: 'empty-document-request',
      signal: new AbortController().signal,
      generateAgent
    })
    expect(result.markdown).toBe('# Title')
  })

  it('rejects an end anchor on the first step of an empty document and accepts a corrected plan', async() => {
    let turn = 0
    const diagnostics: DocumentEditValidationDiagnostic[] = []
    const generateAgent = vi.fn(async() => {
      turn += 1
      if (turn === 1) return { content: '', toolCalls: [{ id: 'bad-plan', name: 'create_markdown_edit_plan', input: { version: 0, summary: 'Create a guide.', steps: [{ id: 'first', description: 'Create the guide.', intent: 'Insert the guide.', startAnchor: '', endAnchor: 'intro', dependsOn: [] }] } }] }
      if (turn === 2) return { content: '', toolCalls: [{ id: 'good-plan', name: 'create_markdown_edit_plan', input: { version: 0, summary: 'Create a guide.', steps: [{ id: 'first', description: 'Create the guide.', intent: 'Insert the guide.', startAnchor: '', dependsOn: [] }] } }] }
      if (turn === 3) return { content: '', toolCalls: [{ id: 'apply', name: 'apply_markdown_edit', input: { version: 0, planStepId: 'first', search: '', replace: '# HTML Guide', description: 'Created the guide.' } }] }
      return { content: '', toolCalls: [{ id: 'finish', name: 'finish_markdown_edit', input: { version: 1, summary: 'Created the guide.' } }] }
    })
    const result = await runDocumentEditAgent({
      markdown: '',
      instruction: 'Create an HTML guide.',
      contextMessages: [],
      requestId: 'empty-plan-repair-request',
      signal: new AbortController().signal,
      generateAgent,
      onValidationFailure: diagnostic => diagnostics.push(diagnostic)
    })
    expect(result.markdown).toBe('# HTML Guide')
    expect(diagnostics[0]).toMatchObject({ code: 'scope' })
    expect(generateAgent).toHaveBeenCalledTimes(3)
  })

  it('revises only unfinished plan steps after a scope failure', async() => {
    let turn = 0
    const generateAgent = vi.fn(async() => {
      turn += 1
      if (turn === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'plan',
            name: 'create_markdown_edit_plan',
            input: {
              version: 0,
              summary: 'Update both words.',
              steps: [
                { id: 'first', description: 'Update first.', intent: 'Change first.', startAnchor: 'first', dependsOn: [] },
                { id: 'second', description: 'Update second.', intent: 'Change second.', startAnchor: 'missing', dependsOn: ['first'] }
              ]
            }
          }]
        }
      }
      if (turn === 2) return { content: '', toolCalls: [{ id: 'apply-1', name: 'apply_markdown_edit', input: { version: 0, planStepId: 'first', search: 'first', replace: 'done', description: 'Updated first.' } }] }
      if (turn === 3) return { content: '', toolCalls: [{ id: 'revise', name: 'revise_markdown_edit_plan', input: { version: 1, reason: 'The second anchor moved.', remainingSteps: [{ id: 'second', description: 'Update second.', intent: 'Change second.', startAnchor: 'second', dependsOn: ['first'] }] } }] }
      if (turn === 4) return { content: '', toolCalls: [{ id: 'apply-2', name: 'apply_markdown_edit', input: { version: 1, planStepId: 'second', search: 'second', replace: 'done2', description: 'Updated second.' } }] }
      return { content: '', toolCalls: [{ id: 'finish', name: 'finish_markdown_edit', input: { version: 2, summary: 'Updated both words.' } }] }
    })
    const result = await runDocumentEditAgent({
      markdown: 'first second',
      instruction: 'Update both words.',
      contextMessages: [],
      requestId: 'plan-revision-request',
      signal: new AbortController().signal,
      generateAgent
    })
    expect(result.markdown).toBe('done done2')
    expect(generateAgent).toHaveBeenCalledTimes(4)
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

  it('uses host-owned append and prepend operations without replacing existing text', async() => {
    const calls: DocumentAgentGenerateRequest[] = []
    const generateAgent = vi.fn(async(input: DocumentAgentGenerateRequest) => {
      calls.push(input)
      if (calls.length === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'plan',
            name: 'create_markdown_edit_plan',
            input: {
              summary: 'Add notes.',
              steps: [{ id: 'append', description: 'Append notes.', intent: 'Add the notes at the end.', operation: 'append', startAnchor: null, endAnchor: null, dependsOn: [] }]
            }
          }]
        }
      }
      return {
        content: '',
        toolCalls: [{ id: 'append', name: 'append_markdown', input: { markdown: '## Notes\n\n- Added detail', description: 'Appended notes.' } }]
      }
    })
    const result = await runDocumentEditAgent({
      markdown: '# Existing',
      instruction: 'Add notes.',
      contextMessages: [],
      requestId: 'append-operation-request',
      signal: new AbortController().signal,
      generateAgent
    })

    expect(result.markdown).toBe('# Existing\n\n## Notes\n\n- Added detail')
    expect(calls[1].tools.map(tool => tool.name)).toEqual(['append_markdown'])
    expect(result.summary.operationCount).toBe(1)
  })

  it('returns a partial result after a confirmed step when the provider fails', async() => {
    let calls = 0
    const phases: string[] = []
    const result = await runDocumentEditAgent({
      markdown: 'Existing',
      instruction: 'Append notes.',
      contextMessages: [],
      requestId: 'partial-agent-request',
      signal: new AbortController().signal,
      generateAgent: vi.fn(async(_input: DocumentAgentGenerateRequest) => {
        calls += 1
        if (calls === 1) {
          return {
            content: '',
            toolCalls: [{
              id: 'plan',
              name: 'create_markdown_edit_plan',
              input: {
                summary: 'Append notes.',
                steps: [
                  { id: 'append', description: 'Append notes.', intent: 'Append notes.', operation: 'append', startAnchor: null, endAnchor: null, dependsOn: [] },
                  { id: 'prepend', description: 'Prepend context.', intent: 'Prepend context.', operation: 'prepend', startAnchor: null, endAnchor: null, dependsOn: ['append'] }
                ]
              }
            }]
          }
        }
        if (calls === 2) {
          return {
            content: '',
            toolCalls: [{ id: 'append', name: 'append_markdown', input: { markdown: 'Notes', description: 'Appended notes.' } }]
          }
        }
        throw new Error('provider unavailable')
      }),
      onPhase: phase => phases.push(phase)
    })

    expect(result.agentCompletion).toBe('partial')
    expect(result.recovery?.strategy).toBe('partial-agent')
    expect(result.markdown).toBe('Existing\n\nNotes')
    expect(result.agentCompletedSteps).toBe(1)
    expect(phases).toContain('partial')
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

  it('resets consecutive missing-tool failures after a valid plan step', async() => {
    const diagnostics: DocumentEditValidationDiagnostic[] = []
    let calls = 0
    const generateAgent = vi.fn(async(_input: DocumentAgentGenerateRequest) => {
      calls += 1
      if (calls === 1) {
        return {
          content: '',
          toolCalls: [{
            id: 'plan',
            name: 'create_markdown_edit_plan',
            input: {
              summary: 'Append notes.',
              steps: [{ id: 'append', description: 'Append notes.', intent: 'Append notes.', operation: 'append', startAnchor: null, endAnchor: null, dependsOn: [] }]
            }
          }]
        }
      }
      if (calls === 2) return { content: '', truncated: true }
      return {
        content: '',
        toolCalls: [{ id: 'append', name: 'append_markdown', input: { markdown: 'Notes', description: 'Appended notes.' } }]
      }
    })

    const result = await runDocumentEditAgent({
      markdown: 'Existing',
      instruction: 'Append notes.',
      contextMessages: [],
      requestId: 'truncated-then-success',
      signal: new AbortController().signal,
      generateAgent,
      onValidationFailure: diagnostic => diagnostics.push(diagnostic)
    })

    expect(result.markdown).toBe('Existing\n\nNotes')
    expect(generateAgent).toHaveBeenCalledTimes(3)
    expect(diagnostics).toHaveLength(1)
    expect(diagnostics[0].code).toBe('truncated')
  })

  it('waits for two consecutive missing tool calls before failing', async() => {
    const diagnostics: DocumentEditValidationDiagnostic[] = []
    const generateAgent = vi.fn(async(_input: DocumentAgentGenerateRequest) => ({ content: '', toolCalls: [] }))

    await expect(runDocumentEditAgent({
      markdown: 'Existing',
      instruction: 'Append notes.',
      contextMessages: [],
      requestId: 'missing-tool-call',
      signal: new AbortController().signal,
      generateAgent,
      onValidationFailure: diagnostic => diagnostics.push(diagnostic)
    })).rejects.toThrow('required editing tool call')

    expect(generateAgent).toHaveBeenCalledTimes(2)
    expect(diagnostics.map(diagnostic => diagnostic.code)).toEqual(['missing-tool-call', 'missing-tool-call'])
  })
})
