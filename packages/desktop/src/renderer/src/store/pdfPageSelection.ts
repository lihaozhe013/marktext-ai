import {
  AI_MAX_IMAGE_COUNT
} from '@shared/types/ai'

export class PdfPageSelectionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PdfPageSelectionError'
  }
}

export const defaultPdfPages = (pageCount: number): number[] =>
  pageCount > 0 && pageCount <= AI_MAX_IMAGE_COUNT
    ? Array.from({ length: pageCount }, (_, index) => index + 1)
    : []

export const formatPdfPageSelection = (pages: readonly number[]): string => {
  const sorted = Array.from(new Set(pages)).sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0]
  let end = sorted[0]
  for (const page of sorted.slice(1)) {
    if (page === end + 1) {
      end = page
      continue
    }
    parts.push(start === end ? `${start}` : `${start}-${end}`)
    start = page
    end = page
  }
  if (start !== undefined) parts.push(start === end ? `${start}` : `${start}-${end}`)
  return parts.join(',')
}

export const parsePdfPageSelection = (value: string, pageCount: number): number[] => {
  const input = value.trim()
  if (!input) throw new PdfPageSelectionError('Choose at least one PDF page.')
  const pages = new Set<number>()
  for (const part of input.split(',')) {
    const token = part.trim()
    if (!/^\d+(?:\s*-\s*\d+)?$/.test(token)) {
      throw new PdfPageSelectionError('Use page numbers and ranges such as 1,3,5-8.')
    }
    const [startText, endText] = token.split('-').map(item => item.trim())
    const start = Number(startText)
    const end = endText === undefined ? start : Number(endText)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > pageCount) {
      throw new PdfPageSelectionError(`PDF pages must be between 1 and ${pageCount}.`)
    }
    for (let page = start; page <= end; page += 1) {
      pages.add(page)
      if (pages.size > AI_MAX_IMAGE_COUNT) {
        throw new PdfPageSelectionError(`Select no more than ${AI_MAX_IMAGE_COUNT} PDF pages.`)
      }
    }
  }
  return Array.from(pages).sort((a, b) => a - b)
}
