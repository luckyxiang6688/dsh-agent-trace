/**
 * 来源页的**数据层口径**（静态夹具）：聚合、游标、配置并集、设置快照。
 *
 * 这里断言的是 SQL 的取数口径，不是界面：换一种写法没关系，
 * 但这些数字、顺序、并集必须一模一样。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../src/adapter/superagent/db.ts'
import { readPolicy } from '../src/service/policy.ts'
import type { StoreLike } from '../src/adapter/superagent/db.ts'
import { writeFixture, type FixturePaths } from './fixtures/second-source/fixture.ts'

let fixture: FixturePaths
let store: StoreLike

before(() => {
  fixture = writeFixture(join(mkdtempSync(join(tmpdir(), 'source-stats-')), 'fixture'))
  store = openStore(fixture.stateDir)!
})

test('来源聚合：去重后的事件数、最后活跃时刻', () => {
  const aggregates = store.sourceAggregates()
  assert.deepEqual(aggregates, [
    { source: 'fixture', received: 6, lastAt: '2026-02-01T00:00:35.000Z' },
  ])
})

test('事件行：新→旧，游标按 (at,id) 续，多取一行由上层判 more', () => {
  assert.deepEqual(
    store.sourceEventRows('fixture', 10).map(row => row.id),
    ['tr-follow', 'tr-noise', 'tr-filtered', 'tr-ctx', 'tr-b2', 'tr-b1'],
  )
  assert.deepEqual(
    store.sourceEventRows('fixture', 3, { at: '2026-02-01T00:00:20.000Z', id: 'tr-noise' }).map(row => row.id),
    ['tr-filtered', 'tr-ctx', 'tr-b2'],
  )
  // 别的来源没有事件，不串源
  assert.deepEqual(store.sourceEventRows('github', 10), [])
})

test('工单索引带上起点事件与来源；决定按 triggerIds 反查', () => {
  const tickets = store.ticketIndex()
  assert.equal(tickets.length, 1)
  assert.equal(tickets[0]!.id, fixture.ticketId)
  assert.equal(tickets[0]!.originTriggerId, 'tr-b1')
  assert.equal(tickets[0]!.source, 'fixture')
  assert.equal(tickets[0]!.title, '整理本周周报')

  assert.deepEqual(store.decisionsOfTrigger('tr-b1').map(decision => decision.id), ['dec-accept'])
  assert.deepEqual(store.decisionsOfTrigger('tr-b2').map(decision => decision.id), ['dec-accept'])
  // 没有裁定的触发：空数组，不是 undefined、也不报错
  assert.deepEqual(store.decisionsOfTrigger('tr-noise'), [])
})

test('按起点事件的来源查工单：过滤在 SQL 里做，不串源', () => {
  assert.deepEqual(store.ticketsBySource('fixture', 10).map(ticket => ticket.id), [fixture.ticketId])
  assert.deepEqual(store.ticketsBySource('github', 10), [])
})

test('配置里的来源取并集：settings.sources 与 policy.sources 都算', () => {
  const configured = store.configuredSources()
  const byName = new Map(configured.map(item => [item.source, item]))
  assert.equal(byName.get('fixture')?.enabled, true)
  assert.equal(byName.get('github')?.enabled, false)
})

test('设置快照与 readPolicy 同源：同一份快照 → 同一个 policyVersion 与发送者名单', () => {
  const snapshots = store.settingsSnapshots()
  assert.equal(snapshots.length, 1)
  assert.equal(snapshots[0]!.revision, 1)
  assert.equal(snapshots[0]!.policyVersion, 'pv-2')

  const policy = readPolicy(store)!
  assert.equal(policy.version, 'pv-2')
  assert.equal(policy.revision, 1)
  assert.deepEqual(policy.sendersOf('fixture'), ['u1'])
  assert.deepEqual(policy.enabledRules(), ['rule-a'])
  // 按版本取历史：拿得到的那份要一致，拿不到的不许退回最新
  assert.equal(policy.at('pv-2')?.version, 'pv-2')
  assert.equal(policy.at('pv-404'), undefined)
  // 快照的 savedAt 是策略的保存时间，不是「现在」
  assert.equal(policy.savedAt, '2026-02-01T00:00:00.000Z')
})

test('sourceLabels 是线程名映射，不是来源标题', () => {
  const labels = store.sourceLabels('fixture')
  assert.deepEqual(labels, { 't-1': '周报讨论' })
  assert.equal(store.sourceLabels('github'), undefined)
})

test('坏 JSON 的工单行只被跳过：按来源查询不抛错，好行照常返回', () => {
  // `json_extract` 碰到非法 JSON 会抛 malformed JSON。同一条查询里一条坏行
  // 就能让整个请求 500——不带 source 的列表靠 `rows()` 跳过坏行，带 source 的也要一样。
  const dir = mkdtempSync(join(tmpdir(), 'source-stats-bad-json-'))
  copyFileSync(join(fixture.stateDir, 'orchestrator.sqlite'), join(dir, 'orchestrator.sqlite'))
  const sqlite = new DatabaseSync(join(dir, 'orchestrator.sqlite'))
  sqlite.prepare('insert into ticket (id, value) values (?, ?)').run('t-bad-json', '{not json')
  sqlite.close()
  const copy = openStore(dir)!
  try {
    assert.deepEqual(copy.ticketsBySource('fixture', 10).map(ticket => ticket.id), [fixture.ticketId])
  } finally {
    copy.close()
  }
})

test('没有起点来源的工单：按来源查不到，不带来源仍能取到（左栏不显示它）', () => {
  // 迁移来的旧工单可能没有起点事件（`ticketIndex()` 注释里写着）。用库副本验证口径：
  // 不动共享夹具，免得别处的计数断言跟着变。
  const dir = mkdtempSync(join(tmpdir(), 'source-stats-no-origin-'))
  copyFileSync(join(fixture.stateDir, 'orchestrator.sqlite'), join(dir, 'orchestrator.sqlite'))
  const sqlite = new DatabaseSync(join(dir, 'orchestrator.sqlite'))
  sqlite.prepare('insert into ticket (id, value) values (?, ?)').run('t-no-origin', JSON.stringify({
    id: 't-no-origin',
    title: '旧工单（没有起点）',
    state: 'ended',
    createdAt: '2026-01-01T00:00:00.000Z',
    origin: { triggerId: '', triggerIds: [] },
  }))
  sqlite.close()
  const copy = openStore(dir)!
  try {
    // INNER JOIN 不命中：它不属于任何来源，左栏（永远带 source）看不到它。
    assert.deepEqual(copy.ticketsBySource('fixture', 10).map(ticket => ticket.id), [fixture.ticketId])
    // 但数据没丢：不带来源的列表仍取得到（API 的逃生口）。
    assert.ok(copy.tickets(10).some(ticket => ticket.id === 't-no-origin'))
  } finally {
    copy.close()
  }
})
