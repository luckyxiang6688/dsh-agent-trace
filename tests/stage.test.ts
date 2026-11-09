import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canRetry, stageLabel, stageTag, ticketStage, waitsForPerson } from '../src/adapter/superagent/stage.ts'
import type { RawTicket } from '../src/adapter/superagent/db.ts'

const ticket = (extra: Partial<RawTicket> = {}): RawTicket => ({
  id: 'ticket-1', title: '示例', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  assignments: [{ id: 'a1', state: 'running', startedAt: '2026-01-01T00:01:00Z' }],
  ...extra,
})

const at = (stage: ReturnType<typeof ticketStage>) => stageTag(stage)

test('派工进行中就是执行中', () => {
  assert.equal(at(ticketStage(ticket())), 'working')
  assert.equal(stageLabel(ticketStage(ticket())), '执行中')
})

test('没有派工、或派工还是 pending，就是排队', () => {
  assert.equal(at(ticketStage(ticket({ assignments: [] }))), 'working/queued')
  assert.equal(at(ticketStage(ticket({
    assignments: [{ id: 'a1', state: 'pending', createdAt: '2026-01-01T00:00:30Z' }],
  }))), 'working/queued')
})

test('ready 报告 → 等待人验收', () => {
  assert.equal(at(ticketStage(ticket({
    assignments: [{ id: 'a1', state: 'running', report: { state: 'ready', at: '2026-01-01T00:02:00Z' } }],
  }))), 'person/review')
})

test('waiting 报告或派工已结束 → 空闲', () => {
  assert.equal(at(ticketStage(ticket({
    assignments: [{ id: 'a1', state: 'running', report: { state: 'waiting', at: '2026-01-01T00:02:00Z' } }],
  }))), 'idle')
  assert.equal(at(ticketStage(ticket({
    assignments: [{ id: 'a1', state: 'ended', endedAt: '2026-01-01T00:02:00Z' }],
  }))), 'idle')
})

test('blocked/failed 没有人跟进 → 等人处理', () => {
  const blocked = ticket({
    assignments: [{ id: 'a1', state: 'running', report: { state: 'blocked', at: '2026-01-01T00:02:00Z' } }],
  })
  assert.equal(at(ticketStage(blocked)), 'person/blocked')
  assert.equal(waitsForPerson(blocked), true)
  assert.equal(at(ticketStage({ ...blocked, assignments: [{ ...blocked.assignments![0]!, report: { state: 'failed', at: '2026-01-01T00:02:00Z' } }] })), 'person/failed')
})

test('报告之后人跟进过，就不再算等人的受阻', () => {
  const followed = ticket({
    assignments: [{ id: 'a1', state: 'running', report: { state: 'blocked', at: '2026-01-01T00:02:00Z' } }],
    inputs: [{ id: 'i1', kind: 'trigger', human: true, at: '2026-01-01T00:03:00Z' }],
  })
  assert.equal(waitsForPerson(followed), false)
  assert.equal(at(ticketStage(followed)), 'working')
})

test('只作为上下文送达的人消息不解除等待', () => {
  const contextOnly = ticket({
    assignments: [{ id: 'a1', state: 'running', report: { state: 'blocked', at: '2026-01-01T00:02:00Z' } }],
    inputs: [{ id: 'i1', kind: 'trigger', human: true, context: true, at: '2026-01-01T00:03:00Z' }],
  })
  assert.equal(waitsForPerson(contextOnly), true)
})

test('投递失败优先于待回答与待验收', () => {
  const failedDelivery = ticket({
    delivery: { error: 'worker session gone', at: '2026-01-01T00:03:00Z' },
    attention: { id: 'q1', question: '用哪个名字？' },
    assignments: [{ id: 'a1', state: 'running', report: { state: 'ready', at: '2026-01-01T00:02:00Z' } }],
  })
  assert.equal(at(ticketStage(failedDelivery)), 'person/delivery')
})

test('有待回答的问题优先于待验收', () => {
  assert.equal(at(ticketStage(ticket({
    attention: { id: 'q1', question: '用哪个名字？' },
    assignments: [{ id: 'a1', state: 'running', report: { state: 'ready', at: '2026-01-01T00:02:00Z' } }],
  }))), 'person/answer')
})

test('已结束最优先，标签带结束去向', () => {
  const ended = ticket({
    ended: { at: '2026-01-01T00:05:00Z', outcome: 'completed', by: 'executor' },
    delivery: { error: 'x', at: '2026-01-01T00:03:00Z' },
  })
  assert.equal(at(ticketStage(ended)), 'ended')
  assert.equal(canRetry(ended), false)
})

test('可重试：未结束且等人处理，或投递失败', () => {
  assert.equal(canRetry(ticket({
    assignments: [{ id: 'a1', state: 'running', report: { state: 'blocked', at: '2026-01-01T00:02:00Z' } }],
  })), true)
  assert.equal(canRetry(ticket({ delivery: { error: 'x', at: '2026-01-01T00:02:00Z' } })), true)
  assert.equal(canRetry(ticket()), false)
})
