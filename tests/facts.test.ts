import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gateFacts } from '../src/service/facts.ts'
import { eventFactsOf } from '../src/service/reader.ts'
import { PROSE_PREVIEW_CHARS } from '../src/domain/model.ts'
import type { PolicySnapshot, PolicyView } from '../src/service/policy.ts'
import type { RawDecision, RawTrigger } from '../src/adapter/superagent/db.ts'
import type { StoreLike } from '../src/adapter/superagent/db.ts'

const view = (savedAt: string, senders: string[] = ['alice']): PolicyView => ({
  sendersOf: () => senders,
  // 与上游同口径：忽略大小写。
  allows: (_source: string, id: string) => senders.some(allowed => allowed.toLowerCase() === id.toLowerCase()),
  enabledRules: () => ['copy', 'visual'],
  savedAt,
  version: 'v2',
  revision: 2,
})

const older = view('2026-01-01T00:00:00Z', [])
const latest = view('2026-02-01T00:00:00Z', ['alice'])

const policy: PolicySnapshot = {
  ...latest,
  latest: () => latest,
  // 版本 v1 时 alice 还不在名单里——历史快照必须按版本取，不能拿最新冒充
  at: version => (version === 'v1' ? older : version === 'v2' ? latest : undefined),
}

const trigger: RawTrigger = {
  id: 't1', source: 'demo', at: '2026-01-02T00:00:00Z', text: '请修一下',
  actor: { id: 'alice' }, human: true, addressed: 'mention',
  threads: [{ source: 'demo', id: 'demo:thread-1' }],
}

const decision = (extra: Partial<RawDecision> = {}): RawDecision => ({
  id: 'd1', kind: 'accept', strength: 'explicit', at: '2026-01-02T00:01:00Z',
  ticketId: 'ticket-1', triggerIds: ['t1'], policyVersion: 'v2',
  mandate: { strength: 'explicit', policyVersion: 'v2', basis: { via: 'addressed', sender: 'alice', addressed: 'mention' } },
  ...extra,
})

test('准入依据读 mandate.basis，并按 policyVersion 回查当时快照', () => {
  const rows = gateFacts(decision(), trigger, policy, 'ticket-1')
  const gate = rows.filter(row => row.group === 'gate')
  assert.equal(gate.find(row => row.label === '准入依据')?.value, '点名且名单内（addressed）')
  assert.match(gate.find(row => row.label === '发送者')?.value ?? '', /在名单内/)
  assert.equal(gate.find(row => row.label === '策略版本')?.tone, 'ok')
})

test('评估抽屉先回答从哪来 / 属于谁：主控会话、评估对象、产出工单', () => {
  const rows = gateFacts(decision(), trigger, policy, 'ticket-1', undefined, 'orchestrator-abc')
  assert.deepEqual(rows.filter(row => row.group === 'meta').map(row => [row.label, row.value]), [
    ['评估会话', '主控会话 orchestrator-abc'],
    ['评估对象', '事件 Trigger t1'],
    ['产出', '工单 Ticket ticket-1'],
  ])
})

test('主控会话读不到时写「未记录」，不编造 id；批量事件报条数', () => {
  const rows = gateFacts(decision({ triggerIds: ['t1', 't2', 't3'] }), trigger, policy, 'ticket-1')
  const meta = new Map(rows.filter(row => row.group === 'meta').map(row => [row.label, row.value]))
  assert.equal(meta.get('评估会话'), '主控会话（未记录）')
  assert.equal(meta.get('评估对象'), '事件 Trigger t1 等 3 条')
})

test('没有工单的决定（ignore）不冒充产出；路由决定用完整 id 并带 Ticket', () => {
  const rows = gateFacts({ id: 'd2', kind: 'ignore', strength: 'inferred', triggerIds: ['t1'] }, trigger, policy, 'ticket-1')
  assert.equal(rows.find(row => row.label === '产出')?.value, '没有工单：不接（ignore）')
  // accept 的产出认它自己造出来的那张工单，不跟着页面参数走
  const accepted = gateFacts(decision(), trigger, policy, 'another-ticket')
  assert.equal(accepted.find(row => row.label === '产出')?.value, '工单 Ticket ticket-1')
  const accept = gateFacts(decision(), trigger, policy, 'c5faef17fff20441f4b105b70f265c13')
  assert.match(accept.find(row => row.label === '路由决定')?.value ?? '', /工单 Ticket c5faef17fff20441f4b105b70f265c13/)
})

test('addressed=mention 也算点名，不再显示「未点名」', () => {
  const rows = gateFacts(decision(), trigger, policy, 'ticket-1')
  assert.equal(rows.find(row => row.label === '点名')?.value, '@提及智能体（算点名）')
  assert.ok(!rows.some(row => row.label === '点名' && /未点名/.test(row.value)))
})

test('ignore 没有 mandate：只给结果与强度，不伪造准入表', () => {
  const rows = gateFacts({
    id: 'd2', kind: 'ignore', strength: 'inferred', triggerIds: ['t1'],
    reason: [{ code: 'said', values: { text: '证据不足' } }],
    audit: { rule_assessments: [{ rule_id: 'copy', matched: false, reason: '没有具体错字' }] },
  }, trigger, policy, 'ticket-1')
  assert.equal(rows.find(row => row.label === '准入结果')?.value, '未接单 · 不接（ignore）')
  assert.equal(rows.find(row => row.label === '准入依据'), undefined)
  assert.equal(rows.find(row => row.label === '决定')?.tone, 'warn')
  assert.equal(rows.find(row => row.label === '理由')?.value, '证据不足')
})

test('研判理由与证据归入 assessment 分组，不再落进资格 Gate', () => {
  const rows = gateFacts(decision({
    audit: {
      rule_assessments: [{ rule_id: 'copy', matched: false, reason: '没有可改的字' }],
      direction: { evidence: '只有一句转述' },
    },
  }), trigger, policy, 'ticket-1')
  for (const label of ['研判', '研判理由', '证据']) {
    assert.equal(rows.find(row => row.label === label)?.group, 'assessment', label)
  }
  assert.equal(rows.find(row => row.label === '研判')?.tone, 'warn')
  // 内置规则 id 译成「中文（code）」；自定义 id 原样，不编中文。
  assert.equal(rows.find(row => row.label === '研判')?.value, '文案修正（copy） 未命中')
})

test('名单判定用 actor id，不用显示名：basis.sender 是名字时不能误判为不在名单内', () => {
  // 上游 `basis.sender` 是 `entry.name || entry.id`，可能是个显示名；
  // 拿显示名去比 id 名单，会把上游放行的人说成「不在名单内」，和 accept 自相矛盾。
  const rows = gateFacts(decision({
    mandate: {
      strength: 'explicit', policyVersion: 'v2',
      basis: { via: 'addressed', sender: '张三（显示名）', addressed: 'mention' },
    },
  }), trigger, policy, 'ticket-1')   // trigger.actor.id = 'alice'，在名单里
  const row = rows.find(item => item.label === '发送者')!
  assert.equal(row.value, '张三（显示名） · 在名单内')
  assert.equal(row.tone, 'ok')
})

test('名单字段读不出时不冒充「不在名单内」', () => {
  const unreadable: PolicyView = { ...latest, sendersOf: () => undefined, allows: () => false }
  const snapshot: PolicySnapshot = { ...unreadable, latest: () => unreadable, at: () => unreadable }
  const row = gateFacts(decision(), trigger, snapshot, 'ticket-1').find(item => item.label === '发送者')!
  assert.match(row.value, /名单不可得/)
  assert.equal(row.tone, 'muted')
})

test('历史版本查不到时不冒充最新策略', () => {
  const rows = gateFacts(decision({
    policyVersion: 'v0',
    mandate: { strength: 'explicit', policyVersion: 'v0', basis: { via: 'addressed', sender: 'alice' } },
  }), trigger, policy, 'ticket-1')
  assert.match(rows.find(row => row.label === '策略版本')?.value ?? '', /当时快照不可得/)
  assert.match(rows.find(row => row.label === '发送者')?.value ?? '', /名单不可得/)
})

test('长自由文本只回预览并挂全文 id，不再整段塞进抽屉', () => {
  // 授权范围可以是整段任务陈述，研判理由/证据也可能是上千字英文：
  // `value` 只能是预览，全文按 `span/decision-<id>/facts/<key>` 另取。
  const scope = '整理本周周报并写入 doc/weekly.md。'.repeat(80)      // 2400 字
  const reason = 'reason '.repeat(400)                                 // 2800 字
  const sink = new Map<string, string>()
  const rows = gateFacts(decision({
    mandate: {
      strength: 'explicit',
      policyVersion: 'v2',
      basis: { via: 'addressed', sender: 'alice', scope },
    },
    audit: {
      rule_assessments: [{ rule_id: 'copy', matched: false, reason }],
      direction: { evidence: reason },
    },
  }), trigger, policy, 'ticket-1', sink)

  const scopeRow = rows.find(row => row.label === '授权范围')!
  assert.equal(scopeRow.value.length, PROSE_PREVIEW_CHARS)
  assert.equal(scopeRow.prose?.length, scope.length)
  assert.equal(scopeRow.prose?.id, 'span/decision-d1/facts/scope')
  assert.equal(sink.get('span/decision-d1/facts/scope'), scope)

  for (const [label, key] of [['研判理由', 'reason'], ['证据', 'evidence']]) {
    const row = rows.find(item => item.label === label)!
    assert.equal(row.value.length, PROSE_PREVIEW_CHARS, label)
    assert.equal(row.prose?.length, reason.length, label)
    assert.equal(row.prose?.id, `span/decision-d1/facts/${key}`, label)
    assert.equal(sink.get(`span/decision-d1/facts/${key}`), reason, label)
  }
})

test('结束事件标题带完整工单 id 与 Ticket，不是单独一个「Ticket」', () => {
  const store = {
    ticket: () => ({ ended: { at: '2026-01-01T00:00:00Z', by: 'master', outcome: 'completed' } }),
  } as unknown as StoreLike
  const facts = eventFactsOf(store, 'c5faef17fff20441f4b105b70f265c13', 'event-ended')
  assert.equal(facts?.title, '工单 Ticket c5faef17fff20441f4b105b70f265c13 · 结束')
})

test('离散事件的长问题同样只回预览，id 对得上 span', () => {
  const question = '为什么这一步不能直接写文件？'.repeat(200)          // 2800 字
  // 只用到 ticket() 一个方法，其余字段与事件抽屉无关
  const store = { ticket: () => ({ attention: { question } }) } as unknown as StoreLike
  const sink = new Map<string, string>()
  const facts = eventFactsOf(store, 't1', 'event-attention', sink)?.facts ?? []
  const row = facts.find(item => item.label === '问题')!
  assert.equal(row.value.length, PROSE_PREVIEW_CHARS)
  assert.equal(row.prose?.length, question.length)
  assert.equal(row.prose?.id, 'span/event-attention/facts/question')
  assert.equal(sink.get('span/event-attention/facts/question'), question)
})
