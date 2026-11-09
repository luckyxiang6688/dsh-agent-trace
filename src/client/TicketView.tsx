/**
 * 一张工单的内部视图：比例带 + 时序图 + 两抽屉。
 *
 * 它不再自带左栏：内存里没有路由，工单是覆盖在来源页之上的一层
 * （`TicketOverlay`），来源页在下面保持挂载。这里只负责这张工单本身。
 */
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  present, laneOf, formatDuration, CANVAS_WIDTH, STATE_BAND_WIDTH, type SwimlaneModel,
} from '../presenter/swimlane.ts'
import { OUTCOME_LABEL, type ActionDetail, type Chain, type Disposition, type LinkDetail, type Prose, type SpanDetail } from '../domain/model.ts'
import { fetchChain, fetchLink, fetchSpanDetail, fetchText, translateTexts } from './api.ts'
import { pushEscape } from './escape.ts'
import { styles } from './styles.ts'

const ROLE_COLOR: Record<string, string> = {
  source: '#94a3b8',
  router: '#818cf8',
  executor: '#34d399',
  subagent: '#a3b8c9',
}

/** 状态带底色：低饱和实色，与「未参与」的斜纹一眼区分；要淡到不盖住活动块。 */
const STATE_FILL: Record<string, string> = {
  person: '#fbf3e3',
  working: '#eef7f2',
  idle: '#f3f5f7',
  ended: '#eef0f4',
}

export function TicketView(props: { ticketId: string }): ReturnType<typeof h> {
  const { ticketId } = props
  const [chain, setChain] = useState<Chain | undefined>()
  const [dispositions, setDispositions] = useState<readonly Disposition[]>([])
  const [detail, setDetail] = useState<SpanDetail | undefined>()
  const [link, setLink] = useState<LinkDetail | undefined>()
  const [translations, setTranslations] = useState<Record<string, string>>({})
  const [translating, setTranslating] = useState(false)
  // 超过翻译上限的正文 id：明说「太长没翻」，不让人以为失败了。
  const [skipped, setSkipped] = useState<Record<string, true>>({})
  const [error, setError] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  /** 已取回的全文，按「工单 + 文本 id」缓存：展开/收起不重复请求。 */
  const fullTexts = useRef(new Map<string, string>())

  useEffect(() => {
    let alive = true
    setLoading(true)
    setChain(undefined)
    setDispositions([])
    setDetail(undefined)
    setLink(undefined)
    setError(undefined)
    void (async () => {
      const data = await fetchChain(ticketId)
      if (!alive) return
      if (!data) {
        setError(`读不到工单 ${ticketId}`)
        setLoading(false)
        return
      }
      setChain(data.chain)
      setDispositions(data.dispositions)
      setLoading(false)
    })()
    return () => { alive = false }
  }, [ticketId])

  // 抽屉开着时，Esc 只关抽屉（栈顶），不会连带关掉覆盖层。
  useEffect(() => {
    if (!detail && !link) return
    const release = pushEscape(() => { setDetail(undefined); setLink(undefined) })
    return release
  }, [detail, link])

  // 点抽屉外部收起；点图上的可点元素交给它自己的 onClick（否则一次点击关掉又打开）。
  useEffect(() => {
    if (!detail && !link) return
    const close = () => { setDetail(undefined); setLink(undefined) }
    const onDown = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null
      if (!target) return
      if (target.closest('[data-drawer]')) return
      if (target.closest('[data-span], [data-link], [data-legend]')) return
      close()
    }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [detail, link])

  const model = useMemo(
    () => (chain ? present(chain, { events: dispositions }) : undefined),
    [chain, dispositions],
  )

  /** 取一段正文的全文；抽屉默认只有预览，点「展开原文」才走这里。 */
  const loadText = useCallback(async (textId: string): Promise<string | undefined> => {
    if (!chain) return undefined
    const key = `${chain.ticketId}\u0000${textId}`
    const hit = fullTexts.current.get(key)
    if (hit !== undefined) return hit
    const text = await fetchText(chain.ticketId, textId)
    if (text !== undefined) fullTexts.current.set(key, text)
    return text
  }, [chain])

  const openLink = useCallback(async (linkId: string) => {
    if (!chain) return
    const data = await fetchLink(chain.ticketId, linkId)
    if (!data) { setError(`读不到连线 ${linkId}`); return }
    setDetail(undefined)
    setTranslations({})
    setSkipped({})
    setLink(data)
  }, [chain])

  const openSpan = useCallback(async (spanId: string) => {
    if (!chain) return
    const data = await fetchSpanDetail(chain.ticketId, spanId)
    if (!data) { setError(`读不到这一段 ${spanId}`); return }
    setLink(undefined)
    setDetail(data)
    setSkipped({})
    // 之前翻过的直接用缓存，不再让用户点第二次（键是 Prose.id）
    setTranslations(data.translations ?? {})
  }, [chain])

  // 翻译由用户主动触发：抽屉打开不产生任何模型调用。
  // 送的是全文（翻译上限按全文判），取回后按 `Prose.id` 存，和抽屉数据对得上。
  const translate = useCallback(async (items: readonly Prose[]) => {
    if (items.length === 0) return
    setTranslating(true)
    try {
      // 路由一次最多收 5 条：超出的分批，否则后面的永远翻不到。
      for (let start = 0; start < items.length; start += 5) {
        const batch = items.slice(start, start + 5)
        const fulls = await Promise.all(batch.map(item =>
          item.length > item.text.length ? loadText(item.id) : Promise.resolve(item.text)))
        // 取不到全文（会话已归档）就不翻：拿预览去翻，存回来的译文和原文对不上，
        // 重开抽屉还会因为服务端按全文缓存而消失。
        const ready = batch
          .map((item, index) => ({ item, text: fulls[index] }))
          .filter((entry): entry is { item: Prose; text: string } => entry.text !== undefined)
        if (ready.length === 0) continue
        const payload = await translateTexts(ready.map(entry => entry.text))
        if (!payload) continue
        setTranslations(previous => {
          const next = { ...previous }
          payload.items?.forEach((item, index) => {
            const prose = ready[index]?.item
            if (item && prose) next[prose.id] = item
          })
          return next
        })
        const skippedIds = (payload.skipped ?? [])
          .map(index => ready[index]?.item.id)
          .filter((id): id is string => typeof id === 'string')
        if (skippedIds.length > 0) {
          setSkipped(previous => ({ ...previous, ...Object.fromEntries(skippedIds.map(id => [id, true as const])) }))
        }
      }
    } catch { /* 翻译失败保留原文 */ }
    setTranslating(false)
  }, [loadText])

  return h('div', { style: styles.ticketBody },
    error ? h('div', { style: styles.error }, `读不到数据：${error}`) : null,
    chain ? h('h1', { style: styles.title }, chain.title) : null,
    // 不点抽屉也要知道「这是哪张工单、事件从哪来」：标题下先给身份行。
    // 来源读不到就写「未记录」，不把缺字段伪装成「没有来源」。
    chain
      ? h('div', { 'data-identity': '1', style: styles.identity },
          `工单 Ticket ${chain.ticketId} · ${chain.source ? `来源 ${chain.source}` : '来源（未记录）'}`)
      : null,
    chain ? h('div', { style: styles.sub }, `${chain.stage} · ${model ? formatDuration(model.durationMs) : ''}`) : null,
    chain && model
      ? h(Bar, { items: dispositions, chain, onLink: (id: string) => void openLink(id) })
      : null,
    chain && model
      ? h(Sequence, {
          chain,
          model,
          onLink: (id: string) => void openLink(id),
          onPick: (id: string) => void openSpan(id),
        })
      : h('div', { style: styles.empty }, loading ? '读取中…' : '这张工单没有可画的时序'),
    link
      ? h('aside', { 'data-drawer': '1', style: styles.drawer },
          h('div', { style: styles.drawerHead },
            h('b', null, link.title),
            h('button', { style: styles.close, onClick: () => setLink(undefined) }, '×')),
          h('div', { style: styles.drawerBody }, ...renderLink(link, loadText)))
      : null,
    detail
      ? h('aside', { 'data-drawer': '1', style: styles.drawer },
          h('div', { style: styles.drawerHead },
            h('b', null, detail.title),
            h('button', { style: styles.close, onClick: () => setDetail(undefined) }, '×')),
          h('div', { style: styles.drawerBody },
            ...renderDetail(detail, translations, skipped, translating, loadText, (items: readonly Prose[]) => void translate(items))))
      : null,
  )
}

type LoadText = (id: string) => Promise<string | undefined>

/**
 * 一段正文：默认只显示预览（最多 200 字）。超过预览长度时给「展开原文 · N 字」，
 * 点了才去取全文；取不到就明说，预览不消失。
 */
function ProseBlock(props: {
  prose: Prose
  display?: string
  say?: boolean
  /** 想法、工具返回默认压到 4 行，避免一眼看到一屏英文。 */
  clamp?: boolean
  onLoad: LoadText
}): ReturnType<typeof h> {
  const { prose, display, say, clamp, onLoad } = props
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const expandable = prose.length > prose.text.length
  // 有译文时收起态显示译文；展开态显示原文全文。
  const collapsed = display ?? prose.text
  const body = open && full !== undefined ? full : collapsed

  const toggle = async () => {
    if (open) { setOpen(false); return }
    if (full !== undefined) { setOpen(true); return }
    setLoading(true)
    setFailed(false)
    const text = await onLoad(prose.id)
    setLoading(false)
    if (text === undefined) { setFailed(true); return }
    setFull(text)
    setOpen(true)
  }

  return h('div', null,
    h('div', {
      style: {
        ...(say ? styles.quoteSay : styles.quoteIn),
        ...(clamp && !open ? styles.proseClamp : {}),
        ...(open ? styles.proseFull : {}),
      },
    }, body),
    expandable || open
      ? h('div', { style: styles.proseBar },
          failed ? h('span', { style: styles.proseError }, '原文已不可读（会话可能已归档）') : null,
          h('button', {
            style: styles.proseToggle,
            disabled: loading,
            onClick: () => void toggle(),
          }, loading ? '读取中…' : open ? '收起' : `展开原文 · ${prose.length} 字`))
      : null)
}

/** 连线详情：形状与原型一致——引用气泡 / 徽章行 / 说明，不用表格。 */
function renderLink(link: LinkDetail, onLoad: LoadText): ReturnType<typeof h>[] {
  return [
    link.subtitle ? h('div', { key: 'sub', style: styles.linkSub }, link.subtitle) : null,
    ...link.sections.map((section, index) =>
      h('div', { key: index, style: styles.sec },
        h('div', { style: styles.secTitle }, section.title),
        ...(section.body
          ? [h(ProseBlock, { key: 'b', prose: section.body, say: section.say, onLoad })]
          : section.text
            ? [h('div', { key: 't', style: section.say ? styles.quoteSay : styles.quote }, section.text)]
            : []),
        ...(section.items?.length
          ? [h('div', { key: 'b', style: styles.badges },
              ...section.items.map((item, i) => h('span', {
                key: i,
                style: {
                  ...styles.badge,
                  ...(item.tone === 'ok' ? styles.pillOk : item.tone === 'warn' ? styles.pillWarn : {}),
                },
              }, item.text)))]
          : []),
        ...(section.kind === 'note' && !section.text ? [h('div', { key: 'n', style: styles.pending }, '—')] : []))),
  ].filter(Boolean) as ReturnType<typeof h>[]
}

function renderDetail(
  detail: SpanDetail,
  translations: Record<string, string>,
  skipped: Record<string, true>,
  translating: boolean,
  onLoad: LoadText,
  onTranslate: (items: readonly Prose[]) => void,
): ReturnType<typeof h>[] {
  const blocks: ReturnType<typeof h>[] = []

  /** 一段「它的想法」：右侧带翻译按钮，翻过的直接给中文 */
  const thoughtSection = (key: string, items: readonly Prose[]) => {
    if (items.length === 0) return null
    const done = items.every(item => translations[item.id] || skipped[item.id])
    return h('div', { key, style: styles.sec },
      h('div', { style: styles.secHead },
        h('span', { style: styles.secTitle }, '它的想法'),
        done ? null : h('button', {
          style: { ...styles.secAction, ...(translating ? styles.headActionBusy : {}) },
          disabled: translating,
          onClick: () => onTranslate(items),
        }, translating ? '翻译中…' : '翻译')),
      ...items.map(item =>
        h(ProseBlock, {
          key: item.id,
          prose: item,
          display: translations[item.id],
          clamp: true,
          onLoad,
        })),
      ...items
        .filter(item => skipped[item.id])
        .map(item => h('div', { key: `skip-${item.id}`, style: styles.proseError },
          `原文 ${item.length} 字，超过翻译上限（1200 字）`)))
  }

  /** 一组结构化事实（勾选项/徽章，不套表格）；没有行就不画空壳。 */
  const factsSection = (key: 'gate' | 'action' | 'assessment' | 'decision' | 'meta', title: string) => {
    const rows = (detail.facts ?? []).filter(row => (row.group ?? 'gate') === key)
    if (rows.length === 0) return null
    return h('div', { key: `facts-${key}`, style: styles.sec },
      h('div', { style: styles.secTitle }, title),
      ...rows.map((row, index) => {
        // 配色由数据层给出的字段值决定，不再用自然语言正则猜正负。
        // 概要类（时间/人名/编号）不是核对项，不挂「通过/未通过」徽章。
        const tone = row.tone ?? 'muted'
        const isMeta = (row.group ?? 'gate') === 'meta'
        return h('div', { key: index, 'data-fact': row.label, style: { ...styles.checkItem, ...(!isMeta && tone === 'ok' ? styles.checkOk : !isMeta && tone === 'warn' ? styles.checkWarn : {}) } },
          h('div', { style: styles.checkHead },
            h('b', { style: styles.checkName }, row.label),
            isMeta ? null : h('span', { style: { ...styles.pill, ...(tone === 'ok' ? styles.pillOk : tone === 'warn' ? styles.pillWarn : styles.pillMuted) } },
              tone === 'ok' ? '通过' : tone === 'warn' ? '未通过' : '记录')),
          row.prose
            ? h('div', { style: styles.checkNote },
                h(ProseBlock, {
                  prose: { text: row.value, length: row.prose.length, id: row.prose.id },
                  clamp: true,
                  onLoad,
                }))
            : h('div', { style: styles.checkNote }, row.value))
      }))
  }

  // 首行：模型自己写的报告摘要 / 系统落库的任务陈述。出处标在旁边，不改写内容。
  if (detail.lead) {
    blocks.push(h('div', { key: 'lead', style: styles.lead },
      h('span', { style: styles.leadTag }, detail.leadSource === 'system' ? '系统记录' : '模型自述'),
      h('span', null, detail.lead)))
  }

  // 概要紧跟首行：谁在跑、什么时候、耗时这些先给结论，再展开过程。
  const summary = factsSection('meta', '概要')
  if (summary) blocks.push(summary)

  if (detail.received.length) {
    blocks.push(h('div', { key: 'recv', style: styles.sec },
      h('div', { style: styles.secTitle }, '它收到的'),
      ...detail.received.map(item => h(ProseBlock, { key: item.id, prose: item, onLoad }))))
  }

  const topThoughts = thoughtSection('think', detail.thoughts)
  if (topThoughts) blocks.push(topThoughts)
  else if (detail.note) {
    blocks.push(h('div', { key: 'note', style: styles.sec },
      h('div', { style: styles.secTitle }, '它的想法'),
      h('div', { style: styles.pending }, detail.note)))
  }

  // 评估块的三段事实（勾选项/徽章，不套表格）；概要已在首行后面画过，这里不再重复
  for (const group of [
    { key: 'gate', title: '判定依据 · 准入 Gate' },
    { key: 'action', title: '它的动作' },
    { key: 'assessment', title: '研判 Assessment' },
    { key: 'decision', title: '决定 Decision' },
  ] as const) {
    const section = factsSection(group.key, group.title)
    if (section) blocks.push(section)
  }

  // 执行过程：按「第 N 步」分组。step 号按轮重置，多轮时组头带上轮次，避免连着三个「第 1 步」。
  const manyTurns = new Set((detail.steps ?? []).map(step => step.turn).filter(turn => turn !== undefined)).size > 1
  for (const step of detail.steps ?? []) {
    const label = manyTurns && step.turn !== undefined ? `第 ${step.turn} 轮 · 第 ${step.step} 步` : `第 ${step.step} 步`
    blocks.push(h('div', { key: `step-${step.turn ?? ''}-${step.step}`, style: styles.stepBlock },
      h('div', { style: styles.stepHead },
        label + (step.tools.length ? ` · ${step.tools.join(' / ')}` : ''),
        // 会话中途换过模型才出现；没换就不在每步重复一遍。
        step.model
          ? h('span', { key: 'model', style: styles.stepModel },
              ` · 模型改为 ${step.model.provider ? `${step.model.provider} / ` : ''}${step.model.model}`)
          : null),
      ...(step.received.length
        ? [h('div', { key: 'step-recv', style: styles.sec },
            h('div', { style: styles.secTitle }, '它收到的'),
            ...step.received.map(item => h(ProseBlock, { key: item.id, prose: item, onLoad })))]
        : []),
      thoughtSection(`th-${step.step}`, step.thoughts) ?? undefined,
      h('div', { key: 'act', style: styles.sec },
        h('div', { style: styles.secTitle }, '它的动作'),
        ...step.actions.map((action, index) => renderAction(action, index, onLoad)))))
  }

  // 事件超过上限时只加载了开头一批：这条必须说出来，不能让后面的步骤「看起来没发生」。
  if (detail.truncated) {
    blocks.push(h('div', { key: 'truncated', style: styles.truncNote },
      `这段活动有 ${detail.truncated.total} 条记录，抽屉只展开了最早的 ${detail.truncated.shown} 条，`
      + '后面的步骤没有加载（长任务的会话日志读取上限）。'))
  }

  // 结果：子代理的交付物、执行器最后一步的收尾
  if (detail.outcome) {
    blocks.push(h('div', { key: 'outcome', style: styles.sec },
      h('div', { style: styles.secTitle }, '结果'),
      h(ProseBlock, { prose: detail.outcome, onLoad })))
  }

  if (blocks.length === 0) blocks.push(h('div', { key: 'none', style: styles.pending }, '这一段没有留下可读的记录'))
  return blocks.filter(Boolean) as ReturnType<typeof h>[]
}

/** 一次工具调用：工具名 + 参数 + 结果行。成功只报体量，失败才带可展开的原文。 */
function renderAction(action: ActionDetail, index: number, onLoad: LoadText): ReturnType<typeof h> {
  const result = action.result
  return h('div', { key: index, style: { ...styles.action, ...(action.failed ? styles.actionFailed : {}) } },
    h('div', { style: styles.actionTool },
      action.toolNote ?? action.tool,
      // 中文名旁边留原名（带命名空间/下划线），方便和会话日志/上游工具名对上。
      action.toolNote ? h('span', { key: 'raw', style: styles.toolRaw }, action.toolRaw ?? action.tool) : null,
      action.failed
        ? h('span', { key: 'f', style: { ...styles.pill, ...styles.pillWarn, marginLeft: 6 } }, '失败')
        : null),
    ...action.fields.map((field, fieldIndex) =>
      h('div', { key: fieldIndex, style: styles.field },
        h('span', { style: styles.fieldLabel }, field.label),
        field.prose
          ? h('div', { style: styles.fieldProse },
              h(ProseBlock, {
                prose: { text: field.value, length: field.prose.length, id: field.prose.id },
                clamp: true,
                onLoad,
              }))
          : h('span', {
              style: field.kind === 'code' ? styles.fieldCode : styles.fieldValue,
            }, field.value))),
    result
      ? h('div', { key: 'result', style: styles.field },
          h('span', { style: styles.fieldLabel }, '结果'),
          result.detail
            ? h('div', { style: styles.fieldProse },
                h(ProseBlock, {
                  prose: { text: result.summary, length: result.detail.length, id: result.detail.id },
                  clamp: true,
                  onLoad,
                }))
            : h('span', {
                style: result.status === 'error' ? styles.fieldValue : styles.fieldMeta,
              }, result.summary))
      : null)
}

/** 本工单相关事件去向：段可点、图例可点，两处都开同一个连线详情。 */
function Bar(props: { items: readonly Disposition[]; chain: Chain; onLink: (id: string) => void }) {
  const { items, chain, onLink } = props
  const paths = [
    { key: 'routed', label: '经主控', color: '#818cf8', stripe: false },
    { key: 'direct', label: '订阅直通', color: '#f59e0b', stripe: true },
    { key: 'context', label: '仅上下文', color: '#a3b8c9', stripe: false },
    { key: 'filtered', label: '源头丢弃', color: '#e5e7eb', stripe: false },
  ] as const

  if (items.length === 0) return null

  const counts = paths.map(path => ({ ...path, n: items.filter(item => item.path === path.key).length }))
  const total = Math.max(items.length, 1)

  return h('div', { style: styles.barCard },
    h('div', { style: styles.barHead },
      // 一张工单可能跨多个线程：标题说的是「本工单」，不是「这条线程」
      h('span', null, '本工单相关事件去向'),
      h('span', { style: styles.barTotal }, `${items.length} 条事件`)),
    h('div', { style: styles.barTrack },
      ...counts.filter(item => item.n > 0).map(item =>
        h('div', {
          key: item.key,
          // 段本身也能点：图例在下面，视线先落到带子上。
          'data-link': `path-${item.key}`,
          title: `${item.label} ${item.n} 条`,
          onClick: () => onLink(`path-${item.key}`),
          style: {
            width: `${(item.n / total) * 100}%`, background: item.color, height: '100%', cursor: 'pointer',
            ...(item.stripe
              ? { backgroundImage: 'repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 4px, transparent 4px 8px)' }
              : {}),
          },
        }))),
    h('div', { style: styles.legend },
      ...counts.map(item =>
        h('span', {
          key: item.key,
          // 图例是第二个入口：段在带子上，图例在下面，两处都得能点开。
          'data-legend': item.n === 0 ? undefined : `path-${item.key}`,
          style: { ...styles.legendItem, ...(item.n === 0 ? styles.legendOff : {}) },
          onClick: item.n === 0 ? undefined : () => onLink(`path-${item.key}`),
        },
          h('i', { style: { ...styles.swatch, background: item.color } }),
          `${item.label} ${item.n} 条`,
          outcomeSummary(items.filter(entry => entry.path === item.key))))),
    h('div', { style: styles.barTitle }, chain.title),
  )
}

/** 括号里的结果分布：接单 1 · 拒绝 0 */
function outcomeSummary(items: readonly Disposition[]): string {
  if (items.length === 0) return ''
  const tally = new Map<string, number>()
  for (const item of items) tally.set(item.outcome, (tally.get(item.outcome) ?? 0) + 1)
  return `（${[...tally].map(([code, n]) => `${OUTCOME_LABEL[code] ?? code} ${n}`).join(' · ')}）`
}

const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳'
function circled(n: number): string {
  return n >= 1 && n <= 20 ? CIRCLED[n - 1]! : `(${n})`
}

function Sequence(props: {
  chain: Chain
  model: SwimlaneModel
  onPick: (id: string) => void
  onLink: (id: string) => void
}) {
  const { model, chain, onPick, onLink } = props
  const width = model.canvasWidth ?? CANVAS_WIDTH
  return h('div', null,
    h('div', { style: styles.canvas },
      // `data-scroller`：性能采样要量「用户实际滚的那个容器」，不是外层页面。
      h('div', { style: styles.scroller, 'data-scroller': 'timeline' },
      h('svg', { viewBox: `0 0 ${width} ${model.heightPx}`, style: styles.svg },
        h('defs', null,
          h('pattern', { id: 'hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
            h('rect', { width: 6, height: 6, fill: '#f7f8fa' }),
            h('line', { x1: 0, y1: 0, x2: 0, y2: 6, stroke: '#e6e9ed', strokeWidth: 1.2 }))),
        // 画布左上角给出图名：标题区只有工单标题，不点开不知道这是一张什么图。
        h('text', {
          x: 8, y: 22, fontSize: 11, fill: '#9aa1ab', letterSpacing: '.04em',
          'data-chart-title': '1',
        }, '工单时序图'),
        ...model.lanes.map(lane => h('g', { key: lane.key },
          h('line', {
            x1: lane.x * width, y1: 40, x2: lane.x * width, y2: model.heightPx - 24,
            stroke: '#eef0f2', strokeWidth: 1.5,
          }),
          h('text', {
            x: lane.x * width, y: 22, textAnchor: 'middle', fontSize: 13,
            fontWeight: 650, fill: ROLE_COLOR[lane.role],
            'data-lane': lane.key,
            'data-lane-en': lane.labelEn === lane.label ? undefined : lane.labelEn,
          }, lane.label,
            // 多来源列没有英文别名（labelEn 就是来源名），不重复画一遍。
            lane.labelEn === lane.label
              ? null
              : h('tspan', { dx: 4, fontSize: 9, fontWeight: 500, fill: '#9aa1ab' }, lane.labelEn)),
        )),
        ...model.ticks.map(tick => h('g', { key: tick.atMs },
          h('text', {
            x: 54, y: tick.top + 4, textAnchor: 'end', fontSize: 9.5, fill: '#b6bcc4',
          }, tick.label),
          h('line', {
            x1: 62, y1: tick.top, x2: width - 40, y2: tick.top,
            stroke: '#f2f4f6', strokeWidth: 1,
          }),
        )),
        ...model.stateBands.map(band => {
          const lane = laneOf(model, band.laneKey)
          const w = STATE_BAND_WIDTH
          return h('g', {
            key: band.id, 'data-link': band.id, style: { cursor: 'pointer' },
            onClick: () => onLink(band.id),
          },
            h('rect', {
              x: lane.x * width - w / 2, y: band.top, width: w, height: Math.max(band.height, 2),
              rx: 4, fill: STATE_FILL[band.group] ?? '#eef1f5', opacity: 0.9,
              ...(band.startsApprox ? { stroke: '#d5dae1', strokeWidth: 1, strokeDasharray: '4 3' } : {}),
            }),
            // 标签在色块右侧留白，不再压块标题；留白不够时只留悬停提示。
            band.labelX === undefined
              ? h('title', null, band.label)
              : h('text', {
                  x: band.labelX,
                  y: band.labelY ?? band.top + 13,
                  textAnchor: band.labelAnchor ?? 'start',
                  fontSize: 9.5, fill: '#9aa1ab',
                }, band.label),
          )
        }),
        ...model.bands.map(band => {
          const lane = laneOf(model, band.laneKey)
          return h('g', { key: band.id },
            h('rect', {
              x: lane.x * width - 46, y: band.top, width: 92, height: band.height,
              fill: 'url(#hatch)', opacity: 0.7,
            }),
            band.height > 56
              ? h('text', {
                  x: lane.x * width + 52, y: band.top + 14, fontSize: 9.5, fill: '#b6bcc4',
                }, band.label)
              : null,
          )
        }),
        ...model.notices.map(notice => {
          const lane = laneOf(model, notice.laneKey)
          return h('g', {
            key: notice.id, 'data-link': notice.id, style: { cursor: 'pointer' },
            onClick: () => onLink(notice.id),
          },
            h('circle', { cx: lane.x * width, cy: notice.top, r: 3.5, fill: '#f59e0b' }),
            h('text', {
              x: lane.x * width + 10, y: notice.top + 13, fontSize: 9.5, fill: '#b45309',
            }, `${notice.label} Notice`))
        }),
        ...model.arrows.map(arrow => {
          const from = laneOf(model, arrow.from)
          const to = laneOf(model, arrow.to)
          const x1 = from.x * width
          const x2 = to.x * width
          const dir = x2 > x1 ? 1 : -1
          const color = arrow.kind === 'fast' ? '#f59e0b' : arrow.kind === 'back' ? '#94a3b8' : '#6366f1'
          const dash = arrow.kind === 'fast' ? '6 4' : arrow.kind === 'back' ? '2 3' : undefined
          const mid = (x1 + x2) / 2
          return h('g', {
            key: arrow.id, 'data-link': arrow.id, style: { cursor: 'pointer' },
            onClick: () => onLink(arrow.id),
          },
            h('line', {
              x1: x1 + dir * 9, y1: arrow.top, x2: x2 - dir * 12, y2: arrow.top,
              stroke: color, strokeWidth: 1.4, strokeDasharray: dash,
            }),
            h('path', {
              d: `M${x2 - dir * 12},${arrow.top - 3.5} L${x2 - dir * 3},${arrow.top} L${x2 - dir * 12},${arrow.top + 3.5} Z`,
              fill: color,
            }),
            // 标签压在活动块上时由 presenter 决定：内联进块标题行（不单独画），
            // 或留在原位加白描边——两种都比「字压在块标题上」可读。
            arrow.inline ? null : h('text', {
              x: arrow.labelX ?? mid, y: arrow.top - 6, textAnchor: arrow.labelAnchor ?? 'middle', fontSize: 10, fill: color,
              ...(arrow.halo ? { style: { paintOrder: 'stroke' }, stroke: '#fff', strokeWidth: 3 } : {}),
            }, `${circled(arrow.step)} ${arrow.label}`, arrow.labelEn
              ? h('tspan', { fontSize: 7.5, fill: '#b6bcc4' }, ` ${arrow.labelEn}`)
              : null),
          )
        }),
        ...model.nodes.map(node => {
          const lane = laneOf(model, node.laneKey)
          const color = ROLE_COLOR[node.role] ?? '#94a3b8'
          const isEvent = node.event === true
          const blockWidth = node.width
          const blockHeight = node.nested ? 20 : node.height
          const blockTop = node.top
          const left = lane.x * width - blockWidth / 2
          // 离散事件只占一行：小圆角、单行字，不与活动块混淆。
          const textOffset = node.nested ? 10 : isEvent ? 24 : 28
          // 子代理是 20px 小卡、离散事件是 14px 小点：都放不下第二个注解。
          const badge = node.nested || isEvent ? undefined : node.badge
          const textBaseline = blockTop + (node.nested ? 14 : isEvent ? 10 : 17)
          return h('g', { key: node.id, 'data-span': node.id, onClick: () => onPick(node.id), style: { cursor: 'pointer' } },
            h('rect', {
              x: left, y: blockTop, width: blockWidth, height: blockHeight,
              rx: isEvent ? 7 : 6, fill: color, opacity: isEvent ? 0.26 : node.nested ? 0.12 : 0.16, stroke: color,
              strokeDasharray: node.nested ? '3 3' : undefined,
            }),
            !node.nested && node.step
              ? h('text', {
                  x: left + 12, y: textBaseline, fontSize: isEvent ? 9 : 11, fill: color,
                }, circled(node.step))
              : null,
            // 标签与注解同一行：注解用小一号字跟在标签后面，绝不另起一行压到下一块。
            h('text', {
              x: left + textOffset, y: textBaseline,
              fontSize: node.nested ? 9.5 : isEvent ? 9.5 : 11, fill: '#334155',
            }, node.label,
              badge
                ? h('tspan', {
                    dx: 4, fontSize: 7.5,
                    fill: node.badgeKind === 'fast' ? '#f59e0b' : node.badgeKind === 'call' ? '#6366f1' : node.badgeKind === 'back' ? '#94a3b8' : '#64748b',
                  }, `${node.badgeStep === undefined ? '' : `${circled(node.badgeStep)} `}${badge}`)
                : null),
            // 内联放不下时整段文字仍在：悬停看全量。
            badge ? h('title', null, badge) : null,
            // 起点不是观测值：虚线边 + 明说，不让人以为是精确时刻
            node.approxStart
              ? h('g', { key: 'approx' },
                  h('line', {
                    x1: lane.x * width - blockWidth / 2, y1: blockTop,
                    x2: lane.x * width + blockWidth / 2, y2: blockTop,
                    stroke: color, strokeWidth: 1.4, strokeDasharray: '4 3',
                  }),
                  h('text', {
                    x: lane.x * width + blockWidth / 2 + 6, y: blockTop + 9,
                    fontSize: 8.5, fill: '#b6bcc4',
                  }, '起点未知'))
              : null,
          )
        }),
      ),
      ),
    ),
  )
}
