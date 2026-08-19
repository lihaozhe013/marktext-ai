import { readJson, writeJsonAtomic } from './storage'
import type { StoredKeys, StoredSettings } from './index'

interface AiSettingsStoreDependencies {
  normalizeSettings: (value: unknown) => { settings: StoredSettings; legacy: boolean }
  normalizeKeys: (value: unknown, settings: StoredSettings) => { keys: StoredKeys; legacy: boolean }
  onMigration: (connectionCount: number) => void
}

export class AiSettingsStore {
  constructor(
    private readonly settingsPath: string,
    private readonly keyPath: string,
    private readonly dependencies: AiSettingsStoreDependencies
  ) {}

  async read(): Promise<{ settings: StoredSettings; keys: StoredKeys }> {
    const rawSettings = await readJson<unknown>(this.settingsPath, undefined)
    const normalizedSettings = this.dependencies.normalizeSettings(rawSettings)
    const rawKeys = await readJson<unknown>(this.keyPath, undefined)
    const normalizedKeys = this.dependencies.normalizeKeys(rawKeys, normalizedSettings.settings)
    if (normalizedSettings.legacy || normalizedKeys.legacy) {
      await writeJsonAtomic(this.settingsPath, normalizedSettings.settings)
      await writeJsonAtomic(this.keyPath, normalizedKeys.keys)
      this.dependencies.onMigration(normalizedSettings.settings.connections.length)
    }
    return { settings: normalizedSettings.settings, keys: normalizedKeys.keys }
  }
}
