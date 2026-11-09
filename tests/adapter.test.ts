import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildChain } from '../src/adapter/superagent/chain.ts'
import type { RawDecision, RawTicket, StoreLike } from '../src/adapter/superagent/db.ts'

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

const base: RawTicket = {
  id: 'ticket-1', title: '示例', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  assignments: [{ id: 'a1', state: 'running', startedAt: '2026-01-01T00:01:00Z' }],
}

test('阶段与阶段键都从同一套派生规则来', () => {
  const chain = buildChain(store({
    ...base,
    assignments: [{ id: 'a1', state: 'running', report: { state: 'ready', at: '2026-01-01T00:02:00Z' } }],
  }), 'ticket-1')!
  assert.equal(chain.stage, '等待人验收')
  assert.equal(chain.stageTag, 'person/review')
})

test('输入的 human/context/triggerId 要原样带给上层', () => {
  const chain = buildChain(store({
    ...base,
    inputs: [
      { id: 'i1', kind: 'trigger', triggerId: 'tr-1', at: '2026-01-01T00:03:00Z', human: true },
      { id: 'i2', kind: 'trigger', triggerId: 'tr-2', at: '2026-01-01T00:04:00Z', human: true, context: true },
      { id: 'i3', kind: 'resumed', triggerId: 'tr-1', at: '2026-01-01T00:05:00Z' },
    ],
  }), 'ticket-1')!
  assert.deepEqual(chain.inputs?.map(input => input.kind), ['trigger', 'trigger', 'resumed'])
  assert.equal(chain.inputs?.[0]?.human, true)
  assert.equal(chain.inputs?.[1]?.context, true)
  assert.equal(chain.inputs?.[2]?.triggerId, 'tr-1')
})

test('提问与投递失败都带出来，阶段据此判定', () => {
  const asked = buildChain(store({
    ...base,
    attention: { id: 'q1', question: '用哪个名字？', triggerId: 'tr-1' },
  }), 'ticket-1')!
  assert.equal(asked.attention?.question, '用哪个名字？')
  assert.equal(asked.stageTag, 'person/answer')

  const failed = buildChain(store({
    ...base,
    delivery: { at: '2026-01-01T00:03:00Z', error: 'session gone' },
  }), 'ticket-1')!
  assert.equal(failed.delivery?.error, 'session gone')
  assert.equal(failed.stageTag, 'person/delivery')
})

test('answers 兼容字符串与旧对象两种存法', () => {
  const chain = buildChain(store({
    ...base,
    answers: ['第一问的答复', { text: '第二问的答复', at: '2026-01-01T00:06:00Z' }, { at: '2026-01-01T00:07:00Z' }],
  }), 'ticket-1')!
  assert.deepEqual(chain.answers, ['第一问的答复', '第二问的答复'])
})

test('已结束的工单即使还挂着 delivery 也显示已结束', () => {
  const chain = buildChain(store({
    ...base,
    ended: { at: '2026-01-01T00:09:00Z', by: 'executor', outcome: 'completed' },
    delivery: { at: '2026-01-01T00:03:00Z', error: 'session gone' },
  }), 'ticket-1')!
  assert.equal(chain.stageTag, 'ended')
  assert.equal(chain.stage, '已结束 · completed')
  assert.equal(chain.endedAt, '2026-01-01T00:09:00Z')
})

test('调用方已经拿到的行与决定可以直传：不重复查库、不重复扫 decision 表', () => {
  const ticket: RawTicket = { ...base, id: 'ticket-1' }
  const decision: RawDecision = {
    id: 'd1', ticketId: 'ticket-1', kind: 'route', at: '2026-01-01T00:00:30Z',
    reason: [{ code: 'explicitRouted', values: {} }],
  }
  const counting = () => {
    const counted = store(ticket, [decision])
    const calls = { ticket: 0, decisions: 0 }
    const originalTicket = counted.ticket
    const originalDecisions = counted.decisions
    counted.ticket = id => { calls.ticket += 1; return originalTicket(id) }
    counted.decisions = () => { calls.decisions += 1; return originalDecisions() }
    return { counted, calls }
  }

  // 列表路径：行与整表决定都已经在外层拿过，buildChain 不应再查。
  const shared = counting()
  const chain = buildChain(shared.counted, 'ticket-1', { ticket, decisions: [decision] })!
  assert.equal(chain.spans.length > 0, true)
  assert.equal(shared.calls.ticket, 0, '直传工单行后不应再查 ticket 表')
  assert.equal(shared.calls.decisions, 0, '直传决定后不应再扫 decision 表')

  // 详情路径：不传预载，保持旧行为（各自查一次）。
  const detail = counting()
  buildChain(detail.counted, 'ticket-1')
  assert.equal(detail.calls.ticket, 1)
  assert.equal(detail.calls.decisions, 1)
})
