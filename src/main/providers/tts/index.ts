/** TTS provider orchestrator:enabled 开关 + 启动失败静默降级的安全包装层,
 *  真正的 sidecar 通信全部委托给注入的 TtsClient(见 ttsClient.ts)。 */
import type { TtsLanguage } from '@shared/llm'
import type { TtsClient } from './ttsClient'

export interface TtsProvider {
  /** 尝试启动 sidecar;返回是否可用。enabled:false 或未传 client 时恒返回 false,不抛错。 */
  start(): Promise<boolean>
  begin(id: string, language: TtsLanguage): void
  pushToken(token: string): void
  finish(): void
  cancel(): void
  close(): Promise<void>
}

export function createTtsProvider(opts: { enabled: boolean; client?: TtsClient }): TtsProvider {
  let available = false
  const client = opts.client

  return {
    async start(): Promise<boolean> {
      if (!opts.enabled || !client) return false
      try {
        await client.start()
        available = true
      } catch (e) {
        available = false
        console.warn('[tts] sidecar 启动失败,本次会话降级为纯文字', e)
      }
      return available
    },
    begin(id, language): void { if (available && client) client.begin(id, language) },
    pushToken(token): void { if (available && client) client.pushToken(token) },
    finish(): void { if (available && client) client.finish() },
    cancel(): void { if (available && client) client.cancel() },
    async close(): Promise<void> {
      if (available && client) {
        available = false
        await client.close()
      }
    }
  }
}
