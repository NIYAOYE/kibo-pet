import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileTools } from './fileTools'
import type { ToolSpec } from './toolSpec'

const ctx = { signal: new AbortController().signal }

function scratch(): { workspaceDir: string; tools: Record<string, ToolSpec> } {
  const dir = mkdtempSync(join(tmpdir(), 'filetools-'))
  const workspaceDir = join(dir, 'workspace')
  mkdirSync(workspaceDir, { recursive: true })
  const list = createFileTools({ workspaceDir })
  const tools = Object.fromEntries(list.map((t) => [t.name, t]))
  return { workspaceDir, tools }
}

describe('createFileTools', () => {
  it('返回固定的 5 个工具', () => {
    const { tools } = scratch()
    expect(Object.keys(tools)).toEqual(['list_dir', 'read_file', 'write_file', 'edit_file', 'delete_file'])
  })

  describe('list_dir', () => {
    it('工作目录为空 → 提示空目录', async () => {
      const { tools } = scratch()
      const out = await tools.list_dir.run({}, ctx)
      expect(out).toContain('空目录')
    })

    it('列出文件与子目录,文件带字节数', async () => {
      const { workspaceDir, tools } = scratch()
      writeFileSync(join(workspaceDir, 'a.txt'), 'hello', 'utf-8')
      mkdirSync(join(workspaceDir, 'sub'))
      const out = (await tools.list_dir.run({}, ctx)) as string
      expect(out).toContain('a.txt (5 字节)')
      expect(out).toContain('sub/')
    })

    it('path 传空字符串 → 视同省略,列出根目录', async () => {
      const { workspaceDir, tools } = scratch()
      writeFileSync(join(workspaceDir, 'a.txt'), 'hello', 'utf-8')
      mkdirSync(join(workspaceDir, 'sub'))
      const out = (await tools.list_dir.run({ path: '' }, ctx)) as string
      expect(out).toContain('a.txt (5 字节)')
      expect(out).toContain('sub/')
    })

    it('子路径不存在(非根目录) → 提示目录不存在', async () => {
      const { tools } = scratch()
      const out = await tools.list_dir.run({ path: 'ghost' }, ctx)
      expect(out).toBe('目录不存在,请检查路径')
    })

    it('路径越界 → 返回越界提示', async () => {
      const { tools } = scratch()
      const out = (await tools.list_dir.run({ path: '../evil' }, ctx)) as string
      expect(out).toContain('不能越界')
    })
  })

  describe('read_file', () => {
    it('读取已有文本文件', async () => {
      const { workspaceDir, tools } = scratch()
      writeFileSync(join(workspaceDir, 'note.txt'), '今天的笔记', 'utf-8')
      const out = (await tools.read_file.run({ path: 'note.txt' }, ctx)) as string
      expect(out).toContain('今天的笔记')
    })

    it('超长内容被截断', async () => {
      const { workspaceDir, tools } = scratch()
      writeFileSync(join(workspaceDir, 'big.txt'), 'x'.repeat(20000), 'utf-8')
      const out = (await tools.read_file.run({ path: 'big.txt' }, ctx)) as string
      expect(out).toContain('内容过长已截断')
    })

    it('文件不存在 → 提示', async () => {
      const { tools } = scratch()
      const out = await tools.read_file.run({ path: 'ghost.txt' }, ctx)
      expect(out).toBe('文件不存在,请先用 list_dir 确认路径')
    })

    it('目标是目录 → 提示改用 list_dir', async () => {
      const { workspaceDir, tools } = scratch()
      mkdirSync(join(workspaceDir, 'sub'))
      const out = await tools.read_file.run({ path: 'sub' }, ctx)
      expect(out).toBe('目标是目录不是文件,请改用 list_dir')
    })

    it('路径越界 → 拒绝', async () => {
      const { tools } = scratch()
      const out = (await tools.read_file.run({ path: '../evil.txt' }, ctx)) as string
      expect(out).toContain('不能越界')
    })
  })

  describe('write_file', () => {
    it('创建新文件', async () => {
      const { workspaceDir, tools } = scratch()
      const out = await tools.write_file.run({ path: 'new.txt', content: 'hi' }, ctx)
      expect(out).toBe('已写入 new.txt')
      expect(readFileSync(join(workspaceDir, 'new.txt'), 'utf-8')).toBe('hi')
    })

    it('自动创建缺失的父目录', async () => {
      const { workspaceDir, tools } = scratch()
      await tools.write_file.run({ path: 'a/b/c.txt', content: 'deep' }, ctx)
      expect(readFileSync(join(workspaceDir, 'a', 'b', 'c.txt'), 'utf-8')).toBe('deep')
    })

    it('覆盖已有文件', async () => {
      const { workspaceDir, tools } = scratch()
      writeFileSync(join(workspaceDir, 'x.txt'), 'old', 'utf-8')
      await tools.write_file.run({ path: 'x.txt', content: 'new' }, ctx)
      expect(readFileSync(join(workspaceDir, 'x.txt'), 'utf-8')).toBe('new')
    })

    it('路径越界 → 拒绝且不落盘', async () => {
      const { workspaceDir, tools } = scratch()
      const out = (await tools.write_file.run({ path: '../evil.txt', content: 'x' }, ctx)) as string
      expect(out).toContain('不能越界')
      expect(existsSync(join(workspaceDir, '..', 'evil.txt'))).toBe(false)
    })

    it('目标是目录 → 拒绝,不改目录', async () => {
      const { workspaceDir, tools } = scratch()
      mkdirSync(join(workspaceDir, 'sub'))
      const out = await tools.write_file.run({ path: 'sub', content: 'x' }, ctx)
      expect(out).toBe('目标是目录,write_file 只能写入文件')
      expect(existsSync(join(workspaceDir, 'sub'))).toBe(true)
    })
  })

  describe('edit_file', () => {
    it('old_string 唯一匹配 → 替换成功', async () => {
      const { workspaceDir, tools } = scratch()
      writeFileSync(join(workspaceDir, 'doc.txt'), 'hello world', 'utf-8')
      const out = await tools.edit_file.run({ path: 'doc.txt', old_string: 'world', new_string: 'there' }, ctx)
      expect(out).toBe('已修改 doc.txt')
      expect(readFileSync(join(workspaceDir, 'doc.txt'), 'utf-8')).toBe('hello there')
    })

    it('old_string 未找到 → 报错不改文件', async () => {
      const { workspaceDir, tools } = scratch()
      writeFileSync(join(workspaceDir, 'doc.txt'), 'hello world', 'utf-8')
      const out = await tools.edit_file.run({ path: 'doc.txt', old_string: 'nope', new_string: 'x' }, ctx)
      expect(out).toContain('未在文件中找到')
      expect(readFileSync(join(workspaceDir, 'doc.txt'), 'utf-8')).toBe('hello world')
    })

    it('old_string 匹配多处 → 报错不改文件', async () => {
      const { workspaceDir, tools } = scratch()
      writeFileSync(join(workspaceDir, 'doc.txt'), 'a a a', 'utf-8')
      const out = await tools.edit_file.run({ path: 'doc.txt', old_string: 'a', new_string: 'b' }, ctx)
      expect(out).toContain('匹配到多处')
      expect(readFileSync(join(workspaceDir, 'doc.txt'), 'utf-8')).toBe('a a a')
    })

    it('文件不存在 → 提示', async () => {
      const { tools } = scratch()
      const out = await tools.edit_file.run({ path: 'ghost.txt', old_string: 'a', new_string: 'b' }, ctx)
      expect(out).toBe('文件不存在,请先用 list_dir 确认路径')
    })
  })

  describe('delete_file', () => {
    it('删除已有文件', async () => {
      const { workspaceDir, tools } = scratch()
      writeFileSync(join(workspaceDir, 'gone.txt'), 'x', 'utf-8')
      const out = await tools.delete_file.run({ path: 'gone.txt' }, ctx)
      expect(out).toBe('已删除 gone.txt')
      expect(existsSync(join(workspaceDir, 'gone.txt'))).toBe(false)
    })

    it('目标是目录 → 拒绝,不删除', async () => {
      const { workspaceDir, tools } = scratch()
      mkdirSync(join(workspaceDir, 'sub'))
      const out = await tools.delete_file.run({ path: 'sub' }, ctx)
      expect(out).toBe('目标是目录,delete_file 只能删除单个文件')
      expect(existsSync(join(workspaceDir, 'sub'))).toBe(true)
    })

    it('文件不存在 → 提示', async () => {
      const { tools } = scratch()
      const out = await tools.delete_file.run({ path: 'ghost.txt' }, ctx)
      expect(out).toBe('文件不存在')
    })

    it('路径越界 → 拒绝', async () => {
      const { tools } = scratch()
      const out = (await tools.delete_file.run({ path: '../evil.txt' }, ctx)) as string
      expect(out).toContain('不能越界')
    })
  })
})
