/**
 * 第二来源夹具：一个**不是 demo** 的来源（`fixture`），用来证明视图是按数据推导的。
 *
 * 它和 demo 的差别全在数据里，不在代码里：
 *   - 来源不提供回复通道（`ticket.channels` 为空）→ 不该画「确认收到 / 回复」
 *   - 点名方式是 `mention`（@ 提及）→ 也算点名，不再是「未点名」
 *   - batch：两条触发合成一张工单 → 两支事件箭头
 *   - context-only：只作上下文送达 → 单列一类，不算直通
 *   - filtered：源头丢弃的事件 → 比例带计数，图上没有连接点
 *   - blocked → 人跟进 → retry → ready → ended 的完整状态带
 *
 * 产物是两个真实形状的东西：上游的 sqlite（`orchestrator.sqlite`）与多帧 zstd 会话日志。
 * 不依赖任何线上数据，`writeFixture()` 每次重建，测试之间互不影响。
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { zstdCompressSync } from 'node:zlib'

export interface FixturePaths {
  readonly root: string
  /** 与线上一致：`<root>/state/superagent`。 */
  readonly stateDir: string
  /** 与线上一致：`<root>/sessions`（stateDir 往上两级）。 */
  readonly sessionsRoot: string
  readonly ticketId: string
  readonly workerSessionId: string
  readonly routerSessionId: string
}

const START = '2026-02-01T00:00:00Z'
const T = (seconds: number): string => new Date(Date.parse(START) + seconds * 1000).toISOString()

const DDL = [
  'create table kv (key text primary key, value text not null)',
  'create table trigger (id text primary key, value text not null, at text not null)',
  'create table disposition (id text primary key, value text not null)',
  'create table thread (key text primary key, value text not null)',
  'create table ticket (id text primary key, value text not null)',
  'create table decision (id text primary key, thread text not null, value text not null)',
  'create table outbox (id text primary key, value text not null)',
]

const TICKET = 'ticket-fixture'
const WORKER = `worker-${TICKET}`
const ROUTER = 'orchestrator-fixture'
const THREAD = 'fixture:t-1'

/** 一次真实的长时间推理：>200 字，用来验证长正文仍走「预览 + 按 id 取全文」（单测断言）。 */
const LONG_THOUGHT = [
  '先确认共享盘里有哪些数据：只有模板就按模板填，有原始表格就汇总成段落。',
  '第二步检查目标目录是否可写，避免写到一半失败；同时核对日期范围是否覆盖本周一到周日。',
  '第三步把结果贴回工单，说明数据来源、缺口与下一步建议；缺数据的部分不臆造，也不留空。',
  '最后再读一遍生成的文件，确认标题层级、表格与链接都能正常打开。',
  '如果共享盘里本周还没有数据，就把「缺数据」写清楚并停下来等人补充，而不是自己编一份。',
  '每一步的结论都要能指回原始文件，方便复核时逐条对照。',
].join('')

const trigger = (id: string, seconds: number, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  source: 'fixture',
  at: T(seconds),
  text,
  addressed: 'mention',
  human: true,
  threads: [{ source: 'fixture', id: 't-1' }],
  actor: { source: 'fixture', id: 'u1' },
  meta: {},
  ...extra,
})

const triggers = [
  trigger('tr-b1', 0, '帮我整理这周的周报'),
  trigger('tr-b2', 0.4, '顺便补上上周的对比'),
  trigger('tr-ctx', 5, '（参考）相关文档在 doc/weekly.md'),
  trigger('tr-filtered', 10, '群里有人提到：登录页那个错别字还没改'),
  // 与上一条同文案、同原因码，差别只在 `meta.noisy`：
  // 抽屉必须按数据说话（元数据里写着 noisy），不能凭文案猜「为什么被丢弃」。
  trigger('tr-noise', 20, '（噪音）登录页那个错别字还没改', { meta: { noisy: true } }),
  trigger('tr-follow', 35, '数据在共享盘，先按那个整理'),
]

const dispositions = [
  { id: 'tr-b1', value: { at: T(0.5), decisionId: 'dec-accept', fanout: [TICKET] } },
  { id: 'tr-b2', value: { at: T(0.6), decisionId: 'dec-accept', fanout: [TICKET] } },
  { id: 'tr-ctx', value: { at: T(5), context: [TICKET] } },
  { id: 'tr-filtered', value: { at: T(10), filtered: { code: 'no_mention' } } },
  { id: 'tr-noise', value: { at: T(20), filtered: { code: 'no_mention' } } },
  { id: 'tr-follow', value: { at: T(35), fanout: [TICKET] } },
]

const decisions = [
  {
    id: 'dec-accept',
    thread: THREAD,
    value: {
      id: 'dec-accept',
      kind: 'accept',
      at: T(0.5),
      ticketId: TICKET,
      threadKey: THREAD,
      triggerIds: ['tr-b1', 'tr-b2'],
      policyVersion: 'pv-2',
      strength: 'explicit',
      mandate: {
        strength: 'explicit',
        policyVersion: 'pv-2',
        basis: { via: 'addressed', addressed: 'mention' },
        actor: { source: 'fixture', id: 'u1' },
        scope: 'thread',
      },
      reason: [{ code: 'explicitRouted' }],
    },
  },
]

const ticket = {
  id: TICKET,
  title: '整理本周周报',
  createdAt: T(0),
  updatedAt: T(96),
  decisionId: 'dec-accept',
  mandate: {
    strength: 'explicit',
    policyVersion: 'pv-2',
    basis: { via: 'addressed', addressed: 'mention' },
    actor: { source: 'fixture', id: 'u1' },
    scope: 'thread',
  },
  // 关键：这个来源没有回复通道
  channels: [],
  origin: { triggerId: 'tr-b1', triggerIds: ['tr-b1', 'tr-b2'] },
  assignments: [
    {
      id: 'a1', state: 'ended', createdAt: T(2), startedAt: T(3), endedAt: T(34), endedReason: 'retried',
      report: { state: 'blocked', at: T(30), summary: '缺数据来源，无法整理' },
    },
    {
      id: 'a2', state: 'ended', createdAt: T(40), startedAt: T(41), endedAt: T(95),
      report: { state: 'ready', at: T(80), summary: '周报已整理并保存到 doc/weekly.md' },
    },
  ],
  inputs: [
    { id: 'i1', kind: 'trigger', text: '帮我整理这周的周报', triggerId: 'tr-b1', at: T(0), human: true },
    { id: 'i2', kind: 'trigger', text: '顺便补上上周的对比', triggerId: 'tr-b2', at: T(0.4), human: true },
    { id: 'i3', kind: 'trigger', text: '（参考）相关文档在 doc/weekly.md', triggerId: 'tr-ctx', at: T(5), human: true, context: true },
    { id: 'i4', kind: 'trigger', text: '数据在共享盘，先按那个整理', triggerId: 'tr-follow', at: T(35), human: true },
    { id: 'i5', kind: 'resumed', at: T(40) },
  ],
  attention: null,
  answers: [],
  delivery: null,
  follows: [],
  ended: { at: T(95), by: 'executor', outcome: 'completed' },
  execution: { name: 'fixture-executor', assignment: 'a2' },
}

const thread = {
  key: THREAD,
  ref: { source: 'fixture', id: 't-1' },
  createdAt: T(0),
  lastAt: T(35),
  subscriptions: [TICKET],
  meta: { title: '周报' },
}

/** 会话日志：header 与每条事件各占一帧（线上格式）。 */
function writeSession(
  sessionsRoot: string,
  workspace: string,
  id: string,
  header: Record<string, unknown>,
  events: readonly Record<string, unknown>[],
): void {
  const dir = join(sessionsRoot, workspace, id)
  mkdirSync(dir, { recursive: true })
  const frames = [
    JSON.stringify({ type: 'session', id, ...header }),
    ...events.map(event => JSON.stringify(event)),
  ].map(line => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

/** 建一套完整的第二来源夹具，返回各路径。已存在的目录会被清掉。 */
export function writeFixture(root: string): FixturePaths {
  rmSync(root, { recursive: true, force: true })
  const stateDir = join(root, 'state', 'superagent')
  const sessionsRoot = join(root, 'sessions')
  mkdirSync(stateDir, { recursive: true })
  mkdirSync(sessionsRoot, { recursive: true })

  const db = new DatabaseSync(join(stateDir, 'orchestrator.sqlite'))
  for (const sql of DDL) db.exec(sql)
  db.prepare('insert into kv (key, value) values (?, ?)').run('master-id', JSON.stringify(ROUTER))
  // 设置快照：来源启用状态 + 策略历史（`readPolicy(store)` 的唯一数据源）。
  db.prepare('insert into kv (key, value) values (?, ?)').run('settings-version:1', JSON.stringify({
    revision: 1,
    savedAt: T(0),
    policyVersion: 'pv-2',
    settings: {
      sources: { fixture: { enabled: true }, github: { enabled: false } },
      policy: {
        sources: { fixture: { allowed: [{ id: 'u1' }] } },
        rules: [{ id: 'rule-a', enabled: true }, { id: 'rule-b', enabled: false }],
      },
    },
  }))
  // 线程显示名（**不是**来源标题）：只有线程 id → 名的映射。
  db.prepare('insert into kv (key, value) values (?, ?)').run('source-labels:fixture',
    JSON.stringify({ 't-1': '周报讨论' }))
  const put = (table: 'disposition' | 'ticket' | 'thread' | 'decision', key: string, value: unknown, threadKey = ''): void => {
    if (table === 'thread') {
      db.prepare('insert into thread (key, value) values (?, ?)').run(key, JSON.stringify(value))
      return
    }
    if (table === 'decision') {
      db.prepare('insert into decision (id, thread, value) values (?, ?, ?)').run(key, threadKey, JSON.stringify(value))
      return
    }
    db.prepare(`insert into ${table} (id, value) values (?, ?)`).run(key, JSON.stringify(value))
  }
  for (const item of triggers) {
    db.prepare('insert into trigger (id, value, at) values (?, ?, ?)').run(item.id, JSON.stringify(item), item.at)
  }
  for (const item of dispositions) put('disposition', item.id, item.value)
  for (const item of decisions) put('decision', item.id, item.value, item.thread)
  put('ticket', ticket.id, ticket)
  put('thread', thread.key, thread)
  db.close()

  // 主控会话：受理这一单的那次评估（按 trigger id 定位，不靠「最新」）
  writeSession(sessionsRoot, 'ws', ROUTER, { createdAt: Date.parse(T(0)) }, [
    { type: 'assistant/message', time: Date.parse(T(0.3)), data: { text: '这是点名请求，直接路由。' } },
    { type: 'tool/call', time: Date.parse(T(0.5)), data: { name: 'orchestrator_eval', arguments: JSON.stringify({ trigger_id: 'tr-b1' }) } },
    { type: 'tool/result', time: Date.parse(T(0.6)), data: { message: { content: [{ type: 'text', text: 'accepted' }] } } },
  ])

  // 执行器会话：确实是 `worker-<ticketId>`；两次派工各有一轮工具调用。
  // 成功返回里埋一个哨兵串：抽屉响应与缓存里都不许出现它（B9：返回正文不再展示）。
  writeSession(sessionsRoot, 'ws', WORKER, {
    createdAt: Date.parse(T(2)),
    // 线上真实 header 就带这个字段：运行方（DSH 的 agent preset），不是模型。
    agentPreset: 'dsh-superagent-worker',
  }, [
    { type: 'user/message', time: Date.parse(T(2)), data: { text: '帮我整理这周的周报' } },
    // 模型在会话事件里：请求头 + 请求上下文（线上三处冗余，取任一处都能复原）
    { type: 'request/header', time: Date.parse(T(2)), data: {
      header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high', maxTokens: 256000 } },
    } },
    { type: 'request/context', time: Date.parse(T(2)), data: {
      provider: 'deepseek-account', model: 'deepseek-flash', contextWindow: 1048576,
    } },
    { type: 'assistant/message', time: Date.parse(T(3)), data: { text: '先找数据来源。' } },
    { type: 'tool/call', time: Date.parse(T(4)), data: { step: 0, name: 'bash', arguments: JSON.stringify({ command: 'ls doc' }) } },
    { type: 'tool/result', time: Date.parse(T(5)), data: { message: { content: [{ type: 'text', text: 'weekly.md ticket-sentinel-success' }] } } },
    { type: 'tool/call', time: Date.parse(T(20)), data: { step: 1, name: 'orchestrator_report', arguments: JSON.stringify({ state: 'blocked', summary: '缺数据来源，无法整理' }) } },
    // 长想法：>200 字，E2E 的「展开原文」要有可展开的正文（工具返回已不再提供原文）
    { type: 'assistant/message', time: Date.parse(T(42)), data: { text: LONG_THOUGHT } },
    { type: 'tool/call', time: Date.parse(T(43)), data: { step: 0, name: 'write', arguments: JSON.stringify({ path: 'doc/weekly.md' }) } },
    // 真实上游的 error 是对象；正文是错误堆栈，只有失败才允许展开
    { type: 'tool/result', time: Date.parse(T(44)), data: {
      error: { name: 'ToolError', code: 'EACCES', reason: 'disk full' },
      message: { isError: true, content: [{ type: 'text', text: `write failed: EACCES: permission denied\n${'    at fs.writeFileSync (node:fs:1:1)\n'.repeat(12)}` }] },
    } },
    { type: 'tool/call', time: Date.parse(T(60)), data: { step: 1, name: 'bash', arguments: JSON.stringify({ command: 'rm -rf tmp/*' }) } },
    { type: 'tool/result', time: Date.parse(T(61)), data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
  ])

  // 子代理：只认 origin=subagent，父会话是执行器
  writeSession(sessionsRoot, 'ws', 'child-fixture', {
    parentSession: WORKER, origin: 'subagent', delegationDepth: 1, createdAt: Date.parse(T(10)),
    // 子代理跑在 DSH 的 standard preset 上，模型也从它自己的会话事件里读。
    agentPreset: 'standard',
  }, [
    { type: 'user/message', time: Date.parse(T(10)), data: { text: '看一下共享盘有哪些数据' } },
    // 故意用一个与父会话不同的模型：证明读的是子会话，不是父会话的模型
    { type: 'request/header', time: Date.parse(T(10)), data: {
      header: { config: { provider: 'deepseek-account', model: 'deepseek-reasoner', reasoningEffort: 'medium' } },
    } },
    { type: 'assistant/message', time: Date.parse(T(20)), data: { text: '共享盘里有 3 份数据。' } },
  ])

  return {
    root,
    stateDir,
    sessionsRoot,
    ticketId: TICKET,
    workerSessionId: WORKER,
    routerSessionId: ROUTER,
  }
}
