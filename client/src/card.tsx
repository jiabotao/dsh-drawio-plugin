/**
 * DrawioCard:`drawio_render` 工具调用的对话卡片(keyed toolview)。
 *
 * 视图模型只从持久化的调用切片派生(照 SkillRow):流式中显示"生成中",
 * 已结算 ok 显示缩略图卡片,error/stopped 显示摘要行。xml/path 取自
 * argsRaw;寻址用 sessionId(PropsRuntime 会话标准槽,host 侧观察会话解析
 * 工作区根);缩略图数据走 drawio-file 资源协议(useResource,保存后自动推帧刷新)。
 */
import { useState, type CSSProperties } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import { addressFor } from './resource.ts'
import { Thumbnail } from './thumbnail.tsx'
import { EditorOverlay } from './editor-overlay.tsx'

export type DrawioCardProps = ToolCallViewProps & PropsLocale<'drawio'>

type CardState = 'running' | 'ok' | 'error' | 'stopped'

interface CardModel {
  title: string
  path: string | undefined
  xml: string | undefined
  state: CardState
  errorSummary: string | null
}

/** 与 host.mjs 的 sanitizeTitle 保持一致(默认路径推导)。 */
function sanitizeTitle(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50)
  return cleaned === '' ? 'diagram' : cleaned
}

/** argsRaw 可能是流式截断 JSON;尽力解析,失败回退 callId。 */
function parseArgs(argsRaw: string): { title?: string; path?: string; xml?: string } {
  try {
    const parsed = JSON.parse(argsRaw) as unknown
    if (typeof parsed === 'object' && parsed !== null) {
      const { title, path, xml } = parsed as Record<string, unknown>
      return {
        ...(typeof title === 'string' ? { title } : {}),
        ...(typeof path === 'string' ? { path } : {}),
        ...(typeof xml === 'string' ? { xml } : {}),
      }
    }
  } catch {
    // 流式前缀不可解析:回退由调用方处理
  }
  return {}
}

function firstLine(text: string): string {
  const newline = text.indexOf('\n')
  return newline === -1 ? text : text.slice(0, newline)
}

/** 已结算结果的错误摘要(与 ui-tool 的文本契约对齐)。 */
function resultText(block: ToolCallViewProps['block']): string | null {
  if (!('kind' in block)) return null
  const parts: string[] = []
  for (const item of block.content) {
    parts.push(item.type === 'text' ? item.text : JSON.stringify(item))
  }
  return parts.join('\n') || null
}

function cardModel(block: ToolCallViewProps['block'], callId: string): CardModel {
  const settled = 'kind' in block
  const argsRaw = (settled ? block.call?.argsRaw : block.argsRaw) ?? ''
  const args = parseArgs(argsRaw)
  const title = args.title ?? firstLine(argsRaw) ?? callId
  const path = args.path ?? `diagrams/${sanitizeTitle(title)}.drawio`
  const state: CardState = !settled
    ? 'running'
    : block.error?.code === 'interrupted'
      ? 'stopped'
      : block.isError ? 'error' : 'ok'
  return {
    title,
    path,
    xml: args.xml,
    state,
    errorSummary: state === 'error' && settled ? (resultText(block) ?? block.error?.reason ?? null) : null,
  }
}

const cardStyle: CSSProperties = {
  border: '1px solid var(--dsh-border, #e0e0e0)',
  borderRadius: '8px',
  padding: '10px 12px',
  margin: '6px 0',
  display: 'flex',
  flexDirection: 'column',
  gap: '8px',
}
const headerStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '10px', fontSize: '13px' }
const titleStyle: CSSProperties = { fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const pathStyle: CSSProperties = { opacity: 0.65, fontFamily: 'monospace', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const rowStyle: CSSProperties = { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', opacity: 0.85 }

export function DrawioCard(props: DrawioCardProps) {
  const { block, callId, sessionId, useResource, t } = props
  const model = cardModel(block, callId)
  const [editing, setEditing] = useState(false)

  // 无 path 时用空地址:不是 dsh-resource URL,快照恒为 none(不发起任何流)
  const address = model.state === 'ok' && model.path !== undefined
    ? addressFor(sessionId, model.path)
    : ''
  const snapshot = useResource<'drawio-file'>(address)
  const currentXml = snapshot.value?.xml ?? model.xml

  if (model.state !== 'ok') {
    const text = model.state === 'running'
      ? t('card.generating')
      : (model.errorSummary ?? t('card.failed'))
    return (
      <div style={rowStyle} data-tool="drawio_render" data-state={model.state}>
        <span>{t('card.title')}</span>
        <span style={pathStyle}>{model.title}</span>
        <span>{text}</span>
      </div>
    )
  }

  return (
    <div style={cardStyle} data-tool="drawio_render">
      <div style={headerStyle}>
        <span style={titleStyle}>{model.title}</span>
        <span style={pathStyle}>{model.path}</span>
        <button type="button" onClick={() => setEditing(true)}>{t('card.edit')}</button>
      </div>
      <Thumbnail
        snapshot={snapshot}
        alt={model.title}
        renderingText={t('card.rendering')}
        failedText={t('card.failed')}
        retryText={t('card.retry')}
      />
      {editing && currentXml !== undefined ? (
        <EditorOverlay
          sessionId={sessionId}
          path={model.path ?? ''}
          xml={currentXml}
          title={model.title}
          savingText={t('card.saving')}
          closeText={t('card.close')}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  )
}
