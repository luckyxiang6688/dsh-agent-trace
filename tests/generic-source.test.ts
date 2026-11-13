/**
 * 通用性验证：整套读取链路跑在**第二个来源**的静态夹具上。
 * 这个来源没有回复通道、点名用 @、有 batch / context-only / filtered / blocked→retry。
 * 视图不该为它写任何特例——下面断言的都是「数据推到哪，图就画到哪」。
 */
import { before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeFixture, type FixturePaths } from './fixtures/second-source/fixture.ts'
import { createReader } from '../src/service/reader.ts'
import { readSessionEvents as readSessionEventsFromFile, sessionFileOf } from '../src/adapter/session/children.ts'
import { present } from '../src/presenter/swimlane.ts'
import type { ChainReader } from '../src/domain/model.ts'

let fixture: FixturePaths
let reader: ChainReader

before(() => {
  fixture = writeFixture(join(mkdtempSync(join(tmpdir(), 'fixture-source-')), 'fixture'))
  reader = createReader({
    stateDir: fixture.stateDir,
    sessionQuery: {
      async readSession(sessionId: string) {
        const file = sessionFileOf(fixture.sessionsRoot, sessionId)
        return { events: file ? readSessionEventsFromFile(file) : [] }
      },
    },
  })
})

test('列表与链路来自夹具，来源名就是数据里的 id', async () => {
  const items = await reader.listChains(10)
  assert.equal(items.length, 1)
  assert.equal(items[0]!.ticketId, fixture.ticketId)
  assert.equal(items[0]!.state, '已结束 · 完成（completed）')
  assert.ok(items[0]!.summary?.startsWith('fixture'))

  const chain = (await reader.readChain(fixture.ticketId))!
  assert.equal(chain.source, 'fixture')
  assert.equal(chain.stageTag, 'ended')
  // 来源没有回复通道：视图据此不画确认/回复
  assert.equal(chain.canReply, false)
  // batch：两条触发
  assert.deepEqual(chain.origins?.map(origin => origin.triggerId), ['tr-b1', 'tr-b2'])
})

test('工单列表跟着来源走：只列起点事件来自该来源的工单', async () => {
  const mine = await reader.listChains(10, 'fixture')
  assert.equal(mine.length, 1)
  assert.equal(mine[0]!.ticketId, fixture.ticketId)
  // 来源随工单一起回来（按来源分组/标注时直接用，不必再逐行反查）
  assert.equal(mine[0]!.source, 'fixture')
  assert.equal((await reader.listChains(10))[0]!.source, 'fixture')
  // 别的来源没有工单：返回空，不是把全部工单都端出来
  assert.deepEqual(await reader.listChains(10, 'github'), [])
})

test('blocked → 人跟进 → 重试 → 待验收 → 结束，状态带按时刻切段', async () => {
  const chain = (await reader.readChain(fixture.ticketId))!
  assert.deepEqual(
    (chain.stateBands ?? []).map(band => band.tag),
    ['working/queued', 'working', 'person/blocked', 'working', 'working/queued', 'working', 'person/review', 'ended'],
  )
  const retry = chain.spans.find(span => span.kind === 'event' && span.label === '重试')
  assert.ok(retry, '旧派工以 retried 结束时要画出重试节点')
  assert.equal(retry!.startMs, 40_000)
})

test('context-only 单列一类，不与订阅直通混在一起', async () => {
  const items = await reader.readDispositions(fixture.ticketId)
  // 两条源头丢弃（tr-filtered 与同线程的 tr-noise）
  assert.deepEqual(items.map(item => item.path).sort(), ['context', 'direct', 'filtered', 'filtered', 'routed'])
  const context = items.find(item => item.path === 'context')!
  assert.equal(context.triggerId, 'tr-ctx')
  // 点名方式是 @ 提及：这也算点名，不能显示成「未点名」
  const routed = items.find(item => item.path === 'routed')!
  assert.equal(routed.addressed, 'mention')
})

test('图上元素全部由数据决定：两支事件、两条直通、两次派工、没有回复', async () => {
  const chain = (await reader.readChain(fixture.ticketId))!
  const dispositions = await reader.readDispositions(fixture.ticketId)
  const model = present(chain, { events: dispositions })
  const ids = model.arrows.map(arrow => arrow.id)

  assert.deepEqual(ids.filter(id => id.startsWith('arrow-trigger')), ['arrow-trigger', 'arrow-trigger-1'])
  assert.ok(!ids.some(id => id.startsWith('arrow-ack')), '没有回复通道就不画确认收到')
  assert.ok(!ids.some(id => id.startsWith('arrow-reply')), '没有回复通道就不画回复')

  const fast = model.arrows.filter(arrow => arrow.kind === 'fast')
  assert.deepEqual(fast.map(arrow => arrow.label), ['仅上下文', '订阅直通'])

  assert.equal(ids.filter(id => id.startsWith('arrow-dispatch')).length, 2)
  assert.equal(ids.filter(id => id.startsWith('arrow-report')).length, 2)

  // 子代理挂在执行器列，仍是子代理角色
  const child = model.nodes.find(node => node.role === 'subagent')
  assert.ok(child?.nested)
  assert.ok(model.lanes.every(lane => lane.role !== 'subagent'))
})

test('连线抽屉按语境给解释：仅上下文不等于直通', async () => {
  const context = await reader.readLink(fixture.ticketId, 'arrow-fast-1')
  assert.equal(context?.title, '事件 · 仅上下文')
  assert.ok(context?.sections.some(section => section.title === '为什么只是上下文'))

  const direct = await reader.readLink(fixture.ticketId, 'arrow-fast-3')
  assert.equal(direct?.title, '事件 · 订阅直通')
})

test('batch 的第二支事件箭头在真实 reader 上也拿得到原文与发送者', async () => {
  // dispositions 每条决定只保留批里第一条（tr-b1）；第二支必须从 originEvents 补齐，
  // 不能反过来对库里存在的 tr-b2 说「没有记录原文」。
  const second = (await reader.readLink(fixture.ticketId, 'arrow-trigger-1'))!
  assert.equal(second.sections.find(section => section.title === '消息')?.body?.text, '顺便补上上周的对比')
  assert.ok(second.sections.some(section => section.title === '发送者'))
  assert.match(
    second.sections.find(section => section.title === '它在工单里的位置')?.text ?? '',
    /同批/)
})

test('派工抽屉：收到的来自工单输入，工具返回只留结果行并标错', async () => {
  const detail = await reader.readSpanDetail(fixture.ticketId, 'assignment-a1')
  assert.ok(detail)
  assert.ok(detail!.received.some(prose => prose.text === '帮我整理这周的周报'))
  assert.ok(detail!.received.some(prose => prose.text.includes('仅上下文')))

  // 带 error 的那次返回发生在第二次派工里（44s）；真实 schema 的 error 是对象
  const second = await reader.readSpanDetail(fixture.ticketId, 'assignment-a2')
  const failed = (second!.steps ?? []).flatMap(step => step.actions).filter(action => action.failed)
  assert.ok(failed.length > 0, 'tool/result 带 error 的那次调用要标失败')
  assert.equal(failed[0]!.result?.status, 'error')
  assert.ok(failed[0]!.result?.summary.includes('disk full'), failed[0]!.result?.summary)
  assert.ok(failed[0]!.result?.detail, '失败的堆栈仍可展开')

  // 夹具里有一段 >200 字的想法：预览只回前 200 字，全文仍按 id 取回。
  const longThought = (second!.steps ?? []).flatMap(step => step.thoughts).find(thought => thought.length > 200)
  assert.ok(longThought, '夹具应有一段的 >200 字想法')
  assert.equal((await reader.readText(fixture.ticketId, longThought!.id))?.length, longThought!.length)
})

test('运行方来自会话 header 的 preset：reader 真的读了日志，不是桩', async () => {
  const worker = await reader.readSpanDetail(fixture.ticketId, 'assignment-a1')
  assert.equal(
    worker?.facts?.find(row => row.label === '运行方')?.value,
    'DSH 内置 Worker（dsh-superagent-worker）')
  assert.equal(
    worker?.facts?.find(row => row.label === '模型路由')?.value,
    'deepseek-account · deepseek-flash')

  // 子代理读它自己的会话头与事件：preset 是 standard，模型是 reasoner（父会话是 flash）
  const child = await reader.readSpanDetail(fixture.ticketId, 'subagent-child-fixture')
  assert.equal(
    child?.facts?.find(row => row.label === '运行方')?.value,
    'DSH 内置 Agent（standard）')
  assert.equal(
    child?.facts?.find(row => row.label === '模型路由')?.value,
    'deepseek-account · deepseek-reasoner')
})

test('离散事件抽屉读领域表：重试说清上一次为什么结束', async () => {
  const detail = await reader.readSpanDetail(fixture.ticketId, 'event-retry-a2')
  assert.equal(detail?.title, '重试 · 第 2 次派工')
  const rows = detail?.facts ?? []
  assert.ok(rows.some(row => row.label === '上一次结束原因' && row.value === 'retried'))
})

test('按 id 取全文：抽屉只回预览，点开才取原文', async () => {
  assert.equal(
    await reader.readText(fixture.ticketId, 'span/assignment-a1/steps/0/thoughts/0'),
    '先找数据来源。')
  assert.equal(
    await reader.readText(fixture.ticketId, 'link/arrow-trigger/sections/0'),
    '帮我整理这周的周报')
  assert.equal(
    await reader.readText(fixture.ticketId, 'span/subagent-child-fixture/outcome'),
    '共享盘里有 3 份数据。')
  // B9：成功返回不写缓存，按旧 id 取不到；失败堆栈仍能按 id 取回
  assert.equal(await reader.readText(fixture.ticketId, 'span/assignment-a1/steps/0/results/0'), undefined)
  const second = await reader.readSpanDetail(fixture.ticketId, 'assignment-a2')
  const failure = (second!.steps ?? []).flatMap(step => step.actions).find(action => action.result?.detail)
  assert.ok(failure?.result?.detail)
  assert.equal(
    await reader.readText(fixture.ticketId, failure!.result!.detail!.id),
    `disk full · EACCES\n\nwrite failed: EACCES: permission denied\n${'    at fs.writeFileSync (node:fs:1:1)\n'.repeat(12)}`)
  assert.equal(await reader.readText(fixture.ticketId, 'span/assignment-a1/nope/0'), undefined)
  assert.equal(await reader.readText(fixture.ticketId, 'bogus'), undefined)
})

test('全文缓存按工单隔离：不存在的工单取不到别人的正文', async () => {
  // 先让这条正文进缓存，再换一个工单查同一个 id。
  // 缓存键里只要丢了工单，第二次就会串到别人的正文——这条才是能红的断言。
  assert.equal(await reader.readText(fixture.ticketId, 'link/arrow-trigger/sections/0'), '帮我整理这周的周报')
  assert.equal(await reader.readText('ticket-does-not-exist', 'link/arrow-trigger/sections/0'), undefined)
})

test('抽屉响应体不含原文：每段正文都已截到 200 字以内', async () => {
  const detail = await reader.readSpanDetail(fixture.ticketId, 'assignment-a1')
  assert.ok(detail)
  const serialized = JSON.stringify(detail)
  assert.ok(serialized.length < 24_000, `响应 ${serialized.length} 字节，超预算`)
  const longTexts: string[] = []
  const walk = (value: unknown, path: string): void => {
    if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return }
    if (!value || typeof value !== 'object') return
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'translations') continue
      if (typeof inner === 'string' && inner.length > 200) longTexts.push(`${path}.${key}`)
      else walk(inner, `${path}.${key}`)
    }
  }
  walk(detail, 'detail')
  assert.deepEqual(longTexts, [])
  // B9：成功返回的正文（哨兵）不得出现在抽屉响应里——只允许失败堆栈按 id 另取。
  assert.ok(!serialized.includes('ticket-sentinel-success'), '成功返回的正文泄露进抽屉响应')
})
