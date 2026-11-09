/**
 * 事件抽屉的三段：事实 / 解释 / 没记录的事实。
 *
 * 最要紧的一条：解释句绝不能混进事实。事实只写库里的字段；
 * 句子是查表来的，必须单独成段并标明「解释」。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSourceEventDetail } from '../src/service/sources.ts'
import { interpretDecisionKind, interpretFilteredCode } from '../src/service/explain.ts'
import { createReader } from '../src/service/reader.ts'
import { PROSE_PREVIEW_CHARS } from '../src/domain/model.ts'
import { writeFixture, type FixturePaths } from './fixtures/second-source/fixture.ts'
import { readSessionEvents, sessionFileOf } from '../src/adapter/session/children.ts'
import type { ChainReader } from '../src/domain/model.ts'
import type { RawDecision, RawDisposition, RawTrigger } from '../src/adapter/superagent/db.ts'

const labels = (detail: ReturnType<typeof buildSourceEventDetail>): string[] =>
  (detail?.facts ?? []).map(fact => fact.label)

const factOf = (detail: ReturnType<typeof buildSourceEventDetail>, label: string): string | undefined =>
  detail?.facts.find(fact => fact.label === label)?.value

const trigger = (extra: Partial<RawTrigger> = {}): RawTrigger => ({
  id: 'tr-1', source: 'fixture', at: '2026-02-01T00:00:00Z', text: '帮我整理周报',
  addressed: 'mention', human: true, actor: { source: 'fixture', id: 'u1' }, meta: {},
  ...extra,
})

test('丢弃 + meta.noisy：元数据进事实，解释单独成段，事实里不得混入解释句', () => {
  const disposition: RawDisposition = { id: 'tr-1', filtered: { code: 'no_mention' } }
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-1',
    trigger: trigger({ meta: { noisy: true } }),
    disposition,
    decisions: [],
    threads: [],
    tickets: [],
  })!

  assert.equal(factOf(detail, '元数据'), '{"noisy":true}')
  assert.equal(factOf(detail, '原因码'), 'no_mention')
  assert.equal(factOf(detail, '去向'), '源头丢弃')

  // 解释在解释段里，带着码查表的原文
  assert.deepEqual(detail.interpretations, [interpretFilteredCode('no_mention')])

  // 事实段不能出现解释句的任何片段
  const explained = interpretFilteredCode('no_mention').text
  for (const fact of detail.facts) {
    assert.ok(!fact.value.includes(explained), `事实「${fact.label}」里混入了整句解释`)
    assert.ok(!fact.value.includes('这道闸'), `事实「${fact.label}」里混入了查表文案`)
  }

  // 没记录的事实必须点明：过滤只落码、没留设置快照
  assert.ok(detail.notRecorded.some(line => line.includes('设置快照')))
  assert.ok(detail.notRecorded.some(line => line.includes('去重')))
})

test('同文案、无 noisy，走裁定 ignore：裁定/理由/授权/规则评估/策略版本全在事实里', () => {
  const decision: RawDecision = {
    id: 'dec-1',
    kind: 'ignore',
    evalId: 'eval-1',
    policyVersion: 'pv-9',
    reason: [{ code: 'directionUnsettled' }],
    mandate: { strength: 'referenced', policyVersion: 'pv-9', scope: 'thread', basis: { via: 'rule', rule: 'r-1' } },
    audit: { rule_assessments: [
      { rule_id: 'r-1', matched: true },
      { rule_id: 'r-2', matched: false },
    ] },
  }
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-1',
    trigger: trigger(),
    disposition: { id: 'tr-1', decisionId: 'dec-1' },
    decisions: [decision],
    threads: [],
    tickets: [],
  })!

  assert.equal(factOf(detail, '元数据'), '空')
  assert.equal(factOf(detail, '裁定'), 'ignore（拒绝）')
  assert.equal(factOf(detail, '策略版本'), 'pv-9')
  assert.equal(factOf(detail, '授权强度'), 'referenced')
  assert.equal(factOf(detail, '主控理由码'), 'directionUnsettled')
  assert.equal(factOf(detail, '规则评估'), '2 条，命中 1 条')
  assert.ok(labels(detail).includes('授权依据'))

  assert.ok(detail.interpretations.some(item => item.label === '裁定 ignore'))
  assert.ok(detail.interpretations.some(item => item.label === '理由码 directionUnsettled'))
  assert.deepEqual(detail.interpretations[0], interpretDecisionKind('ignore'))
})

test('理由里带原文（`values.text`）：原文进事实，不当成解释', () => {
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-1',
    trigger: trigger(),
    disposition: { id: 'tr-1', decisionId: 'dec-said' },
    decisions: [{
      id: 'dec-said',
      kind: 'ignore',
      reason: [{ code: 'said', values: { text: '这个话题已经在别处处理了' } }],
    }],
    threads: [],
    tickets: [],
  })!

  // 原文是库里的值：进事实段（`service/facts.ts:176-177` 同口径）。
  assert.equal(factOf(detail, '理由原文'), '这个话题已经在别处处理了')
  assert.equal(factOf(detail, '主控理由码'), 'said')
  // `said` 不当成解释：解释段里不该出现它。
  assert.ok(!detail.interpretations.some(item => item.label.includes('said')))
})

test('退回记录的坏形状不抛：只取得到 ticketId 的项', () => {
  // 详情路由外层 catch 会把抛错变成 500；同一个字段在 `fateOf` 里已经做了守卫，
  // 这里不能再漏一个读取点。
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-1',
    trigger: trigger(),
    disposition: { id: 'tr-1', handbacks: [{ ticketId: 't-a' }, null as never] },
    decisions: [],
    threads: [],
    tickets: [],
  })!
  assert.equal(factOf(detail, '退回工单'), 't-a')
  assert.equal(detail.relatedTickets.some(ticket => ticket.ticketId === 't-a'), true)
})

test('订阅直通：线程订阅与工单关联都带上，线程名来自 source-labels', () => {
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-1',
    trigger: trigger({ threads: [{ source: 'fixture', id: 't-1' }] }),
    disposition: { id: 'tr-1', fanout: ['ticket-a'] },
    decisions: [],
    threads: [{
      key: 'fixture:t-1',
      label: '周报讨论',
      thread: { key: 'fixture:t-1', subscriptions: ['ticket-a'], context: ['ticket-b'], lastAt: '2026-02-01T00:00:35Z' },
    }],
    tickets: [{ id: 'ticket-a', title: '整理周报', originTriggerId: 'tr-1', source: 'fixture' }],
  })!

  assert.equal(factOf(detail, '去向'), '订阅直通')
  assert.equal(factOf(detail, '送达工单'), 'ticket-a')
  assert.deepEqual(detail.relatedTickets, [{ ticketId: 'ticket-a', title: '整理周报', source: 'fixture' }])
  assert.deepEqual(detail.threads, [{
    key: 'fixture:t-1',
    label: '周报讨论',
    subscriptions: ['ticket-a'],
    context: ['ticket-b'],
    lastAt: '2026-02-01T00:00:35Z',
  }])
})

test('关联工单可以跨来源：抽屉带上它的来源，别当成当前来源下的工单', () => {
  // 执行器用 orchestrator_thread_follow 关注别的来源的线程后，那边的扇出/上下文
  // 会牵到本工单。左栏按来源过滤，所以抽屉必须标出「它来自哪里」。
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-1',
    trigger: trigger(),
    disposition: { id: 'tr-1', context: ['ticket-other'] },
    decisions: [],
    threads: [],
    tickets: [{ id: 'ticket-other', title: 'github 建的', originTriggerId: 'tr-g', source: 'github' }],
  })!
  assert.deepEqual(detail.relatedTickets, [
    { ticketId: 'ticket-other', title: 'github 建的', source: 'github' },
  ])
})

test('只有去向行、没有触发行：给降级详情，不返回 undefined', () => {
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-lost',
    disposition: { id: 'tr-lost', fanout: ['ticket-a'] },
    decisions: [],
    threads: [],
    tickets: [],
  })
  assert.ok(detail, '有去向行就必须有详情')
  assert.equal(factOf(detail!, '原文'), '没有触发行：这条事件只有去向记录，原文不可读')
  assert.equal(factOf(detail!, '去向'), '订阅直通')
  // 没有原文就不给预览（不是空串，是「没有这一项」）
  assert.equal(detail!.text, undefined)

  // 两样都没有才 undefined
  assert.equal(buildSourceEventDetail({
    source: 'fixture', triggerId: 'tr-none', decisions: [], threads: [], tickets: [],
  }), undefined)
})

test('长文：详情只给 200 字预览，长度按全文记；全文另走一条路', () => {
  const long = '长'.repeat(PROSE_PREVIEW_CHARS + 120)
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-1',
    trigger: trigger({ text: long }),
    decisions: [],
    threads: [],
    tickets: [],
  })!
  assert.equal(detail.text?.text.length, PROSE_PREVIEW_CHARS)
  assert.equal(detail.text?.length, long.length)
  assert.equal(detail.text?.id, 'tr-1')
  assert.equal(factOf(detail, '原文长度'), `${long.length} 字`)
})

let fixture: FixturePaths
let reader: ChainReader

before(() => {
  fixture = writeFixture(join(mkdtempSync(join(tmpdir(), 'event-detail-')), 'fixture'))
  reader = createReader({
    stateDir: fixture.stateDir,
    sessionQuery: {
      async readSession(sessionId: string) {
        const file = sessionFileOf(fixture.sessionsRoot, sessionId)
        return { events: file ? readSessionEvents(file) : [] }
      },
    },
  })
})

test('夹具上的真实抽屉：被丢弃的事件带原因码与设置版本声明，线程名是标签里的那个', async () => {
  const filtered = (await reader.readSourceEvent('fixture', 'tr-noise'))!
  assert.equal(factOf(filtered, '原因码'), 'no_mention')
  assert.equal(factOf(filtered, '元数据'), '{"noisy":true}')
  assert.ok(filtered.notRecorded.some(line => line.includes('设置快照')))

  const routed = (await reader.readSourceEvent('fixture', 'tr-b1'))!
  assert.equal(factOf(routed, '裁定'), 'accept（接单）')
  assert.equal(factOf(routed, '策略版本'), 'pv-2')
  assert.equal(factOf(routed, '主控理由码'), 'explicitRouted')
  assert.equal(routed.threads[0]?.key, 'fixture:t-1')
  assert.equal(routed.threads[0]?.label, '周报讨论')
  assert.deepEqual(routed.threads[0]?.subscriptions, [fixture.ticketId])
  assert.ok(routed.relatedTickets.some(ticket => ticket.ticketId === fixture.ticketId))

  // 不串源：拿别的来源名读同一条事件必须 404
  assert.equal(await reader.readSourceEvent('github', 'tr-b1'), undefined)
  // 全文路由只认本来源
  assert.equal(await reader.readSourceEventText('github', 'tr-b1'), undefined)
  assert.equal(await reader.readSourceEventText('fixture', 'tr-b1'), '帮我整理这周的周报')
})
