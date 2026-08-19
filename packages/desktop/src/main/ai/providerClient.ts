import type { AiProtocol } from '@shared/types/ai'

interface ProviderEndpointSettings {
  protocol: AiProtocol
  endpoint: string
}

export const resolveRequestEndpoint = (settings: ProviderEndpointSettings): string => {
  const url = new URL(settings.endpoint)
  const pathname = url.pathname.replace(/\/+$/, '')
  if (settings.protocol === 'openai-chat-completions') {
    if (!pathname.endsWith('/chat/completions')) url.pathname = `${pathname}/chat/completions`
  } else if (!pathname.endsWith('/messages')) {
    url.pathname = pathname.endsWith('/v1') ? `${pathname}/messages` : `${pathname}/v1/messages`
  }
  return url.toString()
}

export const resolveModelsEndpoint = (settings: ProviderEndpointSettings): string => {
  const url = new URL(settings.endpoint)
  const pathname = url.pathname.replace(/\/+$/, '')
  if (settings.protocol === 'openai-chat-completions') {
    url.pathname = pathname.endsWith('/chat/completions')
      ? `${pathname.slice(0, -'/chat/completions'.length)}/models`
      : `${pathname}/models`
  } else {
    url.pathname = pathname.endsWith('/messages')
      ? `${pathname.slice(0, -'/messages'.length)}/models`
      : pathname.endsWith('/v1')
        ? `${pathname}/models`
        : `${pathname}/v1/models`
  }
  return url.toString()
}
