import { test } from 'node:test'
import assert from 'node:assert/strict'
import { thoughtBeforeEval } from '../src/service/thoughts.ts'

const assistant = (text: string) => ({ type: 'assistant/message', data: { text } })
const evalCall = (triggerId: string) => ({
  type: 'tool/call',
  data: { name: 'orchestrator_eval', arguments: JSON.stringify({ trigger_id: triggerId }) },
})

const events = [
  assistant('第一条候选的想法'),
  evalCall('t1'),
  assistant('第二条候选的想法'),
  evalCall('t2'),
]

test('两条决定各取自己那次评估前的想法', () => {
  assert.equal(thoughtBeforeEval(events, 't1'), '第一条候选的想法')
  assert.equal(thoughtBeforeEval(events, 't2'), '第二条候选的想法')
})

test('找不到对应 trigger 时不回退到别人的想法', () => {
  assert.equal(thoughtBeforeEval(events, 't9'), undefined)
})

test('没有 triggerId 时保持旧行为：第一次评估之前', () => {
  assert.equal(thoughtBeforeEval(events, undefined), '第一条候选的想法')
})
