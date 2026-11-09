/**
 * superagent 的私有契约只出现在这个文件里（P2）。
 * 任何表名、列名、字段路径的变化都只改这里；上层只见 domain 类型。
 */
import { DatabaseSync } from 'node:sqlite'

/** 只读句柄。打开失败返回 undefined，由调用方降级。 */
export function openStore(stateDir: string): StoreLike | undefined {
  try {
    return new SqliteStore(stateDir)
  } catch {
    return undefined
  }
}

export interface StoreLike {
  tickets(limit: number): RawTicket[]
  /** 按起点事件的来源过滤工单，新→旧。来源页的工单区跟着选中的来源走。 */
  ticketsBySource(source: string, limit: number): RawTicket[]
  ticket(id: string): RawTicket | undefined
  outbox(ticketId: string): RawOutbox[]
  triggers(): RawTrigger[]
  decisions(): RawDecision[]
  dispositions(): RawDisposition[]
  threads(): RawThread[]
  /** 任意 kv 行；`master-id` 就是主控会话 id（`src/kv.ts:33`）。 */
  kv(key: string): unknown

  // —— 来源页（B14）：单行查询与分组聚合，避免为了看一条事件扫全表 ——
  trigger(id: string): RawTrigger | undefined
  disposition(id: string): RawDisposition | undefined
  thread(key: string): RawThread | undefined
  /** 来源的接收数与最后活跃时刻（`select … from trigger group by source`）。 */
  sourceAggregates(): RawSourceAggregate[]
  /**
   * 去向行 + 它所属的来源（join trigger）。
   * 分类不在这里做：service 的唯一分类器负责，避免两套规则漂移。
   */
  dispositionSources(): { source: string; disposition: RawDisposition }[]
  /** 所有工单的 id / 标题 / 起点事件 / 起点来源，供来源计数与抽屉的关联工单。 */
  ticketIndex(): RawTicketIndexEntry[]
  /**
   * 把这条事件列进 `triggerIds` 的决定。**可能不止一条**：重评估（`core/evals.ts`）与
   * 退回重排队都会留下新决定行，去向的 `decisionId` 指针只指最新那次。选哪条由
   * `service/sources.ts` 的 `decisionFor` 决定，不要在这里按顺序取。
   */
  decisionsOfTrigger(triggerId: string): RawDecision[]
  /** 某来源的事件，从新到旧；`before` 是上一页最后一条的 `{at,id}`。 */
  sourceEventRows(source: string, limit: number, before?: { at?: string; id: string }): RawTrigger[]
  /** 配置里出现过的来源（含未安装/未启用的）。 */
  configuredSources(): { source: string; enabled?: boolean }[]
  /** 设置快照：`kv['settings-version:<revision>']`，按 revision 从新到旧。坏行跳过。 */
  settingsSnapshots(): RawSettingsSnapshot[]
  /**
   * 线程/会话显示名：`kv['source-labels:<source>']`（`src/kv.ts:39-40`）。
   * **不是来源标题**——来源标题只能来自注册表。
   */
  sourceLabels(source: string): Record<string, string> | undefined

  close(): void
}

/** 线程聚合（`src/core/model.ts:159-183`），只取展示要用的部分。 */
export interface RawThread {
  key: string
  ref?: { source?: string; id?: string }
  createdAt?: string
  lastAt?: string
  /** 订阅这张线程的工单。 */
  subscriptions?: string[]
  /** 只跟随上下文、没有写权限的工单。 */
  context?: string[]
  /** 线程上可读的属性，来源自定（如飞书话题名、Issue 编号）。 */
  meta?: Record<string, unknown>
  evaluating?: { id?: string; triggerIds?: string[] }
}

/** 一次派工（`src/core/model.ts:246-260`）。 */
export interface RawAssignment {
  id: string
  state: string
  createdAt?: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: { state?: string; summary?: string; at?: string }
  /** Inputs 最近一次送达 worker 的时刻。 */
  deliveredAt?: string
  /** worker 上一轮跑空、也没有等待项的时刻。 */
  idleAt?: string
}

/** ticket.inputs 的一条（`src/core/model.ts:262-286`）。按 kind 判别，只读展示用得到的字段。 */
export interface RawInput {
  id?: string
  kind?: string
  text?: string
  triggerId?: string
  decisionId?: string
  at?: string
  /** 人写的（只有 trigger 输入有这个标记）。 */
  human?: true
  /** 只作为上下文送达，不授权。 */
  context?: true
  /** worker 的会话把它读进某一步的时刻；null 表示还排在会话里。 */
  readAt?: string | null
  deliveredTo?: string
  deliveredAt?: string
  note?: string
  from?: string
  to?: string
  effect?: Record<string, unknown>
}

/** 提问（`src/core/model.ts:299`）：上游没有时间字段，时刻需要另行推断。 */
export interface RawAttention {
  id?: string
  question?: string
  /** 提出这个问题的那条人的消息。 */
  triggerId?: string
}

/** ticket.answers：上游是字符串数组；旧版本可能存过对象，读取时兼容两种。 */
export type RawAnswer = string | { text?: string; at?: string }

/** 工单跟随的线程（`src/core/model.ts:319-323`）。 */
export interface RawFollow {
  thread: string
  own: boolean
  closed?: { at: string; outcome: 'merged' | 'closed' }
}

/** 上下游的 ticket 行里我们用到的最小字段集（`src/core/model.ts:301-334`）。 */
export interface RawTicket {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  decisionId?: string
  mandate?: {
    strength?: string
    policyVersion?: string
    basis?: Record<string, unknown>
    actor?: { source?: string; id?: string }
    scope?: string
  }
  /** 收到消息时的出口；回复走这里。 */
  channels?: { source?: string; thread?: string; address?: Record<string, string> }[]
  assignments?: RawAssignment[]
  ended?: { at: string; by?: string; outcome: string; reason?: string }
  origin?: { triggerId: string; triggerIds: string[] }
  /** 上游的当前阶段（派生值，仅作参考；展示以完整 stage 计算为准）。 */
  stage?: string
  inputs?: RawInput[]
  /** 没交给运行中派工的 input id。 */
  undelivered?: string[]
  attention?: RawAttention | null
  answers?: readonly RawAnswer[]
  follows?: RawFollow[]
  delivery?: { at?: string; error?: string } | null
  execution?: { name?: string; directory?: string; assignment?: string }
}

/** 发出去的话。**没有时间字段**，时间要从会话日志取。 */
export interface RawOutbox {
  id: string
  text: string
  kind: string
  ticketId?: string
  status?: string
  channel?: { ticketId?: string; thread?: string; address?: Record<string, unknown> }
  dropped?: { at?: string; reason?: string }
}

export interface RawTrigger {
  id: string
  source: string
  at?: string
  text?: string
  addressed?: string | null
  human?: boolean
  threads?: { source: string; id: string }[]
  actor?: { source?: string; id?: string }
  channel?: { source?: string; thread?: string }
  meta?: Record<string, unknown>
}

export interface RawDecision {
  id: string
  evalId?: string
  threadKey?: string
  kind: string
  strength?: string
  at?: string
  ticketId?: string
  triggerIds?: string[]
  policyVersion?: string
  reason?: { code: string; values?: Record<string, string> }[]
  mandate?: {
    strength?: string
    policyVersion?: string
    basis?: Record<string, unknown>
    actor?: { source?: string; id?: string }
    scope?: string
  }
  audit?: {
    rule_assessments?: { rule_id: string; matched: boolean; reason?: string }[]
    direction?: Record<string, unknown>
  }
}

/** 来源的接收数与最后活跃时刻。 */
export interface RawSourceAggregate {
  source: string
  /** 去重后的触发条数（不是收到次数）。 */
  received: number
  lastAt?: string
}

/** 工单索引的一行：来源计数与关联工单都只用这几个字段。 */
export interface RawTicketIndexEntry {
  id: string
  title?: string
  originTriggerId?: string
  source?: string
}

/**
 * 设置快照（`app/store.ts:22-25` 的 `SettingsVersion`）。
 * 只声明本项目用得到的部分：策略历史与来源启用状态。
 */
export interface RawSettingsSnapshot {
  revision?: number
  savedAt?: string
  policyVersion?: string
  settings?: {
    sources?: Record<string, { enabled?: boolean }>
    policy?: {
      sources?: Record<string, { allowed?: { id?: string }[] }>
      rules?: { id?: string; enabled?: boolean }[]
    }
  }
}

/** 事件去向。字段名与上游 disposition 表一致。 */
export interface RawDisposition {
  /** 行主键就是 trigger id。 */
  id: string
  at?: string
  evalId?: string
  decisionId?: string
  filtered?: { code: string }
  fanout?: string[]
  acked?: string[]
  /** 只作为上下文送达的工单 id（不授权、不唤醒模型）。 */
  context?: string[]
  /** 被退回重排，说明这次派发没有落地。 */
  requeued?: unknown
  /** 退回到其他工单：上游写的是对象（`core/model.ts:57`，`{ticketId, reason, at}`），不是 id 串。 */
  handbacks?: { ticketId: string; reason?: string; at?: string }[]
}

class SqliteStore implements StoreLike {
  private readonly db: DatabaseSync

  constructor(stateDir: string) {
    this.db = new DatabaseSync(`${stateDir}/orchestrator.sqlite`, { readOnly: true })
  }

  tickets(limit: number): RawTicket[] {
    return this.rows('select value from ticket order by rowid desc limit ?', limit)
  }

  ticketsBySource(source: string, limit: number): RawTicket[] {
    // 起点事件决定来源（与 `ticketIndex()` 同一口径：ticket.origin.triggerId → trigger.source）。
    //
    // `json_valid` 是给坏行兜底的：`json_extract` 碰到非法 JSON **会抛 malformed JSON**，
    // 一条坏数据就能让整次查询失败（`rows()` 只兜 JSON.parse，兜不住 SQL 层的抛错）。
    // 不带 `source` 的列表走 `rows()`，坏行只是被跳过；带 `source` 时也要保持同样的容错。
    return this.rows<RawTicket>(
      'select t.value from ticket t join trigger g '
      + 'on json_valid(t.value) and json_valid(g.value) '
      + 'and g.id = json_extract(t.value, \'$.origin.triggerId\') '
      + "where json_valid(t.value) and json_extract(g.value, '$.source') = ? "
      + 'order by t.rowid desc limit ?',
      source, limit)
  }

  ticket(id: string): RawTicket | undefined {
    return this.rows<RawTicket>('select value from ticket where id = ?', id)[0]
  }

  outbox(ticketId: string): RawOutbox[] {
    return this.rows<RawOutbox>('select value from outbox order by rowid')
      .filter(item => item.ticketId === ticketId)
  }

  triggers(): RawTrigger[] {
    return this.rows('select value from trigger order by rowid')
  }

  decisions(): RawDecision[] {
    return this.rows('select value from decision order by rowid')
  }

  dispositions(): RawDisposition[] {
    return this.rowsWithId('select id, value from disposition order by rowid')
  }

  threads(): RawThread[] {
    return this.rows('select value from thread order by rowid')
  }

  trigger(id: string): RawTrigger | undefined {
    return this.rows<RawTrigger>('select value from trigger where id = ?', id)[0]
  }

  disposition(id: string): RawDisposition | undefined {
    return this.rowsWithId('select id, value from disposition where id = ?', id)[0]
  }

  thread(key: string): RawThread | undefined {
    return this.rows<RawThread>('select value from thread where key = ?', key)[0]
  }

  sourceAggregates(): RawSourceAggregate[] {
    const out: RawSourceAggregate[] = []
    const sql = "select json_extract(value, '$.source') as source, count(*) as n, max(at) as lastAt "
      + "from trigger where json_extract(value, '$.source') is not null group by source"
    for (const row of this.db.prepare(sql).all() as { source?: unknown; n?: unknown; lastAt?: unknown }[]) {
      if (typeof row.source !== 'string') continue
      out.push({
        source: row.source,
        received: typeof row.n === 'number' ? row.n : Number(row.n ?? 0),
        ...(typeof row.lastAt === 'string' ? { lastAt: row.lastAt } : {}),
      })
    }
    return out
  }

  dispositionSources(): { source: string; disposition: RawDisposition }[] {
    const out: { source: string; disposition: RawDisposition }[] = []
    const sql = 'select d.id as id, d.value as dv, t.value as tv from disposition d join trigger t on t.id = d.id'
    for (const row of this.db.prepare(sql).all() as { id?: unknown; dv?: unknown; tv?: unknown }[]) {
      if (typeof row.id !== 'string' || typeof row.dv !== 'string' || typeof row.tv !== 'string') continue
      try {
        const source = (JSON.parse(row.tv) as { source?: unknown }).source
        if (typeof source !== 'string') continue
        out.push({ source, disposition: { id: row.id, ...JSON.parse(row.dv) as object } })
      } catch { /* 跳过坏行 */ }
    }
    return out
  }

  ticketIndex(): RawTicketIndexEntry[] {
    const out: RawTicketIndexEntry[] = []
    // 左连起点事件：旧数据可能没有 origin，来源就留空，不拿别的来源顶替。
    const sql = "select t.id as id, json_extract(t.value, '$.title') as title, "
      + "json_extract(t.value, '$.origin.triggerId') as originTriggerId, "
      + "json_extract(g.value, '$.source') as source "
      + "from ticket t left join trigger g on g.id = json_extract(t.value, '$.origin.triggerId')"
    for (const row of this.db.prepare(sql).all() as Record<string, unknown>[]) {
      if (typeof row.id !== 'string') continue
      out.push({
        id: row.id,
        ...(typeof row.title === 'string' ? { title: row.title } : {}),
        ...(typeof row.originTriggerId === 'string' ? { originTriggerId: row.originTriggerId } : {}),
        ...(typeof row.source === 'string' ? { source: row.source } : {}),
      })
    }
    return out
  }

  decisionsOfTrigger(triggerId: string): RawDecision[] {
    return this.rows<RawDecision>(
      'select value from decision d where exists '
      + "(select 1 from json_each(d.value, '$.triggerIds') j where j.value = ?)", triggerId)
  }

  sourceEventRows(source: string, limit: number, before?: { at?: string; id: string }): RawTrigger[] {
    // 排序键与游标同源：`at` 列是 ISO 文本，字典序即时间序；同一时刻用 id 兜底。
    if (before?.at) {
      return this.rows<RawTrigger>(
        "select value from trigger where json_extract(value, '$.source') = ? "
        + 'and (at < ? or (at = ? and id < ?)) order by at desc, id desc limit ?',
        source, before.at, before.at, before.id, limit)
    }
    return this.rows<RawTrigger>(
      "select value from trigger where json_extract(value, '$.source') = ? order by at desc, id desc limit ?",
      source, limit)
  }

  configuredSources(): { source: string; enabled?: boolean }[] {
    const found = new Map<string, boolean | undefined>()
    const add = (source: unknown, enabled?: unknown): void => {
      if (typeof source !== 'string' || !source) return
      const state = typeof enabled === 'boolean' ? enabled : undefined
      // 名称来源可能多处出现：只要有一处带 enabled，就用它。
      found.set(source, found.get(source) ?? state)
    }
    for (const snapshot of this.settingsSnapshots()) {
      for (const [source, instance] of Object.entries(snapshot.settings?.sources ?? {})) {
        add(source, instance?.enabled)
      }
      for (const source of Object.keys(snapshot.settings?.policy?.sources ?? {})) add(source)
    }
    // 只存了某个块的修订号、但当前设置里已经删掉的来源：也算「配置过」。
    for (const row of this.db.prepare("select key from kv where key like 'settings-block-revision:source:%'").all() as { key?: unknown }[]) {
      if (typeof row.key !== 'string') continue
      const source = row.key.slice('settings-block-revision:source:'.length)
      add(source)
    }
    return [...found].map(([source, enabled]) => ({ source, ...(enabled === undefined ? {} : { enabled }) }))
      .sort((left, right) => left.source.localeCompare(right.source))
  }

  settingsSnapshots(): RawSettingsSnapshot[] {
    const out: { revision: number; snapshot: RawSettingsSnapshot }[] = []
    for (const row of this.db.prepare("select key, value from kv where key like 'settings-version:%'").all() as { key?: unknown; value?: unknown }[]) {
      if (typeof row.key !== 'string' || typeof row.value !== 'string') continue
      try {
        const snapshot = JSON.parse(row.value) as RawSettingsSnapshot
        // revision 以行里的值为准，缺失时退回键名；排序只看得到的那部分。
        const fromKey = Number(row.key.slice('settings-version:'.length))
        const revision = typeof snapshot.revision === 'number'
          ? snapshot.revision
          : Number.isFinite(fromKey) ? fromKey : 0
        out.push({ revision, snapshot })
      } catch { /* 跳过坏行 */ }
    }
    return out.sort((left, right) => right.revision - left.revision).map(item => item.snapshot)
  }

  sourceLabels(source: string): Record<string, string> | undefined {
    const value = this.kv(`source-labels:${source}`)
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const out: Record<string, string> = {}
    for (const [key, label] of Object.entries(value as Record<string, unknown>)) {
      if (typeof label === 'string' && label) out[key] = label
    }
    return Object.keys(out).length > 0 ? out : undefined
  }

  kv(key: string): unknown {
    for (const row of this.db.prepare('select value from kv where key = ?').all(key) as { value?: unknown }[]) {
      if (typeof row.value !== 'string') continue
      try { return JSON.parse(row.value) } catch { return undefined }
    }
    return undefined
  }

  close(): void {
    try { this.db.close() } catch { /* 关闭失败不影响宿主 */ }
  }

  /** 带主键的行：disposition 的 id 就是 trigger id，需要它来关联原文。 */
  private rowsWithId(sql: string, ...args: (number | string)[]): RawDisposition[] {
    const out: RawDisposition[] = []
    for (const row of this.all(sql, args) as { id?: unknown; value?: unknown }[]) {
      if (typeof row?.value !== 'string' || typeof row?.id !== 'string') continue
      try { out.push({ id: row.id, ...JSON.parse(row.value) as object }) } catch { /* 跳过坏行 */ }
    }
    return out
  }

  /** 行里存的是 JSON 文本；解析失败的行直接跳过，不让一行坏数据毁掉整次读取。 */
  private rows<T>(sql: string, ...args: (number | string)[]): T[] {
    const out: T[] = []
    for (const row of this.all(sql, args) as { value?: unknown }[]) {
      if (typeof row?.value !== 'string') continue
      try { out.push(JSON.parse(row.value) as T) } catch { /* 跳过 */ }
    }
    return out
  }

  /** 无参数时走全量查询，有参数时按位置绑定；调用方用空数组表示「不带参数」。 */
  private all(sql: string, args: (number | string)[]): unknown[] {
    const statement = this.db.prepare(sql)
    return args.length === 0 ? statement.all() : statement.all(...args)
  }
}
