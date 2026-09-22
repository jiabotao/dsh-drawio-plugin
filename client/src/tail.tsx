/**
 * DrawioTail:turn 尾部的 drawio 卡片列表(conversation.chat.turnTail 槽位)。
 *
 * 与折叠区里的 toolview 卡片的差别:这里位于正式回复主流(turn-tail 在
 * TURN_PROCESS_INDEPENDENT_KINDS 白名单中),数据来自 turn-drawio.ts 从
 * tool/call + tool/result.meta 推导的 turn 数据(不依赖任何自定义会话事件)。
 * xml 事实源是 drawio-file 资源(首帧读盘,保存后推帧刷新),因此卡片始终
 * 展示文件当前内容。寻址用 props.sessionId,host 侧观察会话解析工作区根
 * (live 优先,历史会话冷读恢复),无需客户端再取 cwd。
 */
import { useState, type CSSProperties } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseResource } from '@deepseek-ai/dsh-client-resources/client'
import { addressFor } from './resource.ts'
import { Thumbnail } from './thumbnail.tsx'
import { EditorOverlay } from './editor-overlay.tsx'
import { selectRenderedDiagrams, type RenderedDiagram } from './turn-drawio.ts'
import { NS } from './locales.ts'

export type DrawioTailProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<typeof NS>

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

interface TailCardProps {
  item: RenderedDiagram
  sessionId: string
  useResource: UseResource
  t: PropsLocale<typeof NS>['t']
}

/** 单张图卡片(hooks 必须每卡一份,故列表项是独立组件)。 */
function TailDiagramCard({ item, sessionId, useResource, t }: TailCardProps) {
  const snapshot = useResource<'drawio-file'>(addressFor(sessionId, item.filePath))
  const [editing, setEditing] = useState(false)
  const currentXml = snapshot.value?.xml
  return (
    <div style={cardStyle} data-tool="drawio_render" data-turn-tail-card={item.callId}>
      <div style={headerStyle}>
        <span style={titleStyle}>{item.title}</span>
        <span style={pathStyle}>{item.filePath}</span>
        <button type="button" onClick={() => setEditing(true)}>{t('card.edit')}</button>
      </div>
      <Thumbnail
        snapshot={snapshot}
        alt={item.title}
        renderingText={t('card.rendering')}
        failedText={t('card.failed')}
        retryText={t('card.retry')}
      />
      {editing && currentXml !== undefined ? (
        <EditorOverlay
          sessionId={sessionId}
          path={item.filePath}
          xml={currentXml}
          title={item.title}
          savingText={t('card.saving')}
          closeText={t('card.close')}
          onClose={() => setEditing(false)}
        />
      ) : null}
    </div>
  )
}

/**
 * turn-tail 入口:本 turn 没有成功渲染的图时整体不出现(返回 null,
 * 不占用槽位布局)。
 */
export function DrawioTail(props: DrawioTailProps) {
  const rendered = selectRenderedDiagrams(props)
  if (rendered === null) return null
  const { sessionId, useResource, t } = props
  return (
    <>
      {rendered.map(item => (
        <TailDiagramCard key={item.callId} item={item} sessionId={sessionId} useResource={useResource} t={t} />
      ))}
    </>
  )
}
