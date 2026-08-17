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
