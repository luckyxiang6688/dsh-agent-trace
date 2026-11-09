/**
 * 左栏：上面「来源」，中间可拖的横线，下面「工单」。
 *
 * 两组各自滚动、各自有独立高度——来源列表长了不能把工单列表挤没，
 * 反过来也一样。折叠按钮保留自旧版，折叠时横线不画（56px 宽没有拖的意义）。
 *
 * 这里**不许出现 `<b>`**：E2E 用「aside 里有 b 且第一个按钮是关闭」识别抽屉。
 */
import { createElement as h, useLayoutEffect, useRef, useState } from 'react'
import type { ChainSummary } from '../domain/model.ts'
import type { SourceSummary } from '../domain/source.ts'
import { splitterUsable } from './split.ts'
import { Splitter } from './Splitter.tsx'
import { styles } from './styles.ts'

export function Rail(props: {
  sources: readonly SourceSummary[]
  activeSource?: string
  onPickSource: (source: string) => void
  tickets: readonly ChainSummary[]
  activeTicketId?: string
  onPickTicket: (ticketId: string) => void
  ratio: number
  onRatioChange: (ratio: number) => void
  onRatioCommit: (ratio: number) => void
  collapsed: boolean
  onToggle: () => void
}): ReturnType<typeof h> {
  const { collapsed } = props
  // 比例要对着**两区本身**量，不能对着整个 aside：标题栏那 40 多像素
  // 也算进高度的话，横线会停在鼠标上方，拖到两端也到不了 0/100。
  const body = useRef<HTMLDivElement | null>(null)
  // 两区总高不够时横线没有拖的意义（按钮、内容都塞不下），直接不画。
  // 窗口缩放会改变高度，所以要跟着量，不能在渲染时算一次。
  const [usable, setUsable] = useState(true)
  // 用 layout effect：首帧量好再绘制，矮窗口里不会先闪一下再消失。
  useLayoutEffect(() => {
    const element = body.current
    if (!element) return
    const measure = (): void => setUsable(splitterUsable(element.getBoundingClientRect().height))
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  return h('aside', {
    style: { ...styles.railShell, ...(collapsed ? { width: 56 } : {}) },
  },
    h('div', { style: styles.railHeadBar },
      collapsed ? null : h('span', { style: { ...styles.railTitle, margin: 0 } }, '来源与工单'),
      h('button', {
        style: styles.railToggle,
        title: collapsed ? '展开' : '收起',
        onClick: props.onToggle,
      }, collapsed ? '»' : '«')),
    h('div', { ref: body, 'data-rail-body': '1', style: styles.railBody },
    h('div', {
      'data-rail-sources': '1',
      style: { ...styles.railSection, flexBasis: `${props.ratio * 100}%`, flexGrow: 0, flexShrink: 0 },
    },
      collapsed ? null : h('div', { style: styles.railSectionTitle }, '来源'),
      props.sources.length === 0
        ? h('div', { style: styles.railFoot }, h('span', { style: styles.empty }, '还没有来源'))
        : props.sources.map(item => {
            const name = item.label ?? item.source
            const empty = item.received === 0
            return h('button', {
              key: item.source,
              'data-source-row': item.source,
              title: empty ? `${name} · 没有事件` : `${name} · ${item.received} 条事件`,
              onClick: () => props.onPickSource(item.source),
              style: {
                ...styles.sourceRow,
                ...(item.source === props.activeSource ? styles.itemOn : {}),
                ...(empty && item.source !== props.activeSource ? styles.sourceRowOff : {}),
              },
            },
              collapsed
                ? h('div', { style: { ...styles.itemCollapsed, padding: 0 } }, name.slice(0, 2))
                : [
                    h('div', { key: 'n', style: styles.sourceName }, name),
                    h('div', { key: 'm', style: styles.sourceMeta },
                      item.enabled === false
                        ? h('span', { style: styles.sourceWarn }, '未启用')
                        : empty
                          ? '没有事件'
                          : `${item.received} 条事件 · ${item.tickets} 张工单`),
                  ],
            )
          })),
    collapsed || !usable
      ? null
      : h(Splitter, {
          ratio: props.ratio,
          measure: () => body.current?.getBoundingClientRect() ?? null,
          onChange: props.onRatioChange,
          onCommit: props.onRatioCommit,
        }),
    h('div', {
      'data-rail-tickets': '1',
      style: { ...styles.railSection, flex: 1, borderTop: collapsed ? '1px solid #e6e8eb' : undefined },
    },
      collapsed ? null : h('div', { style: styles.railSectionTitle }, '工单'),
      props.tickets.length === 0
        ? h('div', { style: styles.railFoot }, h('span', { style: styles.empty }, '还没有工单'))
        : props.tickets.map(item =>
            h('button', {
              key: item.ticketId,
              'data-ticket-row': item.ticketId,
              title: item.title,
              onClick: () => props.onPickTicket(item.ticketId),
              style: {
                ...styles.item,
                ...(item.ticketId === props.activeTicketId ? styles.itemOn : {}),
                ...(collapsed ? styles.itemCollapsed : {}),
              },
            },
              collapsed
                ? h('span', { style: styles.dot })
                : [
                    h('div', { key: 'n', style: styles.itemName }, item.title),
                    h('div', { key: 'm', style: styles.itemMeta },
                      h('span', { style: styles.itemState }, `${item.state} · ${item.stepCount} 段`)),
                    item.summary ? h('div', { key: 's', style: styles.itemSummary }, item.summary) : null,
                  ],
            ))),
    ),
  )
}
