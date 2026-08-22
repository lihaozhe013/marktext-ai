import type { AiChatSession } from '@shared/types/ai'
import { readJson, writeJsonAtomic } from './storage'

interface AiChatStoreDependencies {
  normalizeMessages: (messages: AiChatSession['messages']) => AiChatSession['messages']
  normalizeModel: (value: unknown) => AiChatSession['selectedModel']
  normalizeSession: (value: unknown) => AiChatSession
  clearPendingAttachments: (documentId: string) => void
  pruneAttachments: (graceMs: number) => Promise<void>
  onCleanupError: (error: unknown) => void
  migrateRevisions: (fromDocumentId: string, toDocumentId: string) => Promise<void>
}

export class AiChatStore {
  private chatMutation: Promise<void> = Promise.resolve()

  constructor(
    private readonly chatPath: string,
    private readonly dependencies: AiChatStoreDependencies
  ) {}

  private queueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.chatMutation.then(operation, operation)
    this.chatMutation = result.then(() => undefined, () => undefined)
    return result
  }

  async load(documentId: string): Promise<AiChatSession> {
    const all = await readJson<Record<string, unknown>>(this.chatPath, {})
    return this.dependencies.normalizeSession(all[documentId])
  }

  async save(documentId: string, session: AiChatSession): Promise<void> {
    return this.queueMutation(async() => {
      const all = await readJson<Record<string, unknown>>(this.chatPath, {})
      const normalized = this.dependencies.normalizeSession(session)
      all[documentId] = {
        messages: normalized.messages,
        selectedModel: this.dependencies.normalizeModel(normalized.selectedModel),
        ...(normalized.requestBodyPresetOverrides?.length
          ? { requestBodyPresetOverrides: normalized.requestBodyPresetOverrides }
          : {}),
        ...(normalized.contextSummary
          ? { contextSummary: normalized.contextSummary }
          : {})
      }
      this.dependencies.clearPendingAttachments(documentId)
      await writeJsonAtomic(this.chatPath, all)
      await this.dependencies.pruneAttachments(0).catch(error => this.dependencies.onCleanupError(error))
    })
  }

  async clear(documentId: string): Promise<void> {
    return this.queueMutation(async() => {
      const all = await readJson<Record<string, unknown>>(this.chatPath, {})
      delete all[documentId]
      await writeJsonAtomic(this.chatPath, all)
      await this.dependencies.pruneAttachments(0).catch(error => this.dependencies.onCleanupError(error))
    })
  }

  async migrateDocumentIdentity(fromDocumentId: string, toDocumentId: string): Promise<void> {
    if (!fromDocumentId || !toDocumentId || fromDocumentId === toDocumentId) return
    return this.queueMutation(async() => {
      const chats = await readJson<Record<string, unknown>>(this.chatPath, {})
      if (chats[fromDocumentId] !== undefined) {
        chats[toDocumentId] = chats[toDocumentId] ?? chats[fromDocumentId]
        delete chats[fromDocumentId]
        await writeJsonAtomic(this.chatPath, chats)
      }
      await this.dependencies.migrateRevisions(fromDocumentId, toDocumentId)
      await this.dependencies.pruneAttachments(0).catch(error => this.dependencies.onCleanupError(error))
    })
  }
}
