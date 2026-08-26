import path from 'path'
import type {
  AiConnectionInput,
  AiModelRef,
  AiReasoningEffortPreference,
  AiSettings,
  AiVerbosityPreference
} from '@shared/types/ai'
import { featureLog, connectionLog } from './logging'
import { writeJsonAtomic } from './storage'
import { AiSettingsStore } from './settingsStore'
import {
  SETTINGS_SCHEMA_VERSION,
  firstStoredModelRef,
  hasStoredModelRef,
  isReasoningEffortPreference,
  isVerbosityPreference,
  normalizeContextMode,
  normalizeEditAgentMaxSteps,
  normalizeEditAutoRetryCount,
  normalizeFailureOutputAfter,
  normalizeStoredKeys,
  normalizeStoredSettings,
  resolveRequestBodyPreset,
  toPublicSettings,
  validateConnectionInput
} from './settingsConfig'
import type { ResolvedModelTarget, StoredConnection, StoredKeys, StoredSettings } from './types'

const SETTINGS_FILE = 'ai-connection.json'
const KEY_FILE = 'ai-connection-key.json'

export class AiSettingsService {
  private readonly settingsPath: string
  private readonly keyPath: string
  private readonly settingsStore: AiSettingsStore
  private settingsMutation: Promise<void> = Promise.resolve()

  constructor(userDataPath: string) {
    this.settingsPath = path.join(userDataPath, SETTINGS_FILE)
    this.keyPath = path.join(userDataPath, KEY_FILE)
    this.settingsStore = new AiSettingsStore(this.settingsPath, this.keyPath, {
      normalizeSettings: normalizeStoredSettings,
      normalizeKeys: normalizeStoredKeys,
      onMigration: connectionCount => featureLog('legacy connection settings migrated connectionCount=%s', connectionCount)
    })
  }

  private queueSettingsMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.settingsMutation.then(operation, operation)
    this.settingsMutation = result.then(() => undefined, () => undefined)
    return result
  }

  async readSettingsState(): Promise<{ settings: StoredSettings; keys: StoredKeys }> {
    return this.settingsStore.read()
  }

  async resolveModelTarget(modelRef: AiModelRef, state?: { settings: StoredSettings; keys: StoredKeys }): Promise<ResolvedModelTarget> {
    const current = state ?? await this.readSettingsState()
    const connection = current.settings.connections.find(item => item.id === modelRef.connectionId)
    if (!connection) throw new Error('The selected AI connection no longer exists.')
    const model = connection.models.find(item => item.id === modelRef.modelId)
    if (!model) throw new Error('The selected AI model no longer exists.')
    const apiKey = current.keys[connection.id] ?? ''
    if (!apiKey) throw new Error(`Configure an API key for connection "${connection.name}" first.`)
    return {
      connection: { ...connection, models: connection.models.map(item => ({ ...item })) },
      model: { ...model },
      apiKey,
      ref: { ...modelRef },
      attribution: {
        connectionId: connection.id,
        modelId: model.id,
        connectionName: connection.name,
        model: model.model,
        protocol: connection.protocol
      },
      requestBodyPreset: resolveRequestBodyPreset(model, undefined)
    }
  }

  async getSettings(): Promise<AiSettings> {
    const { settings, keys } = await this.readSettingsState()
    return toPublicSettings(settings, keys)
  }

  async saveConnection(input: AiConnectionInput): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      connectionLog(
        'save start connectionId=%s protocol=%s endpoint=%s modelCount=%s',
        input.id ?? 'new',
        input.protocol,
        input.endpoint,
        input.models.length
      )
      const connection = validateConnectionInput(input)
      const current = await this.readSettingsState()
      const connections = current.settings.connections.some(item => item.id === connection.id)
        ? current.settings.connections.map(item => item.id === connection.id ? connection : item)
        : [...current.settings.connections, connection]
      const defaultModel = current.settings.defaultModel && connections.some(item =>
        item.id === current.settings.defaultModel?.connectionId &&
        item.models.some(model => model.id === current.settings.defaultModel?.modelId)
      )
        ? current.settings.defaultModel
        : connection.models[0]
          ? { connectionId: connection.id, modelId: connection.models[0].id }
          : undefined
      const lastUsedModel = current.settings.lastUsedModel === undefined
        ? undefined
        : hasStoredModelRef(connections, current.settings.lastUsedModel)
          ? current.settings.lastUsedModel
          : hasStoredModelRef(connections, defaultModel)
            ? defaultModel
            : firstStoredModelRef(connections)
      const settings: StoredSettings = {
        ...current.settings,
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        connections,
        defaultModel,
        lastUsedModel
      }
      const keys = { ...current.keys }
      if (typeof input.apiKey === 'string' && input.apiKey.trim()) keys[connection.id] = input.apiKey.trim()
      await writeJsonAtomic(this.settingsPath, settings)
      await writeJsonAtomic(this.keyPath, keys)
      connectionLog('save succeeded connectionId=%s modelCount=%s', connection.id, connection.models.length)
      return toPublicSettings(settings, keys)
    })
  }

  async deleteConnection(connectionId: string): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      const connections = current.settings.connections.filter(connection => connection.id !== connectionId)
      if (connections.length === current.settings.connections.length) return toPublicSettings(current.settings, current.keys)
      const keys = { ...current.keys }
      delete keys[connectionId]
      const fallbackConnection = connections.find(connection => connection.models.length > 0)
      const defaultModel = current.settings.defaultModel?.connectionId === connectionId
        ? fallbackConnection
          ? { connectionId: fallbackConnection.id, modelId: fallbackConnection.models[0].id }
          : undefined
        : current.settings.defaultModel
      const lastUsedModel = current.settings.lastUsedModel === undefined
        ? undefined
        : hasStoredModelRef(connections, current.settings.lastUsedModel)
          ? current.settings.lastUsedModel
          : hasStoredModelRef(connections, defaultModel)
            ? defaultModel
            : firstStoredModelRef(connections)
      const settings: StoredSettings = {
        ...current.settings,
        schemaVersion: SETTINGS_SCHEMA_VERSION,
        connections,
        defaultModel,
        lastUsedModel
      }
      await writeJsonAtomic(this.settingsPath, settings)
      await writeJsonAtomic(this.keyPath, keys)
      featureLog('connection deleted connectionId=%s', connectionId)
      return toPublicSettings(settings, keys)
    })
  }

  async deleteConnectionKey(connectionId: string): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      const keys = { ...current.keys }
      delete keys[connectionId]
      await writeJsonAtomic(this.keyPath, keys)
      featureLog('connection key deleted connectionId=%s', connectionId)
      return toPublicSettings(current.settings, keys)
    })
  }

  async setDefaultModel(modelRef: AiModelRef | null): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      if (modelRef) {
        try {
          await this.resolveModelTarget(modelRef, current)
        } catch (error) {
          if (!(error instanceof Error && error.message.includes('API key'))) throw error
        }
      }
      const settings: StoredSettings = {
        ...current.settings,
        defaultModel: modelRef ?? undefined
      }
      await writeJsonAtomic(this.settingsPath, settings)
      return toPublicSettings(settings, current.keys)
    })
  }

  async setLastUsedModel(modelRef: AiModelRef | null): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      if (modelRef && !hasStoredModelRef(current.settings.connections, modelRef)) {
        throw new Error('The selected AI model no longer exists.')
      }
      const settings: StoredSettings = {
        ...current.settings,
        lastUsedModel: modelRef ?? undefined
      }
      await writeJsonAtomic(this.settingsPath, settings)
      featureLog(
        'last used model updated connectionId=%s modelId=%s',
        modelRef?.connectionId ?? 'none',
        modelRef?.modelId ?? 'none'
      )
      return toPublicSettings(settings, current.keys)
    })
  }

  async setLastUsedReasoningEffort(preference: AiReasoningEffortPreference | null): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      if (preference !== null && !isReasoningEffortPreference(preference)) {
        throw new Error('The selected reasoning effort is invalid.')
      }
      const current = await this.readSettingsState()
      const settings: StoredSettings = {
        ...current.settings,
        lastUsedReasoningEffort: preference ?? undefined
      }
      await writeJsonAtomic(this.settingsPath, settings)
      featureLog('last used reasoning effort updated preference=%s', preference ?? 'none')
      return toPublicSettings(settings, current.keys)
    })
  }

  async setLastUsedVerbosity(preference: AiVerbosityPreference | null): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      if (preference !== null && !isVerbosityPreference(preference)) {
        throw new Error('The selected verbosity is invalid.')
      }
      const current = await this.readSettingsState()
      const settings: StoredSettings = {
        ...current.settings,
        lastUsedVerbosity: preference ?? undefined
      }
      await writeJsonAtomic(this.settingsPath, settings)
      featureLog('last used verbosity updated preference=%s', preference ?? 'none')
      return toPublicSettings(settings, current.keys)
    })
  }

  async reorderConnections(connectionIds: string[]): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      const existingIds = current.settings.connections.map(connection => connection.id)
      const requestedIds = Array.isArray(connectionIds) ? connectionIds : []
      if (
        requestedIds.length !== existingIds.length ||
        new Set(requestedIds).size !== requestedIds.length ||
        requestedIds.some(id => !existingIds.includes(id))
      ) {
        throw new Error('The AI connection order must contain every configured connection exactly once.')
      }
      const connectionsById = new Map(current.settings.connections.map(connection => [connection.id, connection]))
      const connections = requestedIds.map(id => connectionsById.get(id) as StoredConnection)
      const settings: StoredSettings = {
        ...current.settings,
        connections
      }
      await writeJsonAtomic(this.settingsPath, settings)
      featureLog('connection order updated order=%s', requestedIds.join(','))
      return toPublicSettings(settings, current.keys)
    })
  }

  async setEditAutoRetryCount(retryCount: number): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      const settings: StoredSettings = {
        ...current.settings,
        editAutoRetryCount: normalizeEditAutoRetryCount(retryCount)
      }
      await writeJsonAtomic(this.settingsPath, settings)
      featureLog('edit auto retry count updated count=%s', settings.editAutoRetryCount)
      return toPublicSettings(settings, current.keys)
    })
  }

  async setEditAgentMaxSteps(maxSteps: number): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      const settings: StoredSettings = {
        ...current.settings,
        editAgentMaxSteps: normalizeEditAgentMaxSteps(maxSteps)
      }
      await writeJsonAtomic(this.settingsPath, settings)
      featureLog('edit agent max steps updated maxSteps=%s', settings.editAgentMaxSteps)
      return toPublicSettings(settings, current.keys)
    })
  }

  async setFailureOutputAfter(failureCount: number): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      const settings: StoredSettings = {
        ...current.settings,
        failureOutputAfter: normalizeFailureOutputAfter(failureCount)
      }
      await writeJsonAtomic(this.settingsPath, settings)
      featureLog('failure output threshold updated count=%s', settings.failureOutputAfter)
      return toPublicSettings(settings, current.keys)
    })
  }

  async setContextMode(contextMode: AiSettings['contextMode']): Promise<AiSettings> {
    return this.queueSettingsMutation(async() => {
      const current = await this.readSettingsState()
      const settings: StoredSettings = {
        ...current.settings,
        contextMode: normalizeContextMode(contextMode)
      }
      await writeJsonAtomic(this.settingsPath, settings)
      featureLog('context mode updated mode=%s', settings.contextMode)
      return toPublicSettings(settings, current.keys)
    })
  }
}
