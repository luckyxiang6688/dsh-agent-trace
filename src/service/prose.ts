/**
 * 正文的统一形状：预览 + 总字数 + 取全文的 id。
 *
 * 抽屉只回预览，点「展开原文」再按 id 取全文——不把几十 KB 的推理流水
 * 一次塞进响应。这里不做摘要，只做机械截断；摘要一律用模型自己写的字段。
 */
import { PROSE_PREVIEW_CHARS, type Prose } from '../domain/model.ts'

/** 全文暂存：构建详情时把每段正文写进来，`readText` 据此回取。 */
export type TextSink = Map<string, string>

/** 包一段正文；超过预览上限的只回前 N 字，同时把全文记进 sink。 */
export function proseOf(text: string, id: string, sink?: TextSink): Prose {
  sink?.set(id, text)
  return {
    text: text.length <= PROSE_PREVIEW_CHARS ? text : text.slice(0, PROSE_PREVIEW_CHARS),
    length: text.length,
    id,
  }
}

/**
 * 取首句，给「块首行」用。
 * 按中英文句末标点切；`. ` 后面必须跟空白或结尾才算句末，
 * 否则 `doc/weekly.md` 这种路径会被切断。没有标点就截到 `max` 字。
 */
export function firstSentence(text: string, max = 140): string {
  const compact = text.replace(/\s+/g, ' ').trim()
  if (!compact) return ''
  const match = /[。！？]|[.!?](?=\s|$)/.exec(compact)
  if (match && match.index + 1 <= max) return compact.slice(0, match.index + 1)
  if (compact.length <= max) return compact
  return `${compact.slice(0, max)}…`
}
