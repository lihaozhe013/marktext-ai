import { computed, type ComputedRef, type Ref } from 'vue'
import bus from '../bus'
import { type AiChangeTracker, type AiChangeMarker } from './aiChangeTracker'
import type { AiEditSession } from './aiEditSession'

export interface AiChangeControllerContext {
  tracker: AiChangeTracker
  changeVersion: Ref<number>
  getCurrentTabId: () => string | undefined
  getSession: () => AiEditSession | null
  getExpectedMarkdown: (requestId: string) => string | undefined
  markSessionStale: (requestId: string) => void
}

export interface AiChangeController {
  currentChangeMarker: ComputedRef<AiChangeMarker | undefined>
  getSaveSequence: () => number
  getLastSavedSequence: (tabId: string) => number
  refreshChangeMarker: (tabId?: string) => void
  publishChangeMarker: (tabId: string) => void
  dispose: () => void
}

export const createAiChangeController = ({
  tracker,
  changeVersion,
  getCurrentTabId,
  getSession,
  getExpectedMarkdown,
  markSessionStale
}: AiChangeControllerContext): AiChangeController => {
  const lastSavedSequence = new Map<string, number>()
  let saveSequence = 0

  const publishChangeMarker = (tabId: string): void => {
    const marker = tracker.get(tabId)
    bus.emit('ai-change-marker-updated', {
      tabId,
      marker: marker
        ? {
          revisionId: marker.revisionId,
          status: marker.status,
          visible: marker.visible,
          ranges: marker.ranges.map((range) => ({ ...range }))
        }
        : undefined
    })
  }

  const refreshChangeMarker = (tabId?: string): void => {
    changeVersion.value += 1
    if (tabId) publishChangeMarker(tabId)
  }

  const currentChangeMarker = computed<AiChangeMarker | undefined>(() => {
    const version = changeVersion.value
    const tabId = getCurrentTabId()
    return version >= 0 && tabId ? tracker.get(tabId) : undefined
  })

  const handleMarkerRequest = (tabId: unknown): void => {
    if (typeof tabId === 'string') publishChangeMarker(tabId)
  }

  const handleDocumentChanged = (payload: unknown): void => {
    const data = payload as { id?: string; markdown?: string } | undefined
    if (!data?.id || typeof data.markdown !== 'string') return

    tracker.updateDocument(data.id, data.markdown)
    const session = getSession()
    if (
      session &&
      session.tabId === data.id &&
      session.status !== 'applying' &&
      data.markdown !== session.beforeMarkdown &&
      getExpectedMarkdown(session.requestId) !== data.markdown
    ) {
      markSessionStale(session.requestId)
    }
    refreshChangeMarker(data.id)
  }

  const handleDocumentSaved = (tabId: unknown): void => {
    if (typeof tabId !== 'string') return
    saveSequence += 1
    lastSavedSequence.set(tabId, saveSequence)
    tracker.markSaved(tabId)
    refreshChangeMarker(tabId)
  }

  const handleFileLoaded = (payload: unknown): void => {
    const data = payload as { id?: string; markdown?: string } | undefined
    if (!data?.id || typeof data.markdown !== 'string') return

    const session = getSession()
    if (session?.tabId === data.id && data.markdown !== session.beforeMarkdown) {
      markSessionStale(session.requestId)
    }
    const marker = tracker.get(data.id)
    if (
      marker &&
      data.markdown !== marker.currentMarkdown &&
      data.markdown !== marker.beforeMarkdown &&
      data.markdown !== marker.afterMarkdown
    ) {
      tracker.clear(data.id)
      refreshChangeMarker(data.id)
    }
  }

  bus.on('ai-request-change-marker', handleMarkerRequest)
  bus.on('ai-document-content-changed', handleDocumentChanged)
  bus.on('ai-document-saved', handleDocumentSaved)
  bus.on('file-loaded', handleFileLoaded)

  return {
    currentChangeMarker,
    getSaveSequence: () => saveSequence,
    getLastSavedSequence: (tabId: string) => lastSavedSequence.get(tabId) ?? 0,
    refreshChangeMarker,
    publishChangeMarker,
    dispose: () => {
      bus.off('ai-request-change-marker', handleMarkerRequest)
      bus.off('ai-document-content-changed', handleDocumentChanged)
      bus.off('ai-document-saved', handleDocumentSaved)
      bus.off('file-loaded', handleFileLoaded)
    }
  }
}
