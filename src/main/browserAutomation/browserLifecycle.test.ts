import { describe, it, expect } from 'vitest'
import { resolveLaunchPlan, DEFAULT_CDP_PORT } from './browserLifecycle'

describe('resolveLaunchPlan', () => {
  it('mode:isolated → isolated 计划,channel chrome,不指定 userDataDir', () => {
    const plan = resolveLaunchPlan({ enabled: true, mode: 'isolated' }, {})
    expect(plan).toEqual({ kind: 'isolated', channel: 'chrome', headless: false })
  })

  it('mode:cdp 未传端口 → 用默认端口 9222 拼出 endpoint', () => {
    const plan = resolveLaunchPlan({ enabled: true, mode: 'cdp' }, {})
    expect(plan).toEqual({ kind: 'cdp', endpointURL: `http://localhost:${DEFAULT_CDP_PORT}` })
  })

  it('mode:cdp 传自定义端口 → 拼进 endpoint', () => {
    const plan = resolveLaunchPlan({ enabled: true, mode: 'cdp' }, { cdpPort: 9333 })
    expect(plan).toEqual({ kind: 'cdp', endpointURL: 'http://localhost:9333' })
  })
})
