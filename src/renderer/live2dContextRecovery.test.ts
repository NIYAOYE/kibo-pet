import { describe, it, expect } from 'vitest'
import { nextContextRecoveryState } from './live2dContextRecovery'

describe('nextContextRecoveryState', () => {
  it('healthy + contextlost -> recovering', () => {
    expect(nextContextRecoveryState('healthy', 'contextlost')).toBe('recovering')
  })
  it('healthy + restore-succeeded -> healthy(防御性 no-op,不应该发生但不能抛错)', () => {
    expect(nextContextRecoveryState('healthy', 'restore-succeeded')).toBe('healthy')
  })
  it('healthy + restore-failed -> healthy(同上)', () => {
    expect(nextContextRecoveryState('healthy', 'restore-failed')).toBe('healthy')
  })
  it('recovering + contextlost -> given-up(还没恢复完成又丢了一次)', () => {
    expect(nextContextRecoveryState('recovering', 'contextlost')).toBe('given-up')
  })
  it('recovering + restore-succeeded -> healthy', () => {
    expect(nextContextRecoveryState('recovering', 'restore-succeeded')).toBe('healthy')
  })
  it('recovering + restore-failed -> given-up', () => {
    expect(nextContextRecoveryState('recovering', 'restore-failed')).toBe('given-up')
  })
  it('given-up + contextlost -> given-up(终态,忽略后续事件)', () => {
    expect(nextContextRecoveryState('given-up', 'contextlost')).toBe('given-up')
  })
  it('given-up + restore-succeeded -> given-up', () => {
    expect(nextContextRecoveryState('given-up', 'restore-succeeded')).toBe('given-up')
  })
  it('given-up + restore-failed -> given-up', () => {
    expect(nextContextRecoveryState('given-up', 'restore-failed')).toBe('given-up')
  })
})
