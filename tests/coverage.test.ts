/**
 * 归因覆盖率的口径：只按界面**真的会显示**的字段判，认不得的码逐条点名。
 * 这些用例同时充当口径文档——改口径先改这里。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { auditDecisionCoverage, formatCoverageReport } from '../src/service/coverage.ts'
import type { RawDecision } from '../src/adapter/superagent/db.ts'

const accept: RawDecision = {
  id: 'd-accept',
  kind: 'accept',
  strength: 'explicit',
  reason: [{ code: 'explicitRouted' }],
  mandate: {
    strength: 'explicit',
    basis: { via: 'addressed', addressed: 'direct', sender: 'alice', rules: ['copy'] },
  },
  audit: { rule_assessments: [{ rule_id: 'copy', matched: true }] },
}

const ignore: RawDecision = {
  id: 'd-ignore',
  kind: 'ignore',
  strength: 'inferred',
  reason: [{ code: 'said', values: { text: '无关紧要' } }],
  audit: { rule_assessments: [{ rule_id: 'visual', matched: false }] },
}

test('全码可查的决定算可解释，非 accept 单独计数', () => {
  const report = auditDecisionCoverage([accept, ignore])
  assert.equal(report.total, 2)
  assert.equal(report.explainable, 2)
  assert.deepEqual(report.nonAccept, { total: 1, explainable: 1 })
  assert.deepEqual(report.byKind, {
    accept: { total: 1, explainable: 1 },
    ignore: { total: 1, explainable: 1 },
  })
  assert.deepEqual(report.gaps, [])
})

test('准入闸的码（不在 REASONS 表里）也算可解释', () => {
  const decisions: RawDecision[] = ['no_mention', 'not_a_member', 'admission_ignored', 'not_human']
    .map(code => ({ id: `d-${code}`, kind: 'ignore', reason: [{ code }] }))
  const report = auditDecisionCoverage(decisions)
  assert.equal(report.explainable, 4)
  assert.deepEqual(report.gaps, [])
})

test('来源自定义理由码算缺口，字段与码都要点名', () => {
  const report = auditDecisionCoverage([
    { ...ignore, id: 'd-custom', reason: [{ code: 'workspacePolicyV2' }] },
  ])
  assert.equal(report.explainable, 0)
  assert.deepEqual(report.nonAccept, { total: 1, explainable: 0 })
  assert.deepEqual(report.gaps, [
    { decisionId: 'd-custom', kind: 'ignore', field: '主控理由码', code: 'workspacePolicyV2' },
  ])
})

test('裁定、强度、准入依据、规则评估的未知值各自成缺口', () => {
  const report = auditDecisionCoverage([{
    id: 'd-mixed',
    kind: 'deferred',
    strength: 'assumed',
    mandate: {
      basis: { via: 'carrier-pigeon', addressed: 'shouted', cell: 'nowhere', rules: ['house-style'] },
    },
    audit: { rule_assessments: [{ rule_id: 'house-style', matched: false }] },
  }])
  const fields = report.gaps.map(gap => `${gap.field}:${gap.code}`)
  assert.deepEqual(fields, [
    '裁定:deferred',
    '授权强度:assumed',
    '授权依据:carrier-pigeon',
    '授权依据:shouted',
    '授权依据:nowhere',
    '授权依据:house-style',
    '规则评估:house-style',
  ])
  assert.deepEqual(report.nonAccept, { total: 1, explainable: 0 })
})

test('空值不算缺口：界面本来就不显示那一行', () => {
  const report = auditDecisionCoverage([{ id: 'd-bare', kind: 'ignore' }])
  assert.equal(report.explainable, 1)
  assert.deepEqual(report.gaps, [])
})

test('mandate.strength 优先于顶层 strength（与界面同口径）', () => {
  const report = auditDecisionCoverage([{
    id: 'd-strength',
    kind: 'accept',
    strength: 'assumed',
    mandate: { strength: 'explicit' },
  }])
  assert.deepEqual(report.gaps, [])
})

test('文本报告给出两个比例与缺口明细', () => {
  const report = auditDecisionCoverage([
    accept,
    ignore,
    { ...ignore, id: 'd-custom', reason: [{ code: 'customCode' }] },
  ])
  const text = formatCoverageReport(report)
  assert.match(text, /决定总数 3，可解释 2（66\.7%）/)
  assert.match(text, /未接单决定 2，可解释 1（50\.0%）/)
  assert.match(text, /主控理由码 · customCode · d-custom/)
})
