import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerRoutes, type RequestLike, type ResponseLike, type RuntimeStatus, type WebServerLike } from '../src/service/routes.ts'
import { createHealth, type HealthTracker } from '../src/service/health.ts'
import type { ChainReader } from '../src/domain/model.ts'

interface Captured {
  status: number
  headers: Record<string, string>
  body: unknown
}

/** 把路由注册下来，手动喂一个请求；不启真实端口。 */
function harness(reader: Partial<ChainReader> | undefined, translate: (texts: readonly string[]) => Promise<(string | undefined)[]>
  = async texts => texts.map(() => undefined), health?: HealthTracker,
  status: RuntimeStatus = { configured: true, stateDirOrigin: 'config' }) {
  let handler: ((req: RequestLike, res: ResponseLike) => unknown) | undefined
  const web: WebServerLike = {
    port: 3082,
    register(route) { handler = route.handler },
  }
  registerRoutes(web, reader as ChainReader | undefined, translate, health ?? createHealth(), status)
  return async (method: string, url: string, body?: string): Promise<Captured> => {
    const response: Captured = { status: 0, headers: {}, body: undefined }
    const listeners: Record<string, ((chunk?: unknown) => void)[]> = {}
    const req: RequestLike = {
      method,
      url,
      headers: { origin: 'http://127.0.0.1:3082' },
      on(event, listener) { (listeners[event] ??= []).push(listener) },
    }
    const res: ResponseLike = {
      statusCode: 0,
      setHeader(name, value) { response.headers[name] = value },
      end(payload) {
        response.status = res.statusCode
        response.body = payload ? JSON.parse(payload) : undefined
      },
    }
    const promise = handler!(req, res)
    if (body !== undefined) {
      listeners['data']?.forEach(listener => listener(Buffer.from(body)))
      listeners['end']?.forEach(listener => listener())
    }
    await promise
    return response
  }
}

test('正文全文路由：%2F 编码的 id 能取到，响应不缓存', async () => {
  const request = harness({
    readText: async (ticketId, textId) => (ticketId === 't1' && textId === 'span/assignment-a1/thoughts/0'
      ? '完整原文'
      : undefined),
  })
  const ok = await request('GET', '/agent-trace/texts/t1/span%2Fassignment-a1%2Fthoughts%2F0')
  assert.equal(ok.status, 200)
  assert.deepEqual(ok.body, { text: '完整原文' })
  assert.equal(ok.headers['cache-control'], 'no-store')

  const missing = await request('GET', '/agent-trace/texts/t1/span%2Funknown%2Fthoughts%2F0')
  assert.equal(missing.status, 404)
})

test('正文全文只接受 GET', async () => {
  const request = harness({ readText: async () => 'x' })
  const response = await request('POST', '/agent-trace/texts/t1/span%2Fa%2Foutcome')
  assert.equal(response.status, 405)
})

test('翻译路由把超长正文的下标报成 skipped', async () => {
  const request = harness({}, async texts => texts.map(() => '译文'))
  const long = '长'.repeat(1300)
  const response = await request('POST', '/agent-trace/translate', JSON.stringify({ texts: ['短', long] }))
  assert.equal(response.status, 200)
  const body = response.body as { items: (string | undefined)[]; skipped: number[] }
  assert.deepEqual(body.items, ['译文', '译文'])
  assert.deepEqual(body.skipped, [1])
})

test('翻译路由一次最多收 5 条', async () => {
  let received: readonly string[] = []
  const request = harness({}, async texts => { received = texts; return texts.map(() => undefined) })
  await request('POST', '/agent-trace/translate', JSON.stringify({ texts: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }))
  assert.equal(received.length, 5)
})

test('来源列表与事件分页：limit 夹到 1..200，游标原样透传', async () => {
  const calls: { source: string; limit: number; cursor?: string }[] = []
  const request = harness({
    listSources: async () => [{
      source: 'fixture', received: 6, tickets: 1,
      counts: { routed: 2, direct: 1, context: 1, filtered: 2, requeued: 0, handback: 0, undecided: 0 },
      unrecorded: 0,
    }],
    listSourceEvents: async (source, limit, cursor) => {
      calls.push({ source, limit, ...(cursor ? { cursor } : {}) })
      return { items: [], more: false }
    },
  })

  const sources = await request('GET', '/agent-trace/sources')
  assert.equal(sources.status, 200)
  assert.equal((sources.body as { items: unknown[] }).items.length, 1)

  await request('GET', '/agent-trace/sources/fixture/events?limit=999&cursor=abc%3D')
  await request('GET', '/agent-trace/sources/fixture/events?limit=0')
  await request('GET', '/agent-trace/sources/fixture/events')
  assert.deepEqual(calls, [
    { source: 'fixture', limit: 200, cursor: 'abc=' },
    { source: 'fixture', limit: 1 },
    { source: 'fixture', limit: 50 },
  ])
})

test('工单列表的来源参数原样透传；空串按「没给」处理', async () => {
  const calls: string[] = []
  const request = harness({
    listChains: async (limit, source) => { calls.push(`${limit}:${source ?? '<none>'}`); return [] },
  })
  await request('GET', '/agent-trace/chains?limit=7&source=fixture')
  await request('GET', '/agent-trace/chains?source=')
  await request('GET', '/agent-trace/chains')
  assert.deepEqual(calls, ['7:fixture', '20:<none>', '20:<none>'])
})

test('事件详情与全文：跨源/不存在一律 404，空正文与「没有这条」要分开', async () => {
  const request = harness({
    readSourceEvent: async (source, id) => (source === 'fixture' && id === 'tr-1'
      ? {
          source, triggerId: id, title: `事件 ${id}`, facts: [], interpretations: [], notRecorded: [],
          relatedTickets: [], threads: [],
        }
      : undefined),
    readSourceEventText: async (source, id) => {
      if (source !== 'fixture') return undefined
      if (id === 'tr-empty') return ''
      if (id === 'tr-1') return '正文'
      return undefined
    },
  })

  const detail = await request('GET', '/agent-trace/sources/fixture/events/tr-1')
  assert.equal(detail.status, 200)
  assert.equal((detail.body as { detail: { triggerId: string } }).detail.triggerId, 'tr-1')

  assert.equal((await request('GET', '/agent-trace/sources/github/events/tr-1')).status, 404)
  assert.equal((await request('GET', '/agent-trace/sources/fixture/events/tr-404')).status, 404)

  assert.deepEqual((await request('GET', '/agent-trace/sources/fixture/events/tr-1/text')).body, { text: '正文' })
  // 空字符串是合法正文：不能用 falsy 判定成 404
  assert.deepEqual((await request('GET', '/agent-trace/sources/fixture/events/tr-empty/text')).body, { text: '' })
  assert.equal((await request('GET', '/agent-trace/sources/fixture/events/tr-404/text')).status, 404)
})

test('来源路由只接受 GET', async () => {
  const request = harness({ listSources: async () => [] })
  assert.equal((await request('POST', '/agent-trace/sources')).status, 405)
  assert.equal((await request('POST', '/agent-trace/sources/fixture/events')).status, 405)
  assert.equal((await request('POST', '/agent-trace/sources/fixture/events/tr-1')).status, 405)
})

test('健康路由：给出存储状态与按模板聚合的计数；自身只接受 GET', async () => {
  const health = createHealth(() => 0, () => ({ ok: true, ms: 1 }))
  const request = harness({
    listSources: async () => [],
    readSourceEvent: async () => undefined,
  }, undefined, health)

  // 先打两次：一次成功、一次 404。404 不是插件故障，不该记进 errors。
  await request('GET', '/agent-trace/sources')
  await request('GET', '/agent-trace/sources/fixture/events/tr-404')

  const response = await request('GET', '/agent-trace/health')
  assert.equal(response.status, 200)
  const body = response.body as {
    ok: boolean
    errors: number
    routes: Record<string, { count: number; errors: number }>
    store?: { ok: boolean }
  }
  assert.equal(body.ok, true)
  assert.deepEqual(body.store, { ok: true, ms: 1 })
  assert.equal(body.routes['/sources']?.count, 1)
  assert.equal(body.routes['/sources/:source/events/:id']?.count, 1)
  assert.equal(body.routes['/sources/:source/events/:id']?.errors, 0)
  assert.equal(body.errors, 0, '404 不算故障，顶层 errors 应为 0')
  // 计数键是模板，不是带 id 的原路径：健康快照里不该出现任何 id
  assert.ok(!JSON.stringify(body).includes('tr-404'))

  assert.equal((await request('POST', '/agent-trace/health')).status, 405)
})

test('健康路由自己也要计数：查过一次健康，快照里就有它', async () => {
  const health = createHealth(() => 0)
  const request = harness({}, undefined, health)
  await request('GET', '/agent-trace/health')
  const snapshot = health.snapshot()
  assert.equal(snapshot.routes['/health']?.count, 1)
})

test('真实路由打过来都要归到自己的模板，一条也不许落进 /other', async () => {
  // 这条锁的是「标签 ↔ 真实路由表」的一致性，两侧都要管住：
  //  ① 标签侧：routeLabel 与 handler 的正则各写各的，单复数写岔时只有从 handler 打进去才看得出；
  //  ② 路由侧：handler 没匹配上会统一回 `{error:'unknown route'}`——早先这一条的 stub 全返回
  //     undefined，10 条里 5 条 404，「没这条路由」和「有路由没数据」在断言上分不开，
  //     把 `/spans/` 改成 `/spanzz/` 仍然全绿。所以现在逐条挑 unknown route 出来对账。
  const health = createHealth(() => 0)
  const request = harness({
    listChains: async () => [],
    readChain: async () => undefined,
    readSpanDetail: async () => undefined,
    readLink: async () => undefined,
    readText: async () => '正文',
    readSessionSample: async () => ({}),
    listSources: async () => [],
    listSourceEvents: async () => ({ items: [], more: false }),
    readSourceEvent: async () => undefined,
    readSourceEventText: async () => '正文',
  }, undefined, health)

  const paths = [
    '/chains?limit=2',
    '/chains/c1',
    '/spans/c1/assignment-a1',
    '/links/c1/path-routed',
    '/texts/c1/span%2Fa%2Fthoughts%2F0',
    '/debug/sess-1',
    '/sources',
    '/sources/fixture/events',
    '/sources/fixture/events/tr-1',
    '/sources/fixture/events/tr-1/text',
  ]
  const responses: { path: string; status: number; error?: string }[] = []
  for (const path of paths) {
    const response = await request('GET', `/agent-trace${path}`)
    responses.push({ path, status: response.status, error: (response.body as { error?: string } | undefined)?.error })
  }

  // 路由侧：没有一条落到「不认识这条路径」
  const missed = responses.filter(item => item.error === 'unknown route').map(item => item.path)
  assert.deepEqual(missed, [], `没匹配到路由的：${missed.join(', ')}`)
  // 有真值可回的两条必须是 200：这样 404 的语义（没数据）与 404 的语义（没路由）才分得开
  for (const path of ['/texts/c1/span%2Fa%2Fthoughts%2F0', '/sources/fixture/events/tr-1/text']) {
    assert.equal(responses.find(item => item.path === path)?.status, 200, `${path} 应该 200`)
  }

  // 标签侧：每条都被某个模板接住，且没有落进兜底桶
  const routes = health.snapshot().routes
  assert.deepEqual(Object.keys(routes).filter(key => key === '/other'), [], `落进 /other 的有：${JSON.stringify(routes)}`)
})

test('路径里的坏百分号编码回 400：这是请求的问题，不是插件故障', async () => {
  const request = harness({
    listSourceEvents: async () => { throw new Error('解码就该先失败，不该走到 reader') },
  })
  const response = await request('GET', '/agent-trace/sources/%E0%A4%A/events')
  assert.equal(response.status, 400)
})

test('未配置存储时仍是「可解释的 503」，不是光秃秃的 404', async () => {
  const request = harness(undefined, undefined, undefined, {
    configured: false, stateDirOrigin: 'none', hint: '没有找到 superagent 的 stateDir。',
  })
  // 这两个接口在任何状态下都要能答：用户靠它们确认插件到底有没有在工作。
  const status = await request('GET', '/agent-trace/status')
  assert.equal(status.status, 200)
  assert.deepEqual(status.body, { configured: false, stateDirOrigin: 'none', hint: '没有找到 superagent 的 stateDir。' })
  assert.equal((await request('GET', '/agent-trace/health')).status, 200)

  // 其余路由统一 503 + `unconfigured`：客户端据此画空状态，而不是逐条报「读取失败」。
  for (const path of ['/agent-trace/sources', '/agent-trace/chains', '/agent-trace/sources/github/events']) {
    const response = await request('GET', path)
    assert.equal(response.status, 503, `${path} 应该 503`)
    assert.equal((response.body as { unconfigured?: boolean }).unconfigured, true, `${path} 应带 unconfigured`)
  }
})

test('配置成功时 /status 不携带 hint', async () => {
  const request = harness({ listSources: async () => [] }, undefined, undefined,
    { configured: true, stateDirOrigin: 'orchestrator' })
  const status = await request('GET', '/agent-trace/status')
  assert.equal(status.status, 200)
  assert.deepEqual(status.body, { configured: true, stateDirOrigin: 'orchestrator' })
})
