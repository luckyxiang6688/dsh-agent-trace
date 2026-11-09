/**
 * 健康快照：计数按路由模板聚合，存储探测决定 ok。
 *
 * 这里断言的是**快照的语义**，不是 HTTP：什么算故障（500）、什么不算（404/403），
 * 以及健康接口绝不能把 id 与正文带出来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHealth, routeLabel, storeProbe } from '../src/service/health.ts'

test('路由标签按模板聚合，不含 id', () => {
  assert.equal(routeLabel('/chains'), '/chains')
  assert.equal(routeLabel('/sources'), '/sources')
  assert.equal(routeLabel('/sources/fixture/events'), '/sources/:source/events')
  assert.equal(routeLabel('/sources/fixture/events/tr-b1'), '/sources/:source/events/:id')
  assert.equal(routeLabel('/sources/fixture/events/tr-b1/text'), '/sources/:source/events/:id/text')
  assert.equal(routeLabel('/sources/fixture/weird'), '/sources/:source/*')
  // 带 id 的几个模板要跟 routes.ts 的正则对齐：单复数差一个 s 就全落进 /other。
  assert.equal(routeLabel('/chains/c5faef17'), '/chains/:id')
  assert.equal(routeLabel('/spans/t1/assignment-a1'), '/spans/:ticket/:span')
  assert.equal(routeLabel('/links/t1/path-routed'), '/links/:ticket/:path')
  assert.equal(routeLabel('/texts/t1/span%2Fassignment-a1%2Fthoughts%2F0'), '/texts/:ticket/:id')
  assert.equal(routeLabel('/texts/t1/span/a/thoughts/0'), '/texts/:ticket/:id')
  assert.equal(routeLabel('/debug/sess-1'), '/debug/:session')
  assert.equal(routeLabel('/nope'), '/other')
})

test('计数与耗时按标签累加；500 才算故障', () => {
  let clock = 1000
  const health = createHealth(() => clock)
  clock = 1010
  health.record('/chains', 12, true)
  clock = 1020
  health.record('/chains', 8, true)
  health.record('/sources', 30, false)

  clock = 1500
  const snapshot = health.snapshot()
  assert.equal(snapshot.ok, true, '没接存储探测时不判故障')
  assert.equal(snapshot.uptimeMs, 500)
  // 顶层给一个总数：监控不必自己遍历 routes；它只增不减，所以不并入 ok。
  assert.equal(snapshot.errors, 1)
  assert.deepEqual(snapshot.routes['/chains'], { count: 2, errors: 0, lastMs: 8, maxMs: 12 })
  assert.deepEqual(snapshot.routes['/sources'], { count: 1, errors: 1, lastMs: 30, maxMs: 30 })
  assert.equal(snapshot.store, undefined)
})

test('存储探测是 ok 的唯一来源；探测抛异常也进快照，不让健康接口自己崩', () => {
  const healthy = createHealth(() => 0, () => ({ ok: true, ms: 2 }))
  assert.deepEqual(healthy.snapshot().store, { ok: true, ms: 2 })
  assert.equal(healthy.snapshot().ok, true)

  const broken = createHealth(() => 0, () => ({ ok: false, ms: 1, error: 'store unavailable' }))
  assert.equal(broken.snapshot().ok, false)

  const throwing = createHealth(() => 0, () => { throw new Error('EACCES') })
  const snapshot = throwing.snapshot()
  assert.equal(snapshot.ok, false)
  assert.ok(snapshot.store?.error?.includes('EACCES'))
})

test('探测失败也必须关句柄：kv() 抛错时 close 仍要执行，成功路径也只关一次', () => {
  // 缺 kv 表 / 文件损坏 / 瞬时锁都会让 kv() 抛；不关的话 /health 每被轮询一次就漏一个 fd。
  let closed = 0
  const broken = storeProbe(() => ({
    kv() { throw new Error('no such table: kv') },
    close() { closed += 1 },
  }))
  const failed = broken()
  assert.equal(failed.ok, false)
  assert.ok(failed.error?.includes('kv'))
  assert.equal(closed, 1, 'kv() 抛错后仍要 close')

  const fine = storeProbe(() => ({ kv() { return undefined }, close() { closed += 1 } }))
  assert.equal(fine().ok, true)
  assert.equal(closed, 2, '成功路径不能多关也不能不关')

  // 连句柄都没开出来时不要调 close
  const missing = storeProbe(() => undefined)
  assert.deepEqual({ ...missing(), ms: 0 }, { ok: false, ms: 0, error: 'store unavailable' })
  assert.equal(closed, 2)
})
