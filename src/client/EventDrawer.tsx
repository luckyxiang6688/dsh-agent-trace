/**
 * 来源事件抽屉。骨架沿用旧抽屉（380px、`aside` + `b` + 关闭按钮）：
 * E2E 靠这个形状识别抽屉，换皮不换骨。
 *
 * 段序固定：原文 → 事实 → 解释 → 没记录的事实 → 线程 → 关联工单。
 * 先看这条消息自己说了什么，再看系统怎么判它；三段的口径必须分开：
 *   原文     —— 这条事件的原话，只回预览，点「展开全文」才取；
 *   事实     —— 库里写下的字段，原文照录；
 *   解释     —— 由原因码查表得来，明确标「解释」，不是记录；
 *   没记录的事实 —— 库没写、也不能靠猜补的，逐条声明。
 * 每段只放数据，不放「这段是怎么来的」旁注——那是实现约束，摆在抽屉里像在免责。
 */
import { createElement as h, useState } from 'react'
import type { Prose } from '../domain/model.ts'
import type { SourceEventDetail } from '../domain/source.ts'
import { fetchSourceEventText } from './api.ts'
import { relatedTicketLabel } from './labels.ts'
import { styles } from './styles.ts'

export function EventDrawer(props: {
  source: string
  detail?: SourceEventDetail
  error?: string
  onClose: () => void
  onOpenTicket: (ticketId: string) => void
}): ReturnType<typeof h> {
  const { detail } = props
  const primary = detail?.relatedTickets[0]?.ticketId

  return h('aside', { 'data-drawer': '1', style: styles.drawer },
    h('div', { style: styles.drawerHead },
      h('b', null, detail?.title ?? '事件详情'),
      h('button', { style: styles.close, onClick: props.onClose }, '×')),
    h('div', { style: styles.drawerBody },
      props.error
        ? h('div', { style: styles.error }, `读不到事件：${props.error}`)
        : !detail
          ? h('div', { style: styles.pending }, '读取中…')
          : [
              // 原文放最前：先看这条消息自己说了什么，再看系统怎么判它。
              detail.text
                ? section('原文', [
                    h(SourceProse, {
                      key: 'prose',
                      source: props.source,
                      triggerId: detail.triggerId,
                      prose: detail.text,
                    }),
                  ])
                : null,

              section('事实', detail.facts.map((fact, index) =>
                h('div', {
                  key: index,
                  'data-fact': fact.label,
                  style: {
                    ...styles.checkItem,
                    ...(fact.tone === 'ok' ? styles.checkOk : fact.tone === 'warn' ? styles.checkWarn : {}),
                  },
                },
                  h('div', { style: styles.checkName }, fact.label),
                  h('div', { style: styles.checkNote }, fact.value)))),

              detail.interpretations.length
                ? section('解释', [
                    ...detail.interpretations.map((item, index) =>
                      h('div', { key: index, 'data-interp': '1', style: styles.interpretation },
                        h('span', { style: styles.interpTag }, '解释'),
                        // 不用 <b>：抽屉头那个 <b> 是 E2E 定位标题用的，此处再出现会让断言含糊。
                        h('span', { style: { fontWeight: 600 } }, item.label),
                        `：${item.text}`)),
                  ])
                : null,

              detail.notRecorded.length
                ? section('没记录的事实', detail.notRecorded.map((text, index) =>
                    h('div', { key: index, style: styles.notRecordedItem }, text)))
                : null,

              detail.threads.length
                ? section('线程', [
                    ...detail.threads.map(thread =>
                      h('div', { key: thread.key, style: styles.stepBlock },
                        h('div', { style: styles.stepHead }, thread.label ?? thread.key),
                        h('div', { style: styles.field },
                          h('span', { style: styles.fieldLabel }, '线程'),
                          h('span', { style: styles.fieldValue }, thread.key)),
                        h('div', { style: styles.field },
                          h('span', { style: styles.fieldLabel }, '订阅'),
                          h('span', { style: styles.fieldValue },
                            thread.subscriptions.length ? thread.subscriptions.join(' · ') : '没有')),
                        h('div', { style: styles.field },
                          h('span', { style: styles.fieldLabel }, '仅上下文'),
                          h('span', { style: styles.fieldMeta },
                            thread.context.length ? thread.context.join(' · ') : '没有')),
                        thread.lastAt
                          ? h('div', { style: styles.field },
                              h('span', { style: styles.fieldLabel }, '最近活动'),
                              h('span', { style: styles.fieldMeta }, thread.lastAt))
                          : null)),
                  ])
                : null,

              detail.relatedTickets.length
                ? section('关联工单', [
                    ...detail.relatedTickets.map(ticket =>
                      h('button', {
                        key: ticket.ticketId,
                        style: styles.openTicket,
                        onClick: () => props.onOpenTicket(ticket.ticketId),
                      },
                        relatedTicketLabel(ticket, props.source))),
                    primary
                      ? h('button', {
                          key: 'primary',
                          style: { ...styles.openTicket, borderColor: '#c7c9f5', fontWeight: 600 },
                          onClick: () => props.onOpenTicket(primary),
                        }, '打开工单时序图 →')
                      : null,
                  ])
                : null,
            ]),
  )
}

function section(title: string, content: readonly (ReturnType<typeof h> | null)[]): ReturnType<typeof h> {
  return h('div', { key: title, style: styles.sec },
    h('div', { 'data-drawer-section': title, style: styles.secTitle }, title),
    ...content.filter(Boolean))
}

/**
 * 原文：默认显示预览；超过预览长度时给「展开全文」，点了才取全文。
 * 取不到就明说，预览不消失——源码可读性差的时候不要把它变成空白。
 */
function SourceProse(props: {
  source: string
  triggerId: string
  prose: Prose
}): ReturnType<typeof h> {
  const { prose } = props
  const [open, setOpen] = useState(false)
  const [full, setFull] = useState<string | undefined>()
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const expandable = prose.length > prose.text.length
  const body = open && full !== undefined ? full : prose.text

  const toggle = async () => {
    if (open) { setOpen(false); return }
    if (full !== undefined) { setOpen(true); return }
    setLoading(true)
    setFailed(false)
    const text = await fetchSourceEventText(props.source, props.triggerId)
    setLoading(false)
    if (text === undefined) { setFailed(true); return }
    setFull(text)
    setOpen(true)
  }

  return h('div', null,
    h('div', { style: { ...styles.quoteIn, ...(open ? styles.proseFull : {}) } }, body),
    expandable || open
      ? h('div', { style: styles.proseBar },
          failed ? h('span', { style: styles.proseError }, '原文已不可读') : null,
          h('button', {
            style: styles.proseToggle,
            disabled: loading,
            onClick: () => void toggle(),
          }, loading ? '读取中…' : open ? '收起' : `展开全文 · ${prose.length} 字`))
      : null)
}
