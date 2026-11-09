/**
 * 子代理与会话发现：直接读会话目录里的 header。
 *
 * 实测结构（2026-11-07）：`<sessions>/<workspace>/<sessionId>/session.v4.jsonl.zstd`，
 * 首行是会话 header，含 `parentSession` / `origin` / `delegationDepth`。
 * 这是官方字段，不依赖命名约定，也不需要 `subagent/descriptor` 事件。
 *
 * 识别子代理必须看 `origin === 'subagent'`：只看 `parentSession` 会把 fork 误判成子代理
 * （`subagent/child-agent.ts:135-152`、`core/session/src/types.ts:110-128`）。
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { decodeFirstFrame, decodeSessionText } from './zstd.ts'

export interface ChildSession {
  readonly id: string
  readonly createdAt: number
  readonly depth: number
}

interface Header {
  type?: string
  id?: string
  createdAt?: number
  parentSession?: string
  origin?: string
  delegationDepth?: number
  /** 会话创建时选的 DSH agent preset；上游用这个名字决定运行方，不是模型。 */
  agentPreset?: string
}

/** 一个会话的 header 里对「谁在跑」有用的部分：只有 preset（模型不在 header 里）。 */
export interface SessionHeaderInfo {
  readonly id: string
  /**
   * 会话**创建时**选的 preset。header 是追加型日志的首帧，重选 preset 不会改写它；
   * 上游路由时会以会话投影为准、header 只兜底，所以这里报的是「建会话时的运行方」。
   */
  readonly agentPreset?: string
}

/** 按会话 id 读它的 header（只解第一帧，成本与子代理发现同级）。 */
export function readSessionHeader(sessionsRoot: string, sessionId: string): SessionHeaderInfo | undefined {
  const file = sessionFileOf(sessionsRoot, sessionId)
  if (!file) return undefined
  const header = readHeader(file)
  if (!header || typeof header.id !== 'string') return undefined
  return {
    id: header.id,
    ...(typeof header.agentPreset === 'string' ? { agentPreset: header.agentPreset } : {}),
  }
}

/** 扫描 sessions 根目录，返回父会话等于 `parentId` 的子代理会话。失败返回空数组。 */
export function findChildSessions(sessionsRoot: string, parentId: string): readonly ChildSession[] {
  const found: ChildSession[] = []
  for (const descriptor of sessionFiles(sessionsRoot)) {
    const header = readHeader(descriptor.file)
    if (header?.parentSession !== parentId || typeof header.id !== 'string') continue
    // 有 origin 就必须是 subagent；没有该字段的旧会话按血缘接受（header 里没有别的证据可判）。
    if (header.origin !== undefined && header.origin !== 'subagent') continue
    found.push({
      id: header.id,
      createdAt: typeof header.createdAt === 'number' ? header.createdAt : 0,
      depth: typeof header.delegationDepth === 'number' ? header.delegationDepth : 1,
    })
  }
  return found
}

/** 读出整个会话文件的事件行（含 data），用于取工具调用的精确时间。 */
export function readSessionEvents(file: string): readonly { type?: string; time?: number; data?: Record<string, unknown> }[] {
  const out: { type?: string; time?: number; data?: Record<string, unknown> }[] = []
  for (const line of decodeSessionText(file).split('\n')) {
    if (!line) continue
    try {
      const parsed = JSON.parse(line) as { type?: string; time?: number; data?: Record<string, unknown> }
      if (parsed.type !== 'session') out.push(parsed)
    } catch { /* 跳过坏行 */ }
  }
  return out
}

/** 找到某个会话目录里的日志文件；找不到返回 undefined。 */
export function sessionFileOf(sessionsRoot: string, sessionId: string): string | undefined {
  return sessionFiles(sessionsRoot).find(descriptor => descriptor.id === sessionId)?.file
}

/** 列出所有会话日志，带上 header 里读得到的元信息。 */
function sessionFiles(sessionsRoot: string): readonly { id: string; file: string }[] {
  const files: { id: string; file: string }[] = []
  let workspaces: string[] = []
  try {
    workspaces = readdirSync(sessionsRoot, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return files
  }
  for (const workspace of workspaces) {
    let sessions: string[] = []
    try {
      sessions = readdirSync(join(sessionsRoot, workspace), { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
    } catch { continue }
    for (const sessionId of sessions) {
      files.push({ id: sessionId, file: join(sessionsRoot, workspace, sessionId, 'session.v4.jsonl.zstd') })
    }
  }
  return files
}

export interface RouterLookup {
  /** 判定时刻；用它排除之后才创建的会话。 */
  readonly atMs?: number
  /** 这批事件里出现的 trigger id；在主控会话的 `orchestrator_*` 工具入参里能找到。 */
  readonly triggerIds?: readonly string[]
  /**
   * 要求必须命中 trigger id 才返回。给「署名」用：扫的是所有 workspace 的会话目录，
   * 没命中还退到最新一个，可能把别的 workspace 的主控会话当成这张工单的评估者。
   */
  readonly requireMention?: boolean
}

/**
 * 主控会话：优先用 kv 的 `master-id`（上游自己记的指针，`src/kv.ts:33`）。
 * 没有指针时退回到 `orchestrator-*` 会话里按 trigger id 找；再找不到才取最新一个。
 */
export function findRouterSessionId(
  sessionsRoot: string,
  lookup: RouterLookup = {},
): string | undefined {
  const candidates = routerSessions(sessionsRoot)
  if (candidates.length === 0) return undefined

  const ids = lookup.triggerIds ?? []
  if (ids.length > 0) {
    const bounded = lookup.atMs === undefined
      ? candidates
      : candidates.filter(item => item.createdAt <= lookup.atMs! + 1000)
    // 新会话更可能是这一次的；逐个读到命中为止，限制次数避免扫描所有历史。
    for (const candidate of (bounded.length > 0 ? bounded : candidates).slice(0, 5)) {
      if (mentionsAny(readSessionEvents(candidate.file), ids)) return candidate.id
    }
    // 署名场景：没命中就不猜，宁可写「未记录」。
    if (lookup.requireMention) return undefined
  } else if (lookup.requireMention) {
    return undefined
  }

  const before = lookup.atMs === undefined
    ? candidates
    : candidates.filter(item => item.createdAt <= lookup.atMs! + 1000)
  return (before[0] ?? candidates[0])!.id
}

/** 主控会话们，按创建时间从新到旧。 */
function routerSessions(sessionsRoot: string): readonly { id: string; file: string; createdAt: number }[] {
  const found: { id: string; file: string; createdAt: number }[] = []
  for (const descriptor of sessionFiles(sessionsRoot)) {
    if (!descriptor.id.startsWith('orchestrator-')) continue
    const header = readHeader(descriptor.file)
    const createdAt = typeof header?.createdAt === 'number' ? header.createdAt : 0
    found.push({ id: descriptor.id, file: descriptor.file, createdAt })
  }
  return found.sort((left, right) => right.createdAt - left.createdAt)
}

/** 工具入参里是否出现这批 trigger id；出现在别的会话说明不是它的评估。 */
function mentionsAny(
  events: readonly { type?: string; data?: Record<string, unknown> }[],
  triggerIds: readonly string[],
): boolean {
  return events.some(event => {
    if (event.type !== 'tool/call') return false
    const raw = event.data?.['arguments']
    if (typeof raw !== 'string') return false
    return triggerIds.some(id => raw.includes(id))
  })
}

/** 只解压够读首行的一段；文件损坏就当没有。 */
function readHeader(file: string): Header | undefined {
  try {
    const firstLine = decodeFirstFrame(file).split('\n', 1)[0]
    if (!firstLine) return undefined
    const parsed = JSON.parse(firstLine) as Header
    return parsed.type === 'session' ? parsed : undefined
  } catch {
    return undefined
  }
}
