import { describe, expect, it } from 'vitest'
import { resolveModelsEndpoint, resolveRequestEndpoint } from 'main_renderer/ai/providerClient'

describe('Responses provider endpoints', () => {
  it('normalizes base and legacy chat endpoints to Responses', () => {
    expect(resolveRequestEndpoint({ protocol: 'openai-responses', endpoint: 'https://api.example/v1' }))
      .toBe('https://api.example/v1/responses')
    expect(resolveRequestEndpoint({ protocol: 'openai-responses', endpoint: 'https://api.example/v1/chat/completions' }))
      .toBe('https://api.example/v1/responses')
    expect(resolveRequestEndpoint({ protocol: 'openai-responses', endpoint: 'https://api.example/v1/responses' }))
      .toBe('https://api.example/v1/responses')
  })

  it('keeps model discovery on /models', () => {
    expect(resolveModelsEndpoint({ protocol: 'openai-responses', endpoint: 'https://api.example/v1/responses' }))
      .toBe('https://api.example/v1/models')
  })
})
