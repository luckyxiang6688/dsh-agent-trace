/**
 * 来源页的领域类型：来源 → 事件 → 去向。
 *
 * 这一层的两条硬规则：
 * 1. `received` 是**去重后的事件条数**，不是「收到几次」——上游按事件 id 去重不留痕
 *    （`vendor/dsh-superagent/src/core/intake.ts:23`），界面文案不得写「收到 N 次」。
 * 2. 事实（`facts`）、解释（`interpretations`）、没记录的事实（`notRecorded`）三段分开，
 *    解释由原因码查表得来，绝不能混进事实里冒充记录。
 */
import type { Prose } from './model.ts'

/** 一条事件的去向分类计数。 */
export interface SourceCounts {
  readonly routed: number
  readonly direct: number
  readonly context: number
  readonly filtered: number
  readonly requeued: number
  readonly handback: number
  /** 有去向行，但没有裁定也没有扇出（排队中/评估中/写入中断都可能）。 */
  readonly undecided: number
}

export interface SourceSummary {
  readonly source: string
  /** 注册表给的中文标题；拿不到就退回来源 id。 */
  readonly label?: string
  readonly installed?: boolean
  readonly enabled?: boolean
  /** 去重后的事件条数。 */
  readonly received: number
  /** 以这个来源的事件为起点的工单数。 */
  readonly tickets: number
  readonly lastAt?: string
  readonly counts: SourceCounts
  /** 有事件行但没有去向行的条数。 */
  readonly unrecorded: number
}

/**
 * 一条事件的去向。优先级（写死，单测锁住）：
 * filtered > requeued > handback > routed > context > direct > undecided > unrecorded。
 */
export type EventFate =
  | { readonly kind: 'filtered'; readonly code: string }
  | {
      readonly kind: 'routed'
      readonly decisionId?: string
      readonly evalId?: string
      readonly decisionKind?: string
      /** 裁定接单时创建/关联的工单。 */
      readonly ticketId?: string
    }
  | { readonly kind: 'direct'; readonly tickets: readonly string[] }
  | { readonly kind: 'context'; readonly tickets: readonly string[] }
  | { readonly kind: 'requeued' }
  | { readonly kind: 'handback'; readonly tickets: readonly string[] }
  | { readonly kind: 'undecided' }
  | { readonly kind: 'unrecorded' }

export interface SourceEvent {
  readonly triggerId: string
  readonly at?: string
  /** 原文预览（最多 200 字）；全文走事件详情路由。 */
  readonly text?: string
  readonly textLength?: number
  readonly addressed?: string | null
  readonly human?: boolean
  readonly actor?: string
  readonly threads?: readonly string[]
  readonly fate: EventFate
}

export interface SourceEventPage {
  readonly items: readonly SourceEvent[]
  readonly more: boolean
  readonly nextCursor?: string
}

/** 抽屉里的一个事实行：值只来自库里的字段，`tone` 只影响配色。 */
export interface SourceEventFact {
  readonly label: string
  readonly value: string
  readonly tone?: 'ok' | 'warn' | 'muted'
}

/** 由原因码翻译来的**解释**；界面必须把它和事实分开标。 */
export interface SourceEventInterpretation {
  readonly label: string
  readonly text: string
}

export interface RelatedTicket {
  readonly ticketId: string
  readonly title?: string
  /**
   * 这张工单的起点来源。扇出/上下文订阅可以让**别的来源**的事件牵到本工单，
   * 所以它未必等于当前事件的来源；抽屉据此标出来源，别让人以为它属于当前来源。
   */
  readonly source?: string
}

/** 事件所在线程。订阅关系按当前库里的状态给出，可能晚于事件发生时刻。 */
export interface SourceThreadInfo {
  readonly key: string
  /** `kv['source-labels:<source>']` 给的会话/线程显示名；没有就不写。 */
  readonly label?: string
  readonly subscriptions: readonly string[]
  readonly context: readonly string[]
  readonly lastAt?: string
  readonly meta?: Readonly<Record<string, unknown>>
}

export interface SourceEventDetail {
  readonly source: string
  readonly triggerId: string
  readonly title: string
  readonly facts: readonly SourceEventFact[]
  readonly interpretations: readonly SourceEventInterpretation[]
  /** 「没记录的事实」：数据库没有写下的东西，逐条声明，不用推测补全。 */
  readonly notRecorded: readonly string[]
  /** 原文预览。 */
  readonly text?: Prose
  readonly relatedTickets: readonly RelatedTicket[]
  readonly threads: readonly SourceThreadInfo[]
}
