/** 时间窗换算：span 的相对秒 → 会话事件的绝对毫秒。纯函数，可单测。 */
export interface TimeWindow {
  readonly fromMs: number
  readonly toMs: number
}

/** 两端各留 2 秒容差，避免因时钟精度把边界事件漏掉。 */
const PADDING_MS = 2000

export function calculateWindow(startMs: number, endMs: number, baseMs: number): TimeWindow {
  const from = baseMs + Math.min(startMs, endMs) - PADDING_MS
  const to = baseMs + Math.max(startMs, endMs) + PADDING_MS
  return { fromMs: from, toMs: to }
}
