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
  AiConnectionSettings,
  AiEditSummary,
  AiImageAttachment,
  AiImageMimeType,
  AiImageUpload,
  AiInteractionMode,
  AiPreparedRevision,
  AiResponse
} from '@shared/types/ai'
import {
  AI_IMAGE_MIME_TYPES,
  AI_MAX_IMAGE_BYTES,
  AI_MAX_IMAGE_COUNT,
  AI_MAX_IMAGE_TOTAL_BYTES
} from '@shared/types/ai'
import { AiChangeTracker, rangesFromSummary, fullDocumentRange, type AiChangeMarker } from './aiChangeTracker'

export interface AiApplyPayload {
  tabId: string
  surface: AiEditorSurface
  mode: 'edit' | 'undo'
  beforeMarkdown: string
  markdown: string
  onApplied: (success: boolean, markdown?: string) => void
}

export type AiAttachmentError = '' | 'unsupported' | 'too-large' | 'too-many' | 'total-too-large' | 'read-failed'

export interface PendingAiImage {
  attachment: AiImageAttachment
  data: Uint8Array
}

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

const MIME_BY_EXTENSION: Record<string, AiImageMimeType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}

const resolveImageMimeType = (file: File): AiImageMimeType | undefined => {
  if (AI_IMAGE_MIME_TYPES.includes(file.type as AiImageMimeType)) return file.type as AiImageMimeType
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
  createdAt: message.createdAt,
  revisionId: message.revisionId,
  attachments: message.attachments?.map(attachment => ({ ...attachment })),
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
    protocol: 'openai-chat-completions',
    endpoint: '',
    model: '',
    hasApiKey: false
  })
  const mode = ref<AiInteractionMode>((localStorage.getItem('ai-mode') as AiInteractionMode) || 'answer')
  const visible = ref(localStorage.getItem('ai-panel-visible') !== 'false')
  const width = ref(Number(localStorage.getItem('ai-panel-width')) || 380)
  const messages = ref<AiChatMessage[]>([])
  const pendingAttachments = ref<PendingAiImage[]>([])
  const attachmentError = ref<AiAttachmentError>('')
  const loading = ref(false)
  const error = ref('')
  const lastAnswer = ref('')
  const pendingRevision = ref<AiPreparedRevision | null>(null)
  const pendingRecovery = ref<PendingAiRecovery | null>(null)
  const activeRequestId = ref<string | null>(null)
  const activeDocumentId = ref('')
  const changeTracker = new AiChangeTracker()
  const changeVersion = ref(0)
  const lastSavedSequence = new Map<string, number>()
  let saveSequence = 0
  let chatLoadSequence = 0
  let loadedChatDocumentId = ''

  const clearPendingAttachments = (): void => {
    pendingAttachments.value = []
  }

  const addImageFiles = async(files: readonly File[]): Promise<void> => {
    attachmentError.value = ''
    let rejected: AiAttachmentError = ''
    const available = AI_MAX_IMAGE_COUNT - pendingAttachments.value.length
    if (files.length > available) rejected = 'too-many'
    const selected = files.slice(0, Math.max(0, available))
    let totalBytes = pendingAttachments.value.reduce((total, item) => total + item.attachment.byteSize, 0)
    for (const file of selected) {
      const mimeType = resolveImageMimeType(file)
      if (!mimeType) {
        rejected = rejected || 'unsupported'
        continue
      }
      if (file.size <= 0 || file.size > AI_MAX_IMAGE_BYTES) {
        rejected = rejected || 'too-large'
        continue
      }
      if (totalBytes + file.size > AI_MAX_IMAGE_TOTAL_BYTES) {
        rejected = rejected || 'total-too-large'
        continue
      }
      try {
        const data = new Uint8Array(await file.arrayBuffer())
        const attachment: AiImageAttachment = {
          id: createId(),
          name: file.name || 'image',
          mimeType,
          byteSize: data.byteLength
        }
        pendingAttachments.value.push({ attachment, data })
        totalBytes += data.byteLength
      } catch {
        rejected = rejected || 'read-failed'
      }
    }
    attachmentError.value = rejected
  }

  const removePendingAttachment = (id: string): void => {
    pendingAttachments.value = pendingAttachments.value.filter(item => item.attachment.id !== id)
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
      setAiEditSessionStatus(session.requestId, 'stale')
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

  const loadSettings = async(): Promise<void> => {
    try {
      settings.value = await window.electron.ipcRenderer.invoke('mt::ai::get-settings')
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  }

  const loadChat = async(documentId: string = currentDocumentId.value): Promise<void> => {
    if (!documentId || (documentId === activeDocumentId.value && loadedChatDocumentId === documentId)) return
    const loadSequence = ++chatLoadSequence
    activeDocumentId.value = documentId
    try {
      const loadedMessages: AiChatMessage[] = await window.electron.ipcRenderer.invoke('mt::ai::chat-load', documentId)
      if (loadSequence !== chatLoadSequence || documentId !== currentDocumentId.value) return
      messages.value = loadedMessages
      loadedChatDocumentId = documentId
    } catch (err) {
      if (loadSequence !== chatLoadSequence || documentId !== currentDocumentId.value) return
      error.value = err instanceof Error ? err.message : String(err)
      messages.value = []
      loadedChatDocumentId = documentId
    }
  }

  const saveChat = async(): Promise<void> => {
    if (activeDocumentId.value) {
      await window.electron.ipcRenderer.invoke(
        'mt::ai::chat-save',
        activeDocumentId.value,
        toIpcChatMessages(messages.value.slice(-10))
      )
    }
  }

  const clearChat = async(): Promise<void> => {
    clearPendingAttachments()
    messages.value = []
    lastAnswer.value = ''
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
    options: { revisionId?: string; editSummary?: AiEditSummary; attachments?: AiImageAttachment[] } = {}
  ): void => {
    messages.value.push({
      id: createId(),
      role,
      mode: messageMode,
      content,
      createdAt: Date.now(),
      ...options
    })
    const retainedMessages = messages.value.slice(-10)
    messages.value = retainedMessages
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
    const attachments = pending.map(item => item.attachment)
    const uploads: AiImageUpload[] = pending.map(item => ({ ...item.attachment, data: new Uint8Array(item.data) }))
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
      pendingAttachments.value = []
      attachmentError.value = ''
      appendMessage('user', value, requestMode, { attachments })
      featureLog(
        'request snapshot mode=%s documentKind=%s markdownChars=%s contextMessages=%s requestId=%s',
        requestMode,
        documentIdentityKind(documentId),
        baseMarkdown.length,
        messages.value.length - 1,
        requestId
      )
      error.value = ''
      loading.value = true
      activeRequestId.value = requestId
      const response: AiResponse = await window.electron.ipcRenderer.invoke('mt::ai::request', {
        requestId,
        documentId,
        mode: requestMode,
        prompt: value,
        markdown: baseMarkdown,
        attachments: uploads,
        messages: toIpcChatMessages(messages.value.slice(0, -1))
      })
      if (requestId !== activeRequestId.value || documentId !== currentDocumentId.value) return
      if (requestMode === 'answer') {
        appendMessage('assistant', response.content, requestMode)
        lastAnswer.value = response.content
        await saveChat()
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
          await applyEdit(response, requestId, requestTabId, baseMarkdown)
        }
      }
    } catch (err) {
      if (requestId === activeRequestId.value) {
        error.value = err instanceof Error ? err.message : String(err)
      }
    } finally {
      if (requestId === activeRequestId.value) {
        loading.value = false
        activeRequestId.value = null
      }
      if (!keepEditSession) endAiEditSession(requestId)
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
  ): Promise<void> => {
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
      return
    }
    if (nextMarkdown === beforeMarkdown) {
      appendMessage('assistant', response.summary ?? '', response.mode, { editSummary: response.editSummary })
      await saveChat()
      return
    }
    if (!setAiEditSessionStatus(requestId, 'applying')) {
      error.value = 'The document changed while the AI was working. The edit was discarded.'
      return
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
      return
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
                editSummary: response.editSummary
              })
              await saveChat()
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
        void discardPreparedRevision(revisionId).finally(() => {
          pendingRevision.value = null
          resolve()
        })
      })
    })
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
    activeRequestId.value = null
    loading.value = false
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
    mode,
    visible,
    width,
    messages,
    pendingAttachments,
    pendingRecovery,
    attachmentError,
    loading,
    error,
    lastAnswer,
    currentChangeMarker,
    currentDocumentId,
    setVisible,
    togglePanel,
    setMode,
    setWidth,
    addImageFiles,
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
    undoAiEdit
  }
})
