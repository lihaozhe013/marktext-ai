import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
import { launchWithMarkdown } from './helpers'

const dispatchFileEvent = async(page: Page, eventType: 'dragover' | 'drop', selector: string, name: string, type: string, coordinateSelector = selector): Promise<boolean> => {
  return await page.evaluate(({ selector: targetSelector, coordinateSelector: pointSelector, eventType, name: fileName, type: fileType }) => {
    const target = document.querySelector(targetSelector)
    const pointTarget = document.querySelector(pointSelector)
    if (!(target instanceof HTMLElement) || !(pointTarget instanceof HTMLElement)) return false
    const rect = pointTarget.getBoundingClientRect()
    const transfer = new DataTransfer()
    const content = fileType === 'application/pdf'
      ? '%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF'
      : 'attachment'
    transfer.items.add(new File([content], fileName, { type: fileType }))
    return target.dispatchEvent(new DragEvent(eventType, {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2
    }))
  }, { selector, coordinateSelector, eventType, name, type })
}

test.describe('AI Panel attachment isolation', () => {
  let app: ElectronApplication
  let page: Page

  test.beforeEach(async() => {
    const launched = await launchWithMarkdown('# Attachment test\n\n')
    app = launched.app
    page = launched.page
    await page.waitForSelector('.ai-panel', { state: 'visible' })
  })

  test.afterEach(async() => {
    await app.close()
  })

  test('accepts file drops anywhere in the panel without opening MarkText import', async() => {
    const targets = ['.ai-header', '.ai-mode-switch', '.ai-messages', '.ai-composer']
    for (const [index, selector] of targets.entries()) {
      const notCancelled = await dispatchFileEvent(page, 'drop', selector, `image-${index}.png`, 'image/png')
      expect(notCancelled).toBe(false)
    }

    await expect(page.locator('.ai-pending-attachment')).toHaveCount(targets.length)
    await expect(page.locator('.import-dialog .el-overlay')).toBeHidden()
  })

  test('opens the native file picker from the attachment label', async() => {
    const chooserPromise = page.waitForEvent('filechooser')
    await page.locator('label.ai-attachment-dropzone').click()
    const chooser = await chooserPromise
    await chooser.setFiles({
      name: 'selected.png',
      mimeType: 'image/png',
      buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    })

    await expect(page.locator('.ai-pending-attachment')).toHaveCount(1)
  })

  test('takes over after the global import overlay was opened first', async() => {
    const initialNotCancelled = await dispatchFileEvent(page, 'dragover', '.editor-component', 'document.pdf', 'application/pdf')
    expect(initialNotCancelled).toBe(false)
    await expect(page.locator('.import-dialog .el-overlay')).toBeVisible()

    const panelNotCancelled = await dispatchFileEvent(
      page,
      'dragover',
      '.import-dialog .el-overlay',
      'document.pdf',
      'application/pdf',
      '.ai-panel'
    )
    expect(panelNotCancelled).toBe(false)

    const dropNotCancelled = await dispatchFileEvent(
      page,
      'drop',
      '.import-dialog .el-overlay',
      'document.pdf',
      'application/pdf',
      '.ai-panel'
    )
    expect(dropNotCancelled).toBe(false)
    await expect(page.locator('.ai-pending-attachment')).toHaveCount(1)
    await expect(page.locator('.import-dialog .el-overlay')).toBeHidden()
  })

  test('keeps the existing global import behavior outside the panel', async() => {
    const notCancelled = await dispatchFileEvent(page, 'dragover', '.editor-component', 'document.md', 'text/markdown')
    expect(notCancelled).toBe(false)
    await expect(page.locator('.import-dialog .el-overlay')).toBeVisible()
  })
})
