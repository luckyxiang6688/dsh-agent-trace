/**
 * 一段活动的详情。
 *
 * 数据一律走 `ctx.sessionQuery`——会话日志是多帧 zstd（实测 51 帧），
 * 文件直读只能解出第一帧，等于什么都读不到。
 *
 * 结构对齐原型 actBlock：按「步」分组，每步有组头、想法、收到的、动作。
 */
import {
  PROSE_PREVIEW_CHARS, type ActionDetail, type Chain, type ExecutorInfo, type Prose,
  type ProseRef, type SpanDetail, type StepDetail,
} from '../domain/model.ts'
import { calculateWindow } from '../presenter/window.ts'
import { toolChinese, toolLabel, translateArgs } from '../presenter/translate.ts'
import { formatDuration } from '../presenter/swimlane.ts'
import { firstSentence, proseOf, type TextSink } from './prose.ts'

export interface Translator {
  translate(texts: readonly string[]): Promise<(string | undefined)[]>
  peek?(texts: readonly string[]): (string | undefined)[]
}

/** 一个离散事件（提问/回答/停止/重试/投递失败/工单结束）的抽屉素材。 */
export interface EventFacts {
  readonly title?: string
  readonly note?: string
  readonly outcome?: string
  readonly facts?: readonly {
    label: string
    value: string
    group?: 'gate' | 'action' | 'assessment' | 'decision' | 'meta'
    tone?: 'ok' | 'warn' | 'muted'
    prose?: ProseRef
  }[]
}

export interface FactsProvider {
  /** 自由文本只回预览；传 sink 就顺手把全文记下来，供「展开原文」按 id 回取。 */
  factsFor(ticketId: string, sink?: TextSink): readonly {
    label: string
    value: string
    group?: 'gate' | 'action' | 'assessment' | 'decision' | 'meta'
    tone?: 'ok' | 'warn' | 'muted'
    prose?: ProseRef
  }[]
  routerThoughts?(ticketId: string): Promise<readonly string[]>
  routerReceived?(ticketId: string): readonly string[]
  routerNote?(ticketId: string): string | undefined
  /** 离散事件的抽屉内容，按 span id 分派；取不到就返回 undefined。 */
  eventFacts?(ticketId: string, spanId: string, sink?: TextSink): EventFacts | undefined
  /**
   * 块首行：只回模型/系统自己写的原文，不代写摘要。
   * 取不到就返回 undefined，由调用方退回会话里的原始字段或干脆不显示。
   */
  leadFor?(ticketId: string, spanId: string): { text: string; source: 'model' | 'system' } | undefined
  /**
   * 会话 header 的 `agentPreset`：这是「谁在跑」的唯一字段。
   * 会话读不到就返回 undefined，由调用方写「未记录」，不猜。
   */
  presetOf?(sessionId: string): string | undefined
}

/** 只声明用到的方法。readSession 返回完整事件（含 data）。 */
export interface SessionReader {
  readSession?(sessionId: string): Promise<{ events?: readonly RawEvent[] }>
  listEvents?(sessionId: string): Promise<readonly RawEvent[]>
}

export interface RawEvent {
  seq?: number
  time?: number
  type?: string
  data?: Record<string, unknown>
  [key: string]: unknown
}

const MAX_EVENTS = 400

/** 组装一段活动的抽屉内容。任何一步失败都降级为空，不抛。 */
export async function readSpanDetail(
  query: SessionReader | undefined,
  sessionId: string,
  chain: Chain,
  spanId: string,
  translator?: Translator,
  factsProvider?: FactsProvider,
  /**
   * 全文暂存。传进来就顺手把每段正文的全文写进去，供 `readText` 按 id 回取；
   * 不传则只回预览（路由就是这么用的）。
   */
  collect?: TextSink,
): Promise<SpanDetail | undefined> {
  const span = chain.spans.find(item => item.id === spanId)
  if (!span) return undefined
  const sink: TextSink = collect ?? new Map()

  // 离散事件没有持续区间，读会话窗口没有意义：内容全在领域表里。
  if (span.kind === 'event') {
    const event = factsProvider?.eventFacts?.(chain.ticketId, span.id, sink)
    return {
      spanId: span.id,
      title: event?.title ?? span.label,
      ...(span.badge ? { badge: span.badge } : {}),
      received: [],
      thoughts: [],
      actions: [],
      ...(event?.facts?.length ? { facts: event.facts } : {}),
      ...(event?.note ? { note: event.note } : {}),
      ...(event?.outcome
        ? { outcome: proseOf(event.outcome, `span/${span.id}/outcome`, sink) }
        : {}),
    }
  }

  const base = Date.parse(chain.createdAt)
  const window = calculateWindow(span.startMs, span.endMs, base)
  const identitySessionId = span.source?.sessionId ?? sessionId
  const { events, readable } = await load(query, identitySessionId)
  // 谁在跑：运行方读会话 header，模型读会话事件。用完整事件而不是窗口——
  // `request/header` 往往在 span 时间窗之前，被截断时也要能报出模型。
  const points = span.role === 'router' ? [] : modelPoints(events)
  const agent = span.role === 'router'
    ? undefined
    : executorInfo(points, factsProvider?.presetOf?.(identitySessionId), window.toMs)
  const filtered = events
    .filter(event => typeof event.time === 'number' && event.time >= window.fromMs && event.time <= window.toMs)
  const inWindow = filtered.slice(0, MAX_EVENTS)
  // 超上限时只取窗口开头的部分：尾部（往往是最新的步骤）没有加载，
  // 必须回一个可显示的计数，客户端据此明说，而不是让后面的步骤「看起来没发生」。
  const truncated = inWindow.length < filtered.length
    ? { shown: inWindow.length, total: filtered.length }
    : undefined

  const steps = groupByStep(inWindow, span.id, sink, modelAtOf(points))

  // 子代理：首条用户消息就是父会话交给它的任务；末条模型输出就是它交回的结论
  let subagentReceived: string[] = []
  let subagentOutcome: string | undefined
  let subagentMeta: { label: string; value: string }[] = []
  if (span.role === 'subagent') {
    for (const event of inWindow) {
      const text = event.type === 'user/message' ? extractText(event.data ?? {}) : ''
      if (text) { subagentReceived = [text]; break }
    }
    for (let index = inWindow.length - 1; index >= 0; index -= 1) {
      const event = inWindow[index]!
      if (event.type !== 'assistant/message') continue
      const text = extractText(event.data ?? {})
      // 存全文：`proseOf` 会再截成预览，首行用首句——不能先压到 400 字再存，
      // 否则「展开原文 · N 字」报的是压过的字数，点开也拿不回真正的原文。
      if (text) { subagentOutcome = text; break }
    }
    const first = inWindow.find(event => typeof event.time === 'number')
    const last = [...inWindow].reverse().find(event => typeof event.time === 'number')
    if (first?.time && last?.time) {
      subagentMeta = [{ label: '耗时', value: formatElapsed(last.time - first.time) }]
    }
  }

  // 评估块：想法来自主控会话；收到的来自触发消息
  const receivedText = span.role === 'router'
    ? [...(factsProvider?.routerReceived?.(chain.ticketId) ?? [])]
    : span.role === 'subagent'
      ? subagentReceived
      // 执行器收到的是人的消息（触发与恢复）；只标注「仅上下文」的条目，不混为一谈。
      : (chain.inputs ?? [])
          .filter(input => input.kind === 'trigger' && input.text)
          .map(input => (input.context ? `（仅上下文，不授权）${input.text}` : input.text!))
  const received = receivedText.map((text, index) => proseOf(text, `span/${span.id}/received/${index}`, sink))
  const thoughtTexts: string[] = []
  if (span.role === 'router' && factsProvider?.routerThoughts) {
    thoughtTexts.push(...await factsProvider.routerThoughts(chain.ticketId))
  }
  const thoughts = thoughtTexts.map((text, index) => proseOf(text, `span/${span.id}/thoughts/${index}`, sink))

  // 翻译缓存：顶层想法与每一步的想法一起查。键是 `Prose.id`，值是中文译文。
  // 查缓存要用全文——预览被截断过，拿预览去查会永远 miss。
  const thoughtProses = [...thoughts, ...steps.flatMap(step => step.thoughts)]
  const fullTexts = thoughtProses.map(prose => sink.get(prose.id) ?? prose.text)
  const peeks = translator?.peek?.(fullTexts) ?? []
  const translations: Record<string, string> = {}
  thoughtProses.forEach((prose, index) => {
    const hit = peeks[index]
    if (hit) translations[prose.id] = hit
  })
  const facts = span.role === 'router' ? factsProvider?.factsFor(chain.ticketId, sink) ?? [] : []
  // 从哪来 / 属于谁：先写这块属于哪张工单，再写谁在跑、用的什么模型。
  const ownerFacts = span.role === 'executor'
    ? [{ label: '所属', value: `工单 Ticket ${chain.ticketId}`, group: 'meta' as const }]
    : span.role === 'subagent'
      ? [{ label: '所属', value: `工单 Ticket ${chain.ticketId} · 子代理`, group: 'meta' as const }]
      : []
  // 运行方与模型：派工块、子代理块都要。取不到也照样出行，写「未记录」而不是留空。
  const identityFacts = span.role === 'executor' || span.role === 'subagent'
    ? agentFacts(agent, readable)
    : []
  const allFacts = [...facts, ...ownerFacts, ...identityFacts, ...subagentMeta.map(row => ({ ...row, group: 'meta' as const }))]
  const last = steps.length > 0 ? steps[steps.length - 1] : undefined

  // 首行：模型自己写的报告摘要 / 系统落库的任务陈述优先；
  // 都没有才退到它给第一个工具写的「说明」。绝不由我们概括一句。
  const providerLead = factsProvider?.leadFor?.(chain.ticketId, span.id)
  const described = steps
    .flatMap(step => step.actions)
    .flatMap(action => action.fields)
    .find(field => field.label === '说明')?.value
  const leadText = firstSentence(providerLead?.text || subagentOutcome || described || '')

  return {
    spanId: span.id,
    title: span.label,
    ...(span.badge ? { badge: span.badge } : {}),
    ...(leadText ? { lead: leadText, leadSource: providerLead?.source ?? 'model' as const } : {}),
    received,
    thoughts,
    ...(Object.keys(translations).length > 0 ? { translations } : {}),
    // 有分步时不再重复输出最后一步的动作：客户端只渲染 `steps`，重复一份只是白占体积。
    actions: steps.length > 0 ? [] : last?.actions ?? [],
    ...(steps.length > 0 ? { steps } : {}),
    ...(allFacts.length > 0 ? { facts: allFacts } : {}),
    ...(span.role === 'router' && thoughts.length === 0
      ? { note: factsProvider?.routerNote?.(chain.ticketId) ?? '这次没有留下模型思考。' }
      : {}),
    ...(truncated ? { truncated } : {}),
    // 被截断时不报「结果」：手里最后一条想法只是加载窗口的末尾，不是这次活动的收尾。
    ...(truncated
      ? {}
      : span.role === 'subagent'
        ? (subagentOutcome ? { outcome: proseOf(subagentOutcome, `span/${span.id}/outcome`, sink) } : {})
        : last?.thoughts.length
          ? {
              outcome: proseOf(
                sink.get(last.thoughts[last.thoughts.length - 1]!.id) ?? last.thoughts[last.thoughts.length - 1]!.text,
                `span/${span.id}/outcome`,
                sink,
              ),
            }
          : {}),
  }
}

/** 运行方显示名：按会话 header 的 `agentPreset` 查表；未知 preset 原样显示。 */
const RUNTIME_NAMES: Readonly<Record<string, string>> = {
  'dsh-superagent-worker': 'DSH 内置 Worker',
  standard: 'DSH 内置 Agent',
}

/** 模型路由的一个时点。`provider` 是模型 API 路由，不是 agent 产品名。 */
interface ModelPoint {
  readonly atMs: number
  readonly provider?: string
  readonly model: string
  readonly effort?: string
  readonly contextWindow?: number
}

/**
 * 从会话事件里抽模型时间线。
 *
 * 只认实际发生过的事件（不读配置）——配置是「应该用什么」，事件才是「实际用了什么」。
 * 三处冗余：`request/header`（每次请求）、`request/context`（路由变化时）、
 * `assistant/message.message.source`（每条模型消息）；子代理另有 `subagent/descriptor`。
 * `model/selection` 只是「选中」，不代表已经用过，故意不算进来。
 */
function modelPoints(events: readonly RawEvent[]): ModelPoint[] {
  const points: ModelPoint[] = []
  for (const event of events) {
    if (typeof event.time !== 'number') continue
    const data = event.data ?? {}
    let provider: string | undefined
    let model: string | undefined
    let effort: string | undefined
    let contextWindow: number | undefined
    if (event.type === 'request/header') {
      const config = nested(data, 'header', 'config')
      provider = field(config, 'provider')
      model = field(config, 'model')
      effort = field(config, 'reasoningEffort')
    } else if (event.type === 'request/context') {
      provider = field(data, 'provider')
      model = field(data, 'model')
      const window = data['contextWindow']
      if (typeof window === 'number' && Number.isFinite(window)) contextWindow = window
    } else if (event.type === 'assistant/message') {
      const source = nested(data, 'message', 'source')
      provider = field(source, 'provider')
      model = field(source, 'model')
    } else if (event.type === 'subagent/descriptor') {
      // 子代理的一等字段：父会话写下的「这次给它派了哪个模型」。
      provider = field(data, 'agentProvider')
      model = field(data, 'agentModel')
      effort = field(data, 'agentReasoningEffort')
    }
    if (!model) continue
    points.push({
      atMs: event.time,
      model,
      ...(provider ? { provider } : {}),
      ...(effort ? { effort } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
    })
  }
  return points.sort((left, right) => left.atMs - right.atMs)
}

function nested(
  data: Record<string, unknown>,
  outer: string,
  inner: string,
): Record<string, unknown> | undefined {
  const value = data[outer]
  if (!value || typeof value !== 'object') return undefined
  const child = (value as Record<string, unknown>)[inner]
  return child && typeof child === 'object' ? child as Record<string, unknown> : undefined
}

function field(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

const modelKey = (point: { provider?: string; model: string }): string => `${point.provider ?? ''}\u0000${point.model}`

/**
 * 汇总成「谁在跑」：运行方来自 header，模型取**这个活动块时间窗内**最后一个时点。
 *
 * 窗口之后（同会话更晚的轮次/派工）换的模型不能算到本块头上；provider / effort /
 * 上下文窗口只在**同一个模型段**里回溯，不跨模型借值，否则会把 A 的路由安到 B 头上。
 */
function executorInfo(
  points: readonly ModelPoint[],
  preset: string | undefined,
  toMs: number | undefined,
): ExecutorInfo | undefined {
  const runtime = preset ? RUNTIME_NAMES[preset] ?? preset : undefined
  const scoped = typeof toMs === 'number' ? points.filter(point => point.atMs <= toMs) : [...points]
  // 窗口之前才有模型证据时，用会话第一个模型当基线（与 modelAtOf 同一口径），不退回空。
  if (scoped.length === 0 && points.length > 0) scoped.push(points[0]!)
  const last = scoped[scoped.length - 1]
  if (!runtime && !last) return undefined
  /** 只在这个模型段内回溯；缺失就如实不给，不借上一个模型的值。 */
  const inSegment = <T>(pick: (point: ModelPoint) => T | undefined): T | undefined => {
    if (!last) return undefined
    const key = modelKey(last)
    for (let index = scoped.length - 1; index >= 0; index -= 1) {
      const point = scoped[index]!
      if (modelKey(point) !== key) break
      const value = pick(point)
      if (value !== undefined) return value
    }
    return undefined
  }
  const segments = scoped.filter((point, index) => index === 0 || modelKey(point) !== modelKey(scoped[index - 1]!))
  const provider = inSegment(point => point.provider)
  const effort = inSegment(point => point.effort)
  const contextWindow = inSegment(point => point.contextWindow)
  return {
    ...(runtime ? { runtime } : {}),
    ...(preset && runtime !== preset ? { preset } : {}),
    ...(provider ? { provider } : {}),
    ...(last ? { model: last.model } : {}),
    ...(effort ? { effort } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(segments.length > 1 ? { switches: segments.length } : {}),
  }
}

/** 某时刻生效的模型；窗口开始前没有任何时点时，用会话的第一个模型。 */
function modelAtOf(points: readonly ModelPoint[]): (atMs: number) => { provider?: string; model: string } | undefined {
  return (atMs: number) => {
    let hit: ModelPoint | undefined
    for (const point of points) {
      if (point.atMs > atMs) break
      hit = point
    }
    const chosen = hit ?? points[0]
    return chosen ? { model: chosen.model, ...(chosen.provider ? { provider: chosen.provider } : {}) } : undefined
  }
}

const groupDigits = (value: number): string => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')

/**
 * 抽屉「概要」段的三行。取不到也给一行明确说明：不显示空壳，也不把「没发起过请求」
 * 和「会话读不到」混为一谈。
 */
function agentFacts(
  agent: ExecutorInfo | undefined,
  readable: boolean,
): { label: string; value: string; group: 'meta'; tone: 'muted' }[] {
  const runtime = agent?.runtime
    ? `${agent.runtime}${agent.preset ? `（${agent.preset}）` : ''}`
    : '未记录'
  const route = agent?.model
    ? `${agent.provider ? `${agent.provider} · ` : ''}${agent.model}`
      + `${agent.switches && agent.switches > 1 ? `（这段活动里换过 ${agent.switches - 1} 次）` : ''}`
    : readable
      ? '未记录（这个会话还没有发起过模型请求）'
      : '会话不可读（可能已归档）'
  const effort = [
    agent?.effort,
    agent?.contextWindow !== undefined ? `上下文 ${groupDigits(agent.contextWindow)}` : undefined,
  ].filter((part): part is string => Boolean(part)).join(' · ') || '未记录'
  return [
    { label: '运行方', value: runtime, group: 'meta', tone: 'muted' },
    { label: '模型路由', value: route, group: 'meta', tone: 'muted' },
    { label: '推理强度', value: effort, group: 'meta', tone: 'muted' },
  ]
}

/** 读取完整事件：优先 readSession（含 data），退化到 listEvents。 */
interface LoadedEvents {
  readonly events: readonly RawEvent[]
  /** 读到了会话（哪怕是空会话）为 true；读不到 / 报错为 false。「空」与「不可读」不能混。 */
  readonly readable: boolean
}

async function load(query: SessionReader | undefined, sessionId: string): Promise<LoadedEvents> {
  if (!query) return { events: [], readable: false }
  try {
    if (typeof query.readSession === 'function') {
      const snapshot = await query.readSession(sessionId)
      if (snapshot?.events?.length) return { events: snapshot.events, readable: true }
      if (snapshot) {
        // 会话读到了，只是还没有事件：可读。
        if (typeof query.listEvents === 'function') {
          try {
            const events = await query.listEvents(sessionId)
            if (events.length) return { events, readable: true }
          } catch {
            /* 退回「可读但空」 */
          }
        }
        return { events: [], readable: true }
      }
    }
    if (typeof query.listEvents === 'function') {
      return { events: await query.listEvents(sessionId), readable: true }
    }
  } catch {
    /* 会话可能已归档 */
  }
  return { events: [], readable: false }
}

/** 分组时的可变动作状态；结果在遍历结束后统一收成 `ActionResult`。 */
interface ActionState {
  tool: string
  /** 工具名的中文说明；没收录的工具为 undefined。 */
  note?: string
  /** 上游原始工具名（与展示名不同时才存，例如带命名空间）。 */
  raw?: string
  fields: { label: string; value: string; kind: string; prose?: ProseRef }[]
  failed?: boolean
  /** 调用时刻：用来算耗时。调用 id 只用于建索引，不留在动作上。 */
  callTime?: number
  /** 结果累积。 */
  results: number
  chars: number
  reason: string[]
  errorBody: string
  lastResultTime?: number
}

/**
 * 按 step 分组：tool/call 的 data.step 是组号；
 * 组内的想法取「该步之前最近的一条模型输出」；
 * 工具返回（tool/result）挂回它对应那次调用，错误标红。
 *
 * 正文只回预览，全文写进 `sink`，id 形如
 * `span/<spanId>/steps/<step>/thoughts/<i>`、`.../results/<actionIndex>`。
 */
function groupByStep(
  events: readonly RawEvent[],
  spanId: string,
  sink: TextSink,
  modelAt?: (atMs: number) => { provider?: string; model: string } | undefined,
): StepDetail[] {
  // `data.step` 按轮重置：turn 1 的 step 1 与 turn 2 的 step 1 是两件事，键必须带 turn。
  const steps = new Map<string, { step: number; turn?: number; thoughts: Prose[]; actions: ActionState[] }>()
  /** 换过模型的那一步：记下来，组头才能标「模型改为 X」。 */
  const stepModels = new Map<string, { provider?: string; model: string }>()
  let previousModel: string | undefined
  /** 调用 id → 动作：并行调用时按 id 配对，不靠先后顺序猜。 */
  const byKey = new Map<string, ActionState>()
  /** 还没等到返回的调用，按出现顺序排队；老日志没有 id，只能先进先出地配。 */
  const pending: ActionState[] = []
  let pendingThought = ''
  let stepIndex = 0
  let last: ActionState | undefined

  for (const event of events) {
    const data = unwrap(event.data)
    if (event.type === 'assistant/message') {
      const text = extractText(data)
      if (text) pendingThought = text
      continue
    }
    if (event.type === 'tool/result') {
      const action = matchAction(byKey, pending, last, data)
      if (!action) continue
      // 正常返回的正文只用来数体量；不进响应、不写缓存。失败正文留给「展开原文」。
      const text = extractText(data)
      const info = errorInfo(data)
      if (info.failed) action.failed = true
      action.results += 1
      action.chars += text.length
      for (const reason of info.reasons) {
        if (!action.reason.includes(reason)) action.reason.push(reason)
      }
      if (info.failed && text) action.errorBody = action.errorBody ? `${action.errorBody}\n${text}` : text
      if (typeof event.time === 'number') action.lastResultTime = event.time
      continue
    }
    if (event.type !== 'tool/call') continue

    const step = typeof data['step'] === 'number' ? Number(data['step']) : stepIndex
    stepIndex = step
    const turn = typeof data['turn'] === 'number' ? Number(data['turn']) : undefined
    const stepKey = turn === undefined ? String(step) : `${turn}.${step}`
    const name = typeof data['name'] === 'string' ? String(data['name']) : 'tool'
    let entry = steps.get(stepKey)
    if (!entry) {
      entry = { step, ...(turn !== undefined ? { turn } : {}), thoughts: [], actions: [] }
      // 第一步只建立基线；之后哪一步的模型与上一步不同，就在那一步的组头标出来。
      const model = typeof event.time === 'number' ? modelAt?.(event.time) : undefined
      if (model) {
        const key = modelKey(model)
        if (previousModel !== undefined && key !== previousModel) stepModels.set(stepKey, model)
        previousModel = key
      }
    }
    if (pendingThought && entry.thoughts.length === 0) {
      entry.thoughts.push(
        proseOf(pendingThought, `span/${spanId}/steps/${stepKey}/thoughts/${entry.thoughts.length}`, sink))
      pendingThought = ''
    }
    const keys = idKeys(data)
    const note = toolChinese(name)
    const action: ActionState = {
      tool: toolLabel(name),
      ...(note ? { note } : {}),
      ...(name !== toolLabel(name) ? { raw: name } : {}),
      fields: [...translateArgs(parseArgs(data['arguments'] ?? data['args']))],
      results: 0,
      chars: 0,
      reason: [],
      errorBody: '',
      ...(typeof event.time === 'number' ? { callTime: event.time } : {}),
    }
    for (const key of keys) byKey.set(key, action)
    entry.actions.push(action)
    pending.push(action)
    last = action
    steps.set(stepKey, entry)
  }

  // 按（轮, 步）排序；没有 turn 的老日志退化成按步号，与以前一致。
  return [...steps.entries()]
    .sort((left, right) => (left[1].turn ?? 0) - (right[1].turn ?? 0) || left[1].step - right[1].step)
    .map(([stepKey, entry]) => ({
      step: entry.step,
      ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
      tools: [...new Set(entry.actions.map(action => action.note ?? action.tool))],
      thoughts: entry.thoughts,
      received: [],
      actions: entry.actions.map((action, index) => finalizeAction(action, spanId, stepKey, index, sink)),
      ...(stepModels.has(stepKey) ? { model: stepModels.get(stepKey)! } : {}),
    }))
}

/** 调用与返回共用的 id：`callId` / `toolCallId`，返回侧还可能挂在 message 上。 */
function idKeys(data: Record<string, unknown>): string[] {
  const keys: unknown[] = [data['callId'], data['toolCallId']]
  const message = data['message']
  if (message && typeof message === 'object') {
    keys.push((message as Record<string, unknown>)['toolCallId'], (message as Record<string, unknown>)['callId'])
  }
  return keys.filter((key): key is string => typeof key === 'string' && key.length > 0)
}

/**
 * 先按 id 配对；老日志没有 id 时按调用顺序配最早的未配对调用，都配完了才挂回最近一次。
 *
 * 带了 id 却对不上，说明它属于时间窗外的另一次调用——宁可丢，也不能挂到别人头上。
 */
function matchAction(
  byKey: ReadonlyMap<string, ActionState>,
  pending: ActionState[],
  last: ActionState | undefined,
  data: Record<string, unknown>,
): ActionState | undefined {
  const keys = idKeys(data)
  if (keys.length > 0) {
    for (const key of keys) {
      const hit = byKey.get(key)
      if (!hit) continue
      const index = pending.indexOf(hit)
      if (index >= 0) pending.splice(index, 1)
      return hit
    }
    return undefined
  }
  return pending.shift() ?? last
}

/** 把累积的结果收成一行摘要；成功正文不落缓存，失败正文按 id 可展开。 */
function finalizeAction(
  action: ActionState,
  spanId: string,
  stepKey: string,
  index: number,
  sink: TextSink,
): ActionDetail {
  const failed = action.failed === true
  // 没有匹配到任何返回：不编结果行——可能只是被时间窗截断，不是「没有返回」。
  if (action.results === 0) {
    return {
      tool: action.tool,
      ...(action.note ? { toolNote: action.note } : {}),
      ...(action.raw ? { toolRaw: action.raw } : {}),
      fields: action.fields,
      ...(failed ? { failed: true } : {}),
    }
  }
  const elapsed = action.callTime !== undefined && action.lastResultTime !== undefined
    ? formatElapsed(action.lastResultTime - action.callTime)
    : ''
  const reasonFull = action.reason.join(' · ') || firstLine(action.errorBody)
  const parts: string[] = [failed ? '失败' : '成功']
  if (elapsed) parts.push(elapsed)
  if (action.results > 1) parts.push(`${action.results} 条`)
  if (failed) {
    const reason = clipText(reasonFull, 80)
    parts.push(reason || '未记录原因')
    if (!reason && action.chars > 0) parts.push(`${action.chars} 字`)
  } else if (action.chars === 0) {
    parts.push('无返回')
  } else if (action.chars >= PROSE_PREVIEW_CHARS) {
    parts.push(`${action.chars} 字`)
  }
  // 只有失败才留原文，且要超过预览长度才值得展开：错误原因/堆栈要能查到，正常返回不占缓存。
  // 原因本身也拼进正文——否则展开后摘要里的原因会消失；正文为空时（真实 schema 常见：
  // 只有 `error.reason`、`content: []`）就单独留原因，否则长原因被 80 字截断后再也取不回来。
  const body = !failed
    ? ''
    : action.errorBody
      ? (reasonFull && firstLine(action.errorBody) !== reasonFull
          ? `${reasonFull}\n\n${action.errorBody}`
          : action.errorBody)
      : reasonFull
  const id = `span/${spanId}/steps/${stepKey}/results/${index}`
  const expandable = body.length > PROSE_PREVIEW_CHARS
  if (expandable) sink.set(id, body)
  return {
    tool: action.tool,
    ...(action.note ? { toolNote: action.note } : {}),
    ...(action.raw ? { toolRaw: action.raw } : {}),
    fields: action.fields,
    ...(failed ? { failed: true } : {}),
    result: {
      status: failed ? 'error' : 'ok',
      summary: parts.join(' · '),
      ...(expandable ? { detail: { length: body.length, id } } : {}),
    },
  }
}

/** 这次返回是不是错误，以及可读的原因（真实 schema 的 error 是对象）。 */
function errorInfo(data: Record<string, unknown>): { failed: boolean; reasons: string[] } {
  const reasons: string[] = []
  let failed = false
  // 顶层的 isError 不在上游 schema 里，但旧实现认它；保留兜底，免得日志一换形态就漏判。
  if (data['isError'] === true) failed = true
  const error = data['error']
  if (typeof error === 'string') {
    const text = error.trim()
    if (text) {
      failed = true
      reasons.push(text)
    }
  } else if (error && typeof error === 'object') {
    // 之前只认非空对象，`error: {}` / `error: []` 会被当成成功；只要 error 存在就算失败。
    const obj = error as Record<string, unknown>
    failed = true
    // 人话优先：reason 比 code 好读；`name` 通常只是 "ToolError"，没别的信息时才兜底。
    for (const key of ['reason', 'message', 'code']) {
      const value = obj[key]
      if (typeof value === 'string' && value.trim()) reasons.push(value.trim())
    }
    if (reasons.length === 0 && typeof obj['name'] === 'string' && obj['name'].trim()) {
      reasons.push(obj['name'].trim())
    }
  }
  const message = data['message']
  const messageObj = message && typeof message === 'object' ? message as Record<string, unknown> : undefined
  if (messageObj?.['isError'] === true) failed = true
  const content = messageObj?.['content'] ?? data['content']
  if (Array.isArray(content) && content.some(part => part && typeof part === 'object'
    && (part as { isError?: unknown }).isError === true)) failed = true
  return { failed, reasons }
}

/** 单行化并截断：摘要里不出现换行和成片的空白。 */
function clipText(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(Boolean) ?? ''
}

/** 2026-11-08 起统一耗时口径：<100ms 标 <0.1s，<60s 一位小数，再长走分钟/小时。 */
function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return ''
  if (ms < 100) return '<0.1s'
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return formatDuration(ms)
}

function unwrap(data: Record<string, unknown> | undefined): Record<string, unknown> {
  if (!data) return {}
  return data
}

function parseArgs(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try { return JSON.parse(raw) } catch { return raw }
}

function extractText(data: Record<string, unknown>): string {
  const direct = data['text']
  if (typeof direct === 'string') return direct
  const message = data['message']
  if (message && typeof message === 'object') return extractText(message as Record<string, unknown>)
  const content = data['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? String((part as { text: string }).text)
        : ''))
      .join('')
  }
  return ''
}
