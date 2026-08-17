import { afterEach, describe, expect, it } from 'vitest'
import {
  aiEditSession,
  beginAiEditSession,
  bumpAiDocumentRevision,
  endAiEditSession,
  getAiDocumentRevision,
  invalidateAiEditSession,
  isAiEditLocked,
  setAiEditSessionStatus
} from '@/store/aiEditSession'

describe('AI edit session', () => {
  afterEach(() => {
    const requestId = aiEditSession.value?.requestId
    if (requestId) endAiEditSession(requestId)
  })

  it('keeps the exact raw Markdown snapshot and allows only one session', () => {
    const beforeMarkdown = '| A | B |\n| --- | --- |\n| 1 | 2 |\n'
    const session = beginAiEditSession({
      requestId: 'request-raw',
      tabId: 'tab-raw',
      documentId: 'path:README.md',
      surface: 'wysiwyg',
      beforeMarkdown
    })

    expect(session).toMatchObject({ beforeMarkdown, beforeRevision: 0 })
    expect(isAiEditLocked()).toBe(true)
    expect(beginAiEditSession({
      requestId: 'request-second',
      tabId: 'tab-raw',
      documentId: 'path:README.md',
      surface: 'wysiwyg',
      beforeMarkdown
    })).toBeNull()
  })

  it('invalidates a session after an external document revision', () => {
    const session = beginAiEditSession({
      requestId: 'request-stale',
      tabId: 'tab-stale',
      documentId: 'tab:tab-stale',
      surface: 'source',
      beforeMarkdown: 'before'
    })

    expect(session).not.toBeNull()
    if (!session) return

    expect(getAiDocumentRevision(session.tabId)).toBe(session.beforeRevision)
    bumpAiDocumentRevision(session.tabId)
    invalidateAiEditSession(session.tabId)
    expect(setAiEditSessionStatus(session.requestId, 'applying')).toBe(false)
    expect(aiEditSession.value?.status).toBe('stale')
    expect(isAiEditLocked()).toBe(true)
  })
})
