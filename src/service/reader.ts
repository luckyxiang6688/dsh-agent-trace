/**
 * 数据层的统一入口：把两个 adapter 拼成 domain 的 ChainReader。
 * 这里是唯一知道「工单 ↔ 会话」关联规则的地方（P2 的边界）。
 */
import type {
  ChainReader, ChainSummary, Chain, Disposition, LinkDetail, Path, Span,
} from '../domain/model.ts'
import type { SourceEventDetail, SourceEventPage, SourceSummary } from '../domain/source.ts'
import { openStore, type RawTrigger, type StoreLike } from '../adapter/superagent/db.ts'
import {
  buildSourceEventDetail, decodeCursor, decisionsByTrigger, mergeSources, pageOf, toSourceEvents,
  type SourceDirectoryEntry,
} from './sources.ts'
import { buildChain, stateOf } from '../adapter/superagent/chain.ts'
import { chainSummary } from '../presenter/swimlane.ts'
import { readSessionEvents, type SessionQueryLike } from '../adapter/session/events.ts'
import { readSpanDetail, type EventFacts } from './detail.ts'
import { buildLink, type LinkEvent } from './link.ts'
import { readPolicy, type PolicySnapshot } from './policy.ts'
import { gateFacts, KIND_LABEL } from './facts.ts'
import { thoughtBeforeEval } from './thoughts.ts'
import type { TextSink } from './prose.ts'
import { findChildSessions, findRouterSessionId, readSessionHeader } from '../adapter/session/children.ts'
import {
  codeLabel, OUTCOME_LABEL, PROSE_PREVIEW_CHARS, REASON_LABEL, TICKET_END_BY_LABEL, TICKET_OUTCOME_LABEL,
  type ChainOrigin, type SpanDetail,
} from '../domain/model.ts'
import { workerSessionId } from '../domain/session.ts'

export interface ReaderOptions {
  readonly stateDir: string
  readonly sessionQuery?: SessionQueryLike
  /** 想法翻译；缺省则不翻译，直接显示原文。 */
  readonly translator?: {
    translate(texts: readonly string[]): Promise<(string | undefined)[]>
    peek?(texts: readonly string[]): (string | undefined)[]
  }
  /**
   * 宿主注册表给的来源目录（已安装与否、中文标题）。拿不到时返回空数组，
   * 来源列表退回「库里有事件 + 配置里出现过」的并集——不编造已安装状态。
   */
  readonly sourceDirectory?: () => readonly SourceDirectoryEntry[]
}

/** 关联规则：执行器会话的 id 是 `worker-<ticketId>`。实现收在 `domain/session.ts`，各视图共用。 */
export { workerSessionId }

export function createReader(options: ReaderOptions): ChainReader {
  const store: StoreLike | undefined = openStore(options.stateDir)
  /**
   * 策略快照**按需读**，不缓存。
   *
   * 设置随时会被保存：启动时读一份的话，之后新存的策略版本在 `at()` 里查不到，
   * 界面就会把「我们没刷新」说成「库里没有这份快照」——那是假话。
   * 代价只是每次扫一遍 `kv` 里少量 `settings-version:*` 行，且只在读工单/事件详情时发生。
   */
  const policyOf = (): PolicySnapshot | undefined => (store ? readPolicy(store) : undefined)
  const sourceDirectory = (): readonly SourceDirectoryEntry[] => {
    try { return options.sourceDirectory?.() ?? [] } catch { return [] }
  }

  /**
   * 正文全文缓存：抽屉只回预览，点「展开原文」再按 id 取全文。
   * 不缓存就得每次重读多帧 zstd 会话（一段就是几十帧），展开会明显卡。
   * 同一 id 的文本写入后不再变，命中即定值；按条数与字数双上限先进先出淘汰。
   */
  const textCache = new Map<string, string>()
  /**
   * 会话 header 的 `agentPreset`：header 是首帧，记的是**建会话时**的 preset，重选不会改写它。
   * 只缓存读到的值——会话还没建好时每次都重试，否则会把「暂时没有」记成「永远没有」。
   * 条数上限与 textCache 同级，长生命周期进程里不会无限堆积。
   */
  const presetCache = new Map<string, string>()
  const PRESET_CACHE_MAX = 2000
  const sessionsRoot = `${options.stateDir}/../../sessions`
  const presetOf = (sessionId: string): string | undefined => {
    const cached = presetCache.get(sessionId)
    if (cached !== undefined) return cached
    const preset = readSessionHeader(sessionsRoot, sessionId)?.agentPreset
    if (preset !== undefined) {
      if (presetCache.size >= PRESET_CACHE_MAX) {
        const oldest = presetCache.keys().next().value
        if (oldest !== undefined) presetCache.delete(oldest)
      }
      presetCache.set(sessionId, preset)
    }
    return preset
  }
  let cachedChars = 0
  const CACHE_MAX_ENTRIES = 2000
  const CACHE_MAX_CHARS = 6_000_000
  const cacheKey = (ticketId: string, textId: string): string => `${ticketId}\u0000${textId}`
  // 连线 id（arrow-trigger 等）跨工单重名，所以缓存键必须带工单。
  const remember = (ticketId: string, sink: ReadonlyMap<string, string>): void => {
    for (const [textId, text] of sink) {
      const key = cacheKey(ticketId, textId)
      // 后写覆盖前写：跑着的工单会继续追加事件，同一个位置 id（如 outcome）的正文会变，
      // 只认第一次会「展开的原文和预览对不上」。
      const previous = textCache.get(key)
      if (previous === text) continue
      if (previous !== undefined) cachedChars -= previous.length
      textCache.set(key, text)
      cachedChars += text.length
    }
    while (textCache.size > CACHE_MAX_ENTRIES || cachedChars > CACHE_MAX_CHARS) {
      const oldest = textCache.keys().next()
      if (oldest.done) break
      cachedChars -= textCache.get(oldest.value)?.length ?? 0
      textCache.delete(oldest.value)
    }
  }

  return {
    async listChains(limit: number, source?: string): Promise<readonly ChainSummary[]> {
      if (!store) return []
      const triggers = new Map(store.triggers().map(trigger => [trigger.id, trigger]))
      // 过滤在库里做（join 起点事件），不是取完再筛——否则 50 条里可能一张都不剩。
      const rows = source ? store.ticketsBySource(source, limit) : store.tickets(limit)
      // 行本来就在手里，decisions 整表只读一次：否则 N 张工单就扫 N 遍。
      const decisions = store.decisions()
      return rows.map(ticket => {
        const chain = buildChain(store, ticket.id, { ticket, decisions })
        const originId = ticket.origin?.triggerId
        const originSource = originId ? triggers.get(originId)?.source : undefined
        return {
          ticketId: ticket.id,
          title: ticket.title,
          state: stateOf(ticket),
          createdAt: ticket.createdAt,
          ...(ticket.ended?.at ? { endedAt: ticket.ended.at } : {}),
          stepCount: ticket.assignments?.length ?? 0,
          ...(originSource ? { source: originSource } : {}),
          ...(chain && originSource ? { summary: chainSummary({ ...chain, source: originSource }) } : {}),
        }
      })
    },

    async readChain(ticketId: string): Promise<Chain | undefined> {
      if (!store) return undefined
      const chain = buildChain(store, ticketId)
      if (!chain) return undefined
      const raw = store.ticket(ticketId)
      const triggers = new Map(store.triggers().map(trigger => [trigger.id, trigger]))
      const originId = raw?.origin?.triggerId
      const source = originId ? triggers.get(originId)?.source : undefined
      // 创建这张工单的全部触发（batch 可能有多条）；每条画一支事件箭头
      const origins: ChainOrigin[] = (raw?.origin?.triggerIds ?? [])
        .map(id => ({ triggerId: id, ...(triggers.get(id)?.at ? { at: triggers.get(id)!.at! } : {}) }))
      const events = await readSessionEvents(options.sessionQuery, workerSessionId(ticketId))
      const base = Date.parse(chain.createdAt)
      const subagents = await subagentSpans(
        options.sessionQuery, options.stateDir, workerSessionId(ticketId), base)
      // 本工单第一条触发的时刻：旧日志没有 `ticket_id` 时用它作归属下界。
      const firstTriggerMs = origins
        .map(origin => (origin.at ? Date.parse(origin.at) : Number.NaN))
        .filter(value => Number.isFinite(value))
      const sinceMs = firstTriggerMs.length > 0 ? Math.min(...firstTriggerMs) : base
      // 回复时刻只从主控会话的工具调用里取，取不到就少画一支箭头；
      // 这里不要求 trigger 命中（提到工单 id 的工具调用已按 ticket_id 过滤，归属仍然可靠）。
      const marks = await toolMarks(
        options.sessionQuery,
        ticketId,
        routerSessionOf(store, options.stateDir, ticketId, { requireMention: false }),
        sinceMs,
      )
      return {
        ...chain,
        ...(source ? { source } : {}),
        ...(origins.length > 0 ? { origins } : {}),
        ...(marks ? { marks } : {}),
        spans: [...mergeExecutorSpans(chain.spans, events, base), ...subagents],
      }
    },

    async readLink(ticketId: string, linkId: string): Promise<LinkDetail | undefined> {
      const chain = await this.readChain(ticketId)
      if (!chain) return undefined
      const raw = store?.ticket(ticketId)
      const assignments = (raw?.assignments ?? []).map((item, index) => {
        const base = Date.parse(chain.createdAt)
        const start = item.startedAt ? Date.parse(item.startedAt) - base : 0
        const end = item.endedAt ? Date.parse(item.endedAt) - base : start
        const report = item.report
        return {
          id: item.id,
          label: `派工 #${index + 1}`,
          startMs: start,
          endMs: end,
          ...(item.state ? { state: item.state } : {}),
          ...(report?.state ? { reportState: report.state } : {}),
          ...(report?.summary ? { reportSummary: report.summary } : {}),
          ...(report?.at ? { reportAt: report.at } : {}),
        }
      })
      const outbox = (store?.outbox(ticketId) ?? []).map(item => ({
        id: item.id,
        kind: item.kind,
        text: item.text,
        ...(item.status ? { status: item.status } : {}),
        ...(item.dropped?.reason ? { droppedReason: item.dropped.reason } : {}),
      }))
      const originTriggerId = raw?.origin?.triggerId
      // 每条起点事件都从 trigger 取完整记录：batch 的一批事件在 dispositions 里只剩第一条，
      // 第二支箭头不能因此说「库里有的原文没有记录」。
      const byId = new Map((store?.triggers() ?? []).map(item => [item.id, item]))
      const originIds = [...new Set([
        ...(raw?.origin?.triggerIds ?? []),
        ...(originTriggerId ? [originTriggerId] : []),
      ])]
      // 只有 trigger 记录真的在库里才给这一条；记录缺失就退回 dispositions 的降级文案，
      // 不能凭空造一个「发送者：人」。
      const originEvents: LinkEvent[] = originIds.flatMap(id => {
        const trigger = byId.get(id)
        if (!trigger) return []
        const threads = threadsOf(trigger)
        return [{
          triggerId: id,
          ...(trigger.text ? { text: trigger.text } : {}),
          ...(trigger.at ? { at: trigger.at } : {}),
          ...(trigger.actor?.id !== undefined ? { actor: String(trigger.actor.id) } : {}),
          ...(trigger.human !== undefined ? { human: trigger.human } : {}),
          ...(threads ? { threads } : {}),
          addressed: trigger.addressed ?? null,
        }]
      })
      const sink = new Map<string, string>()
      const link = buildLink({
        chain,
        // 复用上面那次 trigger 全表读取，别为一个抽屉扫两遍。
        dispositions: dispositionOf(store!, ticketId, byId),
        assignments,
        outbox,
        ...(originTriggerId ? { originTriggerId } : {}),
        ...(originEvents.length > 0 ? { originEvents } : {}),
      }, linkId, sink)
      remember(ticketId, sink)
      return link
    },

    async readSpanDetail(ticketId: string, spanId: string): Promise<SpanDetail | undefined> {
      const chain = await this.readChain(ticketId)
      if (!chain) return undefined
      // 主控会话只有评估块用得上；执行器/子代理块不该为它再扫一遍会话目录。
      let routerId: string | undefined
      let routerResolved = false
      const resolveRouterId = (): string | undefined => {
        if (!routerResolved) {
          routerResolved = true
          routerId = routerSessionOf(store, options.stateDir, ticketId)
        }
        return routerId
      }
      const sink = new Map<string, string>()
      const detail = await readSpanDetail(
        options.sessionQuery as never,
        workerSessionId(ticketId),
        chain,
        spanId,
        options.translator,
        {
          routerThoughts: async (id: string) => {
            const routerSessionId = resolveRouterId()
            if (!routerSessionId) return []
            try {
              const client = options.sessionQuery as unknown as {
                readSession?(sessionId: string): Promise<{ events?: readonly { type?: string; data?: Record<string, unknown> }[] }>
              }
              const snapshot = await client?.readSession?.(routerSessionId)
              const decision = store?.decisions().find(item => item.ticketId === id)
              // 按本次决定的 trigger_id 找它自己的评估调用，两条决定不再共用一段想法
              const thought = thoughtBeforeEval(snapshot?.events ?? [], decision?.triggerIds?.[0])
              return thought ? [thought] : []
            } catch { return [] }
          },
          routerReceived: (id: string) => {
            const decision = store?.decisions().find(item => item.ticketId === id)
            const triggerId = decision?.triggerIds?.[0]
            const trigger = triggerId ? store?.triggers().find(item => item.id === triggerId) : undefined
            return trigger?.text ? [trigger.text] : []
          },
          routerNote: (id: string) => {
            const decision = store?.decisions().find(item => item.ticketId === id)
            if (!decision) return '这次没有留下模型思考。'
            return (decision.audit?.rule_assessments?.length ?? 0) > 0
              ? '这次没有留下模型思考，但下面有模型对规则的逐条研判。'
              : '这次没有模型思考：准入已放行，直接转派工，不需要模型判断。'
          },
          factsFor: (id: string, collect?: TextSink) => {
            const decision = store?.decisions().find(item => item.ticketId === id)
            if (!decision) return []
            const triggerId = decision.triggerIds?.[0]
            const trigger = triggerId ? store?.triggers().find(item => item.id === triggerId) : undefined
            // 准入依据读 decision.mandate.basis，并按 policyVersion 回查当时的快照
            return gateFacts(decision, trigger, policyOf(), id, collect, resolveRouterId())
          },
          eventFacts: (id: string, spanId: string, collect?: TextSink) => eventFactsOf(store, id, spanId, collect),
          // 运行方：会话 header 的 agentPreset；读不到就 undefined，抽屉写「未记录」。
          presetOf,
          // 块首行：只用模型/系统自己写下的原文，取不到就不给。
          leadFor: (id: string, spanId: string) => {
            if (spanId.startsWith('decision-')) {
              const decision = store?.decisions().find(item => item.id === spanId.slice('decision-'.length))
              if (!decision) return undefined
              const scope = decision.mandate?.scope?.trim()
              if (scope) return { text: scope, source: 'system' as const }
              // 没有任务陈述时只给判定码，不把整段英文理由当首行。
              const label = codeLabel(KIND_LABEL, decision.kind) ?? decision.kind
              const code = decision.reason?.[0]?.code
              const reason = codeLabel(REASON_LABEL, code)
              return { text: reason ? `${label} · ${reason}` : label, source: 'system' as const }
            }
            if (spanId.startsWith('assignment-')) {
              const assignmentId = spanId.slice('assignment-'.length)
              const assignment = store?.ticket(id)?.assignments?.find(item => item.id === assignmentId)
              const summary = assignment?.report?.summary?.trim()
              // 报告是模型自己写的完成说明，首句就是核心；没有报告就不给首行。
              return summary ? { text: summary, source: 'model' as const } : undefined
            }
            return undefined
          },
        },
        sink,
      )
      remember(ticketId, sink)
      return detail
    },

    async readText(ticketId: string, textId: string): Promise<string | undefined> {
      const key = cacheKey(ticketId, textId)
      const hit = textCache.get(key)
      if (hit !== undefined) return hit
      // 未命中：按 id 前缀重建一次拥有它的抽屉（重建过程中会把全文写进缓存）。
      // id 里第一段就是拥有者：`span/<spanId>/...` 或 `link/<linkId>/...`。
      const [, owner] = /^span\/([^/]+)\//.exec(textId) ?? []
      const [, linkOwner] = /^link\/([^/]+)\//.exec(textId) ?? []
      try {
        if (owner) await this.readSpanDetail(ticketId, owner)
        else if (linkOwner) await this.readLink(ticketId, linkOwner)
        else return undefined
      } catch {
        return undefined
      }
      return textCache.get(key)
    },

    async readSessionSample(ticketId: string): Promise<Record<string, unknown>> {
      const client = options.sessionQuery as unknown as {
        readSession?(sessionId: string): Promise<{ events?: readonly Record<string, unknown>[] }>
        readEvent?(request: { sessionId: string; seq: number }): Promise<{ target?: unknown }>
      }
      let raw: readonly Record<string, unknown>[] = []
      try {
        raw = (await client?.readSession?.(workerSessionId(ticketId)))?.events ?? []
      } catch { /* 会话可能已归档 */ }
      const histogram: Record<string, number> = {}
      const samples: Record<string, unknown> = {}
      for (const event of raw) {
        const type = typeof event['type'] === 'string' ? String(event['type']) : '?'
        histogram[type] = (histogram[type] ?? 0) + 1
        if (!samples[type]) samples[type] = shapeOf(event)
      }
      const probe = raw.find(event => event['type'] === 'tool/call')
      let full: unknown
      if (probe && typeof probe['seq'] === 'number') {
        try {
          const window = await client?.readEvent?.({ sessionId: workerSessionId(ticketId), seq: probe['seq'] })
          full = window?.target
        } catch (error) { full = String(error) }
      }
      let sessions: unknown = 'unavailable'
      try {
        const client = options.sessionQuery as unknown as { listSessions?(): Promise<readonly Record<string, unknown>[]> }
        const all = await client?.listSessions?.()
        sessions = (all ?? []).map(item => {
          const keys = Object.keys(item)
          return { keys, id: item['id'], parentSession: item['parentSession'], origin: item['origin'], depth: item['delegationDepth'] }
        })
      } catch (error) { sessions = String(error) }
      return { total: raw.length, histogram, samples, full, sessions }
    },

    async readDispositions(ticketId: string): Promise<readonly Disposition[]> {
      if (!store) return []
      return dispositionOf(store, ticketId)
    },

    async listSources(): Promise<readonly SourceSummary[]> {
      if (!store) return []
      return mergeSources({
        aggregates: store.sourceAggregates(),
        dispositions: store.dispositionSources(),
        tickets: store.ticketIndex(),
        configured: store.configuredSources(),
        directory: sourceDirectory(),
      })
    },

    async listSourceEvents(source: string, limit: number, cursor?: string): Promise<SourceEventPage> {
      if (!store) return { items: [], more: false }
      const before = decodeCursor(cursor)
      const rows = store.sourceEventRows(source, limit + 1, before)
      const dispositions = new Map(rows.flatMap(row => {
        const disposition = store.disposition(row.id)
        return disposition ? [[row.id, disposition] as const] : []
      }))
      // 决定表通常很小：一次建索引比每行扫一次 json_each 便宜。
      const decisions = decisionsByTrigger(store.decisions())
      return pageOf(toSourceEvents(rows, dispositions, decisions), limit)
    },

    async readSourceEvent(source: string, triggerId: string): Promise<SourceEventDetail | undefined> {
      if (!store) return undefined
      const trigger = store.trigger(triggerId)
      // 不串源：路径里的来源必须和事件自己的来源一致。
      if (trigger && trigger.source !== source) return undefined
      const disposition = store.disposition(triggerId)
      if (!trigger && !disposition) return undefined
      const labels = store.sourceLabels(source)
      const threads = (trigger?.threads ?? []).map(thread => {
        const key = `${thread.source}:${thread.id}`
        const entry = store.thread(key)
        const label = labels?.[thread.id]
        return { key, ...(label ? { label } : {}), ...(entry ? { thread: entry } : {}) }
      })
      const policy = policyOf()
      return buildSourceEventDetail({
        source,
        triggerId,
        ...(trigger ? { trigger } : {}),
        ...(disposition ? { disposition } : {}),
        decisions: store.decisionsOfTrigger(triggerId),
        threads,
        tickets: store.ticketIndex(),
        ...(policy ? { policy } : {}),
      })
    },

    async readSourceEventText(source: string, triggerId: string): Promise<string | undefined> {
      if (!store) return undefined
      const trigger = store.trigger(triggerId)
      if (!trigger || trigger.source !== source) return undefined
      return typeof trigger.text === 'string' ? trigger.text : undefined
    },
  }
}

/**
 * 这张工单的主控会话。
 *
 * `kv['master-id']` 是上游自己维护的指针（`src/kv.ts:33`），优先用它；
 * 没有指针才按 trigger id 在 `orchestrator-*` 会话里找——**找不到就返回 undefined**，
 * 不拿「最新的某个主控会话」顶替（会话目录跨 workspace，顶替会署错名）。
 */
function routerSessionOf(
  store: StoreLike | undefined,
  stateDir: string,
  ticketId: string,
  options: { requireMention?: boolean } = {},
): string | undefined {
  if (!store) return undefined
  const master = store.kv('master-id')
  if (typeof master === 'string' && master) return master
  const decision = store.decisions().find(item => item.ticketId === ticketId)
  const at = decision?.at ? Date.parse(decision.at) : undefined
  return findRouterSessionId(`${stateDir}/../../sessions`, {
    ...(Number.isFinite(at) ? { atMs: at } : {}),
    ...(decision?.triggerIds ? { triggerIds: decision.triggerIds } : {}),
    // 署名给用户看时没命中就写「未记录」，不许拿别的 workspace 的主控会话顶替；
    // 取回复时刻等「按 ticket_id 过滤」的场景允许退回最新一个。
    ...(options.requireMention !== false ? { requireMention: true } : {}),
  })
}

/** 会话日志里的一条事件，只关心工具调用需要的字段。 */
export interface ToolCallEvent {
  type?: string
  time?: number
  data?: Record<string, unknown>
}

/** 工具入参里的工单归属：上游统一写 `ticket_id`，兼容驼峰。 */
function ticketIdOf(arguments_: unknown): string | undefined {
  let value = arguments_
  if (typeof arguments_ === 'string') {
    try { value = JSON.parse(arguments_) } catch { return undefined }
  }
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const id = record['ticket_id'] ?? record['ticketId']
  return typeof id === 'string' ? id : undefined
}

/**
 * 某会话里某个工具的调用时刻，**只收本工单的**。
 *
 * 主控会话是长生命周期的：同一个 `orchestrator-*` 会话里既有别的工单的 reply，
 * 也可能有几小时前的。不过滤的话，别的工单的回复会把时间轴起点拉到十几个小时前，
 * 本工单真实的几分钟会被压成亚像素——图上看起来就是「什么都没有」。
 * 归属证据是工具入参里的 `ticket_id`；旧日志没有这个字段时，用「不早于本工单首条触发」兜底。
 */
export function toolCallTimes(
  events: readonly ToolCallEvent[],
  tool: string,
  ticketId: string,
  sinceMs?: number,
): number[] {
  const out: number[] = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    if (typeof event.time !== 'number') continue
    const data = event.data ?? {}
    if (data['name'] !== tool) continue
    const owner = ticketIdOf(data['arguments'])
    if (owner !== undefined) {
      if (owner !== ticketId) continue
    } else if (sinceMs !== undefined && event.time < sinceMs) {
      continue
    }
    out.push(event.time)
  }
  return out
}

/**
 * 关键时点：`orchestrator_ack` 由执行器调用，`orchestrator_reply` 由主控调用。
 * 直接从会话日志里取工具调用的时间戳——比按块边界估算准。
 */
async function toolMarks(
  query: SessionQueryLike | undefined,
  ticketId: string,
  routerId: string | undefined,
  sinceMs?: number,
): Promise<{ ackMs?: number; replyMs?: number; replies?: number[] } | undefined> {
  const client = query as unknown as {
    readSession?(sessionId: string): Promise<{ events?: readonly ToolCallEvent[] }>
  }
  const timesOf = async (sessionId: string | undefined, tool: string): Promise<number[]> => {
    if (!sessionId || !client?.readSession) return []
    try {
      const snapshot = await client.readSession(sessionId)
      return toolCallTimes(snapshot?.events ?? [], tool, ticketId, sinceMs)
    } catch { return [] } // 会话可能已归档
  }
  const acks = await timesOf(workerSessionId(ticketId), 'orchestrator_ack')
  const replies = await timesOf(routerId, 'orchestrator_reply')
  if (acks.length === 0 && replies.length === 0) return undefined
  return {
    ...(acks[0] !== undefined ? { ackMs: acks[0] } : {}),
    ...(replies[0] !== undefined ? { replyMs: replies[0] } : {}),
    ...(replies.length > 0 ? { replies } : {}),
  }
}

/**
 * 子代理会话：header 里 `parentSession` 指向父会话，`delegationDepth` 给出层级。
 * 嵌套在执行器列内，不单独占列。
 */
async function subagentSpans(
  query: SessionQueryLike | undefined,
  stateDir: string,
  parentId: string,
  base: number,
): Promise<readonly Span[]> {
  const root = `${stateDir}/../../sessions`
  const client = query as unknown as {
    readSession?(sessionId: string): Promise<{ events?: readonly { time?: number }[] }>
  }
  const spans: Span[] = []
  for (const [index, child] of findChildSessions(root, parentId).entries()) {
    // 子代理的结束时间取它自己最后一条事件——否则时间窗是 0 长度，详情只会截到开头
    let endMs = Math.max(child.createdAt - base, 0)
    try {
      const snapshot = await client?.readSession?.(child.id)
      const times = (snapshot?.events ?? [])
        .map(event => event.time)
        .filter((time): time is number => typeof time === 'number')
      if (times.length > 0) endMs = Math.max(Math.max(...times) - base, 0)
    } catch { /* 会话读不到就用创建时间 */ }
    const startMs = Math.max(child.createdAt - base, 0)
    spans.push({
      id: `subagent-${child.id}`,
      role: 'subagent' as const,
      kind: 'activity' as const,
      label: `子代理 #${index + 1}`,
      badge: child.depth > 1 ? `第 ${child.depth} 层` : '委派',
      startMs,
      endMs: Math.max(endMs, startMs),
      source: { sessionId: child.id },
    })
  }
  return spans
}

/**
 * 把会话事件折进执行器那一段：不新增列，只把 step/tool 收进同一个 span。
 * 事件为空时原样返回——内容缺失是正常情况，不是错误。
 */
function mergeExecutorSpans(
  spans: readonly Span[],
  events: readonly { atMs: number; type: string; tool?: string }[],
  base: number,
): readonly Span[] {
  if (events.length === 0 || !Number.isFinite(base)) return spans
  return spans.map(span => {
    // 离散事件不是派工：不参与「N 次工具调用」的统计。
    if (span.role !== 'executor' || span.kind !== 'activity') return span
    // 只统计落在这一段派工时间窗内的事件
    const tools = events.filter(event => {
      if (event.type !== 'tool/call') return false
      const offset = event.atMs - base
      return offset >= span.startMs && offset <= span.endMs
    }).length
    // 「调用」二字就够：整行是「② 派工 #1 · 23 次调用」，写全「工具调用」会挤出块宽。
    return { ...span, badge: tools > 0 ? `${tools} 次调用` : span.badge }
  })
}

type EventFact = NonNullable<EventFacts['facts']>[number]

/**
 * 离散事件的抽屉内容。全部取自领域表（ticket / decision），不读会话日志：
 * 这些事件本来就没有会话痕迹，硬读只会得到空。
 */
export function eventFactsOf(
  store: StoreLike | undefined,
  ticketId: string,
  spanId: string,
  sink?: TextSink,
): EventFacts | undefined {
  if (!store) return undefined
  const ticket = store.ticket(ticketId)
  if (!ticket) return undefined
  // 事件里的「问题 / 错误 / 原因」是自由文本，可能很长：同样只回预览、全文按 id 另取。
  const free = (text: string, key: string): Pick<EventFact, 'value' | 'prose'> => {
    if (text.length <= PROSE_PREVIEW_CHARS) return { value: text }
    const id = `span/${spanId}/facts/${key}`
    sink?.set(id, text)
    return { value: text.slice(0, PROSE_PREVIEW_CHARS), prose: { length: text.length, id } }
  }

  if (spanId === 'event-attention') {
    const attention = ticket.attention
    if (!attention) return undefined
    const facts: EventFact[] = [
      {
        label: '问题',
        group: 'meta',
        ...free(attention.question ?? '（上游没有记录问题正文）', 'question'),
      },
    ]
    if (attention.triggerId) facts.push({ label: '对应消息', value: attention.triggerId, group: 'meta' })
    return {
      title: '提问 · 执行器 → 人',
      facts,
      note: '提问时刻没有落库：图上的位置按提出问题的报告反推，起点画虚线。',
    }
  }

  if (spanId === 'event-delivery') {
    const delivery = ticket.delivery
    if (!delivery) return undefined
    return {
      title: '投递失败 · 输入没有送到执行器',
      facts: [
        { label: '时间', value: localTime(delivery.at), group: 'meta' },
        { label: '错误', group: 'meta', tone: 'warn', ...free(delivery.error ?? '（上游没有记录错误文本）', 'error') },
      ],
      note: '上游在下次投递成功或工单结束时清除这条记录，所以它只反映当前状态。',
    }
  }

  if (spanId === 'event-ended') {
    const ended = ticket.ended
    if (!ended) return undefined
    const facts: EventFact[] = [
      { label: '时间', value: localTime(ended.at), group: 'meta' },
      { label: '由谁结束', value: codeLabel(TICKET_END_BY_LABEL, ended.by) ?? '未记录', group: 'meta' },
      { label: '去向', value: codeLabel(TICKET_OUTCOME_LABEL, ended.outcome) ?? ended.outcome, group: 'decision', tone: ended.outcome === 'failed' ? 'warn' : 'ok' },
    ]
    if (ended.reason) facts.push({ label: '原因', group: 'meta', ...free(ended.reason, 'reason') })
    return { title: `工单 Ticket ${ticketId} · 结束`, facts }
  }

  const retry = /^event-retry-(.+)$/.exec(spanId)
  if (retry?.[1]) {
    const list = ticket.assignments ?? []
    const index = list.findIndex(item => item.id === retry[1])
    if (index < 0) return undefined
    const previous = list[index - 1]
    const facts: EventFact[] = [
      { label: '上一次派工', value: previous ? `#${index} · ${previous.state}` : '未知', group: 'meta' },
      { label: '上一次结束原因', value: previous?.endedReason ?? '未记录', group: 'meta', tone: 'warn' },
      { label: '本次起点', value: localTime(list[index]?.createdAt), group: 'meta' },
    ]
    return {
      title: `重试 · 第 ${index + 1} 次派工`,
      facts,
      note: '上游用一条新派工重试，旧派工的结束原因是「人工重试（retried）」；新派工的创建时刻就是重试点。',
    }
  }

  const decisionId = /^event-decision-(.+)$/.exec(spanId)
  if (decisionId?.[1]) {
    const found = store.decisions().find(item => item.id === decisionId[1])
    if (!found) return undefined
    const facts: EventFact[] = [
      { label: '判定', value: codeLabel(OUTCOME_LABEL, found.kind) ?? found.kind, group: 'decision', tone: found.kind === 'stop' ? 'warn' : 'muted' },
    ]
    for (const reason of found.reason ?? []) {
      facts.push({ label: '理由码', value: codeLabel(REASON_LABEL, reason.code) ?? reason.code, group: 'decision', tone: 'muted' })
    }
    return {
      title: found.kind === 'stop' ? '停止 · 主控判定' : '不可用 · 主控判定',
      facts,
      note: found.kind === 'stop'
        ? '这是合法的停止判定；非法的停止请求在上游会被降级成「不接（ignore）」，不会出现在这里。'
        : '不可用是判定结果，不是失败。',
    }
  }

  return undefined
}

/** 时间戳 → 本地可读；缺失或解析失败给一句明确说明，不留空。 */
function localTime(value: string | undefined): string {
  if (!value) return '（没有记录时间）'
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : value
}

/**
 * 事件去向。三条路径互斥，按终态优先级归类：
 * 直达工单 > 进评估 > 源头丢弃。
 *
 * 关键：本工单线程上**被规则拒绝**的事件（没有 ticketId）也必须算进来，
 * 否则比例带会漏掉"没被理"的那一类。
 */
function dispositionOf(
  store: StoreLike,
  ticketId: string,
  known?: ReadonlyMap<string, RawTrigger>,
): readonly Disposition[] {
  const triggers = known ?? new Map(store.triggers().map(trigger => [trigger.id, trigger]))
  const ticket = store.ticket(ticketId)
  const originTrigger = ticket?.origin?.triggerId ? triggers.get(ticket.origin.triggerId) : undefined
  const threadKeys = new Set<string>(
    (originTrigger?.threads ?? []).map(thread => `${thread.source}:${thread.id}`),
  )

  const out: Disposition[] = []
  const seen = new Set<string>()

  for (const decision of store.decisions()) {
    const onTicket = decision.ticketId === ticketId
    const onThread = decision.threadKey !== undefined && [...threadKeys].some(
      key => decision.threadKey === key || decision.threadKey?.endsWith(`:${key}`),
    )
    if (!onTicket && !onThread) continue
    const trigger = decision.triggerIds?.[0] ? triggers.get(decision.triggerIds[0]) : undefined
    const key = decision.id
    if (seen.has(key)) continue
    seen.add(key)
    out.push({
      path: 'routed',
      outcome: decision.kind,
      ...(decision.at ? { at: decision.at } : {}),
      ...(trigger?.text ? { text: trigger.text } : {}),
      ...(trigger?.id ? { triggerId: trigger.id } : {}),
      ...(trigger?.actor?.id ? { actor: String(trigger.actor.id) } : {}),
      ...(trigger?.human !== undefined ? { human: trigger.human } : {}),
      ...(threadsOf(trigger) ? { threads: threadsOf(trigger) } : {}),
      ...(trigger ? { addressed: trigger.addressed ?? null } : {}),
    })
  }

  for (const row of store.dispositions()) {
    const fanout = row.fanout ?? []
    const trigger = triggers.get(row.id)
    const common = {
      ...(row.at ? { at: row.at } : {}),
      ...(trigger?.text ? { text: trigger.text } : {}),
      triggerId: row.id,
      ...(trigger?.actor?.id ? { actor: String(trigger.actor.id) } : {}),
      ...(trigger?.human !== undefined ? { human: trigger.human } : {}),
      ...(threadsOf(trigger) ? { threads: threadsOf(trigger) } : {}),
      ...(trigger ? { addressed: trigger.addressed ?? null } : {}),
    }
    if (row.filtered) {
      out.push({ path: 'filtered', outcome: row.filtered.code, ...common })
      continue
    }
    // context-only 只作为上下文送达，不授权、不唤醒模型：单列一类，不能算「订阅直通」
    if (row.context?.includes(ticketId)) {
      out.push({ path: 'context', outcome: 'delivered', ...common })
      continue
    }
    if (row.requeued) continue
    if ((row.handbacks?.length ?? 0) > 0) continue
    if (fanout.includes(ticketId) && !row.decisionId) {
      out.push({ path: 'direct', outcome: 'delivered', ...common })
    }
  }

  return out
}

/** 事件第一层字段名与类型，只给开发期调试路由看形状。 */
function shapeOf(event: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(event)) {
    out[key] = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value
  }
  return out
}

/** 事件所在线程：优先用 id（上游已含来源前缀），否则拼 `source:id`。 */
function threadsOf(trigger: { threads?: { source: string; id: string }[] } | undefined): readonly string[] | undefined {
  const list = (trigger?.threads ?? []).map(thread => thread.id || `${thread.source}:${thread.id}`).filter(Boolean)
  return list.length > 0 ? list : undefined
}
