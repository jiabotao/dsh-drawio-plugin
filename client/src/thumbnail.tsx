/**
 * 缩略图:资源值(xml)变化时,经隐藏 embed iframe 导出 SVG 显示。
 *
 * - 每个实例一个隐藏 EmbedSession(懒挂载,组件卸载销毁);
 * - xml 串变 → 串行 load + export('svg')(postMessage 同通道顺序到达);
 * - 回包字段宽容处理:`svg`(原始文本)或 `data`(data URI)都接受。
 */
import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { EmbedSession, type EmbedExportResult } from './embed.ts'
import type { DrawioFileValue } from './resource.ts'

const VIEWER_URL = '/drawio/index.html?embed=1&proto=json'

/** `useResource('drawio-file')` 快照的最小结构面(避免值导入资源包类型)。 */
export interface ThumbnailSnapshot {
  readonly status: 'none' | 'loading' | 'live' | 'failed'
  readonly value: DrawioFileValue | undefined
  readonly failure: { readonly message: string } | undefined
}

/** export 回包 → <img> src;不认得的形态返回 undefined。 */
function toSvgImgSrc(result: EmbedExportResult): string | undefined {
  const raw = result.svg ?? result.data
  if (typeof raw !== 'string' || raw === '') return undefined
  if (raw.startsWith('data:')) return raw
  if (raw.startsWith('<')) return `data:image/svg+xml;utf8,${encodeURIComponent(raw)}`
  return undefined
}

const frameStyle: CSSProperties = {
  border: '1px solid var(--dsh-border, #e0e0e0)',
  borderRadius: '8px',
  background: '#fff',
  padding: '8px',
  overflow: 'auto',
}
const imageStyle: CSSProperties = { display: 'block', maxWidth: '100%', height: 'auto' }
const hintStyle: CSSProperties = { fontSize: '12px', opacity: 0.7, padding: '12px' }
const retryStyle: CSSProperties = { marginLeft: '8px' }

export interface ThumbnailProps {
  snapshot: ThumbnailSnapshot
  alt: string
  renderingText: string
  failedText: string
  retryText: string
}

export function Thumbnail({ snapshot, alt, renderingText, failedText, retryText }: ThumbnailProps) {
  const [svgSrc, setSvgSrc] = useState<string | undefined>()
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const hostRef = useRef<HTMLDivElement | null>(null)
  const sessionRef = useRef<EmbedSession | undefined>()
  const chainRef = useRef<Promise<unknown>>(Promise.resolve())
  const xml = snapshot.value?.xml

  // 串行渲染管线:每次 xml 变化 load + export;卸载时取消并销毁会话
  useEffect(() => {
    if (xml === undefined) return
    let cancelled = false
    chainRef.current = chainRef.current.then(async () => {
      try {
        const host = hostRef.current
        if (host === null) return
        sessionRef.current ??= await EmbedSession.open(host, VIEWER_URL)
        if (cancelled) return
        sessionRef.current.load(xml)
        const result = await sessionRef.current.export('svg')
        if (cancelled) return
        const src = toSvgImgSrc(result)
        if (src === undefined) throw new Error('drawio: 导出回包中没有 SVG')
        setSvgSrc(src)
        setFailed(false)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })
    return () => { cancelled = true }
  }, [xml, attempt])

  useEffect(() => () => {
    sessionRef.current?.destroy()
    sessionRef.current = undefined
  }, [])

  return (
    <div style={frameStyle}>
      <div ref={hostRef} style={{ display: 'none' }} aria-hidden />
      {svgSrc !== undefined && !failed
        ? <img style={imageStyle} src={svgSrc} alt={alt} />
        : failed || snapshot.status === 'failed'
          ? (
            <div style={hintStyle}>
              {failedText}
              {snapshot.failure !== undefined ? `:${snapshot.failure.message}` : ''}
              <button type="button" style={retryStyle} onClick={() => { setFailed(false); setAttempt(n => n + 1) }}>
                {retryText}
              </button>
            </div>
          )
          : <div style={hintStyle}>{renderingText}</div>}
    </div>
  )
}
