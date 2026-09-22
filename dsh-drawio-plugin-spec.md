# dsh drawio 插件开发说明书 (交给 IDE 的实现提示词)

> 目标：在
>
> **不修改 deepseek-harness (dsh) 任何源码**
>
> 的前提下，开发一个可通过
> `dsh plugin --profile web add <包>`
>
>  安装的第三方插件，让对话中能画 drawio 图:
> 生成 
>
> `.drawio`
>
>  文件、对话内联 SVG 缩略图、全屏 drawio iframe 编辑、关闭自动保存、卡片自动刷新。
> 插件自带 drawio Web 静态资源，用户机器零安装。



***

## 1. 硬约束



* 不改 `deepseek-harness` 仓库任何文件。所有能力来自 dsh 已有的扩展点。

* 插件是一个独立 npm 包，通过 **bundle patch** 被 profile 挂载 (参考 OpenViking 的 `examples/dsh-memory-plugin`)。

* 只在 **web profile** 下生效 (客户端 UI 只在浏览器 composition 里存在)。

* ESM;Node `^22.19 || >=24`。

* drawio 静态资源使用官方 release 的 `webapp` 产物 (Apache-2.0, 随包附 LICENSE), 不改其源码。

## 2. 总体架构：一个 bundle, 一个双面包



```
your-plugin/                      # npm 包 @you/dsh-drawio-plugin

├─ package.json                   # 声明 dsh.bundle.patch + files + peerDeps

├─ cordis.patch.yml               # 只挂一行:双面包行 (Client 半由 client-modules 自动携带)

├─ host.mjs                       # Host 半:工具 + webServer 路由(纯 JS)

├─ client/                       # Client 半:React 插件,必须构建产物

│   ├─ src/index.ts

│   └─ ... (tsdown → lib/client.js)

├─ vendor/drawio/                 # drawio webapp 静态资源(只此一部分)

├─ skills/drawio-diagram/SKILL.md # 教模型 drawio XML 写法

└─ README.md
```

三层职责:



| 层                   | 干什么                                            |
| ------------------- | ---------------------------------------------- |
| Host 半 (`host.mjs`) | ① 注册工具 `drawio_render`;② 注册 HTTP 路由吐静态资源和写文件   |
| Client 半 (构建包)      | 注册 `tool.call.toolview` 卡片、全屏编辑器 iframe、资源自动刷新 |
| drawio webapp       | 缩略图导出 + 完整编辑器，全部浏览器内运行                         |

## 3. 参考：在 dsh 源码里照着抄的样板

实现前先读这几个文件，所有 API 形状以它们为准:



| 样板                                                                                             | 学什么                                                                                                 |
| ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `OpenViking-0.4.21/examples/dsh-memory-plugin/package.json` + `cordis.patch.yml` + `index.mjs` | bundle 声明、patch 挂载行、`name/inject/apply` 插件契约                                                        |
| `packages/host/open-in-app/src/index.ts`                                                       | `ctx.webServer.register({kind:'exact'/'prefix', path, handler})` 注册 HTTP 路由、`requestRejection` 安全检查 |
| `packages/client/ui-open-in-app/src/client/controller.ts`                                      | 客户端 `fetch` 调 host 路由的写法                                                                            |
| `packages/client/ui-deliverables/package.json`                                                 | 客户端包 `dsh.client` 声明 + `exports["./client"]` 形态                                                     |
| `packages/client/ui-skill/src/client/index.ts`                                                 | `ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({name, key}, 组件))`                 |
| `packages/client/resources/README.md`                                                          | 资源流协议 provider 的完整 API                                                                              |
| `packages/client/ui-open-in-app/src/index.ts` + `packages/client/modules/src/index.ts`         | 双面包惯例:行名=包名,Node 半可为空 `apply()`;client-modules 扫 Loader 条目,凭 `dsh.client` 声明自动把 `./client` 注入 `__DSH_BOOT__` |

## 4. Host 半规格

### 4.1 插件入口



```
export const name = 'dsh-drawio-plugin'

export const inject = \['tools', 'webServer', 'connection', 'fs']

export function apply(ctx, input = {}) {

&#x20; // 注册工具 + 注册路由,全部包在 ctx.effect() 里,保证可卸载

}
```

### 4.2 工具 `drawio_render`



* wire 工具名固定为 `drawio_render`(Client 卡片按这个 key 分发)。

* **工具描述写给模型看**, 必须包含：当用户要求绘制架构图、时序图、流程图、思维导图、甘特图、示意图等图形时调用本工具；入参含 `title`、`xml`(完整 .drawio/mxfile XML, 即第 8 节 SKILL.md 教模型产出的那段)、可选 `path`(工作区内相对路径，默认 `diagrams/<title>.drawio`)。

* execute 行为:

1. 把 `xml` 写入工作区 `path`(照 `packages/fs/tool-fs/src/session-cwd.ts`:`ctx.fs.resolve(path, { cwd: exec.agent?.session.header.cwd, signal: exec.signal })` 解析后再写；路径越出工作区由 fs 层拒绝)。

2. 工具结果 (会持久化到会话日志、喂给卡片) 返回:`{ filePath, xml }`。

3. **不在 Host 侧做 SVG 导出**—— 导出在浏览器 viewer iframe 里做 (零外部依赖)。

### 4.3 HTTP 路由 (`ctx.webServer.register`)

照 `packages/host/open-in-app/src/index.ts` 的形状:



| 路由             | kind              | 行为                                                                                                                                       |
| -------------- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `/drawio`      | `prefix`          | 文件服务器：把 `/drawio/<相对路径>` 映射到 `vendor/drawio/` 下对应文件；**必须做路径归一化，拒绝&#x20;**`..`**&#x20;越出目录**; 按扩展名设 `content-type`; 静态资源带 `cache-control` (webServer 路由 path 不带尾斜杠) |
| `/drawio/save` | `exact`,POST,JSON | body `{ sessionId, path, xml }`: `ctx.sessionQuery.observeSession(sessionId)` 解析 `header.cwd` 作工作区根 (live 优先,历史会话冷读恢复;不信任客户端上报路径) + path 词法校验 → 写文件 → `{ ok, path }` |
| `/drawio/file` | `exact`,GET       | 按 query `sessionId`+`path` 读 `.drawio` 原文 (供编辑器加载)                                                                                                   |

所有 handler 开头照样板调用 `connectionOf(ctx).requestRejection(req)` 做未授权拒绝。

## 5. Client 半规格 (必须构建)

### 5.1 package.json 声明



```
{

&#x20; "dsh": {

&#x20;   "client": {

&#x20;     "platform": "web",

&#x20;     "inject": \[

&#x20;       "@deepseek-ai/dsh-client-ui-renderer",

&#x20;       "@deepseek-ai/dsh-client-resources",

&#x20;       "@deepseek-ai/dsh-client-locale"

&#x20;     ]

&#x20;   }

&#x20; },

&#x20; "exports": { "./client": "./lib/client.js" }

}
```



* 本包是**双面包**:`exports["."]` / `main` 指 `host.mjs` (Node 半,必须 Node 安全),`exports["./client"]` 指构建产物;`cordis.patch.yml` 只挂包名一行,Client 半由 client-modules 凭 `dsh.client` 声明自动发现并注入 `__DSH_BOOT__` (机制见 `packages/client/modules/src/index.ts`)。

* `dsh.client.inject` 按第一方惯例**列依赖的包名** (照 `ui-deliverables/package.json`,上面三个分别提供 slots/resources/locale),不要留空;代码里的 `export const inject` 列的是 ctx 服务名,两者别混。

* 用 tsdown 等打包成 `lib/client.js`; 浏览器侧 baseline (React、Cordis) 是宿主冻结的，**不要重复打包**, 需要的三方库走 `dsh.client.external`。

* 浏览器标题、宿主路由等都不通过 slot, 别发明新的宿主扩展点。

### 5.2 注册对话卡片



```
ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(

&#x20; { name: 'tool.call.toolview', key: 'drawio\_render', locale: NS },

&#x20; DrawioCard))
```

### 5.3 DrawioCard 组件行为

props 里能拿到工具结果 (`filePath`、`xml`)。组件自身渲染:



1. **缩略图**: 挂一个隐藏的 `<iframe src="/drawio/index.html?embed=1&proto=json">` (drawio 没有 viewer.html 入口;隐藏 iframe 只跑协议,不需要可见 UI), 等 `{event:'init'}` 后 postMessage `{action:'load', xml}`, 再发 `{action:'export', format:'svg'}`; 监听其回传的 `{event:'export', svg}` 后，把 SVG 设为 `<img src="data:image/svg+xml;base64,...">`。(报文字段以 drawio 官方 embed 文档为准;已在 `js/diagramly/EditorUi.js` 核实 init/load/export/exit 与 xml/svg 导出确实存在。)

2. **"编辑" 按钮**在卡片右上角；点击后渲染一个 `position:fixed;inset:0` 的全屏覆盖层 (React portal, 不需要任何新 slot), 里面是 `<iframe src="/drawio/index.html?embed=1&proto=json&ui=min">` (drawio 没有 dev.html;`dev=1` 只是调试用 URL 参数,正式嵌入不需要)。

3. 编辑器 iframe 加载 `/drawio/file?cwd=...&path=...` 拿到当前 xml,postMessage `{action:'load', xml}`。

4. **关闭编辑器**: 点关闭 / 卸载覆盖层前，向编辑器发 `{action:'export', format:'xml'}` 取最新 xml → `fetch('/drawio/save', {method:'POST', body: JSON.stringify({cwd, path, xml})})` → 保存成功后触发资源刷新 (见 5.4)。

5. **postMessage 安全**: 监听时校验 `event.origin` 只认自己 host; 编辑器和 viewer 同源 (都走 `/drawio/` 前缀), 天然无 CSP 问题。

### 5.4 资源协议实现自动刷新 (需求：卡片刷新)

照 `packages/client/resources/README.md`:



```
ctx.resources.register<'drawio-file'>({

&#x20; protocol: 'drawio-file',

&#x20; async \*open(address, { signal }) {

&#x20;   yield 当前 svg            // 先给当前内容

&#x20;   for await (const change of watcher) yield change  // 后续每次变更一帧

&#x20; },

})
```

卡片 `useResource('dsh-resource://drawio-file/' + filePath)`: 保存路由返回新内容后，推一帧新数据，缩略图自动重渲。`ctx.resources.source(address)` 是 React 外的裸 observable, 供保存回调直接推帧。

### 5.5 本地化

`ctx.locale.register(NS, { zh, en })`, 按钮文案走字典，不写死中文。

## 6. bundle 打包形态

### 6.1 `cordis.patch.yml`



```
\- insert:

&#x20;   - id: dsh-drawio

&#x20;     name: '@you/dsh-drawio-plugin'   # 双面包:包根导出 host.mjs (Host 半);

&#x20;                                     # Client 半由 client-modules 凭 dsh.client 声明自动携带
```

**只挂这一行。** 不要再插 `name: '@you/dsh-drawio-plugin/client'` 第二行:vendored loader 对 `/client` 后缀没有特判,会在 Node 里 import 浏览器 bundle (inject 失败或 `window` 未定义)。第一方双面包 (如 `ui-open-in-app`) 就是"行名=包名",Node 半再空也导出一个 `apply(){}`。

### 6.2 `package.json`



* `dsh.bundle.patch: "./cordis.patch.yml"`(照 openviking 例子)。

* `files` 只放:`host.mjs`、`client/lib/`、`cordis.patch.yml`、`vendor/drawio/`、`skills/`、`README.md`、`LICENSE`。

* `peerDependencies` 对齐 dsh 版本范围 (照 openviking 例子的写法，RC 范围要显式承认多个 pre-release 子系列)。

## 7. drawio 静态资源 vendor



* 来源：GitHub release `jgraph/drawio` 的 `drawio-vX.Y.Z.zip`,**只取 webapp 产物**(`index.html`、`js/` (含 `app.min.js`、`viewer-static.min.js`)、`styles/`、`stencils/`、`mxgraph/`、`shapes/`、`images/` 等), 放 `vendor/drawio/`。注意:webapp 里**没有** `viewer.html`/`dev.html` 这两个入口,编辑器与缩略图统一走 `index.html` + URL 参数。

* **不要 clone 整个 git 仓库**;pin 死版本。

* 随包附 drawio 的 Apache-2.0 LICENSE。

## 8. 随包 SKILL.md (可直接落盘)

把下面整份内容保存为 `skills/drawio-diagram/SKILL.md`, 无需改写。它就是模型写图的教材。



```
\---

name: drawio-diagram

description: 用 drawio(mxGraphModel XML)绘制架构图、时序图、流程图、思维导图、甘特图等图形。当用户要求"画/绘制/生成 XX 图、流程图、架构图、时序图、思维导图、甘特图、示意图"时使用。产出一段完整的 .drawio XML,交给 drawio\_render 工具写盘并渲染。

\---

\# drawio 图形绘制指南

你产出的每一张图,都是一段完整的 \`.drawio\` XML(根元素 \`mxfile\`)。结构固定,照模板套即可。

\## 最小骨架(必须照抄这两行根单元格)

\`\`\`xml

\<mxfile host="app.diagrams.net" type="device">

&#x20; \<diagram id="p1" name="Page-1">

&#x20;   \<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">

&#x20;     \<root>

&#x20;       \<mxCell id="0" />

&#x20;       \<mxCell id="1" parent="0" />

&#x20;       \<!-- 你的节点和边都写在这里,parent="1" -->

&#x20;     \</root>

&#x20;   \</mxGraphModel>

&#x20; \</diagram>

\</mxfile>

\`\`\`

\`id="0"\` 和 \`id="1"\` 这两行必须原样保留,它们是画布根。之后所有元素的 \`parent\` 都是 \`1\`。

\## 三种基本元素

\*\*节点(矩形框)\*\*:\`\<mxCell id="唯一id" value="显示文字" style="..." vertex="1" parent="1">\` + 子元素 \`\<mxGeometry x="100" y="100" width="120" height="60" as="geometry" />\`。

\*\*连线(边)\*\*:\`\<mxCell id="e1" value="边上的文字" style="html=1;endArrow=block;" edge="1" parent="1" source="起点id" target="终点id">\` + \`\<mxGeometry relative="1" as="geometry" />\`。

\*\*规则\*\*:

\- 所有 \`id\` 全局唯一;推荐用语义化名字(如 \`user\`、\`loginApi\`、\`e1\`),不要用 2、3、4 这种数字序列。

\- \`value\` 里直接写中文;要换行用 \`\&#10;\`。

\- 坐标:\`x\` 向右增、\`y\` 向下增。普通节点宽约 120、高约 60;同列的节点 \`x\` 对齐,行间纵向间距约 80。

\## 形状速查(style 字段照抄)

\| 用途 | style |

\|---|---|

\| 普通矩形 | \`rounded=0;whiteSpace=wrap;html=1;\` |

\| 圆角矩形(步骤/组件) | \`rounded=1;arcSize=10;whiteSpace=wrap;html=1;\` |

\| 椭圆/圆形(开始结束) | \`ellipse;whiteSpace=wrap;html=1;\` |

\| 菱形(判断/分支) | \`rhombus;whiteSpace=wrap;html=1;\` |

\| 分组/泳道(架构分层) | \`swimlane;html=1;startSize=30;\` |

\| 人物/参与者 | \`shape=actor;html=1;\` |

\| 数据库 | \`shape=cylinder3;whiteSpace=wrap;html=1;size=15;\` |

\| 文档 | \`shape=document;whiteSpace=wrap;html=1;boundedLbl=1;\` |

\| 便签/说明 | \`shape=note;whiteSpace=wrap;html=1;fillColor=#fff2cc;strokeColor=#d6b656;\` |

\*\*配色\*\*(追加到 style 末尾,与上面的分号隔开):

\| 语义 | fillColor / strokeColor |

\|---|---|

\| 蓝(普通组件) | \`#dae8fc\` / \`#6c8ebf\` |

\| 绿(成功/外部系统) | \`#d5e8d4\` / \`#82b366\` |

\| 黄(注意/人工) | \`#fff2cc\` / \`#d6b656\` |

\| 红(错误/风险) | \`#f8cecc\` / \`#b85450\` |

\| 紫(中间件/总线) | \`#e1d5e7\` / \`#9673a6\` |

例:\`rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;\`

\## 边(连线)速查

\| 用途 | style |

\|---|---|

\| 普通实线调用 | \`html=1;endArrow=block;edgeStyle=orthogonalEdgeStyle;\` |

\| 时序图消息(虚线箭头) | \`html=1;endArrow=block;dashed=1;\` |

\| 自循环/返回 | \`html=1;endArrow=open;dashed=1;\` |

\| 无箭头(依赖) | \`html=1;endArrow=none;\` |

\## 各类图的套路

\- \*\*架构图\*\*:用 \`swimlane\` 分"前端 / 网关 / 业务服务 / 数据层"几个泳道,组件放各自泳道里,实线边连依赖。

\- \*\*时序图\*\*:顶部一排参与者(actor 或圆角矩形),每个参与者下方一条垂直虚线表示生命线;参与者之间用带文字的\*\*水平虚线箭头\*\*表示消息,从上到下按时间排列,\`y\` 依次递增 60\~80。

\- \*\*流程图\*\*:椭圆当开始/结束,圆角矩形当步骤,菱形当判断,正交实线边连接;分支边在 \`value\` 上标"是/否"。

\- \*\*思维导图\*\*:中心一个椭圆,第一层用彩色圆角矩形围绕四周,普通矩形作第二层;边用无箭头实线。

\- \*\*甘特图\*\*:每行一个 \`swimlane\`(任务名),任务条用一个窄圆角矩形横向摆放,\`x\` 表示开始时间偏移、\`width\` 表示工期;顶部另画一条时间刻度线。

\## 完整示例:用户登录时序图

\`\`\`xml

\<mxfile host="app.diagrams.net" type="device">

&#x20; \<diagram id="login" name="Login">

&#x20;   \<mxGraphModel dx="800" dy="600" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">

&#x20;     \<root>

&#x20;       \<mxCell id="0" />

&#x20;       \<mxCell id="1" parent="0" />

&#x20;       \<mxCell id="user" value="用户" style="shape=actor;html=1;" vertex="1" parent="1">

&#x20;         \<mxGeometry x="80" y="40" width="40" height="80" as="geometry" />

&#x20;       \</mxCell>

&#x20;       \<mxCell id="loginPage" value="登录页" style="rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#dae8fc;strokeColor=#6c8ebf;" vertex="1" parent="1">

&#x20;         \<mxGeometry x="320" y="40" width="120" height="60" as="geometry" />

&#x20;       \</mxCell>

&#x20;       \<mxCell id="auth" value="认证服务" style="rounded=1;arcSize=10;whiteSpace=wrap;html=1;fillColor=#d5e8d4;strokeColor=#82b366;" vertex="1" parent="1">

&#x20;         \<mxGeometry x="580" y="40" width="120" height="60" as="geometry" />

&#x20;       \</mxCell>

&#x20;       \<mxCell id="e1" value="提交账号密码" style="html=1;endArrow=block;dashed=1;" edge="1" parent="1" source="user" target="loginPage">

&#x20;         \<mxGeometry relative="1" as="geometry" />

&#x20;       \</mxCell>

&#x20;       \<mxCell id="e2" value="校验凭证" style="html=1;endArrow=block;dashed=1;" edge="1" parent="1" source="loginPage" target="auth">

&#x20;         \<mxGeometry relative="1" as="geometry" />

&#x20;       \</mxCell>

&#x20;     \</root>

&#x20;   \</mxGraphModel>

&#x20; \</diagram>

\</mxfile>

\`\`\`

\## 产出要求

1\. 只在用户明确要画图形时调用 \`drawio\_render\`;日常讨论不要为了画图而画图。

2\. 输出的 \`xml\` 必须是上面那种\*\*完整 mxfile 文档\*\*,能被 drawio 直接打开,不要只给片段。

3\. 先规划好节点数量和大致布局再写坐标,别让节点重叠。

4\. 节点文案简短(≤12 字),细节放边上或备注里。
```

## 9. 验收清单



1. `dsh plugin --profile web add @you/dsh-drawio-plugin` 装得上；`dsh --profile web --dump-config` 能看到 `dsh-drawio` 行;打开 web 端,`window.__DSH_BOOT__` 里出现本包条目。

2. 对话框说 "画个用户登录时序图" → 模型调用 `drawio_render` → 工作区出现 `.drawio` 文件。

3. 对话流里出现卡片，显示 SVG 缩略图。

4. 点 "编辑" → 全屏 drawio 编辑器打开该文件；改完关闭 → 文件被保存 → 缩略图自动更新。

5. 全程未改动 dsh 源码。

## 10. 已知 PoC 项 (开工先验证)



* **子路径服务**:`/drawio/` 前缀下 `index.html` 入口能否正常加载全部子资源 (drawio 历史上假定跑在根路径;已核实 `index.html` 与 `js/bootstrap.js` 全部为相对路径引用,预期可行,仍需实测 service-worker 注册等少数绝对路径点)。若子资源 404, 检查其绝对路径引用或调整挂载前缀。

* **postMessage 报文**: 以 drawio 官方 embed-mode 文档的 JSON schema 为准，本文件只给流程骨架。

* peer 版本范围与本机 dsh 版本对齐；客户端包必须先构建再 `npm pack`。