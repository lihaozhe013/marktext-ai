export interface AiChatPersistenceQueue {
  enqueue: (operation: () => Promise<void>) => Promise<void>
}

export const createAiChatPersistenceQueue = (
  onError: (error: unknown) => void
): AiChatPersistenceQueue => {
  let sequence: Promise<void> = Promise.resolve()

  return {
    enqueue(operation: () => Promise<void>): Promise<void> {
      sequence = sequence
        .then(async() => {
          try {
            await operation()
          } catch (error) {
            onError(error)
          }
        })
      return sequence
    }
  }
}
