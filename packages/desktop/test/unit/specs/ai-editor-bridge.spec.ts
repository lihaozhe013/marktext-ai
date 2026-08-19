import { describe, expect, it, vi } from 'vitest'
import {
  completeAiApply,
  createAiEditorSurfaceController,
  type AiApplyPayload
} from '@/store/aiEditorBridge'

const request = (overrides: Partial<AiApplyPayload> = {}): AiApplyPayload => ({
  tabId: 'tab-1',
  surface: 'wysiwyg',
  mode: 'edit',
  beforeMarkdown: 'before',
  markdown: 'after',
  onApplied: vi.fn(),
  ...overrides
})

describe('AI editor bridge', () => {
  it('applies only to the active surface and tab', () => {
    const applyMarkdown = vi.fn(() => 'after')
    const onApplied = vi.fn()
    const controller = createAiEditorSurfaceController({
      surface: 'wysiwyg',
      getTabId: () => 'tab-1',
      setLocked: vi.fn(),
      applyMarkdown
    })

    controller.handleApply(request({ onApplied }))
    controller.handleApply(request({ surface: 'source', onApplied }))
    controller.handleApply(request({ tabId: 'tab-2', onApplied }))

    expect(applyMarkdown).toHaveBeenCalledTimes(1)
    expect(onApplied).toHaveBeenCalledTimes(2)
    expect(onApplied).toHaveBeenNthCalledWith(1, true, 'after')
    expect(onApplied).toHaveBeenNthCalledWith(2, false, undefined)
  })

  it('completes an apply callback at most once', () => {
    const onApplied = vi.fn()
    const complete = completeAiApply(onApplied)

    complete(true, 'after')
    complete(false)

    expect(onApplied).toHaveBeenCalledOnce()
    expect(onApplied).toHaveBeenCalledWith(true, 'after')
  })

  it('reports adapter failures without leaving the caller pending', () => {
    const onApplied = vi.fn()
    const controller = createAiEditorSurfaceController({
      surface: 'wysiwyg',
      getTabId: () => 'tab-1',
      setLocked: vi.fn(),
      applyMarkdown: () => {
        throw new Error('apply failed')
      }
    })

    controller.handleApply(request({ onApplied }))

    expect(onApplied).toHaveBeenCalledWith(false, undefined)
  })
})
