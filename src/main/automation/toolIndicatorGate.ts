import type { ToolSpec } from '../tools/toolSpec'

export interface IndicatorGate {
  /** 每次桌面控制工具实际开始执行时调用;懒加载——本轮第一次调用才 show()。 */
  onToolStart(): void
  /** 一次完整的多轮工具调用(一次 handleSend)开始时调用,取得本轮的 token。 */
  beginTurn(): number
  /** 一次完整的多轮工具调用结束时调用;仅当 token 与最近一次 beginTurn 匹配、且本轮曾 show() 过时才 hide()。 */
  endTurn(token: number): void
}

/**
 * 桌面控制工具在 agentLoop 里严格顺序执行、从不并发——引用计数版实现里"计数归零
 * 就 hide"在每个工具调用之间都会归零,导致每次工具调用都反复 show/hide,安全网
 * (manualOverrideWatch)和 lastAiPos 被反复清空重建,在两次工具调用之间(模型流式
 * 生成下一步指令的几秒)完全失去监控能力——这正是"人工接管无法打断自动化"的根因。
 * 改为按"一整轮多步任务"（一次 handleSend）的边界来 show/hide:本轮第一次实际调用
 * 桌面工具才 show(),整轮任务结束(endTurn)才 hide(),中途工具调用之间不再触发。
 * token 防止旧轮次(如已被 cancel)延迟到达的 endTurn 错误关闭新轮次刚启动的安全网。
 */
export function createIndicatorGate(show: () => void, hide: () => void): IndicatorGate {
  let shown = false
  let generation = 0

  return {
    onToolStart() {
      if (!shown) { shown = true; show() }
    },
    beginTurn(): number {
      return ++generation
    },
    endTurn(token: number) {
      if (token !== generation) return
      if (shown) { shown = false; hide() }
    }
  }
}

export function wrapToolsWithGate(tools: ToolSpec[], gate: IndicatorGate): ToolSpec[] {
  return tools.map((t) => ({
    ...t,
    run: async (input, ctx) => {
      gate.onToolStart()
      return t.run(input, ctx)
    }
  }))
}
