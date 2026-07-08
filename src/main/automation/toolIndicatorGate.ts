import type { ToolSpec } from '../tools/toolSpec'

export interface IndicatorGate { onToolStart(): void; onToolEnd(): void }

/** 引用计数:多个桌面控制工具在同一轮里前后/交替执行时,只在"从 0 到 1"显示、"回到 0"才隐藏,避免闪烁。 */
export function createIndicatorGate(show: () => void, hide: () => void): IndicatorGate {
  let active = 0
  return {
    onToolStart() {
      active++
      if (active === 1) show()
    },
    onToolEnd() {
      if (active === 0) return
      active--
      if (active === 0) hide()
    }
  }
}

export function wrapToolsWithGate(tools: ToolSpec[], gate: IndicatorGate): ToolSpec[] {
  return tools.map((t) => ({
    ...t,
    run: async (input, ctx) => {
      gate.onToolStart()
      try {
        return await t.run(input, ctx)
      } finally {
        gate.onToolEnd()
      }
    }
  }))
}
