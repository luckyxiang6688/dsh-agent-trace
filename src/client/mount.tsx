/** 把页面挂到 DSH 的侧边栏与主区。这里只做注册，不含渲染逻辑。 */
import { createElement, type ComponentType } from 'react'
import { ErrorBoundary } from './boundary.ts'
import { SourcePage } from './SourcePage.tsx'
import { styles } from './styles.ts'

/** DSH 客户端 slots 服务的最小形状。 */
export interface SlotsLike {
  inject(name: string, setup: () => unknown): unknown
  register(slot: Record<string, unknown>, component: ComponentType<never>): unknown
}

const PANEL_ID = 'agent-trace'
const LABEL = '来源与工单'

/**
 * 面板根部套一层错误边界：上游数据形状意外时，一次渲染抛错会把整块面板卸掉。
 *
 * 兜底文案只拼 `error.message`（截 200 字，与路由 500 响应同口径），不拼栈、不拼对象；
 * 不往宿主控制台写任何东西——那等于把上游内容带出去。代价是「抛错时把数据拼进 message」
 * 会直接显示在界面上，这条约束靠 review 与 `09` §6.3「错误上报」一行守。
 */
export const Panel = (): ReturnType<typeof createElement> =>
  createElement(ErrorBoundary, {
    fallback: (error: Error) => createElement('div', { 'data-boundary': 'panel', style: styles.crashed },
      createElement('div', { style: styles.crashedTitle }, '页面渲染出错'),
      createElement('div', { style: styles.crashedHint },
        `${error.message.slice(0, 200)}。切到别的面板再切回来可以重试；一直这样请把这一步的操作告诉我。`)),
  }, createElement(SourcePage))

export function apply(ctx: { slots: SlotsLike }): void {
  ctx.slots.inject('main', () =>
    ctx.slots.register({ name: 'main', key: PANEL_ID }, Panel as ComponentType<never>))

  ctx.slots.inject('sidebar.panellist', () =>
    ctx.slots.register(
      { name: 'sidebar.panellist', id: PANEL_ID, order: 10, label: () => LABEL },
      (() => createElement('span', { title: LABEL }, '⌁')) as ComponentType<never>,
    ))
}
