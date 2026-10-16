import Anthropic from '@anthropic-ai/sdk'
import type { Ai, AiConfig } from './config'

export function createAi(config: AiConfig): Ai {
  return new Anthropic({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    fetch: config.fetch,
    maxRetries: config.maxRetries,
  })
}
