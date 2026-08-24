import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiConnectionInput, AiJsonValue, AiRequest } from '@shared/types/ai'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle: vi.fn(), on: vi.fn() }
}))
vi.mock('electron-log', () => ({ default: { info: vi.fn() } }))

import { AiService } from 'main_renderer/ai'

const response = (payload: unknown, status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'application/json' },
  text: async() => JSON.stringify(payload)
} as unknown as Response)

const streamResponse = (events: string[], status = 200): Response => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: () => 'text/event-stream' },
  body: new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      for (const event of events) controller.enqueue(encoder.encode(event))
      controller.close()
    }
  })
} as unknown as Response)

const connection = (name: string, endpoint: string, model: string, apiKey: string): AiConnectionInput => ({
  name,
  protocol: 'openai-chat-completions',
  endpoint,
  models: [{ model, label: model }],
  apiKey
})

describe('AI connection profiles and model routing', () => {
  const directories: string[] = []

  afterEach(async() => {
    vi.unstubAllGlobals()
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
  })

  it('stores multiple connections with isolated keys and models', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-connections-'))
    directories.push(directory)
    const service = new AiService(directory)

    await service.saveConnection(connection('Provider A', 'https://a.example/v1', 'model-a', 'key-a'))
    const saved = await service.saveConnection(connection('Provider B', 'https://b.example/v1', 'model-b', 'key-b'))
    expect(saved.connections).toHaveLength(2)
    expect(saved.connections.map(item => item.hasApiKey)).toEqual([true, true])

    const keys = JSON.parse(await readFile(path.join(directory, 'ai-connection-key.json'), 'utf8'))
    expect(Object.values(keys)).toEqual(expect.arrayContaining(['key-a', 'key-b']))
    expect(JSON.stringify(saved)).not.toContain('key-a')
    expect(JSON.stringify(saved)).not.toContain('key-b')
  })

  it('migrates the legacy single connection and key format', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-migration-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'ai-connection.json'), JSON.stringify({
      protocol: 'anthropic-messages',
      endpoint: 'https://legacy.example',
      model: 'legacy-model'
    }))
    await writeFile(path.join(directory, 'ai-connection-key.json'), JSON.stringify('legacy-key'))
    const service = new AiService(directory)

    const settings = await service.getSettings()
    expect(settings.connections).toMatchObject([{
      id: 'legacy-default',
      name: 'Default connection',
      protocol: 'anthropic-messages',
      models: [{ id: 'legacy-default-model', model: 'legacy-model' }],
      hasApiKey: true
    }])
    const migratedKeys = JSON.parse(await readFile(path.join(directory, 'ai-connection-key.json'), 'utf8'))
    expect(migratedKeys).toEqual({ 'legacy-default': 'legacy-key' })
  })

  it('persists and clamps the edit auto-retry setting', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-retries-'))
    directories.push(directory)
    const service = new AiService(directory)

    expect((await service.getSettings()).editAutoRetryCount).toBe(1)
    expect((await service.setEditAutoRetryCount(0)).editAutoRetryCount).toBe(0)
    expect((await service.setEditAutoRetryCount(99)).editAutoRetryCount).toBe(3)
    expect((await service.getSettings()).editAutoRetryCount).toBe(3)
    expect((await service.getSettings()).failureOutputAfter).toBe(1)
    expect((await service.setFailureOutputAfter(0)).failureOutputAfter).toBe(0)
    expect((await service.setFailureOutputAfter(99)).failureOutputAfter).toBe(3)
    expect((await service.getSettings()).failureOutputAfter).toBe(3)
  })

  it('defaults to recent context and persists the summary mode', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-context-mode-'))
    directories.push(directory)
    const service = new AiService(directory)

    expect((await service.getSettings()).contextMode).toBe('recent')
    expect((await service.setContextMode('summary')).contextMode).toBe('summary')
    expect((await service.getSettings()).contextMode).toBe('summary')
    expect((await service.setContextMode(undefined)).contextMode).toBe('recent')
  })

  it('persists and validates user-defined request body presets', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-request-presets-settings-'))
    directories.push(directory)
    const service = new AiService(directory)

    const saved = await service.saveConnection({
      name: 'Custom request presets',
      protocol: 'openai-chat-completions',
      endpoint: 'https://custom.example/v1',
      models: [{
        model: 'arbitrary-model',
        capabilities: {
          requestBodyPresets: {
            presets: [
              { id: 'enabled', name: 'Enabled', body: { thinking: { type: ' enabled ' } } },
              { id: 'disabled', name: 'Disabled', body: { thinking: { type: 'disabled' } } }
            ],
            defaultPresetId: 'enabled',
            editAgentPresetId: 'disabled'
          }
        }
      }],
      apiKey: 'custom-key'
    })
    expect(saved.connections[0].models[0].capabilities).toEqual({
      requestBodyPresets: {
        presets: [
          { id: 'enabled', name: 'Enabled', body: { thinking: { type: ' enabled ' } } },
          { id: 'disabled', name: 'Disabled', body: { thinking: { type: 'disabled' } } }
        ],
        defaultPresetId: 'enabled',
        editAgentPresetId: 'disabled'
      }
    })

    await expect(service.saveConnection({
      name: 'Invalid presets',
      protocol: 'openai-chat-completions',
      endpoint: 'https://invalid.example/v1',
      models: [{ model: 'arbitrary-model', capabilities: { requestBodyPresets: { presets: [] } } }],
      apiKey: 'invalid-key'
    })).rejects.toThrow('Invalid request body preset configuration')
    await expect(service.saveConnection({
      name: 'Invalid edit preset reference',
      protocol: 'openai-chat-completions',
      endpoint: 'https://invalid-edit-preset.example/v1',
      models: [{
        model: 'arbitrary-model',
        capabilities: {
          requestBodyPresets: {
            presets: [{ id: 'only', name: 'Only', body: { thinking: { type: 'enabled' } } }],
            editAgentPresetId: 'missing'
          }
        }
      }],
      apiKey: 'invalid-key'
    })).rejects.toThrow('edit Agent preset')
  })

  it('migrates legacy reasoning_effort profiles and session overrides', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-request-presets-migration-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'ai-connection.json'), JSON.stringify({
      schemaVersion: 6,
      connections: [{
        id: 'legacy-connection',
        name: 'Legacy',
        protocol: 'openai-chat-completions',
        endpoint: 'https://legacy.example/v1',
        models: [{
          id: 'legacy-model',
          model: 'legacy-model',
          label: 'Legacy model',
          capabilities: { reasoningEffort: { options: ['low', 'high'], defaultValue: 'high' } }
        }]
      }],
      editAutoRetryCount: 1,
      editAgentMaxSteps: 64,
      failureOutputAfter: 1,
      contextMode: 'recent'
    }))
    await writeFile(path.join(directory, 'ai-chat.json'), JSON.stringify({
      'tab:legacy': {
        messages: [],
        reasoningEffortOverrides: [{
          modelRef: { connectionId: 'legacy-connection', modelId: 'legacy-model' },
          value: 'low'
        }]
      }
    }))
    const service = new AiService(directory)

    const settings = await service.getSettings()
    const capabilities = settings.connections[0].models[0].capabilities
    expect(capabilities?.requestBodyPresets?.defaultPresetId).toBe('legacy-reasoning-effort:high')
    expect(capabilities?.requestBodyPresets?.presets).toEqual([
      { id: 'legacy-reasoning-effort:low', name: 'low', body: { reasoning_effort: 'low' } },
      { id: 'legacy-reasoning-effort:high', name: 'high', body: { reasoning_effort: 'high' } }
    ])
    expect(JSON.parse(await readFile(path.join(directory, 'ai-connection.json'), 'utf8')).schemaVersion).toBe(8)
    expect((await service.loadChat('tab:legacy')).requestBodyPresetOverrides).toEqual([{
      modelRef: { connectionId: 'legacy-connection', modelId: 'legacy-model' },
      presetId: 'legacy-reasoning-effort:low'
    }])
  })

  it('clears a broken persisted edit Agent preset reference', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-broken-edit-preset-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'ai-connection.json'), JSON.stringify({
      schemaVersion: 8,
      connections: [{
        id: 'broken-connection',
        name: 'Broken preset',
        protocol: 'openai-chat-completions',
        endpoint: 'https://broken-preset.example/v1',
        models: [{
          id: 'broken-model',
          model: 'broken-model',
          label: 'Broken model',
          source: 'manual',
          capabilities: {
            requestBodyPresets: {
              presets: [{ id: 'valid', name: 'Valid', body: { thinking: { type: 'enabled' } } }],
              defaultPresetId: 'valid',
              editAgentPresetId: 'deleted'
            }
          }
        }]
      }],
      defaultModel: { connectionId: 'broken-connection', modelId: 'broken-model' },
      editAutoRetryCount: 1,
      editAgentMaxSteps: 64,
      failureOutputAfter: 1,
      contextMode: 'recent'
    }))
    const service = new AiService(directory)

    const settings = await service.getSettings()
    expect(settings.connections[0].models[0].capabilities?.requestBodyPresets).toEqual({
      presets: [{ id: 'valid', name: 'Valid', body: { thinking: { type: 'enabled' } } }],
      defaultPresetId: 'valid'
    })
    expect(JSON.parse(await readFile(path.join(directory, 'ai-connection.json'), 'utf8')).connections[0].models[0].capabilities.requestBodyPresets.editAgentPresetId).toBeUndefined()
  })

  it('rejects oversized, deeply nested, and prototype-polluting preset JSON', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-request-presets-validation-'))
    directories.push(directory)
    const service = new AiService(directory)
    const save = (body: Record<string, AiJsonValue>) => service.saveConnection({
      name: 'Invalid preset',
      protocol: 'openai-chat-completions',
      endpoint: 'https://invalid.example/v1',
      models: [{
        model: 'invalid-model',
        capabilities: { requestBodyPresets: { presets: [{ id: 'invalid', name: 'Invalid', body }] } }
      }],
      apiKey: 'invalid-key'
    })

    await expect(save({ value: 'x'.repeat(17 * 1024) })).rejects.toThrow('Invalid request body preset configuration')
    let nested: Record<string, AiJsonValue> = { value: true }
    for (let index = 0; index < 9; index += 1) nested = { nested }
    await expect(save(nested)).rejects.toThrow('Invalid request body preset configuration')
    await expect(save(JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, AiJsonValue>)).rejects.toThrow('Invalid request body preset configuration')
  })

  it('sends the configured default, session preset override, and explicit omission', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-request-presets-request-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Custom request presets',
      protocol: 'openai-chat-completions',
      endpoint: 'https://custom.example/v1',
      models: [{
        model: 'arbitrary-model',
        capabilities: {
          requestBodyPresets: {
            presets: [
              { id: 'low', name: 'Low', body: { reasoning_effort: 'low' } },
              { id: 'high', name: 'High', body: { reasoning_effort: 'high' } }
            ],
            defaultPresetId: 'low'
          }
        }
      }],
      apiKey: 'custom-key'
    })
    const fetchMock = vi.fn()
      .mockResolvedValue(response({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const request = (requestId: string, requestBodyPresetOverride?: string | null): AiRequest => ({
      requestId,
      documentId: `tab:${requestId}`,
      mode: 'answer',
      prompt: 'Explain this.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id },
      ...(requestBodyPresetOverride !== undefined ? { requestBodyPresetOverride } : {})
    })

    await service.request(request('preset-default'))
    await service.request(request('preset-override', 'high'))
    await service.request(request('preset-omit', null))

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).reasoning_effort).toBe('low')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).reasoning_effort).toBe('high')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).not.toHaveProperty('reasoning_effort')
  })

  it('prefers Responses, sends standard reasoning controls, and continues a stored answer chain', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-responses-chain-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Responses provider',
      protocol: 'openai-responses',
      endpoint: 'https://responses.example/v1/chat/completions',
      models: [{
        model: 'responses-model',
        capabilities: { responses: { reasoningEffort: 'medium', reasoningSummary: true, verbosity: 'low' } }
      }],
      apiKey: 'responses-key'
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({
        id: 'resp_1',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'First answer' }] }]
      }))
      .mockResolvedValueOnce(response({
        id: 'resp_2',
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'Second answer' }] }]
      }))
    vi.stubGlobal('fetch', fetchMock)
    const modelRef = { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    const first = await service.request({
      requestId: 'responses-first',
      documentId: 'tab:responses',
      mode: 'answer',
      prompt: 'First question',
      markdown: '# Document',
      messages: [],
      modelRef
    })
    expect(first.responsesConversationCandidate).toEqual({ modelRef, previousResponseId: 'resp_1' })
    const firstConversation = first.responsesConversationCandidate
    if (!firstConversation) throw new Error('Expected a Responses conversation candidate.')

    const second = await service.request({
      requestId: 'responses-second',
      documentId: 'tab:responses',
      mode: 'answer',
      prompt: 'Follow up',
      markdown: '# Document',
      messages: [{ id: 'assistant-1', role: 'assistant', mode: 'answer', content: 'First answer', createdAt: 1 }],
      modelRef,
      responsesConversation: { ...firstConversation, anchorMessageId: 'assistant-1' }
    })
    expect(second.content).toBe('Second answer')
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(firstBody).toMatchObject({ model: 'responses-model', store: true, instructions: expect.any(String), reasoning: { effort: 'medium', summary: 'auto' }, text: { verbosity: 'low' } })
    expect(firstBody.input).toEqual([{ role: 'user', content: expect.stringContaining('First question') }])
    expect(firstBody).not.toHaveProperty('previous_response_id')
    expect(secondBody).toMatchObject({ store: true, previous_response_id: 'resp_1', reasoning: { effort: 'medium', summary: 'auto' }, text: { verbosity: 'low' } })
    expect(secondBody.input).toEqual([{ role: 'user', content: expect.stringContaining('Follow up') }])
  })

  it('applies Responses verbosity overrides and omits it for rewrite requests', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-responses-verbosity-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Responses verbosity',
      protocol: 'openai-responses',
      endpoint: 'https://responses.example/v1',
      models: [{ model: 'responses-model', capabilities: { responses: { verbosity: 'medium' } } }],
      apiKey: 'responses-key'
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: 'resp-provider-default', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Provider default' }] }] }))
      .mockResolvedValueOnce(response({ id: 'resp-high', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'High' }] }] }))
      .mockResolvedValueOnce(response({ id: 'resp-rewrite', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '# Rewritten\n\nDocument' }] }] }))
      .mockResolvedValueOnce(response({ id: 'resp-test', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Connection test' }] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const modelRef = { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }

    await service.request({
      requestId: 'responses-provider-default',
      documentId: 'tab:responses-verbosity',
      mode: 'answer',
      prompt: 'Answer briefly.',
      markdown: '# Document',
      messages: [],
      modelRef,
      verbosityOverride: null
    })
    await service.request({
      requestId: 'responses-high',
      documentId: 'tab:responses-verbosity',
      mode: 'answer',
      prompt: 'Explain fully.',
      markdown: '# Document',
      messages: [],
      modelRef,
      verbosityOverride: 'high'
    })
    await service.request({
      requestId: 'responses-rewrite',
      documentId: 'tab:responses-verbosity',
      mode: 'rewrite',
      prompt: 'Rewrite this.',
      markdown: '# Document',
      messages: [],
      modelRef,
      verbosityOverride: 'high'
    })
    await expect(service.testConnection({
      name: 'Responses verbosity test',
      protocol: 'openai-responses',
      endpoint: 'https://responses.example/v1',
      models: [{ model: 'responses-model', capabilities: { responses: { verbosity: 'high' } } }],
      apiKey: 'responses-key'
    })).resolves.toMatchObject({ ok: true })

    const providerDefaultBody = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    const highBody = JSON.parse(String(fetchMock.mock.calls[1][1].body))
    const rewriteBody = JSON.parse(String(fetchMock.mock.calls[2][1].body))
    const testBody = JSON.parse(String(fetchMock.mock.calls[3][1].body))
    expect(providerDefaultBody).not.toHaveProperty('text')
    expect(highBody).toMatchObject({ text: { verbosity: 'high' } })
    expect(rewriteBody).not.toHaveProperty('text')
    expect(testBody).not.toHaveProperty('text')
  })

  it('rejects Responses presets that override application-owned fields', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-responses-preset-validation-'))
    directories.push(directory)
    const service = new AiService(directory)
    await expect(service.saveConnection({
      name: 'Invalid Responses preset',
      protocol: 'openai-responses',
      endpoint: 'https://responses.example/v1',
      models: [{
        model: 'responses-model',
        capabilities: { requestBodyPresets: { presets: [{ id: 'bad', name: 'Bad', body: { text: { verbosity: 'low' } } }] } }
      }],
      apiKey: 'responses-key'
    })).rejects.toThrow('cannot override')
  })

  it('rejects invalid Responses verbosity configuration', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-responses-invalid-verbosity-'))
    directories.push(directory)
    const service = new AiService(directory)
    const invalidInput = {
      name: 'Invalid Responses verbosity',
      protocol: 'openai-responses',
      endpoint: 'https://responses.example/v1',
      models: [{ model: 'responses-model', capabilities: { responses: { verbosity: 'verbose' } } }],
      apiKey: 'responses-key'
    } as unknown as AiConnectionInput
    await expect(service.saveConnection(invalidInput)).rejects.toThrow('Responses verbosity')
  })

  it('preserves legal Responses text preset fields while applying verbosity', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-responses-text-preset-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Responses text preset',
      protocol: 'openai-responses',
      endpoint: 'https://responses.example/v1',
      models: [{
        model: 'responses-model',
        capabilities: {
          responses: { verbosity: 'high' },
          requestBodyPresets: {
            presets: [{ id: 'text-format', name: 'Text format', body: { text: { format: { type: 'text' } } } }],
            defaultPresetId: 'text-format'
          }
        }
      }],
      apiKey: 'responses-key'
    })
    const fetchMock = vi.fn().mockResolvedValue(response({ id: 'resp-text-preset', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Answer' }] }] }))
    vi.stubGlobal('fetch', fetchMock)
    await service.request({
      requestId: 'responses-text-preset',
      documentId: 'tab:responses-text-preset',
      mode: 'answer',
      prompt: 'Answer.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    expect(body.text).toEqual({ format: { type: 'text' }, verbosity: 'high' })
  })

  it('rebuilds local context once when a stored Responses id is explicitly stale', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-responses-stale-id-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Responses stale id',
      protocol: 'openai-responses',
      endpoint: 'https://responses.example/v1',
      models: [{ model: 'responses-model' }],
      apiKey: 'responses-key'
    })
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: { message: 'previous_response_id is not found', param: 'previous_response_id' } }, 404))
      .mockResolvedValueOnce(response({ id: 'resp-new', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Rebuilt' }] }] }))
    vi.stubGlobal('fetch', fetchMock)
    const modelRef = { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    const result = await service.request({
      requestId: 'responses-stale',
      documentId: 'tab:responses-stale',
      mode: 'answer',
      prompt: 'New question',
      markdown: '# Document',
      messages: [{ id: 'assistant-1', role: 'assistant', mode: 'answer', content: 'Earlier answer', createdAt: 1 }],
      modelRef,
      responsesConversation: { modelRef, previousResponseId: 'resp-old', anchorMessageId: 'assistant-1' }
    })
    expect(result.content).toBe('Rebuilt')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const staleBody = JSON.parse(String(fetchMock.mock.calls[0][1].body))
    const rebuiltBody = JSON.parse(String(fetchMock.mock.calls[1][1].body))
    expect(staleBody.previous_response_id).toBe('resp-old')
    expect(rebuiltBody).not.toHaveProperty('previous_response_id')
    expect(rebuiltBody.input).toHaveLength(2)
    expect(rebuiltBody.input[0].content).toBe('Earlier answer')
  })

  it('merges nested preset JSON and lets user fields override generated fields', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-request-presets-merge-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Nested presets',
      protocol: 'openai-chat-completions',
      endpoint: 'https://nested.example/v1',
      models: [{
        model: 'generated-model',
        capabilities: {
          requestBodyPresets: {
            presets: [{
              id: 'mimo-enabled',
              name: 'Mimo enabled',
              body: {
                model: 'user-model',
                thinking: { type: 'enabled', budget: { mode: 'deep' } },
                messages: [{ role: 'user', content: 'user message' }],
                stream: false,
                stream_options: { extra: true },
                array: [1, 2],
                nullable: null
              }
            }],
            defaultPresetId: 'mimo-enabled'
          }
        }
      }],
      apiKey: 'nested-key'
    })
    const fetchMock = vi.fn().mockResolvedValue(response({ choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await service.request({
      requestId: 'preset-merge',
      documentId: 'tab:preset-merge',
      mode: 'answer',
      prompt: 'Explain this.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.model).toBe('user-model')
    expect(body.thinking).toEqual({ type: 'enabled', budget: { mode: 'deep' } })
    expect(body.messages).toEqual([{ role: 'user', content: 'user message' }])
    expect(body.stream).toBe(false)
    expect(body.stream_options).toEqual({ include_usage: true, extra: true })
    expect(body.array).toEqual([1, 2])
    expect(body.nullable).toBeNull()
  })

  it('uses the final preset stream value for response parsing', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-request-presets-stream-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Non-stream preset',
      protocol: 'openai-chat-completions',
      endpoint: 'https://stream-preset.example/v1',
      models: [{
        model: 'stream-preset-model',
        capabilities: {
          requestBodyPresets: {
            presets: [{ id: 'json', name: 'JSON response', body: { stream: false } }],
            defaultPresetId: 'json'
          }
        }
      }],
      apiKey: 'stream-preset-key'
    })
    const fetchMock = vi.fn().mockResolvedValue(response({ choices: [{ message: { content: 'parsed answer' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.request({
      requestId: 'preset-stream',
      documentId: 'tab:preset-stream',
      mode: 'answer',
      prompt: 'Answer.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(result.content).toBe('parsed answer')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.stream).toBe(false)
    expect(body).not.toHaveProperty('stream_options')
  })

  it('does not send request body presets to the hidden context summary request', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-request-presets-summary-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Summary presets',
      protocol: 'openai-chat-completions',
      endpoint: 'https://summary.example/v1',
      models: [{
        model: 'arbitrary-summary-model',
        capabilities: {
          requestBodyPresets: {
            presets: [{ id: 'high', name: 'High', body: { reasoning_effort: 'high' } }],
            defaultPresetId: 'high'
          }
        }
      }],
      apiKey: 'summary-key'
    })
    await service.setContextMode('summary')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'Answer' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'Memory' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await service.request({
      requestId: 'preset-summary',
      documentId: 'tab:preset-summary',
      mode: 'answer',
      prompt: 'Answer.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).reasoning_effort).toBe('high')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).not.toHaveProperty('reasoning_effort')
  })

  it('returns a custom request body rejection without retrying', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-request-presets-rejection-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Rejecting preset',
      protocol: 'openai-chat-completions',
      endpoint: 'https://reject.example/v1',
      models: [{
        model: 'arbitrary-reject-model',
        capabilities: {
          requestBodyPresets: {
            presets: [{ id: 'custom', name: 'Custom', body: { thinking: { type: 'enabled' } } }],
            defaultPresetId: 'custom'
          }
        }
      }],
      apiKey: 'reject-key'
    })
    const fetchMock = vi.fn().mockResolvedValue(response({ error: { message: 'thinking.type is unsupported' } }, 400))
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.request({
      requestId: 'preset-rejection',
      documentId: 'tab:preset-rejection',
      mode: 'answer',
      prompt: 'Answer.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })).rejects.toThrow('thinking.type is unsupported')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('uses the model default request preset for connection tests', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-request-presets-test-connection-'))
    directories.push(directory)
    const service = new AiService(directory)
    const fetchMock = vi.fn().mockResolvedValue(response({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.testConnection({
      name: 'Test preset',
      protocol: 'openai-chat-completions',
      endpoint: 'https://test-preset.example/v1',
      models: [{
        model: 'test-preset-model',
        capabilities: {
          requestBodyPresets: {
            presets: [{ id: 'enabled', name: 'Enabled', body: { thinking: { type: 'enabled' } } }],
            defaultPresetId: 'enabled'
          }
        }
      }],
      apiKey: 'test-preset-key'
    })

    expect(result.ok).toBe(true)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).thinking).toEqual({ type: 'enabled' })
  })

  it('uses the edit Agent preset for every foreground edit turn', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-edit-agent-preset-'))
    directories.push(directory)
    const service = new AiService(directory)
    const presetConfig = {
      presets: [
        { id: 'enabled', name: 'Thinking enabled', body: { thinking: { type: 'enabled' } } },
        { id: 'disabled', name: 'Thinking disabled', body: { thinking: { type: 'disabled' } } }
      ],
      defaultPresetId: 'enabled' as const,
      editAgentPresetId: 'disabled' as const
    }
    const saved = await service.saveConnection({
      name: 'Edit Agent presets',
      protocol: 'openai-chat-completions',
      endpoint: 'https://edit-agent-preset.example/v1',
      models: [{ model: 'edit-preset-model', capabilities: { requestBodyPresets: presetConfig } }],
      apiKey: 'edit-preset-key'
    })
    const fetchMock = vi.fn(async(_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      const toolName = (body.tools as Array<{ function?: { name?: string } }> | undefined)?.[0]?.function?.name
      const input = toolName === 'create_markdown_edit_plan'
        ? { summary: 'Append notes.', steps: [{ id: 'append', description: 'Append notes.', intent: 'Append notes.', operation: 'append', startAnchor: null, endAnchor: null, dependsOn: [] }] }
        : { markdown: 'Notes', description: 'Appended notes.' }
      return response({ choices: [{ message: { tool_calls: [{ id: `call-${fetchMock.mock.calls.length}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const modelRef = { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    const result = await service.request({
      requestId: 'edit-agent-preset-request',
      documentId: 'tab:edit-agent-preset',
      mode: 'edit',
      prompt: 'Append notes.',
      markdown: 'Existing',
      messages: [],
      modelRef
    })

    expect(result.markdown).toBe('Existing\n\nNotes')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls.map(call => JSON.parse(String(call[1].body)).thinking)).toEqual([
      { type: 'disabled' },
      { type: 'disabled' }
    ])

    await service.saveConnection({
      id: saved.connections[0].id,
      name: 'Edit Agent presets inherited',
      protocol: 'openai-chat-completions',
      endpoint: 'https://edit-agent-preset.example/v1',
      models: [{
        id: saved.connections[0].models[0].id,
        model: 'edit-preset-model',
        capabilities: {
          requestBodyPresets: {
            presets: presetConfig.presets,
            defaultPresetId: 'enabled'
          }
        }
      }]
    })
    fetchMock.mockClear()
    await service.request({
      requestId: 'edit-agent-preset-inherit',
      documentId: 'tab:edit-agent-preset-inherit',
      mode: 'edit',
      prompt: 'Append notes.',
      markdown: 'Existing',
      messages: [],
      modelRef
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body)).thinking).toEqual({ type: 'enabled' })

    await service.saveConnection({
      id: saved.connections[0].id,
      name: 'Edit Agent presets omitted',
      protocol: 'openai-chat-completions',
      endpoint: 'https://edit-agent-preset.example/v1',
      models: [{
        id: saved.connections[0].models[0].id,
        model: 'edit-preset-model',
        capabilities: {
          requestBodyPresets: {
            presets: presetConfig.presets,
            defaultPresetId: 'enabled',
            editAgentPresetId: null
          }
        }
      }]
    })
    fetchMock.mockClear()
    await service.request({
      requestId: 'edit-agent-preset-omit',
      documentId: 'tab:edit-agent-preset-omit',
      mode: 'edit',
      prompt: 'Append notes.',
      markdown: 'Existing',
      messages: [],
      modelRef
    })
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).not.toHaveProperty('thinking')
  })

  it('keeps a truncated native tool response on native transport', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-agent-truncated-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('Native', 'https://native-truncated.example/v1', 'native-truncated-model', 'native-key'))
    let calls = 0
    const requests: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async(_url: string, init: RequestInit) => {
      calls += 1
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      requests.push(body)
      const toolName = (body.tools as Array<{ function?: { name?: string } }> | undefined)?.[0]?.function?.name
      if (calls === 3) return response({ choices: [{ message: { content: '' }, finish_reason: 'length' }] })
      const input = toolName === 'create_markdown_edit_plan'
        ? {
          summary: 'Append notes.',
          steps: [
            { id: 'append', description: 'Append notes.', intent: 'Append notes.', operation: 'append', startAnchor: null, endAnchor: null, dependsOn: [] },
            { id: 'more', description: 'Append more notes.', intent: 'Append more notes.', operation: 'append', startAnchor: null, endAnchor: null, dependsOn: ['append'] }
          ]
        }
        : { markdown: calls === 2 ? 'Notes' : 'More', description: calls === 2 ? 'Appended notes.' : 'Appended more notes.' }
      return response({ choices: [{ message: { tool_calls: [{ id: `call-${calls}`, type: 'function', function: { name: toolName, arguments: JSON.stringify(input) } }] }, finish_reason: 'tool_calls' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.request({
      requestId: 'native-truncated-request',
      documentId: 'tab:native-truncated',
      mode: 'edit',
      prompt: 'Append notes.',
      markdown: 'Existing',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(result.markdown).toBe('Existing\n\nNotes\n\nMore')
    expect(requests).toHaveLength(4)
    expect(requests.every(body => Array.isArray(body.tools))).toBe(true)
    expect(requests.every(body => !JSON.stringify(body).includes('native tool transport is unavailable'))).toBe(true)
  })

  it('does not downgrade edit Agent transport for unrelated provider errors', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-agent-parameter-error-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Parameter error',
      protocol: 'openai-chat-completions',
      endpoint: 'https://agent-parameter-error.example/v1',
      models: [{
        model: 'parameter-error-model',
        capabilities: {
          requestBodyPresets: {
            presets: [{ id: 'thinking', name: 'Thinking', body: { thinking: { type: 'enabled' } } }],
            defaultPresetId: 'thinking'
          }
        }
      }],
      apiKey: 'parameter-error-key'
    })
    const fetchMock = vi.fn().mockResolvedValue(response({ error: { message: 'thinking.type is unsupported' } }, 400))
    vi.stubGlobal('fetch', fetchMock)

    await expect(service.request({
      requestId: 'agent-parameter-error-request',
      documentId: 'tab:agent-parameter-error',
      mode: 'edit',
      prompt: 'Append notes.',
      markdown: 'Existing',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })).rejects.toThrow('thinking.type is unsupported')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('exposes raw edit output before the whole-document fallback', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-failure-output-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('OpenAI', 'https://openai.example/v1', 'failure-model', 'openai-key'))
    await service.setEditAutoRetryCount(0)
    const fetchMock = vi.fn(async(_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages?: Array<{ role?: string; content?: string }> }
      const system = body.messages?.find(message => message.role === 'system')?.content ?? ''
      const content = system.includes('recovering a failed Markdown edit')
        ? '# Fallback title'
        : system.includes('native tool transport is unavailable')
          ? 'raw protocol output'
          : '<think>tool plan</think>raw tool output'
      return response({ choices: [{ message: { content }, finish_reason: 'stop' }] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const progress: Array<{ phase: string; failureCount?: number; failureOutput?: string }> = []

    const result = await service.request({
      requestId: 'failure-output-request',
      documentId: 'tab:failure-output',
      mode: 'edit',
      prompt: 'Update the title.',
      markdown: '# Original title',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    }, event => progress.push({ phase: event.phase, failureCount: event.failureCount, failureOutput: event.failureOutput }))

    expect(result.markdown).toBe('# Fallback title')
    expect(result.recovery?.requiresConfirmation).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(progress).toContainEqual(expect.objectContaining({ phase: 'attempt-failed', failureCount: 2 }))
  })

  it('forces the single strict Agent tool and disables parallel calls', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-strict-agent-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('OpenAI', 'https://openai.example/v1', 'strict-model', 'openai-key'))
    const requests: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async(_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      requests.push(body)
      const tools = body.tools as Array<{ function?: { name?: string } }> | undefined
      const toolName = tools?.[0]?.function?.name
      if (toolName === 'create_markdown_edit_plan') {
        return response({ choices: [{ message: { tool_calls: [{ id: 'plan', type: 'function', function: { name: toolName, arguments: JSON.stringify({ summary: 'Append notes.', steps: [{ id: 'append', description: 'Append notes.', intent: 'Append notes.', operation: 'append', startAnchor: null, endAnchor: null, dependsOn: [] }] }) } }] }, finish_reason: 'tool_calls' }] })
      }
      return response({ choices: [{ message: { tool_calls: [{ id: 'append', type: 'function', function: { name: toolName, arguments: JSON.stringify({ markdown: 'Notes', description: 'Appended notes.' }) } }] }, finish_reason: 'tool_calls' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.request({
      requestId: 'strict-agent-request',
      documentId: 'tab:strict-agent',
      mode: 'edit',
      prompt: 'Append notes.',
      markdown: 'Existing',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(result.markdown).toBe('Existing\n\nNotes')
    expect(requests).toHaveLength(2)
    expect(requests.every(body => body.parallel_tool_calls === false)).toBe(true)
    expect(requests.map(body => (body.tool_choice as { function: { name: string } }).function.name)).toEqual(['create_markdown_edit_plan', 'append_markdown'])
    expect((requests[0].tools as Array<{ function: { strict?: boolean } }>)[0].function.strict).toBe(true)
  })

  it('falls back to a complete JSON envelope when native tool transport is unsupported', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-json-agent-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('Gateway', 'https://gateway.example/v1', 'json-model', 'gateway-key'))
    const requests: Array<Record<string, unknown>> = []
    let jsonCalls = 0
    const fetchMock = vi.fn(async(_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      requests.push(body)
      const tools = body.tools as Array<{ function?: { name?: string } }> | undefined
      const toolName = tools?.[0]?.function?.name
      if (toolName) return response({ error: { message: 'tools unsupported' } }, 422)
      jsonCalls += 1
      const payload = jsonCalls === 1
        ? { summary: 'Append notes.', steps: [{ id: 'append', description: 'Append notes.', intent: 'Append notes.', operation: 'append', startAnchor: null, endAnchor: null, dependsOn: [] }] }
        : { markdown: 'Notes', description: 'Appended notes.' }
      return response({ choices: [{ message: { content: JSON.stringify(payload) }, finish_reason: 'stop' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.request({
      requestId: 'json-agent-request',
      documentId: 'tab:json-agent',
      mode: 'edit',
      prompt: 'Append notes.',
      markdown: 'Existing',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(result.markdown).toBe('Existing\n\nNotes')
    expect(fetchMock).toHaveBeenCalledTimes(4)
    expect(requests[2].tools).toBeUndefined()
    expect(requests[3].tools).toBeUndefined()
  })

  it('discovers models without putting the key in the returned list', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-discovery-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('Provider', 'https://provider.example/v1', 'manual-model', 'secret'))
    const fetchMock = vi.fn().mockResolvedValue(response({ data: [{ id: 'discovered-model', owned_by: 'provider' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const models = await service.listModels({
      connectionId: saved.connections[0].id,
      protocol: 'openai-chat-completions',
      endpoint: 'https://provider.example/v1'
    })
    expect(models).toEqual([{ model: 'discovered-model', ownedBy: 'provider' }])
    expect(fetchMock.mock.calls[0][0]).toBe('https://provider.example/v1/models')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ headers: { authorization: 'Bearer secret' } })
    expect(JSON.stringify(models)).not.toContain('secret')
  })

  it('freezes the selected connection and model for each request', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-routing-'))
    directories.push(directory)
    const service = new AiService(directory)
    const first = await service.saveConnection(connection('Provider A', 'https://a.example/v1', 'model-a', 'key-a'))
    const second = await service.saveConnection(connection('Provider B', 'https://b.example/v1', 'model-b', 'key-b'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'from A' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'from B' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const request = (modelRef: { connectionId: string; modelId: string }): AiRequest => ({
      requestId: `request-${modelRef.modelId}`,
      documentId: 'tab:test',
      mode: 'answer',
      prompt: 'Hello',
      markdown: '# Document',
      messages: [],
      modelRef
    })
    const a = await service.request(request({ connectionId: first.connections[0].id, modelId: first.connections[0].models[0].id }))
    const b = await service.request(request({ connectionId: second.connections[1].id, modelId: second.connections[1].models[0].id }))

    expect(a.model).toMatchObject({ connectionName: 'Provider A', model: 'model-a' })
    expect(b.model).toMatchObject({ connectionName: 'Provider B', model: 'model-b' })
    const firstBody = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    const secondBody = JSON.parse(fetchMock.mock.calls[1][1].body as string)
    expect(firstBody.model).toBe('model-a')
    expect(secondBody.model).toBe('model-b')
    expect(firstBody).not.toHaveProperty('reasoning_effort')
    expect(firstBody).not.toHaveProperty('thinking')
    expect(fetchMock.mock.calls[0][1].headers).toMatchObject({ authorization: 'Bearer key-a' })
    expect(fetchMock.mock.calls[1][1].headers).toMatchObject({ authorization: 'Bearer key-b' })
  })

  it('keeps reasoning controls out of Anthropic requests', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-anthropic-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Anthropic',
      protocol: 'anthropic-messages',
      endpoint: 'https://anthropic.example',
      models: [{ model: 'claude-model', label: 'Claude' }],
      apiKey: 'anthropic-key'
    })
    const fetchMock = vi.fn().mockResolvedValue(response({
      content: [{ type: 'text', text: 'from Anthropic' }],
      stop_reason: 'end_turn'
    }))
    vi.stubGlobal('fetch', fetchMock)

    await service.request({
      requestId: 'anthropic-request',
      documentId: 'tab:anthropic',
      mode: 'answer',
      prompt: 'Hello',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    const requestOptions = fetchMock.mock.calls[0][1]
    const body = JSON.parse(requestOptions.body as string)
    expect(fetchMock.mock.calls[0][0]).toBe('https://anthropic.example/v1/messages')
    expect(requestOptions.headers).toMatchObject({ 'x-api-key': 'anthropic-key' })
    expect(body.model).toBe('claude-model')
    expect(body).not.toHaveProperty('reasoning_effort')
    expect(body).not.toHaveProperty('thinking')
    expect(body).not.toHaveProperty('budget_tokens')
  })

  it('injects the user-configured request preset into Anthropic request bodies too', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-anthropic-request-preset-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Anthropic custom preset',
      protocol: 'anthropic-messages',
      endpoint: 'https://anthropic.example',
      models: [{
        model: 'arbitrary-anthropic-model',
        capabilities: {
          requestBodyPresets: {
            presets: [{ id: 'custom', name: 'Custom', body: { thinking: { type: 'enabled' } } }],
            defaultPresetId: 'custom'
          }
        }
      }],
      apiKey: 'anthropic-key'
    })
    const fetchMock = vi.fn().mockResolvedValue(response({
      content: [{ type: 'text', text: 'from Anthropic' }],
      stop_reason: 'end_turn'
    }))
    vi.stubGlobal('fetch', fetchMock)

    await service.request({
      requestId: 'anthropic-preset-request',
      documentId: 'tab:anthropic-preset',
      mode: 'answer',
      prompt: 'Hello',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string).thinking).toEqual({ type: 'enabled' })
  })

  it('uses the compact output budget for Anthropic summaries', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-summary-anthropic-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Anthropic summary',
      protocol: 'anthropic-messages',
      endpoint: 'https://anthropic.example',
      models: [{ model: 'claude-summary', label: 'Claude summary' }],
      apiKey: 'anthropic-summary-key'
    })
    await service.setContextMode('summary')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ content: [{ type: 'text', text: 'Answer' }], stop_reason: 'end_turn' }))
      .mockResolvedValueOnce(response({ content: [{ type: 'text', text: 'Memory' }], stop_reason: 'end_turn' }))
    vi.stubGlobal('fetch', fetchMock)

    await service.request({
      requestId: 'anthropic-summary-request',
      documentId: 'tab:anthropic-summary',
      mode: 'answer',
      prompt: 'Summarize this.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).max_tokens).toBe(512)
  })

  it('streams answer responses and reports live progress without changing the final response', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-streaming-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('OpenAI', 'https://openai.example/v1', 'stream-model', 'openai-key'))
    const fetchMock = vi.fn().mockResolvedValue(streamResponse([
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":2}}\n\n',
      'data: [DONE]\n\n'
    ]))
    vi.stubGlobal('fetch', fetchMock)
    const progress: Array<{ phase: string; outputTokens: number; outputTokensEstimated: boolean }> = []

    const result = await service.request({
      requestId: 'stream-request',
      documentId: 'tab:stream',
      mode: 'answer',
      prompt: 'Say hello.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    }, event => progress.push({ phase: event.phase, outputTokens: event.outputTokens, outputTokensEstimated: event.outputTokensEstimated }))

    expect(result.content).toBe('Hello')
    expect(progress.some(event => event.phase === 'streaming')).toBe(true)
    expect(progress.at(-1)).toMatchObject({ phase: 'validating', outputTokens: 2, outputTokensEstimated: false })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  it('filters reasoning tags from ordinary JSON responses without a repair request', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-reasoning-json-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'OpenAI-compatible',
      protocol: 'openai-chat-completions',
      endpoint: 'https://openai.example/v1',
      models: [{
        model: 'tag-model',
        label: 'Tag model',
        capabilities: { reasoningTag: 'think' }
      }],
      apiKey: 'openai-key'
    })
    const fetchMock = vi.fn().mockResolvedValue(response({
      choices: [{ message: { content: '<think>Plan the answer.</think>\nVisible answer' }, finish_reason: 'stop' }]
    }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.request({
      requestId: 'reasoning-json-request',
      documentId: 'tab:reasoning-json',
      mode: 'answer',
      prompt: 'Answer briefly.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(result.content).toBe('Visible answer')
    expect(result.reasoning).toBe('Plan the answer.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('falls back from rejected streaming options to a normal JSON response', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-stream-fallback-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('OpenAI', 'https://openai.example/v1', 'fallback-model', 'openai-key'))
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ error: { message: 'stream_options is unsupported' } }, 400))
      .mockResolvedValueOnce(response({ error: { message: 'stream is unsupported' } }, 400))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'Fallback answer' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.request({
      requestId: 'stream-fallback-request',
      documentId: 'tab:stream-fallback',
      mode: 'answer',
      prompt: 'Say hello.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(result.content).toBe('Fallback answer')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.parse(fetchMock.mock.calls[0][1].body as string)).toMatchObject({ stream: true, stream_options: { include_usage: true } })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).toMatchObject({ stream: true })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string)).not.toHaveProperty('stream_options')
    expect(JSON.parse(fetchMock.mock.calls[2][1].body as string)).not.toHaveProperty('stream')
  })

  it('sends locally rendered PDF pages as OpenAI image parts', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-pdf-request-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('OpenAI', 'https://openai.example/v1', 'pdf-model', 'openai-key'))
    const fetchMock = vi.fn().mockResolvedValue(response({ choices: [{ message: { content: 'PDF answer' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)
    const pdfData = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37])
    const pageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

    await service.request({
      requestId: 'pdf-request',
      documentId: 'tab:pdf',
      mode: 'answer',
      prompt: 'Summarize the PDF.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id },
      attachments: [{
        id: 'attachment-pdf-0001',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        byteSize: pdfData.byteLength,
        data: pdfData,
        pages: [1]
      }],
      renderedPdfPages: [{
        attachmentId: 'attachment-pdf-0001',
        pageNumbers: [1],
        pages: [{
          id: 'attachment-page-0001',
          name: 'report.pdf page 1',
          mimeType: 'image/png',
          byteSize: pageData.byteLength,
          data: pageData
        }]
      }]
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.messages[0].content).toContain('rendered pages from a PDF attachment')
    expect(body.messages[1].content[1].text).toContain('Selected pages, in order: 1')
    expect(body.messages[1].content).toEqual([
      expect.objectContaining({ type: 'image_url', image_url: expect.objectContaining({ url: `data:image/png;base64,${Buffer.from(pageData).toString('base64')}` }) }),
      expect.objectContaining({ type: 'text' })
    ])
    expect(JSON.stringify(body)).not.toMatch(/file_data|input_file|application\/pdf/)
    await service.saveChat('tab:pdf', {
      messages: [{
        id: 'message-pdf-0001',
        role: 'user',
        mode: 'answer',
        content: 'Summarize the PDF.',
        createdAt: 1,
        attachments: [{
          id: 'attachment-pdf-0001',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          byteSize: pdfData.byteLength,
          pages: [1]
        }]
      }]
    })
    const storedChat = await readFile(path.join(directory, 'ai-chat.json'), 'utf8').catch(() => '')
    expect(storedChat).not.toContain(Buffer.from(pdfData).toString('base64'))
    expect(JSON.parse(storedChat)['tab:pdf'].messages[0].attachments[0]).toMatchObject({
      name: 'report.pdf',
      mimeType: 'application/pdf',
      pages: [1]
    })
  })

  it('extracts current image context once and reuses only the source brief in Agent turns', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-source-brief-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('OpenAI', 'https://openai.example/v1', 'brief-model', 'openai-key'))
    const imageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const requests: Array<Record<string, unknown>> = []
    const fetchMock = vi.fn(async(_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      requests.push(body)
      const tools = body.tools as Array<{ function?: { name?: string } }> | undefined
      const toolName = tools?.[0]?.function?.name
      if (!toolName) return response({ choices: [{ message: { content: '## Extracted facts\n- SCAN scheduling' }, finish_reason: 'stop' }] })
      if (toolName === 'create_markdown_edit_plan') {
        return response({ choices: [{ message: { tool_calls: [{ id: 'plan', type: 'function', function: { name: toolName, arguments: JSON.stringify({ summary: 'Append facts.', steps: [{ id: 'append', description: 'Append facts.', intent: 'Append extracted facts.', operation: 'append', startAnchor: null, endAnchor: null, dependsOn: [] }] }) } }] }, finish_reason: 'tool_calls' }] })
      }
      return response({ choices: [{ message: { tool_calls: [{ id: 'append', type: 'function', function: { name: toolName, arguments: JSON.stringify({ markdown: '## Notes\n\n- SCAN scheduling', description: 'Appended facts.' }) } }] }, finish_reason: 'tool_calls' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.request({
      requestId: 'source-brief-request',
      documentId: 'tab:source-brief',
      mode: 'edit',
      prompt: 'Turn the image into notes.',
      markdown: '# Existing',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id },
      attachments: [{ id: 'image-brief-0001', name: 'notes.png', mimeType: 'image/png', byteSize: imageData.byteLength, data: imageData }]
    })

    expect(result.markdown).toContain('SCAN scheduling')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(requests[0])).toContain('data:image/png;base64')
    expect(JSON.stringify(requests[1])).not.toContain('data:image/png;base64')
    expect(JSON.stringify(requests[2])).not.toContain('data:image/png;base64')
    expect(JSON.stringify(requests[1])).toContain('Extracted facts')
  })

  it('persists progress entries without sending them to the model', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-progress-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('OpenAI', 'https://openai.example/v1', 'progress-model', 'openai-key'))
    const fetchMock = vi.fn().mockResolvedValue(response({ choices: [{ message: { content: 'Done' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)

    await service.request({
      requestId: 'progress-request',
      documentId: 'tab:progress',
      mode: 'answer',
      prompt: 'Read the document.',
      markdown: '# Document',
      messages: [{
        id: 'progress-status',
        role: 'assistant',
        mode: 'answer',
        content: '',
        createdAt: 1,
        kind: 'status',
        progress: { phase: 'waiting' }
      }, {
        id: 'prior-user',
        role: 'user',
        mode: 'answer',
        content: 'Earlier question',
        createdAt: 2
      }],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.messages).toHaveLength(3)
    expect(JSON.stringify(body)).not.toContain('progress-status')
    await service.saveChat('tab:progress', {
      messages: [{
        id: 'progress-status',
        role: 'assistant',
        mode: 'answer',
        content: '',
        createdAt: 1,
        kind: 'status',
        progress: { phase: 'waiting' }
      }]
    })
    expect((await service.loadChat('tab:progress')).messages[0].progress).toEqual({ phase: 'waiting' })
  })

  it('serializes concurrent chat saves without losing the later session', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-chat-queue-'))
    directories.push(directory)
    const service = new AiService(directory)

    await Promise.all([
      service.saveChat('tab:queue', {
        messages: [{ id: 'queue-user', role: 'user', mode: 'edit', content: 'Add a plan.', createdAt: 1 }]
      }),
      service.saveChat('tab:queue', {
        messages: [{ id: 'queue-completed', role: 'assistant', mode: 'edit', content: 'Completed.', createdAt: 2 }]
      })
    ])

    expect((await service.loadChat('tab:queue')).messages).toEqual([
      expect.objectContaining({ id: 'queue-completed', content: 'Completed.' })
    ])
  })

  it('sends rendered PDF pages to Anthropic as images', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-anthropic-pdf-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection({
      name: 'Anthropic',
      protocol: 'anthropic-messages',
      endpoint: 'https://anthropic.example',
      models: [{ model: 'claude-model', label: 'Claude' }],
      apiKey: 'anthropic-key'
    })
    const fetchMock = vi.fn().mockResolvedValue(response({
      content: [{ type: 'text', text: 'PDF answer' }],
      stop_reason: 'end_turn'
    }))
    vi.stubGlobal('fetch', fetchMock)

    const pageData = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await service.request({
      requestId: 'anthropic-pdf-request',
      documentId: 'tab:anthropic-pdf',
      mode: 'answer',
      prompt: 'Read the PDF.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id },
      attachments: [{
        id: 'attachment-pdf-0002',
        name: 'report.pdf',
        mimeType: 'application/pdf',
        byteSize: 5,
        data: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]),
        pages: [1]
      }],
      renderedPdfPages: [{
        attachmentId: 'attachment-pdf-0002',
        pageNumbers: [1],
        pages: [{
          id: 'attachment-page-0002',
          name: 'report.pdf page 1',
          mimeType: 'image/png',
          byteSize: pageData.byteLength,
          data: pageData
        }]
      }]
    })
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(body.system).toContain('rendered pages from a PDF attachment')
    expect(body.messages[0].content).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: Buffer.from(pageData).toString('base64') } },
      expect.objectContaining({ type: 'text' })
    ])
  })

  it('loads legacy chat arrays and saves selected model metadata', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-chat-migration-'))
    directories.push(directory)
    await writeFile(path.join(directory, 'ai-chat.json'), JSON.stringify({
      'tab:test': [{ id: 'message-1', role: 'user', mode: 'answer', content: 'Hi', createdAt: 1 }]
    }))
    const service = new AiService(directory)
    const loaded = await service.loadChat('tab:test')
    expect(loaded.messages).toHaveLength(1)
    expect(loaded.selectedModel).toBeUndefined()

    await service.saveChat('tab:test', {
      messages: loaded.messages,
      selectedModel: { connectionId: 'connection-a', modelId: 'model-a' },
      requestBodyPresetOverrides: [{
        modelRef: { connectionId: 'connection-a', modelId: 'model-a' },
        presetId: 'preset-high'
      }],
      verbosityOverrides: [{
        modelRef: { connectionId: 'connection-a', modelId: 'model-a' },
        verbosity: null
      }]
    })
    const stored = JSON.parse(await readFile(path.join(directory, 'ai-chat.json'), 'utf8'))
    expect(stored['tab:test']).toMatchObject({
      selectedModel: { connectionId: 'connection-a', modelId: 'model-a' },
      requestBodyPresetOverrides: [{ modelRef: { connectionId: 'connection-a', modelId: 'model-a' }, presetId: 'preset-high' }],
      verbosityOverrides: [{ modelRef: { connectionId: 'connection-a', modelId: 'model-a' }, verbosity: null }]
    })
    expect((await service.loadChat('tab:test')).verbosityOverrides).toEqual([{
      modelRef: { connectionId: 'connection-a', modelId: 'model-a' },
      verbosity: null
    }])
  })

  it('uses only rolling memory in summary context mode and persists it', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-summary-request-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('Summary', 'https://summary.example/v1', 'summary-model', 'summary-key'))
    await service.setContextMode('summary')
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'Current answer' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'Remember the answer.' }, finish_reason: 'stop' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await service.request({
      requestId: 'summary-request',
      documentId: 'tab:summary',
      mode: 'answer',
      prompt: 'Follow up',
      markdown: '# Current document',
      messages: [{ id: 'old', role: 'user', mode: 'answer', content: 'Old image context', createdAt: 1, attachments: [{ id: 'old-image', name: 'old.png', mimeType: 'image/png', byteSize: 10 }] }],
      contextSummary: 'Earlier decision',
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(result.contextSummaryCandidate).toBe('Remember the answer.')
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string)
    expect(JSON.stringify(body)).toContain('Earlier decision')
    expect(JSON.stringify(body)).not.toContain('Old image context')
    expect(JSON.stringify(body)).not.toContain('old-image')
    expect(JSON.parse(fetchMock.mock.calls[1][1].body as string).messages).toHaveLength(2)

    await service.saveChat('tab:summary', { messages: [], contextSummary: result.contextSummaryCandidate })
    expect((await service.loadChat('tab:summary')).contextSummary).toBe('Remember the answer.')
  })

  it('falls back locally when the summary provider response is empty', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-summary-fallback-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('Summary', 'https://summary.example/v1', 'summary-model', 'summary-key'))
    await service.setContextMode('summary')
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'Answer body' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] })))

    const result = await service.request({
      requestId: 'summary-fallback-request',
      documentId: 'tab:summary-fallback',
      mode: 'answer',
      prompt: 'Remember this request.',
      markdown: '# Document',
      messages: [],
      modelRef: { connectionId: saved.connections[0].id, modelId: saved.connections[0].models[0].id }
    })

    expect(result.contextSummaryCandidate).toContain('Remember this request.')
    expect(result.contextSummaryCandidate).toContain('Answer body')
  })
})
