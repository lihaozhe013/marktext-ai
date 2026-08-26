import crypto from 'crypto'
import type { AiPreparedRevision, AiRevisionRequest, AiUndoResult } from '@shared/types/ai'
import { readJson, writeJsonAtomic } from './storage'
import { featureLog } from './logging'
import type { StoredRevision, StoredRevisionState } from './types'

const normalizeRevisionMarkdown = (value: string): string => value.replace(/[\r\n]+$/, '')

export class AiRevisionStore {
  constructor(private readonly revisionPath: string) {}

  private async readRevisions(): Promise<StoredRevisionState> {
    const state = await readJson<StoredRevisionState>(this.revisionPath, { revisions: [] })
    return { revisions: Array.isArray(state.revisions) ? state.revisions : [] }
  }

  async prepare(request: AiRevisionRequest): Promise<AiPreparedRevision> {
    if (!request.documentId) throw new Error('Invalid document identity.')
    const revision: StoredRevision = {
      ...request,
      revisionId: crypto.randomUUID(),
      preparedAt: Date.now(),
      status: 'prepared'
    }
    const state = await this.readRevisions()
    state.revisions.push(revision)
    await writeJsonAtomic(this.revisionPath, state)
    featureLog(
      'revision prepared revisionId=%s beforeChars=%s afterChars=%s',
      revision.revisionId,
      revision.beforeMarkdown.length,
      revision.afterMarkdown.length
    )
    return revision
  }

  async commit(revisionId: string, documentId: string, afterMarkdown: string): Promise<void> {
    const state = await this.readRevisions()
    const revision = state.revisions.find(item => item.revisionId === revisionId)
    if (!revision || revision.documentId !== documentId) throw new Error('Revision is no longer valid.')
    // Muya may normalize Markdown while applying a replacement. The renderer
    // sends that serialized result back, which is the canonical content for
    // undo and must replace the model's pre-serialization output.
    revision.afterMarkdown = afterMarkdown
    revision.status = 'committed'
    revision.committedAt = Date.now()
    await writeJsonAtomic(this.revisionPath, state)
    featureLog('revision committed revisionId=%s afterChars=%s', revisionId, afterMarkdown.length)
  }

  async discard(revisionId: string): Promise<void> {
    const state = await this.readRevisions()
    const nextRevisions = state.revisions.filter(item => item.revisionId !== revisionId || item.status !== 'prepared')
    if (nextRevisions.length === state.revisions.length) return
    await writeJsonAtomic(this.revisionPath, { revisions: nextRevisions })
    featureLog('revision discarded revisionId=%s', revisionId)
  }

  async undo(documentId: string, currentMarkdown: string): Promise<AiUndoResult | null> {
    const state = await this.readRevisions()
    const revision = [...state.revisions]
      .reverse()
      .find(item => item.documentId === documentId && item.status === 'committed')
    if (!revision || normalizeRevisionMarkdown(revision.afterMarkdown) !== normalizeRevisionMarkdown(currentMarkdown)) return null
    const inverse: StoredRevision = {
      revisionId: crypto.randomUUID(),
      documentId,
      beforeMarkdown: currentMarkdown,
      afterMarkdown: revision.beforeMarkdown,
      mode: 'edit',
      preparedAt: Date.now(),
      status: 'committed',
      committedAt: Date.now()
    }
    state.revisions.push(inverse)
    await writeJsonAtomic(this.revisionPath, state)
    return {
      revisionId: inverse.revisionId,
      documentId,
      beforeMarkdown: inverse.beforeMarkdown,
      afterMarkdown: inverse.afterMarkdown
    }
  }

  async migrateDocumentIdentity(fromDocumentId: string, toDocumentId: string): Promise<void> {
    const state = await this.readRevisions()
    let changed = false
    for (const revision of state.revisions) {
      if (revision.documentId === fromDocumentId) {
        revision.documentId = toDocumentId
        changed = true
      }
    }
    if (changed) await writeJsonAtomic(this.revisionPath, state)
  }
}
