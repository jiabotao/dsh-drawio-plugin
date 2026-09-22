/**
 * `drawio-file` 资源协议:卡片缩略图自动刷新的数据通道。
 *
 * - 地址:`dsh-resource://drawio-file/<encodeURIComponent(sessionId)>/<逐段编码的相对路径>`
 *   (host 按 sessionId 观察会话、取 header.cwd 作工作区根,活会话与历史会话统一支持)
 * - 值:`{ xml, rev }`;首帧来自 `GET /drawio/file`(host 为事实源),
 *   后续帧由 `saveAndPublish` 保存成功后推入(provider 私有队列;
 *   `ctx.resources.source()` 是只读 observable,不承担推帧)。
 * - 生命周期:registry 按 holder 计数共享/回收流;无持有者的地址推帧被丢弃。
 *
 * 协议形状照 packages/client/resources/README.md 与 src/client/contract.ts。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-resources/client'
// dsh-typert-protocol 属第一方 INLINE_SAFE 白名单(无共享运行时身份的契约层),
// 允许值导入并 inline(见 packages/client/tsdown.client.ts 的 INLINE_SAFE)
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'

/** 资源值:文件当前 XML 与单调递增版本号。 */
export interface DrawioFileValue {
  xml: string
  rev: number
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface ResourceProtocolMap {
    'drawio-file': DrawioFileValue
  }
}

const SCHEME = 'dsh-resource://drawio-file/'
const FILE_ROUTE = '/drawio/file'
const SAVE_ROUTE = '/drawio/save'

/** sessionId + 工作区相对路径 → 资源地址。 */
export function addressFor(sessionId: string, relPath: string): string {
  const segments = relPath.split('/').map(encodeURIComponent).join('/')
  return `${SCHEME}${encodeURIComponent(sessionId)}/${segments}`
}

/** 资源地址 → { sessionId, path };非法地址返回 undefined。 */
export function parseAddress(address: string): { sessionId: string; path: string } | undefined {
  if (!address.startsWith(SCHEME)) return undefined
  const rest = address.slice(SCHEME.length)
  const slash = rest.indexOf('/')
  if (slash <= 0 || slash === rest.length - 1) return undefined
  try {
    const sessionId = decodeURIComponent(rest.slice(0, slash))
    const path = rest.slice(slash + 1).split('/').map(decodeURIComponent).join('/')
    if (sessionId === '' || path === '') return undefined
    return { sessionId, path }
  } catch {
    return undefined
  }
}

/** 简易 JSON fetch;非 2xx 用响应体 message 抛错。 */
async function fetchJson(input: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const response = await fetch(input, init)
  const text = await response.text()
  let payload: Record<string, unknown> | undefined
  try {
    payload = text === '' ? undefined : JSON.parse(text) as Record<string, unknown>
  } catch {
    payload = undefined
  }
  if (!response.ok) {
    throw new Error(String(payload?.message ?? `HTTP ${response.status}`))
  }
  return payload ?? {}
}

interface Waiter {
  resolve: (value: DrawioFileValue) => void
  reject: (error: Error) => void
}

/** 单地址通道:无等待者时积压一帧队列,有等待者时直接分发。 */
interface Channel {
  queue: DrawioFileValue[]
  waiters: Waiter[]
  rev: number
}

const channels = new Map<string, Channel>()

function channelFor(address: string): Channel {
  let channel = channels.get(address)
  if (channel === undefined) {
    channel = { queue: [], waiters: [], rev: 0 }
    channels.set(address, channel)
  }
  return channel
}

function nextValue(channel: Channel, xml: string): DrawioFileValue {
  channel.rev += 1
  return { xml, rev: channel.rev }
}

/** 保存成功后推帧;无打开中的流则积在队列里,下一个 open 仍会先拉 host 首帧。 */
function publish(address: string, xml: string): void {
  const channel = channelFor(address)
  const value = nextValue(channel, xml)
  const waiters = channel.waiters.splice(0)
  if (waiters.length > 0) {
    for (const waiter of waiters) waiter.resolve(value)
    return
  }
  channel.queue.push(value)
}

/**
 * 编辑器关闭/保存的统一出口:写盘(host 校验)→ 推帧(卡片缩略图自动刷新)。
 * @throws host 拒绝或网络失败。
 */
export async function saveAndPublish(sessionId: string, path: string, xml: string): Promise<void> {
  await fetchJson(SAVE_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId, path, xml }),
  })
  publish(addressFor(sessionId, path), xml)
}

/** 地址后续帧流;signal 中止即结束(最后一个持有者离开时被 registry 中止)。 */
async function* frames(channel: Channel, signal: AbortSignal): AsyncIterable<{ ok: true; value: DrawioFileValue }> {
  while (!signal.aborted) {
    let value: DrawioFileValue
    const queued = channel.queue.shift()
    if (queued !== undefined) {
      value = queued
    } else {
      try {
        value = await new Promise<DrawioFileValue>((resolveWait, rejectWait) => {
          const waiter: Waiter = { resolve: resolveWait, reject: rejectWait }
          const onAbort = (): void => {
            const at = channel.waiters.indexOf(waiter)
            if (at !== -1) channel.waiters.splice(at, 1)
            rejectWait(new Error('aborted'))
          }
          if (signal.aborted) {
            onAbort()
            return
          }
          channel.waiters.push(waiter)
          signal.addEventListener('abort', onAbort, { once: true })
        })
      } catch {
        return
      }
    }
    yield { ok: true, value }
  }
}

/** 注册 drawio-file provider(包在 ctx.effect 内,随插件卸载回收)。 */
export function registerDrawioFileResource(ctx: Context): void {
  ctx.effect(() => ctx.resources.register<'drawio-file'>({
    protocol: 'drawio-file',
    async *open(address, { signal }) {
      const parsed = parseAddress(address)
      if (parsed === undefined) return
      const channel = channelFor(address)
      // 首帧:host 上的文件当前内容(事实源)
      try {
        const file = await fetchJson(
          `${FILE_ROUTE}?sessionId=${encodeURIComponent(parsed.sessionId)}&path=${encodeURIComponent(parsed.path)}`,
        )
        if (signal.aborted) return
        yield { ok: true, value: nextValue(channel, String(file.xml ?? '')) }
      } catch (error) {
        if (signal.aborted) return
        // 失败是一帧而非抛出:RemoteFailure 是 RemoteError 实例的联合,
        // 通用码 'gateway/internal',details 为空记录
        yield {
          ok: false,
          error: new RemoteError(
            'gateway/internal',
            error instanceof Error ? error.message : String(error),
            {},
          ),
        }
      }
      for await (const frame of frames(channel, signal)) yield frame
    },
  }), 'drawio: resource drawio-file')
}
