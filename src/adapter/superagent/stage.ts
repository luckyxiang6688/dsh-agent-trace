/**
 * 工单阶段的派生规则。
 *
 * 上游不存 stage，而是按固定顺序现算（`src/core/stage.ts:9-21`，docs/003 的表，先行命中者为准）。
 * 插件要画状态带就必须复刻同一顺序，不能另发明一套判据。
 */
import type { RawAssignment, RawTicket } from './db.ts'

/** 阶段：等人（细分动作）、执行中（可能在排队）、空闲、已结束。 */
export type TicketStage =
  | { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' }
  | { stage: 'idle' }
  | { stage: 'ended' }

/** 阶段标签：`person/answer`、`working/queued` 这类稳定键，用于配色与抽屉。 */
export function stageTag(stage: TicketStage): string {
  if (stage.stage === 'person') return `person/${stage.action}`
  if (stage.stage === 'working' && stage.action) return `working/${stage.action}`
  return stage.stage
}

const STAGE_LABEL: Readonly<Record<string, string>> = {
  'person/delivery': '等待投递后的人',
  'person/answer': '等待人回答',
  'person/review': '等待人验收',
  'person/blocked': '受阻',
  'person/failed': '失败',
  'working/queued': '排队',
  working: '执行中',
  idle: '空闲',
  ended: '已结束',
}

/** 阶段的中文名；未知阶段原样返回，不猜。 */
export function stageLabel(stage: TicketStage): string {
  return stageLabelOfTag(stageTag(stage))
}

/** 按稳定键取中文名；状态带直接用这个，不再造一套文案。 */
export function stageLabelOfTag(tag: string): string {
  return STAGE_LABEL[tag] ?? tag
}

/**
 * 按上游顺序分类工单阶段。判据与 `src/core/stage.ts:9-21` 一一对应：
 * 结束 → 投递失败 → 待回答 → 待验收 → 受阻/失败且等人 → 排队 → 空闲 → 执行中。
 */
export function ticketStage(ticket: RawTicket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }

  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  // 人跟进过之后，受阻/失败会重新回到执行器——不能再算「等人」。
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) {
    return { stage: 'person', action: report }
  }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  if (report === 'waiting' || assignment.state === 'ended') return { stage: 'idle' }
  return { stage: 'working' }
}

/**
 * 工单是否还在等人：最新报告是 blocked/failed，且此后没有人的消息到达
 * （`src/core/model.ts:349-353`）。更晚的报告、人的消息或重试都会解除。
 */
export function waitsForPerson(ticket: RawTicket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  const reportAt = ms(report.at)
  return !(ticket.inputs ?? []).some(input => {
    if (input.kind !== 'trigger' || !input.human || input.context) return false
    const at = ms(input.at)
    return at !== undefined && reportAt !== undefined && at > reportAt
  })
}

/** 还能不能重试：未结束，且等人处理或投递失败（`src/core/stage.ts:24-26`）。 */
export function canRetry(ticket: RawTicket): boolean {
  return !ticket.ended && (waitsForPerson(ticket) || !!ticket.delivery)
}

/** 上游取最后一条派工（`src/core/model.ts:334`）。 */
function latestAssignment(ticket: RawTicket): RawAssignment | undefined {
  const list = ticket.assignments ?? []
  return list[list.length - 1]
}

function ms(value: string | undefined): number | undefined {
  if (!value) return undefined
  const time = Date.parse(value)
  return Number.isFinite(time) ? time : undefined
}
