import { test } from 'node:test'
import assert from 'node:assert/strict'
import { proseOf, firstSentence } from '../src/service/prose.ts'
import { PROSE_PREVIEW_CHARS } from '../src/domain/model.ts'

test('短正文原样返回，不挂截断标记', () => {
  const prose = proseOf('整理本周周报', 'span/x/thoughts/0')
  assert.equal(prose.text, '整理本周周报')
  assert.equal(prose.length, 6)
  assert.equal(prose.id, 'span/x/thoughts/0')
})

test('刚好 200 字不截断，201 字才截', () => {
  const exact = '字'.repeat(PROSE_PREVIEW_CHARS)
  assert.equal(proseOf(exact, 'id').text, exact)
  const over = '字'.repeat(PROSE_PREVIEW_CHARS + 1)
  const prose = proseOf(over, 'id')
  assert.equal(prose.text.length, PROSE_PREVIEW_CHARS)
  // 总字数按原文算——这正是「展开原文 · N 字」要显示的 N
  assert.equal(prose.length, PROSE_PREVIEW_CHARS + 1)
})

test('全文写进 sink，预览不写', () => {
  const sink = new Map<string, string>()
  const long = '一'.repeat(500)
  proseOf(long, 'span/x/outcome', sink)
  proseOf('短', 'span/x/received/0', sink)
  assert.equal(sink.get('span/x/outcome'), long)
  assert.equal(sink.get('span/x/received/0'), '短')
})

test('首句按中文句末切，不吞掉下一句', () => {
  assert.equal(firstSentence('完成：写入 doc/weekly.md。\n\n产出\n- 一份'), '完成：写入 doc/weekly.md。')
  assert.equal(firstSentence('第一句！第二句。'), '第一句！')
  assert.equal(firstSentence('真的吗？是的。'), '真的吗？')
})

test('路径里的点不是句末，不能被切断', () => {
  assert.equal(firstSentence('写入 doc/weekly.md 并验证通过'), '写入 doc/weekly.md 并验证通过')
  // 英文句末得跟空白或结尾才算
  assert.equal(firstSentence('Done. Next step'), 'Done.')
  assert.equal(firstSentence('v1.2 版本'), 'v1.2 版本')
})

test('没有标点时截到上限并标省略号', () => {
  const text = '没有标点的一段话'.repeat(30)
  const out = firstSentence(text, 20)
  assert.equal(out.length, 21)
  assert.ok(out.endsWith('…'))
})

test('空串返回空串，不产出「…」', () => {
  assert.equal(firstSentence('   \n  '), '')
})
