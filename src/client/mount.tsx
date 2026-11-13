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
 * 侧栏图标：一个来源点分出两条去向。
 *
 * 必须画成 16×16 的 SVG——宿主给图标位固定 16px（`.panelGlyph`），标题起点靠它撑开；
 * 之前用字符 `⌁` 只有 8.4px 宽，标题会往左错位 7.6px。线宽与相邻几项同一档，
 * 颜色走 `currentColor`，选中态 / 悬停态由宿主着色。
 */
const Glyph = (): ReturnType<typeof createElement> =>
  createElement('svg', {
    width: 16,
    height: 16,
    viewBox: '0 0 16 16',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': 'true',
  },
  createElement('circle', { key: 'source', cx: 2.6, cy: 8, r: 1.2, fill: 'currentColor', stroke: 'none' }),
  createElement('path', { key: 'stem', d: 'M4.3 8h3.2' }),
  createElement('path', { key: 'fork', d: 'M7.5 8 12 3.7M7.5 8 12 12.3' }),
  createElement('circle', { key: 'up', cx: 13.2, cy: 3.1, r: 1.2, fill: 'currentColor', stroke: 'none' }),
  createElement('circle', { key: 'down', cx: 13.2, cy: 12.9, r: 1.2, fill: 'currentColor', stroke: 'none' }),
  )

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
      Glyph as ComponentType<never>,
    ))
}
