import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AiChatSession, AiConnectionSettings, AiModelRef } from '@shared/types/ai'

const mocks = vi.hoisted(() => {
  const editor = {
    currentFile: { id: 'a', pathname: '', markdown: '' },
    flushActiveEditor: vi.fn()
  }
  const ipcRenderer = {
    invoke: vi.fn(),
    send: vi.fn(),
    on: vi.fn(() => vi.fn()),
    removeAllListeners: vi.fn()
  }
  return {
    editor,
    preferences: { sourceCode: false },
    ipcRenderer,
    bus: { emit: vi.fn() },
    log: { info: vi.fn() }
  }
})

vi.mock('electron-log', () => ({ default: mocks.log }))
vi.mock('@/store/editor', () => ({ useEditorStore: () => mocks.editor }))
vi.mock('@/store/preferences', () => ({ usePreferencesStore: () => mocks.preferences }))
vi.mock('@/bus', () => ({ default: mocks.bus }))
vi.mock('@/store/aiEditSession', () => ({
  aiEditSession: null,
  beginAiEditSession: vi.fn(),
  endAiEditSession: vi.fn(),
  getAiDocumentRevision: vi.fn(() => 0),
  isAiEditLocked: vi.fn(() => false),
  setAiEditSessionStatus: vi.fn()
}))
vi.mock('@/store/aiChangeController', () => ({
  createAiChangeController: () => ({
    currentChangeMarker: undefined,
    getSaveSequence: vi.fn(() => 0),
    getLastSavedSequence: vi.fn(() => 0),
    refreshChangeMarker: vi.fn()
  })
}))
vi.mock('@/store/pdfRendering', () => ({
  defaultPdfPages: vi.fn(() => []),
  formatPdfPageSelection: vi.fn(() => ''),
  getPdfPageCount: vi.fn(),
  parsePdfPageSelection: vi.fn(),
  PdfPageSelectionError: class extends Error {},
  renderPdfPages: vi.fn()
}))

const { useAiStore } = await import('@/store/ai')

const model = (modelId: string, label = modelId) => ({
  id: modelId,
  model: modelId,
  label,
  source: 'manual' as const
})

const settings = (): AiConnectionSettings => ({
  connections: [
    {
      id: 'connection-a',
      name: 'Provider A',
      protocol: 'openai-chat-completions',
      endpoint: 'https://a.example/v1',
      hasApiKey: true,
      models: [model('model-a')]
    },
    {
      id: 'connection-b',
      name: 'Provider B',
      protocol: 'openai-chat-completions',
      endpoint: 'https://b.example/v1',
      hasApiKey: true,
      models: [model('model-b')]
    }
  ],
  defaultModel: { connectionId: 'connection-a', modelId: 'model-a' },
  contextMode: 'recent'
})

const responsesSettings = (): AiConnectionSettings => ({
  connections: [{
    id: 'connection-responses',
    name: 'Responses',
    protocol: 'openai-responses',
    endpoint: 'https://responses.example/v1',
    hasApiKey: true,
    models: [{
      ...model('response-model'),
      capabilities: { responses: { reasoningEffort: 'low', verbosity: 'medium' } }
    }]
  }],
  defaultModel: { connectionId: 'connection-responses', modelId: 'response-model' },
  contextMode: 'recent'
})

const chat = (selectedModel?: AiModelRef): AiChatSession => ({
  messages: [],
  ...(selectedModel ? { selectedModel } : {})
})

describe('AI global model memory', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    mocks.editor.currentFile = { id: 'a', pathname: '', markdown: '' }
    mocks.ipcRenderer.invoke.mockReset()
    mocks.ipcRenderer.invoke.mockResolvedValue(undefined)
    vi.stubGlobal('window', Object.assign(window, {
      electron: { ipcRenderer: mocks.ipcRenderer }
    }))
  })

  it('keeps the selected model when switching documents and clearing chat', async() => {
    const configured = settings()
    const selected: AiModelRef = { connectionId: 'connection-b', modelId: 'model-b' }
    mocks.ipcRenderer.invoke.mockImplementation(async(channel: string, value: unknown) => {
      if (channel === 'mt::ai::chat-load') return chat()
      if (channel === 'mt::ai::set-last-used-model') return { ...configured, lastUsedModel: value }
      return undefined
    })
    const store = useAiStore()
    store.setSettings(configured)

    store.selectModel(selected)
    await Promise.resolve()
    expect(store.selectedModel).toEqual(selected)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mt::ai::set-last-used-model', selected)

    await store.loadChat('tab:a')
    mocks.editor.currentFile = { id: 'b', pathname: '', markdown: '' }
    await store.loadChat('tab:b')
    expect(store.selectedModel).toEqual(selected)

    await store.clearChat()
    expect(store.selectedModel).toEqual(selected)
  })

  it('migrates the first legacy per-document selection into global settings once', async() => {
    const configured = settings()
    const legacySelected: AiModelRef = { connectionId: 'connection-b', modelId: 'model-b' }
    mocks.ipcRenderer.invoke.mockImplementation(async(channel: string) => {
      if (channel === 'mt::ai::chat-load') return chat(legacySelected)
      if (channel === 'mt::ai::set-last-used-model') return { ...configured, lastUsedModel: legacySelected }
      return undefined
    })
    const store = useAiStore()
    store.setSettings(configured)

    await store.loadChat('tab:a')
    expect(store.selectedModel).toEqual(legacySelected)
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mt::ai::set-last-used-model', legacySelected)
  })

  it('keeps the last reasoning effort and verbosity when switching tabs and clearing chat', async() => {
    const configured = responsesSettings()
    mocks.ipcRenderer.invoke.mockImplementation(async(channel: string) => {
      if (channel === 'mt::ai::chat-load') return chat()
      return undefined
    })
    const store = useAiStore()
    store.setSettings(configured)

    store.setReasoningEffort('high')
    store.setVerbosity('low')
    expect(store.reasoningEffortSelection).toBe('high')
    expect(store.verbositySelection).toBe('low')

    await store.loadChat('tab:a')
    mocks.editor.currentFile = { id: 'b', pathname: '', markdown: '' }
    await store.loadChat('tab:b')
    expect(store.reasoningEffortSelection).toBe('high')
    expect(store.verbositySelection).toBe('low')

    await store.clearChat()
    expect(store.reasoningEffortSelection).toBe('high')
    expect(store.verbositySelection).toBe('low')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mt::ai::set-last-used-reasoning-effort', 'high')
    expect(mocks.ipcRenderer.invoke).toHaveBeenCalledWith('mt::ai::set-last-used-verbosity', 'low')
  })
})
