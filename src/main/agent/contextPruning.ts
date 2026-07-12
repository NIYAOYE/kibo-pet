import type { AgentMessage } from '@shared/llm'

/** 保留最近几条带图 tool_result 的图片;桌面/浏览器流程常见"操作前后各一截"的对照,取 2 */
export const KEEP_RECENT_IMAGES = 2

export const STALE_IMAGE_NOTE = '(此前附带的截图已过期移除;如需查看最新画面请重新调用截图工具)'

/**
 * 原地裁剪历史消息中过期的截图:只保留最近 keep 条带图 tool_result 的图片,
 * 更早的剥离 images 并在文本末尾追加占位说明,让模型知道"图没了、可以重截"。
 * 剥离即失去带图身份,天然幂等。多轮工具任务里旧截图每轮全量重发是最大的
 * token 黑洞(40 轮上限下 O(n²) 增长),对标 computer-use 参考实现的
 * keep-last-N-images 策略。user 消息上的图(当前回合用户附图)不动。
 */
export function pruneStaleImages(messages: AgentMessage[], keep = KEEP_RECENT_IMAGES): void {
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'tool_result' || !m.images || m.images.length === 0) continue
    seen++
    if (seen <= keep) continue
    delete m.images
    m.content = m.content ? `${m.content}\n${STALE_IMAGE_NOTE}` : STALE_IMAGE_NOTE
  }
}
