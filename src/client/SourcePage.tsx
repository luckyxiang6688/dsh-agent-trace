/**
 * 落地页：来源 → 事件 → 工单。
 *
 * 数据顺序就是产品顺序：先看哪个来源进了什么、每条事件去了哪，再点进工单。
 * 工单是盖在主区上的一层（不是页面切换），所以来源页始终挂载、滚动位置不丢。
 */
import { createElement as h, useCallback, useEffect, useRef, useState } from 'react'
import type { ChainSummary } from '../domain/model.ts'
import type { EventFate, SourceEvent, SourceSummary } from '../domain/source.ts'
import { fetchChains, fetchSourceEvent, fetchSourceEvents, fetchSources } from './api.ts'
import { ErrorBoundary } from './boundary.ts'
import { EventDrawer } from './EventDrawer.tsx'
import { pushEscape } from './escape.ts'
import { Rail } from './Rail.tsx'
import { readStoredRatio, writeStoredRatio } from './split.ts'
import { SourceView } from './SourceView.tsx'
import { styles } from './styles.ts'
import { TicketOverlay } from './TicketOverlay.tsx'

type FateKind = EventFate['kind']

const EVENT_PAGE = 50

export function SourcePage(): ReturnType<typeof h> {
  const [sources, setSources] = useState<readonly SourceSummary[] | undefined>()
  const [chains, setChains] = useState<readonly ChainSummary[]>([])
  const [activeSource, setActiveSource] = useState<string | undefined>()
  const [events, setEvents] = useState<readonly SourceEvent[]>([])
  const [more, setMore] = useState(false)
  const [cursor, setCursor] = useState<string | undefined>()
  const [loadingEvents, setLoadingEvents] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [selectedEventId, setSelectedEventId] = useState<string | undefined>()
  const [detail, setDetail] = useState<Awaited<ReturnType<typeof fetchSourceEvent>>>()
  const [drawerError, setDrawerError] = useState<string | undefined>()
  const [filter, setFilter] = useState<FateKind | undefined>()
  const [ticketId, setTicketId] = useState<string | undefined>()
  const [collapsed, setCollapsed] = useState(false)
  const [ratio, setRatio] = useState<number>(() => readStoredRatio())
  const [error, setError] = useState<string | undefined>()

  // 请求各自编号：切来源/切事件时，晚到的旧响应直接丢掉。
  const listSeq = useRef(0)
  const detailSeq = useRef(0)
  const chainSeq = useRef(0)

  useEffect(() => {
    void (async () => {
      const nextSources = await fetchSources()
      setSources(nextSources)
      if (nextSources === undefined) setError('来源列表读取失败')
    })()
  }, [])

  // 落地默认选第一个来源（列表按最近活跃排，所以就是最近有动静的那个）。
  useEffect(() => {
    if (activeSource) return
    const first = sources?.[0]?.source
    if (first) setActiveSource(first)
  }, [sources, activeSource])

  // 工单区跟着选中的来源走：换来源就换一批，晚到的旧响应丢弃。
  useEffect(() => {
    if (!activeSource) return
    const seq = ++chainSeq.current
    setChains([])
    void (async () => {
      const nextChains = await fetchChains(50, activeSource)
      if (seq !== chainSeq.current) return
      setChains(nextChains ?? [])
    })()
  }, [activeSource])

  useEffect(() => {
    if (!activeSource) return
    const seq = ++listSeq.current
    setLoadingEvents(true)
    // 上一来源的「加载更早」若还在飞，它已经作废；不在这里清掉的话，
    // 它走到 seq 检查就 return，按钮会永远停在「加载中」。
    setLoadingMore(false)
    setEvents([])
    setMore(false)
    setCursor(undefined)
    setError(undefined)
    void (async () => {
      const page = await fetchSourceEvents(activeSource, EVENT_PAGE)
      if (seq !== listSeq.current) return
      setLoadingEvents(false)
      if (!page) { setError('事件读取失败'); return }
      setEvents(page.items)
      setMore(page.more)
      setCursor(page.nextCursor)
    })()
  }, [activeSource])

  useEffect(() => {
    if (!activeSource || !selectedEventId) return
    const seq = ++detailSeq.current
    setDetail(undefined)
    setDrawerError(undefined)
    void (async () => {
      const data = await fetchSourceEvent(activeSource, selectedEventId)
      if (seq !== detailSeq.current) return
      if (!data) { setDrawerError('没有这条事件'); return }
      setDetail(data)
    })()
  }, [activeSource, selectedEventId])

  // 抽屉开了，Esc 先关它（栈顶）；覆盖层是更早压进去的，下一按才轮到它。
  useEffect(() => {
    if (!selectedEventId) return
    return pushEscape(() => setSelectedEventId(undefined))
  }, [selectedEventId])

  // 点抽屉外关闭；点事件行/工单小徽章不算「外面」，它们有自己的 onClick。
  useEffect(() => {
    if (!selectedEventId) return
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-drawer]')) return
      if (target.closest('[data-event]')) return
      if (target.closest('[data-ticket-chip]')) return
      setSelectedEventId(undefined)
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [selectedEventId])

  const pickSource = useCallback((source: string) => {
    setActiveSource(source)
    setSelectedEventId(undefined)
    setTicketId(undefined)
    setFilter(undefined)
  }, [])

  const pickTicket = useCallback((id: string) => {
    setSelectedEventId(undefined)
    setTicketId(id)
  }, [])

  const openEvent = useCallback((triggerId: string) => {
    setSelectedEventId(triggerId)
    setTicketId(undefined)
  }, [])

  const toggleFilter = useCallback((kind: FateKind) => {
    setFilter(previous => (previous === kind ? undefined : kind))
  }, [])

  const loadMore = useCallback(async () => {
    if (!activeSource || !cursor || loadingMore) return
    const seq = listSeq.current
    setLoadingMore(true)
    try {
      const page = await fetchSourceEvents(activeSource, EVENT_PAGE, cursor)
      if (seq !== listSeq.current) return
      if (!page) { setError('更早的事件读取失败'); return }
      setEvents(previous => [...previous, ...page.items])
      setMore(page.more)
      setCursor(page.nextCursor)
    } finally {
      // 只有仍是当前来源时才复位：切走之后按钮属于新来源，不能由旧请求改。
      if (seq === listSeq.current) setLoadingMore(false)
    }
  }, [activeSource, cursor, loadingMore])

  const summary = sources?.find(item => item.source === activeSource)

  return h('div', {
    'data-source-page': '1',
    style: { ...styles.app, ...(collapsed ? { gridTemplateColumns: '56px minmax(0,1fr)' } : {}) },
  },
    h(Rail, {
      sources: sources ?? [],
      activeSource,
      onPickSource: pickSource,
      tickets: chains,
      activeTicketId: ticketId,
      onPickTicket: pickTicket,
      ratio,
      onRatioChange: setRatio,
      onRatioCommit: (next: number) => { setRatio(next); writeStoredRatio(next) },
      collapsed,
      onToggle: () => setCollapsed(value => !value),
    }),
    h('main', { style: styles.mainPane },
      // 覆盖层打开时只隐藏、不卸载：关掉它回到原处，滚动位置还在。
      h('div', {
        'data-source-pane': '1',
        style: { ...styles.sourcePane, ...(ticketId ? styles.hidden : {}) },
      },
        h(SourceView, {
          summary,
          events,
          more,
          loading: loadingEvents || sources === undefined,
          loadingMore,
          error,
          filter,
          onToggleFilter: toggleFilter,
          onOpenEvent: openEvent,
          onOpenTicket: pickTicket,
          onLoadMore: () => void loadMore(),
        })),
      ticketId
        ? h(TicketOverlay, {
            ticketId,
            sourceLabel: summary?.label ?? summary?.source ?? activeSource,
            onClose: () => setTicketId(undefined),
          })
        : null,
      selectedEventId
        // 抽屉单独兜一层：事件详情字段形状不对时，别把整块面板（含左栏与已加载事件）一起换掉；
        // 兜底里必须留「关闭」，否则用户被卡在一条画不出来的事件上。
        ? h(ErrorBoundary, {
            key: selectedEventId,
            fallback: (error: Error) => h('aside', { 'data-boundary': 'drawer', style: styles.drawer },
              h('div', { style: styles.drawerHead },
                h('b', null, '这条事件画不出来'),
                h('button', {
                  style: styles.close,
                  onClick: () => setSelectedEventId(undefined),
                  title: '关闭',
                }, '×')),
              h('div', { style: styles.drawerBody },
                h('div', { style: styles.crashed },
                  h('div', { style: styles.crashedTitle }, '事件详情可能缺字段'),
                  h('div', { style: styles.crashedHint },
                    `${error.message.slice(0, 200)}。关掉这条，其它事件不受影响。`)))),
          }, h(EventDrawer, {
            source: activeSource ?? '',
            detail,
            error: drawerError,
            onClose: () => setSelectedEventId(undefined),
            onOpenTicket: pickTicket,
          }))
        : null,
    ),
  )
}
