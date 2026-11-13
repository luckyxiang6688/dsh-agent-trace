/**
 * 原因码 → 人话。**这一层是解释，不是记录。**
 *
 * 界面必须把它单独成段并写明「解释」：库里只有码，句子是查表来的。
 * 表里没有的码不推测，明说「不在解释表里」。
 */
import type { SourceEventInterpretation } from '../domain/source.ts'
import { codeLabel, OUTCOME_LABEL, REASON_LABEL } from '../domain/model.ts'

/** 源头 scope 判定的原因码。它们和主控准入层共用同一个码空间，别把两道闸混成一道。 */
const GATE_TEXT: Readonly<Record<string, string>> = {
  no_mention: '这道闸判这条消息没有点名。注意：同一个码也可能来自主控准入层，'
    + '具体是哪道闸要看这条事件有没有裁定记录——源头丢弃不写裁定。',
  not_a_member: '主控准入：发送者不在该来源的名单里。',
  not_human: '主控准入：发送者被判定为机器人/非人类。',
  admission_ignored: '主控准入：命中准入表里的「忽略」格。',
  no_admissible: '主控准入：没有可用的准入路径。',
  listedUnaddressed: '主控准入：名单内但没点名。',
  unlistedAddressed: '主控准入：点了名但不在名单内。',
  unlistedUnaddressed: '主控准入：既不在名单内也没有点名。',
  source_disabled: '来源未启用。',
  source_not_installed: '来源未安装。',
}

/** 主控裁定的结果。 */
const DECISION_TEXT: Readonly<Record<string, string>> = {
  accept: '主控裁定接单：准入与研判都通过，据此创建或关联了一张工单。',
  ignore: '主控裁定不接：这条消息不转成工单。具体理由看「主控理由码」。',
  stop: '主控裁定停止：该线程上的工作到此为止。',
  unavailable: '主控判定当前不可用（不是失败，也不是拒绝）。',
  observed: '主控只做了观察（观察模式 observe），没有据此建单。',
}

/**
 * 决策行里的理由码（上游 `core/reasons.ts` 的 `REASONS`）。
 * 只翻译上游定义的码；来源自定义码落到 `NOT_IN_TABLE`，不推测。
 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  said: '这条理由的原话记在「理由原文」里（上游用 `said` 表示：发送者就是这么说的）。',
  timeout: '评估超时。',
  policyChanged: '评估期间策略被改过，这次评估按当时的策略收尾。',
  noAdmissible: '没有可准入的事件（这批事件都被准入拦下了）。',
  startedTicket: '该线程已经建过工单，不再重复建单。',
  acceptedBefore: '这条事件此前已经被接单处理过。',
  routed: '已路由到工单。',
  explicitRouted: '明确点名 + 名单内，按直路由处理，不需要模型裁量。',
  humanStop: '人工要求停止。',
  legacyImport: '从旧版任务记录导入，不是本次评估产生的。',
  forwarded: '转给该线程已有工单的执行器。',
  senderNotMember: '发送者不在该来源的名单里。',
  retried: '人工重试。',
  hostRestarted: 'dsh-superagent 重启导致这次收尾。',
  stopUnknown: '停止目标未知或已经结束。',
  stopNotExplicit: '停止需要名单内发送者明确要求，这条不算。',
  directionUnsettled: '研判认为实现方向还没定，不能接单。',
  noRuleMatched: '研判没有命中任何启用中的规则。',
  ignoredFromCard: '从卡片上被忽略，没有经过规则评估。',
  observed: '观察模式（observe）下记录为「本应接单」，实际没有建单。',
  // 准入闸的码：`policy.ts` 直接返回并写进决定行，不在 `REASONS` 表里。
  // 同一个码空间也被来源层的 scope 判定使用，所以不把话说死是哪道闸。
  no_mention: '没有点名智能体，且这个来源不接收其余消息。',
  not_a_member: '发送者不在这个来源的名单里。',
  admission_ignored: '准入表把这一格设为忽略。',
  not_human: '发送者被判为自动消息（机器人），或来源不接收这条。',
  // 历史数据里见过的收尾码（不在当前上游 `REASONS` 表里），保留原译名。
  stale: '评估期间事件已经被别的决定处理过。',
}

const NOT_IN_TABLE = '这个码不在本插件的解释表里，不做推测；上文的事实行是库里原样记录。'

/**
 * 来源层丢弃的码。
 *
 * 上游把「来源不听这条」原样落成 `filtered: { code }`（`core/intake.ts:27`），而
 * `SourceKind.scope` 的契约只返回码、不返回说明——来源插件可以自定义任意字面码。
 * 所以表里没有的码就是**真的无法从库里知道含义**，只能指明它归谁定义。
 */
export function interpretFilteredCode(code: string, source?: string): SourceEventInterpretation {
  const known = GATE_TEXT[code]
  if (known) return { label: `原因码 ${code}`, text: known }
  const owner = source ? `来源 ${source} 的插件` : '产生它的来源插件'
  return {
    label: `原因码 ${code}`,
    text: `这是${owner}在「来源层」给出的判定码：上游契约允许来源自定义码，`
      + '库里只存这个码、不存它的说明。本插件的解释表里没有它，不做推测。'
      + '码的含义随来源插件的版本变化，要确认只能对照**当时安装的那一版**来源插件。',
  }
}

export function interpretDecisionKind(kind: string): SourceEventInterpretation {
  return { label: `裁定 ${codeLabel(OUTCOME_LABEL, kind) ?? kind}`, text: DECISION_TEXT[kind] ?? NOT_IN_TABLE }
}

export function interpretReasonCode(code: string): SourceEventInterpretation {
  return { label: `理由码 ${codeLabel(REASON_LABEL, code) ?? code}`, text: REASON_TEXT[code] ?? NOT_IN_TABLE }
}

/** 测试用：把表暴露出来，防止改了文案却没人发现。 */
export const EXPLAIN_TABLES = { GATE_TEXT, DECISION_TEXT, REASON_TEXT } as const
