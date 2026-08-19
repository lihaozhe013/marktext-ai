export const formatPages = (pages: readonly number[]): string => {
  const sorted = Array.from(new Set(pages)).sort((a, b) => a - b)
  const parts: string[] = []
  let start = sorted[0]
  let end = sorted[0]
  for (const page of sorted.slice(1)) {
    if (page === end + 1) end = page
    else {
      parts.push(start === end ? `${start}` : `${start}-${end}`)
      start = page
      end = page
    }
  }
  if (start !== undefined) parts.push(start === end ? `${start}` : `${start}-${end}`)
  return `p. ${parts.join(',')}`
}

export const makeUnifiedDiff = (before: string, after: string): string => {
  const oldLines = before.replaceAll('\r\n', '\n').split('\n')
  const newLines = after.replaceAll('\r\n', '\n').split('\n')
  const prefix = (() => {
    let index = 0
    while (
      index < oldLines.length &&
      index < newLines.length &&
      oldLines[index] === newLines[index]
    ) { index += 1 }
    return index
  })()
  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - suffix - 1] === newLines[newLines.length - suffix - 1]
  ) { suffix += 1 }
  const oldChanged = oldLines.slice(prefix, oldLines.length - suffix)
  const newChanged = newLines.slice(prefix, newLines.length - suffix)
  const contextBefore = oldLines.slice(Math.max(0, prefix - 3), prefix).map((line) => ` ${line}`)
  const contextAfter = oldLines
    .slice(oldLines.length - suffix, Math.min(oldLines.length, oldLines.length - suffix + 3))
    .map((line) => ` ${line}`)
  const header = `@@ -${prefix + 1},${oldChanged.length} +${prefix + 1},${newChanged.length} @@`
  const body = [
    ...contextBefore,
    ...oldChanged.map((line) => `-${line}`),
    ...newChanged.map((line) => `+${line}`),
    ...contextAfter
  ]
  const result = [header, ...body].join('\n')
  return result.length > 12000 ? `${result.slice(0, 12000)}\n…` : result
}
