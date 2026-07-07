# MVP-11 信息查询增强(天气查询)— 设计

> 2026-07-06 与用户 brainstorming 定下。承接 ROADMAP.md 第③项「信息查询增强」。
> 本期**只做天气查询一个工具**;汇率 / 单位换算 / 快递各留作后续独立 MVP。

## 1. 背景与目标

在已有 `web_search` 工具之上,给 Agent 加一个**结构化天气查询工具** `weather`,复用 MVP-04 起的
`ToolSpec` / `toolRegistry` / agentLoop 回灌机制(和剪贴板、待办工具同一套)。

- **数据源**:[Open-Meteo](https://open-meteo.com/) —— 免 key、免注册、公益 API。
  - 地理编码:`https://geocoding-api.open-meteo.com/v1/search`(地名 → 经纬度,支持中文)
  - 预报:`https://api.open-meteo.com/v1/forecast`(实况 + 每日预报)
- **返回内容**:当前实况 + 未来 3 天预报,公制单位(°C / km·h⁻¹ / mm / %)。
- **零配置**:不需要 API key、不加设置项、不加 IPC 通道、不碰 preload/renderer、不加依赖。
- **地点缺失**:`location` 为必填参数;用户没说城市时,由模型自然反问「你在哪个城市」。

### 非目标(各留作后续独立 MVP / 明确不做)

- 汇率换算、单位换算、快递查询(ROADMAP 第③项其余子工具)。
- 「默认城市」设置项、IP 自动定位。
- 超过 3 天的预报、逐小时预报、空气质量 / 生活指数等。

## 2. 架构与组件

单文件模块 `src/main/tools/weather.ts`,沿用 `searchBackends/duckduckgo.ts` 的
`createXBackend(fetchFn = fetch)` 形状(可注入 `fetch` 便于单测)。**不**新建 `weatherBackends/` 目录
——那套后端抽象是因为搜索有两个 provider(DDG + Tavily);天气只有一个 provider,YAGNI。
纯格式化函数留在 `tools/` 内(与 `webSearch.ts` 的 `formatSearchResults` 一致),不进 `@shared`
(渲染层用不到)。

### 2.1 纯函数(可单测,无 electron)

- `wmoCodeText(code: number): string`
  WMO weather-code(0–99)→ 中文天气现象(晴 / 多云 / 雾 / 小雨 / 雷阵雨 / 小雪 …);
  未知码 → `未知(code N)`。天气码语义变动时这里是唯一改动点。
- `parseGeocoding(json: unknown): GeoHit[]`
  解析地理编码响应 → `{ name, latitude, longitude, admin1?, country? }[]`;非预期结构退化为空数组。
- `parseForecast(json: unknown): ForecastData`
  解析预报响应 → 当前实况 + 每日数组的类型化结构。
- `formatWeather(loc: GeoHit, data: ForecastData): string`
  纯拼装最终面向模型的中文文本:地点(名称 + admin1/country 消歧)+ 当前实况
  (温度 / 体感 / 天气现象 / 风速 / 湿度)+ 未来 3 天表(日期 · 现象 · 高/低温 · 降水概率)。

### 2.2 客户端

- `interface WeatherClient { getWeather(location, signal): Promise<...> }`
  内部先 `geocode` 再 `forecast`。
- `createOpenMeteoClient(fetchFn = fetch): WeatherClient`
  - `geocode`:`GET .../v1/search?name=<location>&count=1&language=zh&format=json`
    → `parseGeocoding` → 取首条命中。
  - `forecast`:`GET .../v1/forecast?latitude=<lat>&longitude=<lon>`
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m`
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`
    `&timezone=auto&forecast_days=4` → `parseForecast`。
    (`forecast_days=4` = 今天 + 未来 3 天;`current` 覆盖今天实况,每日表取其后 3 天。)

### 2.3 工具

- `createWeatherTool(client: WeatherClient): ToolSpec`
  - `name: 'weather'`
  - `description`:引导模型「查询某地天气/未来几天天气时调用;location 必填,用户没说城市要先问」。
  - `inputSchema`:仅 `location`(string,必填)。返回内容固定为「实况 + 未来 3 天」,
    不设 `days` 参数(小模型输入面越窄越稳,也贴合已定的固定返回)。
  - `run(input, ctx)`:`ctx.onStatus('正在查询天气:<location>')` → `client.getWeather(...)`
    → `formatWeather` → 返回字符串;`ctx.signal` 透传给两次 fetch。

## 3. 数据流

```
模型 → weather({ location: "北京" })
  → onStatus("正在查询天气:北京")
  → geocode("北京")  → 取首条命中 { name:"北京", lat, lon, admin1, country }
  → forecast(lat, lon)  → { current, daily[] }  (forecast_days=4:今天 + 未来 3 天)
  → formatWeather(loc, data)  → 中文文本
  → 返回给 agentLoop 回灌
```

## 4. 错误与边界处理

- **地理编码 0 命中**:**返回**友好文案(`没找到「X」这个地方,请确认地名或换个说法。`),
  **不抛异常** —— 让模型把它转达 / 追问用户。
- **完全没给城市**:`location` 必填 → 由 `validateInput` 拦下并回灌「缺少必填参数 location」,
  模型据此反问用户(用户已确认的期望行为)。
- **HTTP 非 2xx**(geocode 或 forecast):**抛异常** → `toolRegistry.run` 捕获转成 `isError` 文本
  回灌,绝不使 agent 循环崩溃。
- **取消**:`ctx.signal` 透传到两次 fetch;上层取消照常静默丢弃。
- **反注入**:**不加** `web_search` 那样的「不可信内容」头 —— 输出是可信 API 返回的、由我们自己
  拼装的结构化数值数据,没有自由文本注入面;唯一回显的字符串是我们控制的地点名。

## 5. 接线

`src/main/shell/chat.ts` 的 `handleSend` 里,把 `createWeatherTool(createOpenMeteoClient())`
加进 `createToolRegistry([...])` 数组(现约第 179–186 行)。**仅此一处改动**:
无新 IPC 通道、无 preload、无 renderer、无 settings、无 secrets、无新依赖。
(全局 `fetch` 已被 `duckduckgo.ts` 使用,沿用即可。)

## 6. 测试

`src/main/tools/weather.test.ts`(纯 Vitest,不引 electron),仿 `webSearch.test.ts` 用 fixture:

- `wmoCodeText`:已知码若干 + 未知码退化。
- `parseGeocoding`:多命中取首条、空结果退化空数组、脏结构不抛。
- `parseForecast` + `formatWeather`:从保存的预报 fixture 断言输出含地点、当前温度/现象、3 天行。
- `createOpenMeteoClient` 用假 `fetch`:
  - happy-path(geocode fixture + forecast fixture → 文本);
  - 地名无命中 → 返回「没找到」文案;
  - geocode / forecast HTTP 错误 → 抛异常(由 registry 兜底,单测直接断言抛)。

## 7. 验收

- `pnpm typecheck` / `pnpm test`(新增用例全绿,回归不破)/ `pnpm build` 三包通过。
- 真机 `pnpm dev` 或 `pnpm preview`:问「北京今天天气怎么样」「上海未来三天会下雨吗」→
  宠物调用 weather、回复含实况 + 3 天预报 + 地点;问一个不存在的地名 → 友好提示;
  只问「今天天气怎么样」不给城市 → 宠物反问在哪个城市。
  (真机 GUI 交互按项目既有惯例由人工肉眼验收。)

## 8. 原则:工具/技能是项目默认注入,不进宠物包

**工具和技能的可用性由项目本身默认注入,恒定存在,与加载哪个宠物无关;绝不放进宠物包
(`pets/<id>/`),也不依赖宠物包内容(如 `persona.md`)来让模型「知道」某个工具存在。**

- `weather` 工具在项目代码 `src/main/shell/chat.ts` 的 registry 里注入,换任何宠物都恒在
  (与 `web_search` / 剪贴板 / 待办同一套);它的用法引导写在**工具自己的 `description`**(项目代码)里,
  随 `ToolDef` 传给模型 —— 模型的工具可发现性完全不经过宠物包。
- 因此**不**在 `pets/luluka/persona.md` 里加任何「有 weather 工具」之类的引导:那会把工具可发现性
  错误地耦合进宠物包(且 persona.md 被 gitignore、换宠物即失效)。persona.md 只管人设口吻,不管工具清单。

## 9. 遗留 / 说明

- Open-Meteo 是公益 API,理论上有可用性/限流风险(ROADMAP 已标注为第③项主要风险点);
  HTTP 错误已由 registry 兜底回灌,不致崩溃。
