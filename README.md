# @you/dsh-drawio-plugin

DeepSeek Harness (dsh) 的 drawio 绘图插件：在对话中直接生成、预览、编辑 drawio 图。
**不修改 dsh 任何源码**，全部能力来自 dsh 已有扩展点（bundle patch + 双面包）。

## 功能

- 模型工具 `drawio_render`：把完整 mxfile XML 写入会话工作区（默认 `diagrams/<标题>.drawio`）
- 对话内联卡片：drawio 缩略图（SVG，浏览器内导出，零外部依赖）
- 全屏 drawio 编辑器（embed iframe，`ui=min`），关闭自动保存
- 卡片自动刷新：保存后经 `drawio-file` 资源协议推帧，缩略图即时更新
- 插件自带 drawio webapp 静态资源（v31.4.5，pin 版本），用户机器零安装
- 随包 `drawio-diagram` 技能，教模型写出合法的 drawio XML

## 环境要求

- `@deepseek-ai/dsh` `0.1.0-rc.6+` 或 `0.1.5-rc.x`（开发对齐 `0.1.5-rc.2`）
- Node.js `^22.19.0` 或 `>=24`
- 安装/卸载插件时需要 `pnpm`（`dsh plugin` 内部转发）

## 安装

```bash
npm pack                                            # 生成 tarball(prepack 自动构建 client 半)
npx @deepseek-ai/dsh plugin --profile web add ./you-dsh-drawio-plugin-0.1.0.tgz
npx @deepseek-ai/dsh --profile web --dump-config    # 应看到 dsh-drawio 行
npx @deepseek-ai/dsh --profile web                  # 启动 web 端
```

> 只在 **web profile** 生效（客户端 UI 只存在于浏览器 composition）。
> 本地目录安装（`dsh plugin add ./dsh-drawio-plugin`）要求该目录自带 `node_modules`。

## 使用

1. 对话里说「画个用户登录时序图」→ 模型经 `drawio-diagram` 技能学会写法，调用 `drawio_render` → 工作区出现 `.drawio` 文件
2. 对话流出现卡片，显示 SVG 缩略图
3. 点「编辑」→ 全屏 drawio 编辑器打开该文件；改完点「关闭」（或 Esc）→ 自动保存 → 缩略图自动更新
4. 编辑器内 Ctrl+S 也会保存（不关闭编辑器）

## 工作原理

双面包（一行 cordis patch 挂载）：

- **Host 半**（`host.mjs`，包根导出）：注册 `drawio_render` 工具（`defineTool`，经 `ctx.fs` 写工作区）；
  注册三条路由——`GET /drawio/*` 静态资源（prefix）、`POST /drawio/save`、`GET /drawio/file`，
  全部过 `connection.requestRejection` 认证栅栏，写读路径经词法校验 + 活会话工作区交叉校验；
  经独立 provider 挂载随包技能
- **Client 半**（`client/lib/client.js`，`exports["./client"]`，由 dsh-client-modules 凭
  `dsh.client` 声明自动注入 `__DSH_BOOT__`）：keyed toolview 卡片（`key: 'drawio_render'`）、
  embed postMessage 协议封装（origin/source 双校验）、`drawio-file` 资源 provider

drawio 以 embed 模式（`embed=1&proto=json`）运行在 `/drawio/` 前缀下，编辑器与缩略图统一走
`index.html`；SVG 导出全部在浏览器内完成。

## 开发

```bash
npm install            # 安装开发依赖(类型 + tsdown)
npm run build          # 构建 client 半 → client/lib/client.js(npm pack 前必须)
npm run fetch-drawio   # 更新 vendor drawio(版本见 vendor/drawio/VERSION)
npm test               # host 侧 node --test
npx tsc --noEmit       # 类型检查
```

目录：`host.mjs` Host 半入口 · `client/src/` 浏览器半源码 · `client/lib/` 构建产物 ·
`vendor/drawio/` drawio webapp · `skills/drawio-diagram/` 模型教材 · `scripts/fetch-drawio.mjs`

设计文档见 `dsh-drawio-plugin-design.md`；原始说明书见 `dsh-drawio-plugin-spec.md`。

## 许可

本插件代码：Apache-2.0（见 [LICENSE](LICENSE)）。
`vendor/drawio/` 为 jgraph/drawio 的 webapp 产物：Apache-2.0（见 [vendor/drawio/LICENSE](vendor/drawio/LICENSE)）。
