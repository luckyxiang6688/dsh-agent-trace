import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLink, type LinkContext } from '../src/service/link.ts'
import type { Chain, Disposition } from '../src/domain/model.ts'

const chain: Chain = {
  ticketId: 'ticket-1', title: '示例', stage: '进行中', createdAt: '2026-01-01T00:00:00Z', spans: [],
}

const origin: Disposition = {
  path: 'routed', outcome: 'accept', triggerId: 'origin', text: '原始请求',
  actor: 'alice', human: true, threads: ['demo:thread-1'], addressed: 'direct',
  at: '2026-01-01T00:00:01Z',
}
const other: Disposition = {
  path: 'routed', outcome: 'accept', triggerId: 'other', text: '别的消息',
}

const context = (extra: Partial<LinkContext> = {}): LinkContext => ({
  chain, dispositions: [other, origin], assignments: [], outbox: [], originTriggerId: 'origin', ...extra,
})

test('事件箭头用 origin trigger 原文，不再取 dispositions[0]', () => {
  const link = buildLink(context(), 'arrow-trigger')!
  assert.equal(link.sections.find(section => section.title === '消息')?.body?.text, '原始请求')
  const sender = link.sections.find(section => section.title === '发送者')!
  assert.ok(sender.items?.some(item => item.text === 'alice'))
  assert.ok(sender.items?.some(item => item.text === '人'))
  assert.equal(link.sections.find(section => section.title === '线程')?.text, 'demo:thread-1')
  assert.equal(link.sections.find(section => section.title === '点名方式')?.text, '直接点名智能体')
  assert.ok(link.sections.some(section => section.title === '时间'))
})

test('没有 batch 记录时，第二支箭头不拿起点原文冒充', () => {
  const link = buildLink(context(), 'arrow-trigger-1')!
  assert.equal(link.sections.find(section => section.title === '消息')?.text, '（这次运行没有记录原文）')
  assert.match(
    link.sections.find(section => section.title === '它在工单里的位置')?.text ?? '',
    /归属没有记录/)
})

test('batch 的第二条起点事件从 originEvents 取原文、发送者与时间', () => {
  const link = buildLink(context({
    chain: { ...chain, origins: [{ triggerId: 'origin' }, { triggerId: 'other' }] },
    originEvents: [
      { triggerId: 'origin', text: '原始请求', at: '2026-01-01T00:00:01Z' },
      {
        triggerId: 'other', text: '同批的另一条', at: '2026-01-01T00:00:02Z',
        actor: 'bob', human: true, threads: ['demo:thread-2'], addressed: 'mention',
      },
    ],
  }), 'arrow-trigger-1')!
  assert.equal(link.sections.find(section => section.title === '消息')?.body?.text, '同批的另一条')
  const sender = link.sections.find(section => section.title === '发送者')!
  assert.ok(sender.items?.some(item => item.text === 'bob'))
  assert.equal(link.sections.find(section => section.title === '线程')?.text, 'demo:thread-2')
  assert.equal(link.sections.find(section => section.title === '点名方式')?.text, '@提及智能体（算点名）')
  assert.ok(link.sections.some(section => section.title === '时间'))
})

test('旧数据只有 origin.triggerId 时，第一支箭头也从 originEvents 取完整记录', () => {
  const link = buildLink(context({
    originEvents: [{ triggerId: 'origin', text: '旧数据原文', actor: 'carol', human: true }],
  }), 'arrow-trigger')!
  assert.equal(link.sections.find(section => section.title === '消息')?.body?.text, '旧数据原文')
  const sender = link.sections.find(section => section.title === '发送者')!
  assert.ok(sender.items?.some(item => item.text === 'carol'))
})

test('ack 有日志证据但 outbox 缺失时给说明，而不是 404', () => {
  const link = buildLink(context(), 'arrow-ack')
  assert.ok(link)
  assert.match(link!.sections[0]!.text ?? '', /没有可读的回复记录/)
})

test('ack 抽屉显示投递状态与用途', () => {
  const link = buildLink(context({
    outbox: [{ id: 'o1', kind: 'acknowledgement', text: '收到', status: 'sent' }],
  }), 'arrow-ack')!
  const badges = link.sections.find(section => section.title === '投递状态')!
  assert.ok(badges.items?.some(item => item.text === '已发送'))
  assert.ok(badges.items?.some(item => item.text === 'acknowledgement'))
})

test('回复缺失时同样不 404', () => {
  const link = buildLink(context(), 'arrow-reply-0')
  assert.ok(link)
  assert.match(link!.sections[0]!.text ?? '', /没有可读的回复记录/)
})

test('长消息只回 200 字预览，全文进 sink', () => {
  const sink = new Map<string, string>()
  const long = '请'.repeat(5000)
  const link = buildLink(
    context({ dispositions: [{ ...origin, text: long }] }),
    'arrow-trigger',
    sink,
  )!
  const section = link.sections.find(item => item.title === '消息')!
  assert.equal(section.text, undefined, '有原文时不再用 text 字段')
  assert.equal(section.body?.text.length, 200)
  assert.equal(section.body?.length, 5000)
  assert.equal(section.body?.id, 'link/arrow-trigger/sections/0')
  assert.equal(sink.get('link/arrow-trigger/sections/0'), long)
})

test('报告内容给完整摘要的预览，不再预压到 400 字', () => {
  const summary = `完成：整理周报。\n\n${'产出细节。'.repeat(100)}`
  const link = buildLink(context({
    assignments: [{
      id: 'a1', label: '派工 #1', startMs: 0, endMs: 1000,
      reportState: 'ready', reportSummary: summary,
    }],
  }), 'arrow-report-assignment-a1')!
  const section = link.sections[0]!
  assert.equal(section.body?.length, summary.length)
  assert.equal(section.body?.text.length, 200)
})

test('没有原文时仍用我们写的降级说明（text，不是 body）', () => {
  const link = buildLink(context({ dispositions: [{ ...origin, text: undefined }] }), 'arrow-trigger')!
  const section = link.sections.find(item => item.title === '消息')!
  assert.equal(section.body, undefined)
  assert.equal(section.text, '（这次运行没有记录原文）')
})

test('去向抽屉·经主控：逐条列出时间、发送者、原文与结果', () => {
  const link = buildLink(context({
    dispositions: [
      origin,
      { ...other, at: '2026-01-01T00:00:03Z', outcome: 'ignore', addressed: null, text: undefined },
    ],
  }), 'path-routed')!

  assert.equal(link.title, '经主控 · 慢路径')
  assert.match(link.subtitle ?? '', /主控评估/)
  // 按事件时刻排序：origin 在前
  assert.deepEqual(link.sections.map(section => section.title), ['1.00s · alice', '3.00s · 未记录发送者'])
  assert.equal(link.sections[0]!.body?.text, '原始请求')
  assert.equal(link.sections[0]!.body?.id, 'link/path-routed/sections/0')
  const badges = link.sections[0]!.items!.map(item => item.text)
  assert.deepEqual(badges, ['接单', '人', '直接点名智能体'])
  // 第二条没有原文、没有发送者、没有点名：逐项降级，不留空壳
  assert.equal(link.sections[1]!.text, '（这次运行没有记录原文）')
  assert.deepEqual(link.sections[1]!.items!.map(item => item.text), ['拒绝', '人', '未点名'])
})

test('去向抽屉·源头丢弃：按原因分组，每组一个例子，并说明不进时序图', () => {
  const filtered = (outcome: string, text: string, at: string): Disposition => ({
    path: 'filtered', outcome, text, at, actor: 'bot', human: false, addressed: null,
  })
  const link = buildLink(context({
    dispositions: [
      filtered('no_mention', '第一条没点名的', '2026-01-01T00:00:02Z'),
      filtered('no_mention', '第二条没点名的', '2026-01-01T00:00:04Z'),
      filtered('not_a_member', '名单外的人', '2026-01-01T00:00:06Z'),
    ],
  }), 'path-filtered')!

  assert.equal(link.title, '源头丢弃')
  assert.deepEqual(link.sections.map(section => section.title), ['2.00s · bot', '6.00s · bot', '说明'])
  assert.equal(link.sections[0]!.body?.text, '第一条没点名的', '每组只给第一个例子')
  assert.ok(link.sections[0]!.items!.some(item => item.text === '同类 2 条'))
  // 结果已经是「未点名」时不再重复一个同名徽章
  assert.deepEqual(link.sections[0]!.items!.map(item => item.text), ['未点名', '机器人', '同类 2 条'])
  assert.ok(link.sections[1]!.items!.every(item => item.text !== '同类 2 条'))
  assert.match(link.sections[2]!.text ?? '', /不会出现在时序图上/)
})

test('去向抽屉·长原文只回 200 字预览，全文进 sink', () => {
  const long = '长'.repeat(450)
  const sink = new Map<string, string>()
  const link = buildLink(context({ dispositions: [{ ...origin, text: long }] }), 'path-routed', sink)!
  assert.equal(link.sections[0]!.body?.text.length, 200)
  assert.equal(link.sections[0]!.body?.length, 450)
  assert.equal(sink.get(link.sections[0]!.body!.id), long)
})

test('去向抽屉：该路径没有事件时给一句说明，不摔 404', () => {
  // 段只在该路径有事件时才画得出来，走到这里说明两次请求之间数据变了。
  const link = buildLink(context(), 'path-filtered')!
  assert.equal(link.title, '源头丢弃')
  assert.equal(link.sections.length, 1)
  assert.equal(link.sections[0]!.kind, 'note')
  assert.match(link.sections[0]!.text ?? '', /不在当前记录里/)
})

test('去向抽屉：解析不了的时间不出 NaN 标题，也不扰乱排序', () => {
  const link = buildLink(context({
    dispositions: [
      { ...origin, at: 'garbage' },
      { ...other, at: '2026-01-01T00:00:03Z', outcome: 'ignore' },
    ],
  }), 'path-routed')!
  assert.deepEqual(link.sections.map(section => section.title), ['3.00s · 未记录发送者', '（没有记录时间） · alice'])
})

test('事件抽屉说明它在工单里的位置：起点 / 同批 / 归属未记录', () => {
  const originLink = buildLink(context(), 'arrow-trigger')!
  assert.match(
    originLink.sections.find(section => section.title === '它在工单里的位置')?.text ?? '',
    /起点事件/)
  // batch：第二支箭头对应第二条起点事件——既不能复读第一条的原文，也不能说成「后来输入」
  const batch = buildLink(context({
    chain: { ...chain, origins: [{ triggerId: 'origin' }, { triggerId: 'other' }] },
  }), 'arrow-trigger-1')!
  assert.equal(batch.sections.find(section => section.title === '消息')?.body?.text, '别的消息')
  assert.match(
    batch.sections.find(section => section.title === '它在工单里的位置')?.text ?? '',
    /同批/)
  // 没有起点记录：第一支只说是「第一条可读事件」，不说成起点；后面的绝不冒充起点
  const anonymous = buildLink(context({ originTriggerId: undefined }), 'arrow-trigger')!
  assert.match(
    anonymous.sections.find(section => section.title === '它在工单里的位置')?.text ?? '',
    /起点事件没有记录/)
  const unknown = buildLink(context({ originTriggerId: undefined }), 'arrow-trigger-1')!
  assert.match(
    unknown.sections.find(section => section.title === '它在工单里的位置')?.text ?? '',
    /归属没有记录/)
})

test('派工箭头用完整工单 id 并带 Ticket，执行器会话写全名', () => {
  const link = buildLink(context({
    assignments: [{ id: 'a1', label: '派工 #1', startMs: 0, endMs: 1000, state: 'running' }],
  }), 'arrow-dispatch-assignment-a1')!
  assert.equal(link.sections[0]!.text, `工单 Ticket ${chain.ticketId} 已创建，派给一个执行器会话。`)
  assert.ok(link.sections[0]!.items?.some(item => item.text === `执行器会话 worker-${chain.ticketId}`))
})

test('源头丢弃分组带上人与点名方式：人和机器人不会被并成一组', () => {
  const link = buildLink(context({
    dispositions: [
      { path: 'filtered', outcome: 'no_mention', text: '人说的', at: '2026-01-01T00:00:02Z', actor: 'alice', human: true, addressed: 'mention' },
      { path: 'filtered', outcome: 'no_mention', text: '机器人群发', at: '2026-01-01T00:00:04Z', actor: 'bot', human: false, addressed: null },
    ],
  }), 'path-filtered')!

  assert.deepEqual(link.sections.map(section => section.title), ['2.00s · alice', '4.00s · bot', '说明'])
  // 分组后每组的「人/机器人」是同质的，例子行的属性不会被读成整组的属性
  assert.deepEqual(link.sections[0]!.items!.map(item => item.text), ['未点名', '人', '@提及智能体（算点名）'])
  assert.ok(link.sections.every(section => section.items?.every(item => item.text !== '同类 2 条') ?? true))
})
