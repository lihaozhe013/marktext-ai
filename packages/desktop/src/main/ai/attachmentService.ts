import type { AiAttachment, AiAttachmentData, AiRenderedPdfPages } from '@shared/types/ai'
import {
  AI_MAX_IMAGE_BYTES,
  AI_MAX_IMAGE_COUNT,
  AI_MAX_IMAGE_TOTAL_BYTES
} from '@shared/types/ai'
import { AiAttachmentStore, normalizeAttachmentUploads, normalizeImageUpload, orderAttachmentLocations } from './attachments'
import type { ProviderImage, ProviderMessage, ProviderToolCall, ProviderToolResult } from './providerMessages'
import { readJson } from './storage'
import { featureLog } from './logging'
import { collectAttachmentIds, normalizeChatSession } from './chatNormalization'

const ATTACHMENT_GRACE_MS = 24 * 60 * 60 * 1000

export class AiAttachmentService {
  private readonly attachmentStore: AiAttachmentStore
  private readonly pendingAttachmentIds = new Map<string, number>()
  private readonly pendingAttachmentDocuments = new Map<string, string>()
  private readonly attachmentMimeTypes = new Map<string, AiAttachment['mimeType']>()

  constructor(userDataPath: string, private readonly chatPath: string) {
    this.attachmentStore = new AiAttachmentStore(userDataPath)
  }

  clearPendingAttachments(documentId: string): void {
    for (const [id, pendingDocumentId] of this.pendingAttachmentDocuments) {
      if (pendingDocumentId === documentId) {
        this.pendingAttachmentIds.delete(id)
        this.pendingAttachmentDocuments.delete(id)
        this.attachmentMimeTypes.delete(id)
      }
    }
  }

  async pruneAttachments(graceMs = ATTACHMENT_GRACE_MS): Promise<void> {
    const all = await readJson<Record<string, unknown>>(this.chatPath, {})
    const referenced = new Set<string>()
    for (const value of Object.values(all)) {
      for (const id of collectAttachmentIds(normalizeChatSession(value).messages)) referenced.add(id)
    }
    const now = Date.now()
    for (const [id, expiresAt] of this.pendingAttachmentIds) {
      if (expiresAt > now) referenced.add(id)
      else {
        this.pendingAttachmentIds.delete(id)
        this.pendingAttachmentDocuments.delete(id)
        this.attachmentMimeTypes.delete(id)
      }
    }
    await this.attachmentStore.prune(referenced, graceMs)
  }

  async saveRequestAttachments(uploads: unknown, documentId: string): Promise<AiAttachment[]> {
    const normalized = normalizeAttachmentUploads(uploads)
    if (!normalized.length) return []
    const saved = await this.attachmentStore.save(normalized)
    const expiresAt = Date.now() + ATTACHMENT_GRACE_MS
    for (const attachment of saved) {
      this.pendingAttachmentIds.set(attachment.id, expiresAt)
      this.pendingAttachmentDocuments.set(attachment.id, documentId)
      this.attachmentMimeTypes.set(attachment.id, attachment.mimeType)
    }
    featureLog(
      'request attachments saved count=%s bytes=%s types=%s',
      saved.length,
      saved.reduce((total, attachment) => total + attachment.byteSize, 0),
      Array.from(new Set(saved.map(attachment => attachment.mimeType === 'application/pdf' ? 'pdf' : 'image'))).sort().join('+') || 'none'
    )
    return saved
  }

  async hydrateProviderMessages(
    messages: Array<{ role: 'user' | 'assistant'; content: string; reasoning?: string; attachments?: AiAttachment[]; toolCalls?: ProviderToolCall[]; toolResults?: ProviderToolResult[] }>,
    priorityAttachmentIds: ReadonlySet<string> = new Set(),
    renderedPdfPages: readonly AiRenderedPdfPages[] = []
  ): Promise<ProviderMessage[]> {
    const imagesByMessage = new Map<number, ProviderImage[]>()
    const attachmentContextByMessage = new Map<number, string[]>()
    const renderedPdfPagesById = new Map(renderedPdfPages.map(item => [item.attachmentId, item]))
    const selected = new Set<string>()
    let attachmentCount = 0
    let totalBytes = 0
    const addAttachment = async(
      index: number,
      attachment: AiAttachment,
      required: boolean
    ): Promise<void> => {
      if (selected.has(attachment.id)) return
      try {
        if (attachment.mimeType === 'application/pdf') {
          const prepared = renderedPdfPagesById.get(attachment.id)
          if (!prepared) {
            if (required) throw new Error('The current PDF pages could not be prepared.')
            return
          }
          const pages = prepared.pages.map(page => normalizeImageUpload(page))
          const pageNumbers = [...prepared.pageNumbers].sort((a, b) => a - b)
          const selectedPages = [...(attachment.pages ?? pageNumbers)].sort((a, b) => a - b)
          if (
            pages.length !== pageNumbers.length ||
            pageNumbers.length !== selectedPages.length ||
            pageNumbers.some((page, index) => page !== selectedPages[index])
          ) {
            throw new Error('The rendered PDF pages do not match the selected pages.')
          }
          const pageBytes = pages.reduce((total, page) => total + page.byteSize, 0)
          if (
            !pages.length ||
            attachmentCount + pages.length > AI_MAX_IMAGE_COUNT ||
            totalBytes + pageBytes > AI_MAX_IMAGE_TOTAL_BYTES
          ) {
            if (required) throw new Error('The selected attachments exceed the attachment context limit.')
            return
          }
          selected.add(attachment.id)
          attachmentCount += pages.length
          totalBytes += pageBytes
          const images = imagesByMessage.get(index) ?? []
          images.push(...pages.map(page => ({
            mimeType: page.mimeType,
            data: Buffer.from(page.data).toString('base64')
          })))
          imagesByMessage.set(index, images)
          const contexts = attachmentContextByMessage.get(index) ?? []
          contexts.push(`The following images are rendered pages from the PDF attachment "${attachment.name}". Selected pages, in order: ${pageNumbers.join(', ')}. Treat these images as one document and do not infer content from unshown pages.`)
          attachmentContextByMessage.set(index, contexts)
          return
        }
        if (
          attachmentCount >= AI_MAX_IMAGE_COUNT ||
          totalBytes + attachment.byteSize > AI_MAX_IMAGE_TOTAL_BYTES
        ) {
          if (required) throw new Error('The selected attachments exceed the attachment context limit.')
          return
        }
        const stored = await this.attachmentStore.read(attachment.id, attachment.mimeType)
        if (stored.data.byteLength > AI_MAX_IMAGE_BYTES) {
          throw new Error('Image is too large.')
        }
        if (totalBytes + stored.data.byteLength > AI_MAX_IMAGE_TOTAL_BYTES) {
          if (required) throw new Error('The selected attachments exceed the attachment context limit.')
          return
        }
        selected.add(attachment.id)
        attachmentCount += 1
        totalBytes += stored.data.byteLength
        const images = imagesByMessage.get(index) ?? []
        images.push({ mimeType: stored.mimeType, data: Buffer.from(stored.data).toString('base64') })
        imagesByMessage.set(index, images)
      } catch (error) {
        if (required) throw new Error(`The current attachment could not be read. ${error instanceof Error ? error.message : String(error)}`)
        featureLog('historical attachment skipped reason=%s', error instanceof Error ? error.message : String(error))
      }
    }

    const ordered = orderAttachmentLocations(messages, priorityAttachmentIds)
    if (ordered.missing.length) throw new Error('The current attachment was not found.')
    for (const location of ordered.locations) {
      await addAttachment(location.index, location.attachment, location.required)
    }
    return messages.map((message, index) => ({
      role: message.role,
      content: message.content,
      reasoning: message.reasoning,
      toolCalls: message.toolCalls,
      toolResults: message.toolResults,
      images: imagesByMessage.get(index),
      attachmentContext: attachmentContextByMessage.get(index)?.join('\n')
    }))
  }

  async readAttachment(documentId: string, attachmentId: string): Promise<AiAttachmentData> {
    const all = await readJson<Record<string, unknown>>(this.chatPath, {})
    const messages = normalizeChatSession(all[documentId]).messages
    const metadata = messages.flatMap(message => message.attachments ?? []).find(attachment => attachment.id === attachmentId)
    const mimeType = metadata?.mimeType ?? this.attachmentMimeTypes.get(attachmentId)
    if (!mimeType) throw new Error('Attachment was not found.')
    return this.attachmentStore.read(attachmentId, mimeType)
  }
}
