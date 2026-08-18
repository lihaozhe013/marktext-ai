import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist'
import pdfWorkerSrc from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type { AiImageUpload } from '@shared/types/ai'
import {
  AI_MAX_IMAGE_BYTES,
  AI_MAX_IMAGE_TOTAL_BYTES,
  AI_PDF_RENDER_DPI,
  AI_PDF_RENDER_MAX_EDGE
} from '@shared/types/ai'
export {
  defaultPdfPages,
  formatPdfPageSelection,
  parsePdfPageSelection,
  PdfPageSelectionError
} from './pdfPageSelection'
import {
  formatPdfPageSelection,
  parsePdfPageSelection
} from './pdfPageSelection'

GlobalWorkerOptions.workerSrc = pdfWorkerSrc

const loadPdf = async(data: Uint8Array) => {
  const loadingTask = getDocument({
    data: new Uint8Array(data),
    useWorkerFetch: false
  })
  try {
    return await loadingTask.promise
  } catch (error) {
    await loadingTask.destroy().catch(() => undefined)
    throw error
  }
}

export const getPdfPageCount = async(data: Uint8Array): Promise<number> => {
  const pdfDocument = await loadPdf(data)
  try {
    return pdfDocument.numPages
  } finally {
    await pdfDocument.cleanup()
  }
}

export const renderPdfPages = async(
  data: Uint8Array,
  pageNumbers: readonly number[],
  filename: string
): Promise<{ pageCount: number; pages: AiImageUpload[] }> => {
  const pdfDocument = await loadPdf(data)
  try {
    const pageCount = pdfDocument.numPages
    const selectedPages = parsePdfPageSelection(formatPdfPageSelection(pageNumbers), pageCount)
    const pages: AiImageUpload[] = []
    let totalBytes = 0
    for (const pageNumber of selectedPages) {
      const page = await pdfDocument.getPage(pageNumber)
      const baseViewport = page.getViewport({ scale: AI_PDF_RENDER_DPI / 72 })
      const maxDimension = Math.max(baseViewport.width, baseViewport.height)
      const scale = Math.min(1, AI_PDF_RENDER_MAX_EDGE / maxDimension)
      const viewport = page.getViewport({ scale: (AI_PDF_RENDER_DPI / 72) * scale })
      const canvas = globalThis.document.createElement('canvas')
      canvas.width = Math.ceil(viewport.width)
      canvas.height = Math.ceil(viewport.height)
      const context = canvas.getContext('2d', { alpha: false })
      if (!context) throw new Error('The PDF page renderer could not create a canvas.')
      context.fillStyle = '#ffffff'
      context.fillRect(0, 0, canvas.width, canvas.height)
      await page.render({ canvas, canvasContext: context, viewport }).promise
      const blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(result => result ? resolve(result) : reject(new Error('The PDF page renderer returned no image.')), 'image/png')
      })
      const pageData = new Uint8Array(await blob.arrayBuffer())
      if (!pageData.byteLength || pageData.byteLength > AI_MAX_IMAGE_BYTES) {
        throw new Error('A rendered PDF page exceeds the 10 MB image limit.')
      }
      totalBytes += pageData.byteLength
      if (totalBytes > AI_MAX_IMAGE_TOTAL_BYTES) {
        throw new Error('Rendered PDF pages exceed the 30 MB request limit.')
      }
      pages.push({
        id: `${crypto.randomUUID()}-p${pageNumber}`,
        name: `${filename} page ${pageNumber}`,
        mimeType: 'image/png',
        byteSize: pageData.byteLength,
        data: pageData
      })
      canvas.width = 0
      canvas.height = 0
      page.cleanup()
    }
    return { pageCount, pages }
  } finally {
    await pdfDocument.cleanup()
  }
}
