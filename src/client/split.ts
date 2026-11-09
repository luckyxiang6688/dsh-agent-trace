/**
 * 左栏上下两区的分隔比例。
 *
 * 比例存的是「上区占左栏高度的百分比」，不是像素：换窗口大小、换机器都还对。
 * 存储里的坏值（NaN、越界、非数字）一律回落默认值，不抛——脏数据只影响一次布局。
 */
export const SPLIT_KEY = 'dsh-agent-trace:rail-split:v1'
export const DEFAULT_RATIO = 0.55
export const MIN_RATIO = 0.15
export const MAX_RATIO = 0.85

export function clampRatio(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_RATIO
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, value))
}

type Readable = { getItem(key: string): string | null }
type Writable = { setItem(key: string, value: string): void }

function storage(): Storage | undefined {
  try {
    return typeof localStorage === 'undefined' ? undefined : localStorage
  } catch {
    return undefined
  }
}

export function readStoredRatio(source: Readable | undefined = storage()): number {
  if (!source) return DEFAULT_RATIO
  try {
    const raw = source.getItem(SPLIT_KEY)
    if (raw === null || raw.trim() === '') return DEFAULT_RATIO
    const value = Number(raw)
    return Number.isFinite(value) ? clampRatio(value) : DEFAULT_RATIO
  } catch {
    return DEFAULT_RATIO
  }
}

export function writeStoredRatio(ratio: number, target: Writable | undefined = storage()): void {
  if (!target) return
  try {
    target.setItem(SPLIT_KEY, String(clampRatio(ratio)))
  } catch {
    /* 隐私模式/配额满：布局照旧，只是下次不记得 */
  }
}

/** 指针位置 → 比例。容器高度为 0（还没布局）时给默认值，别除零。 */
export function ratioFromPointer(clientY: number, top: number, height: number): number {
  if (!Number.isFinite(height) || height <= 0) return DEFAULT_RATIO
  return clampRatio((clientY - top) / height)
}

/** 分隔条的最小可用高度：容器太矮时不画分隔条（两区都滚不动，拖拽也没意义）。 */
export const MIN_SPLITTER_CONTAINER = 160

export function splitterUsable(height: number): boolean {
  return Number.isFinite(height) && height >= MIN_SPLITTER_CONTAINER
}
