/**
 * 插件自身的健康快照（M4 §6.4）：出问题要能自证。
 *
 * 这个插件是**纯读者**：不采集、不建索引。所以 §6.4 的四项在这里的落点是：
 *   - 插件自身 health → 本文件的计数器 + `GET /agent-trace/health`；
 *   - 采集延迟       → 不适用（插件不采集；探针的处理开销另有实测，见 `09` §6.2）；
 *   - 丢弃计数       → 业务数据，来源页比例带与 `/sources` 已经给了，不在这份快照里重复；
 *   - 索引重建状态   → 不适用（每次查询直接读 sqlite，没有索引可重建）。
 *
 * 只记**计数与耗时**，不记路径参数与正文：健康接口和日志一样，不该成为内容泄漏面。
 */

export interface RouteStat {
  /** 请求次数。 */
  count: number
  /** 抛异常的次数（异常最终会变成 500）。 */
  errors: number
  /** 最近一次的耗时。 */
  lastMs: number
  /** 观测到的最大耗时。 */
  maxMs: number
}

/** 存储可用性探测：读一次库，回报成败与耗时。 */
export type StoreProbe = () => { ok: boolean; ms: number; error?: string }

/** 探测用得到的最小存储接口：能读一个键、能关。 */
export interface ProbeStore {
  kv(key: string): unknown
  close(): void
}

/**
 * 存储探测：句柄能开、能读一个最廉价的键，就算可用。
 *
 * `close()` 必须在 `finally` 里：缺 kv 表、文件损坏、瞬时锁都会让 `kv()` 抛，
 * 而 `/health` 恰恰是故障时被高频轮询的接口——漏一个句柄就会把 fd 攒满，
 * 反过来影响宿主（违背 P4「任何失败都不得影响宿主」）。有单测钉住这条路径。
 */
export function storeProbe(open: () => ProbeStore | undefined): StoreProbe {
  return () => {
    const started = Date.now()
    let store: ProbeStore | undefined
    try {
      store = open()
      if (!store) return { ok: false, ms: Date.now() - started, error: 'store unavailable' }
      store.kv('master-id')
      return { ok: true, ms: Date.now() - started }
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: String(error).slice(0, 120) }
    } finally {
      store?.close()
    }
  }
}

export interface HealthSnapshot {
  ok: boolean
  /** 进程内自 apply 以来的毫秒数。 */
  uptimeMs: number
  /** 累计 500 次数（各模板之和）：给监控一个单一数字，不必自己遍历 routes。 */
  errors: number
  /** 按路由标签聚合：标签是路径模板，不含 id。 */
  routes: Record<string, RouteStat>
  /** 没接存储探测时缺省（桌面/测试环境可能没有 stateDir）。 */
  store?: { ok: boolean; ms: number; error?: string }
}

export interface HealthTracker {
  record(route: string, ms: number, ok: boolean): void
  snapshot(): HealthSnapshot
}

export function createHealth(now: () => number = Date.now, probe?: StoreProbe): HealthTracker {
  const startedAt = now()
  const routes = new Map<string, RouteStat>()

  return {
    record(route, ms, ok) {
      const stat = routes.get(route) ?? { count: 0, errors: 0, lastMs: 0, maxMs: 0 }
      stat.count += 1
      stat.errors += ok ? 0 : 1
      stat.lastMs = Math.round(ms)
      stat.maxMs = Math.max(stat.maxMs, Math.round(ms))
      routes.set(route, stat)
    },
    snapshot() {
      let store: HealthSnapshot['store']
      if (probe) {
        try { store = probe() } catch (error) { store = { ok: false, ms: 0, error: String(error).slice(0, 120) } }
      }
      // 健康与否只看存储：路由计数器本身反映的是流量，不是故障。
      // 累计 errors 故意不并入 ok——它自 apply 起只增不减，一次历史 500 会让 ok 永久为 false。
      // 要看「现在是不是在挨打」，读 errors 这个数或各模板的计数。
      const entries = Object.fromEntries(routes)
      return {
        ok: store ? store.ok : true,
        uptimeMs: now() - startedAt,
        errors: Object.values(entries).reduce((sum, stat) => sum + stat.errors, 0),
        routes: entries,
        ...(store ? { store } : {}),
      }
    },
  }
}

/**
 * 把 URL 路径压成一个固定标签：`/sources/fixture/events/tr-1` → `/sources/:source/events/:id`。
 * 计数按模板聚合，否则每个 id 一条，既读不出趋势，也会让快照随流量膨胀。
 */
export function routeLabel(path: string): string {
  if (path === '/chains' || path === '/sources' || path === '/health') return path
  if (path === '/translate') return path
  if (path.startsWith('/sources/')) {
    // '/sources/<source>/events' → ['', 'sources', '<source>', 'events']，再往后是 /<id> 与 /text。
    const parts = path.split('/')
    if (parts[3] === 'events' && parts.length === 4) return '/sources/:source/events'
    if (parts[3] === 'events' && parts.length === 5) return '/sources/:source/events/:id'
    if (parts[3] === 'events' && parts[5] === 'text' && parts.length === 6) return '/sources/:source/events/:id/text'
    return '/sources/:source/*'
  }
  // 下面这些模板必须与 `routes.ts` 的正则逐字对应（复数、段数、斜杠数）：
  // 早先这里写成 `/chain/`、`/span/`、`/link/`，与真实路由差一个 s，
  // 结果工单详情/泳道/正文全文的请求全被算进 `/other`，快照等于没观测到它们。
  if (/^\/chains\/[^/]+$/.test(path)) return '/chains/:id'
  if (/^\/spans\/[^/]+\/[^/]+$/.test(path)) return '/spans/:ticket/:span'
  if (/^\/links\/[^/]+\/[^/]+$/.test(path)) return '/links/:ticket/:path'
  // 正文 id 形如 `span/<spanId>/thoughts/0`（斜杠未编码时还能多段），这里不数段。
  if (/^\/texts\/[^/]+\/.+$/.test(path)) return '/texts/:ticket/:id'
  if (/^\/debug\/[^/]+$/.test(path)) return '/debug/:session'
  return '/other'
}
