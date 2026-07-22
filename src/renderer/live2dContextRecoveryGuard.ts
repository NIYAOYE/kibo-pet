import { nextContextRecoveryState, type ContextRecoveryState } from './live2dContextRecovery'

export const CONTEXT_RECOVERY_MESSAGE = '画面渲染出现问题,正在尝试恢复…'
export const CONTEXT_GIVEN_UP_MESSAGE = '渲染反复失败,已停止自动重试。请从托盘或设置中切换宠物/模型。'

export interface ContextRecoveryCanvasLike {
  addEventListener(type: 'webglcontextlost' | 'webglcontextrestored', listener: (event: Event) => void): void
  removeEventListener(type: 'webglcontextlost' | 'webglcontextrestored', listener: (event: Event) => void): void
}

export interface ContextRecoveryGuardDeps {
  canvas: ContextRecoveryCanvasLike
  /** 重新加载当前 source;由调用方(main.ts)绑定好"当前宠物的 currentSource",
   *  guard 本身不知道 source 是什么,只知道"重载一次"这个动作。 */
  reload: () => Promise<void>
  showOverlay: (text: string) => void
  hideOverlay: () => void
  onStateChange: (state: ContextRecoveryState) => void
  /** 见设计文档 §2:进入 recovering/given-up 时必须强制 setIgnoreMouseEvents(true),
   *  因为遮罩层没有 pointer-events:none,而 Electron 的忽略状态是丢失前、依赖光标位置的
   *  陈旧 hit-test 结果决定的。只会被调用 true——恢复健康后不需要显式传 false 撤销:
   *  mousemove 循环本来就在持续用 hitTest 结果重新校正,下一次移动就会自然纠正回来。 */
  forceIgnoreMouseEvents: (ignore: boolean) => void
}

export interface ContextRecoveryGuard {
  /** 真实换宠物提交新 source 时调用,强制回到 healthy——不属于状态机自身的事件,
   *  是外部对"这已经是一个全新的、还没经历过任何丢失的会话"这一事实的显式声明。 */
  reset(): void
  currentState(): ContextRecoveryState
  /** 这个 guard 被替换(换宠物/换 canvas)之后必须调用:被换下的旧 canvas 之后可能
   *  经由一次完全无关的 `Application.destroy()` 被强制 lose context(见 main.ts 顶部注释),
   *  如果旧 guard 还挂着监听,就会对着一个"已经不代表任何当前宠物"的旧会话误报一次
   *  recovering/given-up,弹出一个再也没人会去关闭的恢复中浮层。 */
  dispose(): void
}

/** 见 docs/superpowers/specs/2026-07-22-live2d-phase7-gpu-context-recovery-design.md §2。
 *  只在 canvas 上挂两个标准 WebGL 事件监听,不新建任何渲染器生命周期。 */
export function createLive2DContextRecoveryGuard(deps: ContextRecoveryGuardDeps): ContextRecoveryGuard {
  let state: ContextRecoveryState = 'healthy'

  function setState(next: ContextRecoveryState): void {
    state = next
    deps.onStateChange(state)
  }

  async function handleRestore(): Promise<void> {
    try {
      await deps.reload()
      // 重载这段时间里,如果 canvas 又并发丢失了一次 context(recovering->given-up 的第二条
      // 转移在下面的 webglcontextlost 监听里已经同步处理过),这次迟到的重载结果就不再代表
      // 当前状态——不能让一次"成功"把已经判定的 given-up 打回 healthy。
      if (state !== 'recovering') return
      setState(nextContextRecoveryState(state, 'restore-succeeded'))
      deps.hideOverlay()
    } catch (err) {
      console.warn('[live2dContextRecoveryGuard] 恢复重载失败', err)
      if (state !== 'recovering') return
      setState(nextContextRecoveryState(state, 'restore-failed'))
      deps.forceIgnoreMouseEvents(true)
      deps.showOverlay(CONTEXT_GIVEN_UP_MESSAGE)
    }
  }

  function handleContextLost(event: Event): void {
    event.preventDefault()
    if (state === 'given-up') return
    const next = nextContextRecoveryState(state, 'contextlost')
    setState(next)
    if (next === 'recovering') {
      deps.forceIgnoreMouseEvents(true)
      deps.showOverlay(CONTEXT_RECOVERY_MESSAGE)
    } else if (next === 'given-up') {
      deps.forceIgnoreMouseEvents(true)
      deps.showOverlay(CONTEXT_GIVEN_UP_MESSAGE)
    }
  }

  function handleContextRestored(): void {
    if (state !== 'recovering') return
    void handleRestore()
  }

  deps.canvas.addEventListener('webglcontextlost', handleContextLost)
  deps.canvas.addEventListener('webglcontextrestored', handleContextRestored)

  return {
    reset(): void {
      state = 'healthy'
      deps.hideOverlay()
      deps.onStateChange(state)
    },
    currentState(): ContextRecoveryState {
      return state
    },
    dispose(): void {
      deps.canvas.removeEventListener('webglcontextlost', handleContextLost)
      deps.canvas.removeEventListener('webglcontextrestored', handleContextRestored)
    }
  }
}
