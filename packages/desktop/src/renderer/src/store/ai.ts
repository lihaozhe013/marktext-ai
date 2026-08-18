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
import { AiChangeTracker, rangesFromSummary, fullDocumentRange, type AiChangeMarker } from './aiChangeTracker'
import {
  defaultPdfPages,
  formatPdfPageSelection,
  getPdfPageCount,
  parsePdfPageSelection,
  PdfPageSelectionError,
  renderPdfPages
} from './pdfRendering'

export interface AiApplyPayload {
  tabId: string
  surface: AiEditorSurface
  mode: 'edit' | 'undo'
  beforeMarkdown: string
  markdown: string
  onApplied: (success: boolean, markdown?: string) => void
}

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

// Pinia wraps store values in Vue reactive proxies. Electron IPC uses the
// structured clone algorithm, which cannot clone those proxies, so every
// chat message crossing the renderer/main boundary must be copied explicitly.
const toIpcChatMessage = (message: AiChatMessage): AiChatMessage => ({
  id: message.id,
  role: message.role,
  mode: message.mode,
  content: message.content,
  reasoning: message.reasoning,
  createdAt: message.createdAt,
  revisionId: message.revisionId,
  kind: message.kind,
  progress: message.progress ? { ...message.progress } : undefined,
  attachments: message.attachments?.map(attachment => ({
    ...attachment,
    ...(attachment.mimeType === 'application/pdf' && attachment.pages ? { pages: [...attachment.pages] } : {})
  })),
  model: message.model ? { ...message.model } : undefined,
  editSummary: message.editSummary
    ? {
      operationCount: message.editSummary.operationCount,
      addedLines: message.editSummary.addedLines,
      removedLines: message.editSummary.removedLines,
      operations: message.editSummary.operations.map(operation => ({ ...operation }))
    }
    : undefined
})

const toIpcChatMessages = (items: readonly AiChatMessage[]): AiChatMessage[] =>
  items.map(toIpcChatMessage)

export const useAiStore = defineStore('ai', () => {
  const editorStore = useEditorStore()
  const preferencesStore = usePreferencesStore()
  const settings = ref<AiConnectionSettings>({
    connections: []
  })
  const mode = ref<AiInteractionMode>((localStorage.getItem('ai-mode') as AiInteractionMode) || 'answer')
  const visible = ref(localStorage.getItem('ai-panel-visible') !== 'false')
  const width = ref(Number(localStorage.getItem('ai-panel-width')) || 380)
  const messages = ref<AiChatMessage[]>([])
  const selectedModel = ref<AiModelRef | undefined>()
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
  const expectedAgentMarkdown = new Map<string, string>()
  const changeTracker = new AiChangeTracker()
  const changeVersion = ref(0)
  const lastSavedSequence = new Map<string, number>()
  let saveSequence = 0
  let chatLoadSequence = 0
  let loadedChatDocumentId = ''

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
    hasApiKey: connection.hasApiKey
  }))))
  const hasAnyApiKey = computed(() => settings.value.connections.some(connection => connection.hasApiKey))

  const isValidModelRef = (value: AiModelRef | undefined): value is AiModelRef =>
    !!value && modelOptions.value.some(option => option.ref.connectionId === value.connectionId && option.ref.modelId === value.modelId)

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

  const currentChangeMarker = computed<AiChangeMarker | undefined>(() => {
    const version = changeVersion.value
    const tabId = editorStore.currentFile?.id
    return version >= 0 && tabId ? changeTracker.get(tabId) : undefined
  })

  const publishChangeMarker = (tabId: string): void => {
    const marker = changeTracker.get(tabId)
    bus.emit('ai-change-marker-updated', {
      tabId,
      marker: marker
        ? {
          revisionId: marker.revisionId,
          status: marker.status,
          visible: marker.visible,
          ranges: marker.ranges.map(range => ({ ...range }))
        }
        : undefined
    })
  }

  const refreshChangeMarker = (tabId?: string): void => {
    changeVersion.value += 1
    if (tabId) publishChangeMarker(tabId)
  }

  bus.on('ai-request-change-marker', (tabId) => {
    if (typeof tabId === 'string') publishChangeMarker(tabId)
  })

  bus.on('ai-document-content-changed', (payload) => {
    const data = payload as { id?: string; markdown?: string } | undefined
    if (!data?.id || typeof data.markdown !== 'string') return
    changeTracker.updateDocument(data.id, data.markdown)
    const session = aiEditSession.value
    if (
      session &&
      session.tabId === data.id &&
      session.status !== 'applying' &&
      data.markdown !== session.beforeMarkdown
    ) {
      if (expectedAgentMarkdown.get(session.requestId) !== data.markdown) {
        setAiEditSessionStatus(session.requestId, 'stale')
      }
    }
    refreshChangeMarker(data.id)
  })
  bus.on('ai-document-saved', (tabId) => {
    if (typeof tabId !== 'string') return
    saveSequence += 1
    lastSavedSequence.set(tabId, saveSequence)
    changeTracker.markSaved(tabId)
    refreshChangeMarker(tabId)
  })
  bus.on('file-loaded', (payload) => {
    const data = payload as { id?: string; markdown?: string } | undefined
    if (!data?.id || typeof data.markdown !== 'string') return
    const session = aiEditSession.value
    if (session?.tabId === data.id && data.markdown !== session.beforeMarkdown) {
      setAiEditSessionStatus(session.requestId, 'stale')
    }
    const marker = changeTracker.get(data.id)
    if (marker && data.markdown !== marker.currentMarkdown && data.markdown !== marker.beforeMarkdown && data.markdown !== marker.afterMarkdown) {
      changeTracker.clear(data.id)
      refreshChangeMarker(data.id)
    }
  })

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
      selectedModel.value = loadedSession.selectedModel
      resolveSelectedModel()
      loadedChatDocumentId = documentId
    } catch (err) {
      if (loadSequence !== chatLoadSequence || documentId !== currentDocumentId.value) return
      error.value = err instanceof Error ? err.message : String(err)
      messages.value = []
      resolveSelectedModel()
      loadedChatDocumentId = documentId
    }
  }

  const saveChat = async(): Promise<void> => {
    if (activeDocumentId.value) {
      await window.electron.ipcRenderer.invoke(
        'mt::ai::chat-save',
        activeDocumentId.value,
        {
          messages: toIpcChatMessages(messages.value.slice(-MAX_STORED_CHAT_MESSAGES)),
          selectedModel: selectedModel.value ? { ...selectedModel.value } : undefined
        }
      )
    }
  }

  const clearChat = async(): Promise<void> => {
    clearPendingAttachments()
    messages.value = []
    selectedModel.value = resolveSelectedModel()
    lastAnswer.value = ''
    currentProgress.value = undefined
    attachmentError.value = ''
    if (pendingRecovery.value) {
      endAiEditSession(pendingRecovery.value.requestId)
    }
    pendingRecovery.value = null
    if (activeDocumentId.value) {
      await window.electron.ipcRenderer.invoke('mt::ai::chat-clear', activeDocumentId.value)
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
    if (!['agent-step', 'attempt-failed', 'retrying', 'fallback', 'failed', 'cancelled'].includes(event.phase)) return
    const progress: AiProgressInfo = {
      phase: event.phase,
      attempt: event.attempt,
      elapsedMs: event.elapsedMs,
      outputTokens: event.outputTokens,
      outputTokensEstimated: event.outputTokensEstimated,
      inputTokens: event.inputTokens,
      inputTokensEstimated: event.inputTokensEstimated,
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
      stepAddedLines: event.stepAddedLines,
      stepRemovedLines: event.stepRemovedLines,
      stepRemovedText: event.stepRemovedText,
      stepAddedText: event.stepAddedText,
      cachedInputTokens: event.cachedInputTokens,
      cacheWriteInputTokens: event.cacheWriteInputTokens
    }
    progressPersistSequence = progressPersistSequence
      .then(() => appendProgress(event.phase, progress))
      .catch(() => undefined)
  })

  const appendProgress = async(
    phase: AiProgressPhase,
    details: Partial<Pick<AiProgressInfo, 'current' | 'total' | 'attempt' | 'elapsedMs' | 'outputTokens' | 'outputTokensEstimated' | 'inputTokens' | 'inputTokensEstimated' | 'failureReason' | 'failureCount' | 'failureOutput' | 'failureOutputTruncated' | 'step' | 'maxSteps' | 'successfulSteps' | 'toolFailures' | 'documentVersion' | 'stepDescription' | 'stepAddedLines' | 'stepRemovedLines' | 'stepRemovedText' | 'stepAddedText' | 'cachedInputTokens' | 'cacheWriteInputTokens' | 'planSummary' | 'planStepCount' | 'planStepDescriptions' | 'planRevisionCount' | 'currentPlanStep'>> = {}
  ): Promise<void> => {
    const progress: AiProgressInfo = { phase, ...details }
    currentProgress.value = progress
    appendMessage('assistant', '', 'answer', { kind: 'status', progress })
    await saveChat()
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
      if (renderingPdf.value) await appendProgress('pdf-rendering')
      const renderedPdfPages = await prepareRenderedPdfPages(
        requestDocumentId,
        contextMessages,
        pending,
        async(current, total) => appendProgress('pdf-rendering', { current, total })
      )
      if (renderingPdf.value) {
        const renderedPageCount = renderedPdfPages.reduce((total, item) => total + item.pages.length, 0)
        await appendProgress('pdf-rendered', { current: renderedPageCount, total: renderedPageCount })
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
      await appendProgress('sending')
      await appendProgress('sent')
      await appendProgress('waiting')
      const response: AiResponse = await window.electron.ipcRenderer.invoke('mt::ai::request', {
        requestId,
        documentId,
        mode: requestMode,
        prompt: value,
        markdown: baseMarkdown,
        modelRef: requestModel,
        attachments: uploads,
        messages: toIpcChatMessages(contextMessages),
        renderedPdfPages
      })
      if (requestId !== activeRequestId.value || documentId !== currentDocumentId.value) return
      await appendProgress('responded')
      if (requestMode === 'answer') {
        appendMessage('assistant', response.content, requestMode, { model: response.model, reasoning: response.reasoning })
        lastAnswer.value = response.content
        await saveChat()
        await appendProgress('completed', finalProgressDetails())
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
          await appendProgress('local-processing')
          const applied = progressiveEditRequests.has(requestId)
            ? await finishProgressiveEdit(response, requestId, requestTabId, baseMarkdown)
            : await applyEdit(response, requestId, requestTabId, baseMarkdown)
          if (applied) await appendProgress('completed', finalProgressDetails())
        }
      }
    } catch (err) {
      if (requestId === activeRequestId.value) {
        if (err instanceof PdfPageSelectionError) {
          attachmentError.value = err.message.includes('historical') ? 'pdf-pages-required' : 'pdf-invalid-pages'
        } else if (err instanceof Error && /rendered PDF|PDF page renderer|stored PDF/i.test(err.message)) {
          attachmentError.value = 'pdf-render-failed'
        }
        error.value = err instanceof Error ? err.message : String(err)
        if (liveProgress.value?.phase !== 'failed') await appendProgress('failed', finalProgressDetails()).catch(() => undefined)
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
      appendMessage('assistant', response.summary ?? '', response.mode, {
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
    const applySaveSequence = saveSequence
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
              if ((lastSavedSequence.get(tabId) ?? 0) > applySaveSequence) {
                changeTracker.markSaved(tabId)
              }
              refreshChangeMarker(tabId)
              appendMessage('assistant', response.summary ?? '', response.mode, {
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
    refreshChangeMarker(tabId)
    appendMessage('assistant', response.summary ?? '', response.mode, {
      editSummary: response.editSummary,
      model: response.model,
      reasoning: response.reasoning
    })
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
    const progress = liveProgress.value
    window.electron.ipcRenderer.send('mt::ai::cancel', requestId)
    activeRequestId.value = null
    loading.value = false
    stopLiveProgress()
    appendProgress(
      'cancelled',
      progress
        ? {
          attempt: progress.attempt,
          elapsedMs: progress.elapsedMs,
          outputTokens: progress.outputTokens,
          outputTokensEstimated: progress.outputTokensEstimated,
          inputTokens: progress.inputTokens,
          inputTokensEstimated: progress.inputTokensEstimated
        }
        : {}
    ).catch(() => undefined)
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
