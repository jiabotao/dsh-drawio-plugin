/**
 * 全屏 drawio 编辑器覆盖层(React portal,不需要任何新 slot)。
 *
 * 流程:iframe(init)→ load(资源最新 xml)→ 关闭时 export('xml')
 * → saveAndPublish(写盘 + 推帧)→ onClose。编辑器内 Ctrl+S
 * ({event:'save'})走同样的保存但不关闭;{event:'exit'} 视同关闭。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import { EmbedSession } from './embed.ts'
import { saveAndPublish } from './resource.ts'

const EDITOR_URL = '/drawio/index.html?embed=1&proto=json&ui=min'

const overlayStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--dsh-bg, #ffffff)',
}
const barStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '8px 12px',
  borderBottom: '1px solid var(--dsh-border, #e0e0e0)',
  fontSize: '13px',
}
const titleStyle: CSSProperties = { fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
const stageStyle: CSSProperties = { flex: 1, minHeight: 0 }

export interface EditorOverlayProps {
  sessionId: string
  path: string
  xml: string
  title: string
  savingText: string
  closeText: string
  onClose: () => void
}

export function EditorOverlay({ sessionId, path, xml, title, savingText, closeText, onClose }: EditorOverlayProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<EmbedSession | undefined>()
  const savingRef = useRef(false)
  const aliveRef = useRef(true)
  const [saving, setSaving] = useState(false)

  /** 导出最新 xml → 写盘 + 推帧(保存失败只记日志,由用户重试)。 */
  const save = async (): Promise<void> => {
    const session = sessionRef.current
    if (session === undefined || savingRef.current) return
    savingRef.current = true
    setSaving(true)
    try {
      const result = await session.export('xml')
      if (typeof result.xml === 'string' && aliveRef.current) {
        await saveAndPublish(sessionId, path, result.xml)
      }
    } catch (error) {
      console.error('[dsh-drawio] 保存失败:', error)
    } finally {
      savingRef.current = false
      if (aliveRef.current) setSaving(false)
    }
  }

  /** 关闭:先保存再退场。 */
  const close = async (): Promise<void> => {
    await save()
    onClose()
  }

  useEffect(() => {
    aliveRef.current = true
    const host = hostRef.current
    if (host === null) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    const onKeydown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') void close()
    }
    window.addEventListener('keydown', onKeydown)

    EmbedSession.open(host, EDITOR_URL)
      .then(session => {
        if (!aliveRef.current) {
          session.destroy()
          return
        }
        sessionRef.current = session
        session.load(xml)
        session.onSave(() => { void save() })
        session.onExit(() => { void close() })
      })
      .catch((error: unknown) => {
        console.error('[dsh-drawio] 编辑器初始化失败:', error)
        onClose()
      })

    return () => {
      aliveRef.current = false
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeydown)
      sessionRef.current?.destroy()
      sessionRef.current = undefined
    }
    // 覆盖层只在挂载时初始化一次;xml 取打开时刻的最新资源帧,
    // sessionId/path/onClose 在其生命周期内不变
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return createPortal(
    <div style={overlayStyle} role="dialog" aria-modal="true" aria-label={title}>
      <div style={barStyle}>
        <span style={titleStyle}>{title}</span>
        {saving ? <span>{savingText}</span> : null}
        <button type="button" onClick={() => { void close() }}>{closeText}</button>
      </div>
      <div ref={hostRef} style={stageStyle} />
    </div>,
    document.body,
  )
}
