/**
 * 归因覆盖率：库里每一条决定，界面能不能把它的码翻译成人话。
 *
 * 这是「解释力」承诺唯一的硬指标——不需要埋点，只用现有 sqlite 离线算。
 * 口径必须与界面一致：只检查界面**真的会显示**的字段，不额外扣分，
 * 也不替界面把没显示的码算成已解释。
 *
 * 判据：一条决定的所有码都能在译名表里查到 → 可解释；有一个查不到 → 记一条缺口。
 * 来源自定义码（`REASONS` 之外）本来就可能查不到，缺口会点名它在哪个字段，
 * 由人判断是补译名还是留给来源插件。
 */
import type { RawDecision } from '../adapter/superagent/db.ts'
import {
  ADDRESSED_LABEL,
  CELL_LABEL,
  OUTCOME_LABEL,
  REASON_LABEL,
  RULE_LABEL,
  STRENGTH_LABEL,
  VIA_LABEL,
} from '../domain/model.ts'

export interface CoverageGap {
  decisionId: string
  kind: string
  /** 界面上的字段名（裁定 / 授权强度 / 主控理由码 / 授权依据 / 规则评估）。 */
  field: string
  code: string
}

export interface CoverageBucket {
  total: number
  explainable: number
}

export interface CoverageReport {
  total: number
  explainable: number
  byKind: Record<string, CoverageBucket>
  /** 非 accept 的决定（未接单）——解释力的主指标：人最需要知道「为什么没接」。 */
  nonAccept: CoverageBucket
  gaps: CoverageGap[]
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

/** 只报表里没有的码；空值不算缺口（界面本来就不显示该行）。 */
function gapsOf(decision: RawDecision): Omit<CoverageGap, 'decisionId' | 'kind'>[] {
  const gaps: Omit<CoverageGap, 'decisionId' | 'kind'>[] = []

  const check = (field: string, table: Readonly<Record<string, string>>, code: string | undefined): void => {
    if (code && !(code in table)) gaps.push({ field, code })
  }

  check('裁定', OUTCOME_LABEL, text(decision.kind))
  check('授权强度', STRENGTH_LABEL, text(decision.mandate?.strength) ?? text(decision.strength))

  for (const reason of decision.reason ?? []) {
    check('主控理由码', REASON_LABEL, text(reason.code))
  }

  const basis = decision.mandate?.basis
  if (basis) {
    check('授权依据', VIA_LABEL, text(basis['via']))
    check('授权依据', ADDRESSED_LABEL, text(basis['addressed']))
    check('授权依据', CELL_LABEL, text(basis['cell']))
    const rules = Array.isArray(basis['rules']) ? basis['rules'] : []
    for (const rule of rules) check('授权依据', RULE_LABEL, text(rule))
  }

  for (const rule of decision.audit?.rule_assessments ?? []) {
    check('规则评估', RULE_LABEL, text(rule.rule_id))
  }

  return gaps
}

export function auditDecisionCoverage(decisions: readonly RawDecision[]): CoverageReport {
  const report: CoverageReport = {
    total: 0,
    explainable: 0,
    byKind: {},
    nonAccept: { total: 0, explainable: 0 },
    gaps: [],
  }

  for (const decision of decisions) {
    const kind = decision.kind || '(缺少 kind)'
    const bucket = report.byKind[kind] ??= { total: 0, explainable: 0 }
    const gaps = gapsOf(decision)

    report.total += 1
    bucket.total += 1
    if (kind !== 'accept') report.nonAccept.total += 1

    if (gaps.length === 0) {
      report.explainable += 1
      bucket.explainable += 1
      if (kind !== 'accept') report.nonAccept.explainable += 1
    } else {
      for (const gap of gaps) report.gaps.push({ decisionId: decision.id, kind, ...gap })
    }
  }

  return report
}

const percent = (part: number, whole: number): string =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`

/** 纯文本报告，给 CLI 贴到终端 / 文档里。 */
export function formatCoverageReport(report: CoverageReport): string {
  const lines: string[] = []
  lines.push(`决定总数 ${report.total}，可解释 ${report.explainable}（${percent(report.explainable, report.total)}）`)
  lines.push(`未接单决定 ${report.nonAccept.total}，可解释 ${report.nonAccept.explainable}（${percent(report.nonAccept.explainable, report.nonAccept.total)}）`)
  lines.push('')
  lines.push('按裁定分：')
  for (const [kind, bucket] of Object.entries(report.byKind).sort((a, b) => b[1].total - a[1].total)) {
    lines.push(`  ${kind}: ${bucket.explainable}/${bucket.total}`)
  }
  if (report.gaps.length === 0) {
    lines.push('', '缺口：无')
    return lines.join('\n')
  }
  lines.push('', `缺口 ${report.gaps.length} 条（字段 / 码 / 决定 id）：`)
  for (const gap of report.gaps) {
    lines.push(`  ${gap.field} · ${gap.code} · ${gap.decisionId}`)
  }
  return lines.join('\n')
}
