/**
 * 来源页的纯逻辑：分类、合并、游标、抽屉内容。
 *
 * 两条纪律：
 * - **只有一个分类器**（`fateOf`），比例带计数、事件行徽章、来源统计都调它。
 * - **事实与解释分开**：事实只写库里的字段；解释按表翻译并单独成段；
 *   库里没写的东西进 `notRecorded`，绝不用推测补全。
 */
import type {
  EventFate, SourceCounts, SourceEvent, SourceEventDetail, SourceEventFact,
  SourceEventInterpretation, SourceEventPage, SourceSummary,
} from '../domain/source.ts'
import {
  ACCEPT_MODE_LABEL, ADDRESSED_LABEL, CELL_LABEL, codeLabel, OUTCOME_LABEL, PROSE_PREVIEW_CHARS,
  REASON_LABEL, RULE_LABEL, STRENGTH_LABEL, VIA_LABEL,
} from '../domain/model.ts'
import type {
  RawDecision, RawDisposition, RawSourceAggregate, RawThread, RawTicketIndexEntry, RawTrigger,
} from '../adapter/superagent/db.ts'
import { interpretDecisionKind, interpretFilteredCode, interpretReasonCode } from './explain.ts'
import type { PolicySnapshot } from './policy.ts'

/** 注册表给的来源目录项；测试与拿不到宿主能力时为空。 */
export interface SourceDirectoryEntry {
  readonly source: string
  readonly label?: string
  readonly installed?: boolean
  readonly enabled?: boolean
}

/**
 * 一条事件的去向。**优先级写死在这里**，单测锁住：
 * filtered > requeued > handback > routed > context > direct > undecided > unrecorded。
 */
export function fateOf(disposition: RawDisposition | undefined, decision?: RawDecision): EventFate {
  if (!disposition) return { kind: 'unrecorded' }
  // 源头丢弃：`Intake.receive` 只写 filtered.code，不写线程、不发事件。
  if (disposition.filtered) return { kind: 'filtered', code: disposition.filtered.code }
  if (disposition.requeued) return { kind: 'requeued' }
  // 坏数据（非数组、元素为 null）不许把整页读挂：上游正常写入不含这些形状，
  // 但只读库可能遇到别的写入方。
  const handbacks = Array.isArray(disposition.handbacks) ? disposition.handbacks : []
  if (handbacks.length > 0) {
    // 上游写的是 `{ticketId, reason, at}` 对象；视图只要 id。
    return { kind: 'handback', tickets: handbacks.flatMap(item => item?.ticketId ? [item.ticketId] : []) }
  }
  // 有裁定：以决定行为准；决定行缺失（旧数据/写入中断）时仍算「已裁定」，但内容标为未记录。
  if (decision || disposition.decisionId) {
    const decisionId = disposition.decisionId ?? decision?.id
    const evalId = disposition.evalId ?? decision?.evalId
    const ticketId = decision?.ticketId
    return {
      kind: 'routed',
      ...(decisionId ? { decisionId } : {}),
      ...(evalId ? { evalId } : {}),
      ...(decision?.kind ? { decisionKind: decision.kind } : {}),
      ...(ticketId ? { ticketId } : {}),
    }
  }
  if ((disposition.context?.length ?? 0) > 0) return { kind: 'context', tickets: disposition.context! }
  if ((disposition.fanout?.length ?? 0) > 0) return { kind: 'direct', tickets: disposition.fanout! }
  return { kind: 'undecided' }
}

const EMPTY_COUNTS: SourceCounts = {
  routed: 0, direct: 0, context: 0, filtered: 0, requeued: 0, handback: 0, undecided: 0,
}

function tally(counts: SourceCounts, fate: EventFate): SourceCounts {
  const next = { ...counts }
  if (fate.kind === 'unrecorded') return next
  next[fate.kind] += 1
  return next
}

/**
 * 三源并集：库里的接收数、配置里出现过的来源、宿主注册表的已安装来源。
 * 装了但没有事件的来源也要列出来（界面置灰），否则「这个来源没收到任何东西」不可见。
 */
export function mergeSources(input: {
  aggregates: readonly RawSourceAggregate[]
  dispositions: readonly { source: string; disposition: RawDisposition }[]
  tickets: readonly RawTicketIndexEntry[]
  configured: readonly { source: string; enabled?: boolean }[]
  directory: readonly SourceDirectoryEntry[]
}): readonly SourceSummary[] {
  const sources = new Set<string>()
  const received = new Map<string, number>()
  const lastAt = new Map<string, string>()
  for (const item of input.aggregates) {
    sources.add(item.source)
    received.set(item.source, item.received)
    if (item.lastAt) lastAt.set(item.source, item.lastAt)
  }
  const counts = new Map<string, SourceCounts>()
  for (const { source, disposition } of input.dispositions) {
    sources.add(source)
    counts.set(source, tally(counts.get(source) ?? EMPTY_COUNTS, fateOf(disposition)))
  }
  const ticketCount = new Map<string, number>()
  for (const ticket of input.tickets) {
    if (!ticket.source) continue
    ticketCount.set(ticket.source, (ticketCount.get(ticket.source) ?? 0) + 1)
  }

  const directory = new Map(input.directory.map(entry => [entry.source, entry]))
  const configured = new Map(input.configured.map(entry => [entry.source, entry]))
  for (const source of directory.keys()) sources.add(source)
  for (const source of configured.keys()) sources.add(source)

  const out: SourceSummary[] = []
  for (const source of sources) {
    const tallyOf = counts.get(source) ?? EMPTY_COUNTS
    const classified = Object.values(tallyOf).reduce((sum, value) => sum + value, 0)
    const total = received.get(source) ?? 0
    const entry = directory.get(source)
    const config = configured.get(source)
    const enabled = entry?.enabled ?? config?.enabled
    out.push({
      source,
      ...(entry?.label ? { label: entry.label } : {}),
      ...(entry?.installed === undefined ? {} : { installed: entry.installed }),
      ...(enabled === undefined ? {} : { enabled }),
      received: total,
      tickets: ticketCount.get(source) ?? 0,
      ...(lastAt.get(source) ? { lastAt: lastAt.get(source)! } : {}),
      counts: tallyOf,
      unrecorded: Math.max(total - classified, 0),
    })
  }
  // 最近活跃在前；没有事件的来源排后面，按名字排。
  return out.sort((left, right) => {
    if (left.lastAt && right.lastAt) return right.lastAt.localeCompare(left.lastAt) || left.source.localeCompare(right.source)
    if (left.lastAt) return -1
    if (right.lastAt) return 1
    return left.source.localeCompare(right.source)
  })
}

/**
 * 游标：`{at,id}` 的 base64url。坏游标返回 undefined（调用方退回最新一页），不 500。
 * 不带 `at` 的游标没有意义：事件表的时间列是 NOT NULL。
 */
export function encodeCursor(event: { at?: string; triggerId: string }): string | undefined {
  if (!event.at) return undefined
  return Buffer.from(JSON.stringify({ at: event.at, id: event.triggerId }), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string | undefined): { at: string; id: string } | undefined {
  if (!cursor) return undefined
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { at?: unknown; id?: unknown }
    if (typeof parsed.at !== 'string' || typeof parsed.id !== 'string') return undefined
    return { at: parsed.at, id: parsed.id }
  } catch {
    return undefined
  }
}

/** 把 adapter 的行拼成事件列表。`decisions` 按 trigger id 建索引，一次请求只建一次。 */
export function toSourceEvents(
  rows: readonly RawTrigger[],
  dispositions: ReadonlyMap<string, RawDisposition>,
  decisions: ReadonlyMap<string, readonly RawDecision[]>,
): readonly SourceEvent[] {
  return rows.map(row => {
    const disposition = dispositions.get(row.id)
    const fate = fateOf(disposition, decisionFor(decisions.get(row.id) ?? [], disposition))
    return {
      triggerId: row.id,
      ...(row.at ? { at: row.at } : {}),
      ...(row.text ? { text: previewOf(row.text) } : {}),
      ...(typeof row.text === 'string' ? { textLength: row.text.length } : {}),
      ...(row.addressed === undefined ? {} : { addressed: row.addressed }),
      ...(row.human === undefined ? {} : { human: row.human }),
      ...(row.actor?.id ? { actor: String(row.actor.id) } : {}),
      ...(row.threads?.length ? { threads: row.threads.map(thread => thread.id || `${thread.source}:${thread.id}`) } : {}),
      fate,
    }
  })
}

/** 按 trigger id 收集候选决定：一个事件可能出现在多条决定的 `triggerIds` 里（重评估、退回后重排队）。 */
export function decisionsByTrigger(decisions: readonly RawDecision[]): Map<string, RawDecision[]> {
  const out = new Map<string, RawDecision[]>()
  for (const decision of decisions) {
    for (const id of decision.triggerIds ?? []) {
      const list = out.get(id)
      if (list) list.push(decision)
      else out.set(id, [decision])
    }
  }
  return out
}

/**
 * 选「这条去向对应的那条决定」。
 *
 * 上游 `Evals.record`（`core/evals.ts:329-335`）每次评估都把 `disposition.decisionId` 覆盖成最新那条，
 * 旧决定行仍保留同一个 trigger。所以**按指针选**，不能按数组顺序取第一条——那是**最早**的一条，
 * 会把重评估后的结果说反（accept 说成 ignore，或反过来）。
 * 没有指针（旧数据）时退到 `at` 最新的一条；`at` 也缺失就取最后一次出现的那条。
 */
export function decisionFor(
  decisions: readonly RawDecision[],
  disposition: RawDisposition | undefined,
): RawDecision | undefined {
  if (decisions.length === 0) return undefined
  const pointed = disposition?.decisionId
  if (pointed) {
    const hit = decisions.find(decision => decision.id === pointed)
    if (hit) return hit
  }
  return decisions.reduce((latest, decision) =>
    String(decision.at ?? '') >= String(latest.at ?? '') ? decision : latest)
}

/** 事件分页：多取一行判断 `more`，游标取本页最后一条。 */
export function pageOf(events: readonly SourceEvent[], limit: number): SourceEventPage {
  const items = events.slice(0, limit)
  const last = items[items.length - 1]
  // 没有时间戳的行做不了游标。此时不报 `more`：否则界面会显示一个
  // 点了没反应的「加载更早」。也不写空字符串游标，那等于伪造一个坏游标。
  const nextCursor = events.length > limit && last ? encodeCursor(last) : undefined
  return {
    items,
    more: nextCursor !== undefined,
    ...(nextCursor ? { nextCursor } : {}),
  }
}

/** 事件抽屉的组装。没有触发行也要给降级详情，不能 undefined。 */
export function buildSourceEventDetail(input: {
  source: string
  triggerId: string
  trigger?: RawTrigger
  disposition?: RawDisposition
  decisions: readonly RawDecision[]
  threads: readonly { key: string; label?: string; thread?: RawThread }[]
  tickets: readonly RawTicketIndexEntry[]
  /**
   * 策略快照（`kv` 里的 `settings-version:*`）。给了就能按裁定的 `policyVersion`
   * 回查「当时名单里是谁、开了哪些规则」；没给或该版本不可得，就在「没记录的事实」里说明。
   */
  policy?: PolicySnapshot
}): SourceEventDetail | undefined {
  const { trigger, disposition } = input
  if (!trigger && !disposition) return undefined
  const decision = decisionFor(input.decisions, disposition)
  const fate = fateOf(disposition, decision)

  const facts: SourceEventFact[] = []
  const push = (label: string, value: string | undefined, tone?: 'ok' | 'warn' | 'muted'): void => {
    if (value === undefined || value === '') return
    facts.push({ label, value, ...(tone ? { tone } : {}) })
  }

  push('时间', trigger?.at ? timeText(trigger.at) : undefined)
  push('来源', input.source)
  push('事件 id', input.triggerId)
  if (trigger) {
    push('发送者', trigger.actor?.id ? String(trigger.actor.id) : '未记录')
    push('人还是机器', trigger.human === true ? '人' : trigger.human === false ? '自动/机器人' : '未记录')
    push('点名方式', trigger.addressed === undefined || trigger.addressed === null
      ? '没有点名标记（addressed 字段为空）'
      : codeLabel(ADDRESSED_LABEL, trigger.addressed) ?? trigger.addressed)
    push('线程', trigger.threads?.length
      ? trigger.threads.map(thread => thread.id || `${thread.source}:${thread.id}`).join(' · ')
      : '未记录')
    const metaKeys = Object.keys(trigger.meta ?? {})
    push('元数据', metaKeys.length > 0 ? JSON.stringify(trigger.meta) : '空')
    push('原文长度', typeof trigger.text === 'string' ? `${trigger.text.length} 字` : '未记录')
  } else {
    push('原文', '没有触发行：这条事件只有去向记录，原文不可读', 'warn')
  }

  push('去向', FATE_LABEL[fate.kind])
  if (fate.kind === 'filtered') push('原因码', fate.code, 'warn')
  if (fate.kind === 'direct' || fate.kind === 'context' || fate.kind === 'handback') {
    push('送达工单', fate.tickets.join(' · '), 'muted')
  }
  if (fate.kind === 'undecided') push('去向细节', '有去向行，但没有裁定、没有扇出、也没有丢弃原因', 'muted')
  if (fate.kind === 'unrecorded') push('去向细节', '没有去向行', 'warn')
  if (disposition) {
    push('扇出工单', disposition.fanout?.length ? disposition.fanout.join(' · ') : '没有')
    if (disposition.context?.length) push('仅上下文工单', disposition.context.join(' · '), 'muted')
    const handbacks = Array.isArray(disposition.handbacks) ? disposition.handbacks : []
    if (handbacks.length) {
      // 与 `fateOf` 同口径：元素形状不对就不取，别抛给详情路由变成 500。
      push('退回工单', handbacks.flatMap(item => item?.ticketId ? [item.ticketId] : []).join(' · '), 'muted')
    }
    if (disposition.requeued) push('重新入队记录', JSON.stringify(disposition.requeued), 'muted')
  }

  if (decision) {
    // 行值统一「中文（英文码）」：码是库里的事实，中文只是译名，两个都留给人对照。
    push('裁定', decision.kind ? `${codeLabel(OUTCOME_LABEL, decision.kind)}` : '未记录',
      decision.kind === 'ignore' || decision.kind === 'stop' ? 'warn' : 'ok')
    push('决定 id', decision.id)
    push('评估 id', decision.evalId)
    // 版本可能是数字（历史坏形状）：原样显示，但只有字符串才能拿去查快照。
    const rawVersion = decision.policyVersion ?? decision.mandate?.policyVersion
    const version = typeof rawVersion === 'string' && rawVersion ? rawVersion : undefined
    push('策略版本', rawVersion === undefined ? undefined : String(rawVersion))
    // 按版本**精确**回查：取不到就不写这几行，也不拿最新一份顶替——
    // 用现在的配置解释当时的决定，比不解释更坏。
    const snapshot = version ? input.policy?.at(version) : undefined
    if (snapshot) {
      const savedAt = snapshot.savedAt ? timeText(snapshot.savedAt) : undefined
      const revision = typeof snapshot.revision === 'number' ? `修订 ${snapshot.revision}` : undefined
      // 「修订 N」是这份内容**最早**一次保存的修订号；同一内容之后被重复保存不算。
      push('策略快照', [savedAt, revision ? `${revision}（该内容最早一次保存）` : undefined]
        .filter(Boolean).join(' · ') || undefined, 'muted')
      // 形状坏了的行（迁移会把解析失败的原样保留）要说「读不出」，不能说成「名单为空」。
      const allowed = snapshot.sendersOf(input.source)
      if (allowed === undefined) {
        push('当时名单', '该版本的名单字段形状异常，读不出', 'warn')
      } else {
        push('当时名单', allowed.length ? allowed.join(' · ') : '名单为空：没有发送者在准入名单内',
          allowed.length ? 'muted' : 'warn')
      }
      const rules = snapshot.enabledRules()
      if (rules === undefined) {
        push('当时启用规则', '该版本的规则字段形状异常，读不出', 'warn')
      } else {
        const named = rules.filter(Boolean).map(rule => codeLabel(RULE_LABEL, rule) ?? rule)
        push('当时启用规则', named.length ? named.join(' · ') : '没有启用中的规则', 'muted')
      }
      const sender = trigger?.actor?.id ? String(trigger.actor.id) : undefined
      if (sender) {
        if (allowed === undefined) {
          push('名单判定', '名单读不出，无法判断', 'muted')
        } else {
          // 与上游同口径（忽略大小写）：这里判的不是「字面相等」，是「上游会不会放行」。
          const listed = snapshot.allows(input.source, sender)
          push('名单判定', listed ? '在名单内' : '不在名单内', listed ? 'ok' : 'warn')
        }
      }
    }
    push('授权强度', codeLabel(STRENGTH_LABEL, decision.mandate?.strength ?? decision.strength))
    push('授权范围', decision.mandate?.scope)
    push('授权依据', decision.mandate?.basis ? basisText(decision.mandate.basis) : undefined)
    push('主控理由码', (decision.reason ?? []).map(reason => codeLabel(REASON_LABEL, reason.code)).join(' · '))
    // `said` 这类理由把原话放在 `values.text` 里（`service/facts.ts:176-177` 同口径）：
    // 原文照录，不进解释表。
    for (const reason of decision.reason ?? []) {
      const text = reason.values?.['text']
      if (text) push('理由原文', text, 'muted')
    }
    const rules = decision.audit?.rule_assessments ?? []
    if (rules.length > 0) {
      push('规则评估', `${rules.length} 条，命中 ${rules.filter(rule => rule.matched).length} 条`)
    }
  } else if (fate.kind === 'routed') {
    push('裁定', '去向行记了有裁定，但对应决定行不存在', 'warn')
  }

  // —— 解释：只由码翻译，单独成段 ——
  const interpretations: SourceEventInterpretation[] = []
  if (fate.kind === 'filtered') interpretations.push(interpretFilteredCode(fate.code, input.source))
  if (decision?.kind) interpretations.push(interpretDecisionKind(decision.kind))
  // `said` 的原话已经作为「理由原文」进了事实，不再按码翻译（那会把它当成解释）。
  for (const reason of decision?.reason ?? []) {
    if (reason.code !== 'said') interpretations.push(interpretReasonCode(reason.code))
  }

  // —— 没记录的事实：逐条声明，不用推测补全 ——
  const notRecorded: string[] = []
  if (fate.kind === 'filtered') {
    // 这道闸在**来源层**：上游 intake 调 SourceScope 判定「不听」，把码原样落库（`core/intake.ts:27`），
    // 根本没进主控准入。写清层级，别让读者拿准入表去对不上号。
    notRecorded.push('丢弃发生在来源层（来源插件的 scope 判定），没有进入主控准入；'
      + '这里只记了原因码，没有记录当时来源的配置或设置快照，判据的细节无法从库里复原。')
    notRecorded.push('源头丢弃的事件不写线程记录，线程的 lastAt 不因它更新。')
  }
  if (fate.kind === 'unrecorded') {
    notRecorded.push('没有去向记录（可能还在排队，或写入中断）。')
  }
  if (fate.kind === 'routed' && !decision) {
    notRecorded.push('这条去向指向一条不存在的决定行，裁定内容无法复原。')
  }
  // 裁定的「当时配置」能不能复原，必须在这里说清：拿不到就明说拿不到。
  if (decision) {
    const rawVersion = decision.policyVersion ?? decision.mandate?.policyVersion
    const version = typeof rawVersion === 'string' && rawVersion ? rawVersion : undefined
    if (version === undefined) {
      notRecorded.push('这条裁定没有记录可用的策略版本，无法回查当时生效的名单与规则。')
    } else if (!input.policy?.at(version)) {
      // 措辞不写「库里没有」：读失败（`readPolicy` 吞异常）与真的没有在这里分不开，
      // 断言「库里没有」可能是假话。只说我们取不到。
      notRecorded.push(`取不到策略版本 ${version.slice(0, 8)} 的设置快照（可能已被清理，或本次读取失败），`
        + '无法复原当时生效的名单与规则。')
    }
  }
  notRecorded.push('上游在入库前按事件 id 去重（`core/intake.ts:23`：命中已有行就直接返回 duplicate，'
    + '不写任何行、不发 trigger.received）；重复收到的那几次不会留痕，条数是**去重后的事件数**。')

  const relatedTickets = relatedOf(input.triggerId, fate, input.tickets, disposition)

  return {
    source: input.source,
    triggerId: input.triggerId,
    title: `事件 ${input.triggerId}`,
    facts,
    interpretations,
    notRecorded,
    ...(trigger?.text ? { text: { text: previewOf(trigger.text), length: trigger.text.length, id: trigger.id } } : {}),
    relatedTickets,
    threads: input.threads.map(item => ({
      key: item.key,
      ...(item.label ? { label: item.label } : {}),
      subscriptions: item.thread?.subscriptions ?? [],
      context: item.thread?.context ?? [],
      ...(item.thread?.lastAt ? { lastAt: item.thread.lastAt } : {}),
      ...(item.thread?.meta ? { meta: item.thread.meta } : {}),
    })),
  }
}

/** 去向的中文名。列表、抽屉、比例带共用一份，别各写各的。 */
export const FATE_LABEL: Readonly<Record<EventFate['kind'], string>> = {
  filtered: '源头丢弃',
  routed: '经主控裁定',
  direct: '订阅直通',
  context: '仅上下文送达',
  requeued: '重新入队',
  handback: '退回其他工单',
  undecided: '未决（没有裁定记录）',
  unrecorded: '没有去向记录',
}

/** 这条事件牵扯到的工单：裁定/扇出/退回的，加上以它为起点创建的。 */
function relatedOf(
  triggerId: string,
  fate: EventFate,
  tickets: readonly RawTicketIndexEntry[],
  disposition: RawDisposition | undefined,
): SourceEventDetail['relatedTickets'] {
  const ids = new Set<string>()
  if (fate.kind === 'routed' && fate.ticketId) ids.add(fate.ticketId)
  if (fate.kind === 'direct' || fate.kind === 'context' || fate.kind === 'handback') {
    for (const id of fate.tickets) ids.add(id)
  }
  for (const id of disposition?.fanout ?? []) ids.add(id)
  for (const ticket of tickets) {
    if (ticket.originTriggerId === triggerId) ids.add(ticket.id)
  }
  const index = new Map(tickets.map(ticket => [ticket.id, ticket]))
  return [...ids].map(ticketId => ({
    ticketId,
    ...(index.get(ticketId)?.title ? { title: index.get(ticketId)!.title! } : {}),
    // 关联工单可能来自别的来源（跨来源 follow 后，扇出/上下文会把本来源的事件牵到它）：
    // 把来源一起带出来，抽屉才标得出「它不属于当前来源」。
    ...(index.get(ticketId)?.source ? { source: index.get(ticketId)!.source! } : {}),
  }))
}

function previewOf(text: string): string {
  return text.length <= PROSE_PREVIEW_CHARS ? text : text.slice(0, PROSE_PREVIEW_CHARS)
}

/** 时间戳 → 本地可读；缺失或解析失败给一句明确说明，不留空。 */
function timeText(value: string): string {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : value
}

/**
 * 准入依据（`MandateBasis`）→ 人话。原来整段 `JSON.stringify` 直接给人看，键名和码全是英文。
 * 这里逐项译成「中文（code）」；`scope` 是来源记录的自由形状，认不得就原样附在最后，不丢事实。
 */
function basisText(basis: Record<string, unknown>): string {
  const parts: string[] = []
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() ? value.trim() : undefined

  const via = text(basis['via'])
  if (via) parts.push(codeLabel(VIA_LABEL, via) ?? via)
  const addressed = text(basis['addressed'])
  if (addressed === 'direct') parts.push('直接点名（direct）')
  else if (addressed === 'mention') parts.push('提及（mention）')
  const cell = text(basis['cell'])
  if (cell) parts.push(codeLabel(CELL_LABEL, cell) ?? cell)
  const sender = text(basis['sender'])
  if (sender) parts.push(`发送者 ${sender}`)
  const rules = Array.isArray(basis['rules']) ? basis['rules'] : []
  const namedRules = rules.flatMap(rule => typeof rule === 'string' && rule ? [codeLabel(RULE_LABEL, rule) ?? rule] : [])
  if (namedRules.length) parts.push(`命中规则 ${namedRules.join(' · ')}`)
  const observation = basis['observation']
  if (observation && typeof observation === 'object') {
    const mode = text((observation as Record<string, unknown>)['mode'])
    if (mode) parts.push(codeLabel(ACCEPT_MODE_LABEL, mode) ?? mode)
  }
  const authority = text(basis['authority'])
  if (authority) parts.push(`旧版授权记录 ${authority}`)

  const scope = basis['scope']
  if (scope && typeof scope === 'object' && Object.keys(scope as Record<string, unknown>).length > 0) {
    parts.push(`来源范围 ${JSON.stringify(scope)}`)
  }
  // 一个字段都认不出时宁可原样给 JSON，也不显示空值。
  return parts.length ? parts.join(' · ') : JSON.stringify(basis)
}
