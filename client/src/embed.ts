/**
 * drawio embed 模式 JSON postMessage 协议封装(`embed=1&proto=json`)。
 *
 * 报文事实来源:drawio `src/main/webapp/js/diagramly/EditorUi.js` —
 * 握手 `{event:'init'}`(L25247)、入向 `{action:'load'}`(L24499)、
 * 入向 `{action:'export', format}`(L24114,format 支持 xml/svg/xmlsvg/png/xmlpng)、
 * 出向 `{event:'export', …}`(L24141/L22960)、`{event:'save'}`、`{event:'exit'}`。
 *
 * 安全:drawio 回包 postMessage 目标是 `'*'`,所以入站必须双校验 —
 * `event.origin` 限本宿主源,`event.source` 限本 iframe;出站 targetOrigin 不发 '*'。
 */

/** `{event:'export'}` 回包(字段随 format 而定,以实测为准,见设计文档 PoC P1-1)。 */
export interface EmbedExportResult {
  format?: string
  xml?: string
  svg?: string
  data?: string
}

interface EmbedMessage {
  event?: string
  [key: string]: unknown
}

const INIT_TIMEOUT_MS = 30_000
const EXPORT_TIMEOUT_MS = 30_000

interface PendingExport {
  resolve: (result: EmbedExportResult) => void
  reject: (error: Error) => void
  timer: number
}

/** 一个 drawio iframe 的协议会话;`destroy` 前必须配对调用。 */
export class EmbedSession {
  private initResolve: (() => void) | undefined
  private pending: PendingExport | undefined
  private exportChain: Promise<unknown> = Promise.resolve()
  private readonly saveListeners = new Set<() => void>()
  private readonly exitListeners = new Set<() => void>()
  private destroyed = false

  private constructor(
    private readonly iframe: HTMLIFrameElement,
    private readonly origin: string,
  ) {
    window.addEventListener('message', this.onMessage)
  }

  /**
   * 挂载 iframe 并等 `{event:'init'}` 握手。
   * @param mount - iframe 的父容器(隐藏容器也可,drawio 离屏照常导出)。
   * @param url - `/drawio/index.html?embed=1&proto=json…`。
   */
  static open(mount: HTMLElement, url: string): Promise<EmbedSession> {
    return new Promise((resolveOpen, rejectOpen) => {
      const iframe = document.createElement('iframe')
      iframe.src = url
      iframe.style.border = '0'
      iframe.style.width = '100%'
      iframe.style.height = '100%'
      const session = new EmbedSession(iframe, window.location.origin)
      const timer = window.setTimeout(() => {
        session.destroy()
        rejectOpen(new Error('drawio: 编辑器初始化超时'))
      }, INIT_TIMEOUT_MS)
      session.initResolve = () => {
        window.clearTimeout(timer)
        resolveOpen(session)
      }
      mount.appendChild(iframe)
    })
  }

  /** 载入文档(load/export 报文同通道顺序到达,无需等 load 回包)。 */
  load(xml: string): void {
    this.post({ action: 'load', xml })
  }

  /** 导出(串行单 pending;30s 超时)。 */
  export(format: 'xml' | 'svg'): Promise<EmbedExportResult> {
    const run = (): Promise<EmbedExportResult> => new Promise((resolveExport, rejectExport) => {
      if (this.destroyed) {
        rejectExport(new Error('drawio: 会话已销毁'))
        return
      }
      const timer = window.setTimeout(() => {
        this.pending = undefined
        rejectExport(new Error(`drawio: export(${format}) 超时`))
      }, EXPORT_TIMEOUT_MS)
      this.pending = { resolve: resolveExport, reject: rejectExport, timer }
      this.post({ action: 'export', format })
    })
    const result = this.exportChain.then(run, run)
    this.exportChain = result.catch(() => {})
    return result
  }

  /** 编辑器内保存(Ctrl+S 等)回调;返回退订函数。 */
  onSave(listener: () => void): () => void {
    this.saveListeners.add(listener)
    return () => { this.saveListeners.delete(listener) }
  }

  /** 编辑器要求关闭回调;返回退订函数。 */
  onExit(listener: () => void): () => void {
    this.exitListeners.add(listener)
    return () => { this.exitListeners.delete(listener) }
  }

  /** 移除监听、拒绝挂起导出、卸载 iframe。 */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    window.removeEventListener('message', this.onMessage)
    if (this.pending !== undefined) {
      window.clearTimeout(this.pending.timer)
      this.pending.reject(new Error('drawio: 会话已销毁'))
      this.pending = undefined
    }
    this.iframe.remove()
  }

  private post(message: Record<string, unknown>): void {
    this.iframe.contentWindow?.postMessage(JSON.stringify(message), this.origin)
  }

  private readonly onMessage = (event: MessageEvent): void => {
    if (this.destroyed) return
    // 双校验:只收本宿主源、本 iframe 的报文
    if (event.origin !== this.origin || event.source !== this.iframe.contentWindow) return
    let data: EmbedMessage
    try {
      data = JSON.parse(String(event.data)) as EmbedMessage
    } catch {
      return
    }
    if (data === null || typeof data !== 'object') return
    switch (data.event) {
      case 'init': {
        const ready = this.initResolve
        this.initResolve = undefined
        ready?.()
        return
      }
      case 'export': {
        const pending = this.pending
        if (pending === undefined) return
        this.pending = undefined
        window.clearTimeout(pending.timer)
        pending.resolve(data as EmbedExportResult)
        return
      }
      case 'save':
        for (const listener of [...this.saveListeners]) listener()
        return
      case 'exit':
        for (const listener of [...this.exitListeners]) listener()
        return
      default:
    }
  }
}
