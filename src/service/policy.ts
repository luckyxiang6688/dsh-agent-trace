/**
 * 读取策略快照，用于回答「闸门当时看到了什么」。
 *
 * 上游把每次保存都写成 `kv` 里的一行 `settings-version:<revision>`，
 * 决策行里存了当时的 `policyVersion`（哈希）。所以历史快照**查得到**：
 * 先按 policyVersion 精确匹配，匹配不到才退回最新一份并明确标注。
 *
 * 数据只从 adapter 拿（P2）：这里不再自己打开 sqlite。
 */
import type { RawSettingsSnapshot } from '../adapter/superagent/db.ts'

export interface PolicyView {
  /** 该来源允许的发送者 id 列表。 */
  sendersOf(source: string): readonly string[]
  /** 启用中的规则 id。 */
  enabledRules(): readonly string[]
  /** 这份策略的保存时间。 */
  savedAt?: string
  /** 上游的策略版本哈希。 */
  version?: string
  /** 上游的修订号。 */
  revision?: number
}

export interface PolicySnapshot extends PolicyView {
  /** 按版本哈希取当时的快照；取不到返回 undefined（不退回最新，避免冒充历史）。 */
  at(version: string | undefined): PolicyView | undefined
  /** 最新一份。 */
  latest(): PolicyView
}

export function readPolicy(
  store: { settingsSnapshots(): readonly RawSettingsSnapshot[] },
): PolicySnapshot | undefined {
  try {
    const versions = store.settingsSnapshots()
    const views = versions
      .filter(item => item.settings?.policy)
      .map(item => ({ raw: item, view: viewOf(item) }))
      .sort((left, right) => (right.raw.revision ?? 0) - (left.raw.revision ?? 0))
    if (views.length === 0) return undefined

    const latestView = views[0]!.view
    return {
      ...latestView,
      latest: () => latestView,
      at: (version: string | undefined) => {
        if (!version) return undefined
        return views.find(item => item.raw.policyVersion === version)?.view
      },
    }
  } catch {
    return undefined
  }
}

function viewOf(raw: RawSettingsSnapshot): PolicyView {
  const policy = raw.settings?.policy!
  return {
    sendersOf: (source: string) =>
      (policy.sources?.[source]?.allowed ?? [])
        .map(item => (typeof item.id === 'string' ? item.id : ''))
        .filter(Boolean),
    enabledRules: () => (policy.rules ?? []).filter(rule => rule.enabled).map(rule => String(rule.id ?? '')),
    ...(raw.savedAt ? { savedAt: raw.savedAt } : {}),
    ...(raw.policyVersion ? { version: raw.policyVersion } : {}),
    ...(typeof raw.revision === 'number' ? { revision: raw.revision } : {}),
  }
}
