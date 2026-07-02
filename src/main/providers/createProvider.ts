import type { LlmProvider } from './llmProvider'
import type { ProviderSettings } from '@shared/llm'
import { createAnthropicProvider } from './anthropicProvider'
import { createOpenAiCompatProvider } from './openaiCompatProvider'
import { createFakeProvider } from './fakeProvider'

export function createProvider(settings: ProviderSettings, apiKey: string): LlmProvider {
  switch (settings.kind) {
    case 'anthropic':
      return createAnthropicProvider({ apiKey, baseURL: settings.baseURL, model: settings.model })
    case 'openai-compat':
      return createOpenAiCompatProvider({ apiKey, baseURL: settings.baseURL, model: settings.model })
    case 'fake':
    default:
      return createFakeProvider({})
  }
}
