/**
 * 评估块的事实行。
 *
 * 准入依据优先读 `decision.mandate.basis`（上游 accept 时持久化），
 * 并按 `decision.policyVersion` 回查当时的策略快照——不再用「当前策略」猜历史。
 * ignore 决策没有 mandate，只显示 strength + reason + 规则的逐条研判。
 */
import { PROSE_PREVIEW_CHARS, type ProseRef } from '../domain/model.ts'
import type { RawDecision, RawTrigger } from '../adapter/superagent/db.ts'
import type { PolicySnapshot } from './policy.ts'
import type { TextSink } from './prose.ts'

export interface FactRow {
  label: string
  value: string
  group?: 'gate' | 'action' | 'assessment' | 'decision' | 'meta'
  tone?: 'ok' | 'warn' | 'muted'
  /** 自由文本超过预览上限时带上全文 id，客户端给「展开原文」。 */
  prose?: ProseRef
}

/** 长的自由文本：`value` 只放预览，全文写进 sink 由 `readText` 按 id 回取。 */
function freeFact(text: string, id: string, sink?: TextSink): { value: string; prose?: ProseRef } {
  if (text.length <= PROSE_PREVIEW_CHARS) return { value: text }
  sink?.set(id, text)
  return { value: text.slice(0, PROSE_PREVIEW_CHARS), prose: { length: text.length, id } }
}

/** 评估块的事实行 id：`span/decision-<id>/facts/<key>`，与块的 spanId 对齐。 */
const factId = (decision: RawDecision, key: string): string => `span/decision-${decision.id}/facts/${key}`

const VIA_LABEL: Readonly<Record<string, string>> = {
  addressed: '名单内发送者点名',
  followup: '工单线程内追问',
  admission: '准入表',
  listed: '名单内',
  bot: '机器人',
}

export const KIND_LABEL: Readonly<Record<string, string>> = {
  accept: '接受，转交派工',
  ignore: '不接',
  stop: '停止工单',
  unavailable: '暂不可用',
}

export function gateFacts(
  decision: RawDecision,
  trigger: RawTrigger | undefined,
  policy: PolicySnapshot | undefined,
  ticketId: string,
  sink?: TextSink,
  /** 作出这次决定的主控会话 id；读不到就写「未记录」。 */
  routerId?: string,
): FactRow[] {
  const rows: FactRow[] = []
  // 从哪来 / 属于谁：评估由主控会话作出，产出就是这张工单。
  const subject = decision.triggerIds ?? []
  rows.push(
    { group: 'meta', label: '评估会话', value: routerId ? `主控会话 ${routerId}` : '主控会话（未记录）', tone: 'muted' },
    { group: 'meta', label: '评估对象', tone: 'muted',
      value: subject.length === 0 ? '事件 Trigger（未记录）'
        : subject.length === 1 ? `事件 Trigger ${subject[0]}` : `事件 Trigger ${subject[0]} 等 ${subject.length} 条` },
    // 按上游语义说：accept 才造工单（`ticketId` 就是它造出来的那张），其余都没有工单。
    { group: 'meta', label: '产出', tone: 'muted',
      value: decision.kind === 'accept' && decision.ticketId
        ? `工单 Ticket ${decision.ticketId}`
        : `没有工单（${decision.kind}）` },
  )
  const basis = decision.mandate?.basis
  const version = decision.mandate?.policyVersion ?? decision.policyVersion
  const snapshot = policy?.at(version)

  if (basis) {
    const via = typeof basis['via'] === 'string' ? basis['via'] : ''
    const cell = typeof basis['cell'] === 'string' ? basis['cell'] : undefined
    const scope = typeof basis['scope'] === 'string' ? basis['scope'] : undefined
    const sender = typeof basis['sender'] === 'string'
      ? basis['sender']
      : typeof basis['actor'] === 'string' ? basis['actor'] : trigger?.actor?.id
    const addressed = typeof basis['addressed'] === 'string' ? basis['addressed'] : trigger?.addressed ?? null

    rows.push({
      group: 'gate', label: '准入依据',
      value: `${VIA_LABEL[via] ?? (via || '已落库的授权')}${cell ? ` · 单元格 ${cell}` : ''}`,
      tone: 'ok',
    })

    if (sender) {
      const allowed = snapshot?.sendersOf(trigger?.source ?? String(basis['source'] ?? '')) ?? []
      rows.push({
        group: 'gate', label: '发送者',
        value: `${sender} · ${snapshot ? (allowed.includes(sender) ? '在名单内' : '不在名单内') : '名单不可得'}`,
        tone: snapshot ? (allowed.includes(sender) ? 'ok' : 'warn') : 'muted',
      })
    }

    if (addressed !== undefined) {
      rows.push({
        group: 'gate', label: '点名',
        value: addressed === 'direct'
          ? '直接点名智能体'
          : addressed === 'mention' ? '@提及智能体（算点名）' : '未点名（走准入表）',
        tone: addressed === 'direct' || addressed === 'mention' ? 'ok' : 'muted',
      })
    }

    // 授权范围是本次评估的任务陈述，可能是一整段话：同样只回预览。
    if (scope) rows.push({ group: 'gate', label: '授权范围', tone: 'muted', ...freeFact(scope, factId(decision, 'scope'), sink) })

    rows.push({
      group: 'gate', label: '策略版本',
      value: version
        ? `${shortVersion(version)}${snapshot?.savedAt ? ` · 快照 ${localTime(snapshot.savedAt)}` : ' · 当时快照不可得'}`
        : '未记录',
      tone: snapshot ? 'ok' : 'muted',
    })
  } else {
    rows.push({
      group: 'gate', label: '准入结果',
      value: `未接单（${decision.kind}）`,
      tone: 'warn',
    })
    rows.push({
      group: 'gate', label: '强度',
      value: decision.strength ?? '未记录',
      tone: 'muted',
    })
    // ignore 没有 mandate：点名信息只能取自 trigger，并注明来源
    if (trigger) {
      rows.push({
        group: 'gate', label: '点名',
        value: trigger.addressed === 'direct'
          ? '直接点名智能体'
          : trigger.addressed === 'mention' ? '@提及智能体（算点名）' : '未点名（走准入表）',
        tone: trigger.addressed ? 'ok' : 'muted',
      })
    }
  }

  const rules = decision.audit?.rule_assessments ?? []
  if (rules.length > 0) {
    const matched = rules.filter(rule => rule.matched).length
    rows.push({
      group: 'assessment', label: '研判',
      value: rules.map(rule => `${rule.rule_id} ${rule.matched ? '命中' : '未命中'}`).join(' · '),
      tone: matched === rules.length ? 'ok' : matched === 0 ? 'warn' : 'muted',
    })
    const firstReason = rules.find(rule => rule.reason)?.reason
    // 理由与证据是模型/系统写的自由文本，可能上千字：只回预览，全文按 id 另取。
    if (firstReason) rows.push({ group: 'assessment', label: '研判理由', tone: 'muted', ...freeFact(firstReason, factId(decision, 'reason'), sink) })
    const evidence = decision.audit?.direction?.['evidence']
    if (evidence) rows.push({ group: 'assessment', label: '证据', tone: 'muted', ...freeFact(String(evidence), factId(decision, 'evidence'), sink) })
  } else {
    rows.push({
      group: 'assessment', label: '研判',
      value: '未运行：准入已放行，不需要模型判断',
      tone: 'muted',
    })
  }

  rows.push({
    group: 'action', label: '路由决定',
    value: rules.length > 0 || decision.mandate?.basis?.['via'] === 'admission'
      ? `评估工具 → eval_decide（工单 Ticket ${ticketId}）`
      : `未调用评估工具（准入直接放行 → 工单 Ticket ${ticketId}）`,
    tone: 'muted',
  })

  rows.push({
    group: 'decision', label: '决定',
    value: `${KIND_LABEL[decision.kind] ?? decision.kind} · ${decision.reason?.[0]?.code ?? '未记录'} · strength=${decision.strength ?? '—'}`,
    tone: decision.kind === 'accept' ? 'ok' : decision.kind === 'ignore' ? 'warn' : 'muted',
  })

  const reasonText = decision.reason?.[0]?.values?.['text']
  if (reasonText) rows.push({ group: 'decision', label: '理由', tone: 'muted', ...freeFact(reasonText, factId(decision, 'reason-text'), sink) })

  return rows
}

const shortVersion = (version: string): string => version.slice(0, 8)

function localTime(value: string): string {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : value
}
