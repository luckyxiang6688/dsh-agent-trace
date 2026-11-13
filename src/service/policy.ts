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
  /**
   * 该来源允许的发送者 id 列表。
   *
   * 行里没写这个字段 → `[]`（没配名单就是谁都不准入）；
   * 写了但形状坏了（不是数组）→ `undefined`（读不出，**不是**空名单）。
   */
  sendersOf(source: string): readonly string[] | undefined
  /**
   * 这个 id 是否在该来源的名单里。
   *
   * 比较口径与上游**一致**：忽略大小写（上游 `sameName` 是 `toLowerCase()` 比较）。
   * 用 `includes` 精确比较会把上游放行的人说成「不在名单内」，和裁定的 accept 自相矛盾。
   * 名单读不出时返回 `false`——调用方应先看 `sendersOf` 是不是 `undefined`，别把 false 说成「不在名单内」。
   */
  allows(source: string, id: string): boolean
  /** 启用中的规则 id；行里没写 → `[]`，形状坏了 → `undefined`。 */
  enabledRules(): readonly string[] | undefined
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
        if (typeof version !== 'string' || !version) return undefined
        // 同一份策略内容可能被保存过多次（revision 不同、`policyVersion` 相同）。
        // 取**最早**那一次：那才是这份内容开始生效的时刻；取最新会把「之后的保存时间」说成「当时的」。
        // views 按 revision 降序，所以循环结束后留下的是最早的一条。
        let found: PolicyView | undefined
        for (const item of views) if (item.raw.policyVersion === version) found = item.view
        return found
      },
    }
  } catch {
    return undefined
  }
}

/**
 * 形状守卫：快照行是历史数据，迁移代码会把解析失败的行原样保留，
 * 所以 `allowed` 可能不是数组、`rules` 可能含 null。读的时候一律只认形状，
 * 不抛——抛出去就成了路由 500（失败隔离是硬约束）。
 */
function sendersOfView(policy: NonNullable<NonNullable<RawSettingsSnapshot['settings']>['policy']>, source: string): string[] | undefined {
  const allowed: unknown = policy.sources?.[source]?.allowed
  // 没写 → 空名单（谁都不准入）；写了但不是数组 → 读不出，别冒充空。
  if (allowed === undefined || allowed === null) return []
  if (!Array.isArray(allowed)) return undefined
  return allowed.flatMap(item => {
    const id = (item as { id?: unknown } | null | undefined)?.id
    return typeof id === 'string' && id ? [id] : []
  })
}

function enabledRulesOfView(policy: NonNullable<NonNullable<RawSettingsSnapshot['settings']>['policy']>): string[] | undefined {
  const rules: unknown = policy.rules
  if (rules === undefined || rules === null) return []
  if (!Array.isArray(rules)) return undefined
  return rules.flatMap(rule => {
    const item = rule as { id?: unknown; enabled?: unknown } | null | undefined
    if (!item || item.enabled !== true || item.id === undefined || item.id === null) return []
    return [String(item.id)]
  })
}

function viewOf(raw: RawSettingsSnapshot): PolicyView {
  const policy = raw.settings?.policy!
  return {
    sendersOf: (source: string) => sendersOfView(policy, source),
    allows: (source: string, id: string) =>
      (sendersOfView(policy, source) ?? []).some(allowed => allowed.toLowerCase() === id.toLowerCase()),
    enabledRules: () => enabledRulesOfView(policy),
    ...(raw.savedAt ? { savedAt: raw.savedAt } : {}),
    ...(raw.policyVersion ? { version: raw.policyVersion } : {}),
    ...(typeof raw.revision === 'number' ? { revision: raw.revision } : {}),
  }
}
