import { describe, expect, it } from 'vitest'
import {
  defaultPdfPages,
  formatPdfPageSelection,
  parsePdfPageSelection
} from '@/store/pdfPageSelection'

describe('AI PDF page selection', () => {
  it('defaults short PDFs to all pages', () => {
    expect(defaultPdfPages(3)).toEqual([1, 2, 3])
    expect(defaultPdfPages(10)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    expect(defaultPdfPages(11)).toEqual([])
  })

  it('parses comma-separated pages and ranges', () => {
    expect(parsePdfPageSelection('1, 3, 5-8', 10)).toEqual([1, 3, 5, 6, 7, 8])
    expect(parsePdfPageSelection('8-9,1,9', 10)).toEqual([1, 8, 9])
    expect(formatPdfPageSelection([1, 3, 5, 6, 7, 8])).toBe('1,3,5-8')
  })

  it('rejects invalid selections and more than ten pages', () => {
    expect(() => parsePdfPageSelection('', 10)).toThrow()
    expect(() => parsePdfPageSelection('0,1', 10)).toThrow()
    expect(() => parsePdfPageSelection('4-2', 10)).toThrow()
    expect(() => parsePdfPageSelection('1,11', 10)).toThrow()
    expect(() => parsePdfPageSelection('1-11', 20)).toThrow(/10/i)
  })
})
