/**
 * 会话事件读取。正文不复制（P3）：这里只产出 span 与指针，
 * 需要看内容时由 presenter 再按 seq 区间取。
 *
 * 上游只有 `ctx.sessionQuery` 一个入口；拿不到就返回空数组，不抛。
 */

/** 只声明我们用到的方法，避免把 DSH 的类型拖进 adapter 之外。 */
export interface SessionQueryLike {
  listEvents?(sessionId: string): Promise<readonly RawSessionEvent[]>
  readSession?(sessionId: string): Promise<{ events?: readonly RawSessionEvent[] }>
}

/** 会话事件的最小形状；字段名做兼容处理，缺字段就当没有。 */
export interface RawSessionEvent {
  seq?: number
  time?: number
  type?: string
  data?: Record<string, unknown>
}

/** 我们认为值得成为链路节点的会话事件。 */
const INTERESTING: ReadonlySet<string> = new Set([
  'tool/call',
  'tool/result',
  'step/start',
  'step/end',
])

export interface SessionSpan {
  readonly seq: number
  readonly atMs: number
  readonly type: string
  readonly tool?: string
}

/** 读取一个会话里的事件，按时间排序。读取失败返回空数组。 */
export async function readSessionEvents(
  query: SessionQueryLike | undefined,
  sessionId: string,
): Promise<readonly SessionSpan[]> {
  const events = await load(query, sessionId)
  const out: SessionSpan[] = []
  for (const event of events) {
    const type = typeof event?.type === 'string' ? event.type : ''
    if (!INTERESTING.has(type)) continue
    const atMs = typeof event.time === 'number' ? event.time : Number.NaN
    if (!Number.isFinite(atMs)) continue
    const tool = event.data && typeof event.data['name'] === 'string' ? String(event.data['name']) : undefined
    out.push({
      seq: typeof event.seq === 'number' ? event.seq : 0,
      atMs,
      type,
      ...(tool ? { tool } : {}),
    })
  }
  return out.sort((left, right) => left.atMs - right.atMs)
}

async function load(query: SessionQueryLike | undefined, sessionId: string): Promise<readonly RawSessionEvent[]> {
  if (!query) return []
  try {
    if (typeof query.listEvents === 'function') return await query.listEvents(sessionId)
    if (typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId)
      return snapshot?.events ?? []
    }
  } catch {
    /* 会话可能已被归档或删除：这不是错误，是预期内的缺失 */
  }
  return []
}
