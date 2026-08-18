import path from 'path'
import fsPromises from 'fs/promises'
import type {
  AiAttachment,
  AiAttachmentData,
  AiAttachmentUpload,
  AiImageAttachment,
  AiImageMimeType,
  AiImageUpload,
  AiPdfAttachment,
  AiPdfMimeType,
  AiPdfUpload
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

const ATTACHMENT_DIRECTORY = 'ai-attachments'
const ATTACHMENT_ID_REGEXP = /^[A-Za-z0-9_-]{16,80}$/
const MAX_NAME_LENGTH = 160

const EXTENSIONS: Record<AiImageMimeType | AiPdfMimeType, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'application/pdf': 'pdf'
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)

const toBytes = (value: unknown): Uint8Array => {
  if (value instanceof Uint8Array) return new Uint8Array(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0))
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength))
  }
  throw new Error('Attachment data is not a byte array.')
}

const hasBytes = (bytes: Uint8Array, expected: number[], offset = 0): boolean =>
  expected.every((value, index) => bytes[offset + index] === value)

const hasImageSignature = (mimeType: AiImageMimeType, bytes: Uint8Array): boolean => {
  if (mimeType === 'image/png') return bytes.length >= 8 && hasBytes(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (mimeType === 'image/jpeg') return bytes.length >= 3 && hasBytes(bytes, [0xff, 0xd8, 0xff])
  if (mimeType === 'image/webp') return bytes.length >= 12 && hasBytes(bytes, [0x52, 0x49, 0x46, 0x46]) && hasBytes(bytes, [0x57, 0x45, 0x42, 0x50], 8)
  return bytes.length >= 6 && (hasBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || hasBytes(bytes, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))
}

const hasPdfSignature = (bytes: Uint8Array): boolean => hasBytes(bytes, [0x25, 0x50, 0x44, 0x46, 0x2d])

const sanitizeName = (value: unknown, fallback: string): string => {
  const name = typeof value === 'string' ? value : ''
  const safe = name.replace(/[\\/\0]/g, '_').trim().slice(0, MAX_NAME_LENGTH)
  return safe || fallback
}

const isImageMimeType = (value: unknown): value is AiImageMimeType =>
  typeof value === 'string' && AI_IMAGE_MIME_TYPES.includes(value as AiImageMimeType)

const isPdfMimeType = (value: unknown): value is AiPdfMimeType =>
  typeof value === 'string' && AI_PDF_MIME_TYPES.includes(value as AiPdfMimeType)

const normalizePageSelection = (value: unknown): number[] | undefined => {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('Invalid PDF page selection.')
  const pages = value.filter((page): page is number => typeof page === 'number')
  if (pages.length !== value.length || pages.some(page => !Number.isInteger(page) || page < 1)) {
    throw new Error('Invalid PDF page selection.')
  }
  const unique = Array.from(new Set(pages)).sort((a, b) => a - b)
  if (!unique.length || unique.length > 10) throw new Error('A PDF can select up to 10 pages.')
  return unique
}

export const isSafeAttachmentId = (value: string): boolean => ATTACHMENT_ID_REGEXP.test(value)

const normalizeAttachmentMetadata = (value: unknown): AiAttachment => {
  if (!isRecord(value)) throw new Error('Invalid attachment.')
  const id = typeof value.id === 'string' ? value.id : ''
  if (!isSafeAttachmentId(id)) throw new Error('Invalid attachment ID.')
  const mimeType = value.mimeType
  const byteSize = value.byteSize
  if (typeof byteSize !== 'number' || !Number.isInteger(byteSize) || byteSize <= 0) {
    throw new Error('Invalid attachment size.')
  }
  if (isPdfMimeType(mimeType)) {
    if (byteSize > AI_MAX_PDF_BYTES) throw new Error('Invalid PDF attachment size.')
    return {
      id,
      name: sanitizeName(value.name, 'document.pdf'),
      mimeType,
      byteSize,
      pages: normalizePageSelection(value.pages)
    }
  }
  if (isImageMimeType(mimeType)) {
    if (byteSize > AI_MAX_IMAGE_BYTES) throw new Error('Invalid image attachment size.')
    return { id, name: sanitizeName(value.name, 'image'), mimeType, byteSize }
  }
  throw new Error('Unsupported attachment format. Use PNG, JPEG, WebP, GIF, or PDF.')
}

export const normalizeImageAttachment = (value: unknown): AiImageAttachment => {
  const attachment = normalizeAttachmentMetadata(value)
  if (!isImageMimeType(attachment.mimeType)) throw new Error('Unsupported image format. Use PNG, JPEG, WebP, or GIF.')
  return attachment as AiImageAttachment
}

export const normalizePdfAttachment = (value: unknown): AiPdfAttachment => {
  const attachment = normalizeAttachmentMetadata(value)
  if (!isPdfMimeType(attachment.mimeType)) throw new Error('Unsupported PDF format.')
  return attachment as AiPdfAttachment
}

const normalizeAttachmentUpload = (value: unknown): AiAttachmentUpload => {
  if (!isRecord(value)) throw new Error('Invalid attachment.')
  const data = toBytes(value.data)
  const metadata = normalizeAttachmentMetadata({
    id: value.id,
    name: value.name,
    mimeType: value.mimeType,
    byteSize: data.byteLength,
    pages: value.pages
  })
  if (!data.byteLength) throw new Error('Attachment data is empty.')
  if (isPdfMimeType(metadata.mimeType)) {
    if (!hasPdfSignature(data)) throw new Error('The PDF data does not match its declared format.')
  } else if (!hasImageSignature(metadata.mimeType, data)) {
    throw new Error('The image data does not match its declared format.')
  }
  return { ...metadata, byteSize: data.byteLength, data } as AiAttachmentUpload
}

export const normalizeImageUpload = (value: unknown): AiImageUpload => {
  const upload = normalizeAttachmentUpload(value)
  if (!isImageMimeType(upload.mimeType)) throw new Error('Unsupported image format. Use PNG, JPEG, WebP, or GIF.')
  return upload as AiImageUpload
}

export const normalizePdfUpload = (value: unknown): AiPdfUpload => {
  const upload = normalizeAttachmentUpload(value)
  if (!isPdfMimeType(upload.mimeType)) throw new Error('Unsupported PDF format.')
  return upload as AiPdfUpload
}

export const normalizeAttachmentUploads = (value: unknown): AiAttachmentUpload[] => {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error('Invalid attachments.')
  if (value.length > AI_MAX_IMAGE_COUNT) throw new Error(`You can attach up to ${AI_MAX_IMAGE_COUNT} files at a time.`)
  const uploads = value.map(normalizeAttachmentUpload)
  const ids = new Set<string>()
  for (const upload of uploads) {
    if (ids.has(upload.id)) throw new Error('Duplicate attachment ID.')
    ids.add(upload.id)
  }
  const imageBytes = uploads.filter(upload => isImageMimeType(upload.mimeType)).reduce((total, upload) => total + upload.byteSize, 0)
  const pdfBytes = uploads.filter(upload => isPdfMimeType(upload.mimeType)).reduce((total, upload) => total + upload.byteSize, 0)
  const totalBytes = imageBytes + pdfBytes
  if (imageBytes > AI_MAX_IMAGE_TOTAL_BYTES || pdfBytes > AI_MAX_PDF_TOTAL_BYTES || totalBytes > AI_MAX_IMAGE_TOTAL_BYTES) {
    throw new Error(`Attachments in one request must total less than ${AI_MAX_IMAGE_TOTAL_BYTES / (1024 * 1024)} MB.`)
  }
  return uploads
}

export const normalizeImageUploads = (value: unknown): AiImageUpload[] => {
  if (Array.isArray(value) && value.length > AI_MAX_IMAGE_COUNT) throw new Error(`You can attach up to ${AI_MAX_IMAGE_COUNT} images.`)
  const uploads = normalizeAttachmentUploads(value)
  if (uploads.some(upload => !isImageMimeType(upload.mimeType))) throw new Error('Only image attachments are supported here.')
  const totalBytes = uploads.reduce((total, upload) => total + upload.byteSize, 0)
  if (totalBytes > AI_MAX_IMAGE_TOTAL_BYTES) {
    throw new Error(`Images in one request must total less than ${AI_MAX_IMAGE_TOTAL_BYTES / (1024 * 1024)} MB.`)
  }
  return uploads as AiImageUpload[]
}

const toMetadata = (upload: AiAttachmentUpload): AiAttachment => ({
  id: upload.id,
  name: upload.name,
  mimeType: upload.mimeType,
  byteSize: upload.byteSize,
  ...(upload.mimeType === 'application/pdf' && upload.pages ? { pages: [...upload.pages] } : {})
})

export interface OrderedAttachmentLocation {
  index: number
  attachment: AiAttachment
  required: boolean
}

export const orderAttachmentLocations = (
  messages: ReadonlyArray<{ attachments?: AiAttachment[] }>,
  priorityIds: ReadonlySet<string>
): { locations: OrderedAttachmentLocation[]; missing: string[] } => {
  const byId = new Map<string, { index: number; attachment: AiAttachment }>()
  messages.forEach((message, index) => {
    for (const attachment of message.attachments ?? []) byId.set(attachment.id, { index, attachment })
  })
  const selected = new Set<string>()
  const locations: OrderedAttachmentLocation[] = []
  const missing: string[] = []
  for (const id of priorityIds) {
    const location = byId.get(id)
    if (!location) {
      missing.push(id)
      continue
    }
    selected.add(id)
    locations.push({ ...location, required: true })
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    for (const attachment of messages[index].attachments ?? []) {
      if (selected.has(attachment.id)) continue
      selected.add(attachment.id)
      locations.push({ index, attachment, required: false })
    }
  }
  return { locations, missing }
}

const isValidStoredData = (mimeType: AiImageMimeType | AiPdfMimeType, data: Uint8Array): boolean => {
  if (mimeType === 'application/pdf') return data.byteLength > 0 && data.byteLength <= AI_MAX_PDF_BYTES && hasPdfSignature(data)
  return data.byteLength > 0 && data.byteLength <= AI_MAX_IMAGE_BYTES && hasImageSignature(mimeType, data)
}

export class AiAttachmentStore {
  private readonly directory: string

  constructor(userDataPath: string) {
    this.directory = path.join(userDataPath, ATTACHMENT_DIRECTORY)
  }

  private filePath(id: string, mimeType: AiImageMimeType | AiPdfMimeType): string {
    return path.join(this.directory, `${id}.${EXTENSIONS[mimeType]}`)
  }

  async save(uploads: AiAttachmentUpload[]): Promise<AiAttachment[]> {
    const normalized = normalizeAttachmentUploads(uploads)
    if (!normalized.length) return []
    await fsPromises.mkdir(this.directory, { recursive: true, mode: 0o700 })
    try {
      await fsPromises.chmod(this.directory, 0o700)
    } catch {
      // chmod is best effort on filesystems that do not expose POSIX modes.
    }
    const written: string[] = []
    try {
      for (const upload of normalized) {
        const filePath = this.filePath(upload.id, upload.mimeType)
        await fsPromises.writeFile(filePath, upload.data, { flag: 'wx', mode: 0o600 })
        written.push(filePath)
      }
    } catch (error) {
      await Promise.all(written.map(filePath => fsPromises.unlink(filePath).catch(() => undefined)))
      throw error
    }
    return normalized.map(toMetadata)
  }

  async read(id: string, mimeType: AiImageMimeType | AiPdfMimeType): Promise<AiAttachmentData> {
    if (!isSafeAttachmentId(id) || (!isImageMimeType(mimeType) && !isPdfMimeType(mimeType))) throw new Error('Invalid attachment.')
    let data: Uint8Array
    try {
      data = new Uint8Array(await fsPromises.readFile(this.filePath(id, mimeType)))
    } catch {
      throw new Error('The stored attachment is unavailable.')
    }
    if (!isValidStoredData(mimeType, data)) throw new Error('The stored attachment is invalid.')
    return { mimeType, data } as AiAttachmentData
  }

  async prune(referencedIds: ReadonlySet<string>, graceMs: number): Promise<void> {
    let entries: { name: string; isFile(): boolean }[]
    try {
      entries = await fsPromises.readdir(this.directory, { withFileTypes: true })
    } catch {
      return
    }
    const now = Date.now()
    await Promise.all(entries.filter(entry => entry.isFile()).map(async(entry) => {
      const match = entry.name.match(/^([A-Za-z0-9_-]{16,80})\.(png|jpg|webp|gif|pdf)$/)
      if (!match || referencedIds.has(match[1])) return
      const filePath = path.join(this.directory, entry.name)
      try {
        const stat = await fsPromises.stat(filePath)
        if (now - stat.mtimeMs < graceMs) return
        await fsPromises.unlink(filePath)
      } catch {
        // A concurrent cleanup or an already removed orphan is harmless.
      }
    }))
  }
}
