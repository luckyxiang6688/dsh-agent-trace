/**
 * 「评估时模型在想什么」：取**本次**候选（trigger_id）的评估工具调用之前
 * 最近一条 assistant 消息。之前实现取「第一条 evaluation 之前」，
 * 两条决定会共用同一段想法——这是错的。
 */
export interface ThoughtEvent {
  type?: string
  data?: Record<string, unknown>
}

const EVAL_TOOLS = new Set(['orchestrator_eval', 'orchestrator_eval_decide'])

export function thoughtBeforeEval(
  events: readonly ThoughtEvent[],
  triggerId: string | undefined,
): string | undefined {
  let latestText = ''
  for (const event of events) {
    if (event.type === 'assistant/message') {
      const text = textOf(event.data ?? {})
      if (text) latestText = text
      continue
    }
    if (event.type !== 'tool/call') continue
    const name = typeof event.data?.['name'] === 'string' ? String(event.data['name']) : ''
    if (!EVAL_TOOLS.has(name)) continue
    const args = parseArgs(event.data?.['arguments'] ?? event.data?.['args'])
    const id = typeof args?.['trigger_id'] === 'string' ? String(args['trigger_id']) : undefined
    // 有 triggerId 时按它匹配；没有就退回「第一次评估之前」，保持旧行为
    if (triggerId === undefined || id === triggerId) return latestText || undefined
  }
  return undefined
}

function parseArgs(raw: unknown): Record<string, unknown> | undefined {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return undefined
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

function textOf(data: Record<string, unknown>): string {
  const direct = data['text']
  if (typeof direct === 'string') return direct
  const message = data['message']
  if (message && typeof message === 'object') return textOf(message as Record<string, unknown>)
  const content = data['content']
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map(part => part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
        ? String((part as { text: string }).text)
        : '')
      .join('')
  }
  return ''
}
