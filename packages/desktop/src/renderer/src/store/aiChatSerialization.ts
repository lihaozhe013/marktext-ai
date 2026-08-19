import type { AiChatMessage, AiProgressInfo } from '@shared/types/ai'

export const toIpcAiProgress = (progress: AiProgressInfo): AiProgressInfo => ({
  ...progress,
  planStepDescriptions: progress.planStepDescriptions
    ? [...progress.planStepDescriptions]
    : undefined
})

export const toIpcChatMessage = (message: AiChatMessage): AiChatMessage => ({
  id: message.id,
  role: message.role,
  mode: message.mode,
  content: message.content,
  reasoning: message.reasoning,
  createdAt: message.createdAt,
  revisionId: message.revisionId,
  kind: message.kind,
  progress: message.progress ? toIpcAiProgress(message.progress) : undefined,
  attachments: message.attachments?.map(attachment => ({
    ...attachment,
    ...(attachment.mimeType === 'application/pdf' && attachment.pages ? { pages: [...attachment.pages] } : {})
  })),
  model: message.model ? { ...message.model } : undefined,
  editSummary: message.editSummary
    ? {
      operationCount: message.editSummary.operationCount,
      addedLines: message.editSummary.addedLines,
      removedLines: message.editSummary.removedLines,
      operations: message.editSummary.operations.map(operation => ({ ...operation }))
    }
    : undefined
})

export const toIpcChatMessages = (items: readonly AiChatMessage[]): AiChatMessage[] =>
  items.map(toIpcChatMessage)
