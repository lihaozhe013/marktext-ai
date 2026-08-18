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
  text: async() => JSON.stringify(payload)
} as Response)

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
})
