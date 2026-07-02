import type { ProviderSettings } from '@shared/llm'
import { createProvider } from '../providers/createProvider'

/** 用给定配置发一条最短消息,消费到 done/error;成功返回 {ok:true}。 */
export async function testConnection(settings: ProviderSettings, apiKey: string): Promise<{ ok: boolean; error?: string }> {
  const provider = createProvider(settings, apiKey)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  try {
    for await (const chunk of provider.streamChat({
      system: '你是一个连接测试助手。',
      messages: [{ role: 'user', content: '回复"ok"即可。' }],
      maxOutputTokens: 16,
      signal: ctrl.signal
    })) {
      if (chunk.type === 'error') return { ok: false, error: chunk.message }
      if (chunk.type === 'done') return { ok: true }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message ?? err) }
  } finally {
    clearTimeout(timer)
  }
}
