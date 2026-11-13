/**
 * dsh-superagent-trace — host 插件入口。
 *
 * M1 目标：把数据层接上并产出可验证的链路，不做任何 UI。
 * 约束（P4）：handler 纯、吞异常、只读基本类型；任何失败都不得影响宿主。
 */
import { appendFileSync } from 'node:fs'
import { openStore } from './adapter/superagent/db.ts'
import { createHealth, storeProbe } from './service/health.ts'
import { createReader } from './service/reader.ts'
import { registerRoutes } from './service/routes.ts'
import { peekTranslations, translateAll, type LlmLike } from './service/translate.ts'

/**
 * 诊断日志**默认不写**：只有显式设置 `DSH_AGENT_TRACE_LOG=<文件路径>` 才落盘。
 *
 * M4 安全清单要求「正文不写日志」，并且分发出去的插件不能把路径钉死在这台机器上
 * （旧实现写死了一个 `/Users/<开发机>/...` 的绝对路径，换台机器就会尝试往不存在的目录写）。
 * 日志只记事件与计数，不记原文/标题——要看正文请在界面上看。
 */
const LOG = typeof process.env.DSH_AGENT_TRACE_LOG === 'string' && process.env.DSH_AGENT_TRACE_LOG
  ? process.env.DSH_AGENT_TRACE_LOG
  : undefined
const say = (line: string): void => {
  if (!LOG) return
  try { appendFileSync(LOG, `${new Date().toISOString()} ${line}\n`) } catch { /* 不影响宿主 */ }
}

export const name = 'dsh-superagent-trace'
export const inject = ['orchestrator', 'sessionQuery', 'webServer', 'llm']

export type StateDirOrigin = 'config' | 'orchestrator' | 'none'

/**
 * 解析要读哪个 stateDir。
 *
 * 顺序：显式配置 → orchestrator 自己的 `machine.stateDir` → 都没有。
 *
 * 第二档不是兜底，是**正确缺省**：本插件读的 `orchestrator.sqlite` 就住在
 * superagent 的 stateDir 里，所以 superagent 配在哪，我们就该读哪。
 * 有了这一档，bundle 自动挂载的用户不用配任何东西也能工作——
 * bundle 内的 patch 不能写死绝对路径，这正是之前会静默退出的根因。
 */
export function resolveStateDir(
  config: { stateDir?: unknown } | undefined,
  orchestrator: unknown,
): { stateDir: string; origin: StateDirOrigin } {
  const configured = typeof config?.stateDir === 'string' ? config.stateDir.trim() : ''
  if (configured) return { stateDir: configured, origin: 'config' }
  // 结构化读取上游字段（P2：适配器隔离），只认形状，不 import 上游类型。
  const machine = (orchestrator as { machine?: { stateDir?: unknown } } | undefined)?.machine
  // 继承值**不 trim**：上游用 `join(machine.stateDir, 'orchestrator.sqlite')` 拼路径，
  // 我们若 trim 掉尾随空格就会指向另一个目录。而 readOnly 打开失败只会表现为「没有数据」，
  // 不会报错——「读错目录」比「读不到」更危险。trim 在这里只用来判空。
  const inherited = typeof machine?.stateDir === 'string' ? machine.stateDir : ''
  if (inherited.trim()) return { stateDir: inherited, origin: 'orchestrator' }
  return { stateDir: '', origin: 'none' }
}

export function apply(
  ctx: { orchestrator?: unknown; sessionQuery?: unknown; webServer?: never; llm?: unknown },
  config?: { stateDir?: string; translate?: { provider?: string; model?: string } },
): void {
  say('APPLY: plugin loaded')
  const resolved = resolveStateDir(config, ctx.orchestrator)
  const stateDir = resolved.stateDir
  say(`CONFIG: stateDir=${stateDir || '(未配置)'} origin=${resolved.origin}`)

  const translateConfig = config?.translate?.provider && config.translate.model
    ? { provider: config.translate.provider, model: config.translate.model }
    : undefined
  say(`TRANSLATE: ${translateConfig ? `${translateConfig.provider}/${translateConfig.model}` : '未配置'}`)

  // 来源标题与「装没装」只有宿主注册表知道（DB 里的 source 只是 id）。
  // 拿不到就返回空数组：来源列表退回库/设置并集，不编造安装状态。
  const sourceDirectory = (): { source: string; label?: string; installed?: boolean; enabled?: boolean }[] => {
    try {
      const sources = (ctx.orchestrator as {
        sources?: { instances?: () => unknown; kind?: (id: string) => unknown }
      } | undefined)?.sources
      if (!sources?.instances) return []
      const instances = sources.instances()
      if (!Array.isArray(instances)) return []
      return instances.flatMap((instance: unknown) => {
        const item = instance as { id?: unknown; enabled?: unknown; installed?: unknown }
        if (typeof item?.id !== 'string') return []
        const kind = sources.kind?.(item.id) as { title?: { zh?: unknown } } | undefined
        const label = typeof kind?.title?.zh === 'string' ? kind.title.zh : undefined
        return [{
          source: item.id,
          ...(label ? { label } : {}),
          ...(typeof item.installed === 'boolean' ? { installed: item.installed } : {}),
          ...(typeof item.enabled === 'boolean' ? { enabled: item.enabled } : {}),
        }]
      })
    } catch {
      return []
    }
  }

  // 未配置时仍要注册路由：页面必须能说出「为什么是空的」，而不是给一个 404。
  const reader = stateDir
    ? createReader({
        stateDir,
        sessionQuery: ctx.sessionQuery as never,
        sourceDirectory,
        ...(translateConfig
          ? {
              translator: {
                translate: (texts: readonly string[]) => translateAll(ctx.llm as LlmLike, texts, translateConfig),
                peek: (texts: readonly string[]) => peekTranslations(texts, translateConfig),
              },
            }
          : {}),
      })
    : undefined

  // 健康探测只做一次最廉价的读：句柄能开、能查，就算存储可用。
  const health = createHealth(Date.now,
    stateDir ? storeProbe(() => openStore(stateDir)) : () => ({ ok: false, ms: 0, error: 'stateDir unset' }))

  try {
    if (ctx.webServer) {
      registerRoutes(ctx.webServer, reader, async texts =>
        translateConfig ? translateAll(ctx.llm as LlmLike, texts, translateConfig) : texts.map(() => undefined),
        health,
        {
          configured: Boolean(reader),
          stateDirOrigin: resolved.origin,
          ...(reader ? {} : {
            hint: '没有拿到 superagent 的 stateDir（orchestrator 没有暴露 machine.stateDir）。'
              + '若 superagent 用了自定义目录，在 profile 的 cordis.patch.yml 里给 dsh-superagent-trace 加 config.stateDir。',
          }),
        })
      say('ROUTES: /agent-trace/chains 已注册')
    } else say('ROUTES: webServer 不可用')
  } catch (error) {
    say(`ROUTES ERR: ${String(error)}`)
  }
  // 启动自检只在开了诊断日志时跑：默认状态下不做这些无谓的读取。
  if (LOG && reader) void (async () => {
    try {
      const summaries = await reader.listChains(3)
      say(`CHAINS: ${summaries.length} 条`)
      for (const summary of summaries) {
        // 不记标题：标题是上游内容，日志里只留 id 与计数。
        say(`  · ${summary.ticketId} ${summary.state} steps=${summary.stepCount}`)
      }
      const latest = summaries[0]
      if (!latest) return
      const chain = await reader.readChain(latest.ticketId)
      if (!chain) { say('CHAIN: undefined'); return }
      say(`CHAIN ${chain.ticketId} stage=${chain.stage} spans=${chain.spans.length}`)
      for (const span of chain.spans) {
        say(`  span ${span.role} ${span.label} ${span.startMs}→${span.endMs}ms ${span.badge ?? ''}`)
      }
      const dispositions = await reader.readDispositions(latest.ticketId)
      say(`DISPOSITIONS: ${dispositions.map(item => `${item.path}/${item.outcome}`).join(' ')}`)
    } catch (error) {
      say(`READ ERR: ${String(error)}`)
    }
  })()
}
