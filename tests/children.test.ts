import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import { findChildSessions, findRouterSessionId, readSessionEvents, sessionFileOf } from '../src/adapter/session/children.ts'

/** 按真实格式落一个会话文件：header 与每条事件各占一帧。 */
function writeSession(
  root: string,
  workspace: string,
  id: string,
  header: Record<string, unknown>,
  events: readonly Record<string, unknown>[] = [],
): void {
  const dir = join(root, workspace, id)
  mkdirSync(dir, { recursive: true })
  const frames = [
    JSON.stringify({ type: 'session', id, ...header }),
    ...events.map(event => JSON.stringify(event)),
  ].map(line => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))
}

const workspace = 'ws'

test('只认 origin=subagent 的子会话，fork 不算子代理', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
  writeSession(root, workspace, 'child-1', { parentSession: 'parent', origin: 'subagent', delegationDepth: 1, createdAt: 100 })
  writeSession(root, workspace, 'fork-1', { parentSession: 'parent', origin: 'fork', delegationDepth: 1, createdAt: 200 })
  writeSession(root, workspace, 'legacy-1', { parentSession: 'parent', delegationDepth: 1, createdAt: 300 })
  writeSession(root, workspace, 'other-1', { parentSession: 'someone-else', origin: 'subagent', createdAt: 400 })

  const found = findChildSessions(root, 'parent')
  assert.deepEqual(found.map(item => item.id).sort(), ['child-1', 'legacy-1'])
})

test('事件分布在多个帧里也要全部读到', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
  writeSession(root, workspace, 'child-1', { parentSession: 'parent', origin: 'subagent' }, [
    { type: 'assistant/message', time: 1000, data: { text: '想' } },
    { type: 'tool/call', time: 2000, data: { name: 'bash' } },
  ])
  const events = readSessionEvents(sessionFileOf(root, 'child-1')!)
  assert.deepEqual(events.map(event => event.type), ['assistant/message', 'tool/call'])
})

test('上游给的会话 id 只当键比对，不拼进路径：`../` 之类查不到就是 undefined', () => {
  // 安全清单（M4）：任何来自上游的路径都只用于展示，不参与文件访问。
  // `sessionFileOf` 的做法是先扫目录再按 id 等值匹配——上游 id 永远不会成为路径的一部分。
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
  writeSession(root, workspace, 'child-1', { parentSession: 'parent', origin: 'subagent' })

  assert.equal(sessionFileOf(root, '../../etc/passwd'), undefined)
  assert.equal(sessionFileOf(root, 'child-1/../../child-1'), undefined)
  // 正常 id 拿到的文件仍落在会话根目录里
  assert.ok(sessionFileOf(root, 'child-1')!.startsWith(root))
})

test('主控会话按 trigger id 定位，不取全局最新', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sessions-'))
  writeSession(root, workspace, 'orchestrator-old', { createdAt: 1000 }, [
    { type: 'tool/call', data: { name: 'orchestrator_eval', arguments: '{"trigger_id":"t2"}' } },
  ])
  writeSession(root, workspace, 'orchestrator-new', { createdAt: 5000 }, [
    { type: 'tool/call', data: { name: 'orchestrator_reply', arguments: '{"ticket_id":"other"}' } },
  ])

  assert.equal(findRouterSessionId(root, { triggerIds: ['t2'], atMs: 2000 }), 'orchestrator-old')
  // 没有命中时退回判定时刻之前最新创建的会话，而不是未来才创建的那个
  assert.equal(findRouterSessionId(root, { triggerIds: ['t404'], atMs: 2000 }), 'orchestrator-old')
  // 署名场景：没命中就不猜（会话目录跨 workspace，顶替会署错名）；没有 trigger 可查也不猜
  assert.equal(findRouterSessionId(root, { triggerIds: ['t404'], atMs: 2000, requireMention: true }), undefined)
  assert.equal(findRouterSessionId(root, { atMs: 2000, requireMention: true }), undefined)
})
