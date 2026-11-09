/**
 * 采集侧开销实测（M4 §6.2：单事件处理器 < 0.5ms，不阻塞事件循环）。
 *
 * 被测对象是 `probe/` 的采集处理器。拷到临时目录再 import：它会往同目录写日志，
 * 直接 import 会把仓库里的 probe.log 越写越大，测出来的是「写仓库所在卷」而不是处理器本身。
 *
 * 用法：
 *   node tests/perf/collector-bench.mjs            # 默认（不抓载荷，只记元数据）
 *   APM_PROBE_CAPTURE=1 node tests/perf/collector-bench.mjs   # 抓载荷（含 stringify）
 */
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(HERE, '..', '..', '..', 'probe', 'index.js')
const ROUNDS = 5000
const WARMUP = 500

const work = mkdtempSync(join(tmpdir(), 'apm-collector-bench-'))
const moduleFile = join(work, 'index.js')
copyFileSync(SOURCE, moduleFile)

const handlers = []
const ctx = { on: (_name, handler) => handlers.push(handler) }
const mod = await import(pathToFileURL(moduleFile).href)
mod.apply(ctx)
if (handlers.length !== 1) throw new Error(`期望挂 1 个处理器，实际 ${handlers.length}`)

// 三种事件轮换：工具调用（带参数）、assistant 消息（带正文）、step 标记（纯元数据）。
const events = [
  { type: 'tool/call', time: 1, data: { name: 'orchestrator_route', callId: 'c1', arguments: '{"ticket_id":"t-1","note":"再来一版"}' } },
  { type: 'tool/result', time: 2, data: { name: 'orchestrator_route', callId: 'c1', ok: true } },
  { type: 'assistant/message', time: 3, data: { text: '这段是对上周工作的一次较长总结，用来让序列化有真实体量。'.repeat(4), usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 800 } } },
  { type: 'step/start', time: 4, data: { turn: 1, step: 2 } },
]
const session = { id: 'worker-t-1' }

for (let i = 0; i < WARMUP; i += 1) handlers[0](session, events[i % events.length])

const samples = []
for (let i = 0; i < ROUNDS; i += 1) {
  const event = events[i % events.length]
  const start = process.hrtime.bigint()
  handlers[0](session, event)
  samples.push(Number(process.hrtime.bigint() - start) / 1e6)
}

samples.sort((a, b) => a - b)
const avg = samples.reduce((sum, value) => sum + value, 0) / samples.length
const p95 = samples[Math.floor(samples.length * 0.95)]
const bytes = readFileSync(join(work, 'probe.log')).length

console.log(`${process.env.APM_PROBE_CAPTURE === '1' ? '抓载荷' : '默认  '}：${ROUNDS} 个事件，平均 ${avg.toFixed(4)} ms，p95 ${p95.toFixed(4)} ms，日志 ${(bytes / 1024).toFixed(1)} KB`)
console.log(`COLLECTOR ${JSON.stringify({
  capture: process.env.APM_PROBE_CAPTURE === '1',
  rounds: ROUNDS,
  avgMs: Number(avg.toFixed(4)),
  p95Ms: Number(p95.toFixed(4)),
  budgetMs: 0.5,
  pass: avg < 0.5,
})}`)

rmSync(work, { recursive: true, force: true })
