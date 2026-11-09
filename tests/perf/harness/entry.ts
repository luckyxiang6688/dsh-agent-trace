/**
 * 隔离页：把真实组件挂在普通 DOM 上，供 headless Chrome 量性能与看呈现。
 *
 * 为什么不走真实实例：500 个节点的链路需要往 `.dsh-home` 里造数据（那是宿主的库），
 * 不在测试里动。这里换掉 `fetch`，喂给组件一份形状相同（或故意坏掉）的合成数据，
 * 渲染走的仍是同一份 `TicketView` / `EventDrawer` / `TicketOverlay` / `Panel` 代码。
 *
 * 用法：`index.html#scroll`、`#drawer`、`#crash`、`#crash-panel`，节点数用 `?count=500`。
 * 崩溃两种模式喂的是**形状坏掉**的响应（`spans: null` / `counts: null`），
 * 不是自己重抄一份 fallback——要测的是接线，不是文案复制品。
 */
import { createElement as h, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { EventDrawer } from '../../../src/client/EventDrawer.tsx'
import { Panel } from '../../../src/client/mount.tsx'
import { SourcePage } from '../../../src/client/SourcePage.tsx'
import { TicketOverlay } from '../../../src/client/TicketOverlay.tsx'
import { TicketView } from '../../../src/client/TicketView.tsx'
import type { Chain, Span } from '../../../src/domain/model.ts'
import type { SourceEventDetail } from '../../../src/domain/source.ts'

const params = new URLSearchParams(location.search)
const count = Math.max(1, Number(params.get('count') ?? 500) || 500)
const mode = location.hash.slice(1) || 'scroll'

const ROLES = ['source', 'router', 'executor', 'executor', 'subagent'] as const
const BASE = Date.parse('2026-11-08T10:00:00.000Z')

function bigChain(n: number): Chain {
  const spans: Span[] = Array.from({ length: n }, (_, index) => {
    const role = ROLES[index % ROLES.length]!
    return {
      id: `span-${index}`,
      role,
      kind: index % 7 === 6 ? 'event' : 'activity',
      label: `第 ${index + 1} 步`,
      startMs: index * 1200,
      endMs: index * 1200 + 900,
      ...(index % 5 === 0 ? { badge: '报告' } : {}),
    }
  })
  return {
    ticketId: 'synthetic-500',
    title: `${n} 个节点的合成链路`,
    source: 'fixture',
    stage: '执行中',
    stageTag: 'working/running',
    createdAt: new Date(BASE).toISOString(),
    spans,
  }
}

function crossSourceDetail(): SourceEventDetail {
  return {
    source: 'fixture',
    triggerId: 'tr-drawer-1',
    title: '一条来自 fixture 的事件',
    facts: [{ label: '发送者', value: 'fixture:thread-1' }],
    interpretations: [],
    notRecorded: ['这条事件没有记录当时的设置快照。'],
    relatedTickets: [
      { ticketId: 'c5faef17fff20441f4b105b70f265c13', title: '同源工单', source: 'fixture' },
      { ticketId: 'f18e5e3cc957cbeefe44851db42fedcf', title: '跨源工单', source: 'demo' },
    ],
    threads: [],
  }
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } })

const brokenSummary = { source: 'fixture', label: '夹具来源', received: 1, tickets: 0, counts: null }
const okSummary = {
  source: 'fixture', label: '夹具来源', installed: true, enabled: true,
  received: 1, tickets: 0, lastAt: '2026-11-08T10:00:00.000Z', unrecorded: 0,
  counts: { routed: 0, direct: 0, context: 0, filtered: 1, requeued: 0, handback: 0, undecided: 0 },
}

/**
 * 三种「上游形状意外」的响应，用来触发真实边界：
 * - `/sources` 的 `counts: null`：`api.ts` 只校验 `items` 是数组，随后 `SourceView` 取 `counts[kind]` 抛错 → 面板根边界；
 * - `/chains/:id` 的 `spans: null`：`TicketView` 的泳道模型遍历它抛错 → 覆盖层内边界；
 * - 事件详情的 `facts: null`：`EventDrawer` 渲染时遍历它抛错 → 抽屉自己的边界（面板其余部分必须还在）。
 */
globalThis.fetch = (async (input: RequestInfo | URL) => {
  const url = String(input)
  if (url.includes('/agent-trace/sources') && !url.includes('/events')) {
    if (mode === 'crash-panel') return json({ items: [brokenSummary] })
    if (mode === 'crash-drawer') return json({ items: [okSummary] })
    return json({ items: [] })
  }
  if (url.includes('/agent-trace/sources/fixture/events/tr-broken')) {
    return json({ detail: {
      source: 'fixture', triggerId: 'tr-broken', title: '一条事件',
      facts: null, interpretations: [], notRecorded: [], relatedTickets: [], threads: [],
    } })
  }
  if (url.includes('/agent-trace/sources/fixture/events')) {
    return json({ items: [{
      triggerId: 'tr-broken', at: '2026-11-08T10:00:00.000Z', text: '一条事件',
      fate: { kind: 'filtered', code: 'no_mention' },
    }], more: false })
  }
  if (url.includes('/agent-trace/chains?')) return json({ items: [] })
  if (url.includes('/agent-trace/chains/')) {
    const chain = bigChain(count)
    return json({ chain: url.includes('synthetic-crash') ? { ...chain, spans: null } : chain, dispositions: [] })
  }
  return json({})
}) as typeof fetch

const container = document.getElementById('root')!
const started = performance.now()
const root = createRoot(container)

if (mode === 'drawer') {
  root.render(h(EventDrawer, {
    source: 'fixture',
    detail: crossSourceDetail(),
    onClose: () => {},
    onOpenTicket: () => {},
  }))
} else if (mode === 'crash') {
  // 真的 TicketOverlay：若边界被挪到顶栏外面，「← 返回来源」就点不到了。
  // 宿主暴露一个切换工单的入口，用来验「上一张崩过之后换一张还能画」。
  const OverlayHost = (): ReturnType<typeof h> => {
    const [ticketId, setTicketId] = useState('synthetic-crash')
    ;(window as unknown as Record<string, unknown>).__switchTicket = setTicketId
    return h(TicketOverlay, {
      ticketId,
      sourceLabel: '夹具来源',
      onClose: () => { (window as unknown as Record<string, unknown>).__closed = true },
    })
  }
  root.render(h(OverlayHost))
} else if (mode === 'crash-panel') {
  // 真的 Panel：若 `mount.tsx` 忘了把 SourcePage 包进边界，这里就没有兜底。
  root.render(h(Panel))
} else if (mode === 'crash-drawer') {
  // 真的 SourcePage：点开一条详情形状坏掉的事件，抽屉边界兜住、面板其余部分还在。
  root.render(h(SourcePage))
} else {
  root.render(h(TicketView, { ticketId: 'synthetic-500' }))
}

/** 各模式的就绪信号：都是「真东西画出来了」，不是「render 调过了」。 */
const SENTINEL: Record<string, string> = {
  drawer: '[data-drawer]',
  crash: '[data-boundary=ticket]',
  'crash-panel': '[data-boundary=panel]',
  'crash-drawer': '[data-event]',
  scroll: '[data-span]',
}

const poll = (): void => {
  const found = document.querySelectorAll(SENTINEL[mode] ?? '[data-span]').length
  if (found > 0 || performance.now() - started > 8000) {
    const win = window as unknown as Record<string, unknown>
    win.__renderMs = performance.now() - started
    win.__spanCount = document.querySelectorAll('[data-span]').length
    win.__ready = true
    return
  }
  setTimeout(poll, 16)
}
poll()

/** 在时序图自己的滚动容器里来回滚到底，采 rAF 帧间隔；不可滚时明确回报，不拿空转帧率冒充。 */
;(window as unknown as Record<string, unknown>).__measureScroll = (durationMs = 3000) =>
  new Promise((resolve) => {
    // 用户滚的是 `TicketView` 里那个 `maxHeight:72vh; overflow:auto` 的 div；
    // 外层 `#root` 只是恰好也溢出，量它等于量错对象。
    const scroller = document.querySelector<HTMLElement>('[data-scroller]') ?? container
    const scrollHeight = scroller.scrollHeight
    const clientHeight = scroller.clientHeight
    if (scrollHeight - clientHeight <= 40) {
      resolve({ scrollable: false, scrollHeight, clientHeight })
      return
    }
    const frames: number[] = []
    let last = performance.now()
    let direction = 1
    const performanceStart = performance.now()
    // rAF 被暂停（后台化/失焦）时 Promise 永不 settle，evaluate 会跟着挂住整个脚本；
    // 到点用定时器兜底，并把这件事如实报成 timedOut。
    const timer = setTimeout(() => resolve({ scrollable: true, timedOut: true, scrollHeight, clientHeight, frames }), durationMs + 2000)
    const step = (): void => {
      const now = performance.now()
      frames.push(now - last)
      last = now
      scroller.scrollTop = direction > 0 ? scrollHeight : 0
      direction = -direction
      if (now - performanceStart < durationMs) requestAnimationFrame(step)
      else { clearTimeout(timer); resolve({ scrollable: true, scrollHeight, clientHeight, frames }) }
    }
    requestAnimationFrame(step)
  })
