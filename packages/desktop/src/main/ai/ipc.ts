import { BrowserWindow, ipcMain } from 'electron'
import type {
  AiChatSession,
  AiConnectionInput,
  AiModelListInput,
  AiProgressEvent,
  AiRequest,
  AiRevisionRequest,
  AiSettings
} from '@shared/types/ai'
import type { AiService } from './index'
import { featureLog } from './logging'

type AiIpcService = Pick<
  AiService,
  | 'getSettings'
  | 'setEditAutoRetryCount'
  | 'setEditAgentMaxSteps'
  | 'setFailureOutputAfter'
  | 'saveConnection'
  | 'deleteConnection'
  | 'deleteConnectionKey'
  | 'setDefaultModel'
  | 'testConnection'
  | 'listModels'
  | 'request'
  | 'cancel'
  | 'loadChat'
  | 'saveChat'
  | 'clearChat'
  | 'readAttachment'
  | 'prepareRevision'
  | 'commitRevision'
  | 'discardRevision'
  | 'undoRevision'
  | 'migrateDocumentIdentity'
>

const broadcastSettings = (settings: AiSettings): void => {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('mt::ai-settings-changed', settings)
  }
}

export const registerAiIpcHandlers = (aiService: AiIpcService): void => {
  ipcMain.handle('mt::ai::get-settings', () => aiService.getSettings())
  ipcMain.handle('mt::ai::set-edit-retry-count', async(_event, retryCount: number) => {
    const saved = await aiService.setEditAutoRetryCount(retryCount)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::set-edit-agent-max-steps', async(_event, maxSteps: number) => {
    const saved = await aiService.setEditAgentMaxSteps(maxSteps)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::set-failure-output-after', async(_event, failureCount: number) => {
    const saved = await aiService.setFailureOutputAfter(failureCount)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::save-connection', async(_event, connection: AiConnectionInput) => {
    const saved = await aiService.saveConnection(connection)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::delete-connection', async(_event, connectionId: string) => {
    const saved = await aiService.deleteConnection(connectionId)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::delete-connection-key', async(_event, connectionId: string) => {
    const saved = await aiService.deleteConnectionKey(connectionId)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::set-default-model', async(_event, modelRef) => {
    const saved = await aiService.setDefaultModel(modelRef)
    broadcastSettings(saved)
    return saved
  })
  ipcMain.handle('mt::ai::test-connection', (_event, connection: AiConnectionInput) =>
    aiService.testConnection(connection)
  )
  ipcMain.handle('mt::ai::list-models', (_event, connection: AiModelListInput) =>
    aiService.listModels(connection)
  )
  ipcMain.handle('mt::ai::request', (event, request: AiRequest) =>
    aiService.request(request, (progress) => {
      if (!event.sender.isDestroyed()) { event.sender.send('mt::ai::progress', progress as AiProgressEvent) }
    })
  )
  ipcMain.on('mt::ai::cancel', (_event, requestId: string) => aiService.cancel(requestId))
  ipcMain.handle('mt::ai::chat-load', (_event, documentId: string) =>
    aiService.loadChat(documentId)
  )
  ipcMain.handle('mt::ai::chat-save', (_event, documentId: string, session: AiChatSession) =>
    aiService.saveChat(documentId, session)
  )
  ipcMain.handle('mt::ai::chat-clear', (_event, documentId: string) =>
    aiService.clearChat(documentId)
  )
  ipcMain.handle('mt::ai::attachment-read', (_event, documentId: string, attachmentId: string) =>
    aiService.readAttachment(documentId, attachmentId)
  )
  ipcMain.handle('mt::ai::revision-prepare', (_event, request: AiRevisionRequest) =>
    aiService.prepareRevision(request)
  )
  ipcMain.handle(
    'mt::ai::revision-commit',
    (_event, revisionId: string, documentId: string, afterMarkdown: string) =>
      aiService.commitRevision(revisionId, documentId, afterMarkdown)
  )
  ipcMain.handle('mt::ai::revision-discard', (_event, revisionId: string) =>
    aiService.discardRevision(revisionId)
  )
  ipcMain.handle('mt::ai::revision-undo', (_event, documentId: string, currentMarkdown: string) =>
    aiService.undoRevision(documentId, currentMarkdown)
  )
  ipcMain.handle(
    'mt::ai::revision-migrate',
    (_event, fromDocumentId: string, toDocumentId: string) =>
      aiService.migrateDocumentIdentity(fromDocumentId, toDocumentId)
  )
  featureLog('IPC handlers registered')
}
