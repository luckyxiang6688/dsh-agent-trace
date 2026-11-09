/**
 * 模型想法翻译：把英文推理翻成中文，供抽屉阅读。
 *
 * 三条约束：
 *   1. 只翻译**展示用**的短文本，不改动任何原始数据（P3）
 *   2. 失败就退回原文，绝不因为翻译失败让抽屉空着（P4）
 *   3. 结果按文本哈希缓存，同一段文字只翻一次（代价控制）
 */
export interface LlmLike {
  prepareCall?(config: { provider: string; model: string }): Promise<{
    stream(options: Record<string, unknown>): AsyncIterable<{ type?: string; text?: string }>
  }>
  listProviders?(): readonly { id?: string; name?: string }[]
}

export interface TranslateOptions {
  readonly provider: string
  readonly model: string
  /** 单次翻译的最大字符数，超过直接跳过（长文翻译又慢又贵）。 */
  readonly maxChars?: number
}

const cache = new Map<string, string>()
const CACHE_LIMIT = 300

const SYSTEM = '你是翻译。把用户给出的英文技术推理译为简洁中文，保留代码、命令与专有名词原文，不要解释，不要加任何前缀。'

/** 只查缓存，不产生任何模型调用。用于"再次打开直接用译文"。 */
export function peekTranslations(
  texts: readonly string[],
  options: TranslateOptions | undefined,
): (string | undefined)[] {
  if (!options) return texts.map(() => undefined)
  return texts.map(text => cache.get(`${options.provider}/${options.model}:${hash(text)}`))
}

/** 批量翻译；返回与输入等长的数组，翻不出来的位置放 undefined。 */
/** 超过这个字数的正文不送翻译：一次调用塞不下，结果也不可信。路由按它报 skipped。 */
export const TRANSLATE_MAX_CHARS = 1200

export async function translateAll(
  llm: LlmLike | undefined,
  texts: readonly string[],
  options: TranslateOptions | undefined,
): Promise<(string | undefined)[]> {
  if (!llm?.prepareCall || !options) return texts.map(() => undefined)
  const maxChars = options.maxChars ?? TRANSLATE_MAX_CHARS
  const out: (string | undefined)[] = []
  for (const text of texts) {
    if (!text || text.length > maxChars) { out.push(undefined); continue }
    const key = `${options.provider}/${options.model}:${hash(text)}`
    const hit = cache.get(key)
    if (hit) { out.push(hit); continue }
    const translated = await once(llm, text, options)
    if (translated) remember(key, translated)
    out.push(translated)
  }
  return out
}

async function once(llm: LlmLike, text: string, options: TranslateOptions): Promise<string | undefined> {
  try {
    const prepared = await llm.prepareCall!({ provider: options.provider, model: options.model }) as {
      config?: Record<string, unknown>
      stream(o: Record<string, unknown>): AsyncIterable<{ type?: string; text?: string }>
    }
    // 必须带上 resolve 后的 config，否则适配器会拒绝（配置在派发前后必须一致）
    const chunks = prepared.stream({
      ...(prepared.config ?? { provider: options.provider, model: options.model }),
      system: SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    })
    let out = ''
    for await (const chunk of chunks) {
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      const anyChunk = chunk as { delta?: { text?: string }; content?: string }
      if (!out && typeof anyChunk?.delta?.text === 'string') out += anyChunk.delta.text
      if (!out && typeof anyChunk?.content === 'string') out += anyChunk.content
    }
    const clean = out.trim()
    return clean.length > 0 ? clean : undefined
  } catch (error) {
    // 翻译是增强项：失败不是错误，但要在开发期留下原因
    return undefined
  }
}

function remember(key: string, value: string): void {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value as string)
  cache.set(key, value)
}

function hash(text: string): string {
  let value = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 16777619)
  }
  return (value >>> 0).toString(36)
}
