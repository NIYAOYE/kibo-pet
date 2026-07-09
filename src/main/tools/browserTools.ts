import type { ToolSpec } from './toolSpec'
import type { BrowserControl } from '../browserAutomation/browserControl'

export function createBrowserTools(opts: { control: BrowserControl }): ToolSpec[] {
  const c = opts.control

  const navigate: ToolSpec = {
    name: 'browser_navigate',
    description: '让浏览器跳转到指定网址。首次调用会自动启动浏览器。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    run: async (input) => {
      const { url } = input as { url: string }
      const r = await c.navigate(url)
      return r.ok ? `已跳转到:${url}` : `跳转失败:${r.error}`
    }
  }

  const click: ToolSpec = {
    name: 'browser_click',
    description: '按可见文字点击页面元素(按钮/链接等);不需要坐标。也可传 selector 用 CSS 选择器精确定位(高级用法)。',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' }, selector: { type: 'string' } },
      required: ['text']
    },
    run: async (input) => {
      const { text, selector } = input as { text: string; selector?: string }
      const r = await c.click({ text, selector })
      return r.ok ? `已点击:${selector ?? text}` : `点击失败:${r.error}`
    }
  }

  const fillText: ToolSpec = {
    name: 'browser_fill_text',
    description: '按标签/占位符文字定位输入框并填入内容。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' }, value: { type: 'string' } }, required: ['text', 'value'] },
    run: async (input) => {
      const { text, value } = input as { text: string; value: string }
      const r = await c.fillText({ text, value })
      return r.ok ? `已在"${text}"填入内容` : `填写失败:${r.error}`
    }
  }

  const readText: ToolSpec = {
    name: 'browser_read_text',
    description: '读取当前页面可见正文,用于判断页面内容或验证操作结果。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const r = await c.readText()
      return r.ok ? `页面正文:\n${r.text}` : `读取失败:${r.error}`
    }
  }

  const screenshot: ToolSpec = {
    name: 'browser_screenshot',
    description: '截取当前页面的画面。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const r = await c.screenshot()
      if (!r.ok || !r.image) return `截图失败:${r.error}`
      return { content: '已截取当前页面', images: [r.image] }
    }
  }

  const scroll: ToolSpec = {
    name: 'browser_scroll',
    description: '上下滚动当前页面。',
    inputSchema: {
      type: 'object',
      properties: { direction: { type: 'string' }, amount: { type: 'string' } },
      required: ['direction']
    },
    run: async (input) => {
      const { direction, amount } = input as { direction: 'up' | 'down'; amount?: 'page' | 'small' }
      const r = await c.scroll({ direction, amount })
      return r.ok ? `已${direction === 'down' ? '向下' : '向上'}滚动` : `滚动失败:${r.error}`
    }
  }

  const waitFor: ToolSpec = {
    name: 'browser_wait_for',
    description: '等待指定文字出现在页面上,应对页面动态加载;超时会报错。',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    run: async (input) => {
      const { text } = input as { text: string }
      const r = await c.waitFor({ text })
      return r.ok ? `已等到:${text}` : `等待失败:${r.error}`
    }
  }

  const listTabs: ToolSpec = {
    name: 'browser_list_tabs',
    description: '列出当前打开的所有标签页(序号/标题/网址)。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const r = await c.listTabs()
      if (!r.ok || !r.tabs) return `列出标签页失败:${r.error}`
      if (r.tabs.length === 0) return '当前没有打开的标签页'
      return `当前标签页:\n${r.tabs.map((t) => `[${t.index}] ${t.title} (${t.url})`).join('\n')}`
    }
  }

  const openTab: ToolSpec = {
    name: 'browser_open_tab',
    description: '新开一个标签页并设为当前操作对象,可选立即跳转到指定网址。',
    inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: [] },
    run: async (input) => {
      const { url } = input as { url?: string }
      const r = await c.openTab({ url })
      return r.ok ? '已新开标签页' : `新开标签页失败:${r.error}`
    }
  }

  const switchTab: ToolSpec = {
    name: 'browser_switch_tab',
    description: '把已有的某个标签页切为当前操作对象(序号来自 browser_list_tabs)。',
    inputSchema: { type: 'object', properties: { index: { type: 'number' } }, required: ['index'] },
    run: async (input) => {
      const { index } = input as { index: number }
      const r = await c.switchTab({ index })
      return r.ok ? `已切换到标签页 [${index}]` : `切换失败:${r.error}`
    }
  }

  const close: ToolSpec = {
    name: 'browser_close',
    description: '主动结束本次浏览器自动化会话(关闭浏览器)。',
    inputSchema: { type: 'object', properties: {}, required: [] },
    run: async () => {
      const r = await c.close()
      return r.ok ? '已关闭浏览器' : `关闭失败:${r.error}`
    }
  }

  return [navigate, click, fillText, readText, screenshot, scroll, waitFor, listTabs, openTab, switchTab, close]
}
