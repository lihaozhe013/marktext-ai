import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createPinia, setActivePinia } from 'pinia'
import { describe, expect, it, beforeEach } from 'vitest'
import { usePreferencesStore } from '@/store/preferences'

const staticPreferences = JSON.parse(
  readFileSync(resolve(__dirname, '../../../static/preference.json'), 'utf8')
) as Record<string, unknown>
const schema = JSON.parse(
  readFileSync(resolve(__dirname, '../../../src/main/preferences/schema.json'), 'utf8')
) as Record<string, { default?: unknown }>

describe('preference defaults', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('keeps the shipped defaults aligned with the preference schema', () => {
    for (const key of [
      'titleBarStyle',
      'startUpAction',
      'imageInsertAction',
      'imagePreferRelativeDirectory'
    ]) {
      expect(staticPreferences[key]).toBe(schema[key]?.default)
    }
  })

  it('uses the same defaults before the main process sends persisted preferences', () => {
    const preferences = usePreferencesStore()

    expect(preferences.titleBarStyle).toBe('native')
    expect(preferences.startUpAction).toBe('blank')
    expect(preferences.imageInsertAction).toBe('folder')
    expect(preferences.imagePreferRelativeDirectory).toBe(true)
  })
})
