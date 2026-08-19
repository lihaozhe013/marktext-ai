import { afterEach, describe, expect, it } from 'vitest'
import { ref } from 'vue'
import bus from '@/bus'
import { AiChangeTracker, fullDocumentRange } from '@/store/aiChangeTracker'
import { createAiChangeController } from '@/store/aiChangeController'

describe('AI change controller', () => {
  const controllers: Array<{ dispose: () => void }> = []

  afterEach(() => {
    controllers.splice(0).forEach(controller => controller.dispose())
  })

  it('tracks save sequence and document markers through the existing bus events', () => {
    const tracker = new AiChangeTracker()
    tracker.apply('tab-1', 'revision-1', 'before', 'after', fullDocumentRange('after'))
    const controller = createAiChangeController({
      tracker,
      changeVersion: ref(0),
      getCurrentTabId: () => 'tab-1',
      getSession: () => null,
      getExpectedMarkdown: () => undefined,
      markSessionStale: () => undefined
    })
    controllers.push(controller)

    bus.emit('ai-document-saved', 'tab-1')

    expect(controller.getSaveSequence()).toBe(1)
    expect(controller.getLastSavedSequence('tab-1')).toBe(1)
    expect(controller.currentChangeMarker.value?.status).toBe('saved')
  })

  it('stops listening after disposal', () => {
    const tracker = new AiChangeTracker()
    const controller = createAiChangeController({
      tracker,
      changeVersion: ref(0),
      getCurrentTabId: () => 'tab-1',
      getSession: () => null,
      getExpectedMarkdown: () => undefined,
      markSessionStale: () => undefined
    })

    controller.dispose()
    bus.emit('ai-document-saved', 'tab-1')

    expect(controller.getSaveSequence()).toBe(0)
  })
})
