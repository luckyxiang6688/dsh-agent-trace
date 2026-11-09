import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildChain } from '../src/adapter/superagent/chain.ts'
import { buildLink } from '../src/service/link.ts'
import { present } from '../src/presenter/swimlane.ts'
import type { RawDecision, RawTicket, StoreLike } from '../src/adapter/superagent/db.ts'
import type { Chain } from '../src/domain/model.ts'

function store(ticket: RawTicket, decisions: RawDecision[] = []): StoreLike {
  return {
    tickets: () => [ticket],
    ticket: id => (id === ticket.id ? ticket : undefined),
    outbox: () => [],
    triggers: () => [],
    decisions: () => decisions,
    dispositions: () => [],
    threads: () => [],
    kv: () => undefined,
    // 来源页用的访问器：这套测试不碰它们，给空实现即可（契约仍由 db.ts 的实现满足）。
    ticketsBySource: () => [],
    trigger: () => undefined,
    disposition: () => undefined,
    thread: () => undefined,
    decisionsOfTrigger: () => [],
    sourceAggregates: () => [],
    dispositionSources: () => [],
    ticketIndex: () => [],
    sourceEventRows: () => [],
    configuredSources: () => [],
    settingsSnapshots: () => [],
    sourceLabels: () => undefined,
    close: () => {},
  }
}

const T = (seconds: number): string => new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000).toISOString()

const base: RawTicket = {
  id: 'ticket-1', title: '示例', createdAt: T(0), updatedAt: T(0),
}

/** 排队 → 执行 → 受阻 → 人跟进 → 重试排队 → 执行 → 待验收 → 已结束 的完整生命期。 */
const retried: RawTicket = {
  ...base,
  assignments: [
    {
      id: 'a1', state: 'ended', createdAt: T(0), startedAt: T(10), endedAt: T(40), endedReason: 'retried',
      report: { state: 'blocked', at: T(30) },
    },
    {
      id: 'a2', state: 'ended', createdAt: T(50), startedAt: T(60), endedAt: T(130),
      report: { state: 'ready', at: T(100) },
    },
  ],
  inputs: [
    { id: 'i0', kind: 'trigger', at: T(0), human: true, text: '做这个' },
    { id: 'i1', kind: 'trigger', at: T(45), human: true, text: '接着做' },
  ],
  ended: { at: T(120), by: 'orchestrator', outcome: 'completed' },
}

test('状态带按派工/报告/人的消息切段，相邻同态合并', () => {
  const chain = buildChain(store(retried), 'ticket-1')!
  const bands = chain.stateBands ?? []
  assert.deepEqual(
    bands.map(band => [band.tag, band.startMs, band.endMs]),
    [
      ['working/queued', 0, 10_000],
      ['working', 10_000, 30_000],
      // 30s 报告受阻、45s 人跟进前一直是「等人」
      ['person/blocked', 30_000, 45_000],
      ['working', 45_000, 50_000],
      ['working/queued', 50_000, 60_000],
      ['working', 60_000, 100_000],
      ['person/review', 100_000, 120_000],
      ['ended', 120_000, 130_000],
    ],
  )
  // 每段都要能解释「为什么是这个态」
  assert.ok(bands.every(band => !!band.reason))
})

test('投递失败与待回答各自成为状态带，起点标为近似', () => {
  const asked = buildChain(store({
    ...base,
    assignments: [{ id: 'a1', state: 'ended', createdAt: T(0), startedAt: T(1), endedAt: T(20), report: { state: 'progress', at: T(5) } }],
    inputs: [{ id: 'i1', kind: 'trigger', at: T(2), human: true, text: '问个问题' }],
    attention: { id: 'q1', question: '用哪个名字？' },
  }), 'ticket-1')!
  const answer = (asked.stateBands ?? []).find(band => band.tag === 'person/answer')
  assert.ok(answer, '应该有等待人回答的状态带')
  // 提问时刻没有落库：优先用提出问题的报告时刻，必须标明近似
  assert.equal(answer!.startMs, 5_000)
  assert.equal(answer!.startsApprox, true)

  // 连报告时刻也没有：退回最后一条人的消息，同样标近似，不编造 0
  const fallback = buildChain(store({
    ...base,
    updatedAt: T(12),
    assignments: [{ id: 'a1', state: 'ended', createdAt: T(0), startedAt: T(1) }],
    inputs: [{ id: 'i1', kind: 'trigger', at: T(7), human: true, text: '问个问题' }],
    attention: { id: 'q1', question: '用哪个名字？' },
  }), 'ticket-1')!
  const derived = (fallback.stateBands ?? []).find(band => band.tag === 'person/answer')
  assert.ok(derived, '提问之后到工单最后一次写入之间应该有等待带')
  assert.equal(derived!.startMs, 7_000)
  assert.equal(derived!.endMs, 12_000)
  assert.equal(derived!.startsApprox, true)

  const failed = buildChain(store({
    ...base,
    assignments: [{ id: 'a1', state: 'ended', createdAt: T(0), startedAt: T(1), endedAt: T(20) }],
    delivery: { at: T(3), error: 'session gone' },
  }), 'ticket-1')!
  const deliveryBand = (failed.stateBands ?? []).find(band => band.tag === 'person/delivery')
  assert.ok(deliveryBand)
  assert.equal(deliveryBand!.startMs, 3_000)
  assert.equal(deliveryBand!.endMs, 20_000)
})

test('离散节点：重试、提问、投递失败、工单结束、停止各画一次', () => {
  const chain = buildChain(store({
    ...retried,
    delivery: { at: T(3), error: 'session gone' },
    attention: { id: 'q1', question: '用哪个名字？' },
  }, [{ id: 'd1', kind: 'stop', at: T(4), ticketId: 'ticket-1' } as RawDecision]), 'ticket-1')!
  const ids = chain.spans.filter(span => span.kind === 'event').map(span => span.id)
  assert.ok(ids.includes('event-decision-d1'), '合法停止要画成离散节点')
  assert.ok(ids.includes('event-retry-a2'), '重试要画在第二次派工处')
  assert.ok(ids.includes('event-delivery'))
  assert.ok(ids.includes('event-attention'))
  assert.ok(ids.includes('event-ended'))
  // 离散节点不是活动块：时间窗为 0
  assert.ok(chain.spans.filter(span => span.kind === 'event').every(span => span.endMs === span.startMs))
})

test('状态带只铺执行器列，且不再叠「执行器空闲」斜纹', () => {
  const chain: Chain = {
    ticketId: 't1', title: '示例', stage: '进行中', createdAt: '2026-01-01T00:00:00Z',
    spans: [
      { id: 'assignment-a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 10_000, endMs: 40_000 },
      { id: 'event-ended', role: 'executor', kind: 'event', label: '工单结束', startMs: 120_000, endMs: 120_000 },
    ],
    stateBands: [
      { id: 'state-band-0', tag: 'working/queued', label: '排队', startMs: 0, endMs: 10_000 },
      { id: 'state-band-1', tag: 'person/review', label: '等待人验收', startMs: 40_000, endMs: 120_000 },
    ],
  }
  const model = present(chain)
  const executor = model.lanes.find(lane => lane.role === 'executor')!
  assert.ok(model.stateBands.every(band => band.laneKey === executor.key))
  assert.deepEqual(model.stateBands.map(band => band.group), ['working', 'person'])
  // 斜纹只剩主控列
  assert.ok(model.bands.every(band => band.laneKey !== executor.key))
  // 离散事件是小节点，不撑成 42px 的活动块
  const event = model.nodes.find(node => node.id === 'event-ended')!
  assert.equal(event.event, true)
  assert.equal(event.height, 14)
})

test('离散事件不产生派工/报告箭头：它不是一次派工', () => {
  const model = present({
    ticketId: 't1', title: '示例', stage: '已结束', createdAt: '2026-01-01T00:00:00Z',
    spans: [
      { id: 'assignment-a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 1000, reportState: 'ready' },
      { id: 'event-ended', role: 'executor', kind: 'event', label: '工单结束', startMs: 1200, endMs: 1200 },
    ],
  })
  assert.deepEqual(
    model.arrows.map(arrow => arrow.id),
    ['arrow-dispatch-assignment-a1', 'arrow-report-assignment-a1'],
  )
})

test('状态带可点，抽屉给出起止、原因与下一步', () => {
  const chain: Chain = {
    ticketId: 't1', title: '示例', stage: '等待人验收', createdAt: '2026-01-01T00:00:00Z',
    spans: [],
    stateBands: [{
      id: 'state-band-0', tag: 'person/review', label: '等待人验收',
      startMs: 61_000, endMs: 125_000, reason: '最新报告为就绪，等待人验收',
    }],
  }
  const detail = buildLink({ chain, dispositions: [], assignments: [], outbox: [] }, 'state-band-0')!
  assert.equal(detail.title, '状态 · 等待人验收')
  const titles = detail.sections.map(section => section.title)
  assert.deepEqual(titles, ['这段时间', '为什么是这个状态', '接下来'])
  const badges = detail.sections[0]!.items?.map(item => item.text) ?? []
  assert.ok(badges.includes('从 1m1s 起'))
  assert.ok(badges.includes('持续 1m4s'))
  assert.equal(detail.sections[2]!.text, '等人验收。验收后由主控收尾，或退回继续。')
})

test('未知状态带 id 返回 undefined，不抛', () => {
  const chain: Chain = { ticketId: 't1', title: 'x', stage: '进行中', createdAt: '2026-01-01T00:00:00Z', spans: [] }
  assert.equal(buildLink({ chain, dispositions: [], assignments: [], outbox: [] }, 'state-band-7'), undefined)
})
