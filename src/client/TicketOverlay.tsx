/**
 * 工单覆盖层：盖住右侧主区，左栏仍可见可点。
 *
 * 这不是路由切换——宿主没有路由，打开工单只是叠一层。来源页在下面继续挂载，
 * 关掉覆盖层回到原处，滚动位置和已加载的事件都不丢。
 */
import { createElement as h, useEffect, useRef } from 'react'
import { ErrorBoundary } from './boundary.ts'
import { pushEscape } from './escape.ts'
import { styles } from './styles.ts'
import { TicketView } from './TicketView.tsx'

export function TicketOverlay(props: {
  ticketId: string
  /** 面包屑的前半截：来源的中文标题，拿不到就退回来源 id。 */
  sourceLabel?: string
  onClose: () => void
}): ReturnType<typeof h> {
  // 覆盖层先压栈；里面再开抽屉是后压，所以 Esc 先关抽屉、再关它。
  //
  // 栈上只压**一个**稳定闭包：父组件传的 onClose 是行内箭头函数，每次渲染都是新引用；
  // 若拿它做依赖，每渲染一次都会「弹出再压回」，把覆盖层顶到抽屉之上，Esc 顺序就反了。
  const close = useRef(props.onClose)
  useEffect(() => { close.current = props.onClose })
  useEffect(() => pushEscape(() => close.current()), [])

  return h('section', { 'data-ticket-overlay': props.ticketId, style: styles.overlay },
    h('div', { style: styles.overlayHead },
      h('button', { style: styles.overlayBack, onClick: props.onClose }, '← 返回来源'),
      h('span', { style: styles.overlayCrumb },
        `${props.sourceLabel ?? '来源'} › 工单 ${props.ticketId}`)),
    h('div', { style: styles.overlayBody },
      // 边界放在覆盖层内部：一张工单画不出来时，顶栏的「返回来源」与下面的来源页都还在。
      //
      // `key` 必须有：左栏在覆盖层打开时仍可点，换工单只改 ticketId、不重建这棵子树；
      // 边界的错误状态只在卸载时清空，不换 key 的话上一张的崩溃会一直盖着下一张。
      h(ErrorBoundary, {
        key: props.ticketId,
        fallback: (error: Error) => h('div', { 'data-boundary': 'ticket', style: styles.crashed },
          h('div', { style: styles.crashedTitle }, '这张工单画不出来'),
          h('div', { style: styles.crashedHint },
            `${error.message.slice(0, 200)}。点左上「← 返回来源」回到事件列表，其它工单不受影响。`)),
      }, h(TicketView, { ticketId: props.ticketId }))),
  )
}
