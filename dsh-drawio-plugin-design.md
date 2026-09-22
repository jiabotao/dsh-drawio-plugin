# dsh-drawio-plugin 开发设计文档

> 本文档是 [dsh-drawio-plugin-spec.md](dsh-drawio-plugin-spec.md) 的落地设计。
> 所有 API 形状均已对照三方源码核实：deepseek-harness(dsh) 官方仓库、drawio 官方仓库、
> OpenViking `examples/dsh-memory-plugin`。关键证据见附录 A。
>
> 硬约束不变：**不改 dsh 任何源码**；独立 npm 包；只在 web profile 生效；ESM；Node `^22.19 || >=24`。

---

## 1. 设计总览

### 1.1 运行时数据流

```
模型 ──tool call──► drawio_render (Host) ──ctx.fs──► 工作区 diagrams/*.drawio
                        │
                        │ 工具结果持久化到会话日志
                        ▼
              对话流 DrawioCard (Client, 按 key='drawio_render' 分发)
                        │
                        ├─ 缩略图: 隐藏 iframe /drawio/index.html?embed=1&proto=json
                        │     load → export svg → <img>
                        │
                        └─ [编辑] → 全屏覆盖层 iframe (ui=min)
                              关闭时 export xml → POST /drawio/save ──ctx.fs──► 写盘
                              → drawio-file 资源推帧 → 缩略图自动刷新
```

静态资源：`GET /drawio/*` (prefix) 直接由 Host 从包内 `vendor/drawio/` 吐出，用户机器零安装。

### 1.2 双面包挂载原理（单行 patch）

dsh 的第一方 UI 包全是"双面包"：包根导出是 Node 半（可为空 `apply(){}`），`exports["./client"]` 是浏览器半，
`package.json` 里 `dsh.client` 声明平台与依赖。cordis 树中**一行包名条目**同时驱动两侧：

- Host 侧：Loader import 包根导出（`host.mjs`），执行 `apply(ctx)`；
- 浏览器侧：`dsh-client-modules` 的 Node 半增量扫描 Loader 条目，发现 `dsh.client` 声明后解析
  `./client` 导出，把构建产物拼进 `window.__DSH_BOOT__`，经 webserver index 注入 + combo 脚本
  (`/plugins/<pkg>/client.js`) 送达浏览器模块表。

因此 `cordis.patch.yml` **只挂一行**：

```yaml
- insert:
    - id: dsh-drawio
      name: '@you/dsh-drawio-plugin'
```

> 禁止再插 `name: '@you/dsh-drawio-plugin/client'` 第二行：vendored loader 对 `/client` 后缀
> 没有特判，会把浏览器 bundle 当 Node 插件 import（inject 失败或 `window` 未定义）。

### 1.3 包结构

```
dsh-drawio-plugin/                    # npm 包 @you/dsh-drawio-plugin
├─ package.json                       # dsh.bundle.patch + dsh.client + exports + peerDeps
├─ cordis.patch.yml                   # 单行 insert
├─ host.mjs                           # Host 半入口(纯 JS,无构建):工具 + 路由 + skill 挂载
├─ client/
│  ├─ src/
│  │  ├─ index.ts                     # apply: locale/slots/resources 注册
│  │  ├─ card.tsx                     # DrawioCard 工具卡片
│  │  ├─ thumbnail.tsx                # 缩略图(隐藏 embed iframe → svg)
│  │  ├─ editor-overlay.tsx           # 全屏编辑器覆盖层(React portal)
│  │  ├─ embed.ts                     # drawio embed postMessage 协议封装
│  │  ├─ resource.ts                  # drawio-file 资源 provider + 保存发布
│  │  └─ locales.ts                   # NS/zh/en 字典
│  ├─ tsdown.config.ts                # 复刻第一方 client bundle 契约(见 §4.1)
│  └─ lib/client.js                   # 构建产物(npm pack 前必须构建)
├─ vendor/drawio/                     # drawio webapp 静态资源(pin 版本)
│  ├─ index.html  js/  styles/  stencils/  mxgraph/  shapes/  images/ ...
│  ├─ LICENSE                         # drawio Apache-2.0
│  └─ VERSION                         # 记录 vendor 的 drawio 版本号
├─ skills/drawio-diagram/SKILL.md     # 模型写图教材(内容见 spec §8)
├─ scripts/fetch-drawio.mjs           # vendor 下载/更新脚本(不进 files)
├─ test/*.test.mjs                    # host 侧 node --test
└─ README.md
```

---

## 2. package.json 设计

```json
{
  "name": "@you/dsh-drawio-plugin",
  "version": "0.1.0",
  "description": "Draw.io diagrams in DeepSeek Harness conversations",
  "type": "module",
  "main": "host.mjs",
  "exports": {
    ".": "./host.mjs",
    "./client": "./client/lib/client.js",
    "./package.json": "./package.json"
  },
  "files": [
    "host.mjs",
    "client/lib/",
    "cordis.patch.yml",
    "vendor/drawio/",
    "skills/",
    "README.md",
    "LICENSE"
  ],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": [
        "@deepseek-ai/dsh-client-ui-renderer",
        "@deepseek-ai/dsh-client-ui-tool",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-resources"
      ]
    }
  },
  "engines": { "node": "^22.19.0 || >=24" },
  "peerDependencies": {
    "@deepseek-ai/dsh-tools": ">=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1",
    "@deepseek-ai/dsh-skill-filesystem": ">=0.1.0-rc.6 <0.2.0 || ^0.1.5-rc.1"
  },
  "scripts": {
    "build": "tsdown --config client/tsdown.config.ts",
    "fetch-drawio": "node scripts/fetch-drawio.mjs",
    "test": "node --test test/*.test.mjs",
    "prepack": "npm run build"
  },
  "license": "Apache-2.0"
}
```

要点：

- `exports["."]` → `host.mjs`：Host Loader 的 import 目标，必须 Node 安全（顶层不碰浏览器 API）。
- `exports["./client"]` → 构建产物：client-modules 凭 `dsh.client` 声明发现它；**pack 前必须已构建**，
  缺失时宿主启动会以 `MissingClientBundleError` 明确报错。
- `dsh.client.inject` 列**包名**（不是 ctx 服务名）：分别提供 `ctx.slots`、toolview props 类型座位、
  `ctx.locale`、`ctx.resources`。代码里的 `export const inject`（§4.2）列的是 ctx 服务名，两者勿混。
- peerDeps 只声明运行时真正 import 的包（`dsh-tools` 的 `defineTool`、`dsh-skill-filesystem` 的 skill
  provider），范围照 openviking 先例，显式承认多个 RC 子系列。`ctx.fs`/`ctx.webServer` 等仅是
  ctx 服务，纯 JS 下不产生 import，不入 peerDeps。

---

## 3. Host 半设计（`host.mjs`）

### 3.1 插件契约

```js
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'

export const name = 'dsh-drawio-plugin'
export const inject = ['tools', 'webServer', 'connection', 'fs', 'sessions']

export function apply(ctx, input = {}) {
  registerDrawioTool(ctx)      // §3.2,ctx.effect 包裹
  registerDrawioRoutes(ctx)    // §3.3,每条路由一个 ctx.effect
  mountDrawioSkills(ctx)       // §3.4
}
```

- 所有注册都包在 `ctx.effect()` 里，保证 profile 热更新/卸载时路由与工具被回收（照 open-in-app 先例）。
- `connection` 服务是浏览器侧包，Host 侧无类型，照样板用 `Reflect.get(ctx, 'connection')` 取，
  接口签名：`requestRejection(req) → 401 | 403 | undefined`。

### 3.2 工具 `drawio_render`

wire 工具名固定 `drawio_render`（Client 卡片按此 key 分发）。

**parameters**（`defineTool` 的 ValueSchemaSpec DSL）：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 是 | 图标题，用于默认文件名 |
| `xml` | string | 是 | 完整 `.drawio` mxfile XML（SKILL.md 教模型产出） |
| `path` | string | 否 | 工作区内相对路径，默认 `diagrams/<title>.drawio` |

**描述**（写给模型）：当用户要求绘制架构图、时序图、流程图、思维导图、甘特图、示意图等图形时调用；
`xml` 必须是完整 mxfile 文档。

**output**：

- `schema`：`{ filePath: string, xml: string }`（canonical value 持久化到会话日志，供回放与卡片使用）。
- `render(args, value)`：只回一段短文本（如 `已创建 drawio 图：<filePath>`）。**不把 xml 回喂模型**，
  节省 token；xml 已在 args 与日志里。

**execute 流程**：

1. `const cwd = exec.agent?.session.header.cwd`；无 agent（非会话调用）→ 抛错拒绝（照 tool-fs 惯例）。
2. `rel = path ?? \`diagrams/${sanitize(title)}.drawio\``；`sanitize` 去掉路径分隔符与非法字符，
   强制 `.drawio` 后缀。
3. `const target = await ctx.fs.resolve(rel, { cwd, signal: exec.signal })`——越出工作区由 fs 层拒绝
   （照 `packages/fs/tool-fs/src/session-cwd.ts`）。
4. `await ctx.fs.writeText(target, xml)`（方法名以 `@deepseek-ai/dsh-fs` 类型为准）。
5. `return { filePath: rel, xml }`。
6. 全程转发 `exec.signal`；**不在 Host 侧做 SVG 导出**（导出在浏览器 iframe 内完成，零外部依赖）。

### 3.3 HTTP 路由（`ctx.webServer.register`）

三条路由，全部以 `requestRejection` 开头（Host/Origin 栅栏 + 登录 cookie 认证，照 open-in-app）：

| # | kind / path | 方法 | 行为 |
| --- | --- | --- | --- |
| 1 | `prefix` `/drawio` | GET/HEAD | 静态文件服务，映射到包内 `vendor/drawio/` |
| 2 | `exact` `/drawio/save` | POST JSON | 校验 → 写工作区文件 → `{ ok: true }` |
| 3 | `exact` `/drawio/file` | GET | 读工作区 `.drawio` 原文 → `{ path, xml }` |

> webServer 路由 path 不带尾斜杠；prefix 匹配是 longest-prefix-wins，命名路由优先于 SPA fallback，
> `/drawio` 与现有组合无冲突。

**路由 1：静态服务**（照 `frontend-static` 的 `serveStatic`）：

- 非 GET/HEAD → 405。
- `rel = decodeURIComponent(pathname.slice('/drawio'.length))`；
  `target = resolve(normalize(join(vendorRoot, rel)))`；
  `target !== vendorRoot && !target.startsWith(vendorRoot + sep)` → **403**（注意用 `sep` 不用 `'/'`，
  Windows 反斜杠）。
- `readFile` 失败且 code ∈ {ENOENT, EISDIR, ENOTDIR} → 404；其他错误上抛（webserver 兜底 400）。
- MIME 表（在 frontend-static 基础上扩充）：

```js
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.json': 'application/json',
  '.map':  'application/json',
  '.png':  'image/png', '.gif': 'image/gif', '.jpg': 'image/jpeg',
  '.ico':  'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml':  'application/xml', '.woff2': 'font/woff2', '.gz': 'application/gzip',
  '.webmanifest': 'application/manifest+json',
}
// 查不到 → application/octet-stream
```

- 缓存：静态资源 `cache-control: public, max-age=3600`（vendor 版本 pin，升级即换 URL 内容）；
  `.html` 用 `no-cache`。

**路由 2：保存**（照 open-in-app 的 POST 样板）：

- method ≠ POST → 405；content-type essence ≠ `application/json` → 415；
  body 上限 **8 MiB**（drawio XML 可能较大；超限排空后 413）。
- body 必须是 `{ sessionId: string, path: string, xml: string }` → 否则 400；
  `path` 必须以 `.drawio` 结尾（防止借写盘覆盖工作区任意文件）。
- 工作区根解析（见下）→ `resolveWithin(root, path)`，越界 → 400。
- `ctx.fs` 写盘后 `{ ok: true }`；fs 错误映射：越界/权限 → 403，其余 → 500。

**路由 3：读文件**：query `sessionId`、`path` 同上校验；不存在 → 404；成功 `{ path, xml }`。

**工作区根解析**：客户端上报 `sessionId`，Host 经
`ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })` 观察目标会话
（live 优先；历史会话冷读恢复、不进 store），取 `header.cwd` 作根；观察失败或
cwd 缺失/非绝对路径 → 400（`code: 'no-workspace'`）。根永远来自服务端会话事实，
不信任任何客户端上报的路径；这同时修复了历史会话（不在 `ctx.sessions` 活清单里）
卡片读盘被拒的问题。

### 3.4 SKILL 挂载（照 openviking `skills.mjs`）

```js
const SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url))

function mountDrawioSkills(ctx) {
  return ctx.plugin(skillFilesystem, {
    providerName: 'drawio',          // 不得与 dsh 自带 'filesystem' 冲突
    includeDefaultRoots: false,      // 只读本包目录,不重复项目/用户技能根
    bundledSkillDir: SKILLS_DIR,
    watch: false,                    // 打包技能只随升级变化;Windows 上 watcher 会锁文件
  })
}
```

`skills/drawio-diagram/SKILL.md` 内容直接采用 spec §8 全文，无需改写。

---

## 4. Client 半设计（`client/`）

### 4.1 构建契约（本插件最大的工程风险点，PoC P0-2）

宿主浏览器模块表是 **lazy CJS 工厂模型**：插件 bundle 执行时只做
`window.__ModuleLoader__.load({ id, factory })` 注册；模块体副作用在首次 require 时才运行。
第一方由共享预设 `clientBundle()`（`packages/client/tsdown.client.ts`）保证产物形态，第三方必须用
自己的 tsdown 配置复刻以下要点：

| 契约 | 取值 |
| --- | --- |
| format / platform | `'cjs'` / `'browser'` |
| entry / outDir / 文件名 | `{ client: 'src/client/index.ts' }` / `client/lib` / 固定 `client.js` |
| banner | `window.__ModuleLoader__.load({ id: "<包名>", factory: (require) => {` |
| intro | `var module = { exports: {} }; var exports = module.exports;` |
| footer | `return module.exports; } });` |
| externals（保持 require） | 仅宿主模块表能应答的说明符，见下 |
| define | `process.env.NODE_ENV`、`import.meta.env.MODE`、`import.meta.env` |
| sourcemap | 建议开（宿主经 `/plugins/<pkg>/client.js.map` 服务） |

**值导入白名单**（宿主种子表 `PLATFORM_MODULES` 应答，打包保持 require）：

```
react, react/jsx-runtime, react-dom, react-dom/client,
@deepseek-ai/cordis,
@deepseek-ai/dsh-client-store,
@deepseek-ai/dsh-client-ui-slots,
@deepseek-ai/dsh-client-ui-primitives,
@deepseek-ai/dsh-client-ui-dockkit
```

**跨插件值导入禁止**：其余 `@deepseek-ai/*` 客户端包一律 `import type`（类型在打包时擦除，
不进 bundle），运行时协作全部走 cordis 服务（`ctx.slots` / `ctx.locale` / `ctx.resources`）。
其他第三方库默认 inline；本插件目标**零运行时三方依赖**（样式用少量 inline style /
构建期读 CSS 文本注入 `<style>`，避开 css-modules 管线）。

`id` 必须是包名 `'@you/dsh-drawio-plugin'`——graph 行 id == 包名，写错则工厂注册到错误行。

### 4.2 入口 `src/index.ts`

```ts
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'   // ctx.slots 类型合并
import type {} from '@deepseek-ai/dsh-client-locale/client'        // ctx.locale
import type {} from '@deepseek-ai/dsh-client-resources/client'     // ctx.resources(以实际包出口为准)
import type { Context } from '@deepseek-ai/cordis'
import { DrawioCard } from './card.tsx'
import { registerDrawioFileResource } from './resource.ts'
import { en, NS, zh } from './locales.ts'

export const inject = ['slots', 'locale', 'resources', 'uiConversation']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'drawio: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'drawio_render', locale: NS },
    DrawioCard,
  ))
  // turn 数据累积器:drawio/rendered 事件 → turn.data['drawio'](§4.6)
  ctx.uiConversation.events.register(drawioDefinition)
  // 正式回复主流的卡片(list 槽位用 id;turn-tail 永不折叠,§4.6)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
    { name: 'conversation.chat.turnTail', id: '@you/dsh-drawio-plugin', locale: NS },
    DrawioTail,
  ))
  registerDrawioFileResource(ctx)   // §4.5,内部 ctx.effect
}
```

> 卡片要进正式回复主流,主路线是上面的 `conversation.chat.turnTail`
> (list,scope=session),toolview 注册保留,仅作折叠区内的工具行。
> 为什么必须这样、数据怎么来,见 §4.6;理由与代价见 §11 踩坑 1、3。

### 4.3 DrawioCard 组件

**props**：`ToolCallViewProps & PropsLocale<'drawio'>`（`@deepseek-ai/dsh-client-ui-tool/client`
类型座位 + slot 注入的 `t`）。`block` 两种形态：

- 流式（无 `kind`）：`block.argsRaw`（可能是截断 JSON 前缀）→ 渲染"生成中"行；
- 已结算：`block.call.argsRaw` / `block.content` / `block.isError` / `block.error` →
  状态 `ok | error | stopped(error.code==='interrupted')`（照 SkillRow 的派生模式）。

**视图模型**：从 `argsRaw` `JSON.parse` 取 `{ title, xml, path }`；解析失败回退显示 `block.callId`。
`error` 状态渲染错误摘要行（可展开看 `content` 文本），不渲染缩略图。

**布局**：

```
┌──────────────────────────────────────────────┐
│ [icon] <title>  ·  <path>            [编辑]  │
│ ┌──────────────────────────────────────────┐ │
│ │            SVG 缩略图 (img)              │ │
│ └──────────────────────────────────────────┘ │
└──────────────────────────────────────────────┘
```

**缩略图（`thumbnail.tsx`）**：

1. 数据源：`useResource<'drawio-file'>(addressFor(sessionId, path))`
   （`{ xml, rev }` 值，见 §4.5）。`sessionId` 来自卡片 props 的会话标准槽，
   地址按 sessionId 寻址（host 观察会话解析工作区根），不用客户端上报 cwd。
2. `value.xml` 变化 → 懒挂载隐藏 `<iframe src="/drawio/index.html?embed=1&proto=json">`，
   `EmbedSession`（§4.4）执行 `load(xml) → export('svg')` → 得 svg →
   `<img src="data:image/svg+xml;base64,...">`；iframe 复用到组件卸载。
3. 加载中显示占位，失败显示重试按钮。

**编辑覆盖层（`editor-overlay.tsx`）**：

1. 点"编辑"→ `createPortal` 一个 `position:fixed;inset:0;z-index` 顶层覆盖层，
   内嵌 `<iframe src="/drawio/index.html?embed=1&proto=json&ui=min">`，自带"关闭"按钮栏。
2. iframe `init` 后 `load(当前 xml)`（当前值取资源最新帧，而非 argsRaw 的旧值）。
3. **关闭流程**：先发 `export('xml')` 取最新 xml → `saveAndPublish(sessionId, path, xml)`
   （POST `/drawio/save` → 成功后向资源队列推帧，§4.5）→ 销毁覆盖层。
4. 编辑器内 Ctrl+S 产生 `{event:'save'}`：执行同样的 export+save+推帧，但**不关闭**编辑器；
   `{event:'exit'}`：视同关闭（若未保存先走第 3 步）。
5. 覆盖层打开时禁掉背景滚动；Esc 等同关闭。

### 4.4 EmbedSession — embed 协议封装（`embed.ts`）

drawio 在 `embed=1 & proto=json` 下由 `EditorUi.js` 实现 JSON postMessage 协议（已核实）：

| 方向 | 报文 | 说明 |
| --- | --- | --- |
| iframe→parent | `{event:'init'}` | 就绪握手，之后才能发 load |
| parent→iframe | `{action:'load', xml, autosave?}` | 载入文档 |
| parent→iframe | `{action:'export', format}` | 请求导出；`format: 'xml' \| 'svg' \| 'xmlsvg' \| 'png' \| 'xmlpng'` |
| iframe→parent | `{event:'export', ...}` | 导出回包（`svg`/`xml`/`data` 字段随 format 而定，实测为准） |
| iframe→parent | `{event:'save'}` | 编辑器内触发保存（Ctrl+S 等） |
| iframe→parent | `{event:'exit'}` | 编辑器要求关闭 |

封装要点：

- `postMessage(msg, location.origin)`；监听侧双校验：`e.origin === location.origin` 且
  `e.source === iframe.contentWindow`，再 `JSON.parse`。
- export 请求/响应配对：单 pending 串行队列，30s 超时 reject。
- `create(container, url)` 返回 Promise，等 `init` 或加载错误后 settle。
- `destroy()` 移除监听并卸载 iframe；所有会话在卡片/覆盖层卸载时销毁。

### 4.5 `drawio-file` 资源协议（卡片自动刷新）

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap { 'drawio-file': DrawioFileValue }
}
interface DrawioFileValue { xml: string; rev: number }
```

- 地址：`dsh-resource://drawio-file/<encodeURIComponent(sessionId)>/<逐段编码的相对路径>`；
  host 侧经 `ctx.sessionQuery.observeSession(sessionId, …)` 观察目标会话，取
  `header.cwd` 作工作区根，不信任任何客户端上报路径（历史会话冷读恢复，可读）。
- provider（`ctx.resources.register`，包在 `ctx.effect` 内）：

```ts
async *open(address, { signal }) {
  const { sessionId, path } = parseAddress(address)
  const file = await fetchJson(`/drawio/file?sessionId=${encodeURIComponent(sessionId)}&path=${encodeURIComponent(path)}`, { signal })
  yield { ok: true, value: { xml: file.xml, rev: ++channel.rev } }  // 首帧:文件当前内容
  for await (const frame of frames(channel, signal)) yield frame     // 后续:保存回调推帧
}
```

- **推帧路径**：插件闭包内维护 `Map<address, 队列>`；`saveAndPublish(sessionId, path, xml)` =
  `POST /drawio/save` → 200 后 `queue.push({ xml, rev: prev + 1 })`。
  （`ctx.resources.source(address)` 是只读裸 observable，供 React 外读取；推帧走 provider 私有队列。）
- 同一文件多张卡片共享一条流（registry 的 holder 计数）；最后一名持有者离开时流被 abort，
  队列随之清空——保存回调对无持有者的地址直接丢弃。
- 首帧 fetch 失败：yield `{ ok:false, error }` 帧（资源转 `failed`，卡片显示重试），不 throw。

### 4.6 turn 尾部主流卡片（`turn-drawio.ts` + `tail.tsx`）

**问题**：§4.3 的 toolview 卡片随 tool-call 节点一起被 turn-process 折叠。

**方案**（照 ui-deliverables 的 produced 推导，零新增会话事件）：

1. **Client 从已有事件推导**（`turn-drawio.ts`）：`ConversationNodeDefinition`（kind
   `'drawio'`，无 target、不产出视图节点）——`turn/start` 起 context；`tool/call`
   记下 `name === 'drawio_render'` 的 callId；`tool/result`（限 `surfaceOp === 'append'`，
   replacement 影子不重复计数）成功且 callId 命中、meta 形状校验通过 → 落一条
   `{ seq, callId, filePath, title }`。meta 即 host 工具的 `output.presentationMeta`
   （`{ filePath, title }`），随 tool/result 持久化、回放原样返回。`buildLocationData`
   发布 `turn.data['drawio']`（空数组不发布）。`declare module` 合并
   `ConversationTurnDataMap`。
2. **turnTail 槽位渲染**（`tail.tsx`）：`conversation.chat.turnTail`（list/session，
   owner=`{ turn, seq, openFile }`）注册 `DrawioTail`。`selectRenderedDiagrams(owner)`
   读 `owner.turn.data.get('drawio')` 并按 `seq <= owner.seq` 过滤；无图返回 null。
   每张图一个 `TailDiagramCard` 子组件（hooks 每卡一份）：
   `useResource<'drawio-file'>(addressFor(props.sessionId, ...))` + 复用
   `Thumbnail`/`EditorOverlay`。

**通道选择**：本方案全部复用已有 `tool/call` + `tool/result.meta`，不新增任何自定义
会话事件（为什么这条路是唯一合规通道，见 §11 踩坑 3；污染会话的修复见 §11 踩坑 9）。

### 4.7 本地化（NS = `'drawio'`）

| key | zh | en |
| --- | --- | --- |
| `card.title` | 图表 | Diagram |
| `card.edit` | 编辑 | Edit |
| `card.close` | 关闭 | Close |
| `card.saving` | 保存中… | Saving… |
| `card.failed` | 渲染失败 | Render failed |
| `card.retry` | 重试 | Retry |
| `card.generating` | 正在生成图表… | Generating diagram… |

类型合并照 ui-skill 先例：`declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { drawio: DrawioKey } }`。

---

## 5. drawio vendor 化

- **来源**：`jgraph/drawio` GitHub release 的 webapp 产物（war/zip，以下载页实际 asset 为准），
  `scripts/fetch-drawio.mjs` 下载 → 解包 → 抽取 `index.html`、`js/`、`styles/`、`stencils/`、
  `mxgraph/`、`shapes/`、`images/`、`plugins/`、`resources/` 等到 `vendor/drawio/`，
  写入 `VERSION`、拷入 Apache-2.0 `LICENSE`。版本 pin 死（参考源码树当前为 31.4.5）。
- **不 clone 整个 git 仓库**；不改 drawio 任何文件。
- **入口**：webapp 没有 `viewer.html`/`dev.html`；编辑器与缩略图统一 `index.html` + URL 参数
  （`dev=1` 只是调试用参数）。已核实 `index.html` 与 `js/bootstrap.js` 全部为**相对路径**引用，
  预期可在 `/drawio/` 子路径下工作（PoC P0-1 实测，重点看 service-worker 注册与少量绝对路径回退）。
- **外部服务**：drawio 默认回退到 viewer.diagrams.net 等在线端点（PROXY_URL 等）。离线环境这些
  请求失败不影响核心编辑/导出；如需纯离线，可在静态服务层对 `index.html` 响应做一次文本注入，
  预设 `window.*_URL` 指向本站或置空（属增强项，不入首版）。

---

## 6. 安全设计汇总

| 层 | 措施 |
| --- | --- |
| 传输/认证 | 三条路由全部先过 `connection.requestRejection`（Host/Origin 栅栏防 DNS rebinding + 登录 cookie） |
| 路径安全 | 静态服务与写读文件都做 `resolve(normalize(join(root, rel)))` + `startsWith(root + sep)`；写读强制 `.drawio` 后缀；工具写盘经 `ctx.fs.resolve({cwd})` 由 fs 层拒越界 |
| 输入校验 | 工具入参由 `defineTool` schema 强制；save 路由限体 8 MiB、JSON essence、字段类型逐项校验 |
| postMessage | `e.origin` + `e.source` 双校验；targetOrigin 不发 `'*'`（drawio 回包是 `'*'`，故入站校验必须严格） |
| 同源 | iframe 与卡片同源（`/drawio` 前缀），无跨域 CSP 问题；drawio 自带 CSP meta 与宿主页面互不影响 |
| 卸载 | 全部注册（工具/路由/locale/slot/resource）包 `ctx.effect`，profile 切换无残留 |

---

## 7. 构建、打包与安装流程

```bash
npm run fetch-drawio        # 一次性(或升级时): vendor drawio
npm run build               # tsdown → client/lib/client.js(必须先于 pack)
npm test                    # node --test(见 §8)
npm pack                    # prepack 自动重跑 build; 检查 tar 内容含 client/lib
dsh plugin --profile web add <tarball 或 registry 包名>
dsh --profile web --dump-config   # 应看到 dsh-drawio 行
```

- 本地目录安装（`dsh plugin add ./dsh-drawio-plugin`）要求该目录自带 `node_modules`
  （Node 从源码树 realpath 解析 peer，照 openviking README 的注意事项）。
- profile 侧 pnpm 设置保持 `nodeLinker: hoisted` + `autoInstallPeers: false`（dsh 默认），
  缺失 peer 的警告不必然致命，以启动结果为准。

---

## 8. 测试策略

**Host（`node --test`，无浏览器）**：

- 静态服务：`..` / `%2e%2e` 穿越 → 403；不存在 → 404；MIME 与 cache-control；POST → 405。
- save 路由：未认证 mock → 401/403；非 JSON → 415；超限 → 413；非 `.drawio` → 400；
  越界 path → 400/403；正常写盘后 file 路由读回一致。
- 工具：mock `ctx.fs` / `exec.agent` —— 默认路径生成、title sanitize、非 agent 调用拒绝、
  signal 转发。
- skill 挂载：`buildSkillsConfig` 的形状（providerName/includeDefaultRoots/bundledSkillDir/watch）。

**Client（轻量单测）**：

- `embed.ts`：mock `iframe.contentWindow` / `window.addEventListener`，验证 init→load→export
  时序、origin/source 拒绝、超时。
- `resource.ts`：mock `ctx.resources` 与 `fetch`，验证首帧、推帧、失败帧。
- 组件层（可选）：`@testing-library/react` + react 18，渲染 DrawioCard 三种状态。

**端到端（验收清单驱动）**：见 §9 PoC 与 spec §9 验收清单逐项对应。

---

## 9. PoC 计划（开工顺序，风险从高到低）

| # | 风险 | 验证方法 | 通过标准 |
| --- | --- | --- | --- |
| P0-1 | drawio 子路径加载 | 本地静态服务器把 `vendor/drawio` 挂到 `/drawio/`，浏览器开 `/drawio/index.html?embed=1&proto=json` | 无子资源 404；编辑器就绪 |
| P0-2 | client bundle 工厂形态 | ~~打包验证~~（已完成：banner/footer/`require` 白名单边界全部符合契约）→ 剩装入测试 profile 实测 | `__DSH_BOOT__.entries` 含本包；`/plugins/<pkg>/client.js` 200；日志执行 |
| P1-1 | embed 报文字段 | 在 P0-1 页面控制台跑 load/export('svg')/export('xml') | 拿到 svg/xml 回包，确定字段名（`svg`/`xml`/`data`） |
| P1-2 | ~~Host 侧 sessions 按 id 取 cwd~~（已消解：卡片 props 直接带 `ToolCallOwnerProps.cwd`，Host 交叉校验活会话） | — | 已实现 |
| P2-1 | service-worker 子路径 | P0-1 时观察控制台 | 失败仅影响离线缓存，功能不阻 |

---

## 10. 验收清单映射（spec §9）

| spec 验收 | 实现/测试对应 |
| --- | --- |
| 1. 装得上、dump-config 可见、`__DSH_BOOT__` 有条目 | §7 流程 + PoC P0-2 |
| 2. 对话"画个用户登录时序图"→ 工作区出现 `.drawio` | §3.2 工具 + §3.4 SKILL + host 单测 |
| 3. 对话流出现 SVG 缩略图卡片 | §4.3/§4.4/§4.5 + PoC P1-1 |
| 4. 编辑→保存→缩略图自动更新 | §4.3 覆盖层 + §4.5 推帧 |
| 5. 全程未改 dsh 源码 | 仅 bundle patch（§1.2） |

---

## 11. 踩坑记录（全部已验证）

1. **只挂 `tool.call.toolview`，卡片会被折叠出主流**。turn 结束后，ChatView 的
   turn-process 把工具调用节点折进"N 次工具调用"披露行（`TURN_PROCESS_INDEPENDENT_KINDS`
   只豁免 system-prompt/user/steering/turn-process/turn-error/turn-max-tokens/
   turn-tail）。卡片要进正式回复主流，必须注册到 `conversation.chat.turnTail`
   （list，scope=session）；toolview 保留，仅作折叠区内工具行。
2. **槽名类型找不到 = 类型包没进编译单元**。`ctx.slots.register` 的槽名联合类型靠
   declaration merging 拼成：未引入声明该槽的包时，`conversation.chat.turnTail` 根本不在
   类型里。修法：`import type {} from '@deepseek-ai/dsh-client-ui-chat/client'`
   （另需 ui-conversation），且该包必须在 devDependencies、版本与运行时对齐。
3. **第三方插件不能写自定义会话事件**。回放校验要求事件类型在构建期生成的
   `KNOWN_SESSION_EVENT_TYPES` 内（或 envelope 带 `ignorable: true`），而
   `Session.append` 不暴露 `ignorable`——写自定义事件 = 会话变成"无插件不可读"。
   合规通道：Host 工具 `output.presentationMeta`（§3.2）随 `tool/result` 持久化，
   客户端用 `ConversationNodeDefinition` 从 `tool/call` + `tool/result` 推导（§4.6）。
4. **`tool/result` 必须限 `surfaceOp === 'append'`**。replacement 影子事件会重复计数；
   且不能跨插件 import 第一方 `isAppendSurfaceEvent`（purity 规则禁止跨插件值导入），
   直接内联判断 `event.surfaceOp === 'append'`。
5. **双面包只挂一行 patch**。`cordis.patch.yml` 不要插第二行 `name: '<pkg>/client'`——
   vendored loader 对 `/client` 后缀无特判，会把浏览器 bundle 当 Node 插件 import
   （inject 失败或 `window` 未定义）。
6. **按 cwd 寻址历史会话会被 host 拒绝**。卡片读文件改按 sessionId 寻址：客户端上报
   sessionId，host 经 `ctx.sessionQuery.observeSession(sessionId)` 取 header.cwd 作
   工作区根，服务端永远不信客户端上报的路径。
7. **改完 client 源码必须重新 build**。宿主跑的是 `client/lib/client.js` 产物（tsdown），
   `npm pack` 前必须已构建；只改源码不重建，浏览器加载的还是旧卡片。
8. **`buildLocationData` 要做记忆化**。previous 等值（turn/key/rendered 引用都没变）
   时返回 previous，否则同一回合每次 surface 更新都重复发布 turn 数据。
9. **npm 版本对齐**。0.1.5-rc.2 的 ui-chat 类型里 `conversation.chat.turnTail` 还是
   `chain`，0.1.6-alpha.1 起才是 `list`；devDependencies 的 client 包版本必须与运行时一致。
10. **污染会话修复**：若早期曾向会话写过自定义事件，用
    `scripts/repair-session-log.mjs` 给旧行补 `ignorable: true`（不删行、不动 seq）。
    该脚本本仓库尚未实现，遇到再补。

---

## 附录 A：关键源码证据索引

| 设计点 | 证据（dsh 仓库相对路径 / 其他） |
| --- | --- |
| bundle patch、插件契约、peer 范围 | OpenViking `examples/dsh-memory-plugin/{package.json,cordis.patch.yml,index.mjs}` |
| `dsh plugin add` 转发 pnpm 到 profile | `apps/cli/src/plugin.ts`；`docs/architecture.md` |
| `webServer.register` / `requestRejection` | `packages/host/webserver/src/index.ts`、`packages/host/open-in-app/src/index.ts` |
| 静态服务与穿越拒绝 | `packages/host/frontend-static/src/index.ts` (`serveStatic`) |
| `defineTool` / 工具契约 | `docs/subsystems/tools.md`、`packages/todo/tool-todo/src/index.ts` |
| 会话工作区写盘 | `packages/fs/tool-fs/src/session-cwd.ts`、`packages/fs/fs/src/types.ts` |
| 双面包与 client 自动发现 | `packages/client/modules/src/index.ts`、`packages/client/ui-open-in-app/src/index.ts` |
| toolview slot / locale | `packages/client/ui-skill/src/client/index.ts`、`SkillRow.tsx`（`ToolCallViewProps`） |
| 资源协议 | `packages/client/resources/README.md` |
| client bundle 工厂契约 / external 白名单 | `packages/client/tsdown.client.ts`、`packages/client/web/src/platform.ts` |
| skill provider 挂载 | OpenViking `skills.mjs`（`ctx.plugin(skillFilesystem, …)`） |
| embed 协议（init/load/export/save/exit） | drawio `src/main/webapp/js/diagramly/EditorUi.js`（L23752、L24114、L24343、L24499、L25247、L22960） |
| drawio 入口与相对路径 | drawio `src/main/webapp/index.html`、`js/bootstrap.js`（无 viewer.html/dev.html） |
