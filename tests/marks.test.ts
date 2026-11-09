import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolCallTimes } from '../src/service/reader.ts'

/**
 * 回归：主控会话是长生命周期的，同一个 `orchestrator-*` 会话里有别的工单的回复。
 * 不过滤会把时间轴起点拉到十几小时前，本工单的几分钟被压成亚像素 → 图上「什么都没有」。
 * 真实样本：fixture 工单（814m45s 空图）混进了 demo 工单 13 小时前的两条回复。
 */
const call = (name: string, time: number, args?: unknown) => ({
  type: 'tool/call',
  time,
  data: { name, ...(args === undefined ? {} : { arguments: args }) },
})
const T0 = Date.parse('2026-11-08T03:16:14.926Z')

test('只收本工单的工具调用，别的工单的回复不算', () => {
  const events = [
    call('orchestrator_reply', T0 - 48_500_000, JSON.stringify({ ticket_id: 'other-ticket' })),
    call('orchestrator_reply', T0 - 48_480_000, JSON.stringify({ ticket_id: 'other-ticket' })),
    call('orchestrator_reply', T0 + 340_000, JSON.stringify({ ticket_id: 'mine' })),
  ]
  assert.deepEqual(toolCallTimes(events, 'orchestrator_reply', 'mine', T0), [T0 + 340_000])
})

test('入参是对象也认，驼峰 ticketId 也认', () => {
  const events = [
    call('orchestrator_reply', T0 + 1, { ticketId: 'mine' }),
    call('orchestrator_reply', T0 + 2, { ticketId: 'other' }),
  ]
  assert.deepEqual(toolCallTimes(events, 'orchestrator_reply', 'mine', T0), [T0 + 1])
})

test('旧日志没有 ticket_id：早于首条触发的丢弃，之后的保留', () => {
  const events = [
    call('orchestrator_reply', T0 - 1000),
    call('orchestrator_reply', T0 + 1000),
  ]
  assert.deepEqual(toolCallTimes(events, 'orchestrator_reply', 'mine', T0), [T0 + 1000])
})

test('没有 sinceMs 时，无 ticket_id 的旧日志仍全部保留（不误杀）', () => {
  const events = [call('orchestrator_reply', T0 - 1000)]
  assert.deepEqual(toolCallTimes(events, 'orchestrator_reply', 'mine'), [T0 - 1000])
})

test('入参不是合法 JSON 时按「没有归属信息」处理，而不是整条丢掉', () => {
  const events = [
    call('orchestrator_reply', T0 - 1000, '{not json'),
    call('orchestrator_reply', T0 + 1000, '{not json'),
  ]
  assert.deepEqual(toolCallTimes(events, 'orchestrator_reply', 'mine', T0), [T0 + 1000])
})

test('只认指定工具名，ack 与 reply 不会互相串', () => {
  const events = [
    call('orchestrator_ack', T0 + 500, JSON.stringify({ ticket_id: 'mine' })),
    call('orchestrator_reply', T0 + 900, JSON.stringify({ ticket_id: 'mine' })),
  ]
  assert.deepEqual(toolCallTimes(events, 'orchestrator_ack', 'mine', T0), [T0 + 500])
  assert.deepEqual(toolCallTimes(events, 'orchestrator_reply', 'mine', T0), [T0 + 900])
})
