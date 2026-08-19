import { describe, expect, it, vi } from 'vitest'
import { reactive } from 'vue'
import { createAiChatPersistenceQueue } from '@/store/aiChatPersistence'
import { toIpcChatMessage } from '@/store/aiChatSerialization'

describe('AI chat persistence queue', () => {
  it('runs delayed saves in enqueue order', async() => {
    const calls: string[] = []
    let releaseFirst: (() => void) | undefined
    const queue = createAiChatPersistenceQueue(vi.fn())

    const first = queue.enqueue(() => new Promise<void>(resolve => {
      calls.push('plan')
      releaseFirst = resolve
    }))
    const second = queue.enqueue(async() => {
      calls.push('step')
    })

    await Promise.resolve()
    expect(calls).toEqual(['plan'])
    releaseFirst?.()
    await Promise.all([first, second])
    expect(calls).toEqual(['plan', 'step'])
  })

  it('continues after a failed save', async() => {
    const errors: unknown[] = []
    const calls: string[] = []
    const queue = createAiChatPersistenceQueue(error => errors.push(error))

    await Promise.all([
      queue.enqueue(async() => {
        calls.push('failed')
        throw new Error('disk full')
      }),
      queue.enqueue(async() => {
        calls.push('completed')
      })
    ])

    expect(calls).toEqual(['failed', 'completed'])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toBeInstanceOf(Error)
  })

  it('converts plan descriptions to cloneable data for the next request', () => {
    const message = reactive({
      id: 'plan-message',
      role: 'assistant' as const,
      mode: 'edit' as const,
      content: '',
      createdAt: 1,
      kind: 'status' as const,
      progress: {
        phase: 'agent-plan' as const,
        planStepDescriptions: ['Add the introduction', 'Add the comparison']
      }
    })

    const copied = toIpcChatMessage(message)

    expect(copied.progress?.planStepDescriptions).toEqual([
      'Add the introduction',
      'Add the comparison'
    ])
    expect(copied.progress?.planStepDescriptions).not.toBe(message.progress.planStepDescriptions)
    expect(() => structuredClone(copied)).not.toThrow()
  })
})
