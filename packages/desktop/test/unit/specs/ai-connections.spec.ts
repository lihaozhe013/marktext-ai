import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import os from 'os'
import path from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiConnectionInput, AiRequest } from '@shared/types/ai'

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

  it('exposes raw edit output before the whole-document fallback', async() => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'marktext-ai-failure-output-'))
    directories.push(directory)
    const service = new AiService(directory)
    const saved = await service.saveConnection(connection('OpenAI', 'https://openai.example/v1', 'failure-model', 'openai-key'))
    await service.setEditAutoRetryCount(0)
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ choices: [{ message: { content: '<think>tool plan</think>raw tool output' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: 'raw protocol output' }, finish_reason: 'stop' }] }))
      .mockResolvedValueOnce(response({ choices: [{ message: { content: '# Fallback title' }, finish_reason: 'stop' }] }))
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
      selectedModel: { connectionId: 'connection-a', modelId: 'model-a' }
    })
    const stored = JSON.parse(await readFile(path.join(directory, 'ai-chat.json'), 'utf8'))
    expect(stored['tab:test']).toMatchObject({ selectedModel: { connectionId: 'connection-a', modelId: 'model-a' } })
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
