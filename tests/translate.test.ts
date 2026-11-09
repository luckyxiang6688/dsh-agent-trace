import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toolChinese, translateArgs } from '../src/presenter/translate.ts'

/** 取某个字段的值；没有就 undefined。 */
const valueOf = (args: Record<string, unknown>, label: string): string | undefined =>
  translateArgs(args).find(field => field.label === label)?.value

test('资源路径译成「名词 + 完整 id」：工单带 Ticket，id 不截断，子资源带中文名', () => {
  const id = 'c5faef17fff20441f4b105b70f265c13'
  assert.equal(valueOf({ resource: `ticket/${id}` }, '资源'), `工单 Ticket ${id}`)
  assert.equal(valueOf({ resource: `ticket/${id}/assignment` }, '资源'), `工单 Ticket ${id} / 派工任务`)
  assert.equal(valueOf({ resource: `ticket/${id}/report/abc123` }, '资源'), `工单 Ticket ${id} / 报告 abc123`)
  assert.equal(valueOf({ resource: `ticket/${id}/unknownpart` }, '资源'), `工单 Ticket ${id} / unknownpart`)
  assert.equal(valueOf({ resource: 'thread/fixture:thread-1' }, '资源'), '线程 fixture:thread-1')
})

test('认不得的名词不猜：URL 与文件路径原样返回', () => {
  assert.equal(
    valueOf({ resource: 'https://example.com/a/b' }, '资源'),
    'https://example.com/a/b')
  assert.equal(valueOf({ resource: 'file:///Users/x/a.txt' }, '资源'), 'file:///Users/x/a.txt')
})

test('前导斜杠不产出空名词', () => {
  assert.equal(valueOf({ resource: '/ticket/c5faef17fff20441f4b105b70f265c13' }, '资源'),
    '工单 Ticket c5faef17fff20441f4b105b70f265c13')
})

test('裸 32 位 id 原样显示', () => {
  assert.equal(valueOf({ resource: 'c5faef17fff20441f4b105b70f265c13' }, '资源'), 'c5faef17fff20441f4b105b70f265c13')
})

test('资源串再长也不超过抽屉的单串上限', () => {
  const value = valueOf({ resource: 'x'.repeat(300) }, '资源')!
  assert.ok(value.length <= 200, `实际 ${value.length} 字`)
  assert.match(value, /共 300 字/)
})

test('续读位置：数字与数字字符串都认，0 显示「从头」', () => {
  assert.equal(valueOf({ offset: 0 }, '续读位置'), '从头')
  assert.equal(valueOf({ offset: '0' }, '续读位置'), '从头')
  assert.equal(valueOf({ offset: 32 }, '续读位置'), '32')
  assert.equal(valueOf({ offset: '4096' }, '续读位置'), '4096')
})

test('只给行为已核对的工具起中文名，其余返回 undefined', () => {
  assert.equal(toolChinese('orchestrator_read'), '读取资源')
  assert.equal(toolChinese('ns/orchestrator_read'), '读取资源')
  assert.equal(toolChinese('bash'), undefined)
  assert.equal(toolChinese('some_new_tool'), undefined)
})
