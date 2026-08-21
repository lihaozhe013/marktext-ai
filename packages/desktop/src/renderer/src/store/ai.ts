import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import log from 'electron-log'
import bus from '../bus'
import { useEditorStore } from './editor'
import { usePreferencesStore } from './preferences'
import {
  aiEditSession,
  beginAiEditSession,
  endAiEditSession,
  getAiDocumentRevision,
  isAiEditLocked,
  setAiEditSessionStatus,
  type AiEditorSurface
} from './aiEditSession'
import type { AiApplyPayload } from './aiEditorBridge'
import type {
  AiChatMessage,
  AiChatSession,
  AiAttachment,
  AiAttachmentUpload,
  AiConnectionSettings,
  AiEditSummary,
  AiImageMimeType,
  AiPdfMimeType,
  AiInteractionMode,
  AiMessageModel,
  AiPreparedRevision,
  AiModelRef,
  AiRequestBodyPresetOverride,
  AiProgressEvent,
  AiProgressInfo,
  AiProgressPhase,
  AiResponse,
  AiRenderedPdfPages
} from '@shared/types/ai'
import {
  AI_IMAGE_MIME_TYPES,
  AI_MAX_IMAGE_BYTES,
  AI_MAX_IMAGE_COUNT,
  AI_MAX_IMAGE_TOTAL_BYTES,
  AI_MAX_PDF_BYTES,
  AI_MAX_PDF_TOTAL_BYTES,
  AI_PDF_MIME_TYPES
} from '@shared/types/ai'
import { AiChangeTracker, rangesFromSummary, fullDocumentRange } from './aiChangeTracker'
import { createAiChangeController } from './aiChangeController'
import { createAiChatPersistenceQueue } from './aiChatPersistence'
import { toIpcChatMessages } from './aiChatSerialization'
import {
  defaultPdfPages,
  formatPdfPageSelection,
  getPdfPageCount,
  parsePdfPageSelection,
  PdfPageSelectionError,
  renderPdfPages
} from './pdfRendering'

export type AiAttachmentError = '' | 'unsupported' | 'too-large' | 'pdf-too-large' | 'too-many' | 'total-too-large' | 'read-failed' | 'pdf-pages-required' | 'pdf-invalid-pages' | 'pdf-render-failed' | 'render-too-large'

export interface PendingAiAttachment {
  attachment: AiAttachment
  data: Uint8Array
  pdfPageCount?: number
  pdfPageSelection?: string
}

/** Compatibility alias for renderer callers that still use the image-only name. */
export type PendingAiImage = PendingAiAttachment

export interface PendingAiRecovery {
  requestId: string
  response: AiResponse
  tabId: string
  beforeMarkdown: string
  surface: AiEditorSurface
}

const createId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

const normalizeDocumentId = (id: string, pathname: string): string => {
  if (pathname) return `path:${pathname}`
  return `tab:${id}`
}

const documentIdentityKind = (documentId: string): 'path' | 'tab' | 'unknown' => {
  if (documentId.startsWith('path:')) return 'path'
  if (documentId.startsWith('tab:')) return 'tab'
  return 'unknown'
}

const featureLog = (message: string, ...args: unknown[]): void => {
  log.info(`[ai-editor] ${message}`, ...args)
}

const MIME_BY_EXTENSION: Record<string, AiAttachment['mimeType']> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf'
}

const MAX_STORED_CHAT_MESSAGES = 100

const resolveAttachmentMimeType = (file: File): AiAttachment['mimeType'] | undefined => {
  if (AI_IMAGE_MIME_TYPES.includes(file.type as AiImageMimeType)) return file.type as AiImageMimeType
  if (AI_PDF_MIME_TYPES.includes(file.type as AiPdfMimeType)) return file.type as AiPdfMimeType
  const extension = file.name.slice(file.name.lastIndexOf('.')).toLowerCase()
  return MIME_BY_EXTENSION[extension]
}

export const useAiStore = defineStore('ai', () => {
  const editorStore = useEditorStore()
  const preferencesStore = usePreferencesStore()
  const settings = ref<AiConnectionSettings>({
    connections: [],
    contextMode: 'recent'
  })
  const mode = ref<AiInteractionMode>((localStorage.getItem('ai-mode') as AiInteractionMode) || 'answer')
  const visible = ref(localStorage.getItem('ai-panel-visible') !== 'false')
  const width = ref(Number(localStorage.getItem('ai-panel-width')) || 380)
  const messages = ref<AiChatMessage[]>([])
  const contextSummary = ref<string | undefined>()
  const selectedModel = ref<AiModelRef | undefined>()
  const requestBodyPresetOverrides = ref<AiRequestBodyPresetOverride[]>([])
  const pendingAttachments = ref<PendingAiAttachment[]>([])
  const attachmentError = ref<AiAttachmentError>('')
  const loading = ref(false)
  const renderingPdf = ref(false)
  const error = ref('')
  const lastAnswer = ref('')
  const pendingRevision = ref<AiPreparedRevision | null>(null)
  const pendingRecovery = ref<PendingAiRecovery | null>(null)
  const activeRequestId = ref<string | null>(null)
  const activeDocumentId = ref('')
  // Requests in this set have already changed the editor one validated step at
  // a time. Their final response only carries the summary; it must not replay
  // the complete document through the transactional apply path.
  const progressiveEditRequests = new Set<string>()
  const progressiveFinalizedRequests = new Set<string>()
  const expectedAgentMarkdown = new Map<string, string>()
  const changeTracker = new AiChangeTracker()
  const changeVersion = ref(0)
  let chatLoadSequence = 0
  let loadedChatDocumentId = ''
  const chatPersistence = createAiChatPersistenceQueue(error => {
    featureLog('chat save failed reason=%s', error instanceof Error ? error.message : String(error))
  })

  const modelRefKey = (value: AiModelRef | undefined): string => value
    ? JSON.stringify(value)
    : ''

  const modelOptions = computed(() => settings.value.connections.flatMap(connection => connection.models.map(model => ({
    ref: { connectionId: connection.id, modelId: model.id },
    connectionId: connection.id,
    connectionName: connection.name,
    modelId: model.id,
    model: model.model,
    label: model.label,
    protocol: connection.protocol,
    hasApiKey: connection.hasApiKey,
    requestBodyPresets: model.capabilities?.requestBodyPresets
  }))))
  const hasAnyApiKey = computed(() => settings.value.connections.some(connection => connection.hasApiKey))

  const isValidModelRef = (value: AiModelRef | undefined): value is AiModelRef =>
    !!value && modelOptions.value.some(option => option.ref.connectionId === value.connectionId && option.ref.modelId === value.modelId)

  const pruneRequestBodyPresetOverrides = (): void => {
    requestBodyPresetOverrides.value = requestBodyPresetOverrides.value.filter((override) => {
      const option = modelOptions.value.find(item => modelRefKey(item.ref) === modelRefKey(override.modelRef))
      return !!option && !!option.requestBodyPresets && (override.presetId === null || option.requestBodyPresets.presets.some(preset => preset.id === override.presetId))
    })
  }

  const requestBodyPresetOverrideFor = (modelRef: AiModelRef | undefined): string | null | undefined => {
    if (!modelRef) return undefined
    return requestBodyPresetOverrides.value.find(item => modelRefKey(item.modelRef) === modelRefKey(modelRef))?.presetId
  }

  const selectedModelOption = computed(() =>
    modelOptions.value.find(option => modelRefKey(option.ref) === modelRefKey(selectedModel.value))
  )
  const selectedRequestBodyPresets = computed(() => selectedModelOption.value?.requestBodyPresets)
  const requestBodyPresetSelection = computed(() => {
    const override = requestBodyPresetOverrideFor(selectedModel.value)
    if (override === undefined) return '__model_default__'
    return override === null ? '__omit__' : override
  })

  const setRequestBodyPreset = (selection: string): void => {
    const modelRef = selectedModel.value
    if (!modelRef || !selectedRequestBodyPresets.value) return
    requestBodyPresetOverrides.value = requestBodyPresetOverrides.value.filter(item => modelRefKey(item.modelRef) !== modelRefKey(modelRef))
    if (selection === '__model_default__') {
      saveChat().catch(err => featureLog('request body preset save failed reason=%s', err instanceof Error ? err.message : String(err)))
      return
    }
    const presetId = selection === '__omit__' ? null : selection
    if (presetId !== null && !selectedRequestBodyPresets.value.presets.some(preset => preset.id === presetId)) return
    requestBodyPresetOverrides.value.push({ modelRef: { ...modelRef }, presetId })
    saveChat().catch(err => featureLog('request body preset save failed reason=%s', err instanceof Error ? err.message : String(err)))
  }

  const resolveSelectedModel = (): AiModelRef | undefined => {
    if (isValidModelRef(selectedModel.value)) return { ...selectedModel.value }
    const fallback = settings.value.defaultModel
    if (isValidModelRef(fallback)) {
      selectedModel.value = { ...fallback }
      return { ...fallback }
    }
    const first = modelOptions.value[0]?.ref
    selectedModel.value = first ? { ...first } : undefined
    return first ? { ...first } : undefined
  }

  const clearPendingAttachments = (): void => {
    pendingAttachments.value = []
  }

  const addAttachmentFiles = async(files: readonly File[]): Promise<void> => {
    attachmentError.value = ''
    let rejected: AiAttachmentError = ''
    const available = AI_MAX_IMAGE_COUNT - pendingAttachments.value.length
    if (files.length > available) rejected = 'too-many'
    const selected = files.slice(0, Math.max(0, available))
    let totalBytes = pendingAttachments.value.reduce((total, item) => total + item.attachment.byteSize, 0)
    for (const file of selected) {
      const mimeType = resolveAttachmentMimeType(file)
      if (!mimeType) {
        rejected = rejected || 'unsupported'
        continue
      }
      const maxBytes = mimeType === 'application/pdf' ? AI_MAX_PDF_BYTES : AI_MAX_IMAGE_BYTES
      if (file.size <= 0 || file.size > maxBytes) {
        rejected = rejected || (mimeType === 'application/pdf' ? 'pdf-too-large' : 'too-large')
        continue
      }
      const totalLimit = mimeType === 'application/pdf' ? AI_MAX_PDF_TOTAL_BYTES : AI_MAX_IMAGE_TOTAL_BYTES
      if (totalBytes + file.size > totalLimit) {
        rejected = rejected || 'total-too-large'
        continue
      }
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        let pdfPageCount: number | undefined
        let pdfPageSelection: string | undefined
        if (mimeType === 'application/pdf') {
          pdfPageCount = await getPdfPageCount(data)
          const pages = defaultPdfPages(pdfPageCount)
          pdfPageSelection = pages.length ? formatPdfPageSelection(pages) : ''
        }
        const attachment: AiAttachment = {
          id: createId(),
          name: file.name || (mimeType === 'application/pdf' ? 'document.pdf' : 'image'),
          mimeType,
          byteSize: data.byteLength,
          ...(mimeType === 'application/pdf' && pdfPageCount !== undefined && pdfPageCount <= AI_MAX_IMAGE_COUNT
            ? { pages: defaultPdfPages(pdfPageCount) }
            : {})
        }
        pendingAttachments.value.push({ attachment, data, pdfPageCount, pdfPageSelection })
        totalBytes += data.byteLength
      } catch (error) {
        if (mimeType === 'application/pdf' && error instanceof Error) rejected = rejected || 'pdf-render-failed'
        else rejected = rejected || 'read-failed'
      }
    }
    attachmentError.value = rejected
  }

  const addImageFiles = addAttachmentFiles

  const removePendingAttachment = (id: string): void => {
    pendingAttachments.value = pendingAttachments.value.filter(item => item.attachment.id !== id)
  }

  const setPendingPdfPageSelection = (id: string, value: string): void => {
    const item = pendingAttachments.value.find(candidate => candidate.attachment.id === id)
    if (!item || item.attachment.mimeType !== 'application/pdf') return
    item.pdfPageSelection = value
    item.attachment = { ...item.attachment, pages: undefined }
    attachmentError.value = ''
  }

  const currentDocumentId = computed(() => {
    const file = editorStore.currentFile
    return file ? normalizeDocumentId(file.id, file.pathname) : ''
  })

  const changeController = createAiChangeController({
    tracker: changeTracker,
    changeVersion,
    getCurrentTabId: () => editorStore.currentFile?.id,
    getSession: () => aiEditSession.value,
    getExpectedMarkdown: requestId => expectedAgentMarkdown.get(requestId),
    markSessionStale: requestId => setAiEditSessionStatus(requestId, 'stale')
  })
  const {
    currentChangeMarker,
    getSaveSequence,
    getLastSavedSequence,
    refreshChangeMarker
  } = changeController

  const setVisible = (value: boolean): void => {
    visible.value = value
    localStorage.setItem('ai-panel-visible', String(value))
  }

  const togglePanel = (): void => setVisible(!visible.value)

  const setMode = (value: AiInteractionMode): void => {
    mode.value = value
    localStorage.setItem('ai-mode', value)
    error.value = ''
  }

  const setWidth = (value: number): void => {
    width.value = Math.max(320, Math.min(520, Math.round(value)))
    localStorage.setItem('ai-panel-width', String(width.value))
  }

  const navigateToChange = (line: number): void => {
    const tabId = editorStore.currentFile?.id
    if (!tabId || !Number.isFinite(line)) return
    bus.emit('ai-navigate-to-line', { tabId, line: Math.max(1, Math.round(line)) })
  }

  const setSettings = (value: AiConnectionSettings): void => {
    settings.value = value
    pruneRequestBodyPresetOverrides()
    if (!isValidModelRef(selectedModel.value)) resolveSelectedModel()
  }

  const selectModel = (value: AiModelRef): void => {
    if (!isValidModelRef(value)) return
    selectedModel.value = { ...value }
    saveChat().catch(err => featureLog('model selection save failed reason=%s', err instanceof Error ? err.message : String(err)))
  }

  const setDefaultModel = async(value: AiModelRef | null): Promise<AiConnectionSettings> => {
    const next = await window.electron.ipcRenderer.invoke('mt::ai::set-default-model', value)
    setSettings(next)
    return next
  }

  const loadSettings = async(): Promise<void> => {
    try {
      setSettings(await window.electron.ipcRenderer.invoke('mt::ai::get-settings'))
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  const loadChat = async(documentId: string = currentDocumentId.value): Promise<void> => {
    if (!documentId || (documentId === activeDocumentId.value && loadedChatDocumentId === documentId)) return
    const loadSequence = ++chatLoadSequence
    activeDocumentId.value = documentId
    try {
      const loadedSession: AiChatSession = await window.electron.ipcRenderer.invoke('mt::ai::chat-load', documentId)
      if (loadSequence !== chatLoadSequence || documentId !== currentDocumentId.value) return
      messages.value = loadedSession.messages
      contextSummary.value = loadedSession.contextSummary
      requestBodyPresetOverrides.value = loadedSession.requestBodyPresetOverrides ?? []
      pruneRequestBodyPresetOverrides()
      selectedModel.value = loadedSession.selectedModel
      resolveSelectedModel()
      loadedChatDocumentId = documentId
    } catch (err) {
      if (loadSequence !== chatLoadSequence || documentId !== currentDocumentId.value) return
      error.value = err instanceof Error ? err.message : String(err)
      messages.value = []
      contextSummary.value = undefined
      requestBodyPresetOverrides.value = []
      resolveSelectedModel()
      loadedChatDocumentId = documentId
    }
  }

  const enqueueChatPersistence = (operation: () => Promise<void>): Promise<void> => {
    return chatPersistence.enqueue(operation)
  }

  const saveChat = (): Promise<void> => {
    const documentId = activeDocumentId.value
    if (!documentId) return Promise.resolve()
    const session: AiChatSession = {
      messages: toIpcChatMessages(messages.value.slice(-MAX_STORED_CHAT_MESSAGES)),
      selectedModel: selectedModel.value ? { ...selectedModel.value } : undefined,
      requestBodyPresetOverrides: requestBodyPresetOverrides.value.map(item => ({ modelRef: { ...item.modelRef }, presetId: item.presetId })),
      contextSummary: contextSummary.value
    }
    return enqueueChatPersistence(() => window.electron.ipcRenderer.invoke('mt::ai::chat-save', documentId, session))
  }

  const clearChat = async(): Promise<void> => {
    clearPendingAttachments()
    messages.value = []
    contextSummary.value = undefined
    requestBodyPresetOverrides.value = []
    selectedModel.value = resolveSelectedModel()
    lastAnswer.value = ''
    currentProgress.value = undefined
    attachmentError.value = ''
    if (pendingRecovery.value) {
      endAiEditSession(pendingRecovery.value.requestId)
    }
    pendingRecovery.value = null
    if (activeDocumentId.value) {
      const documentId = activeDocumentId.value
      await enqueueChatPersistence(() => window.electron.ipcRenderer.invoke('mt::ai::chat-clear', documentId))
    }
  }

  const appendMessage = (
    role: 'user' | 'assistant',
    content: string,
    messageMode: AiInteractionMode,
    options: {
      revisionId?: string
      editSummary?: AiEditSummary
      attachments?: AiAttachment[]
      model?: AiMessageModel
      reasoning?: string
      kind?: AiChatMessage['kind']
      progress?: AiProgressInfo
    } = {}
  ): void => {
    messages.value.push({
      id: createId(),
      role,
      mode: messageMode,
      content,
      createdAt: Date.now(),
      ...options
    })
    const retainedMessages = messages.value.slice(-MAX_STORED_CHAT_MESSAGES)
    messages.value = retainedMessages
  }

  const currentProgress = ref<AiProgressInfo | undefined>()
  const liveProgress = ref<AiProgressEvent | undefined>()
  const liveProgressElapsedMs = ref(0)
  let liveProgressStartedAt = 0
  let liveProgressTimer: ReturnType<typeof setInterval> | undefined
  let progressPersistSequence: Promise<void> = Promise.resolve()

  const stopLiveProgress = (): void => {
    if (liveProgressTimer) clearInterval(liveProgressTimer)
    liveProgressTimer = undefined
    liveProgressStartedAt = 0
    liveProgressElapsedMs.value = 0
    liveProgress.value = undefined
  }

  const startLiveProgress = (requestId: string, requestMode: AiInteractionMode): void => {
    stopLiveProgress()
    liveProgressStartedAt = Date.now()
    liveProgress.value = {
      requestId,
      mode: requestMode,
      phase: 'waiting',
      attempt: 1,
      elapsedMs: 0,
      outputTokens: 0,
      outputTokensEstimated: true,
      streaming: false
    }
    liveProgressTimer = setInterval(() => {
      if (!liveProgressStartedAt || !liveProgress.value) return
      liveProgressElapsedMs.value = Date.now() - liveProgressStartedAt
    }, 1000)
  }

  const applyAgentStep = (event: AiProgressEvent): void => {
    if (
      event.phase !== 'agent-step' ||
      typeof event.documentId !== 'string' ||
      typeof event.stepBaseMarkdown !== 'string' ||
      typeof event.stepMarkdown !== 'string'
    ) return
    const session = aiEditSession.value
    const currentFile = editorStore.currentFile
    if (
      !session ||
      session.requestId !== event.requestId ||
      session.documentId !== event.documentId ||
      session.status === 'stale' ||
      !currentFile ||
      currentFile.id !== session.tabId ||
      (!progressiveEditRequests.has(event.requestId) && currentFile.markdown !== event.stepBaseMarkdown)
    ) {
      setAiEditSessionStatus(event.requestId, 'stale')
      window.electron.ipcRenderer.send('mt::ai::cancel', event.requestId)
      return
    }
    if (!setAiEditSessionStatus(event.requestId, 'applying')) return
    expectedAgentMarkdown.set(event.requestId, event.stepMarkdown)
    let settled = false
    const onApplied = (success: boolean, appliedMarkdown?: string): void => {
      if (settled) return
      settled = true
      if (!success) {
        setAiEditSessionStatus(event.requestId, 'stale')
        window.electron.ipcRenderer.send('mt::ai::cancel', event.requestId)
        return
      }
      progressiveEditRequests.add(event.requestId)
      if (typeof appliedMarkdown === 'string') expectedAgentMarkdown.set(event.requestId, appliedMarkdown)
      setAiEditSessionStatus(event.requestId, 'running')
    }
    bus.emit('ai-apply-markdown', {
      tabId: session.tabId,
      surface: session.surface,
      mode: 'edit',
      beforeMarkdown: event.stepBaseMarkdown,
      markdown: event.stepMarkdown,
      onApplied
    } satisfies AiApplyPayload)
    queueMicrotask(() => {
      if (settled) return
      settled = true
      setAiEditSessionStatus(event.requestId, 'stale')
      window.electron.ipcRenderer.send('mt::ai::cancel', event.requestId)
    })
  }

  const listenForProgress = (): (() => void) => window.electron.ipcRenderer.on('mt::ai::progress', (_event, event) => {
    if (!activeRequestId.value || event.requestId !== activeRequestId.value) return
    if (!liveProgressStartedAt) liveProgressStartedAt = Date.now() - event.elapsedMs
    liveProgress.value = event
    liveProgressElapsedMs.value = Math.max(event.elapsedMs, Date.now() - liveProgressStartedAt)
    applyAgentStep(event)
    if (!['attachment-extracting', 'agent-plan', 'agent-step', 'attempt-failed', 'retrying', 'fallback', 'compacting', 'partial', 'failed', 'cancelled'].includes(event.phase)) return
    const progress: AiProgressInfo = {
      phase: event.phase,
      attempt: event.attempt,
      elapsedMs: event.elapsedMs,
      outputTokens: event.outputTokens,
      outputTokensEstimated: event.outputTokensEstimated,
      inputTokens: event.inputTokens,
      inputTokensEstimated: event.inputTokensEstimated,
      totalInputTokens: event.totalInputTokens,
      totalOutputTokens: event.totalOutputTokens,
      totalCachedInputTokens: event.totalCachedInputTokens,
      totalCacheWriteInputTokens: event.totalCacheWriteInputTokens,
      failureCount: event.failureCount,
      failureOutput: event.failureOutput,
      failureOutputTruncated: event.failureOutputTruncated,
      failureReason: event.failureReason,
      step: event.step,
      maxSteps: event.maxSteps,
      successfulSteps: event.successfulSteps,
      toolFailures: event.toolFailures,
      documentVersion: event.documentVersion,
      stepDescription: event.stepDescription,
      planSummary: event.planSummary,
      planStepCount: event.planStepCount,
      planStepDescriptions: event.planStepDescriptions,
      planRevisionCount: event.planRevisionCount,
      currentPlanStep: event.currentPlanStep,
      stepAddedLines: event.stepAddedLines,
      stepRemovedLines: event.stepRemovedLines,
      stepRemovedText: event.stepRemovedText,
      stepAddedText: event.stepAddedText,
      cachedInputTokens: event.cachedInputTokens,
      cacheWriteInputTokens: event.cacheWriteInputTokens
    }
    enqueueProgress(event.phase, progress)
  })

  const appendProgress = async(
    phase: AiProgressPhase,
    details: Partial<Pick<AiProgressInfo, 'current' | 'total' | 'attempt' | 'elapsedMs' | 'outputTokens' | 'outputTokensEstimated' | 'inputTokens' | 'inputTokensEstimated' | 'totalInputTokens' | 'totalOutputTokens' | 'totalCachedInputTokens' | 'totalCacheWriteInputTokens' | 'failureReason' | 'failureCount' | 'failureOutput' | 'failureOutputTruncated' | 'step' | 'maxSteps' | 'successfulSteps' | 'toolFailures' | 'documentVersion' | 'stepDescription' | 'stepAddedLines' | 'stepRemovedLines' | 'stepRemovedText' | 'stepAddedText' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'planSummary' | 'planStepCount' | 'planStepDescriptions' | 'planRevisionCount' | 'currentPlanStep'>> = {}
  ): Promise<void> => {
    const progress: AiProgressInfo = { phase, ...details }
    currentProgress.value = progress
    appendMessage('assistant', '', 'answer', { kind: 'status', progress })
    await saveChat()
  }

  const enqueueProgress = (
    phase: AiProgressPhase,
    details: Partial<Pick<AiProgressInfo, 'current' | 'total' | 'attempt' | 'elapsedMs' | 'outputTokens' | 'outputTokensEstimated' | 'inputTokens' | 'inputTokensEstimated' | 'totalInputTokens' | 'totalOutputTokens' | 'totalCachedInputTokens' | 'totalCacheWriteInputTokens' | 'failureReason' | 'failureCount' | 'failureOutput' | 'failureOutputTruncated' | 'step' | 'maxSteps' | 'successfulSteps' | 'toolFailures' | 'documentVersion' | 'stepDescription' | 'stepAddedLines' | 'stepRemovedLines' | 'stepRemovedText' | 'stepAddedText' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'planSummary' | 'planStepCount' | 'planStepDescriptions' | 'planRevisionCount' | 'currentPlanStep'>> = {}
  ): Promise<void> => {
    progressPersistSequence = progressPersistSequence
      .then(() => appendProgress(phase, details))
      .catch(error => {
        featureLog('progress persistence failed phase=%s reason=%s', phase, error instanceof Error ? error.message : String(error))
      })
    return progressPersistSequence
  }

  const finalProgressDetails = (): Partial<AiProgressInfo> => {
    const progress = liveProgress.value
    if (!progress) return {}
    return {
      attempt: progress.attempt,
      elapsedMs: progress.elapsedMs,
      outputTokens: progress.outputTokens,
      outputTokensEstimated: progress.outputTokensEstimated,
      inputTokens: progress.inputTokens,
      inputTokensEstimated: progress.inputTokensEstimated,
      totalInputTokens: progress.totalInputTokens,
      totalOutputTokens: progress.totalOutputTokens,
      totalCachedInputTokens: progress.totalCachedInputTokens,
      totalCacheWriteInputTokens: progress.totalCacheWriteInputTokens,
      step: progress.step,
      maxSteps: progress.maxSteps,
      successfulSteps: progress.successfulSteps,
      toolFailures: progress.toolFailures,
      documentVersion: progress.documentVersion,
      stepDescription: progress.stepDescription,
      stepAddedLines: progress.stepAddedLines,
      stepRemovedLines: progress.stepRemovedLines,
      stepRemovedText: progress.stepRemovedText,
      stepAddedText: progress.stepAddedText,
      cachedInputTokens: progress.cachedInputTokens,
      cacheWriteInputTokens: progress.cacheWriteInputTokens,
      failureCount: progress.failureCount,
      failureOutput: progress.failureOutput,
      failureOutputTruncated: progress.failureOutputTruncated
    }
  }

  const preparePendingPdfSelections = async(pending: PendingAiAttachment[]): Promise<void> => {
    for (const item of pending) {
      if (item.attachment.mimeType !== 'application/pdf') continue
      const pageCount = item.pdfPageCount ?? await getPdfPageCount(item.data)
      const input = item.pdfPageSelection?.trim() ?? ''
      const pages = input
        ? parsePdfPageSelection(input, pageCount)
        : defaultPdfPages(pageCount)
      if (!pages.length) throw new PdfPageSelectionError('Select PDF pages before sending.')
      item.pdfPageCount = pageCount
      item.pdfPageSelection = formatPdfPageSelection(pages)
      item.attachment = { ...item.attachment, pages }
    }
  }

  const prepareRenderedPdfPages = async(
    documentId: string,
    contextMessages: readonly AiChatMessage[],
    pending: PendingAiAttachment[],
    onPageRendered?: (current: number, total: number) => Promise<void>
  ): Promise<AiRenderedPdfPages[]> => {
    const currentById = new Map(pending.map(item => [item.attachment.id, item]))
    const ordered: AiAttachment[] = pending.map(item => item.attachment)
    for (let index = contextMessages.length - 1; index >= 0; index -= 1) {
      for (const attachment of contextMessages[index].attachments ?? []) ordered.push(attachment)
    }
    const seen = new Set<string>()
    const rendered: AiRenderedPdfPages[] = []
    let mediaCount = 0
    let renderedBytes = 0
    const pdfPageTotal = ordered.reduce((total, attachment) => {
      if (attachment.mimeType !== 'application/pdf') return total
      const pendingItem = currentById.get(attachment.id)
      const pendingPages = pendingItem?.attachment.mimeType === 'application/pdf'
        ? pendingItem.attachment.pages?.length
        : undefined
      return total + (attachment.pages?.length ?? pendingPages ?? 0)
    }, 0)
    let renderedPdfPageCount = 0
    for (const attachment of ordered) {
      if (seen.has(attachment.id)) continue
      seen.add(attachment.id)
      if (attachment.mimeType !== 'application/pdf') {
        if (mediaCount >= AI_MAX_IMAGE_COUNT) {
          if (currentById.has(attachment.id)) throw new PdfPageSelectionError(`The request can contain at most ${AI_MAX_IMAGE_COUNT} images, including PDF pages.`)
          continue
        }
        mediaCount += 1
        continue
      }
      const pendingItem = currentById.get(attachment.id)
      let data = pendingItem?.data
      if (!data) {
        const stored = await window.electron.ipcRenderer.invoke('mt::ai::attachment-read', documentId, attachment.id)
        if (stored.mimeType !== 'application/pdf') throw new Error('The stored PDF attachment has an invalid format.')
        data = stored.data
      }
      const pageCount = pendingItem?.pdfPageCount ?? await getPdfPageCount(data)
      const pages = attachment.pages?.length
        ? attachment.pages
        : defaultPdfPages(pageCount)
      if (!pages.length) {
        if (pendingItem) throw new PdfPageSelectionError('Select PDF pages before sending.')
        throw new PdfPageSelectionError('A historical PDF has no saved page selection. Reattach it before sending.')
      }
      if (mediaCount + pages.length > AI_MAX_IMAGE_COUNT) {
        if (pendingItem) throw new PdfPageSelectionError(`The request can contain at most ${AI_MAX_IMAGE_COUNT} images, including PDF pages.`)
        continue
      }
      const result = await renderPdfPages(data, pages, attachment.name, async() => {
        renderedPdfPageCount += 1
        await onPageRendered?.(renderedPdfPageCount, pdfPageTotal)
      })
      const pageBytes = result.pages.reduce((total, page) => total + page.byteSize, 0)
      if (renderedBytes + pageBytes > AI_MAX_IMAGE_TOTAL_BYTES) {
        if (pendingItem) throw new Error('Rendered PDF pages exceed the 30 MB request limit.')
        continue
      }
      renderedBytes += pageBytes
      mediaCount += result.pages.length
      rendered.push({ attachmentId: attachment.id, pageNumbers: [...pages], pages: result.pages })
    }
    return rendered
  }

  const submit = async(prompt: string): Promise<void> => {
    const file = editorStore.currentFile
    const value = prompt.trim()
    if (!file || !value || loading.value || pendingRecovery.value || isAiEditLocked()) return
    editorStore.flushActiveEditor()
    const requestFile = editorStore.currentFile
    if (!requestFile) return
    const requestTabId = requestFile.id
    const requestDocumentId = normalizeDocumentId(requestFile.id, requestFile.pathname)
    const requestId = createId()
    const documentId = requestDocumentId
    const baseMarkdown = requestFile.markdown
    const requestMode = mode.value
    const requestSurface: AiEditorSurface = preferencesStore.sourceCode ? 'source' : 'wysiwyg'
    const editSession = requestMode === 'answer'
      ? null
      : beginAiEditSession({
        requestId,
        tabId: requestTabId,
        documentId,
        surface: requestSurface,
        beforeMarkdown: baseMarkdown
      })
    if (requestMode !== 'answer' && !editSession) return
    const pending = pendingAttachments.value.map(item => ({ ...item, attachment: { ...item.attachment } }))
    let keepEditSession = false
    try {
      await loadChat(requestDocumentId)
      const activeFile = editorStore.currentFile
      if (
        !activeFile ||
        activeFile.id !== requestTabId ||
        normalizeDocumentId(activeFile.id, activeFile.pathname) !== requestDocumentId
      ) {
        featureLog('request skipped because active document changed requestId=%s', requestId)
        await loadChat()
        return
      }
      const requestModel = resolveSelectedModel()
      if (!requestModel) {
        error.value = 'Configure at least one AI model before sending a request.'
        return
      }
      const contextMessages = messages.value.slice()
      loading.value = true
      activeRequestId.value = requestId
      startLiveProgress(requestId, requestMode)
      currentProgress.value = undefined
      renderingPdf.value = pending.some(item => item.attachment.mimeType === 'application/pdf')
      await preparePendingPdfSelections(pending)
      const attachments = pending.map(item => item.attachment)
      const uploads: AiAttachmentUpload[] = pending.map(item => ({ ...item.attachment, data: new Uint8Array(item.data) }))
      appendMessage('user', value, requestMode, { attachments })
      await saveChat()
      if (renderingPdf.value) await enqueueProgress('pdf-rendering')
      const renderedPdfPages = await prepareRenderedPdfPages(
        requestDocumentId,
        settings.value.contextMode === 'summary' ? [] : contextMessages,
        pending,
        async(current, total) => enqueueProgress('pdf-rendering', { current, total })
      )
      if (renderingPdf.value) {
        const renderedPageCount = renderedPdfPages.reduce((total, item) => total + item.pages.length, 0)
        await enqueueProgress('pdf-rendered', { current: renderedPageCount, total: renderedPageCount })
      }
      pendingAttachments.value = []
      attachmentError.value = ''
      featureLog(
        'request snapshot mode=%s documentKind=%s markdownChars=%s contextMessages=%s requestId=%s',
        requestMode,
        documentIdentityKind(documentId),
        baseMarkdown.length,
        contextMessages.length,
        requestId
      )
      error.value = ''
      renderingPdf.value = false
      await enqueueProgress('sending')
      await enqueueProgress('sent')
      await enqueueProgress('waiting')
      const response: AiResponse = await window.electron.ipcRenderer.invoke('mt::ai::request', {
        requestId,
        documentId,
        mode: requestMode,
        prompt: value,
        markdown: baseMarkdown,
        modelRef: requestModel,
        requestBodyPresetOverride: requestBodyPresetOverrideFor(requestModel),
        attachments: uploads,
        messages: toIpcChatMessages(contextMessages),
        contextSummary: contextSummary.value,
        renderedPdfPages
      })
      if (requestId !== activeRequestId.value || documentId !== currentDocumentId.value) return
      await enqueueProgress('responded')
      if (requestMode === 'answer') {
        commitContextSummary(response)
        appendMessage('assistant', response.content, requestMode, { model: response.model, reasoning: response.reasoning })
        lastAnswer.value = response.content
        await saveChat()
        await enqueueProgress('completed', finalProgressDetails())
      } else if (response.markdown !== undefined) {
        if (response.recovery?.requiresConfirmation) {
          if (!setAiEditSessionStatus(requestId, 'awaiting-confirmation')) {
            error.value = 'The document changed while the AI was working. The edit was discarded.'
            return
          }
          pendingRecovery.value = {
            requestId,
            response,
            tabId: requestTabId,
            beforeMarkdown: baseMarkdown,
            surface: requestSurface
          }
          keepEditSession = true
        } else {
          await enqueueProgress('local-processing')
          const applied = progressiveEditRequests.has(requestId)
            ? await finishProgressiveEdit(response, requestId, requestTabId, baseMarkdown)
            : await applyEdit(response, requestId, requestTabId, baseMarkdown)
          if (applied) await enqueueProgress(response.agentCompletion === 'partial' ? 'partial' : 'completed', finalProgressDetails())
        }
      }
    } catch (err) {
      if (requestId === activeRequestId.value) {
        const partialFinalized = requestMode !== 'answer' && progressiveEditRequests.has(requestId)
          ? await finalizeUnexpectedProgressiveEdit(requestId, requestTabId, requestMode, baseMarkdown)
          : false
        if (partialFinalized) {
          error.value = ''
          featureLog('progressive edit finalized after request failure requestId=%s', requestId)
          if (liveProgress.value?.phase !== 'partial') await enqueueProgress('partial', finalProgressDetails())
          return
        }
        if (err instanceof PdfPageSelectionError) {
          attachmentError.value = err.message.includes('historical') ? 'pdf-pages-required' : 'pdf-invalid-pages'
        } else if (err instanceof Error && /rendered PDF|PDF page renderer|stored PDF/i.test(err.message)) {
          attachmentError.value = 'pdf-render-failed'
        }
        error.value = err instanceof Error ? err.message : String(err)
        if (liveProgress.value?.phase !== 'failed') await enqueueProgress('failed', finalProgressDetails())
      }
    } finally {
      renderingPdf.value = false
      if (requestId === activeRequestId.value) {
        loading.value = false
        activeRequestId.value = null
        stopLiveProgress()
      }
      if (!keepEditSession) endAiEditSession(requestId)
      progressiveEditRequests.delete(requestId)
      progressiveFinalizedRequests.delete(requestId)
      expectedAgentMarkdown.delete(requestId)
    }
  }

  const discardPreparedRevision = async(revisionId: string): Promise<void> => {
    try {
      await window.electron.ipcRenderer.invoke('mt::ai::revision-discard', revisionId)
    } catch (err) {
      featureLog('revision discard failed revisionId=%s reason=%s', revisionId, err instanceof Error ? err.message : String(err))
    }
  }

  const responseSummary = (response: AiResponse): string => {
    if (response.agentCompletion === 'partial') {
      const completed = response.agentCompletedSteps ?? response.editSummary?.operationCount ?? 0
      const total = response.agentTotalSteps ?? completed
      return response.summary?.trim() || `Applied ${completed} of ${total} planned steps; remaining steps were not applied. Completed changes can be undone.`
    }
    const summary = response.summary?.trim()
    if (summary) return summary
    const operationCount = response.editSummary?.operationCount ?? 0
    if (!operationCount) return 'No document changes were needed.'
    return `Applied ${operationCount} local edit${operationCount === 1 ? '' : 's'}.`
  }

  const commitContextSummary = (response: AiResponse): void => {
    if (settings.value.contextMode !== 'summary') return
    const candidate = response.contextSummaryCandidate?.trim()
    if (candidate) {
      contextSummary.value = candidate
      featureLog('context summary committed chars=%s requestId=%s', candidate.length, response.requestId)
    }
  }

  const applyEdit = async(
    response: AiResponse,
    requestId: string,
    tabId: string,
    beforeMarkdown: string
  ): Promise<boolean> => {
    let applied = false
    editorStore.flushActiveEditor()
    const currentFile = editorStore.currentFile
    const nextMarkdown = response.markdown
    const session = aiEditSession.value
    if (
      !session ||
      session.requestId !== requestId ||
      session.tabId !== tabId ||
      session.documentId !== response.documentId ||
      session.status === 'stale' ||
      getAiDocumentRevision(tabId) !== session.beforeRevision ||
      response.baseMarkdown !== beforeMarkdown ||
      response.documentId !== currentDocumentId.value ||
      currentFile?.id !== tabId ||
      currentFile.markdown !== beforeMarkdown ||
      nextMarkdown === undefined
    ) {
      error.value = 'The document changed while the AI was working. The edit was discarded.'
      return false
    }
    if (nextMarkdown === beforeMarkdown) {
      commitContextSummary(response)
      appendMessage('assistant', responseSummary(response), response.mode, {
        editSummary: response.editSummary,
        reasoning: response.reasoning
      })
      await saveChat()
      return true
    }
    if (!setAiEditSessionStatus(requestId, 'applying')) {
      error.value = 'The document changed while the AI was working. The edit was discarded.'
      return false
    }
    const revision = await window.electron.ipcRenderer.invoke('mt::ai::revision-prepare', {
      documentId: response.documentId,
      beforeMarkdown,
      afterMarkdown: nextMarkdown,
      mode: response.mode
    })
    pendingRevision.value = revision
    const revisionId = revision.revisionId
    const preparedSession = aiEditSession.value
    if (
      !preparedSession ||
      preparedSession.requestId !== requestId ||
      preparedSession.status === 'stale' ||
      editorStore.currentFile?.id !== tabId ||
      editorStore.currentFile.markdown !== beforeMarkdown
    ) {
      await discardPreparedRevision(revisionId)
      pendingRevision.value = null
      error.value = 'The document changed while the AI was working. The edit was discarded.'
      return false
    }
    const applySaveSequence = getSaveSequence()
    await new Promise<void>((resolve) => {
      let settled = false
      const payload: AiApplyPayload = {
        tabId,
        surface: session.surface,
        mode: 'edit',
        beforeMarkdown,
        markdown: nextMarkdown,
        onApplied: (success, markdown) => {
          if (settled) return
          settled = true
          const finishApply = async(): Promise<void> => {
            if (!success || typeof markdown !== 'string' || !pendingRevision.value) {
              error.value = 'The AI edit could not be applied because the document changed.'
              await discardPreparedRevision(revisionId)
              pendingRevision.value = null
              resolve()
              return
            }
            let committed = false
            try {
              await window.electron.ipcRenderer.invoke(
                'mt::ai::revision-commit',
                revisionId,
                response.documentId,
                markdown
              )
              committed = true
              if (aiEditSession.value?.status === 'stale') {
                pendingRevision.value = null
                resolve()
                return
              }
              const ranges = response.mode === 'rewrite'
                ? fullDocumentRange(markdown)
                : rangesFromSummary(markdown, response.editSummary)
              changeTracker.apply(
                tabId,
                revisionId,
                beforeMarkdown,
                markdown,
                ranges
              )
              if (getLastSavedSequence(tabId) > applySaveSequence) {
                changeTracker.markSaved(tabId)
              }
              refreshChangeMarker(tabId)
              commitContextSummary(response)
              appendMessage('assistant', responseSummary(response), response.mode, {
                revisionId,
                editSummary: response.editSummary,
                model: response.model,
                reasoning: response.reasoning
              })
              await saveChat()
              applied = true
            } catch (err) {
              error.value = err instanceof Error ? err.message : String(err)
              if (!committed) await discardPreparedRevision(revisionId)
            } finally {
              pendingRevision.value = null
              resolve()
            }
          }
          finishApply().catch(err => {
            error.value = err instanceof Error ? err.message : String(err)
            pendingRevision.value = null
            resolve()
          })
        }
      }
      bus.emit('ai-apply-markdown', payload)
      queueMicrotask(() => {
        if (settled) return
        settled = true
        error.value = 'The AI edit could not be applied because the editor is unavailable.'
        discardPreparedRevision(revisionId).finally(() => {
          pendingRevision.value = null
          resolve()
        })
      })
    })
    return applied
  }

  const finishProgressiveEdit = async(
    response: AiResponse,
    requestId: string,
    tabId: string,
    beforeMarkdown: string
  ): Promise<boolean> => {
    if (progressiveFinalizedRequests.has(requestId)) return true
    const session = aiEditSession.value
    const currentMarkdown = editorStore.currentFile?.markdown
    if (
      !session ||
      session.requestId !== requestId ||
      session.tabId !== tabId ||
      session.status === 'stale' ||
      editorStore.currentFile?.id !== tabId ||
      currentMarkdown === undefined
    ) {
      error.value = 'The document changed while the AI was working. Completed agent steps were kept.'
      return false
    }
    const revisionId = `agent-${requestId}`
    changeTracker.apply(
      tabId,
      revisionId,
      beforeMarkdown,
      currentMarkdown,
      response.editSummary ? rangesFromSummary(currentMarkdown, response.editSummary) : fullDocumentRange(currentMarkdown)
    )
    progressiveFinalizedRequests.add(requestId)
    refreshChangeMarker(tabId)
    commitContextSummary(response)
    appendMessage('assistant', responseSummary(response), response.mode, {
      editSummary: response.editSummary,
      model: response.model,
      reasoning: response.reasoning
    })
    await saveChat()
    return true
  }

  const finalizeUnexpectedProgressiveEdit = async(
    requestId: string,
    tabId: string,
    requestMode: AiInteractionMode,
    beforeMarkdown: string
  ): Promise<boolean> => {
    if (progressiveFinalizedRequests.has(requestId)) return true
    const session = aiEditSession.value
    const currentMarkdown = editorStore.currentFile?.markdown
    const expectedMarkdown = expectedAgentMarkdown.get(requestId)
    if (
      !session ||
      session.requestId !== requestId ||
      session.tabId !== tabId ||
      session.status === 'stale' ||
      editorStore.currentFile?.id !== tabId ||
      currentMarkdown === undefined ||
      expectedMarkdown === undefined ||
      currentMarkdown !== expectedMarkdown ||
      currentMarkdown === beforeMarkdown
    ) return false
    changeTracker.apply(tabId, `agent-${requestId}`, beforeMarkdown, currentMarkdown, fullDocumentRange(currentMarkdown))
    progressiveFinalizedRequests.add(requestId)
    refreshChangeMarker(tabId)
    appendMessage(
      'assistant',
      'Applied the completed agent steps; the remaining work was not applied. Completed changes can be undone.',
      requestMode,
      { editSummary: undefined }
    )
    await saveChat()
    return true
  }

  const acceptPendingRecovery = async(): Promise<void> => {
    const proposal = pendingRecovery.value
    if (!proposal || loading.value) return
    pendingRecovery.value = null
    await applyEdit(proposal.response, proposal.requestId, proposal.tabId, proposal.beforeMarkdown)
    endAiEditSession(proposal.requestId)
  }

  const discardPendingRecovery = (): void => {
    if (pendingRecovery.value) endAiEditSession(pendingRecovery.value.requestId)
    pendingRecovery.value = null
  }

  const stop = (): void => {
    if (!activeRequestId.value) return
    const requestId = activeRequestId.value
    window.electron.ipcRenderer.send('mt::ai::cancel', requestId)
  }

  const undoAiEdit = async(): Promise<void> => {
    const file = editorStore.currentFile
    const documentId = currentDocumentId.value
    if (!file || !documentId || loading.value) return
    editorStore.flushActiveEditor()
    const beforeMarkdown = file.markdown
    const requestId = createId()
    const surface: AiEditorSurface = preferencesStore.sourceCode ? 'source' : 'wysiwyg'
    const session = beginAiEditSession({
      requestId,
      tabId: file.id,
      documentId,
      surface,
      beforeMarkdown
    })
    if (!session) return
    try {
      const result = await window.electron.ipcRenderer.invoke('mt::ai::revision-undo', documentId, beforeMarkdown)
      if (!result) {
        error.value = 'AI undo refused because the document has changed since the AI edit.'
        return
      }
      if (
        !setAiEditSessionStatus(requestId, 'applying') ||
        editorStore.currentFile?.id !== file.id ||
        editorStore.currentFile.markdown !== beforeMarkdown
      ) {
        error.value = 'The document changed while the AI undo was working.'
        return
      }
      const success = await new Promise<boolean>((resolve) => {
        let settled = false
        const payload: AiApplyPayload = {
          tabId: file.id,
          surface,
          mode: 'undo',
          beforeMarkdown,
          markdown: result.afterMarkdown,
          onApplied: (applied) => {
            if (settled) return
            settled = true
            resolve(applied)
          }
        }
        bus.emit('ai-apply-markdown', payload)
        queueMicrotask(() => {
          if (settled) return
          settled = true
          resolve(false)
        })
      })
      if (!success) {
        error.value = 'The AI undo could not be applied.'
        return
      }
      changeTracker.clear(file.id)
      refreshChangeMarker(file.id)
    } finally {
      endAiEditSession(requestId)
    }
  }

  return {
    settings,
    modelOptions,
    hasAnyApiKey,
    selectedModel,
    selectedModelOption,
    selectedRequestBodyPresets,
    requestBodyPresetSelection,
    selectedModelKey: computed(() => modelRefKey(selectedModel.value)),
    mode,
    visible,
    width,
    messages,
    pendingAttachments,
    pendingRecovery,
    attachmentError,
    loading,
    renderingPdf,
    currentProgress,
    liveProgress,
    liveProgressElapsedMs,
    error,
    lastAnswer,
    currentChangeMarker,
    currentDocumentId,
    setVisible,
    togglePanel,
    setMode,
    setSettings,
    selectModel,
    setRequestBodyPreset,
    setDefaultModel,
    setWidth,
    addImageFiles,
    addAttachmentFiles,
    setPendingPdfPageSelection,
    removePendingAttachment,
    clearPendingAttachments,
    navigateToChange,
    loadSettings,
    loadChat,
    clearChat,
    submit,
    acceptPendingRecovery,
    discardPendingRecovery,
    stop,
    undoAiEdit,
    listenForProgress
  }
})
