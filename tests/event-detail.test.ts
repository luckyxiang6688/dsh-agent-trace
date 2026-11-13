/**
 * 事件抽屉的三段：事实 / 解释 / 没记录的事实。
 *
 * 最要紧的一条：解释句绝不能混进事实。事实只写库里的字段；
 * 句子是查表来的，必须单独成段并标明「解释」。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, mkdtempSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSourceEventDetail } from '../src/service/sources.ts'
import { interpretDecisionKind, interpretFilteredCode } from '../src/service/explain.ts'
import { createReader } from '../src/service/reader.ts'
import { readPolicy } from '../src/service/policy.ts'
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

  // 没记录的事实必须点明：过滤只落码、没留设置快照，且发生在来源层（不是主控准入）
  assert.ok(detail.notRecorded.some(line => line.includes('设置快照')))
  assert.ok(detail.notRecorded.some(line => line.includes('来源层')))
  assert.ok(detail.notRecorded.some(line => line.includes('去重')))
})

test('来源自定义的码：解释里指明归谁定义，仍然不推测含义', () => {
  // 上游契约允许来源 scope 返回任意字面码（`core/reasons.ts` 注释明说），
  // 库里只有码。解释段必须说清「不知道」并指出该找谁，而不是含糊其辞。
  const text = interpretFilteredCode('no_task_prefix', 'wechat').text
  assert.match(text, /来源 wechat 的插件/)
  assert.match(text, /不做推测/)
  assert.match(text, /当时安装的那一版/)
  // 查表命中的码不受影响，也不该被加上「归来源定义」的话
  assert.ok(!interpretFilteredCode('no_mention', 'wechat').text.includes('来源 wechat'))
  // 只有码、不知道来源时也不能编一个来源出来
  assert.match(interpretFilteredCode('mystery').text, /产生它的来源插件/)
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
  assert.equal(factOf(detail, '裁定'), '拒绝（ignore）')
  assert.equal(factOf(detail, '策略版本'), 'pv-9')
  // `referenced` 不在上游 `Strength`（explicit/inferred）里，认不得就原样显示，不编中文。
  assert.equal(factOf(detail, '授权强度'), 'referenced')
  assert.equal(factOf(detail, '主控理由码'), '实现方向未定（directionUnsettled）')
  assert.equal(factOf(detail, '规则评估'), '2 条，命中 1 条')
  assert.ok(labels(detail).includes('授权依据'))

  assert.ok(detail.interpretations.some(item => item.label === '裁定 拒绝（ignore）'))
  assert.ok(detail.interpretations.some(item => item.label === '理由码 实现方向未定（directionUnsettled）'))
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
  assert.equal(factOf(detail, '主控理由码'), '原话（said）')
  // `said` 不当成解释：解释段里不该出现它。
  assert.ok(!detail.interpretations.some(item => item.label.includes('said')))
})

test('内部英文码统一成「中文（code）」：裁定/强度/理由/规则/准入依据都不再只给英文', () => {
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-i18n',
    trigger: trigger(),
    disposition: { id: 'tr-i18n', decisionId: 'dec-i18n' },
    decisions: [{
      id: 'dec-i18n',
      kind: 'accept',
      ticketId: 'ticket-9',
      reason: [{ code: 'explicitRouted' }],
      mandate: {
        strength: 'explicit',
        policyVersion: 'pv-i18n',
        scope: '改一下这一行的间距',
        basis: {
          via: 'admission', addressed: 'direct', cell: 'unlistedAddressed',
          sender: 'alice', rules: ['copy'], observation: { mode: 'observe' },
        },
      },
      audit: { rule_assessments: [{ rule_id: 'visual', matched: true }] },
    }],
    threads: [],
    tickets: [],
  })!

  assert.equal(factOf(detail, '裁定'), '接单（accept）')
  assert.equal(factOf(detail, '点名方式'), '提及（mention）')
  assert.equal(factOf(detail, '授权强度'), '明确（explicit）')
  assert.equal(factOf(detail, '主控理由码'), '明确点名直路由（explicitRouted）')
  assert.equal(
    factOf(detail, '授权依据'),
    '准入表放行（admission） · 直接点名（direct） · 名单外已点名（unlistedAddressed）'
      + ' · 发送者 alice · 命中规则 文案修正（copy） · 观察（observe）',
  )
  assert.equal(factOf(detail, '规则评估'), '1 条，命中 1 条')
})

test('认不得的码不编中文：自定义理由码/规则 id 原样显示，解释段明说不在表里', () => {
  const detail = buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-custom',
    trigger: trigger(),
    disposition: { id: 'tr-custom', decisionId: 'dec-custom' },
    decisions: [{
      id: 'dec-custom',
      kind: 'ignore',
      reason: [{ code: 'workspacePolicyV2' }],
      audit: { rule_assessments: [{ rule_id: 'my-custom-rule', matched: false }] },
    }],
    threads: [],
    tickets: [],
  })!

  assert.equal(factOf(detail, '主控理由码'), 'workspacePolicyV2')
  // 事件抽屉只给规则评估条数；逐条规则译名在工单评估块（`facts.ts`）里，见 facts.test.ts。
  assert.equal(factOf(detail, '规则评估'), '1 条，命中 0 条')
  const interpretation = detail.interpretations.find(item => item.label.includes('workspacePolicyV2'))
  assert.ok(interpretation)
  assert.match(interpretation!.text, /不做推测|不在本插件的解释表里/)
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
  assert.equal(factOf(routed, '裁定'), '接单（accept）')
  assert.equal(factOf(routed, '策略版本'), 'pv-2')
  assert.equal(factOf(routed, '主控理由码'), '明确点名直路由（explicitRouted）')
  // 策略快照按 policyVersion 精确回查：夹具里 pv-2 就是 revision 1 那份。
  assert.equal(factOf(routed, '当时名单'), 'u1')
  assert.equal(factOf(routed, '名单判定'), '在名单内')
  assert.equal(factOf(routed, '当时启用规则'), 'rule-a')
  assert.ok(!routed.notRecorded.some(line => line.includes('取不到策略版本')))
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

/**
 * P1：策略快照接进事件抽屉。
 *
 * 三条纪律：
 * 1. 按 `policyVersion` **精确**回查，回查的是「当时」的名单与规则，不是现在的；
 * 2. 回查不到就进「没记录的事实」，绝不拿最新一份顶替（那等于用今天的配置解释昨天的决定）；
 * 3. 事实行只写库里有的东西，「在名单内」这类判定也是由快照算出来的，进事实段。
 */
const snapshotOf = (
  revision: number,
  policyVersion: string,
  allowed: string[],
  rules: { id: string; enabled: boolean }[],
) => ({
  revision,
  savedAt: '2026-02-01T00:00:00Z',
  policyVersion,
  settings: { policy: { sources: { fixture: { allowed: allowed.map(id => ({ id })) } }, rules } },
})

const decisionWith = (policyVersion: string | undefined): RawDecision => ({
  id: 'dec-1', kind: 'accept', evalId: 'eval-1',
  ...(policyVersion ? { policyVersion } : {}),
  reason: [{ code: 'explicitRouted' }],
  mandate: { strength: 'referenced', ...(policyVersion ? { policyVersion } : {}), scope: 'thread' },
})

const drawerOf = (decision: RawDecision, policy: ReturnType<typeof readPolicy>, actor = 'u1') =>
  buildSourceEventDetail({
    source: 'fixture',
    triggerId: 'tr-1',
    trigger: trigger({ actor: { source: 'fixture', id: actor } }),
    disposition: { id: 'tr-1', decisionId: 'dec-1' },
    decisions: [decision],
    threads: [],
    tickets: [],
    ...(policy ? { policy } : {}),
  })!

test('策略快照按版本精确回查：当时名单、当时启用规则、发送者是否在名单里都进事实', () => {
  const policy = readPolicy({
    settingsSnapshots: () => [
      snapshotOf(2, 'pv-new', ['u9'], [{ id: 'r-new', enabled: true }]),
      snapshotOf(1, 'pv-9', ['u1', 'u2'], [{ id: 'r-1', enabled: true }, { id: 'r-2', enabled: false }]),
    ],
  })
  const detail = drawerOf(decisionWith('pv-9'), policy)

  assert.equal(factOf(detail, '策略版本'), 'pv-9')
  assert.equal(factOf(detail, '当时名单'), 'u1 · u2')
  assert.equal(factOf(detail, '名单判定'), '在名单内')
  // 停用的规则不算「启用中」
  assert.equal(factOf(detail, '当时启用规则'), 'r-1')
  assert.match(factOf(detail, '策略快照')!, /修订 1/)
  assert.ok(!detail.notRecorded.some(line => line.includes('取不到策略版本')))
})

test('回查不到该版本：不拿最新一份顶替，进「没记录的事实」', () => {
  const policy = readPolicy({
    settingsSnapshots: () => [snapshotOf(2, 'pv-new', ['u9'], [{ id: 'r-new', enabled: true }])],
  })
  const detail = drawerOf(decisionWith('pv-old'), policy)

  // 最新那份是 pv-new，但它不是这次裁定的版本：一行都不许写
  assert.ok(!labels(detail).includes('当时名单'))
  assert.ok(!labels(detail).includes('当时启用规则'))
  assert.ok(!labels(detail).includes('名单判定'))
  assert.ok(detail.notRecorded.some(line => line.includes('取不到策略版本')))
})

test('裁定没记策略版本：明说无法回查，而不是沉默', () => {
  const detail = drawerOf(decisionWith(undefined), undefined)
  assert.ok(!labels(detail).includes('当时名单'))
  assert.ok(detail.notRecorded.some(line => line.includes('没有记录可用的策略版本')))
})

test('发送者不在当时名单里：判「不在名单内」，且这一行是告警色', () => {
  const policy = readPolicy({
    settingsSnapshots: () => [snapshotOf(1, 'pv-9', ['u1'], [{ id: 'r-1', enabled: true }])],
  })
  const detail = drawerOf(decisionWith('pv-9'), policy, 'u9')

  assert.equal(factOf(detail, '名单判定'), '不在名单内')
  assert.equal(detail.facts.find(fact => fact.label === '名单判定')?.tone, 'warn')
})

test('设置保存后新版本立刻可查：不把读者创建时的缓存当成库里的真相', async () => {
  // 宿主是长生命周期进程，设置随时会被保存。若策略快照只在 createReader 时读一次，
  // 之后新存的版本会被误报成「库里没有该版本的设置快照」——那是假话。
  const dir = mkdtempSync(join(tmpdir(), 'policy-fresh-'))
  copyFileSync(join(fixture.stateDir, 'orchestrator.sqlite'), join(dir, 'orchestrator.sqlite'))
  const reader = createReader({ stateDir: dir })

  // 读者已建好之后再「保存设置」：新增一份快照，并把裁定指到新版本。
  const sqlite = new DatabaseSync(join(dir, 'orchestrator.sqlite'))
  sqlite.prepare('insert into kv (key, value) values (?, ?)').run(
    'settings-version:7',
    JSON.stringify(snapshotOf(7, 'pv-7', ['u1'], [{ id: 'r-7', enabled: true }])),
  )
  const row = sqlite.prepare("select value from decision where id = 'dec-accept'").get() as { value: string }
  const decision = JSON.parse(row.value)
  decision.policyVersion = 'pv-7'
  if (decision.mandate) decision.mandate.policyVersion = 'pv-7'
  sqlite.prepare("update decision set value = ? where id = 'dec-accept'").run(JSON.stringify(decision))
  sqlite.close()

  const detail = (await reader.readSourceEvent('fixture', 'tr-b1'))!
  assert.equal(factOf(detail, '策略版本'), 'pv-7')
  assert.equal(factOf(detail, '当时启用规则'), 'r-7')
  assert.ok(!detail.notRecorded.some(line => line.includes('取不到策略版本')))
})

test('版本只记在 mandate 上也能回查（不依赖顶层字段）', () => {
  const policy = readPolicy({
    settingsSnapshots: () => [snapshotOf(3, 'pv-m', ['u1'], [{ id: 'r-3', enabled: true }])],
  })
  const decision: RawDecision = {
    id: 'dec-1', kind: 'accept', evalId: 'eval-1',
    mandate: { strength: 'referenced', policyVersion: 'pv-m', scope: 'thread' },
    reason: [],
  }
  const detail = drawerOf(decision, policy)
  assert.equal(factOf(detail, '策略版本'), 'pv-m')
  assert.equal(factOf(detail, '当时启用规则'), 'r-3')
})

test('名单为空：明说是空，而不是含糊的「不在名单内」', () => {
  const policy = readPolicy({
    settingsSnapshots: () => [snapshotOf(1, 'pv-empty', [], [{ id: 'r-1', enabled: true }])],
  })
  const detail = drawerOf(decisionWith('pv-empty'), policy)
  assert.equal(factOf(detail, '当时名单'), '名单为空：没有发送者在准入名单内')
  assert.equal(factOf(detail, '名单判定'), '不在名单内')
})

test('名单比较忽略大小写：上游放行的人不能被说成不在名单内', () => {
  // 上游 `sameName` 是 toLowerCase 比较（vendor `src/infra/text.ts:19`）。
  const policy = readPolicy({
    settingsSnapshots: () => [snapshotOf(1, 'pv-9', ['Alice'], [{ id: 'r-1', enabled: true }])],
  })
  const detail = drawerOf(decisionWith('pv-9'), policy, 'alice')
  assert.equal(factOf(detail, '当时名单'), 'Alice')
  assert.equal(factOf(detail, '名单判定'), '在名单内')
})

test('同一 policyVersion 有多份保存：取最早那份（内容开始生效的时刻）', () => {
  const policy = readPolicy({
    settingsSnapshots: () => [
      snapshotOf(9, 'pv-1', ['u1'], [{ id: 'r-1', enabled: true }]),
      snapshotOf(1, 'pv-1', ['u1'], [{ id: 'r-1', enabled: true }]),
    ],
  })
  const detail = drawerOf(decisionWith('pv-1'), policy)
  assert.match(factOf(detail, '策略快照')!, /修订 1/)
})

test('坏形状的快照不抛错，也不冒充空名单：allowed 不是数组就明说读不出', () => {
  // 迁移代码会把解析失败的历史修订原样保留，所以库里可能有坏形状。
  // 抛出去就是事件详情 500（失败隔离是硬约束）；
  // 按空名单处理则是撒谎——「读不出」和「谁都不准入」是两件事。
  const broken = {
    revision: 1, savedAt: '2026-02-01T00:00:00Z', policyVersion: 'pv-9',
    settings: { policy: { sources: { fixture: { allowed: { broken: true } as never } }, rules: [] } },
  }
  const policy = readPolicy({ settingsSnapshots: () => [broken] })!
  const detail = drawerOf(decisionWith('pv-9'), policy)
  assert.equal(factOf(detail, '当时名单'), '该版本的名单字段形状异常，读不出')
  assert.equal(detail.facts.find(fact => fact.label === '当时名单')?.tone, 'warn')
  assert.equal(factOf(detail, '名单判定'), '名单读不出，无法判断')
  assert.equal(factOf(detail, '当时启用规则'), '没有启用中的规则')
})

test('规则字段坏形状同样明说读不出，不冒充「没有启用中的规则」', () => {
  for (const rules of [{ bad: 1 }, [null]]) {
    const broken = {
      revision: 1, savedAt: '2026-02-01T00:00:00Z', policyVersion: 'pv-r',
      settings: { policy: { sources: { fixture: { allowed: [{ id: 'u1' }] } }, rules: rules as never } },
    }
    const policy = readPolicy({ settingsSnapshots: () => [broken] })!
    const detail = drawerOf(decisionWith('pv-r'), policy)
    // `rules: [null]` 是数组，但里面没有可用的规则对象 → 空列表，不是「读不出」。
    const expected = Array.isArray(rules) ? '没有启用中的规则' : '该版本的规则字段形状异常，读不出'
    assert.equal(factOf(detail, '当时启用规则'), expected, JSON.stringify(rules))
    // 名单字段本身是好的，不能被规则的坏形状连累。
    assert.equal(factOf(detail, '当时名单'), 'u1', JSON.stringify(rules))
  }
})

test('版本不是字符串（历史坏形状）：原样显示，但不当成可回查的版本', () => {
  const decision = { ...decisionWith(undefined), policyVersion: 123 } as unknown as RawDecision
  const detail = drawerOf(decision, undefined)
  assert.equal(factOf(detail, '策略版本'), '123')
  assert.ok(!labels(detail).includes('当时名单'))
  assert.ok(detail.notRecorded.some(line => line.includes('没有记录可用的策略版本')))
})

test('库里出现坏形状的策略快照：事件详情照常返回，不变成 500', async () => {
  // 复核给的复现：往夹具库插一条 `policyVersion` 与裁定相同、但 `allowed` 不是数组的快照行。
  // 迁移代码会把解析失败的历史修订原样保留，所以这种行有合法来源。
  const dir = mkdtempSync(join(tmpdir(), 'policy-broken-'))
  copyFileSync(join(fixture.stateDir, 'orchestrator.sqlite'), join(dir, 'orchestrator.sqlite'))
  const sqlite = new DatabaseSync(join(dir, 'orchestrator.sqlite'))
  sqlite.prepare('insert into kv (key, value) values (?, ?)').run(
    'settings-version:99',
    JSON.stringify({
      revision: 0, savedAt: '2026-01-01T00:00:00Z', policyVersion: 'pv-2',
      settings: { sources: {}, policy: { sources: { fixture: { allowed: { broken: true } } }, rules: [] } },
    }),
  )
  sqlite.close()

  const reader = createReader({ stateDir: dir })
  const detail = (await reader.readSourceEvent('fixture', 'tr-b1'))!
  assert.equal(factOf(detail, '裁定'), '接单（accept）')
  assert.equal(factOf(detail, '当时名单'), '该版本的名单字段形状异常，读不出')
})
