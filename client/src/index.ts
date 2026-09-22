/**
 * @you/dsh-drawio-plugin — Client 半(浏览器侧)入口。
 *
 * 注册五件东西,全部随插件生命周期回收:
 * ① 本地化字典(NS='drawio');
 * ② keyed toolview 卡片(key='drawio_render' → DrawioCard,折叠区内的工具行);
 * ③ drawio-file 资源 provider(缩略图自动刷新通道);
 * ④ drawio 会话事件 Definition(drawio/rendered → turn 数据累积);
 * ⑤ turnTail 槽位卡片(正式回复主流的缩略图卡片,turn-tail 永不折叠)。
 *
 * 跨插件值导入禁止(宿主 bundle purity 规则):其余 dsh 包一律 import type,
 * 运行时协作全部走 cordis 服务(ctx.slots / ctx.locale / ctx.resources /
 * ctx.uiConversation)。形状照 packages/client/ui-deliverables/src/client/index.ts。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import { DrawioCard } from './card.tsx'
import { DrawioTail } from './tail.tsx'
import { drawioDefinition } from './turn-drawio.ts'
import { registerDrawioFileResource } from './resource.ts'
import { en, NS, zh } from './locales.ts'

/** 需要的 ctx 服务(dsh.client.inject 里的包提供;与包级声明不同维度,勿混)。 */
export const inject = ['slots', 'locale', 'resources', 'uiConversation']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'drawio: dictionaries')
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register(
    { name: 'tool.call.toolview', key: 'drawio_render', locale: NS },
    DrawioCard,
  ))
  // turn 数据累积器:drawio/rendered 事件 → turn.data['drawio']
  ctx.uiConversation.events.register(drawioDefinition)
  // 正式回复主流的卡片(list 槽位用 id 而非 key)
  ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register(
    { name: 'conversation.chat.turnTail', id: '@you/dsh-drawio-plugin', locale: NS },
    DrawioTail,
  ))
  registerDrawioFileResource(ctx)
}

