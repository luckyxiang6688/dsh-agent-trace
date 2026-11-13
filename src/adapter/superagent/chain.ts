/**
 * 把上游的工单 / 派工 / 决定翻译成 domain 的 Chain。
 * 只做形状翻译与时间换算；配色、列、文案都属于 presenter。
 */
import { codeLabel, TICKET_OUTCOME_LABEL, type Chain, type ChainStateBand, type Span } from '../../domain/model.ts'
import type { RawDecision, RawTicket, StoreLike } from './db.ts'
import { stageLabel, stageLabelOfTag, stageTag, ticketStage } from './stage.ts'
import { workerSessionId } from '../../domain/session.ts'

/** 工单是否结束，以及结束时的标签。 */
export function stateOf(ticket: RawTicket): string {
  if (ticket.ended) {
    // 结束去向是上游枚举：译成「中文（code）」，认不得的原样显示。
    const outcome = ticket.ended.outcome ? ` · ${codeLabel(TICKET_OUTCOME_LABEL, ticket.ended.outcome)}` : ''
    return `已结束${outcome}`
  }
  return '进行中'
}

/**
 * 阶段：严格按上游的派生顺序算（`stage.ts`），不再只看最近一次报告。
 * 已结束的工单统一显示「已结束」+ 结束去向。
 */
export function stageOf(ticket: RawTicket): { stage: string; stageTag: string } {
  if (ticket.ended) return { stage: stateOf(ticket), stageTag: 'ended' }
  const derived = ticketStage(ticket)
  return { stage: stageLabel(derived), stageTag: stageTag(derived) }
}

/** 徽章：裁定者由「有没有研判痕迹」决定，**不看 strength**（实测 inferred 也可能是规则拒绝）。 */
export function badgeOf(decision: RawDecision): string {
  if ((decision.audit?.rule_assessments?.length ?? 0) > 0) return '模型裁定'
  const code = decision.reason?.[0]?.code ?? ''
  if (code === 'explicitRouted') return '准入放行'
  if (code === 'no_mention' || code === 'not_a_member' || code === 'admission_ignored') return '规则拒绝'
  return '规则放行'
}

/**
 * 调用方手里已有的行，可以不重复查库。
 *
 * 列表接口要为每张工单拼一行摘要：它本来就拿到了 `RawTicket`，`decisions()` 也是整表读，
 * 一张工单调一次就变成「50 张工单扫 50 遍 decision 表」。把这两样传进来，整次列表只查一次。
 * 单张工单的详情路径不传，行为与以前一致。
 */
export interface ChainInputs {
  readonly ticket?: RawTicket
  readonly decisions?: readonly RawDecision[]
}

/** 一张工单 → 一条链路；工单不存在返回 undefined（不抛）。 */
export function buildChain(store: StoreLike, ticketId: string, preloaded: ChainInputs = {}): Chain | undefined {
  const raw = preloaded.ticket ?? store.ticket(ticketId)
  if (!raw) return undefined

  const base = Date.parse(raw.createdAt)
  const offset = (value: string | undefined): number | undefined => {
    if (!value) return undefined
    const ms = Date.parse(value)
    return Number.isFinite(ms) ? Math.max(ms - base, 0) : undefined
  }

  const decisions = (preloaded.decisions ?? store.decisions()).filter(item => item.ticketId === ticketId)
  const decision = decisions.find(item => item.kind !== 'stop' && item.kind !== 'unavailable')
  const spans: Span[] = []

  // 主控：受理这一单的那次判定。
  if (decision) {
    const at = offset(decision.at) ?? 0
    spans.push({
      id: `decision-${decision.id}`,
      role: 'router',
      kind: 'activity',
      label: '评估',
      badge: badgeOf(decision),
      // 评估开始时刻上游没有落库：只画判定点，起点标为近似（虚线边），不编造 -50ms。
      startMs: at,
      endMs: at,
      startsApprox: true,
      source: { sessionId: 'orchestrator' },
    })
  }

  // 停止与不可用是判定结果，不是失败块：画成离散节点。
  for (const item of decisions) {
    if (item.kind !== 'stop' && item.kind !== 'unavailable') continue
    const at = offset(item.at) ?? 0
    spans.push({
      id: `event-decision-${item.id}`,
      role: 'router',
      kind: 'event',
      label: item.kind === 'stop' ? '停止' : '不可用',
      startMs: at,
      endMs: at,
      source: { sessionId: 'orchestrator' },
    })
  }

  // 执行器：每次派工一段活动。派工可以多次，会话不变。
  const assignments = raw.assignments ?? []
  for (const [index, assignment] of assignments.entries()) {
    const start = offset(assignment.startedAt) ?? offset(raw.createdAt) ?? 0
    const end = offset(assignment.endedAt) ?? start
    spans.push({
      id: `assignment-${assignment.id}`,
      role: 'executor',
      kind: 'activity',
      label: `派工 #${index + 1}`,
      ...(assignment.state === 'ended' ? {} : { badge: '进行中' }),
      ...(assignment.report?.state ? { reportState: assignment.report.state } : {}),
      startMs: start,
      endMs: Math.max(end, start),
      source: { sessionId: workerSessionId(ticketId) },
    })
    // 上一条派工是被重试结束的：新派工的开始时刻就是重试点。
    if (index > 0 && assignments[index - 1]?.endedReason === 'retried') {
      const at = offset(assignment.createdAt) ?? start
      spans.push({
        id: `event-retry-${assignment.id}`,
        role: 'executor',
        kind: 'event',
        label: '重试',
        startMs: at,
        endMs: at,
        source: { sessionId: workerSessionId(ticketId) },
      })
    }
  }

  // 投递失败、提问、工单结束：各有明确判据，不混进活动块。
  const deliveryAt = offset(raw.delivery?.at)
  if (deliveryAt !== undefined) {
    spans.push({
      id: 'event-delivery', role: 'executor', kind: 'event', label: '投递失败',
      startMs: deliveryAt, endMs: deliveryAt, source: { sessionId: workerSessionId(ticketId) },
    })
  }
  const attention = attentionAt(raw, offset)
  if (attention !== undefined) {
    spans.push({
      id: 'event-attention', role: 'executor', kind: 'event', label: '提问',
      startMs: attention, endMs: attention, startsApprox: true,
      source: { sessionId: workerSessionId(ticketId) },
    })
  }
  const endedAt = offset(raw.ended?.at)
  if (endedAt !== undefined) {
    spans.push({
      id: 'event-ended', role: 'executor', kind: 'event', label: '工单结束',
      startMs: endedAt, endMs: endedAt, source: { sessionId: workerSessionId(ticketId) },
    })
  }

  const sorted = [...spans].sort((left, right) => left.startMs - right.startMs)
  // 时间轴末端取「最后一段活动」与「工单最后一次写入」的较晚者：
  // 否则「刚提问、还没人回答」这种状态带宽度为 0，画不出来也说不出等了多久。
  const endMs = sorted.reduce(
    (max, span) => Math.max(max, span.endMs),
    Math.max(offset(raw.updatedAt) ?? 0, 0),
  )
  const stateBands = stateBandsOf(raw, offset, endMs)
  const stage = stageOf(raw)
  const inputs = (raw.inputs ?? []).map(input => ({
    kind: input.kind ?? 'unknown',
    ...(input.text !== undefined ? { text: input.text } : {}),
    ...(input.at !== undefined ? { at: input.at } : {}),
    ...(input.human ? { human: true } : {}),
    ...(input.context ? { context: true } : {}),
    ...(input.triggerId !== undefined ? { triggerId: input.triggerId } : {}),
  }))
  const answers = (raw.answers ?? [])
    .map(answer => (typeof answer === 'string' ? answer : answer.text))
    .filter((text): text is string => typeof text === 'string' && text.length > 0)
  return {
    ticketId: raw.id,
    title: raw.title,
    stage: stage.stage,
    stageTag: stage.stageTag,
    createdAt: raw.createdAt,
    // 上游在收到带 channel 的消息时才登记出口；没有出口的来源不能回复。
    ...(Array.isArray(raw.channels) ? { canReply: raw.channels.length > 0 } : {}),
    ...(raw.ended?.at ? { endedAt: raw.ended.at } : {}),
    ...(inputs.length > 0 ? { inputs } : {}),
    ...(raw.attention
      ? {
          attention: {
            ...(raw.attention.question !== undefined ? { question: raw.attention.question } : {}),
            ...(raw.attention.triggerId !== undefined ? { triggerId: raw.attention.triggerId } : {}),
          },
        }
      : {}),
    ...(answers.length > 0 ? { answers } : {}),
    ...(raw.delivery
      ? {
          delivery: {
            ...(raw.delivery.at !== undefined ? { at: raw.delivery.at } : {}),
            ...(raw.delivery.error !== undefined ? { error: raw.delivery.error } : {}),
          },
        }
      : {}),
    ...(raw.follows && raw.follows.length > 0
      ? {
          follows: raw.follows.map(follow => ({
            thread: follow.thread,
            own: follow.own,
            ...(follow.closed ? { closed: { at: follow.closed.at, outcome: follow.closed.outcome } } : {}),
          })),
        }
      : {}),
    ...(stateBands.length > 0 ? { stateBands } : {}),
    spans: sorted,
  }
}

/**
 * 提问时刻没有落库（`Attention` 没有 `at`）。能用的最近证据是提出问题的
 * 那次报告（`assignments.ts:113-119`：report 带 question 且不是 ready 就设 attention），
 * 退而求其次用触发问题的那条人的消息。都拿不到才记 0，并标为近似。
 */
function attentionAt(
  raw: RawTicket,
  offset: (value: string | undefined) => number | undefined,
): number | undefined {
  if (!raw.attention) return undefined
  const reports = (raw.assignments ?? [])
    .map(assignment => assignment.report)
    .filter(report => report?.at && report.state !== 'ready' && report.state !== 'dropped')
  const fromReport = offset(reports[reports.length - 1]?.at)
  if (fromReport !== undefined) return fromReport
  const humans = (raw.inputs ?? [])
    .filter(input => input.kind === 'trigger' && input.human && !input.context)
    .map(input => offset(input.at))
    .filter((value): value is number => value !== undefined)
  return humans[humans.length - 1] ?? 0
}

/**
 * 执行器列的状态背景带：把工单生命期按「状态可能变化」的时刻切开，
 * 每段用与 `ticketStage` 同一套判据（按当时的报告/派工/投递/结束）定态，
 * 相邻同态合并。起点能从落库时刻得到的才算精确，否则标 `startsApprox`。
 */
function stateBandsOf(
  raw: RawTicket,
  offset: (value: string | undefined) => number | undefined,
  endMs: number,
): readonly ChainStateBand[] {
  const assignments = raw.assignments ?? []
  const endedAt = offset(raw.ended?.at)
  const deliveryAt = offset(raw.delivery?.at)
  const attention = attentionAt(raw, offset)

  const points = new Set<number>([0, Math.max(endMs, 0)])
  for (const value of [endedAt, deliveryAt, attention]) {
    if (value !== undefined) points.add(Math.max(value, 0))
  }
  for (const assignment of assignments) {
    for (const value of [
      offset(assignment.createdAt),
      offset(assignment.startedAt),
      offset(assignment.endedAt),
      offset(assignment.report?.at),
    ]) {
      if (value !== undefined) points.add(Math.max(value, 0))
    }
  }
  for (const input of raw.inputs ?? []) {
    if (input.kind !== 'trigger' || !input.human || input.context) continue
    const at = offset(input.at)
    if (at !== undefined) points.add(Math.max(at, 0))
  }

  const stageAt = (at: number): string => {
    if (endedAt !== undefined && endedAt <= at) return 'ended'
    // delivery/attention 是「当前未解除」的事实：一旦出现，之后都还算这个态。
    if (deliveryAt !== undefined && deliveryAt <= at) return 'person/delivery'
    if (attention !== undefined && attention <= at) return 'person/answer'

    const current = [...assignments].reverse().find(assignment => {
      const created = offset(assignment.createdAt) ?? offset(assignment.startedAt) ?? 0
      return created <= at
    })
    if (!current) return 'working/queued'
    const started = offset(current.startedAt)
    if (started === undefined || started > at) return 'working/queued'

    const reportAt = offset(current.report?.at)
    if (current.report && reportAt !== undefined && reportAt <= at) {
      const state = current.report.state
      if (state === 'ready') return 'person/review'
      if (state === 'blocked' || state === 'failed') {
        // 报告之后有人写过（非 context 的 trigger 输入），受阻就回到执行器。
        const followed = (raw.inputs ?? []).some(input => {
          if (input.kind !== 'trigger' || !input.human || input.context) return false
          const humanAt = offset(input.at)
          return humanAt !== undefined && humanAt > reportAt && humanAt <= at
        })
        return followed ? 'working' : `person/${state}`
      }
      if (state === 'waiting') return 'idle'
      if (state === 'dropped') return current.state === 'ended' ? 'idle' : 'working'
      return 'working'
    }
    if (current.state === 'pending') return 'working/queued'
    // 派工最后是 ended，不代表当时已经结束：只有结束时刻早于现在才算空闲。
    const currentEndedAt = offset(current.endedAt)
    if (currentEndedAt !== undefined && currentEndedAt <= at) return 'idle'
    return 'working'
  }

  const reasons: Readonly<Record<string, string>> = {
    'person/review': '最新报告为就绪，等待人验收',
    'person/answer': '有未回答的问题',
    'person/delivery': '输入没有送进执行器会话',
    'person/blocked': '报告受阻，且此后没有人跟进',
    'person/failed': '报告失败，且此后没有人跟进',
    'working/queued': '派工尚未开始',
    working: '执行器正在处理这张工单',
    idle: '执行器上一轮已结束、没有待处理项',
    ended: '工单已结束',
  }

  const ordered = [...points].sort((left, right) => left - right)
  const bands: ChainStateBand[] = []
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const start = ordered[index]!
    const end = ordered[index + 1]!
    if (end <= start) continue
    const tag = stageAt(start)
    const previous = bands[bands.length - 1]
    if (previous && previous.tag === tag) {
      bands[bands.length - 1] = { ...previous, endMs: end }
      continue
    }
    bands.push({
      id: `state-band-${bands.length}`,
      tag,
      label: stageLabelOfTag(tag),
      startMs: start,
      endMs: end,
      ...(tag === 'person/answer' ? { startsApprox: true } : {}),
      ...(reasons[tag] ? { reason: reasons[tag] } : {}),
    })
  }
  return bands
}
