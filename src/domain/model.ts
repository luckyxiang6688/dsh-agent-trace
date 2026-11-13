/**
 * 本项目的领域模型。零外部依赖：不 import DSH，不 import 上游。
 * adapter 负责把上游形状翻译成这里的类型；presenter 只认这里。
 */
import type { SourceEventDetail, SourceEventPage, SourceSummary } from './source.ts'

/** 链路上的角色。列的顺序与配色由 presenter 决定，模型层不关心。 */
export type Role = 'source' | 'router' | 'executor' | 'subagent'

/** 一条链路：一张工单从第一个事件到最后一个回复的完整经过。 */
export interface Chain {
  readonly ticketId: string
  readonly title: string
  /** 这条链路从哪个来源进来（展示用名称）。 */
  readonly source?: string
  /** 阶段的中文名，如「等待人回答」；由 `stageTag` 翻译而来。 */
  readonly stage: string
  /** 阶段的稳定键，如 `person/answer`、`working/queued`；配色与状态带按它分支。 */
  readonly stageTag?: string
  readonly createdAt: string
  readonly endedAt?: string
  readonly spans: readonly Span[]
  /** 这张工单在创建时由哪些事件共同触发（batch 会有多条）。 */
  readonly origins?: readonly ChainOrigin[]
  /** 到达这张工单的输入（人的消息、恢复、策略变更等），按上游顺序。 */
  readonly inputs?: readonly ChainInput[]
  /** 等人回答的问题；有值说明工单停在 answer 态。 */
  readonly attention?: ChainAttention
  /** 已经被回答、等主控发出的话。 */
  readonly answers?: readonly string[]
  /** 最近一次投递失败（输入没能送进执行器会话）。 */
  readonly delivery?: { readonly at?: string; readonly error?: string }
  /** 跟随的线程（如自己的 PR），关闭后可能据此收尾。 */
  readonly follows?: readonly ChainFollow[]
  /** 执行器列的状态背景带：工单在一段时间里处于什么状态。 */
  readonly stateBands?: readonly ChainStateBand[]
  /**
   * 来源是否提供回复通道（`ticket.channels` 非空）。
   * false 时视图不画「确认收到/回复」箭头——画了就是画一件这个来源做不到的事。
   */
  readonly canReply?: boolean
  /** 关键时点的绝对毫秒，来自会话日志里的工具调用；取不到就没有。 */
  readonly marks?: {
    readonly ackMs?: number
    readonly replyMs?: number
    /** 每条 `orchestrator_reply` 的时刻，按调用顺序；多派工时一条派工对一条。 */
    readonly replies?: readonly number[]
  }
}

/** 一条触发事件：画一支事件箭头，batch 不合并。 */
export interface ChainOrigin {
  readonly triggerId: string
  readonly at?: string
}

/** 到达工单的一条输入；kind 见上游 TicketInput。 */
export interface ChainInput {
  readonly kind: string
  readonly text?: string
  readonly at?: string
  readonly human?: boolean
  /** 只作为上下文送达，不授权。 */
  readonly context?: boolean
  readonly triggerId?: string
}

export interface ChainAttention {
  readonly question?: string
  readonly triggerId?: string
}

export interface ChainFollow {
  readonly thread: string
  readonly own: boolean
  readonly closed?: { readonly at: string; readonly outcome: string }
}

/** 状态带：执行器列在一段时间里的工单状态，相对创建时刻的毫秒。 */
export interface ChainStateBand {
  readonly id: string
  /** 稳定键：person/review、working/queued、idle、ended 等。 */
  readonly tag: string
  readonly label: string
  readonly startMs: number
  readonly endMs: number
  /** 起点不是落库时刻（如提问时间只能从报告反推），画虚线边。 */
  readonly startsApprox?: boolean
  /** 原因：为什么这段时间是这个态。 */
  readonly reason?: string
}

/** 链路的一段：要么是一次活动（有持续时间），要么是一次事件（瞬时）。 */
export interface Span {
  readonly id: string
  readonly role: Role
  readonly kind: 'activity' | 'event'
  /** 归属这一段的工序号，由 presenter 按时间排序后统一分配。 */
  readonly label: string
  readonly badge?: string
  readonly startMs: number
  readonly endMs: number
  /** 报告六态（progress/waiting/ready/blocked/failed/dropped），仅有报告的派工有。 */
  readonly reportState?: string
  /** 起点不是真实观测值（如评估开始时刻未落库），画虚线边并标注。 */
  readonly startsApprox?: boolean
  /** 上游原始数据的引用（会话 id + 事件 seq 区间），用于按需读取正文。 */
  readonly source?: SpanSource
}

/** 指向正文的指针。正文本身不复制（P3）。 */
export interface SpanSource {
  readonly sessionId: string
  readonly fromSeq?: number
  readonly toSeq?: number
}

/**
 * 事件去向：一条事件只计一次，按终态优先级归类。
 * `context` 是只作为上下文送达工单（不授权、不唤醒模型），与直通分开展示。
 */
export type Path = 'routed' | 'direct' | 'context' | 'filtered'

export interface Disposition {
  readonly path: Path
  /** 结果码，如 accept / ignore / no_mention；filtered 时为上游原因码。 */
  readonly outcome: string
  /** 事件发生时刻，用于按时间排序。 */
  readonly at?: string
  /** 该事件的原文摘要，抽屉里直接可读。 */
  readonly text?: string
  /** 事件 id，供追溯。 */
  readonly triggerId?: string
  /** 发送者 id。 */
  readonly actor?: string
  /** 发送者是不是人。 */
  readonly human?: boolean
  /** 该事件所在线程（`source:id` 或显示名）。 */
  readonly threads?: readonly string[]
  /** 点名方式：direct / mention / 未点名。 */
  readonly addressed?: string | null
}

/** 箭头/知会点这类"连线元素"的详情：只回答谁对谁、为什么、证据在哪。 */
export interface LinkDetail {
  readonly id: string
  readonly title: string
  readonly subtitle?: string
  /** 段落：引用气泡 / 徽章行 / 纯说明。形状与原型一致，不用表格。 */
  readonly sections: readonly {
    readonly title: string
    readonly kind: 'quote' | 'badges' | 'note'
    /** 我们写的说明：线程、点名方式、降级提示等。 */
    readonly text?: string
    /** 上游原文（消息 / 发出去的话 / 报告内容）：只回预览，全文另取。 */
    readonly body?: Prose
    readonly items?: readonly { text: string; tone?: 'ok' | 'warn' | 'muted' }[]
    /** 引用气泡用"发出去"样式（带底色），区分"收到的"与"发出去的" */
    readonly say?: boolean
  }[]
}

/** 数据层对外的统一入口。实现必须保证：拿不到就返回 undefined，不抛。 */
export interface ChainReader {
  /** `source` 给定时只列起点事件来自该来源的工单（来源页的工单区跟着选中来源走）。 */
  listChains(limit: number, source?: string): Promise<readonly ChainSummary[]>
  readChain(ticketId: string): Promise<Chain | undefined>
  readDispositions(ticketId: string): Promise<readonly Disposition[]>
  /** 全量来源列表（含装未用的来源）；按最近活跃排。 */
  listSources(): Promise<readonly SourceSummary[]>
  /** 某来源的事件，从新到旧；`cursor` 来自上一页的 `nextCursor`。 */
  listSourceEvents(source: string, limit: number, cursor?: string): Promise<SourceEventPage>
  readSourceEvent(source: string, triggerId: string): Promise<SourceEventDetail | undefined>
  readSourceEventText(source: string, triggerId: string): Promise<string | undefined>
  /** 一条连线的详情（箭头或知会点）。 */
  readLink(ticketId: string, linkId: string): Promise<LinkDetail | undefined>
  /** 一段活动的详情（抽屉内容）。正文只回预览，不铺原文。 */
  readSpanDetail(ticketId: string, spanId: string): Promise<SpanDetail | undefined>
  /** 按 `Prose.id` 取一段正文的全文；取不到（会话已归档/ id 不认识）返回 undefined。 */
  readText(ticketId: string, textId: string): Promise<string | undefined>
  /** 开发期调试用：返回会话事件的类型直方图与样例。 */
  readSessionSample(ticketId: string): Promise<Record<string, unknown>>
}

/** 抽屉里正文的预览长度上限：超过就只回这么多字，全文按 id 另取。 */
export const PROSE_PREVIEW_CHARS = 200

/**
 * 事件结果码 → 中文。上游给的是码（accept / no_mention…），
 * 界面上只能出现这一个译名表，服务端抽屉与客户端图例共用。
 */
export const OUTCOME_LABEL: Readonly<Record<string, string>> = {
  accept: '接单',
  ignore: '拒绝',
  stop: '停止',
  unavailable: '不可用',
  observed: '已观察',
  delivered: '送达',
  explicitRouted: '直路由',
  admission_ignored: '准入忽略',
  no_mention: '未点名',
  not_human: '非人类',
  not_a_member: '不在名单',
  duplicate: '重复',
}

/**
 * 授权强度：上游 `Strength`（`core/model.ts:96`）。
 * 码是库里的事实，中文是译名；界面统一写成「中文（code）」。
 */
export const STRENGTH_LABEL: Readonly<Record<string, string>> = {
  explicit: '明确',
  inferred: '推断',
}

/**
 * 主控理由码：上游 `core/reasons.ts` 的 `REASONS`。**只翻译上游定义的码**；
 * 来源可以自定义字面码，表里没有的原样显示，不编含义。
 */
export const REASON_LABEL: Readonly<Record<string, string>> = {
  said: '原话',
  timeout: '评估超时',
  policyChanged: '评估期间策略变更',
  noAdmissible: '没有可准入的事件',
  startedTicket: '该线程已有工单',
  acceptedBefore: '该事件此前已接单',
  routed: '已路由到工单',
  explicitRouted: '明确点名直路由',
  humanStop: '人工要求停止',
  legacyImport: '从旧版任务记录导入',
  forwarded: '转给该线程已有工单的执行器',
  senderNotMember: '发送者不在名单内',
  retried: '人工重试',
  hostRestarted: 'dsh-superagent 重启',
  stopUnknown: '停止目标未知或已结束',
  stopNotExplicit: '停止需要名单内发送者明确要求',
  directionUnsettled: '实现方向未定',
  noRuleMatched: '没有命中启用中的规则',
  ignoredFromCard: '从卡片上忽略，未经规则评估',
  observed: '观察模式：本应接单',
  // 准入闸的码（`policy.ts` 直接返回，不在 `REASONS` 表里，但会原样写进决定行）：
  // 上游自己的界面有同名译名（`client/locales.ts` 的 `reason.*`），这里对齐它。
  no_mention: '未点名',
  not_a_member: '发送者不在名单内',
  admission_ignored: '准入设为忽略',
  not_human: '自动消息',
}

/**
 * 内置规则的 id：上游 `policy.ts` 的 `DEFAULT_RULES`（copy / visual）。
 * 规则 id 是设置里可自定义的，表里没有的原样显示。
 */
export const RULE_LABEL: Readonly<Record<string, string>> = {
  copy: '文案修正',
  visual: '视觉修正',
}

/** 准入依据里的「哪条路」。 */
export const VIA_LABEL: Readonly<Record<string, string>> = {
  addressed: '点名且名单内',
  followup: '该线程已有工单的后续消息',
  admission: '准入表放行',
  listed: '名单放行，旧记录',
  bot: '机器人消息（至多推断）',
}

/** 准入表命中格。 */
export const CELL_LABEL: Readonly<Record<string, string>> = {
  listedUnaddressed: '名单内未点名',
  unlistedAddressed: '名单外已点名',
  unlistedUnaddressed: '名单外未点名',
}

/** 观察模式（AcceptMode）。 */
export const ACCEPT_MODE_LABEL: Readonly<Record<string, string>> = {
  off: '关闭',
  observe: '观察',
  auto: '自动',
  would_accept: '观察模式，旧记录',
}

/** 点名方式：上游 `Trigger.addressed`。 */
export const ADDRESSED_LABEL: Readonly<Record<string, string>> = {
  direct: '直接点名',
  mention: '提及',
}

/** 工单结束去向：上游 `TicketOutcome`（`core/model.ts:273`）。 */
export const TICKET_OUTCOME_LABEL: Readonly<Record<string, string>> = {
  completed: '完成',
  merged: '已合并',
  closed: '已关闭',
  dropped: '已丢弃',
  stopped: '已停止',
}

/** 工单由谁结束：上游 `TicketEndBy`（`core/model.ts:271`）。 */
export const TICKET_END_BY_LABEL: Readonly<Record<string, string>> = {
  executor: '执行器',
  human: '人工',
}

/**
 * 统一格式：`中文（code）`。表里没有的码原样返回——不认识就不编中文，
 * 尤其原因码允许来源自定义。
 */
export function codeLabel(table: Readonly<Record<string, string>>, code: string | undefined): string | undefined {
  if (!code) return undefined
  const label = table[code]
  return label ? `${label}（${code}）` : code
}

/**
 * 一段正文：预览 + 总字数 + 稳定 id。
 * `text` 永远不是完整原文（除非本来就短），要看全文走 `readText(id)`。
 */
export interface Prose {
  readonly text: string
  readonly length: number
  readonly id: string
}

/**
 * 字段正文的「取全文凭据」。字段的 `value` 已经是预览，
 * 这里不再重复一份预览文本，只带总字数与 id。
 */
export interface ProseRef {
  readonly length: number
  readonly id: string
}

/** 一次工具调用的参数字段（已按字段名翻成人话）。 */
export interface ActionField {
  readonly label: string
  readonly value: string
  readonly kind: string
  /** 长正文：`value` 就是预览，这里只带总字数与取全文的 id。 */
  readonly prose?: ProseRef
}

/**
 * 一次工具调用的结果摘要。
 *
 * 正常返回的正文**不进抽屉、也不写缓存**；`summary` 只说成功/失败、耗时、体量、错误原因。
 * 只有失败才有 `detail`——它指向完整的错误正文，点「展开原文」再取。
 */
export interface ActionResult {
  readonly status: 'ok' | 'error'
  readonly summary: string
  readonly detail?: ProseRef
}

/** 一个动作：工具名 + 参数 + 结果。 */
export interface ActionDetail {
  readonly tool: string
  /** 工具名的中文说明（只收行为已核对过的工具）；没有就只显示原名。 */
  readonly toolNote?: string
  /** 上游原始工具名（带命名空间/下划线）：给「对日志」用，`tool` 是去前缀的展示名。 */
  readonly toolRaw?: string
  readonly fields: readonly ActionField[]
  /** 这次工具调用返回了错误（`tool/result` 带 error 或 isError）。 */
  readonly failed?: boolean
  /** 没有匹配到 `tool/result` 就没有这一项，绝不写成「成功 · 无返回」。 */
  readonly result?: ActionResult
}

/**
 * 谁在跑这段活动。
 *
 * `runtime` 只来自会话 header 的 `agentPreset`（运行方），`provider`/`model` 来自会话事件
 * （实际用的模型路由）。上游没有「agent 产品」字段：`openai-codex` 这类 provider 是模型 API
 * 路由，不代表 Codex CLI 在处理工单——不要据此写「Claude Code / Codex」。
 */
export interface ExecutorInfo {
  /** 运行方显示名（按 preset 查表）；未知 preset 原样显示。 */
  readonly runtime?: string
  /** 上游原始 preset，仅当与显示名不同时给（给「对日志」用）。 */
  readonly preset?: string
  /** 模型 API 路由，如 deepseek-account / anthropic。 */
  readonly provider?: string
  /** 模型 id，如 deepseek-flash。 */
  readonly model?: string
  /** 推理强度，如 high。 */
  readonly effort?: string
  /** 上下文窗口（token），来自 request/context。 */
  readonly contextWindow?: number
  /** 这段活动（时间窗内）的模型段数（>1 说明中途换过）。 */
  readonly switches?: number
}

/** 一步：组头 + 想法 + 收到的 + 动作，与原型 actBlock 同构。 */
export interface StepDetail {
  readonly step: number
  /**
   * 第几轮：上游 `tool/call.data.step` 按轮重置（turn 1 的 step 1 与 turn 2 的 step 1 是两回事），
   * 同一份会话里同一 step 号会出现多次，靠 turn 区分。老日志没有 turn 时不给。
   */
  readonly turn?: number
  /** 组头工具名，如 bash / write */
  readonly tools: readonly string[]
  readonly thoughts: readonly Prose[]
  readonly received: readonly Prose[]
  readonly actions: readonly ActionDetail[]
  /**
   * 这一步换了模型才给（与上一步不同）；没变化就没有，避免每步重复一遍。
   * 数据只认会话事件，不读配置——配置是「应该用什么」。
   */
  readonly model?: { readonly provider?: string; readonly model: string }
}

/** 抽屉内容：按固定顺序组织的四段。 */
export interface SpanDetail {
  readonly spanId: string
  readonly title: string
  readonly badge?: string
  /**
   * 抽屉第一行：只取模型或系统自己写的原文（报告摘要 / 任务陈述），不由我们改写。
   * 取不到就没有；绝不为了「好看」编一句。
   */
  readonly lead?: string
  /** 首行的出处：model=模型自己写的，system=系统落库字段。 */
  readonly leadSource?: 'model' | 'system'
  /** 它收到的：任务卡、知会、报告。只回预览。 */
  readonly received: readonly Prose[]
  /** 它的想法：只回预览；已翻过的译文在 `translations` 里按 id 取。 */
  readonly thoughts: readonly Prose[]
  /** 已缓存的译文，键是 `Prose.id`；有值说明之前翻过，抽屉可直接显示中文。 */
  readonly translations?: Readonly<Record<string, string>>
  /** 它的动作：工具调用，参数已按字段名翻译。 */
  readonly actions: readonly ActionDetail[]
  /** 结果：最后一条回复或工具收尾（预览）。 */
  readonly outcome?: Prose
  /** 没有内容时的说明，避免空白段。 */
  readonly note?: string
  /** 按步分组的执行过程（派工块与子代理块共用）。 */
  readonly steps?: readonly StepDetail[]
  /**
   * 会话事件超过读取上限时只加载了开头这批：`shown` 已加载条数、`total` 窗口内总数。
   * 有这一项就说明「后面的步骤没加载」，客户端必须明说，不能显得它们没发生。
   */
  readonly truncated?: { readonly shown: number; readonly total: number }
  /** 结构化事实：评估块的准入/研判/决定就走这里。 */
  readonly facts?: readonly {
    label: string
    value: string
    group?: 'gate' | 'action' | 'assessment' | 'decision' | 'meta'
    /** 配色由字段值直接给出，客户端不再靠自然语言正则猜。 */
    tone?: 'ok' | 'warn' | 'muted'
    /** 自由文本（授权范围、研判理由、证据、问题正文…）：`value` 是预览，这里给全文的 id。 */
    prose?: ProseRef
  }[]
}

export interface ChainSummary {
  readonly ticketId: string
  readonly title: string
  readonly state: string
  readonly createdAt: string
  readonly endedAt?: string
  readonly stepCount: number
  /** 起点事件的来源；旧数据没有起点事件时缺省。 */
  readonly source?: string
  /** 链路摘要：谁 → 谁 → 谁，各段耗时。左栏直接显示。 */
  readonly summary?: string
}
