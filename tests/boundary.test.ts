import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

/**
 * 错误边界的真实 DOM 行为：没它的时候，一次渲染抛错会把整棵根节点清空；
 * 有它的时候，兄弟节点活着、兜底文案出来。
 *
 * 这条测试同时跑一个「不装边界」的对照组——否则断言「兜底文案出现」可能只是
 * 因为组件压根没抛，测不出任何东西。
 */

async function setup() {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
  // React DOM 依赖这两个全局；必须在 import react-dom/client 之前就位。
  ;(globalThis as Record<string, unknown>).window = dom.window
  ;(globalThis as Record<string, unknown>).document = dom.window.document
  // Node 24 的 globalThis.navigator 只有 getter，直接赋值会抛；用 defineProperty 覆盖。
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  ;(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true

  const { createElement: h } = await import('react')
  const { createRoot } = await import('react-dom/client')
  const { act } = await import('react-dom/test-utils')
  const { ErrorBoundary } = await import('../src/client/boundary.ts')
  return { dom, h, createRoot, act, ErrorBoundary }
}

/** React 会把抛出的错误打到 console.error；测试里静音，避免把失败原因掩盖在噪声里。 */
function muteConsole() {
  const original = console.error
  console.error = () => {}
  return () => { console.error = original }
}

test('没装边界时一次抛错会清空整棵根节点（对照组）', async () => {
  const { dom, h, createRoot, act } = await setup()
  const Boom = (): null => { throw new Error('boom') }
  const root = createRoot(dom.window.document.getElementById('root')!)
  const restore = muteConsole()
  try {
    await act(async () => { root.render(h('div', null, h('span', null, '兄弟'), h(Boom))) })
  } catch { /* React 在 act 里可能把错误再抛一次 */ }
  restore()
  const text = dom.window.document.getElementById('root')!.textContent ?? ''
  assert.ok(!text.includes('兄弟'), `对照组应当被整体卸掉，实际还剩：${text}`)
})

test('装了边界：兜底文案出来，边界外的兄弟节点不受影响', async () => {
  const { dom, h, createRoot, act, ErrorBoundary } = await setup()
  const Boom = (): null => { throw new Error('boom') }
  const root = createRoot(dom.window.document.getElementById('root')!)
  const restore = muteConsole()
  try {
    await act(async () => {
      root.render(h('div', null,
        h('span', null, '兄弟'),
        h(ErrorBoundary, { fallback: (error: Error) => h('div', null, `出错了：${error.message}`) },
          h(Boom))))
    })
  } catch { /* 同上 */ }
  restore()
  const text = dom.window.document.getElementById('root')!.textContent ?? ''
  assert.ok(text.includes('兄弟'), `边界外的兄弟节点必须活着，实际：${text}`)
  assert.ok(text.includes('出错了：boom'), `兜底文案必须出来，实际：${text}`)
})
