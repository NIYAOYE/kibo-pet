import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveSafePath } from './pathScope'

function scratchRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pathscope-'))
  const root = join(dir, 'workspace')
  mkdirSync(root, { recursive: true })
  return root
}

describe('resolveSafePath', () => {
  it('工作目录内的相对路径 → 通过', () => {
    const root = scratchRoot()
    const r = resolveSafePath(root, 'notes/todo.txt')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absolutePath).toBe(join(root, 'notes', 'todo.txt'))
  })

  it('省略当前目录("." ) → 解析为根目录本身', () => {
    const root = scratchRoot()
    const r = resolveSafePath(root, '.')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absolutePath).toBe(root)
  })

  it('空字符串 → 拒绝', () => {
    const root = scratchRoot()
    expect(resolveSafePath(root, '').ok).toBe(false)
  })

  it('".." 逃逸到父目录或更上层 → 拒绝', () => {
    const root = scratchRoot()
    expect(resolveSafePath(root, '..').ok).toBe(false)
    expect(resolveSafePath(root, '../secret.txt').ok).toBe(false)
    expect(resolveSafePath(root, 'sub/../../secret.txt').ok).toBe(false)
  })

  it('子路径内部的 ".." 只要最终仍落在根目录内 → 通过', () => {
    const root = scratchRoot()
    const r = resolveSafePath(root, 'a/b/../c.txt')
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.absolutePath).toBe(join(root, 'a', 'c.txt'))
  })

  it('绝对路径(Windows 盘符) → 拒绝', () => {
    const root = scratchRoot()
    expect(resolveSafePath(root, 'C:\\Windows\\System32').ok).toBe(false)
  })

  it('绝对路径(类 POSIX 根) → 拒绝', () => {
    const root = scratchRoot()
    expect(resolveSafePath(root, '/etc/passwd').ok).toBe(false)
  })

  it('前缀碰撞:同级但名字更长的目录不会被误判为子路径', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pathscope-'))
    const root = join(dir, 'workspace')
    mkdirSync(root, { recursive: true })
    mkdirSync(join(dir, 'workspace-evil'), { recursive: true })
    const r = resolveSafePath(root, '../workspace-evil/secret.txt')
    expect(r.ok).toBe(false)
  })

  it('根目录与候选路径大小写不同仍视为同一路径(Windows 盘符大小写不敏感)', () => {
    const r = resolveSafePath('c:\\Users\\test\\workspace', 'note.txt')
    expect(r.ok).toBe(true)
  })
})
