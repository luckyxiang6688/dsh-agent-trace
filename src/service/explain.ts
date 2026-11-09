/**
 * 原因码 → 人话。**这一层是解释，不是记录。**
 *
 * 界面必须把它单独成段并写明「解释」：库里只有码，句子是查表来的。
 * 表里没有的码不推测，明说「不在解释表里」。
 */
import type { SourceEventInterpretation } from '../domain/source.ts'

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
  observed: '主控只做了观察（observe 模式），没有据此建单。',
}

/** 决策行里的理由码。 */
const REASON_TEXT: Readonly<Record<string, string>> = {
  explicitRouted: '明确点名 + 名单内，按直路由处理，不需要模型裁量。',
  noRuleMatched: '研判没有命中任何启用中的规则。',
  directionUnsettled: '研判认为实现方向还没定，不能接单。',
  observed: 'observe 模式下记录为「本应接单」，实际没有建单。',
  stale: '评估期间事件已经被别的决定处理过。',
  timeout: '评估超时。',
}

const NOT_IN_TABLE = '这个码不在本插件的解释表里，不做推测；上文的事实行是库里原样记录。'

export function interpretFilteredCode(code: string): SourceEventInterpretation {
  return { label: `原因码 ${code}`, text: GATE_TEXT[code] ?? NOT_IN_TABLE }
}

export function interpretDecisionKind(kind: string): SourceEventInterpretation {
  return { label: `裁定 ${kind}`, text: DECISION_TEXT[kind] ?? NOT_IN_TABLE }
}

export function interpretReasonCode(code: string): SourceEventInterpretation {
  return { label: `理由码 ${code}`, text: REASON_TEXT[code] ?? NOT_IN_TABLE }
}

/** 测试用：把表暴露出来，防止改了文案却没人发现。 */
export const EXPLAIN_TABLES = { GATE_TEXT, DECISION_TEXT, REASON_TEXT } as const
