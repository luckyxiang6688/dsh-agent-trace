/**
 * 连线元素（箭头 / 知会点）的详情。
 *
 * 每个元素的段落与原型一致，**不套同一个模板**：
 *   事件 → 消息 / 确认与回复 → 发出去的话 / 派工 → 发生了什么 / 报告 → 报告内容
 *
 * 数据来源：trigger（消息）、outbox（发出去的话，无时间）、
 *          assignment.report（报告摘要）、disposition（去向）。
 */
import { OUTCOME_LABEL, type Chain, type Disposition, type LinkDetail, type Path } from '../domain/model.ts'
import { workerSessionId } from '../domain/session.ts'
import { proseOf, type TextSink } from './prose.ts'

export interface AssignmentView {
  readonly id: string
  readonly label: string
  readonly startMs: number
  readonly endMs: number
  readonly state?: string
  readonly reportState?: string
  readonly reportSummary?: string
  readonly reportAt?: string
}

export interface OutboxView {
  readonly id?: string
  readonly kind: string
  readonly text: string
  readonly status?: string
  /** 被丢弃时的原因（上游只给了码/短句）。 */
  readonly droppedReason?: string
}

/** 箭头指向的一条事件：直接来自 trigger 本身，不经过去向归类。 */
export interface LinkEvent {
  readonly triggerId: string
  readonly text?: string
  readonly at?: string
  readonly actor?: string
  readonly human?: boolean
  readonly threads?: readonly string[]
  readonly addressed?: string | null
}

export interface LinkContext {
  readonly chain: Chain
  readonly dispositions: readonly Disposition[]
  readonly assignments: readonly AssignmentView[]
  readonly outbox: readonly OutboxView[]
  /** 创建工单的那条 trigger；事件箭头优先展示它。 */
  readonly originTriggerId?: string
  /**
   * 创建工单的每条 trigger 的完整记录（batch 时有多条）。
   * `dispositions` 每条决定只保留批里第一条事件，其余起点事件要靠这里补齐原文/发送者/时间。
   */
  readonly originEvents?: readonly LinkEvent[]
}

/** 报告状态码 → 中文徽章。 */
const REPORT_LABEL: Record<string, string> = {
  ready: '就绪', blocked: '受阻', progress: '进行中', failed: '失败', waiting: '等待', dropped: '无需处理',
}

const OUTBOX_STATUS: Record<string, { text: string; tone: 'ok' | 'warn' | 'muted' }> = {
  sent: { text: '已发送', tone: 'ok' },
  pending: { text: '排队中', tone: 'muted' },
  dropped: { text: '未送达', tone: 'warn' },
}

const ADDRESSED_LABEL: Record<string, string> = {
  direct: '直接点名智能体',
  mention: '@提及智能体（算点名）',
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(2)}s`

/** 时间戳 → 本地可读；解析失败原样返回。 */
function localTime(value: string | undefined): string | undefined {
  if (!value) return undefined
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : value
}

/** 发出去的话的公共段落：正文 + 状态（+ 丢弃原因）。正文只回预览。 */
function outboxSections(message: OutboxView, title: string, linkId: string, sink: TextSink): LinkDetail['sections'] {
  const status = OUTBOX_STATUS[message.status ?? ''] ?? (message.status ? { text: message.status, tone: 'muted' as const } : undefined)
  return [
    { title, kind: 'quote', body: proseOf(message.text, `link/${linkId}/sections/0`, sink), say: true },
    ...(status
      ? [{
          title: '投递状态',
          kind: 'badges' as const,
          items: [
            { text: status.text, tone: status.tone },
            ...(message.droppedReason ? [{ text: message.droppedReason, tone: 'warn' as const }] : []),
            ...(message.kind ? [{ text: message.kind, tone: 'muted' as const }] : []),
          ],
        }]
      : []),
  ]
}

/** 按 id 前缀分发；未知 id 返回 undefined，不抛。 */
export function buildLink(
  context: LinkContext,
  linkId: string,
  collect?: TextSink,
): LinkDetail | undefined {
  const sink: TextSink = collect ?? new Map()
  const trigger = /^arrow-trigger(?:-(\d+))?$/.exec(linkId)
  if (trigger) {
    const index = Number(trigger[1] ?? 0)
    // 箭头 #N 对应的是第 N 条起点事件（batch 时一单有多个）；没有 origins 记录才退回单个 origin。
    const origins = context.chain.origins ?? []
    const originId = context.originTriggerId ?? origins[0]?.triggerId
    const targetId = origins[index]?.triggerId
    // 起点事件优先用 trigger 本身：batch 时 `dispositions` 只有批里第一条，
    // 但库里每条起点事件都有原文，不能反过来说「没有记录」。
    const originEvent = targetId !== undefined
      ? context.originEvents?.find(item => item.triggerId === targetId)
      : index === 0 && originId !== undefined
        ? context.originEvents?.find(item => item.triggerId === originId)
        : undefined
    // 有 target 就只认它；找不到原文宁可写「没有记录」，也不拿别的 trigger 的原文冒充。
    const event = originEvent ?? (targetId !== undefined
      ? context.dispositions.find(item => item.triggerId === targetId)
      : index === 0
        ? originId !== undefined
          ? context.dispositions.find(item => item.triggerId === originId)
          : context.dispositions[index]
        : undefined)
    const addressed = event?.addressed
    // 这条消息为什么出现在本工单的图上：起点事件、同批进入评估，还是归属没记录。
    // 判定只用 trigger id，绝不拿 undefined 相等来兜底（那会把后来输入说成起点）。
    const position = targetId !== undefined
      ? targetId === originId
        ? '本工单的起点事件：主控就是从这条消息决定接单的。'
        : '与本工单的起点事件同批进入评估的事件。'
      : index === 0
        ? originId !== undefined
          ? '本工单的起点事件：主控就是从这条消息决定接单的。'
          : '起点事件没有记录；这里显示的是第一条可读事件。'
        : '这条消息的归属没有记录：现有数据里找不到它对应哪条起点事件。'
    return {
      id: linkId,
      title: index === 0 ? '事件 ① · 来源' : `事件 #${index + 1} · 来源`,
      sections: [
        {
          title: '消息',
          kind: 'quote',
          // 有原文就只回预览；没有原文才用我们写的降级说明。
          ...(event?.text
            ? { body: proseOf(event.text, `link/${linkId}/sections/0`, sink) }
            : { text: '（这次运行没有记录原文）' }),
        },
        {
          title: '它在工单里的位置',
          kind: 'note' as const,
          text: position,
        },
        ...(event
          ? [
              {
                title: '发送者',
                kind: 'badges' as const,
                items: [
                  ...(event.actor ? [{ text: event.actor, tone: 'muted' as const }] : []),
                  { text: event.human === false ? '机器人' : '人', tone: 'muted' as const },
                ],
              },
              {
                title: '线程',
                kind: 'note' as const,
                text: event.threads?.length ? event.threads.join(' · ') : '没有记录线程',
              },
              {
                title: '点名方式',
                kind: 'note' as const,
                text: addressed ? (ADDRESSED_LABEL[addressed] ?? addressed) : '未点名（走准入表）',
              },
              ...(localTime(event.at)
                ? [{ title: '时间', kind: 'note' as const, text: localTime(event.at)! }]
                : []),
            ]
          : []),
      ],
    }
  }

  if (linkId === 'arrow-ack') {
    const message = context.outbox.find(item => item.kind === 'acknowledgement')
    // 有工具调用证据但没有 outbox 行时不 404：明确说明缺哪一段。
    if (!message) {
      return {
        id: linkId,
        title: '确认收到 · 回复来源',
        sections: [{ title: '发出去的话', kind: 'note', text: '日志里有确认动作，但没有可读的回复记录（可能已被清理）。' }],
      }
    }
    return {
      id: linkId,
      title: '确认收到 · 回复来源',
      sections: outboxSections(message, '发出去的话', linkId, sink),
    }
  }

  const dispatch = /^arrow-dispatch-(.+)$/.exec(linkId)
  if (dispatch?.[1]) {
    const assignment = context.assignments.find(item => `assignment-${item.id}` === dispatch[1])
    return {
      id: linkId,
      title: `${assignment?.label ?? '派工'} · 投递`,
      sections: [{
        title: '发生了什么',
        kind: 'quote',
        text: `工单 Ticket ${context.chain.ticketId} 已创建，派给一个执行器会话。`,
        items: [
          { text: assignment?.state === 'ended' ? '已结束' : '进行中', tone: 'muted' },
          { text: `执行器会话 ${workerSessionId(context.chain.ticketId)}`, tone: 'muted' },
        ],
      }],
    }
  }

  const report = /^arrow-report-(.+)$/.exec(linkId)
  if (report?.[1]) {
    const assignment = context.assignments.find(item => `assignment-${item.id}` === report[1])
    if (!assignment) return undefined
    return {
      id: linkId,
      title: '报告 · 执行器 → 主控',
      sections: [{
        title: '报告内容',
        kind: 'quote',
        // 报告可能很长：只回前 200 字，全文点「展开原文」再取。
        ...(assignment.reportSummary
          ? { body: proseOf(assignment.reportSummary, `link/${linkId}/sections/0`, sink) }
          : {}),
        items: [
          {
            text: REPORT_LABEL[assignment.reportState ?? ''] ?? assignment.reportState ?? '未记录',
            tone: assignment.reportState === 'ready' ? 'ok' : assignment.reportState === 'blocked' || assignment.reportState === 'failed' ? 'warn' : 'muted',
          },
          ...(localTime(assignment.reportAt)
            ? [{ text: localTime(assignment.reportAt)!, tone: 'muted' as const }]
            : []),
        ],
      }],
    }
  }

  const fast = /^arrow-fast-(\d+)$/.exec(linkId)
  if (fast?.[1]) {
    // 编号用的是「全部事件」的下标（presenter 生成时如此），不是直通子集的下标
    const event = context.dispositions[Number(fast[1])]
    const isContext = event?.path === 'context'
    return {
      id: linkId,
      title: isContext ? '事件 · 仅上下文' : '事件 · 订阅直通',
      sections: [
        {
          title: '消息',
          kind: 'quote',
          ...(event?.text
            ? { body: proseOf(event.text, `link/${linkId}/sections/0`, sink) }
            : { text: '（这次运行没有记录原文）' }),
        },
        {
          title: isContext ? '为什么只是上下文' : '为什么绕过主控',
          kind: 'note',
          text: isContext
            ? '这条消息只作为上下文送到执行器：执行器可以读它，但它不授权、不唤醒模型，也不会单独触发一轮工作。'
            : '线程已被工单订阅，程序直送执行器，不经过评估。主控只收到一份知会。',
        },
      ],
    }
  }

  const notice = /^notice-(\d+)$/.exec(linkId)
  if (notice?.[1]) {
    const event = context.dispositions.filter(item => item.path === 'direct')[Number(notice[1])]
    return {
      id: linkId,
      title: '知会 · 主控收到副本',
      sections: [
        {
          title: '它收到的',
          kind: 'quote',
          ...(event?.text
            ? { body: proseOf(event.text, `link/${linkId}/sections/0`, sink) }
            : { text: '（没有记录）' }),
        },
        { title: '说明', kind: 'note', text: '这条消息走直通去了执行器；主控只被抄送，不参与决策，也不会因此唤醒模型。' },
      ],
    }
  }

  const reply = /^arrow-reply-(\d+)$/.exec(linkId)
  if (reply?.[1]) {
    const messages = context.outbox.filter(item => item.kind === 'reply')
    const message = messages[Number(reply[1])]
    if (!message) {
      return {
        id: linkId,
        title: '回复 · 主控 → 来源',
        sections: [{ title: '发出去的话', kind: 'note', text: '日志里有回复动作，但没有可读的回复记录（可能已被清理）。' }],
      }
    }
    return {
      id: linkId,
      title: '回复 · 主控 → 来源',
      sections: outboxSections(message, '发出去的话', linkId, sink),
    }
  }

  // 状态带：只讲「这段时间工单在什么状态、为什么、接下来该发生什么」。
  const stateBand = /^state-band-(\d+)$/.exec(linkId)
  if (stateBand?.[1]) {
    const band = (context.chain.stateBands ?? [])[Number(stateBand[1])]
    if (!band) return undefined
    return {
      id: linkId,
      title: `状态 · ${band.label}`,
      ...(band.startsApprox ? { subtitle: '起点为近似值：提问时刻没有落库，按提出问题的报告反推' } : {}),
      sections: [
        {
          title: '这段时间',
          kind: 'badges',
          items: [
            { text: `从 ${bandTime(band.startMs)} 起`, tone: 'muted' },
            { text: `持续 ${bandTime(band.endMs - band.startMs)}`, tone: 'muted' },
            { text: band.tag, tone: 'muted' },
          ],
        },
        {
          title: '为什么是这个状态',
          kind: 'note',
          text: band.reason ?? '这一段没有留下可判定的记录，状态按派工与报告的先后推导。',
        },
        { title: '接下来', kind: 'note', text: bandNext(band.tag) },
      ],
    }
  }

  // 比例带的段与图例：一条路径上的事件清单。
  const pathLink = /^path-(routed|direct|context|filtered)$/.exec(linkId)
  if (pathLink?.[1]) {
    const path = pathLink[1] as Path
    const meta = PATH_META[path]
    const events = context.dispositions.filter(item => item.path === path)
    // 段只在该路径有事件时才画得出来，所以走到这里说明两次请求之间数据变了：
    // 给一句说明，别把「没数据」摔成 404 让客户端弹错误条。
    if (events.length === 0) {
      return {
        id: linkId,
        title: meta.title,
        subtitle: meta.subtitle,
        sections: [{ title: '说明', kind: 'note', text: '这条路径的事件已不在当前记录里（可能被上游清理或轮转），刷新后可再看一次。' }],
      }
    }
    const base = Date.parse(context.chain.createdAt)
    // 解析不了的时间（上游可能给空串以外的脏值）不能当 0 用，否则会排到最前；
    // 也不能让 NaN 流进排序，那会让整组退化成输入顺序。
    const offset = (value: string | undefined): number => {
      const ms = value ? Date.parse(value) : Number.NaN
      return Number.isFinite(ms - base) ? Math.max(ms - base, 0) : Number.MAX_SAFE_INTEGER
    }
    const sorted = [...events].sort((left, right) => offset(left.at) - offset(right.at))
    // 丢弃是「按原因分组，每组一个例子」：同一原因几百条时逐条列没有信息量。
    // 例子取最早的一条，组按首次出现的时刻排列。分组键带上人和点名方式——
    // 否则「alice 点名」和「机器人群发」会被并成一组，例子行的属性被读成整组的属性。
    const groups = path === 'filtered'
      ? [...sorted.reduce((byOutcome, event) => {
          const key = `${event.outcome}\u0000${event.human === false ? 'bot' : 'human'}\u0000${event.addressed ?? ''}`
          const hit = byOutcome.get(key)
          if (hit) hit.n += 1
          else byOutcome.set(key, { example: event, n: 1 })
          return byOutcome
        }, new Map<string, { example: Disposition; n: number }>()).values()]
      : sorted.map(example => ({ example, n: 1 }))

    return {
      id: linkId,
      title: meta.title,
      subtitle: meta.subtitle,
      sections: [
        ...groups.map(({ example, n }, index) => {
          const atMs = example.at ? Date.parse(example.at) : Number.NaN
          const relative = Number.isFinite(atMs - base) ? bandTime(atMs - base) : undefined
          const outcome = OUTCOME_LABEL[example.outcome] ?? example.outcome
          const addressed = example.addressed ? (ADDRESSED_LABEL[example.addressed] ?? example.addressed) : '未点名'
          return {
            title: `${relative ?? '（没有记录时间）'} · ${example.actor ?? '未记录发送者'}`,
            kind: 'quote' as const,
            ...(example.text
              ? { body: proseOf(example.text, `link/${linkId}/sections/${index}`, sink) }
              : { text: '（这次运行没有记录原文）' }),
            items: [
              { text: outcome, tone: outcomeTone(example.outcome) },
              { text: example.human === false ? '机器人' : '人', tone: 'muted' as const },
              // 结果已经是「未点名」时不再重复一个同名徽章：两枚一样的字只占位置。
              ...(addressed === outcome ? [] : [{ text: addressed, tone: 'muted' as const }]),
              ...(n > 1 ? [{ text: `同类 ${n} 条`, tone: 'muted' as const }] : []),
            ],
          }
        }),
        ...(path === 'filtered'
          ? [{ title: '说明', kind: 'note' as const, text: '这些事件在进入主控前就被规则挡下，不会出现在时序图上。' }]
          : []),
      ],
    }
  }

  void seconds
  return undefined
}

/** 三条路径各一句话，讲清「为什么走这条、对人意味着什么」。 */
const PATH_META: Readonly<Record<Path, { title: string; subtitle: string }>> = {
  routed: {
    title: '经主控 · 慢路径',
    subtitle: '这些事件先送到主控评估：核对发送者、点名与规则，再决定接单、拒绝还是停止。',
  },
  direct: {
    title: '订阅直通 · 快路径',
    subtitle: '线程已被工单订阅，程序把消息直接送进执行器，不经过评估；主控只收到一份知会。',
  },
  context: {
    title: '仅上下文',
    subtitle: '消息只作为上下文送到执行器：能被读到，但不授权、不唤醒模型。',
  },
  filtered: {
    title: '源头丢弃',
    subtitle: '这些事件在准入之前就被挡下，按原因分组，每组给一个例子。',
  },
}

/** 结果码的正负：接单/送达是完成，拒绝/停止/不可用是没做成，其余只是记录。 */
function outcomeTone(code: string): 'ok' | 'warn' | 'muted' {
  if (code === 'accept' || code === 'delivered' || code === 'observed' || code === 'explicitRouted') return 'ok'
  if (code === 'ignore' || code === 'stop' || code === 'unavailable') return 'warn'
  return 'muted'
}

/** 相对工单创建的时长：秒级给两位小数，分钟级给「m分s秒」。 */
function bandTime(ms: number): string {
  const value = Math.max(ms, 0)
  if (value < 60_000) return `${(value / 1000).toFixed(2)}s`
  return `${Math.floor(value / 60_000)}m${Math.round((value % 60_000) / 1000)}s`
}

/** 各状态的下一步：写「等什么」，不写空话。 */
function bandNext(tag: string): string {
  switch (tag) {
    case 'person/review': return '等人验收。验收后由主控收尾，或退回继续。'
    case 'person/answer': return '等人回答问题；回答会作为输入重新送回执行器。'
    case 'person/delivery': return '输入没有送进执行器会话，需要重新投递或重试。'
    case 'person/blocked': return '执行器报受阻且此后没有人跟进，等人的指示或重试。'
    case 'person/failed': return '执行器报失败且此后没有人跟进，等人的指示或重试。'
    case 'working/queued': return '任务已派给执行器但还没开始，等它启动。'
    case 'idle': return '执行器上一轮已结束、没有待处理项，等新输入或主控收尾。'
    case 'ended': return '工单已结束，这条链路到此为止。'
    default: return '执行器正在处理，等它报告。'
  }
}
