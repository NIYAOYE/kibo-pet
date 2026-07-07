# MVP-11 信息查询增强(天气查询)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 Agent 加一个 `weather` 工具:给定城市名,返回当前实况 + 未来 3 天预报(数据源 Open-Meteo,免 key)。

**Architecture:** 单文件 `src/main/tools/weather.ts` 承载全部逻辑,分三层:纯函数(天气码映射 / JSON 解析 / 结果格式化)、Open-Meteo 客户端(先地理编码再取预报,`fetch` 可注入便于单测)、`ToolSpec` 工厂。最后在 `src/main/shell/chat.ts` 的 registry 数组里注入一行——工具由项目默认注入,与宠物包无关。

**Tech Stack:** TypeScript(strict)· Electron 主进程 · 全局 `fetch`(已被 `duckduckgo.ts` 使用)· Vitest。零新依赖。

## Global Constraints

- **不要**给 `package.json` 加 `"type": "module"`(会让 Electron 主进程崩)。
- 工具/技能的可用性**由项目默认注入,恒定存在,与加载哪个宠物无关**;**绝不**放进宠物包(`pets/<id>/`),也**不**依赖 `pets/*/persona.md` 让模型「知道」某工具存在。工具用法引导只写在工具自己的 `description` 里。
- 复用 MVP-04 起的 `ToolSpec` / `toolRegistry` 机制:工具 `run` 抛的异常由 `toolRegistry.run` 兜底转 `isError` 回灌,**工具内部不自行 try/catch 吞异常**。
- 输出是可信 API 的结构化数值数据、由我们自己拼装,**不加**「不可信内容」反注入头(区别于 `web_search`)。
- 公制单位(°C / km·h⁻¹ / %)。返回内容固定为「实况 + 未来3天」,工具入参**仅** `location`(不设 `days` 参数)。
- 提交信息用中文,conventional-commit 风格。测试命令:`pnpm vitest run src/main/tools/weather.test.ts`。

---

### Task 1: 纯函数层(天气码映射 + 解析 + 格式化)

**Files:**
- Create: `src/main/tools/weather.ts`
- Test: `src/main/tools/weather.test.ts`

**Interfaces:**
- Consumes: 无(本任务是最底层)。
- Produces(后续任务依赖这些确切签名):
  - `interface GeoHit { name: string; latitude: number; longitude: number; admin1?: string; country?: string }`
  - `interface CurrentWeather { temperature: number; apparentTemperature: number; humidity: number; weatherCode: number; windSpeed: number }`
  - `interface DailyWeather { date: string; weatherCode: number; tempMax: number; tempMin: number; precipProbability: number }`
  - `interface ForecastData { current: CurrentWeather; daily: DailyWeather[] }`
  - `function wmoCodeText(code: number): string`
  - `function parseGeocoding(json: unknown): GeoHit[]`
  - `function parseForecast(json: unknown): ForecastData`
  - `function formatWeather(loc: GeoHit, data: ForecastData): string`

- [ ] **Step 1: 写失败测试**

写入 `src/main/tools/weather.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  wmoCodeText,
  parseGeocoding,
  parseForecast,
  formatWeather,
  type GeoHit,
  type ForecastData
} from './weather'

// Open-Meteo 地理编码响应样本(/v1/search?name=北京&count=1&language=zh)
const geoJson = {
  results: [
    { id: 1, name: '北京', latitude: 39.9075, longitude: 116.39723, admin1: '北京市', country: '中国' }
  ],
  generationtime_ms: 0.3
}

// 无命中:Open-Meteo 返回不带 results 键
const geoEmptyJson = { generationtime_ms: 0.2 }

// Open-Meteo 预报响应样本(forecast_days=4:今天 + 未来3天)
const forecastJson = {
  timezone: 'Asia/Shanghai',
  current: {
    time: '2026-07-06T14:00',
    temperature_2m: 30.5,
    apparent_temperature: 33.1,
    relative_humidity_2m: 55,
    weather_code: 2,
    wind_speed_10m: 12.4
  },
  daily: {
    time: ['2026-07-06', '2026-07-07', '2026-07-08', '2026-07-09'],
    weather_code: [2, 63, 3, 0],
    temperature_2m_max: [31, 28, 30, 33],
    temperature_2m_min: [22, 21, 20, 24],
    precipitation_probability_max: [10, 80, 30, 0]
  }
}

describe('wmoCodeText', () => {
  it('已知码映射到中文现象', () => {
    expect(wmoCodeText(0)).toBe('晴')
    expect(wmoCodeText(2)).toBe('多云')
    expect(wmoCodeText(63)).toBe('中雨')
    expect(wmoCodeText(95)).toBe('雷阵雨')
  })
  it('未知码退化为「未知(code N)」', () => {
    expect(wmoCodeText(42)).toBe('未知(code 42)')
  })
})

describe('parseGeocoding', () => {
  it('取出命中项的名称/经纬度/行政区/国家', () => {
    const hits = parseGeocoding(geoJson)
    expect(hits).toHaveLength(1)
    expect(hits[0]).toEqual({
      name: '北京', latitude: 39.9075, longitude: 116.39723, admin1: '北京市', country: '中国'
    })
  })
  it('无 results 键退化为空数组', () => {
    expect(parseGeocoding(geoEmptyJson)).toEqual([])
    expect(parseGeocoding({})).toEqual([])
    expect(parseGeocoding(null)).toEqual([])
  })
})

describe('parseForecast', () => {
  it('取出当前实况与每日数组', () => {
    const data = parseForecast(forecastJson)
    expect(data.current).toEqual({
      temperature: 30.5, apparentTemperature: 33.1, humidity: 55, weatherCode: 2, windSpeed: 12.4
    })
    expect(data.daily).toHaveLength(4)
    expect(data.daily[1]).toEqual({
      date: '2026-07-07', weatherCode: 63, tempMax: 28, tempMin: 21, precipProbability: 80
    })
  })
})

describe('formatWeather', () => {
  it('含地点、当前实况、未来3天(取 daily[1..3])', () => {
    const loc: GeoHit = geoJson.results[0]
    const data: ForecastData = parseForecast(forecastJson)
    const text = formatWeather(loc, data)
    expect(text).toContain('北京·北京市·中国')
    expect(text).toContain('多云 30.5°C(体感 33.1°C)')
    expect(text).toContain('湿度 55%')
    expect(text).toContain('未来3天')
    // 未来3天从明天起(daily[1..3]),不含今天(07-06)
    expect(text).toContain('07-07 中雨 21~28°C 降水概率 80%')
    expect(text).toContain('07-09 晴 24~33°C 降水概率 0%')
    expect(text).not.toContain('07-06')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/tools/weather.test.ts`
Expected: FAIL —— 找不到模块 `./weather` / 导出未定义。

- [ ] **Step 3: 写最小实现**

写入 `src/main/tools/weather.ts`:

```ts
export interface GeoHit {
  name: string
  latitude: number
  longitude: number
  admin1?: string
  country?: string
}

export interface CurrentWeather {
  temperature: number
  apparentTemperature: number
  humidity: number
  weatherCode: number
  windSpeed: number
}

export interface DailyWeather {
  date: string
  weatherCode: number
  tempMax: number
  tempMin: number
  precipProbability: number
}

export interface ForecastData {
  current: CurrentWeather
  daily: DailyWeather[]
}

// WMO weather code(0–99)→ 中文天气现象。天气码语义变动时此表是唯一改动点。
const WMO_TEXT: Record<number, string> = {
  0: '晴', 1: '大部晴朗', 2: '多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨', 56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '米雪',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨', 85: '小阵雪', 86: '强阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹'
}

export function wmoCodeText(code: number): string {
  return WMO_TEXT[code] ?? `未知(code ${code})`
}

export function parseGeocoding(json: unknown): GeoHit[] {
  const results = (json as { results?: unknown } | null)?.results
  if (!Array.isArray(results)) return []
  return results
    .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
    .map((r) => ({
      name: String(r.name ?? ''),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      admin1: r.admin1 != null ? String(r.admin1) : undefined,
      country: r.country != null ? String(r.country) : undefined
    }))
    .filter((h) => h.name !== '' && Number.isFinite(h.latitude) && Number.isFinite(h.longitude))
}

export function parseForecast(json: unknown): ForecastData {
  const o = (json ?? {}) as { current?: Record<string, unknown>; daily?: Record<string, unknown> }
  const cur = o.current ?? {}
  const current: CurrentWeather = {
    temperature: Number(cur.temperature_2m),
    apparentTemperature: Number(cur.apparent_temperature),
    humidity: Number(cur.relative_humidity_2m),
    weatherCode: Number(cur.weather_code),
    windSpeed: Number(cur.wind_speed_10m)
  }
  const d = o.daily ?? {}
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
  const times = arr(d.time)
  const codes = arr(d.weather_code)
  const maxs = arr(d.temperature_2m_max)
  const mins = arr(d.temperature_2m_min)
  const pops = arr(d.precipitation_probability_max)
  const daily: DailyWeather[] = times.map((t, i) => ({
    date: String(t),
    weatherCode: Number(codes[i]),
    tempMax: Number(maxs[i]),
    tempMin: Number(mins[i]),
    precipProbability: Number(pops[i])
  }))
  return { current, daily }
}

export function formatWeather(loc: GeoHit, data: ForecastData): string {
  const place = [loc.name, loc.admin1, loc.country].filter((s) => s && s.length > 0).join('·')
  const c = data.current
  const head =
    `${place} 天气\n\n` +
    `当前:${wmoCodeText(c.weatherCode)} ${c.temperature}°C(体感 ${c.apparentTemperature}°C) ` +
    `湿度 ${c.humidity}% 风速 ${c.windSpeed} km/h`
  const rows = data.daily.slice(1, 4).map((d) =>
    `${d.date.slice(5)} ${wmoCodeText(d.weatherCode)} ${d.tempMin}~${d.tempMax}°C 降水概率 ${d.precipProbability}%`
  )
  return `${head}\n\n未来3天:\n${rows.join('\n')}`
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/tools/weather.test.ts`
Expected: PASS(全部用例绿)。

- [ ] **Step 5: 提交**

```bash
git add src/main/tools/weather.ts src/main/tools/weather.test.ts
git commit -m "feat(weather): 天气码映射 + 地理编码/预报解析 + 结果格式化(纯函数)"
```

---

### Task 2: Open-Meteo 客户端

**Files:**
- Modify: `src/main/tools/weather.ts`(追加 client)
- Test: `src/main/tools/weather.test.ts`(追加 client 用例)

**Interfaces:**
- Consumes: Task 1 的 `parseGeocoding` / `parseForecast` / `GeoHit` / `ForecastData`。
- Produces:
  - `interface WeatherResult { loc: GeoHit; data: ForecastData }`
  - `interface WeatherClient { getWeather(location: string, signal: AbortSignal): Promise<WeatherResult | null> }`(`null` = 地名无命中)
  - `function createOpenMeteoClient(fetchFn?: typeof fetch): WeatherClient`

- [ ] **Step 1: 写失败测试**

追加到 `src/main/tools/weather.test.ts`(文件末尾;沿用 Task 1 已定义的 `geoJson`/`geoEmptyJson`/`forecastJson` 常量与已有 import,并把 `createOpenMeteoClient` 加进顶部 import):

```ts
import { createOpenMeteoClient } from './weather'  // 合并进顶部已有 import

describe('createOpenMeteoClient', () => {
  const signal = new AbortController().signal
  // 按 URL 路由的假 fetch:含 'geocoding' 走地理编码,否则走预报
  const routed = (geo: unknown, forecast: unknown, geoStatus = 200, fStatus = 200): typeof fetch =>
    (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('geocoding')) return new Response(JSON.stringify(geo), { status: geoStatus })
      return new Response(JSON.stringify(forecast), { status: fStatus })
    }) as typeof fetch

  it('happy-path:地理编码 URL 带 name/language/count,预报 URL 带经纬度与 forecast_days=4,返回 loc+data', async () => {
    const urls: string[] = []
    const fetchFn: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      urls.push(u)
      if (u.includes('geocoding')) return new Response(JSON.stringify(geoJson), { status: 200 })
      return new Response(JSON.stringify(forecastJson), { status: 200 })
    }) as typeof fetch
    const res = await createOpenMeteoClient(fetchFn).getWeather('北京', signal)
    expect(res).not.toBeNull()
    expect(res!.loc.name).toBe('北京')
    expect(res!.data.daily).toHaveLength(4)
    expect(urls[0]).toContain('geocoding-api.open-meteo.com/v1/search')
    expect(urls[0]).toContain('name=%E5%8C%97%E4%BA%AC') // encodeURIComponent('北京')
    expect(urls[0]).toContain('language=zh')
    expect(urls[0]).toContain('count=1')
    expect(urls[1]).toContain('api.open-meteo.com/v1/forecast')
    expect(urls[1]).toContain('latitude=39.9075')
    expect(urls[1]).toContain('longitude=116.39723')
    expect(urls[1]).toContain('forecast_days=4')
  })

  it('地名无命中返回 null(不请求预报)', async () => {
    let forecastCalled = false
    const fetchFn: typeof fetch = (async (url: string | URL | Request) => {
      const u = String(url)
      if (u.includes('geocoding')) return new Response(JSON.stringify(geoEmptyJson), { status: 200 })
      forecastCalled = true
      return new Response(JSON.stringify(forecastJson), { status: 200 })
    }) as typeof fetch
    const res = await createOpenMeteoClient(fetchFn).getWeather('不存在的地方xyz', signal)
    expect(res).toBeNull()
    expect(forecastCalled).toBe(false)
  })

  it('地理编码 HTTP 非 2xx 抛人话错误', async () => {
    await expect(createOpenMeteoClient(routed(geoJson, forecastJson, 500)).getWeather('北京', signal))
      .rejects.toThrow(/500/)
  })

  it('预报 HTTP 非 2xx 抛人话错误', async () => {
    await expect(createOpenMeteoClient(routed(geoJson, forecastJson, 200, 503)).getWeather('北京', signal))
      .rejects.toThrow(/503/)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/tools/weather.test.ts`
Expected: FAIL —— `createOpenMeteoClient` 未定义。

- [ ] **Step 3: 写最小实现**

追加到 `src/main/tools/weather.ts` 末尾:

```ts
const GEO_ENDPOINT = 'https://geocoding-api.open-meteo.com/v1/search'
const FORECAST_ENDPOINT = 'https://api.open-meteo.com/v1/forecast'

export interface WeatherResult {
  loc: GeoHit
  data: ForecastData
}

export interface WeatherClient {
  getWeather(location: string, signal: AbortSignal): Promise<WeatherResult | null>
}

export function createOpenMeteoClient(fetchFn: typeof fetch = fetch): WeatherClient {
  return {
    async getWeather(location, signal) {
      const geoUrl =
        `${GEO_ENDPOINT}?name=${encodeURIComponent(location)}&count=1&language=zh&format=json`
      const geoRes = await fetchFn(geoUrl, { signal })
      if (!geoRes.ok) throw new Error(`天气地点查询失败(HTTP ${geoRes.status})`)
      const hits = parseGeocoding(await geoRes.json())
      if (hits.length === 0) return null
      const loc = hits[0]
      const forecastUrl =
        `${FORECAST_ENDPOINT}?latitude=${loc.latitude}&longitude=${loc.longitude}` +
        `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m` +
        `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
        `&timezone=auto&forecast_days=4`
      const fRes = await fetchFn(forecastUrl, { signal })
      if (!fRes.ok) throw new Error(`天气预报查询失败(HTTP ${fRes.status})`)
      const data = parseForecast(await fRes.json())
      return { loc, data }
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/tools/weather.test.ts`
Expected: PASS(Task 1 + Task 2 全部用例绿)。

- [ ] **Step 5: 提交**

```bash
git add src/main/tools/weather.ts src/main/tools/weather.test.ts
git commit -m "feat(weather): Open-Meteo 客户端(地理编码+预报,可注入 fetch)"
```

---

### Task 3: `weather` 工具(ToolSpec)

**Files:**
- Modify: `src/main/tools/weather.ts`(追加工具工厂)
- Test: `src/main/tools/weather.test.ts`(追加工具用例)

**Interfaces:**
- Consumes: Task 2 的 `WeatherClient` / `WeatherResult`;Task 1 的 `formatWeather`;`./toolSpec` 的 `ToolSpec`。
- Produces:
  - `function createWeatherTool(client: WeatherClient): ToolSpec`(name `weather`,必填入参 `location`)

- [ ] **Step 1: 写失败测试**

追加到 `src/main/tools/weather.test.ts`(把 `createWeatherTool` 并入顶部 import;`type GeoHit`/`ForecastData` 已 import,复用 `forecastJson`/`geoJson`):

```ts
import { createWeatherTool, type WeatherClient } from './weather'  // 合并进顶部已有 import

describe('createWeatherTool', () => {
  const ctx = { signal: new AbortController().signal }
  const loc = geoJson.results[0]
  const okClient: WeatherClient = { async getWeather() { return { loc, data: parseForecast(forecastJson) } } }

  it('声明:名字 weather,location 必填', () => {
    const tool = createWeatherTool(okClient)
    expect(tool.name).toBe('weather')
    expect(tool.inputSchema.required as string[]).toContain('location')
  })

  it('执行:先 onStatus 播报,返回格式化天气', async () => {
    const statuses: string[] = []
    const tool = createWeatherTool(okClient)
    const out = await tool.run({ location: '北京' }, { ...ctx, onStatus: (t) => statuses.push(t) })
    expect(statuses).toEqual(['正在查询天气:北京'])
    expect(out).toContain('北京·北京市·中国')
    expect(out).toContain('未来3天')
  })

  it('地名无命中(client 返回 null)→ 友好文案,不抛', async () => {
    const tool = createWeatherTool({ async getWeather() { return null } })
    const out = await tool.run({ location: '火星城' }, ctx)
    expect(out).toContain('没找到')
    expect(out).toContain('火星城')
  })

  it('client 抛错原样冒泡(由 registry 转 isError)', async () => {
    const tool = createWeatherTool({ async getWeather() { throw new Error('网络挂了') } })
    await expect(tool.run({ location: '北京' }, ctx)).rejects.toThrow('网络挂了')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm vitest run src/main/tools/weather.test.ts`
Expected: FAIL —— `createWeatherTool` 未定义。

- [ ] **Step 3: 写最小实现**

先在 `src/main/tools/weather.ts` 顶部加导入:

```ts
import type { ToolSpec } from './toolSpec'
```

再追加到文件末尾:

```ts
export function createWeatherTool(client: WeatherClient): ToolSpec {
  return {
    name: 'weather',
    description:
      '查询某个城市/地点的天气(当前实况 + 未来3天预报)。当用户问天气、气温、会不会下雨这类问题时调用。' +
      'location 必填;若用户没说是哪个城市,先反问用户在哪个城市,不要瞎猜。',
    inputSchema: {
      type: 'object',
      properties: {
        location: { type: 'string', description: '城市或地点名,如「北京」「上海浦东」' }
      },
      required: ['location']
    },
    async run(input, ctx) {
      const { location } = input as { location: string }
      ctx.onStatus?.(`正在查询天气:${location}`)
      const result = await client.getWeather(location, ctx.signal)
      if (!result) return `没找到「${location}」这个地方,请确认地名或换个说法。`
      return formatWeather(result.loc, result.data)
    }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm vitest run src/main/tools/weather.test.ts`
Expected: PASS(三个 describe 全绿)。

- [ ] **Step 5: 提交**

```bash
git add src/main/tools/weather.ts src/main/tools/weather.test.ts
git commit -m "feat(weather): weather 工具(location 必填,实况+未来3天)"
```

---

### Task 4: 接入 chat registry + 全量回归

**Files:**
- Modify: `src/main/shell/chat.ts`(import + registry 数组各加一行)

**Interfaces:**
- Consumes: Task 2 的 `createOpenMeteoClient`、Task 3 的 `createWeatherTool`。
- Produces: 无(集成收尾)。

说明:此任务无新单测(纯接线,行为等同已测的工具 + 已测的 registry;真机 GUI 由人工验收)。deliverable 是「工具在真实对话里被默认注入且全量回归不破」。

- [ ] **Step 1: 加 import**

在 `src/main/shell/chat.ts` 现有 `import { createTodoTools } from '../tools/todoTools'` 一行下方,加:

```ts
import { createWeatherTool, createOpenMeteoClient } from '../tools/weather'
```

- [ ] **Step 2: 把工具加进 registry**

在 `handleSend` 内 `createToolRegistry([...])` 的数组里(现有 `...createTodoTools({ store: opts.todoStore, now: () => Date.now() })` 之后),加一行:

```ts
      const registry = createToolRegistry([
        createWebSearchTool(backend),
        createReadSkillTool(opts.skills),
        createSaveMemoryTool((t) => opts.memory.saveFact(t)),
        createReadClipboardTool({ readText: () => opts.clipboard.readText() }),
        createWriteClipboardTool({ writeText: (t) => opts.clipboard.writeText(t) }),
        ...createTodoTools({ store: opts.todoStore, now: () => Date.now() }),
        createWeatherTool(createOpenMeteoClient())
      ])
```

- [ ] **Step 3: 类型检查**

Run: `pnpm typecheck`
Expected: PASS(无类型错误)。

- [ ] **Step 4: 全量测试回归**

Run: `pnpm test`
Expected: PASS —— 既有全部用例 + 新增 weather 用例全绿,无回归。

- [ ] **Step 5: 构建三包**

Run: `pnpm build`
Expected: PASS(main/preload/renderer 三包构建成功)。

- [ ] **Step 6: 提交**

```bash
git add src/main/shell/chat.ts
git commit -m "feat(weather): 把 weather 工具接入 chat registry(项目默认注入)"
```

- [ ] **Step 7: 真机肉眼验收(人工)**

`pnpm dev` 或 `pnpm build && pnpm preview`,在对话框里逐条走:
1. 「北京今天天气怎么样」→ 宠物调用 weather、回复含当前实况 + 未来3天 + 地点(状态行出现「正在查询天气:北京」)。
2. 「上海未来三天会下雨吗」→ 回复含 3 天降水概率。
3. 一个不存在的地名(如「火星城」)→ 友好提示「没找到…」。
4. 只问「今天天气怎么样」不给城市 → 宠物反问在哪个城市(而非瞎猜)。

(后台环境无显示器,GUI 交互按项目既有惯例由人工完成。)

---

## Self-Review

**Spec coverage:**
- 数据源 Open-Meteo 地理编码 + 预报、免 key → Task 2 客户端两个 endpoint。✅
- 返回实况 + 未来3天、公制 → Task 1 `formatWeather`(daily[1..3])+ 客户端 `current`/`daily` 参数。✅
- 零配置(无 key/IPC/preload/设置/依赖)→ Task 4 仅改 chat.ts 一处;全程无新依赖。✅
- 地点缺失反问 → Task 3 `location` 必填 + description 引导 + registry `validateInput` 兜底。✅
- 无命中返回不抛 / HTTP 抛错回灌 → Task 2(client 返回 null / 抛 HTTP 错误)+ Task 3(null→文案,client 抛错冒泡)。✅
- 不加反注入头 → 实现里 `formatWeather` 无 untrusted header。✅
- WMO 码映射纯函数 + fixture 单测 → Task 1。✅
- 工具项目默认注入、不进宠物包、不碰 persona.md → Task 4 接入 chat registry;全程不动 `pets/*`。✅

**Placeholder scan:** 无 TBD/TODO;每个代码步骤均含完整代码。✅

**Type consistency:** `GeoHit`/`CurrentWeather`/`DailyWeather`/`ForecastData`/`WeatherResult`/`WeatherClient` 在 Task 1/2 定义,Task 2/3 按同名同签名消费;`createOpenMeteoClient`/`createWeatherTool`/`formatWeather`/`parseForecast`/`parseGeocoding`/`wmoCodeText` 全程名字一致。`getWeather(location, signal)` 签名 Task 2 定义、Task 3 消费一致。✅
