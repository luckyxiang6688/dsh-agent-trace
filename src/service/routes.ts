/**
 * HTTP 路由：客户端通过它取数据。
 * 只接受同源请求，路径固定前缀，方法只允许 GET（P4：最小暴露面）。
 */
import type { ChainReader } from '../domain/model.ts'
import { routeLabel, type HealthTracker } from './health.ts'
import { TRANSLATE_MAX_CHARS } from './translate.ts'

/** 只声明用到的 webServer 能力，避免把 DSH 类型引入本模块。 */
export interface WebServerLike {
  readonly port?: number
  readonly host?: string
  register(route: { kind: 'prefix'; path: string; handler: (req: RequestLike, res: ResponseLike) => unknown }): void
}

export interface RequestLike {
  method?: string
  url?: string
  headers: Record<string, string | string[] | undefined>
  on?(event: 'data' | 'end' | 'error', listener: (chunk?: unknown) => void): void
}

export interface ResponseLike {
  statusCode: number
  setHeader(name: string, value: string): void
  end(body?: string): void
}

const PREFIX = '/agent-trace'

/** 注册所有路由。任何异常都转成 500，绝不让宿主进程崩。 */
export function registerRoutes(
  web: WebServerLike,
  reader: ChainReader,
  translator: (texts: readonly string[]) => Promise<(string | undefined)[]>,
  // 必填：默认值会静默给出一个「ok 恒为 true、没有存储探测」的实例，
  // 那是最容易误用的缺省——健康接口说自己健康，其实什么都没查。
  health: HealthTracker,
): void {
  web.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      const started = Date.now()
      let label = '/other'
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const path = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : url.pathname
        // 计数按路径模板聚合（不含 id）：既能看出哪条路由在挨打，也不会随流量膨胀。
        label = routeLabel(path)
        if (!sameOrigin(req, url, web.port)) return send(res, 403, { error: 'same-origin request required' })
        if (path === '/health') {
          if ((req.method ?? 'GET').toUpperCase() !== 'GET') return send(res, 405, { error: 'method not allowed' })
          return send(res, 200, health.snapshot())
        }
        const method = (req.method ?? 'GET').toUpperCase()
        if (path.startsWith('/translate')) {
          if (method !== 'POST') return send(res, 405, { error: 'method not allowed' })
          const body = await readJson(req)
          const texts = (Array.isArray((body as { texts?: unknown })?.texts) ? (body as { texts: string[] }).texts : [])
            .slice(0, 5)
          const items = await translator(texts)
          // 超长的原文送不进去：明确告诉客户端哪些没翻，别让人以为翻失败了。
          const skipped = texts.flatMap((text, index) => (text.length > TRANSLATE_MAX_CHARS ? [index] : []))
          return send(res, 200, { items, skipped })
        }
        if (method !== 'GET') return send(res, 405, { error: 'method not allowed' })
        if (path === '/chains') {
          const limit = clamp(Number(url.searchParams.get('limit') ?? 20), 1, 100)
          // 空串等于没给：`?source=` 不该变成「一个名字为空的来源」。
          const source = url.searchParams.get('source') || undefined
          return send(res, 200, { items: await reader.listChains(limit, source) })
        }
        // 开发用：看一眼真实会话事件的类型与字段，抽屉的翻译规则据此写
        const debugMatch = /^\/debug\/([^/]+)$/.exec(path)
        if (debugMatch?.[1]) {
          const events = await reader.readSessionSample(decodeURIComponent(debugMatch[1]))
          return send(res, 200, events)
        }
        const linkMatch = /^\/links\/([^/]+)\/([^/]+)$/.exec(path)
        if (linkMatch?.[1] && linkMatch[2]) {
          const link = await reader.readLink(decodeURIComponent(linkMatch[1]), decodeURIComponent(linkMatch[2]))
          if (!link) return send(res, 404, { error: 'link not found' })
          return send(res, 200, { link })
        }
        const spanMatch = /^\/spans\/([^/]+)\/([^/]+)$/.exec(path)
        if (spanMatch?.[1] && spanMatch[2]) {
          const detail = await reader.readSpanDetail(
            decodeURIComponent(spanMatch[1]),
            decodeURIComponent(spanMatch[2]),
          )
          if (!detail) return send(res, 404, { error: 'span not found' })
          return send(res, 200, { detail })
        }
        // 正文全文：抽屉默认只回预览，点「展开原文」才走这里。
        // `(.+)` 故意接住被编码的斜杠（id 形如 span/<spanId>/thoughts/0），只解一次码。
        const textMatch = /^\/texts\/([^/]+)\/(.+)$/.exec(path)
        if (textMatch?.[1] && textMatch[2]) {
          const text = await reader.readText(
            decodeURIComponent(textMatch[1]),
            decodeURIComponent(textMatch[2]),
          )
          if (text === undefined) return send(res, 404, { error: 'text not found' })
          return send(res, 200, { text })
        }
        // 来源页：来源列表 → 事件分页 → 事件详情 → 事件全文。
        if (path === '/sources') return send(res, 200, { items: await reader.listSources() })
        const eventsMatch = /^\/sources\/([^/]+)\/events$/.exec(path)
        if (eventsMatch?.[1]) {
          const limit = clamp(Number(url.searchParams.get('limit') ?? 50), 1, 200)
          const cursor = url.searchParams.get('cursor') ?? undefined
          return send(res, 200, await reader.listSourceEvents(decodeURIComponent(eventsMatch[1]), limit, cursor))
        }
        const eventTextMatch = /^\/sources\/([^/]+)\/events\/([^/]+)\/text$/.exec(path)
        if (eventTextMatch?.[1] && eventTextMatch[2]) {
          const text = await reader.readSourceEventText(
            decodeURIComponent(eventTextMatch[1]), decodeURIComponent(eventTextMatch[2]))
          if (text === undefined) return send(res, 404, { error: 'event text not found' })
          return send(res, 200, { text })
        }
        const eventMatch = /^\/sources\/([^/]+)\/events\/([^/]+)$/.exec(path)
        if (eventMatch?.[1] && eventMatch[2]) {
          const detail = await reader.readSourceEvent(
            decodeURIComponent(eventMatch[1]), decodeURIComponent(eventMatch[2]))
          if (!detail) return send(res, 404, { error: 'event not found' })
          return send(res, 200, { detail })
        }
        const chainMatch = /^\/chains\/([^/]+)$/.exec(path)
        if (chainMatch?.[1]) {
          const chain = await reader.readChain(decodeURIComponent(chainMatch[1]))
          if (!chain) return send(res, 404, { error: 'chain not found' })
          const dispositions = await reader.readDispositions(chain.ticketId)
          return send(res, 200, { chain, dispositions })
        }
        return send(res, 404, { error: 'unknown route' })
      } catch (error) {
        // 路径里的坏百分号编码是请求本身有问题，不是插件故障，别回 500。
        if (error instanceof URIError) return send(res, 400, { error: 'bad percent-encoding in path' })
        // 只回错误摘要：异常消息可能夹带解析片段（如 JSON.parse 的上下文），
        // 不该顺着 500 原样反射给界面；排查请开 `DSH_AGENT_TRACE_LOG`。
        return send(res, 500, { error: String(error).slice(0, 200) })
      } finally {
        // 一次计数按「最终状态码」判定成败：403/404 是请求问题，不是插件故障。
        health.record(label, Date.now() - started, res.statusCode < 500)
      }
    },
  })
}

/** 读取 JSON body，上限 64KB；解析失败返回 undefined，不抛。 */
function readJson(req: RequestLike): Promise<unknown> {
  return new Promise(resolve => {
    if (!req.on) { resolve(undefined); return }
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      size += buffer.length
      if (size > 65_536) { resolve(undefined); return }
      chunks.push(buffer)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))) } catch { resolve(undefined) }
    })
    req.on('error', () => resolve(undefined))
  })
}

function sameOrigin(req: RequestLike, url: URL, port: number | undefined): boolean {
  const origin = req.headers['origin']
  if (typeof origin !== 'string' || !port) return true
  try {
    const parsed = new URL(origin)
    return parsed.port === String(port) || parsed.host === `127.0.0.1:${port}` || parsed.host === `localhost:${port}`
  } catch {
    return false
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(Math.max(Math.trunc(value), min), max)
}

function send(res: ResponseLike, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}
