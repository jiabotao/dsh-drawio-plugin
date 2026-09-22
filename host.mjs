/**
 * @you/dsh-drawio-plugin — Host 半(双面包的 Node 侧)。
 *
 * 三件事:
 * ① 注册工具 `drawio_render`(defineTool,写工作区 .drawio 文件);
 * ② 注册三条 webServer 路由:`/drawio` 静态资源(prefix)、`/drawio/save`、
 *    `/drawio/file`(exact),全部过 connection 的 requestRejection 安全闸;
 * ③ 用独立 provider 挂载随包 SKILL.md(教模型写 drawio XML)。
 *
 * 安全模型:每条路由先过 `connection.requestRejection`(Host/Origin 栅栏 +
 * 登录 cookie)。工具写盘走第一方 sandbox-policy 链路(standing policy 或经
 * 审批的升级模式,盖章进 ctx.fs.writeText,与 tool-fs write 同构);浏览器路由
 * 属用户手势,走 node fs,词法防线为 sessionId → observeSession 解析的服务端
 * 会话工作区根(header.cwd;live 优先,历史会话冷读恢复)+ 相对路径越界校验 +
 * .drawio 后缀限制。所有注册包在 ctx.effect() 里,profile 卸载/热更新时全量回收。
 *
 * API 形状出处(不改 dsh 源码,全部照抄第一方):
 * - packages/host/open-in-app/src/index.ts(requestRejection、限体 JSON、路由样板)
 * - packages/host/frontend-static/src/index.ts(静态服务、穿越拒绝)
 * - packages/fs/tool-fs/src/session-cwd.ts(会话工作区 cwd)
 * - packages/todo/tool-todo/src/index.ts(defineTool + ctx.tools.register)
 * - OpenViking examples/dsh-memory-plugin/skills.mjs(skill provider 挂载)
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as skillFilesystem from '@deepseek-ai/dsh-skill-filesystem'
import {
  ESCALATION_TARGETS, approveEscalation, escalationHintMarker, sandboxDenialMarker,
  validateEscalationArgs,
} from '@deepseek-ai/dsh-sandbox'
import { FsError } from '@deepseek-ai/dsh-fs'

/** Cordis 插件契约:name/inject/apply。 */
export const name = 'dsh-drawio-plugin'
export const inject = ['tools', 'webServer', 'connection', 'fs', 'sessions', 'sessionQuery']

/** 包内 vendor 的 drawio webapp 根目录(pin 版本,见 vendor/drawio/VERSION)。 */
const VENDOR_ROOT = fileURLToPath(new URL('./vendor/drawio', import.meta.url))
/** 随包技能目录(skills/drawio-diagram/SKILL.md)。 */
const SKILLS_DIR = fileURLToPath(new URL('./skills', import.meta.url))

/** 静态资源前缀(webServer 路由 path 不带尾斜杠)。 */
const DRAWIO_PREFIX = '/drawio'
const SAVE_ROUTE = '/drawio/save'
const FILE_ROUTE = '/drawio/file'

/** save 请求体上限:drawio XML 可能数 MB,给 8 MiB。 */
const MAX_BODY_BYTES = 8 * 1024 * 1024

/** 静态资源 MIME;查不到一律 octet-stream(照 frontend-static 基础表扩充)。 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.gz': 'application/gzip',
  '.webmanifest': 'application/manifest+json',
}

/** 只有"不存在/不是文件"映射 404,其余 fs 错误上交给 webserver 兜底。 */
const STATIC_MISS_CODES = new Set(['ENOENT', 'EISDIR', 'ENOTDIR'])

/**
 * connection 服务是浏览器侧包,Host 侧无类型;照样板用 Reflect 取。
 * @param ctx 插件上下文。
 * @returns 带 requestRejection 的连接服务。
 */
function connectionOf(ctx) {
  return Reflect.get(ctx, 'connection')
}

/**
 * 路由统一入口闸:未授权请求直接按 401/403 结束。
 * @returns true 表示已拒绝,调用方立即 return。
 */
function rejected(ctx, req, res) {
  const rejection = connectionOf(ctx).requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end()
  return true
}

/** JSON 响应(no-store:写读结果都是活事实)。 */
function sendJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(payload))
}

/** 405 + allow 头。 */
function sendMethodNotAllowed(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

/**
 * 限体读取请求体为 UTF-8 文本;超限先排空再返回 null(响应可读而非断流)。
 * @param req node:http 请求。
 * @param limit 字节上限。
 */
async function readBoundedBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) {
      req.resume()
      return null
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks, size).toString('utf8')
}

/** 标题 → 文件名片段:去分隔符与非法字符,限长,空则回退 'diagram'。 */
function sanitizeTitle(title) {
  const cleaned = title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
  return cleaned === '' ? 'diagram' : cleaned
}

/** 统一相对路径形态:反斜杠归一为正斜杠,去前导 './' 与 '/'。 */
function normalizeRelPath(input) {
  return input.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '')
}

/**
 * 工作区内 .drawio 相对路径的词法校验(深度防御的第一道;
 * 第二道是 join+startsWith,见 resolveWithin)。
 * 拒绝:空、NUL、绝对路径、盘符、'.'/'..' 段、非 .drawio 后缀。
 */
function isSafeDrawioRelPath(rel) {
  if (rel === '' || rel.includes('\0')) return false
  if (rel.startsWith('/') || /^[a-zA-Z]:\//.test(rel)) return false
  const segments = rel.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return false
  return rel.toLowerCase().endsWith('.drawio')
}

/**
 * 词法拼接 root 与 rel 并确认不越出 root(静态服务与写读路由共用)。
 * @returns 绝对路径;越界返回 undefined。
 */
function resolveWithin(root, rel) {
  const target = resolve(normalize(join(root, rel)))
  // sep 而非 '/':Windows 上 resolve 产出反斜杠路径
  if (target !== root && !target.startsWith(root + sep)) return undefined
  return target
}

/**
 * 沙箱升级控制器(照 packages/fs/tool-fs/src/sandbox.ts 的 FsSandboxController 裁剪):
 * 仅当挂载了限制性 fs 后端(ctx.fs.sandboxMode 有值)才需要 ctx.sandboxPolicy;
 * 裸后端不做任何策略盖章。
 */
function sandboxControllerOf(ctx) {
  const defaultMode = ctx.fs.sandboxMode
  if (defaultMode === undefined) return { escalationModes: [] }
  const policy = ctx.get('sandboxPolicy')
  if (policy === undefined) {
    throw new Error('dsh-drawio: 文件系统后端启用了沙箱,但 ctx.sandboxPolicy 缺失')
  }
  return { escalationModes: ESCALATION_TARGETS, policy }
}

/** 升级参数的两个 schema 字段(仅在限制性后端下向模型广告)。 */
function escalationSchemaFields(controller) {
  return {
    sandbox_permissions: {
      type: 'string',
      enum: [...controller.escalationModes],
      description: 'The wider sandbox mode this file operation needs. Only valid as a one-shot retry '
        + 'of an operation the sandbox just denied; requires justification and user approval.',
    },
    justification: {
      type: 'string',
      description: 'Required with sandbox_permissions: one sentence for the user explaining '
        + 'why this exact file operation needs the wider access.',
    },
  }
}

/**
 * 为本次写盘盖章策略:常设模式(会话 cwd 为 workspaceRoot),或在携带升级参数时
 * 先经 ctx.approval 审批再放行(与第一方 write/edit 完全同构)。
 */
async function resolveWritePolicy(ctx, controller, args, exec) {
  validateEscalationArgs(args.sandbox_permissions, args.justification)
  const standingPolicy = controller.policy?.resolve(
    exec.agent !== undefined ? { session: exec.agent.session } : {},
  )
  if (args.sandbox_permissions === undefined || args.justification === undefined) {
    return standingPolicy
  }
  if (controller.escalationModes.length === 0) {
    throw new Error('sandbox_permissions is not available in this composition (no sandboxing filesystem to escalate)')
  }
  const approvedMode = await approveEscalation(
    {
      requestedMode: args.sandbox_permissions,
      justification: args.justification,
      effectiveMode: standingPolicy.mode,
      subject: 'operation',
    },
    {
      approver: ctx.get('approval'),
      agent: exec.agent,
      callId: exec.callId,
      toolName: 'drawio_render',
      signal: exec.signal,
    },
  )
  return { ...standingPolicy, mode: approvedMode }
}

/**
 * 沙箱拒绝映射(照 tool-fs mapError):FS_SANDBOX_DENIED → 带 [sandbox: …] 标记与
 * 升级提示的 FsError,模型读到的文案与 bash/write 一致,知道如何带升级参数重试。
 */
function mapSandboxError(error, policy) {
  if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
  return new FsError(
    `${sandboxDenialMarker(policy.mode)}\n${escalationHintMarker('operation')}`,
    'FS_SANDBOX_DENIED',
    { cause: error },
  )
}

/**
 * 按 sessionId 解析工作区根:经 ctx.sessionQuery.observeSession 观察目标会话
 * (live 优先;历史会话冷读恢复,不进 store),取其 header.cwd 作为根。
 * 不信任客户端上报的 cwd——根永远来自服务端会话事实;活会话与历史会话统一支持。
 * 会话不存在或 cwd 缺失/非绝对路径时返回 undefined。
 */
async function workspaceRootOf(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  let observation
  try {
    observation = await ctx.sessionQuery.observeSession(sessionId, { projectionMode: 'none' })
  } catch {
    return undefined
  }
  try {
    const cwd = observation.header?.cwd
    return typeof cwd === 'string' && cwd !== '' && isAbsolute(cwd) ? cwd : undefined
  } finally {
    observation[Symbol.dispose]()
  }
}

/**
 * 注册工具 drawio_render:把模型产出的完整 mxfile XML 写入会话工作区,
 * canonical value { filePath, xml } 持久化到会话日志(供卡片与回放);
 * render 只回短文本,不把 XML 回喂模型。SVG 导出不在 Host 侧做(浏览器 iframe 内完成)。
 */
function registerDrawioTool(ctx) {
  // apply 期一次性构建(照 tool-fs:FsSandboxController 每插件建一次)
  const controller = sandboxControllerOf(ctx)
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'drawio_render',
    description:
      '绘制图形并保存为工作区内的 .drawio 文件,随后在对话中渲染缩略图卡片。'
      + '当用户要求画/绘制/生成架构图、时序图、流程图、思维导图、甘特图、示意图等图形时调用。'
      + 'xml 必须是完整的 mxfile 文档(写法见 drawio-diagram 技能),path 省略时默认 diagrams/<title>.drawio。',
    parameters: {
      title: {
        type: 'string',
        required: true,
        description: '图标题,同时用于默认文件名。',
      },
      xml: {
        type: 'string',
        required: true,
        description: '完整的 .drawio mxfile XML(根元素 mxfile),能被 drawio 直接打开。',
      },
      path: {
        type: 'string',
        description: '工作区内相对路径(以 .drawio 结尾);省略时默认 diagrams/<title>.drawio。',
      },
      // 限制性 fs 后端下广告升级字段(与第一方 write/edit 同词汇)
      ...controller.escalationModes.length > 0 ? escalationSchemaFields(controller) : {},
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          filePath: { type: 'string' },
          xml: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `drawio 图已写入工作区:${value.filePath}(对话卡片将展示缩略图,用户可继续编辑)。`,
      }],
      presentationMeta: (args, value) => ({ filePath: value.filePath, title: args.title }),
    },
    async execute(args, exec) {
      // 与 tool-fs 同源:会话工作区在 session header 上;非会话调用无工作区可写
      const cwd = exec.agent?.session.header.cwd
      if (cwd === undefined) {
        throw new Error('drawio_render: 当前调用没有会话工作区,无法保存图形文件')
      }
      const rel = normalizeRelPath(args.path ?? `diagrams/${sanitizeTitle(args.title)}.drawio`)
      if (!isSafeDrawioRelPath(rel)) {
        throw new Error(`drawio_render: 非法的工作区相对路径(必须位于工作区内且以 .drawio 结尾):${rel}`)
      }
      // 策略先行(照 tool-fs write.ts):常设模式或经审批的升级模式,
      // 盖章进 writeText;裸后端 policy 为 undefined,后端忽略之
      const policy = await resolveWritePolicy(ctx, controller, args, exec)
      const target = await ctx.fs.resolve(rel, {
        cwd: policy?.workspaceRoot ?? cwd,
        signal: exec.signal,
      })
      try {
        await ctx.fs.writeText(target, args.xml, undefined, exec.signal, policy)
      } catch (error) {
        throw mapSandboxError(error, policy)
      }
      return { filePath: rel, xml: args.xml }
    },
  })), 'drawio: tool drawio_render')
}

/** 静态服务:/drawio/* → vendor/drawio/*(GET/HEAD;穿越 403;缺失 404)。 */
async function handleStatic(ctx, req, res) {
  if (rejected(ctx, req, res)) return
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    sendMethodNotAllowed(res, 'GET, HEAD')
    return
  }
  let rel
  try {
    rel = decodeURIComponent(new URL(String(req.url), 'http://localhost').pathname)
      .slice(DRAWIO_PREFIX.length)
  } catch {
    sendJson(res, 400, { code: 'bad-request', message: 'malformed URL escape' })
    return
  }
  // 站点根与目录根都落到 drawio 编辑器入口
  if (rel === '' || rel === '/') rel = '/index.html'
  const target = resolveWithin(VENDOR_ROOT, rel)
  if (target === undefined) {
    res.writeHead(403)
    res.end()
    return
  }
  let body
  try {
    body = await readFile(target)
  } catch (error) {
    if (!STATIC_MISS_CODES.has(/** @type {NodeJS.ErrnoException} */ (error).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  const ext = extname(target)
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    // vendor 版本 pin,升级即换内容;HTML 入口每次协商,其余长缓存
    'cache-control': ext === '.html' ? 'no-cache' : 'public, max-age=3600',
  })
  res.end(body)
}

/**
 * 保存:POST /drawio/save { sessionId, path, xml }。
 * 词法校验 → sessionId 观察解析工作区根 → node fs 写盘(用户手势,不过模型沙箱)。
 */
async function handleSave(ctx, req, res) {
  if (rejected(ctx, req, res)) return
  if (req.method !== 'POST') {
    sendMethodNotAllowed(res, 'POST')
    return
  }
  // 媒体类型 essence 必须恰好是 application/json(照样板)
  const essence = String(req.headers['content-type']).split(';', 1)[0]?.trim().toLowerCase()
  if (essence !== 'application/json') {
    sendJson(res, 415, { code: 'unsupported-media-type', message: 'content-type must be application/json' })
    return
  }
  let text
  try {
    text = await readBoundedBody(req, MAX_BODY_BYTES)
  } catch {
    sendJson(res, 400, { code: 'bad-request', message: 'request body unreadable' })
    return
  }
  if (text === null) {
    sendJson(res, 413, { code: 'payload-too-large', message: 'request body is too large' })
    return
  }
  let body
  try {
    body = JSON.parse(text)
  } catch {
    sendJson(res, 400, { code: 'bad-request', message: 'request body must be JSON' })
    return
  }
  const { sessionId, path, xml } = body ?? {}
  if (typeof sessionId !== 'string' || typeof path !== 'string' || typeof xml !== 'string') {
    sendJson(res, 400, { code: 'bad-request', message: 'body must be JSON with string "sessionId", "path", "xml"' })
    return
  }
  const rel = normalizeRelPath(path)
  if (!isSafeDrawioRelPath(rel)) {
    sendJson(res, 400, { code: 'bad-path', message: `path must stay inside the workspace and end with .drawio: ${rel}` })
    return
  }
  const root = await workspaceRootOf(ctx, sessionId)
  if (root === undefined) {
    sendJson(res, 400, { code: 'no-workspace', message: `unknown session workspace: ${sessionId}` })
    return
  }
  // 浏览器路由走 node fs(用户手势信任模型,与 open-in-app 用 node fs 同理),
  // 不经过模型沙箱;词法防线:resolveWithin + 会话工作区根来自服务端事实 + .drawio 后缀
  const abs = resolveWithin(root, rel)
  if (abs === undefined) {
    sendJson(res, 400, { code: 'bad-path', message: `path escapes the workspace: ${rel}` })
    return
  }
  try {
    await mkdir(dirname(abs), { recursive: true })
    await writeFile(abs, xml, 'utf8')
  } catch (error) {
    sendJson(res, 500, { code: 'write-failed', message: error instanceof Error ? error.message : String(error) })
    return
  }
  sendJson(res, 200, { ok: true, path: rel })
}

/** 读文件:GET /drawio/file?sessionId=…&path=… → { path, xml }。 */
async function handleFile(ctx, req, res) {
  if (rejected(ctx, req, res)) return
  if (req.method !== 'GET') {
    sendMethodNotAllowed(res, 'GET')
    return
  }
  const url = new URL(String(req.url), 'http://localhost')
  const sessionId = url.searchParams.get('sessionId') ?? ''
  const rel = normalizeRelPath(url.searchParams.get('path') ?? '')
  if (!isSafeDrawioRelPath(rel)) {
    sendJson(res, 400, { code: 'bad-path', message: `path must stay inside the workspace and end with .drawio: ${rel}` })
    return
  }
  const root = await workspaceRootOf(ctx, sessionId)
  if (root === undefined) {
    sendJson(res, 400, { code: 'no-workspace', message: `unknown session workspace: ${sessionId}` })
    return
  }
  const abs = resolveWithin(root, rel)
  if (abs === undefined) {
    sendJson(res, 400, { code: 'bad-path', message: `path escapes the workspace: ${rel}` })
    return
  }
  let xml
  try {
    xml = await readFile(abs, 'utf8')
  } catch (error) {
    if (STATIC_MISS_CODES.has(/** @type {NodeJS.ErrnoException} */ (error).code)) {
      sendJson(res, 404, { code: 'not-found', message: `no such file: ${rel}` })
      return
    }
    sendJson(res, 500, { code: 'read-failed', message: error instanceof Error ? error.message : String(error) })
    return
  }
  sendJson(res, 200, { path: rel, xml })
}

/** 注册三条路由,每条一个 ctx.effect(可独立回收)。 */
function registerDrawioRoutes(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: SAVE_ROUTE,
    handler: (req, res) => handleSave(ctx, req, res),
  }), `drawio: POST ${SAVE_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: FILE_ROUTE,
    handler: (req, res) => handleFile(ctx, req, res),
  }), `drawio: GET ${FILE_ROUTE}`)

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: DRAWIO_PREFIX,
    handler: (req, res) => handleStatic(ctx, req, res),
  }), `drawio: GET ${DRAWIO_PREFIX}/*`)
}

/**
 * 挂载随包技能(照 OpenViking skills.mjs):独立 provider 名,
 * 不读默认技能根、不监听文件变动(打包技能只随升级变化)。
 */
function mountDrawioSkills(ctx) {
  return ctx.plugin(skillFilesystem, {
    providerName: 'drawio',
    includeDefaultRoots: false,
    bundledSkillDir: SKILLS_DIR,
    watch: false,
  })
}

/** Host 半入口:工具 + 路由 + 技能。 */
export function apply(ctx) {
  registerDrawioTool(ctx)
  registerDrawioRoutes(ctx)
  mountDrawioSkills(ctx)
}
