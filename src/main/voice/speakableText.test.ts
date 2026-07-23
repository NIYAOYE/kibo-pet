import { describe, it, expect } from 'vitest'
import { toSpeakableText } from './speakableText'

describe('fenced technical fragments', () => {
  it('skips a tilde fenced code block as one technical fragment', () => {
    expect(toSpeakableText('~~~ts\nconst endpoint = "https://example.com/path"\n~~~')).toBe('')
  })
})

describe('toSpeakableText', () => {
  it('纯文本原样返回', () => {
    expect(toSpeakableText('今天天气不错')).toBe('今天天气不错')
  })

  it('去掉加粗标记,保留文字', () => {
    expect(toSpeakableText('这是**重点**内容')).toBe('这是重点内容')
  })

  it('去掉斜体标记(* 和 _ 两种写法),保留文字', () => {
    expect(toSpeakableText('这是*斜体*文字')).toBe('这是斜体文字')
    expect(toSpeakableText('这是_斜体_文字')).toBe('这是斜体文字')
  })

  it('行内代码整体丢弃', () => {
    expect(toSpeakableText('运行 `pnpm test` 命令')).toBe('运行  命令')
  })

  it('围栏代码块整体丢弃(含多行)', () => {
    const raw = '说明如下:\n```js\nconst a = 1\nconsole.log(a)\n```\n就这样'
    expect(toSpeakableText(raw)).toBe('说明如下:\n\n就这样')
  })

  it('Markdown 链接只读文字,丢弃 URL', () => {
    expect(toSpeakableText('参考[这篇文章](https://example.com/a)')).toBe('参考这篇文章')
  })

  it('标题标记去掉前导 #,保留文字', () => {
    expect(toSpeakableText('## 今日总结')).toBe('今日总结')
  })

  it('无序/有序列表标记去掉前导符号,保留文字', () => {
    expect(toSpeakableText('- 第一项')).toBe('第一项')
    expect(toSpeakableText('* 第二项')).toBe('第二项')
    expect(toSpeakableText('1. 第三项')).toBe('第三项')
  })

  it('表格分隔行整行丢弃,数据行转为顿号连接的纯文本', () => {
    const raw = '|城市|气温|\n|---|---|\n|北京|20|'
    expect(toSpeakableText(raw)).toBe('城市 · 气温\n北京 · 20')
  })

  it('常见数学/单位符号映射成可读文字', () => {
    expect(toSpeakableText('今天20℃,湿度60%')).toBe('今天20摄氏度,湿度60百分之')
    expect(toSpeakableText('3×4÷2')).toBe('3乘4除以2')
    expect(toSpeakableText('a≥b 且 a≠c 且 a≈d,误差±1')).toBe('a大于等于b 且 a不等于c 且 a约等于d,误差正负1')
  })

  it('组合场景:加粗 + 符号一起出现', () => {
    expect(toSpeakableText('**当前气温**:20℃')).toBe('当前气温:20摄氏度')
  })

  it('removes bare web URLs while preserving surrounding prose', () => {
    expect(toSpeakableText('请访问 https://example.com/docs 或 www.example.org/help 获取 20 MB 文件。')).toBe(
      '请访问  或  获取 20 MB 文件。'
    )
  })

  it('keeps Markdown link labels and omits images', () => {
    expect(toSpeakableText('阅读[使用指南](https://example.com/guide)；![架构图](https://example.com/diagram.png)不需要朗读。')).toBe(
      '阅读使用指南；不需要朗读。'
    )
  })

  it('removes mailto and data URLs', () => {
    expect(toSpeakableText('请联系 mailto:help@example.com，或打开 data:text/plain;base64,SGVsbG8= 。')).toBe(
      '请联系 ，或打开  。'
    )
  })

  it('continues to remove inline and fenced code without losing prose', () => {
    expect(toSpeakableText('运行 `pnpm test` 后继续。\n```sh\npnpm build\n```\n完成。')).toBe('运行  后继续。\n\n完成。')
  })

  it('removes HTML comments and tags while keeping their text', () => {
    expect(toSpeakableText('<!-- internal note --><strong>状态良好</strong>，请看 <a href="https://example.com">文档</a>。')).toBe(
      '状态良好，请看 文档。'
    )
  })

  it('drops lines that contain only commands, paths, hashes, ids, and credentials', () => {
    const technicalLines = [
      '$ pnpm install',
      'C:\\Users\\alice\\project\\config.json',
      '/usr/local/bin/node',
      'd2c7a1e9b9f4117d1bbf5aa236f4c8b5f6a3940e532ed7380cc3f9e6a2b47c11',
      '550e8400-e29b-41d4-a716-446655440000',
      'sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature'
    ]

    expect(toSpeakableText(technicalLines.join('\n'))).toBe('')
  })

  it('returns an empty string when input contains only URLs, code, and paths', () => {
    expect(toSpeakableText('https://example.com\n`pnpm test`\n./dist/app.js')).toBe('')
  })

  it('does not over-clean ordinary Chinese, English, numbers, and units', () => {
    expect(toSpeakableText('版本 2.4 已准备好，文件大小为 3.5 MB，明天 10:30 见。')).toBe(
      '版本 2.4 已准备好，文件大小为 3.5 MB，明天 10:30 见。'
    )
  })

  it('drops standalone shell commands but keeps prose that begins with a command name', () => {
    expect(toSpeakableText('echo hello\nnode scripts/run.js\npnpm test failed because setup is broken')).toBe(
      'pnpm test failed because setup is broken'
    )
  })

  it('drops Windows and Unix paths even when they use forward slashes or spaces', () => {
    expect(toSpeakableText('C:/Users/alice/project/config.json\n/Users/Alice/My Project/file.txt')).toBe('')
  })

  it('removes version 7 UUIDs', () => {
    expect(toSpeakableText('018f8b0c-0d03-72f1-9dd6-ece79b44e8be')).toBe('')
  })

  it('removes quoted API key assignments', () => {
    expect(
      toSpeakableText("api_key=\"0123456789abcdefghijklmnopqrstuvwxyz\"\napi_key='abcdefghijklmnopqrstuvwxyz0123456789'")
    ).toBe('')
  })

  it('removes internationalized bare URLs', () => {
    expect(toSpeakableText('访问 https://例子.测试/路径 和 www.例子.测试/路径。')).toBe('访问  和 。')
  })

  it('keeps natural explanations after command and path fragments', () => {
    expect(
      toSpeakableText(
        'git status failed because setup is broken\nnode scripts/run.js failed because setup is broken\n/Users/Alice/My Project/file.txt is missing'
      )
    ).toBe('failed because setup is broken\nfailed because setup is broken\nis missing')
  })

  it('drops standalone shell commands from common runtimes and build tools', () => {
    expect(toSpeakableText('ls -la\ncd src/main\npython scripts/run.py\ngo test ./...\ncargo test')).toBe('')
  })

  it('returns an empty string for standalone URLs with trailing sentence punctuation', () => {
    expect(toSpeakableText('https://example.com.\nhttps://example.com。\nwww.例子.测试/路径。')).toBe('')
  })

  it('drops standalone commands with arguments across supported command families', () => {
    expect(
      toSpeakableText(
        'echo hello world\nls\ncd ..\npython scripts/run.py --help\ngo test ./pkg\ncargo test --package app'
      )
    ).toBe('')
  })

  it('keeps the readable explanation after a parameterized command', () => {
    expect(toSpeakableText('python scripts/run.py --help failed because config is missing')).toBe(
      'failed because config is missing'
    )
  })

  it('removes environment secret assignments without removing numeric assignments', () => {
    expect(
      toSpeakableText(
        'OPENAI_API_KEY=abcdefghijklmnopqrstuvwxyz0123456789\nGITHUB_TOKEN=abcdefghijklmnopqrstuvwxyz0123456789\nCOUNT=42'
      )
    ).toBe('COUNT=42')
  })

  it('drops standalone wrapped URLs but keeps wrappers in natural prose', () => {
    expect(toSpeakableText('(https://example.com)')).toBe('')
    expect(toSpeakableText('请查看 (https://example.com)，然后继续。')).toBe('请查看 ()，然后继续。')
  })

  it('removes long hashes with algorithm prefixes', () => {
    expect(toSpeakableText('sha256:d2c7a1e9b9f4117d1bbf5aa236f4c8b5f6a3940e532ed7380cc3f9e6a2b47c11')).toBe('')
  })

  it('keeps readable descriptions after supported command families', () => {
    const explanation = 'failed because configuration is missing'
    const commands = [
      'echo hello world',
      'ls',
      'cd ..',
      'python scripts/run.py --help',
      'go test ./pkg',
      'cargo test --package app'
    ]

    for (const command of commands) {
      expect(toSpeakableText(`${command} ${explanation}`)).toContain(explanation)
    }
  })

  it('drops commands with positional arguments as whole technical lines', () => {
    expect(toSpeakableText('ls src\npython scripts/run.py positionalArgument')).toBe('')
  })

  it('strips an explained echo command instead of narrating its arguments', () => {
    expect(toSpeakableText('echo hello world failed because setup is broken')).toBe('failed because setup is broken')
  })

  it('removes environment secrets with uppercase values while retaining numeric assignments', () => {
    expect(toSpeakableText('OPENAI_API_KEY="ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"\nCOUNT=42')).toBe('COUNT=42')
  })

  it('drops Go and Cargo run and build commands without deleting ordinary prose', () => {
    expect(toSpeakableText('go run main.go\ngo build ./...\ncargo run --bin pet\ncargo build')).toBe('')
    expect(toSpeakableText('go run outside')).toBe('go run outside')
  })

  it('removes relative and absolute paths embedded in natural explanations', () => {
    expect(
      toSpeakableText(
        'See ./dist/app.js is missing\nPath C:/Users/Alice/My Project/file.txt is missing\nCheck /Users/Alice/My Project/file.txt is missing'
      )
    ).toBe('See  is missing\nPath  is missing\nCheck  is missing')
  })

  it('drops Go and Cargo commands with dot and positional package arguments', () => {
    expect(toSpeakableText('go test .\ngo run .\ngo build .\ncargo test parser_case')).toBe('')
    expect(toSpeakableText('go run outside')).toBe('go run outside')
  })

  it('removes embedded relative, Windows, and Unix paths anywhere in natural text', () => {
    expect(
      toSpeakableText(
        'The config is missing: ./dist/app.js\nUse C:/Users/Alice/My Project/file.txt after review\nOpen /Users/Alice/My Project/file.txt later'
      )
    ).toBe('The config is missing: \nUse  after review\nOpen  later')
  })

  it('removes sensitive API and token prefixes plus access-key environment variables', () => {
    expect(
      toSpeakableText(
        'api_1234567890abcdefghij\ntoken_1234567890abcdefghij\nAWS_SECRET_ACCESS_KEY=ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789\nCOUNT=42'
      )
    ).toBe('COUNT=42')
  })

  it('removes complete spaced and relative paths without leaving path fragments', () => {
    expect(
      toSpeakableText(
        'Path: C:/Program Files/Pet Agent after restart\nPath: /Users/Alice/My Project after restart\nRead src/main/foo.test.ts after restart'
      )
    ).toBe('Path:  after restart\nPath:  after restart\nRead  after restart')
  })

  it('drops package-manager commands with file arguments while preserving explanations', () => {
    expect(toSpeakableText('pnpm test src/main/foo.test.ts\nnpm run test src/main/foo.test.ts\nyarn test src/main/foo.test.ts')).toBe('')
    expect(toSpeakableText('pnpm test failed because setup is broken')).toBe('pnpm test failed because setup is broken')
  })

  it('drops standalone curl and wget commands before their URLs are stripped', () => {
    expect(toSpeakableText('curl https://example.com/api\nwget https://example.com/file')).toBe('')
  })

  it('keeps a standalone slash when it is used as natural-language punctuation', () => {
    expect(toSpeakableText('Use / as a separator when text is missing')).toBe('Use / as a separator when text is missing')
  })
})
