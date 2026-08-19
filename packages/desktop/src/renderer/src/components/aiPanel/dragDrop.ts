export const hasFilePayload = (event: DragEvent): boolean =>
  !!event.dataTransfer &&
  (Array.from(event.dataTransfer.types).includes('Files') ||
    event.dataTransfer.files.length > 0 ||
    Array.from(event.dataTransfer.items).some((item) => item.kind === 'file'))

export const isInsidePanel = (event: DragEvent, panel: HTMLElement | null): boolean => {
  if (!panel) return false
  const rect = panel.getBoundingClientRect()
  return (
    event.clientX >= rect.left &&
    event.clientX <= rect.right &&
    event.clientY >= rect.top &&
    event.clientY <= rect.bottom
  )
}

export const stopPanelFileDrag = (event: DragEvent, panel: HTMLElement | null): boolean => {
  if (!hasFilePayload(event) || !isInsidePanel(event, panel)) return false
  event.preventDefault()
  event.stopPropagation()
  event.stopImmediatePropagation()
  return true
}
