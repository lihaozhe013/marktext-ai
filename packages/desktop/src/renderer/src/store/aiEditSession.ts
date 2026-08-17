import { computed, readonly, ref } from 'vue'

export type AiEditorSurface = 'wysiwyg' | 'source'
export type AiEditSessionStatus = 'running' | 'awaiting-confirmation' | 'applying' | 'stale'

export interface AiEditSession {
  requestId: string
  tabId: string
  documentId: string
  surface: AiEditorSurface
  beforeMarkdown: string
  beforeRevision: number
  status: AiEditSessionStatus
}

const activeSession = ref<AiEditSession | null>(null)
const documentRevisions = new Map<string, number>()

export const aiEditSession = readonly(activeSession)
export const aiEditLocked = computed(() => activeSession.value !== null)

export const getAiDocumentRevision = (tabId: string): number =>
  documentRevisions.get(tabId) ?? 0

export const bumpAiDocumentRevision = (tabId: string): number => {
  const revision = getAiDocumentRevision(tabId) + 1
  documentRevisions.set(tabId, revision)
  return revision
}

export const beginAiEditSession = (session: Omit<AiEditSession, 'beforeRevision' | 'status'>): AiEditSession | null => {
  if (activeSession.value) return null
  const next: AiEditSession = {
    ...session,
    beforeRevision: getAiDocumentRevision(session.tabId),
    status: 'running'
  }
  activeSession.value = next
  return next
}

export const setAiEditSessionStatus = (requestId: string, status: AiEditSessionStatus): boolean => {
  if (activeSession.value?.requestId !== requestId) return false
  if (activeSession.value.status === 'stale' && status !== 'stale') return false
  activeSession.value.status = status
  return true
}

export const isAiEditSessionActive = (requestId: string): boolean =>
  activeSession.value?.requestId === requestId

export const invalidateAiEditSession = (tabId?: string): void => {
  if (!activeSession.value) return
  if (tabId && activeSession.value.tabId !== tabId) return
  activeSession.value.status = 'stale'
}

export const endAiEditSession = (requestId: string): void => {
  if (activeSession.value?.requestId === requestId) activeSession.value = null
}

export const isAiEditLocked = (): boolean => activeSession.value !== null

export const pruneAiDocumentRevisions = (tabIds: ReadonlySet<string>): void => {
  for (const tabId of documentRevisions.keys()) {
    if (!tabIds.has(tabId)) documentRevisions.delete(tabId)
  }
}
