<template>
  <aside
    v-if="marker?.visible && marker.ranges.length"
    class="ai-gutter"
    :aria-label="marker.status === 'unsaved' ? 'Unsaved AI changes' : 'Saved AI changes'"
  >
    <button
      v-for="block in changedBlocks"
      :key="`${marker.revisionId}-${block.index}`"
      class="ai-gutter-marker"
      :class="marker.status"
      :style="{ top: `${block.top}px`, height: `${block.height}px` }"
      type="button"
      :title="markerTitle(block)"
      :aria-label="markerTitle(block)"
      @click="ai.navigateToChange(block.startLine)"
    />
  </aside>
</template>

<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { useAiStore } from '@/store/ai'
import { useEditorStore } from '@/store/editor'
import type { AiChangeRange } from '@/store/aiChangeTracker'

interface ChangedBlock {
  index: number
  top: number
  height: number
  startLine: number
}

const ai = useAiStore()
const editorStore = useEditorStore()
const { currentChangeMarker } = storeToRefs(ai)
const { currentFile } = storeToRefs(editorStore)
const marker = currentChangeMarker

const changedBlocks = ref<ChangedBlock[]>([])

let scrollContainer: HTMLElement | null = null
let scrollHandler: (() => void) | null = null
let resizeObserver: ResizeObserver | null = null

// Find the editor's scroll container within the shared parent `.container`.
// Deferred: the <editor> sibling may not be mounted yet when this component
// first renders, so we look it up lazily on the first compute call.
const findScrollContainer = (): HTMLElement | null => {
  const overview = document.querySelector('.ai-gutter')
  if (!overview) return null
  const container = overview.parentElement
  if (!container) return null
  return container.querySelector<HTMLElement>('.editor-component')
}

const computeBlocks = (): void => {
  if (!marker.value?.visible || !marker.value.ranges.length) {
    changedBlocks.value = []
    return
  }

  // Lazily find the scroll container if not yet bound.
  if (!scrollContainer) {
    scrollContainer = findScrollContainer()
    if (scrollContainer) {
      scrollHandler = scheduleCompute
      scrollContainer.addEventListener('scroll', scrollHandler, { passive: true })
      resizeObserver = new ResizeObserver(scheduleCompute)
      resizeObserver.observe(scrollContainer)
    }
  }

  const container = scrollContainer
  if (!container) {
    changedBlocks.value = []
    return
  }

  const muContainer = container.querySelector('.mu-container')
  if (!muContainer) {
    changedBlocks.value = []
    return
  }

  const children = muContainer.children
  if (!children.length) {
    changedBlocks.value = []
    return
  }

  const scrollTop = container.scrollTop
  const containerRect = container.getBoundingClientRect()
  const containerTop = containerRect.top + scrollTop

  const blocks: ChangedBlock[] = []
  let lineStart = 1

  for (let i = 0; i < children.length; i++) {
    const el = children[i] as HTMLElement
    const text = el.textContent ?? ''
    const lineCount = Math.max(1, text.split('\n').length)
    const lineEnd = lineStart + lineCount - 1

    const overlaps = marker.value.ranges.some(
      (range: AiChangeRange) => lineStart <= range.endLine && lineEnd >= range.startLine
    )

    if (overlaps) {
      const elRect = el.getBoundingClientRect()
      blocks.push({
        index: i,
        top: elRect.top - containerTop + scrollTop,
        height: elRect.height,
        startLine: lineStart
      })
    }

    lineStart = lineEnd + 1
  }

  changedBlocks.value = blocks
}

const markerTitle = (block: ChangedBlock): string => {
  const status = marker.value?.status === 'saved' ? 'Saved' : 'Unsaved'
  return `${status} AI change · line ${block.startLine}`
}

const scheduleCompute = (): void => {
  nextTick(computeBlocks)
}

watch(marker, scheduleCompute)
watch(() => currentFile.value?.markdown, scheduleCompute)

onBeforeUnmount(() => {
  if (scrollHandler && scrollContainer) {
    scrollContainer.removeEventListener('scroll', scrollHandler)
  }
  scrollHandler = null
  resizeObserver?.disconnect()
  resizeObserver = null
  scrollContainer = null
})
</script>

<style scoped>
.ai-gutter {
  position: absolute;
  left: 0;
  top: 0;
  width: 14px;
  pointer-events: none;
  z-index: 5;
}

.ai-gutter-marker {
  position: absolute;
  left: 4px;
  width: 3px;
  padding: 0;
  border: 0;
  border-radius: 2px;
  cursor: pointer;
  pointer-events: auto;
  opacity: 0.85;
  transition: width 0.1s ease;
}

.ai-gutter-marker.unsaved,
.ai-gutter-marker.saved {
  background: #28a86b;
}

.ai-gutter-marker:hover,
.ai-gutter-marker:focus-visible {
  width: 6px;
  left: 2px;
  opacity: 1;
  outline: 2px solid var(--editorColor);
  outline-offset: 1px;
}
</style>
