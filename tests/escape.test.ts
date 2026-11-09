/**
 * Esc 栈：后进先出、一次只关一层。
 *
 * 这条规则不是样式问题——抽屉套覆盖层时，两层一起关是用户能直接看到的错。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { escapeDepth, handleEscape, pushEscape, resetEscapeStack } from '../src/client/escape.ts'

test('空栈不消费 Esc', () => {
  resetEscapeStack()
  assert.equal(handleEscape(), false)
  assert.equal(escapeDepth(), 0)
})

test('后进先出：一个 Esc 只关最上面那层', () => {
  resetEscapeStack()
  const closed: string[] = []
  const releaseOverlay = pushEscape(() => closed.push('overlay'))
  const releaseDrawer = pushEscape(() => closed.push('drawer'))

  assert.equal(handleEscape(), true)
  assert.deepEqual(closed, ['drawer'])
  releaseDrawer()
  assert.equal(handleEscape(), true)
  assert.deepEqual(closed, ['drawer', 'overlay'])
  releaseOverlay()
  assert.equal(handleEscape(), false)
})

test('取消函数只摘掉自己，重复调用不误删别人', () => {
  resetEscapeStack()
  const closed: string[] = []
  const releaseOverlay = pushEscape(() => closed.push('overlay'))
  const releaseDrawer = pushEscape(() => closed.push('drawer'))

  releaseDrawer()
  releaseDrawer()
  assert.equal(handleEscape(), true)
  assert.deepEqual(closed, ['overlay'])
  // 被关掉的那层由组件卸载时的 cleanup 摘栈，栈里暂时还留着它
  assert.equal(escapeDepth(), 1)
  releaseOverlay()
  assert.equal(handleEscape(), false)
})

test('栈可以重新压入（抽屉关掉再打开，顺序仍然正确）', () => {
  resetEscapeStack()
  const closed: string[] = []
  const releaseOverlay = pushEscape(() => closed.push('overlay'))
  const releaseFirst = pushEscape(() => closed.push('drawer-1'))
  releaseFirst()
  const releaseSecond = pushEscape(() => closed.push('drawer-2'))

  assert.equal(handleEscape(), true)
  releaseSecond()
  assert.equal(handleEscape(), true)
  releaseOverlay()
  assert.deepEqual(closed, ['drawer-2', 'overlay'])
})
