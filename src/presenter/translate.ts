/**
 * 结构翻译：把工具调用与模型输出的结构翻成人话。
 *
 * 三条铁律：
 *   1. 只翻结构，不猜意图——模型自己的描述原样引用
 *   2. 未知字段降级成键值对，**绝不显示 JSON 花括号**
 *   3. 大段正文只给摘要，正文按需展开
 */

export interface Field {
  readonly label: string
  readonly value: string
  readonly kind: 'text' | 'code' | 'path' | 'badge' | 'size' | 'resource' | 'offset'
}

/** 参数字段 → 人话标签与呈现方式。按字段名写，与工具名无关。 */
const FIELD_RULES: readonly { key: string; label: string; kind: Field['kind'] }[] = [
  { key: 'command', label: '命令', kind: 'code' },
  { key: 'description', label: '说明', kind: 'text' },
  { key: 'file_path', label: '文件', kind: 'path' },
  { key: 'path', label: '路径', kind: 'path' },
  { key: 'pattern', label: '匹配', kind: 'code' },
  { key: 'query', label: '查询', kind: 'text' },
  { key: 'content', label: '写入内容', kind: 'code' },
  { key: 'old_string', label: '替换前', kind: 'code' },
  { key: 'new_string', label: '替换后', kind: 'code' },
  { key: 'text', label: '内容', kind: 'text' },
  { key: 'summary', label: '摘要', kind: 'text' },
  { key: 'purpose', label: '用途', kind: 'badge' },
  { key: 'state', label: '状态', kind: 'badge' },
  { key: 'trigger_id', label: '事件', kind: 'code' },
  { key: 'ticket_id', label: '工单 Ticket', kind: 'code' },
  // orchestrator_read 的分页参数：resource 是它读的那份上下文，offset 是续读位置。
  { key: 'resource', label: '资源', kind: 'resource' },
  { key: 'offset', label: '续读位置', kind: 'offset' },
]

/** 资源路径的第一段 → 中文名。取自上游 orchestrator_read 的资源清单，只译名词，不猜内容。 */
const RESOURCE_WORDS: Readonly<Record<string, string>> = {
  tickets: '工单列表',
  // 术语双语：实体名第一次出现在抽屉里时带上上游英文，和画布上的「事件 Trigger / 派工 Assignment」对齐。
  ticket: '工单 Ticket',
  triggers: '事件列表',
  trigger: '事件',
  threads: '线程列表',
  thread: '线程',
  decisions: '决定列表',
  decision: '决定',
  settings: '设置',
  prompts: '提示词',
  'prompt-preview': '提示词预览',
  models: '模型',
  feishu: '飞书原文',
  github: 'GitHub 原文',
}

/**
 * 资源路径的第二段之后：`ticket/<id>/assignment` 这类子资源的中文名。
 * 取自上游 `RESOURCES` 清单（`src/app/resources.ts`），只译已核对的词，认不得的原样保留。
 */
const RESOURCE_TAILS: Readonly<Record<string, string>> = {
  assignment: '派工任务',
  assignments: '派工列表',
  inputs: '收到的事件',
  result: '最新报告',
  report: '报告',
  transcript: '执行器会话记录',
  message: '消息',
  input: '事件',
}

/**
 * `ticket/c5faef17fff20441f4b105b70f265c13/assignment` → `工单 Ticket <完整 id> / 派工任务`。
 *
 * 资源是**路径**不是定长 id：名词段 + 32 位 id（ticket/decision）+ 可选的子资源。
 * 实测最长 50 字，远低于抽屉上限，所以 id 不用截断，整条路径照实显示；
 * 仍保留一次长度上限——资源串可能很长（URL/文件路径），不能绕过「单串 ≤200 字」。
 * 值是 URL / 文件路径时不猜，原样返回。
 */
function renderResource(text: string): string {
  const [head = '', id, ...tail] = text.split('/').filter(Boolean)
  const noun = RESOURCE_WORDS[head]
  let out = text
  if (noun) {
    const parts: string[] = [id ? `${noun} ${id}` : noun]
    for (let index = 0; index < tail.length; index += 1) {
      const segment = tail[index]!
      const word = RESOURCE_TAILS[segment]
      const next = tail[index + 1]
      // `report/<id>`：名词与它后面的 id 合成一段「报告 <id>」
      if (word && next !== undefined && RESOURCE_TAILS[next] === undefined) {
        parts.push(`${word} ${next}`)
        index += 1
        continue
      }
      parts.push(word ?? segment)
    }
    out = parts.join(' / ')
  }
  return out.length > MAX_INLINE ? `${out.slice(0, MAX_INLINE)}…（共 ${out.length} 字）` : out
}

/** 值的状态码 → 中文。查不到就原样返回。 */
const VALUE_WORDS: Readonly<Record<string, string>> = {
  answer: '答复',
  result: '结果',
  ready: '就绪',
  blocked: '受阻',
  progress: '进行中',
  failed: '失败',
  waiting: '等待',
}

const MAX_INLINE = 160

/** 工具名去掉命名空间前缀，保留可读部分。 */
export function toolLabel(name: string): string {
  const short = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  return short.replace(/_/g, ' ')
}

/**
 * 已知工具的中文名。只收**行为已经核对过**的几个：
 * read 是分页读上下文资源，route 是路由工单，ack/reply 是确认与回复，
 * eval 系列是准入研判（think 侧与 detail 侧都在用）。
 * 没收录的工具保持原名——宁可看见英文，也不猜它是干什么的。
 */
const TOOL_WORDS: Readonly<Record<string, string>> = {
  orchestrator_read: '读取资源',
  orchestrator_route: '路由工单',
  orchestrator_ack: '确认收到',
  orchestrator_reply: '回复来源',
  orchestrator_report: '上报结果',
  orchestrator_eval: '准入研判',
  orchestrator_eval_read: '读取评估材料',
  orchestrator_eval_decide: '作出准入决定',
}

/** 工具名的中文名；没收录返回 undefined（调用方保留原名）。 */
export function toolChinese(name: string): string | undefined {
  const short = name.includes('/') ? name.slice(name.lastIndexOf('/') + 1) : name
  return TOOL_WORDS[short]
}

/** 参数 → 字段列表。未知字段追加在末尾，不丢弃。 */
export function translateArgs(args: unknown): readonly Field[] {
  if (!args || typeof args !== 'object') return []
  const record = args as Record<string, unknown>
  const used = new Set<string>()
  const fields: Field[] = []

  for (const rule of FIELD_RULES) {
    const raw = record[rule.key]
    if (raw === undefined || raw === null) continue
    used.add(rule.key)
    fields.push({ label: rule.label, value: renderValue(raw, rule.kind), kind: rule.kind })
  }

  for (const [key, raw] of Object.entries(record)) {
    if (used.has(key) || raw === undefined || raw === null) continue
    if (typeof raw === 'object') continue
    fields.push({ label: key, value: renderValue(raw, 'text'), kind: 'text' })
  }
  return fields
}

function renderValue(raw: unknown, kind: Field['kind']): string {
  if (kind === 'badge' && typeof raw === 'string') return VALUE_WORDS[raw] ?? raw
  // 续读位置是分页偏移：0 就是从头读，其余只报数值，不猜单位（列表是条数、正文是字数）。
  // 上游偶尔把偏移写成字符串（`"0"`），也一并认。
  if (kind === 'offset') {
    const offset = typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN
    if (Number.isFinite(offset)) return offset === 0 ? '从头' : String(offset)
  }
  if (typeof raw === 'boolean') return raw ? '是' : '否'
  if (typeof raw === 'number') return String(raw)
  if (Array.isArray(raw)) return `${raw.length} 项`
  if (typeof raw === 'object' && raw) return `{${Object.keys(raw).slice(0, 5).join('、')}}`
  const text = String(raw)
  if (kind === 'resource') return renderResource(text)
  if (kind === 'path') return shortenPath(text)
  if (kind === 'code' || kind === 'text') {
    return text.length > MAX_INLINE ? `${text.slice(0, MAX_INLINE)}…（共 ${text.length} 字）` : text
  }
  return text
}

/** 路径只留尾部两段，前面用省略号——长路径会撑破抽屉。 */
export function shortenPath(path: string): string {
  const segments = path.split('/').filter(Boolean)
  return segments.length <= 2 ? path : `…/${segments.slice(-2).join('/')}`
}

/** 模型输出的正文：折叠多余空行，超长截断。 */
export function summarizeReply(text: string): string {
  const compact = text.replace(/\n{3,}/g, '\n\n').trim()
  return compact.length > 400 ? `${compact.slice(0, 400)}…` : compact
}
