/**
 * 来源页的纯逻辑：分类器、三源合并、游标分页。
 *
 * 分类器只有一个（`fateOf`）：比例带计数、事件行徽章、抽屉都调它。
 * 这里把优先级钉死，任何一处「顺手的改动」都要先让这些断言变红。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildSourceEventDetail, decisionFor, decisionsByTrigger, decodeCursor, encodeCursor, fateOf,
  mergeSources, pageOf, toSourceEvents,
} from '../src/service/sources.ts'
import { createReader } from '../src/service/reader.ts'
import { writeFixture, type FixturePaths } from './fixtures/second-source/fixture.ts'
import { readSessionEvents, sessionFileOf } from '../src/adapter/session/children.ts'
import type { ChainReader } from '../src/domain/model.ts'
import type { RawDecision, RawDisposition } from '../src/adapter/superagent/db.ts'

const D = (value: Omit<RawDisposition, 'id'>, id = 'tr-x'): RawDisposition => ({ id, ...value })

test('八种去向各自分类，字段只带库里有的', () => {
  assert.deepEqual(fateOf(undefined), { kind: 'unrecorded' })
  assert.deepEqual(fateOf(D({ filtered: { code: 'no_mention' } })), { kind: 'filtered', code: 'no_mention' })
  assert.deepEqual(fateOf(D({ requeued: { at: 'x' } })), { kind: 'requeued' })
  // 上游 handbacks 是对象数组（`core/model.ts:57` 的 `TriggerDisposition.handbacks`）
  assert.deepEqual(fateOf(D({ handbacks: [{ ticketId: 't-a', reason: 'not mine', at: 'x' }] })),
    { kind: 'handback', tickets: ['t-a'] })
  // 形状不对的行不许抛：拿不到 ticketId 就退成空列表，仍归「退回」。
  assert.deepEqual(fateOf(D({ handbacks: ['t-a'] as never })), { kind: 'handback', tickets: [] })
  // 连数组都不是：当作没有退回记录，不许抛。
  assert.deepEqual(fateOf(D({ handbacks: 't-a' as never })), { kind: 'undecided' })
  assert.deepEqual(fateOf(D({ context: ['t-a'] })), { kind: 'context', tickets: ['t-a'] })
  assert.deepEqual(fateOf(D({ fanout: ['t-a'] })), { kind: 'direct', tickets: ['t-a'] })
  assert.deepEqual(fateOf(D({})), { kind: 'undecided' })

  // 有裁定行：以决定行为准，带出决定 id / 评估 id / 裁定结果 / 建单
  const decision: RawDecision = { id: 'd-1', kind: 'accept', evalId: 'e-1', ticketId: 't-a' }
  assert.deepEqual(fateOf(D({}), decision), {
    kind: 'routed', decisionId: 'd-1', evalId: 'e-1', decisionKind: 'accept', ticketId: 't-a',
  })
  // 去向行记了 decisionId 但决定行丢了：仍算已裁定，内容留给抽屉标「未记录」
  assert.deepEqual(fateOf(D({ decisionId: 'd-2' })), { kind: 'routed', decisionId: 'd-2' })
})

test('优先级：filtered > requeued > handback > routed > context > direct > undecided', () => {
  const decision: RawDecision = { id: 'd-1', kind: 'accept' }
  // 全部字段同时出现 → 取 filtered
  const handback = [{ ticketId: 't-a' }]
  assert.equal(fateOf(D({
    filtered: { code: 'x' }, requeued: {}, handbacks: handback, decisionId: 'd-1', context: ['t-a'], fanout: ['t-a'],
  }), decision).kind, 'filtered')
  assert.equal(fateOf(D({ requeued: {}, handbacks: handback, decisionId: 'd-1', fanout: ['t-a'] }), decision).kind, 'requeued')
  assert.equal(fateOf(D({ handbacks: handback, decisionId: 'd-1', context: ['t-a'] }), decision).kind, 'handback')
  assert.equal(fateOf(D({ decisionId: 'd-1', context: ['t-a'], fanout: ['t-a'] }), decision).kind, 'routed')
  assert.equal(fateOf(D({ context: ['t-a'], fanout: ['t-a'] })).kind, 'context')
  assert.equal(fateOf(D({ fanout: ['t-a'] })).kind, 'direct')
})

test('选决定行：按去向的 decisionId 指针，没有指针才取最新', () => {
  // 上游 `Evals.record`（`core/evals.ts:329-335`）每次评估都把 disposition.decisionId
  // 覆盖成最新那条，旧决定行仍挂同一个 trigger。按数组顺序取第一条会拿到**最早**的结果。
  const early: RawDecision = { id: 'd-early', kind: 'ignore', at: '2026-02-01T00:00:01Z' }
  const late: RawDecision = { id: 'd-late', kind: 'accept', at: '2026-02-01T00:00:09Z' }
  assert.equal(decisionFor([early, late], D({ decisionId: 'd-late' }))?.kind, 'accept')
  // 指针指向的不是最新那条时，**指针赢**——这条断言专门用来打掉「一律取最新」的实现。
  assert.equal(decisionFor([early, late], D({ decisionId: 'd-early' }))?.kind, 'ignore')
  // 指针指向的行丢了：退到最新的一条，而不是最早的一条
  assert.equal(decisionFor([early, late], D({ decisionId: 'd-gone' }))?.id, 'd-late')
  // 没有指针（旧数据）：取 at 最新的
  assert.equal(decisionFor([early, late], D({}))?.id, 'd-late')
  // 数组顺序与时间顺序相反也要正确
  assert.equal(decisionFor([late, early], D({}))?.id, 'd-late')
  // 没有决定行
  assert.equal(decisionFor([], D({ decisionId: 'd-late' })), undefined)
})

test('两条读取路径都按指针选决定：倒序数组下列表与抽屉都取 pointed', () => {
  // 数组里晚的在前：任何一处退回「取数组首条」都会选中 accept，这里要求 ignore。
  const late: RawDecision = {
    id: 'd-late', kind: 'accept', at: '2026-02-01T00:00:09Z', ticketId: 't-a', triggerIds: ['tr-x'],
  }
  const early: RawDecision = { id: 'd-early', kind: 'ignore', at: '2026-02-01T00:00:01Z', triggerIds: ['tr-x'] }
  const disposition = D({ decisionId: 'd-early' }, 'tr-x')

  const events = toSourceEvents(
    [{ id: 'tr-x', source: 'fixture', at: '2026-02-01T00:00:05Z' }],
    new Map([['tr-x', disposition]]),
    decisionsByTrigger([late, early]),
  )
  assert.equal(events[0].fate.kind, 'routed')
  assert.equal(events[0].fate.kind === 'routed' ? events[0].fate.decisionKind : undefined, 'ignore')

  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-x',
    trigger: { id: 'tr-x', source: 'fixture', at: '2026-02-01T00:00:05Z' },
    disposition,
    decisions: [late, early],
    threads: [],
    tickets: [],
  })!
  assert.equal(detail.facts.find(fact => fact.label === '裁定')?.value, 'ignore（拒绝）')
})

test('三源合并：库、配置、注册表取并集，装未用的来源也列出来', () => {
  const merged = mergeSources({
    aggregates: [{ source: 'fixture', received: 3, lastAt: '2026-02-01T00:00:10Z' }],
    dispositions: [
      { source: 'fixture', disposition: D({ filtered: { code: 'no_mention' } }, 'a') },
      { source: 'fixture', disposition: D({ context: ['t-a'] }, 'b') },
      { source: 'legacy', disposition: D({ fanout: ['t-a'] }, 'c') },
    ],
    tickets: [{ id: 't-a', source: 'fixture', originTriggerId: 'a' }],
    configured: [{ source: 'github', enabled: false }],
    directory: [{ source: 'fixture', label: '夹具来源', installed: true, enabled: true }],
  })
  const byName = new Map(merged.map(item => [item.source, item]))

  const fixture = byName.get('fixture')!
  assert.equal(fixture.label, '夹具来源')
  assert.equal(fixture.enabled, true)
  assert.equal(fixture.received, 3)
  assert.equal(fixture.tickets, 1)
  assert.equal(fixture.counts.filtered, 1)
  assert.equal(fixture.counts.context, 1)
  // 3 条事件里有 1 条没有去向行
  assert.equal(fixture.unrecorded, 1)

  // 只有去向行、没有触发行、也没有配置的来源也要出现
  assert.equal(byName.get('legacy')?.counts.direct, 1)
  // 配置里出现、但一条事件都没有的来源：置灰用
  assert.equal(byName.get('github')?.received, 0)
  assert.equal(byName.get('github')?.enabled, false)

  // 最近活跃在前
  assert.equal(merged[0]!.source, 'fixture')
})

test('游标编解码：坏值退回 undefined，不抛', () => {
  const cursor = encodeCursor({ at: '2026-02-01T00:00:10Z', triggerId: 'tr-1' })!
  assert.deepEqual(decodeCursor(cursor), { at: '2026-02-01T00:00:10Z', id: 'tr-1' })
  assert.equal(encodeCursor({ triggerId: 'no-time' }), undefined)
  assert.equal(decodeCursor('not-base64!!'), undefined)
  assert.equal(decodeCursor(Buffer.from('{"at":1}', 'utf8').toString('base64url')), undefined)
  assert.equal(decodeCursor(undefined), undefined)
})

test('分页：多取一行判 more，游标指向本页最后一条', () => {
  const rows = [1, 2, 3].map(index => ({
    id: `tr-${index}`,
    source: 'fixture',
    at: `2026-02-01T00:00:0${index}Z`,
    text: `第 ${index} 条`,
  }))
  const events = toSourceEvents(rows, new Map(), new Map())
  assert.deepEqual(events.map(event => event.triggerId), ['tr-1', 'tr-2', 'tr-3'])
  assert.deepEqual(events.map(event => event.fate.kind), ['unrecorded', 'unrecorded', 'unrecorded'])

  const first = pageOf(events, 2)
  assert.equal(first.items.length, 2)
  assert.equal(first.more, true)
  assert.deepEqual(decodeCursor(first.nextCursor), { at: '2026-02-01T00:00:02Z', id: 'tr-2' })

  const all = pageOf(events, 5)
  assert.equal(all.more, false)
  assert.equal(all.nextCursor, undefined)
})

test('分页：末条没有时间戳时不给空游标，也不报 more', () => {
  // 没有 `at` 就编不出游标；报 more 会让界面显示一个点了没反应的「加载更早」。
  // 取一页时末条是拿不到 `at` 的那条（上游 `at` 缺失的行排在后面）。
  const events = toSourceEvents([
    { id: 'tr-b', source: 'fixture' },
    { id: 'tr-a', source: 'fixture', at: '2026-02-01T00:00:01Z' },
  ], new Map(), new Map())
  const page = pageOf(events, 1)
  assert.equal(page.items.length, 1)
  assert.equal(page.more, false)
  assert.equal(page.nextCursor, undefined)
})

let fixture: FixturePaths
let reader: ChainReader

before(() => {
  fixture = writeFixture(join(mkdtempSync(join(tmpdir(), 'sources-')), 'fixture'))
  reader = createReader({
    stateDir: fixture.stateDir,
    sessionQuery: {
      async readSession(sessionId: string) {
        const file = sessionFileOf(fixture.sessionsRoot, sessionId)
        return { events: file ? readSessionEvents(file) : [] }
      },
    },
    sourceDirectory: () => [
      { source: 'fixture', label: '夹具来源', installed: true, enabled: true },
      { source: 'github', label: 'GitHub', installed: true, enabled: false },
    ],
  })
})

test('夹具来源列表：计数、标题、装未用的来源', async () => {
  const items = await reader.listSources()
  const byName = new Map(items.map(item => [item.source, item]))
  const source = byName.get('fixture')!
  // 6 条触发：2 经裁定、1 直通、1 仅上下文、2 丢弃
  assert.equal(source.received, 6)
  assert.equal(source.tickets, 1)
  assert.deepEqual(source.counts, {
    routed: 2, direct: 1, context: 1, filtered: 2, requeued: 0, handback: 0, undecided: 0,
  })
  assert.equal(source.unrecorded, 0)
  assert.equal(source.label, '夹具来源')
  assert.equal(source.lastAt, '2026-02-01T00:00:35.000Z')

  const github = byName.get('github')!
  assert.equal(github.received, 0)
  assert.equal(github.enabled, false)
  assert.equal(github.label, 'GitHub')
})

test('事件分页：从新到旧、翻页不重复、不再有下一页时 more=false', async () => {
  const first = await reader.listSourceEvents('fixture', 2)
  assert.deepEqual(first.items.map(event => event.triggerId), ['tr-follow', 'tr-noise'])
  assert.equal(first.more, true)

  const second = await reader.listSourceEvents('fixture', 2, first.nextCursor)
  assert.deepEqual(second.items.map(event => event.triggerId), ['tr-filtered', 'tr-ctx'])
  assert.equal(second.more, true)

  const third = await reader.listSourceEvents('fixture', 5, second.nextCursor)
  assert.deepEqual(third.items.map(event => event.triggerId), ['tr-b2', 'tr-b1'])
  assert.equal(third.more, false)

  const seen = [...first.items, ...second.items, ...third.items].map(event => event.triggerId)
  assert.equal(new Set(seen).size, seen.length)
})

test('分类器与工单页的去向口径对得上（同一批事件、同一份数据）', async () => {
  const events = await reader.listSourceEvents('fixture', 50)
  const byTrigger = new Map(events.items.map(event => [event.triggerId, event.fate]))

  // 工单页的分类器：同一张工单的事件去向
  const dispositions = await reader.readDispositions(fixture.ticketId)
  const paths = dispositions.map(item => `${item.triggerId}:${item.path}`)

  // 有裁定的事件：两边都算「经主控」（工单页的路径名是 routed，来源页的 kind 也是 routed）
  assert.ok(paths.includes('tr-b1:routed'))
  assert.equal(byTrigger.get('tr-b1')?.kind, 'routed')
  // 只有 fanout、没有决定行：工单页 direct，来源页 direct
  assert.ok(paths.includes('tr-follow:direct'))
  assert.equal(byTrigger.get('tr-follow')?.kind, 'direct')
  // 仅上下文：两边都是 context
  assert.ok(paths.includes('tr-ctx:context'))
  assert.equal(byTrigger.get('tr-ctx')?.kind, 'context')
  // 源头丢弃：两边都是 filtered（tr-noise 不在这张工单的线程上，工单页不列）
  assert.ok(paths.includes('tr-filtered:filtered'))
  assert.equal(byTrigger.get('tr-filtered')?.kind, 'filtered')
  assert.equal(byTrigger.get('tr-noise')?.kind, 'filtered')
})
