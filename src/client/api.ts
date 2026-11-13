/**
 * 客户端唯一的 HTTP 入口：所有请求都从这里出。
 *
 * 约定：失败返回 `undefined`（或空数组），**不抛**——调用方只根据有没有值
 * 决定画空态还是错误提示，渲染阶段永远不会被 reject 打断。
 */
import type { Chain, ChainSummary, Disposition, LinkDetail, SpanDetail } from '../domain/model.ts'
import type { SourceEventDetail, SourceEventPage, SourceSummary } from '../domain/source.ts'

const PREFIX = '/agent-trace'

async function getJson<T>(path: string): Promise<T | undefined> {
  try {
    const response = await fetch(`${PREFIX}${path}`, { headers: { accept: 'application/json' } })
    if (!response.ok) return undefined
    return (await response.json()) as T
  } catch {
    return undefined
  }
}

/** 插件当前的运行前提。未配置时它是页面唯一能说出原因的地方。 */
export interface RuntimeStatus {
  configured: boolean
  stateDirOrigin: 'config' | 'orchestrator' | 'none'
  hint?: string
}

export async function fetchStatus(): Promise<RuntimeStatus | undefined> {
  return getJson<RuntimeStatus>('/status')
}

export async function fetchSources(): Promise<readonly SourceSummary[] | undefined> {
  const data = await getJson<{ items?: SourceSummary[] }>('/sources')
  return Array.isArray(data?.items) ? data.items : undefined
}

export async function fetchSourceEvents(
  source: string,
  limit: number,
  cursor?: string,
): Promise<SourceEventPage | undefined> {
  const query = new URLSearchParams({ limit: String(limit) })
  if (cursor) query.set('cursor', cursor)
  return getJson<SourceEventPage>(`/sources/${encodeURIComponent(source)}/events?${query.toString()}`)
}

export async function fetchSourceEvent(
  source: string,
  triggerId: string,
): Promise<SourceEventDetail | undefined> {
  const data = await getJson<{ detail?: SourceEventDetail }>(
    `/sources/${encodeURIComponent(source)}/events/${encodeURIComponent(triggerId)}`)
  return data?.detail
}

export async function fetchSourceEventText(source: string, triggerId: string): Promise<string | undefined> {
  const data = await getJson<{ text?: string }>(
    `/sources/${encodeURIComponent(source)}/events/${encodeURIComponent(triggerId)}/text`)
  return typeof data?.text === 'string' ? data.text : undefined
}

export async function fetchChains(limit: number, source?: string): Promise<readonly ChainSummary[] | undefined> {
  const query = source ? `limit=${limit}&source=${encodeURIComponent(source)}` : `limit=${limit}`
  const data = await getJson<{ items?: ChainSummary[] }>(`/chains?${query}`)
  return Array.isArray(data?.items) ? data.items : undefined
}

export async function fetchChain(
  ticketId: string,
): Promise<{ chain: Chain; dispositions: readonly Disposition[] } | undefined> {
  const data = await getJson<{ chain?: Chain; dispositions?: Disposition[] }>(
    `/chains/${encodeURIComponent(ticketId)}`)
  if (!data?.chain) return undefined
  return { chain: data.chain, dispositions: data.dispositions ?? [] }
}

export async function fetchSpanDetail(ticketId: string, spanId: string): Promise<SpanDetail | undefined> {
  const data = await getJson<{ detail?: SpanDetail }>(
    `/spans/${encodeURIComponent(ticketId)}/${encodeURIComponent(spanId)}`)
  return data?.detail
}

export async function fetchLink(ticketId: string, linkId: string): Promise<LinkDetail | undefined> {
  const data = await getJson<{ link?: LinkDetail }>(
    `/links/${encodeURIComponent(ticketId)}/${encodeURIComponent(linkId)}`)
  return data?.link
}

export async function fetchText(ticketId: string, textId: string): Promise<string | undefined> {
  const data = await getJson<{ text?: string }>(
    `/texts/${encodeURIComponent(ticketId)}/${encodeURIComponent(textId)}`)
  return typeof data?.text === 'string' ? data.text : undefined
}

/** 翻译由用户主动触发；失败返回 undefined，调用方保留原文即可。 */
export async function translateTexts(
  texts: readonly string[],
): Promise<{ items?: (string | undefined)[]; skipped?: number[] } | undefined> {
  try {
    const response = await fetch(`${PREFIX}/translate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ texts }),
    })
    if (!response.ok) return undefined
    return (await response.json()) as { items?: (string | undefined)[]; skipped?: number[] }
  } catch {
    return undefined
  }
}
