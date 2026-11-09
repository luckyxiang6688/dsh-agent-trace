/**
 * 视图模型：把 domain 的 Chain 换算成可以直接画的坐标。
 * 纯函数，无副作用、无 IO、不 import 上游——这一层必须能被单测完整覆盖。
 */
import type { Chain, Role, Span } from '../domain/model.ts'

export interface Lane {
  /** 泳道键：来源用来源名，其余用角色名。节点靠它定位。 */
  readonly key: string
  readonly role: Role
  readonly label: string
  readonly labelEn: string
  /** 泳道在画布上的横坐标（0–1 的归一化比例，渲染层再乘宽度）。 */
  readonly x: number
}

export interface Node {
  readonly id: string
  /** 相对毫秒，编号用。 */
  readonly atMs: number
  /** 统一工序号；子代理为 undefined。 */
  step?: number
  readonly role: Role
  /** 归属泳道键。 */
  readonly laneKey: string
  readonly label: string
  /** 与标签同一行的注解（工具数徽章，或挤上来的箭头说明）。一行只放一个。 */
  badge?: string
  /** 注解带工序号时画出圈码：箭头说明被内联进块标题行时用。 */
  badgeStep?: number
  /** 注解的颜色跟着来源走：内联的箭头说明与箭头同色。 */
  badgeKind?: 'call' | 'back' | 'fast'
  /** 距画布顶部的像素。 */
  readonly top: number
  /** 块的渲染宽度：标签与内联注解按它算余量。 */
  readonly width: number
  readonly height: number
  /** 这一段是否持续了可观的时间（太短就只画一条线，不画块）。 */
  readonly solid: boolean
  /** 子代理：嵌套在执行器列内，不单独占列。 */
  readonly nested?: boolean
  /** 离散事件（提问/停止/重试/结束等）：没有持续时间，画成小节点而不是活动块。 */
  readonly event?: boolean
  /** 起点不可观测，渲染层画虚线边并标「起点未知」。 */
  readonly approxStart?: boolean
}

export interface Tick {
  readonly atMs: number
  readonly top: number
  readonly label: string
}

export interface Arrow {
  readonly id: string
  step: number
  /** 事件发生的相对毫秒，编号按它排序（不按像素）。 */
  readonly atMs: number
  readonly from: string
  readonly to: string
  readonly top: number
  readonly label: string
  readonly labelEn?: string
  /** call=向下游派发，back=回传，fast=直通 */
  readonly kind: 'call' | 'back' | 'fast'
  /** 标签压到活动块上时，改为内联在块标题行，不单独画。 */
  inline?: true
  /** 压到块上但能挪开：标签左端（或右端）改到块边上。 */
  labelX?: number
  labelAnchor?: 'start' | 'end'
  /** 压到块上又无处置：保留独立标签，渲染层加白色描边保证可读。 */
  halo?: true
}

export interface Notice {
  readonly id: string
  readonly laneKey: string
  readonly top: number
  readonly label: string
}

export interface Band {
  readonly id: string
  readonly laneKey: string
  readonly top: number
  readonly height: number
  readonly label: string
}

/** 状态背景带：只铺执行器列，画在活动块**下面**，露出块与块之间的空档。 */
export interface StateBand {
  readonly id: string
  readonly laneKey: string
  /** 稳定键：person/review、working/queued、idle、ended 等。 */
  readonly tag: string
  /** 大分类，客户端据此选底色。 */
  readonly group: 'person' | 'working' | 'idle' | 'ended'
  readonly label: string
  readonly top: number
  readonly height: number
  /** 起点不是落库时刻（提问时间只能反推），渲染层画虚线边。 */
  readonly startsApprox?: boolean
  readonly reason?: string
  /**
   * 标签的像素坐标。放在色块右侧的留白里，避开块标题；
   * `undefined` 表示这一列右边放不下，不画字（色块仍可点，悬停有 title）。
   */
  readonly labelX?: number
  readonly labelY?: number
  readonly labelAnchor?: 'start' | 'end'
}

/** 报告六态 → 箭头标签；未知值原样透传。 */
const REPORT_LABEL: Readonly<Record<string, string>> = {
  progress: '进行中',
  waiting: '等待触发',
  ready: '就绪',
  blocked: '受阻',
  failed: '失败',
  dropped: '无需处理',
}

/** 画布逻辑宽度：坐标按它换算，客户端与 presenter 必须用同一个值。 */
export const CANVAS_WIDTH = 1000
/** 状态背景带与活动块的宽度：标签要靠这两个值算留白。 */
export const STATE_BAND_WIDTH = 132
export const NODE_WIDTH = 130
/** 离散事件是单行小节点；子代理是嵌在执行器块里的小卡——两者都不铺满标准块宽。 */
export const EVENT_WIDTH = 108
export const SUBAGENT_WIDTH = 86
/** 自适应目标：链路内容区（不含顶部留白与底部余量）大致这么高。 */
export const TARGET_HEIGHT_PX = 600
/** 短链路的密度上限：再短也不放大，观感与固定密度时代一致。 */
export const MAX_PX_PER_SECOND = 34
/** 同泳道卡片挤不下时允许长高，但有硬上限：否则长工单又会长成几万像素。 */
export const MAX_CANVAS_PX = 1200

export interface SwimlaneModel {
  readonly durationMs: number
  readonly heightPx: number
  readonly canvasWidth: number
  readonly lanes: readonly Lane[]
  readonly nodes: readonly Node[]
  readonly ticks: readonly Tick[]
  readonly arrows: readonly Arrow[]
  readonly notices: readonly Notice[]
  readonly bands: readonly Band[]
  readonly stateBands: readonly StateBand[]
}

export interface PresentOptions {
  /** 每秒对应多少像素。省略时按 `targetHeightPx` 自动缩放。 */
  readonly pxPerSecond?: number
  /** 自动缩放时希望链路占用的高度；长链路会自动压扁，短链路保持基准密度。 */
  readonly targetHeightPx?: number
  /** 画布顶部留白，给刻度与泳道名。 */
  readonly topPadding?: number
  /** 节点最小高度：保证两行文字放得下。 */
  readonly minNodeHeight?: number
  /** 额外的来源列（多来源场景）。 */
  readonly extraSources?: readonly string[]
  /** 这条链路上的事件（用于画触发与直通箭头）。 */
  readonly events?: readonly { at?: string; path?: string; text?: string }[]
  /** 画布逻辑宽度；默认 `CANVAS_WIDTH`。 */
  readonly canvasWidth?: number
}

/**
 * 来源显示名一律取数据里的 source id。
 * 不写死中文名：换一个来源（飞书/GitHub/自定义 Source）时视图不需要改。
 * 宿主若提供 SourceKind.title，由 adapter 决定是否替换成 title——presenter 不猜。
 */

/**
 * 按实际参与者算列：来源可以有多个，主控与执行器各一个。
 * 两条来源 → 四列；一条来源 → 三列。位置均分，首尾留边。
 */
export function lanesFor(chain: Chain, extraSources: readonly string[] = []): readonly Lane[] {
  const sources = [...new Set([...(chain.source ? [chain.source] : []), ...extraSources])]
  const keys = [
    ...(sources.length > 0 ? sources : ['source']),
    'router',
    'executor',
  ]
  const total = keys.length
  return keys.map((key, index) => {
    const x = (index + 1) / (total + 1)
    if (key === 'router') return { key, role: 'router' as Role, label: '主控', labelEn: 'Router', x }
    if (key === 'executor') return { key, role: 'executor' as Role, label: '执行器', labelEn: 'Worker', x }
    if (key === 'source') return { key, role: 'source' as Role, label: '来源', labelEn: 'Source', x }
    return { key, role: 'source' as Role, label: key, labelEn: key, x }
  })
}

/**
 * 自适应缩放：短链路用基准密度（34px/s）保证可读；
 * 长链路压到目标高度内，否则一次 811 分钟的链路会变成一百六十万像素。
 * `minPxPerSecond` 是同泳道卡片防重叠所需的下界，由 `overlapFloor` 给出。
 *
 * 34px/秒只压 `fitted`（观感目标），不压下界——短链路两张卡只隔 10ms 时，
 * 不重叠需要 41.6px/秒，把它截回 34 就会出现「卡片互相压住」。画布高度另有
 * `MAX_CANVAS_PX` 硬上限兜底，所以这里放开是安全的。
 */
export function scaleFor(durationMs: number, targetHeightPx: number, minPxPerSecond = 0): number {
  if (durationMs <= 0) return MAX_PX_PER_SECOND
  const fitted = (targetHeightPx / durationMs) * 1000
  return Math.max(Math.min(fitted, MAX_PX_PER_SECOND), minPxPerSecond)
}

/**
 * 同泳道防重叠下界（px/秒）。
 *
 * A、B 的顶边相距 `(dA + gapMs) * scale`，A 的高度是 `max(dA*scale, minNodeHeight)`。
 * 不重叠的条件是 `(dA+gapMs)*scale >= max(dA*scale, minNodeHeight)`；`gapPx` 只对
 * **被最小高撑开**的卡片追加——真实工单里相邻派工常只隔几十毫秒，如果「任何情况都留 8px」，
 * 335 秒的链路会被抬到 89px/秒、直接顶到 1200px，与「画布固定大小」冲突。
 *
 * 是否被撑开取决于比例，所以先看**参考比例**（present 传进来的 fit）：参考比例下已按时长
 * 画开的对，不需要任何下界；被撑开且间距不足 `minNodeHeight+gapPx` 的对，才抬到
 * `(minNodeHeight+gapPx)/(dA+gapMs)`。
 */
export function overlapFloor(
  chain: Chain,
  minNodeHeight = 42,
  gapPx = 8,
  referencePxPerSecond = MAX_PX_PER_SECOND,
): number {
  const reference = referencePxPerSecond / 1000
  const byLane = new Map<string, Span[]>()
  for (const span of chain.spans) {
    // 离散事件是 14px 小点、子代理是嵌在父块里的小卡：都不参与防重叠计算。
    // 子代理必须真的跳过——它常跨过下一次派工的起点，混进队列会把真正的相邻对挡在
    // 「startMs 排序后相邻」之外（gap<0 被跳过），于是两张派工卡反而压在一起。
    if (span.kind !== 'activity' || span.role === 'subagent') continue
    const key = span.role
    const list = byLane.get(key) ?? []
    list.push(span)
    byLane.set(key, list)
  }
  let worst = 0
  for (const list of byLane.values()) {
    const spans = list.slice().sort((left, right) => left.startMs - right.startMs)
    for (let index = 0; index < spans.length - 1; index += 1) {
      const a = spans[index]!
      const b = spans[index + 1]!
      const gapMs = b.startMs - a.endMs
      const dA = Math.max(a.endMs - a.startMs, 0)
      if (gapMs <= 0) continue
      // 参考比例下 A 已按时长画开（没被最小高撑大）⇒ 两块天然分得开，不需要下界。
      if (dA * reference >= minNodeHeight) continue
      // 空档够长时，撑开的卡片还能再留 gapPx；空档太短（dA*gapPx >= minH*gapMs）就只保证不重叠，
      // 否则下界会跳到 gapPx/gapMs，把长链路重新撑高。
      const withGap = dA * gapPx < minNodeHeight * gapMs
      const required = minNodeHeight + (withGap ? gapPx : 0)
      // 参考比例下已经满足 ⇒ 抬它只会让画布变长。
      if ((dA + gapMs) * reference >= required) continue
      worst = Math.max(worst, (required / (dA + gapMs)) * 1000)
    }
  }
  return worst
}

/** 链路的绝对零点：最早一段、最早触发、最早关键时点、最早状态带的最小值。全部坐标都相对它。 */
export function originOf(chain: Chain): number {
  const base = Date.parse(chain.createdAt)
  const offsets = [
    ...chain.spans.map(span => span.startMs),
    // 状态带从 createdAt（偏移 0）起画；若它早于所有 span/origin，不纳入零点就会画成负坐标被裁掉。
    ...(chain.stateBands ?? []).map(band => band.startMs),
    ...(chain.origins ?? []).map(origin => origin.at ? Date.parse(origin.at) - base : Number.NaN),
    ...(chain.marks?.replies ?? []).map(at => at - base),
    ...(chain.marks?.ackMs === undefined ? [] : [chain.marks.ackMs - base]),
    ...(chain.marks?.replyMs === undefined ? [] : [chain.marks.replyMs - base]),
  ].filter(value => Number.isFinite(value))
  return offsets.length === 0 ? 0 : Math.min(...offsets)
}

/** 耗时：从零点到最晚结束。触发与关键时点都算，避免箭头画到画布外。 */
export function durationOf(chain: Chain): number {
  const base = Date.parse(chain.createdAt)
  const offsets = [
    ...chain.spans.map(span => span.endMs),
    ...(chain.origins ?? []).map(origin => origin.at ? Date.parse(origin.at) - base : Number.NaN),
    ...(chain.marks?.replies ?? []).map(at => at - base),
    ...(chain.marks?.ackMs === undefined ? [] : [chain.marks.ackMs - base]),
    ...(chain.marks?.replyMs === undefined ? [] : [chain.marks.replyMs - base]),
  ].filter(value => Number.isFinite(value))
  if (offsets.length === 0) return 0
  return Math.max(Math.max(...offsets) - originOf(chain), 0)
}

/**
 * 把毫秒格式化成可读时长：秒 → 分秒 → 时 → 天。
 * 长工单不可能再用 `714m6s` 这种读不出量级的写法。
 */
export function formatDuration(ms: number): string {
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 0
  // 先按秒取整再判档：59.6s 该读作 1m，不是 60s。
  const totalSeconds = Math.round(safe / 1000)
  if (totalSeconds < 60) return `${totalSeconds}s`
  const totalMinutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  if (totalMinutes < 60) return seconds === 0 ? `${totalMinutes}m` : `${totalMinutes}m${seconds}s`
  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) return minutes === 0 ? `${totalHours}h` : `${totalHours}h${minutes}m`
  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours === 0 ? `${days}d` : `${days}d${hours}h`
}

/**
 * 生成刻度：最多 `maxTicks` 条，步长取「好看的整数」，
 * 避免出现 7s、14s、21s 这种读不出来的刻度。
 * 阶梯一直排到一天，长工单不会被压在 2 分钟一格里画出几百条线。
 */
export function ticksFor(durationMs: number, maxTicks = 8): number[] {
  if (durationMs <= 0) return [0]
  const rough = durationMs / Math.max(maxTicks, 1)
  const steps = [
    100, 250, 500,
    1_000, 2_000, 5_000, 10_000, 15_000, 30_000,
    60_000, 120_000, 300_000, 600_000, 900_000, 1_800_000,
    3_600_000, 7_200_000, 10_800_000, 21_600_000, 43_200_000, 86_400_000,
  ]
  // 超出阶梯（一天以上）：按整天取阶，避免落到最后一格后每 24h 一条也不算少。
  const step = steps.find(candidate => candidate >= rough)
    ?? Math.ceil(rough / 86_400_000) * 86_400_000
  const out: number[] = []
  for (let at = 0; at <= durationMs; at += step) out.push(at)
  return out
}

/**
 * 时间跨度（毫秒）：只依赖时间戳，与 scale 无关，所以可以先算它再定 scale。
 * 必须和 `buildArrows`/`buildNotices`/`buildStateBands` 的取时刻口径一致；
 * 漏掉状态带会让超出最后一段活动的带被裁掉。
 */
function extentOf(
  chain: Chain,
  events: readonly { at?: string; path?: string }[],
  origin: number,
): number {
  const base = Date.parse(chain.createdAt)
  const at = (value: string | undefined): number =>
    value ? Date.parse(value) - base - origin : Number.NaN
  const offsets = [
    // durationOf 相对 originOf 计；其余项相对 origin 计。二者相差 originOf-origin，必须补齐，
    // 否则「事件早于第一段活动」时跨度被少算，fit 与硬上限都会失效。
    durationOf(chain) + (originOf(chain) - origin),
    ...(chain.origins ?? []).map(entry => at(entry.at)),
    ...(chain.marks?.replies ?? []).map(ms => ms - base - origin),
    chain.marks?.ackMs === undefined ? Number.NaN : chain.marks.ackMs - base - origin,
    chain.marks?.replyMs === undefined ? Number.NaN : chain.marks.replyMs - base - origin,
    ...(chain.stateBands ?? []).map(band => band.endMs - origin),
    ...events.map(event => at(event.at)),
  ].filter(value => Number.isFinite(value))
  return Math.max(0, ...offsets)
}

/**
 * 链路摘要：把角色与耗时串成一句话。
 * 超长时按段省略中段，保留头两段与末段（起点、第一次判断、终点）。
 */
export function chainSummary(chain: Chain, maxSegments = 4): string {
  const labels: string[] = [chain.source ?? '来源']
  /** 每段累计耗时（毫秒）。合并同角色时要**累加**，否则只显示第一段的耗时。 */
  const spent: number[] = [0]
  const render = (label: string, ms: number) => (ms >= 1000 ? `${label} ·${formatDuration(ms)}` : label)

  for (const span of chain.spans) {
    const ms = Math.max(span.endMs - span.startMs, 0)
    const label = span.role === 'router' ? '主控' : span.role === 'executor' ? '执行器' : '子代理'
    // 相邻同角色合并，避免"执行器 ·3s → 执行器 ·2s"这种噪音
    if (labels[labels.length - 1] === label) {
      spent[spent.length - 1]! += ms
    } else {
      labels.push(label)
      spent.push(ms)
    }
  }

  labels.push(labels[0]!)
  spent.push(0)
  const segments = labels.map((label, index) => render(label, spent[index]!))
  if (segments.length <= maxSegments) return segments.join(' → ')
  return [...segments.slice(0, 2), '…', segments[segments.length - 1]].join(' → ')
}

/** Chain → 可绘制的模型。 */
export function present(chain: Chain, options: PresentOptions = {}): SwimlaneModel {
  const topPadding = options.topPadding ?? 48
  const minNodeHeight = options.minNodeHeight ?? 42
  const targetHeightPx = options.targetHeightPx ?? TARGET_HEIGHT_PX

  // 事件（直通/知会）也可能早于第一段活动，零点要把它们算进来，否则顶到画布外
  const baseOfChain = Date.parse(chain.createdAt)
  const events = options.events ?? []
  // 只有会在画布上落笔的事件才参与时间范围：filtered 事件不画箭头（它的位置在比例带），
  // 把它算进来会凭空拉长轴，把真实活动压成一条线。
  const timelineEvents = events.filter(event => event.path === 'direct' || event.path === 'context')
  const eventOffsets = timelineEvents
    .map(event => event.at ? Date.parse(event.at) - baseOfChain : Number.NaN)
    .filter(value => Number.isFinite(value))
  const origin = eventOffsets.length > 0
    ? Math.min(originOf(chain), ...eventOffsets)
    : originOf(chain)

  // 第一趟：时间跨度只依赖时间戳，与 scale 无关；不先算出来就没法定 scale。
  const durationMs = extentOf(chain, timelineEvents, origin)
  const durationSec = durationMs / 1000
  // 第二趟：定 scale。fit 让长链路压进目标高度；同泳道挤不下时才长高，
  // 但长高有硬上限（MAX_CANVAS_PX），否则「密集决策 + 超长工单」又会长成几万像素。
  // 参考比例取「按目标高度铺满」：只有在这个比例下仍被最小高撑开、且挤在一起的卡片才需要抬高画布。
  const fitPxPerSecond = scaleFor(durationMs, targetHeightPx)
  const overlapPxPerSecond = overlapFloor(chain, minNodeHeight, 8, fitPxPerSecond)
  // 封顶要把「末端元素的最小高」留出来：最后一段活动常常在结束前才起画，
  // 按时间算刚好 1128px，再给它 42px 最小高就顶出 1200 了。
  const capRoom = Math.max(MAX_CANVAS_PX - topPadding - 24 - minNodeHeight, 1)
  const capPxPerSecond = durationSec > 0 ? capRoom / durationSec : MAX_PX_PER_SECOND
  const pxPerSecond = options.pxPerSecond
    ?? scaleFor(durationMs, targetHeightPx, Math.min(overlapPxPerSecond, capPxPerSecond))
  const scale = pxPerSecond / 1000

  const canvasWidth = options.canvasWidth ?? CANVAS_WIDTH
  const lanes = lanesFor(chain, options.extraSources ?? [])
  const nodes: Node[] = chain.spans.map(span => {
    const top = topPadding + (span.startMs - origin) * scale
    const rawHeight = (span.endMs - span.startMs) * scale
    const isEvent = span.kind === 'event'
    return {
      id: span.id,
      atMs: span.startMs - origin,
      role: span.role,
      laneKey: laneKeyFor(span.role, lanes),
      label: span.label,
      ...(span.badge ? { badge: span.badge } : {}),
      ...(span.role === 'subagent' ? { nested: true } : {}),
      ...(isEvent ? { event: true } : {}),
      ...(span.startsApprox ? { approxStart: true } : {}),
      top,
      width: isEvent ? EVENT_WIDTH : span.role === 'subagent' ? SUBAGENT_WIDTH : NODE_WIDTH,
      // 离散事件没有持续时间：固定小高度，不撑成块。
      height: isEvent ? 14 : Math.max(rawHeight, minNodeHeight),
      solid: isEvent || rawHeight >= 12,
    }
  })
  // 时间戳解析失败时 top 会是 NaN，画出来 viewBox 直接非法；宁可少画一条，也不产 NaN 坐标。
  const arrows = buildArrows(chain, lanes, origin, topPadding, scale, events)
    .filter(arrow => Number.isFinite(arrow.top))
  const notices = buildNotices(lanes, origin, topPadding, scale, events, chain.createdAt)
    .filter(notice => Number.isFinite(notice.top))
  attachSteps(nodes, arrows)
  placeLabels(nodes, arrows, lanes, canvasWidth)
  const stateBands = buildStateBands(chain, lanes, origin, topPadding, scale, canvasWidth)
  // 执行器列一旦铺了状态带，就不再叠「执行器空闲」斜纹：两种底色讲同一件事，叠在一起会互相打架。
  const bands = buildBands(nodes, arrows, lanes, topPadding, durationMs * scale)
    .filter(band => !(stateBands.length > 0 && band.laneKey === executorLaneKey(lanes)))

  const ticks: Tick[] = ticksFor(durationMs).map(atMs => ({
    atMs,
    top: topPadding + atMs * scale,
    label: formatDuration(atMs),
  }))

  // 高度按**元素底边**算：压缩后一次 2ms 的活动块也有 42px 最小高，
  // 只按 durationMs*scale 算会把它裁掉。状态带也可能伸到最后一段活动之后。
  const contentBottom = Math.max(
    durationMs * scale,
    ...nodes.map(node => (node.top - topPadding) + node.height),
    ...arrows.map(arrow => (arrow.top - topPadding) + 12),
    ...notices.map(notice => (notice.top - topPadding) + 12),
    ...stateBands.map(band => (band.top - topPadding) + band.height),
    0,
  )

  return {
    durationMs,
    heightPx: topPadding + contentBottom + 24,
    canvasWidth,
    lanes,
    nodes,
    ticks,
    arrows,
    notices,
    bands,
    stateBands,
  }
}

/** 执行器列键：状态带只铺这一列。 */
function executorLaneKey(lanes: readonly Lane[]): string | undefined {
  return lanes.find(lane => lane.role === 'executor')?.key
}

/** 状态键 → 大分类：客户端按分类选底色，不解析中文。 */
function groupOfTag(tag: string): StateBand['group'] {
  if (tag.startsWith('person/')) return 'person'
  if (tag === 'idle') return 'idle'
  if (tag === 'ended') return 'ended'
  return 'working'
}

function buildStateBands(
  chain: Chain,
  lanes: readonly Lane[],
  origin: number,
  topPadding: number,
  scale: number,
  canvasWidth: number,
): StateBand[] {
  const laneKey = executorLaneKey(lanes)
  const input = chain.stateBands ?? []
  if (!laneKey || input.length === 0) return []
  const laneIndex = lanes.findIndex(lane => lane.key === laneKey)
  return input.map(band => {
    const top = topPadding + (band.startMs - origin) * scale
    const height = Math.max((band.endMs - band.startMs) * scale, 0)
    return {
      id: band.id,
      laneKey,
      tag: band.tag,
      group: groupOfTag(band.tag),
      label: band.label,
      top,
      height,
      ...(band.startsApprox ? { startsApprox: true } : {}),
      ...(band.reason ? { reason: band.reason } : {}),
      // 太薄的带放不下一行字，不画；否则放到色块右侧的留白里。
      // 阈值为 14px：9.5px 字只需一行，34px 是固定密度时代的旧值，压缩后会让标签全消失。
      ...(height > 14
        ? bandLabelPlacement(lanes[laneIndex]!, laneIndex, lanes, top, height, band.startsApprox, band.label, canvasWidth)
        : {}),
    }
  })
}

/**
 * 状态带标签的位置：色块右缘之外、下一列节点左缘之内。
 * 执行器永远是最后一列（`lanesFor`），所以右侧留白最宽；
 * 留白放不下就不画字，避免再压到块标题上（本次要修的缺陷）。
 */
function bandLabelPlacement(
  lane: Lane,
  index: number,
  lanes: readonly Lane[],
  top: number,
  height: number,
  startsApprox: boolean | undefined,
  label: string,
  canvasWidth: number,
): Pick<StateBand, 'labelX' | 'labelY' | 'labelAnchor'> {
  const center = lane.x * canvasWidth
  const rectRight = center + STATE_BAND_WIDTH / 2
  const next = lanes[index + 1]
  // 下一列的块左缘；执行器是最后一列时退到画布右留白。
  const boundary = next ? next.x * canvasWidth - NODE_WIDTH / 2 : canvasWidth - 40
  const room = boundary - rectRight - 6
  // 9.5px 字号，按 10px/字保守估宽度，不依赖 DOM 测量。
  const needed = Math.max(48, label.length * 10)
  if (room < needed) return {}
  return {
    labelX: rectRight + 6,
    // 起点不可观测时顶部有虚线边，往下让一格；但阈值降到 14px 后薄带放不下 26px 的让步，
    // 基线必须夹在带内（9.5px 字：上留 3px、下留 3px），否则字会掉进下一条带。
    labelY: top + Math.min(startsApprox ? 26 : 13, Math.max(height - 3, 8)),
    labelAnchor: 'start',
  }
}

/** 箭头：触发 → 派工 → 报告 → 回复，以及直通。时间取域内数据，不猜。 */
function buildArrows(
  chain: Chain,
  lanes: readonly Lane[],
  origin: number,
  topPadding: number,
  scale: number,
  events: readonly { at?: string; path?: string }[],
): Arrow[] {
  const sourceKey = lanes[0]!.key
  const routerKey = lanes.find(lane => lane.role === 'router')?.key ?? sourceKey
  const executorKey = lanes.find(lane => lane.role === 'executor')?.key ?? routerKey
  const base = Date.parse(chain.createdAt)
  const out: Arrow[] = []

  const baseOfChain = Date.parse(chain.createdAt)
  const markTop = (ms: number | undefined): number | undefined =>
    ms === undefined ? undefined : topPadding + (ms - baseOfChain - origin) * scale

  const first = chain.spans.find(span => span.role === 'router')

  // 事件箭头：batch 有几条触发就画几支，不合并；时刻取 trigger.at（不是评估开始）。
  const origins = chain.origins ?? []
  if (origins.length > 0) {
    origins.forEach((entry, index) => {
      const at = entry.at ? Date.parse(entry.at) : Number.NaN
      const atMs = Number.isFinite(at) ? at - baseOfChain - origin : (first?.startMs ?? origin) - origin
      out.push({
        id: index === 0 ? 'arrow-trigger' : `arrow-trigger-${index}`,
        step: 0, atMs, from: sourceKey, to: routerKey,
        top: topPadding + atMs * scale,
        label: index === 0 ? '事件' : `事件 #${index + 1}`,
        labelEn: 'Trigger', kind: 'call',
      })
    })
  } else if (first) {
    out.push({
      id: 'arrow-trigger', step: 0, atMs: first.startMs - origin, from: sourceKey, to: routerKey,
      top: topPadding + (first.startMs - origin) * scale,
      label: '事件', labelEn: 'Trigger', kind: 'call',
    })
  }

  // 来源没有回复通道（`ticket.channels` 为空）时，不画「确认收到 / 回复」：
  // 这两件事这个来源做不到，画出来就是假的。
  const canReply = chain.canReply !== false

  if (first && canReply) {
    // 确认收到只在日志里真的出现过 `orchestrator_ack` 时才画；
    // 按块末端估算等于画一件没发生的事。
    const ackAt = markTop(chain.marks?.ackMs)
    if (ackAt !== undefined) {
      out.push({
        id: 'arrow-ack', step: 0,
        atMs: chain.marks!.ackMs! - baseOfChain - origin,
        from: routerKey, to: sourceKey,
        top: ackAt,
        label: '确认收到', labelEn: 'Acknowledge', kind: 'back',
      })
    }
  }

  // 直通：来源直接投递到执行器，不经主控。context-only 走同一条线，但要说明「不授权」。
  for (const [index, event] of events.entries()) {
    if ((event.path !== 'direct' && event.path !== 'context') || !event.at) continue
    const at = Date.parse(event.at)
    if (!Number.isFinite(at)) continue
    const isContext = event.path === 'context'
    out.push({
      id: `arrow-fast-${index}`, step: 0, atMs: at - base - origin, from: sourceKey, to: executorKey,
      top: topPadding + (at - base - origin) * scale,
      label: isContext ? '仅上下文' : '订阅直通',
      labelEn: isContext ? 'Context only' : 'Fast path', kind: 'fast',
    })
  }

  // 只有派工活动块才有「派工 / 报告」两支箭头；离散事件不是一次派工。
  const assignments = chain.spans.filter(item => item.role === 'executor' && item.kind === 'activity')
  for (const [index, span] of assignments.entries()) {
    out.push({
      id: `arrow-dispatch-${span.id}`, step: 0, atMs: span.startMs - origin, from: routerKey, to: executorKey,
      top: topPadding + (span.startMs - origin) * scale - 6,
      label: `派工 #${index + 1}`, labelEn: 'Assignment', kind: 'call',
    })
    // 没报告就不画：这条线上没有发生过「执行器 → 主控」的回报，画一支点进去是空的箭头等于凭空造一个环节。
    if (span.reportState) {
      out.push({
        id: `arrow-report-${span.id}`, step: 0, atMs: span.endMs - origin, from: executorKey, to: routerKey,
        top: topPadding + (span.endMs - origin) * scale + 6,
        label: `报告：${REPORT_LABEL[span.reportState] ?? span.reportState}`,
        labelEn: 'Report', kind: 'back',
      })
    }
    // 回复逐派工画：第 i 条派工对应第 i 条 `orchestrator_reply`（按调用顺序）。
    const replyMs = canReply
      ? chain.marks?.replies?.[index] ?? (index === 0 ? chain.marks?.replyMs : undefined)
      : undefined
    const replyAt = markTop(replyMs)
    if (replyAt !== undefined) {
      out.push({
        id: `arrow-reply-${index}`, step: 0,
        atMs: replyMs! - baseOfChain - origin,
        from: routerKey, to: sourceKey,
        top: replyAt,
        label: '回复', labelEn: 'Reply', kind: 'back',
      })
    }
  }
  return out
}

/**
 * 按时间给块与箭头统一编号。
 * 同一时刻用语义顺序兜底：事件 → 评估 → 派工箭头 → 执行块 → 报告 → 回复。
 * 纯按像素排会让"派工"跑到"事件"前面（派工箭头比事件线高 6px）。
 */
const RANK: Readonly<Record<string, number>> = {
  'arrow-trigger': 0,
  'arrow-ack': 1,
  'node-router': 2,
  'arrow-dispatch': 3,
  /** 派工箭头先于执行块：先"派过去"，才有"在干活"这一段。 */
  'node-executor': 4,
  'arrow-fast': 4.5,
  'arrow-report': 5,
  'arrow-reply': 6,
}

function rankOf(node: Node | undefined, arrow: Arrow | undefined): number {
  if (node) {
    if (node.event) {
      // 离散事件按语义插在相邻环节之间：重试在派工前，提问紧接报告，收尾最后。
      if (node.id.startsWith('event-retry')) return RANK['arrow-dispatch']! - 0.1
      if (node.id.startsWith('event-attention')) return RANK['arrow-report']! + 0.2
      if (node.id.startsWith('event-ended')) return RANK['arrow-reply']! + 0.5
      if (node.role === 'router') return RANK['node-router']! + 0.1
      return RANK['node-executor']! + 0.1
    }
    if (node.role === 'router') return RANK['node-router']!
    if (node.role === 'executor') return RANK['node-executor']!
    return RANK['node-executor']! + 0.2
  }
  if (!arrow) return 9
  if (arrow.id.startsWith('arrow-dispatch')) return RANK['arrow-dispatch']!
  if (arrow.id.startsWith('arrow-fast')) return RANK['arrow-fast']!
  if (arrow.id.startsWith('arrow-report')) return RANK['arrow-report']!
  if (arrow.id.startsWith('arrow-reply')) return RANK['arrow-reply']!
  if (arrow.id.startsWith('arrow-ack')) return RANK['arrow-ack']!
  return RANK['arrow-trigger']!
}

function attachSteps(nodes: Node[], arrows: Arrow[]): void {
  const entries: { at: number; rank: number; assign: (step: number) => void }[] = [
    ...nodes.filter(node => !node.nested).map(node => ({
      at: node.atMs, rank: rankOf(node, undefined), assign: (step: number) => { node.step = step },
    })),
    ...arrows.map(arrow => ({
      at: arrow.atMs, rank: rankOf(undefined, arrow), assign: (step: number) => { arrow.step = step },
    })),
  ]
  entries
    .sort((left, right) => left.at - right.at || left.rank - right.rank)
    .forEach((entry, index) => entry.assign(index + 1))
}

/** 字号与宽度的保守估算：CJK 按 1 倍高、西文按 0.55 倍。不依赖 DOM 测量。 */
function estimateWidth(text: string, fontSize: number): number {
  let units = 0
  for (const char of text) units += /[\u2e80-\u9fff\uff00-\uffef]/.test(char) ? 1 : 0.55
  return units * fontSize
}

/** 块标题行的可用宽度：左边让出圈码/缩进，右边留 6px 余量。 */
function titleRoom(node: Node): number {
  const indent = node.nested ? 10 : node.event ? 24 : 28
  return node.width - indent - 6
}

/**
 * 箭头标签实际占的宽度：圈码 + 空格 + 中文 + 英文副标。
 * 渲染层画的是 `⑤ 订阅直通 Fast path`，只按中文估会系统性少算一截。
 */
function arrowLabelWidth(arrow: Arrow): number {
  const circle = arrow.step === undefined ? 0 : 10 + estimateWidth(' ', 10)
  const english = arrow.labelEn ? estimateWidth(` ${arrow.labelEn}`, 7.5) : 0
  return circle + estimateWidth(arrow.label, 10) + english
}

/** 块顶上「起点未知」那行小字：块右缘起，宽 4 个 CJK 字。 */
const APPROX_NOTE_TEXT = '起点未知'

/**
 * 箭头标签压在活动块上时的落点。
 *
 * 真实形态：直通箭头的落点在主控列，而主控列这一段正是「评估」块——
 * 标签会直接盖住块标题。三条退路，按顺序试：
 *   1. 内联进块标题行（`② 评估 ⑤ 准入放行`），前提是这一行还放得下、且不挤掉已有徽章；
 *   2. 挪到块的右侧/左侧，仍在箭头同一条线上；
 *   3. 留在原位加白色描边——最后兜底，笔画压着块也不糊成一片。
 */
function placeLabels(
  nodes: readonly Node[],
  arrows: readonly Arrow[],
  lanes: readonly Lane[],
  canvasWidth: number,
): void {
  // 只有活动块能挂注解：离散事件只有 14px 高，子代理是父块里的 20px 小卡。
  const hosts = nodes
    .filter(node => !node.nested && !node.event)
    .map(node => {
      const lane = lanes.find(item => item.key === node.laneKey)
      const center = (lane?.x ?? 0) * canvasWidth
      return { node, left: center - node.width / 2, right: center + node.width / 2 }
    })

  // 已被挪到块外的标签：同一块上压着多条箭头时，第二块不能挪到第一块头上。
  const placed: { left: number; right: number; top: number; bottom: number }[] = []

  for (const arrow of arrows) {
    if (!Number.isFinite(arrow.top)) continue
    const from = lanes.find(lane => lane.key === arrow.from)
    const to = lanes.find(lane => lane.key === arrow.to)
    if (!from || !to) continue
    const mid = ((from.x + to.x) / 2) * canvasWidth
    // 标签基线在 top-6、10px 字：占 top-16 … top-4 这一条。
    const width = arrowLabelWidth(arrow)
    const box = { left: mid - width / 2, right: mid + width / 2, top: arrow.top - 16, bottom: arrow.top - 4 }
    // 取纵向距离最近的那一块：标签中心落在块内时就是它。
    const hit = hosts
      .map(host => ({
        host,
        overlap: Math.min(host.node.top + host.node.height, box.bottom) - Math.max(host.node.top, box.top),
      }))
      .filter(entry => entry.overlap > 0 && box.right > entry.host.left && box.left < entry.host.right)
      .sort((left, right) => right.overlap - left.overlap)[0]
    if (!hit) continue

    const node = hit.host.node
    const inlineCircle = arrow.step === undefined ? 0 : 7.5 + estimateWidth(' ', 7.5)
    const fits = inlineCircle + estimateWidth(arrow.label, 7.5) + 4 + estimateWidth(node.label, 11) <= titleRoom(node)
    // 两块讲同一件事（评估块徽章「准入放行」与直通箭头标签）时合并成一条，不重复。
    const redundant = node.badge === arrow.label
    const free = node.badge === undefined || redundant
    if (fits && free && node.badgeStep === undefined) {
      node.badge = arrow.label
      node.badgeStep = arrow.step
      node.badgeKind = arrow.kind
      arrow.inline = true
      continue
    }

    // 挪到块外：横向只让出标签自己的宽度，纵向保持在箭头这条线上。
    // 块顶那行「起点未知」也在块右缘外，同高时得把标签再往右让开它。
    const noteClash = node.approxStart === true && box.bottom > node.top && box.top < node.top + 12
    const noteRoom = noteClash ? estimateWidth(APPROX_NOTE_TEXT, 8.5) + 6 : 0
    const beside = [
      { x: hit.host.right + 6 + noteRoom, anchor: 'start' as const },
      { x: hit.host.left - 6, anchor: 'end' as const },
    ].find(candidate => {
      const left = candidate.anchor === 'start' ? candidate.x : candidate.x - width
      const right = left + width
      const clearsHost = !hosts.some(host =>
        right > host.left && left < host.right
        && box.bottom > host.node.top && box.top < host.node.top + host.node.height)
      const clearsLabels = !placed.some(other =>
        right > other.left && left < other.right && box.bottom > other.top && box.top < other.bottom)
      return clearsHost && clearsLabels
    })
    if (beside) {
      arrow.labelX = beside.x
      arrow.labelAnchor = beside.anchor
      const left = beside.anchor === 'start' ? beside.x : beside.x - width
      placed.push({ left, right: left + width, top: box.top, bottom: box.bottom })
      continue
    }
    arrow.halo = true
  }
}

/** 知会：直通时主控只收到一份副本，不参与决策。 */
function buildNotices(
  lanes: readonly Lane[],
  origin: number,
  topPadding: number,
  scale: number,
  events: readonly { at?: string; path?: string }[],
  createdAt: string,
): Notice[] {
  const routerKey = lanes.find(lane => lane.role === 'router')?.key
  if (!routerKey) return []
  const base = Date.parse(createdAt)
  return events
    .filter(event => event.path === 'direct' && event.at)
    .map((event, index) => ({
      id: `notice-${index}`,
      laneKey: routerKey,
      top: topPadding + (Date.parse(event.at!) - base - origin) * scale,
      label: '知会',
    }))
}

/**
 * 空档带：某列在这段时间里**完全没有参与**，才画斜纹。
 *
 * "参与"包括两种：活动块（在干活），以及箭头端点（收到报告、发出回复）。
 * 只看块会得出错误结论——主控在 13s 收到过报告，不该被标成整段"未参与"。
 */
function buildBands(
  nodes: readonly Node[],
  arrows: readonly Arrow[],
  lanes: readonly Lane[],
  topPadding: number,
  total: number,
): Band[] {
  const bands: Band[] = []
  for (const lane of lanes) {
    const label = lane.role === 'router' ? '主控未参与' : lane.role === 'executor' ? '执行器空闲' : ''
    if (!label) continue

    // 收集该列所有"参与时刻"：块是区间，箭头端点是瞬间
    const moments: { top: number; bottom: number }[] = [
      ...nodes.filter(node => node.laneKey === lane.key).map(node => ({ top: node.top, bottom: node.top + node.height })),
      ...arrows.filter(arrow => arrow.from === lane.key || arrow.to === lane.key)
        .map(arrow => ({ top: arrow.top, bottom: arrow.top + 1 })),
    ].sort((left, right) => left.top - right.top)
    if (moments.length === 0) continue

    const merged: { top: number; bottom: number }[] = []
    for (const moment of moments) {
      const last = merged[merged.length - 1]
      if (last && moment.top <= last.bottom + 1) last.bottom = Math.max(last.bottom, moment.bottom)
      else merged.push({ ...moment })
    }

    for (let index = 0; index < merged.length - 1; index += 1) {
      const from = merged[index]!.bottom
      const to = merged[index + 1]!.top
      if (to - from < 40) continue
      bands.push({ id: `band-${lane.key}-${index}`, laneKey: lane.key, top: from, height: to - from, label })
    }
    const tail = topPadding + total
    const lastEnd = merged[merged.length - 1]!.bottom
    if (tail - lastEnd > 40) {
      bands.push({ id: `band-${lane.key}-tail`, laneKey: lane.key, top: lastEnd, height: tail - lastEnd, label })
    }
  }

  // 每个泳道只在**最宽的那段**标注文字：斜纹本身已经说明"没参与"，
  // 每段都写字反而变成噪音。
  const widest = new Map<string, number>()
  for (const band of bands) {
    const current = widest.get(band.laneKey)
    if (current === undefined || band.height > current) widest.set(band.laneKey, band.height)
  }
  return bands.map(band => band.height >= widest.get(band.laneKey)! ? band : { ...band, label: '' })
}

/** 泳道查找：按 key 找，支持多条来源。 */
export function laneOf(model: SwimlaneModel, key: string): Lane {
  return model.lanes.find(lane => lane.key === key) ?? model.lanes[0]!
}

/** 角色 → 泳道键：来源取第一条来源列，其余按角色。 */
function laneKeyFor(role: Role, lanes: readonly Lane[]): string {
  // 子代理永远挂执行器列，不新增列
  const wanted: Role = role === 'subagent' ? 'executor' : role
  const match = lanes.find(lane => lane.role === wanted)
  return match?.key ?? lanes[0]!.key
}

/** 只保留有实际内容的 span，用于清单与计数。 */
export function visibleSpans(chain: Chain): readonly Span[] {
  return chain.spans.filter(span => span.role !== 'source')
}
