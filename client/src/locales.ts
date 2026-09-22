/**
 * 本地化字典(NS = 'drawio')。按钮与状态文案全部走字典,不写死中文。
 * 形状照 packages/client/ui-skill/src/client/locales.ts。
 */
export const NS = 'drawio'

export const zh = {
  'card.title': '图表',
  'card.generating': '正在生成图表…',
  'card.edit': '编辑',
  'card.close': '关闭',
  'card.saving': '保存中…',
  'card.failed': '渲染失败',
  'card.retry': '重试',
  'card.rendering': '正在渲染缩略图…',
  'card.noWorkspace': '当前会话没有工作区,无法预览',
} as const

export const en = {
  'card.title': 'Diagram',
  'card.generating': 'Generating diagram…',
  'card.edit': 'Edit',
  'card.close': 'Close',
  'card.saving': 'Saving…',
  'card.failed': 'Render failed',
  'card.retry': 'Retry',
  'card.rendering': 'Rendering thumbnail…',
  'card.noWorkspace': 'No workspace in this session; preview unavailable',
} as const

export type DrawioKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** DrawioCard 卡片与编辑器覆盖层的文案。 */
    drawio: DrawioKey
  }
}
