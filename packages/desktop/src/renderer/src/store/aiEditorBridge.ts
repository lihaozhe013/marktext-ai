import type { AiEditorSurface } from './aiEditSession'

export interface AiApplyPayload {
  tabId: string
  surface: AiEditorSurface
  mode: 'edit' | 'undo'
  beforeMarkdown: string
  markdown: string
  onApplied: (success: boolean, markdown?: string) => void
}

export interface AiEditorSurfaceAdapter {
  surface: AiEditorSurface
  getTabId: () => string | null | undefined
  setLocked: (locked: boolean) => void
  applyMarkdown: (request: AiApplyPayload) => string | undefined
}

export interface AiEditorSurfaceController {
  setLocked: (locked: boolean) => void
  handleApply: (payload: unknown) => void
}

export const completeAiApply = (
  callback: AiApplyPayload['onApplied']
): AiApplyPayload['onApplied'] => {
  let completed = false
  return (success, markdown) => {
    if (completed) return
    completed = true
    callback(success, markdown)
  }
}

export const createAiEditorSurfaceController = (
  adapter: AiEditorSurfaceAdapter
): AiEditorSurfaceController => ({
  setLocked: adapter.setLocked,
  handleApply: (payload: unknown): void => {
    const request = payload as Partial<AiApplyPayload> | null | undefined
    if (!request || request.surface !== adapter.surface) return

    const onApplied =
      typeof request.onApplied === 'function' ? completeAiApply(request.onApplied) : undefined
    if (!onApplied || typeof request.tabId !== 'string' || typeof request.markdown !== 'string') { return }

    if (adapter.getTabId() !== request.tabId) {
      onApplied(false)
      return
    }

    try {
      const appliedMarkdown = adapter.applyMarkdown(request as AiApplyPayload)
      onApplied(true, appliedMarkdown ?? request.markdown)
    } catch (error) {
      console.error(`[ai-editor] ${adapter.surface} Markdown apply failed`, error)
      onApplied(false)
    }
  }
})
