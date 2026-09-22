/**
 * Turn 级 drawio 已渲染图的 Definition 与读取器(纯客户端、无模型参与)。
 *
 * 数据来源:会话日志里已有的 `tool/call`(记名)与 `tool/result`(确认成功 +
 * 读 tool-private meta)。不追加任何自定义会话事件——第三方事件类型进不了
 * 构建期生成的 KNOWN_SESSION_EVENT_TYPES,而 Session.append 不暴露
 * `ignorable` 标记,写入即把会话变成"无插件不可读"(官方架构笔记
 * 2026-08-30-retain-ignorable-external-session-events)。presentationMeta
 * ({ filePath, title }) 随 tool/result.meta 持久化,回放原样返回,是合规通道。
 *
 * 推导形状照 packages/client/ui-deliverables/src/client/turn-deliverables.ts
 * 的 produced 累积:call 记 callId → result 成功落一条。
 * 本 Definition 只发布 turn 数据,不产出视图节点;卡片由
 * conversation.chat.turnTail 槽位渲染(turn-tail 永不折叠)。
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TurnTailOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'

/** 一次成功渲染的不可变事实;cwd 由查看会话的 header 提供(fork 继承 cwd)。 */
export interface RenderedDiagram {
  readonly seq: number
  readonly callId: string
  readonly filePath: string
  readonly title: string
}

/** 发布到一个 Turn 上的已渲染图集合。 */
export interface DrawioTurnData {
  readonly rendered: readonly RenderedDiagram[]
}

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface ConversationTurnDataMap {
    /** 本 Turn 内 drawio_render 成功写入工作区的图。 */
    drawio: DrawioTurnData
  }
}

interface DrawioState extends DrawioTurnData {
  readonly turn: number
  /** 见过的 drawio_render 调用(只记 callId;路径/标题以 result.meta 为准)。 */
  readonly calls: ReadonlySet<string>
}

/** drawio_render 的 presentationMeta 形状(与 host.mjs 的 output.presentationMeta 对齐)。 */
function isDrawioMeta(value: unknown): value is { filePath: string; title: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const { filePath, title } = value as Record<string, unknown>
  return typeof filePath === 'string' && filePath.trim().length > 0
    && typeof title === 'string'
}

/** Turn 本地累积器;只发布 Location 数据,不产出视图节点。 */
export const drawioDefinition: ConversationNodeDefinition<DrawioState> = {
  kind: 'drawio',
  match: (event) => {
    if (event.type === 'turn/start') return { id: String(event.data.turn), role: 'start' }
    if (event.type === 'tool/call') return { id: String(event.data.turn), role: 'update' }
    // 只数 append 到 surface 尾部的结算;replacement 影子不重复计数
    // (isAppendSurfaceEvent 的内联:跨插件值导入被 purity 规则禁止)
    if (event.type === 'tool/result' && event.surfaceOp === 'append') {
      return { id: String(event.data.turn), role: 'update' }
    }
    return null
  },
  start: (_context, match) => {
    if (match.event.type !== 'turn/start') throw new Error('drawio start requires turn/start')
    return { turn: match.event.data.turn, calls: new Set(), rendered: [] }
  },
  update: (context, match) => {
    if (match.event.type === 'tool/call') {
      if (match.event.data.name !== 'drawio_render') return context.state
      const callId = String(match.event.data.callId)
      if (context.state.calls.has(callId)) return context.state
      const calls = new Set(context.state.calls)
      calls.add(callId)
      return { ...context.state, calls }
    }
    if (match.event.type !== 'tool/result') return context.state
    const message = match.event.data.message
    const result = message.content[0]
    if (result === undefined || result.isError === true) return context.state
    const callId = String(message.source.callId)
    if (!context.state.calls.has(callId)) return context.state
    if (!isDrawioMeta(match.event.data.meta)) return context.state
    if (context.state.rendered.some(item => item.callId === callId)) return context.state
    return {
      ...context.state,
      rendered: [...context.state.rendered, {
        seq: match.event.seq,
        callId,
        filePath: match.event.data.meta.filePath,
        title: match.event.data.meta.title,
      }],
    }
  },
  buildLocationData: (context, scope, previous) => {
    if (scope !== 'turn' || context.state === undefined) return null
    if (context.state.rendered.length === 0) return null
    if (previous?.kind === 'turn'
      && previous.turn === context.state.turn
      && previous.key === 'drawio'
      && previous.value.rendered === context.state.rendered) return previous
    return {
      kind: 'turn',
      turn: context.state.turn,
      key: 'drawio',
      value: { rendered: context.state.rendered },
    }
  },
}

/**
 * 只有收尾 turn 真的产出了图才认领 turn-tail 链。
 * @param owner - turn-tail 的 owner 时值;seq 为收尾助手消息序,晚到的结算不算。
 * @returns 已渲染图列表,或 null(无图,组件渲染 null)。
 */
export function selectRenderedDiagrams(owner: TurnTailOwnerProps): readonly RenderedDiagram[] | null {
  const data = owner.turn.data.get('drawio')
  if (data === undefined) return null
  const rendered = data.rendered.filter(item => item.seq <= owner.seq)
  return rendered.length === 0 ? null : rendered
}
