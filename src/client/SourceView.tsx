/**
 * 来源页的主内容：去向比例带 + 事件流（新 → 旧，游标分页）。
 *
 * 比例带的图例就是筛选器：点一次只看这一类，再点恢复全部。
 * 注意这里的 DOM 命名不用 `data-link` / `data-legend`——那些只属于工单视图，
 * E2E 会全量收集它们来数时序图的连线，来源页混进来会污染断言。
 */
import { createElement as h, useState } from 'react'
import type { EventFate, SourceEvent, SourceSummary } from '../domain/source.ts'
import { FATE_LABEL } from '../service/sources.ts'
import { styles } from './styles.ts'

type FateKind = EventFate['kind']

const FATE_ORDER: readonly FateKind[] = [
  'routed', 'direct', 'context', 'filtered', 'requeued', 'handback', 'undecided', 'unrecorded',
]

const FATE_COLOR: Readonly<Record<FateKind, string>> = {
  routed: '#818cf8',
  direct: '#f59e0b',
  context: '#a3b8c9',
  filtered: '#e5e7eb',
  requeued: '#c084fc',
  handback: '#fb7185',
  undecided: '#cbd5e1',
  unrecorded: '#f1f5f9',
}

/** 「丢弃/没记录」这类不是好消息也不刺眼：行内文字用更淡的灰。 */
function fateInk(kind: FateKind): string {
  if (kind === 'filtered' || kind === 'unrecorded' || kind === 'undecided') return '#9aa1ab'
  return FATE_COLOR[kind]
}

function countOf(summary: SourceSummary, kind: FateKind): number {
  if (kind === 'unrecorded') return summary.unrecorded
  return summary.counts[kind]
}

/** 事件的本地时间：只到分钟；没有时间就明说，不补一个假时刻。 */
export function formatWhen(at?: string): string {
  if (!at) return '时间未记录'
  const ms = Date.parse(at)
  if (!Number.isFinite(ms)) return '时间未记录'
  const date = new Date(ms)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function ticketsOf(fate: EventFate): readonly string[] {
  switch (fate.kind) {
    case 'routed':
      return fate.ticketId ? [fate.ticketId] : []
    case 'direct':
    case 'context':
    case 'handback':
      return fate.tickets
    default:
      return []
  }
}

export function SourceView(props: {
  summary?: SourceSummary
  events: readonly SourceEvent[]
  more: boolean
  loading: boolean
  loadingMore: boolean
  error?: string
  filter?: FateKind
  onToggleFilter: (kind: FateKind) => void
  onOpenEvent: (triggerId: string) => void
  onOpenTicket: (ticketId: string) => void
  onLoadMore: () => void
}): ReturnType<typeof h> {
  const { summary, events, filter } = props
  const name = summary?.label ?? summary?.source ?? '来源'
  const rows = filter ? events.filter(event => event.fate.kind === filter) : events

  if (!summary) {
    return h('div', { style: styles.sourceView },
      props.error ? h('div', { style: styles.error }, `读不到来源：${props.error}`) : null,
      h('div', { style: styles.empty }, props.loading ? '读取中…' : '选择一个来源'))
  }

  const total = summary.received

  return h('div', { 'data-source-view': summary.source, style: styles.sourceView },
    h('h1', { style: styles.sourceTitle }, name),
    props.summary?.label && props.summary.label !== summary.source
      ? h('div', { style: styles.sub }, summary.source)
      : null,
    h('div', { 'data-source-stats': '1', style: styles.statLine },
      h('span', null, h('span', { style: styles.statStrong }, String(summary.received)), ' 条事件'),
      h('span', null, h('span', { style: styles.statStrong }, String(summary.tickets)), ' 张工单'),
      h('span', null, summary.lastAt ? `最后 ${formatWhen(summary.lastAt)}` : '还没有事件'),
      summary.unrecorded > 0
        ? h('span', { title: '有事件行但没有去向行' }, `${summary.unrecorded} 条没有去向记录`)
        : null),
    total > 0
      ? h(FateBar, { summary, filter, onToggle: props.onToggleFilter })
      : null,
    filter
      ? h('div', { style: styles.statLine },
          h('button', {
            style: styles.filterChip,
            title: '取消筛选',
            onClick: () => props.onToggleFilter(filter),
          }, `只看 ${FATE_LABEL[filter]} · `, h('span', { style: { color: '#9aa1ab' } }, '×')))
      : null,
    h('div', { style: styles.eventList },
      rows.length === 0
        ? h('div', { style: styles.eventEmpty },
            props.loading
              ? '读取中…'
              : total === 0
                ? '这个来源还没有事件。'
                : filter
                  ? `已加载的事件里没有「${FATE_LABEL[filter]}」。`
                  : '这条来源没有可展示的事件。')
        : rows.map(event => h(EventRow, {
            key: event.triggerId,
            event,
            onOpen: props.onOpenEvent,
            onOpenTicket: props.onOpenTicket,
          }))),
    // 筛选是客户端做的，只覆盖已加载的部分——说清楚，别让人以为全部就这些。
    filter && props.more
      ? h('div', { style: styles.notRecorded }, `筛选只作用于已加载的 ${events.length} 条；更早的事件还没加载。`)
      : null,
    props.more
      ? h('button', {
          style: styles.loadMore,
          disabled: props.loadingMore,
          onClick: props.onLoadMore,
        }, props.loadingMore ? '加载中…' : '加载更早的事件')
      : null,
    props.error ? h('div', { style: styles.error }, `读取失败：${props.error}`) : null,
  )
}

/** 比例带：段宽按事件数，图例就是筛选入口。 */
function FateBar(props: {
  summary: SourceSummary
  filter?: FateKind
  onToggle: (kind: FateKind) => void
}): ReturnType<typeof h> {
  const { summary, filter } = props
  const total = Math.max(summary.received, 1)
  const counts = FATE_ORDER.map(kind => ({ kind, n: countOf(summary, kind) }))

  return h('div', { style: styles.barCard },
    h('div', { style: styles.barHead },
      h('span', null, '事件去向'),
      h('span', { style: styles.barTotal }, `${summary.received} 条事件（去重后）`)),
    h('div', { style: styles.barTrack },
      ...counts.filter(item => item.n > 0).map(item =>
        h('div', {
          key: item.kind,
          'data-source-fate': item.kind,
          title: `${FATE_LABEL[item.kind]} ${item.n} 条`,
          onClick: () => props.onToggle(item.kind),
          style: {
            width: `${(item.n / total) * 100}%`,
            background: FATE_COLOR[item.kind],
            height: '100%',
            cursor: 'pointer',
            opacity: filter && filter !== item.kind ? 0.3 : 1,
            ...(item.kind === 'direct'
              ? { backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 4px, transparent 4px 8px)' }
              : {}),
          },
        }))),
    h('div', { style: styles.legend },
      ...counts.map(item =>
        h('span', {
          key: item.kind,
          'data-fate-legend': item.n === 0 ? undefined : item.kind,
          style: {
            ...styles.legendItem,
            ...(item.n === 0 ? styles.legendOff : {}),
            ...(filter === item.kind ? { color: '#334155', fontWeight: 600 } : {}),
          },
          onClick: item.n === 0 ? undefined : () => props.onToggle(item.kind),
        },
          h('i', { style: { ...styles.swatch, background: FATE_COLOR[item.kind] } }),
          `${FATE_LABEL[item.kind]} ${item.n} 条`))),
  )
}

function EventRow(props: {
  event: SourceEvent
  onOpen: (triggerId: string) => void
  onOpenTicket: (ticketId: string) => void
}): ReturnType<typeof h> {
  const { event } = props
  const fate = event.fate
  const tickets = ticketsOf(fate)
  // 行本身可点开抽屉，但纯文字行看不出这一点：悬停给底色，正文后常驻一个「详情」标签。
  const [hover, setHover] = useState(false)

  return h('div', {
    'data-event': event.triggerId,
    'data-fate': fate.kind,
    role: 'button',
    tabIndex: 0,
    title: `${event.text ?? '(没有正文)'} · 点开看详情`,
    onClick: () => props.onOpen(event.triggerId),
    onMouseEnter: () => setHover(true),
    onMouseLeave: () => setHover(false),
    onFocus: () => setHover(true),
    onBlur: () => setHover(false),
    onKeyDown: (keyEvent: { key: string; preventDefault(): void }) => {
      if (keyEvent.key !== 'Enter' && keyEvent.key !== ' ') return
      keyEvent.preventDefault()
      props.onOpen(event.triggerId)
    },
    style: {
      ...styles.eventRow, borderLeftColor: FATE_COLOR[fate.kind],
      ...(hover ? styles.eventRowHover : {}),
    },
  },
    h('span', { style: styles.eventTime }, formatWhen(event.at)),
    h('span', { style: { ...styles.eventFate, color: fateInk(fate.kind) } }, FATE_LABEL[fate.kind]),
    h('span', { style: styles.eventText },
      h('span', { style: styles.eventLabel }, event.text ?? '(没有正文)'),
      h('button', {
        'data-event-detail': 'true',
        style: styles.detailChip,
        title: '打开这条事件的详情',
        onClick: (clickEvent: { stopPropagation(): void }) => {
          clickEvent.stopPropagation()
          props.onOpen(event.triggerId)
        },
      }, '详情'),
      ...tickets.map(ticketId =>
        h('button', {
          key: ticketId,
          'data-ticket-chip': ticketId,
          style: styles.ticketChip,
          title: `打开工单 ${ticketId}`,
          onClick: (clickEvent: { stopPropagation(): void }) => {
            clickEvent.stopPropagation()
            props.onOpenTicket(ticketId)
          },
        }, `工单 ${ticketId.slice(0, 8)}`))),
  )
}
