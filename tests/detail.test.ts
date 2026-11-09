import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readSpanDetail } from '../src/service/detail.ts'
import type { Chain } from '../src/domain/model.ts'

const base = '2026-01-01T00:00:00Z'

const chain = (spans: Chain['spans'], inputs?: Chain['inputs']): Chain => ({
  ticketId: 't1', title: '示例', stage: '进行中', createdAt: base, spans,
  ...(inputs ? { inputs } : {}),
})

/** 只声明用到的方法：readSession 返回事件列表。 */
const reader = (events: readonly Record<string, unknown>[]) => ({
  readSession: async () => ({ events }),
})

const executorSpan = { id: 'assignment-a1', role: 'executor' as const, kind: 'activity' as const, label: '派工 #1', startMs: 0, endMs: 10_000 }

test('执行器「它收到的」来自工单输入，仅上下文的要标注不授权', async () => {
  const detail = (await readSpanDetail(
    reader([]),
    'worker-t1',
    chain([executorSpan], [
      { kind: 'trigger', text: '把这个做完', human: true, at: '2026-01-01T00:00:01Z' },
      { kind: 'trigger', text: '顺便看看这个', human: true, context: true, at: '2026-01-01T00:00:02Z' },
    ]),
    'assignment-a1',
  ))!
  // 正文是 Prose：预览 + 总字数 + 取全文的 id
  assert.deepEqual(detail.received.map(prose => prose.text), ['把这个做完', '（仅上下文，不授权）顺便看看这个'])
  assert.equal(detail.received[0]!.id, 'span/assignment-a1/received/0')
  assert.equal(detail.received[0]!.length, '把这个做完'.length)
})

test('工具调用只出一行结果：成功报体量，失败报原因', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'assistant/message', time: Date.parse(base) + 100, data: { text: '先看目录' } },
      { type: 'tool/call', time: Date.parse(base) + 200, data: { step: 0, name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', time: Date.parse(base) + 300, data: { error: 'exit 1', message: { content: [{ type: 'text', text: 'permission denied' }] } } },
      { type: 'tool/call', time: Date.parse(base) + 400, data: { step: 1, name: 'read', arguments: '{"path":"a.txt"}' } },
      { type: 'tool/result', time: Date.parse(base) + 500, data: { message: { content: [{ type: 'text', text: '文件内容' }] } } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
  ))!
  const steps = detail.steps ?? []
  assert.equal(steps.length, 2)

  const failed = steps[0]!.actions[0]!
  assert.equal(failed.tool, 'bash')
  assert.equal(failed.failed, true)
  assert.equal(failed.result?.status, 'error')
  assert.equal(failed.result?.summary, '失败 · 0.1s · exit 1')
  // 结果不再是「字段」：参数里不该再混进返回正文
  assert.ok(failed.fields.every(field => field.label !== '返回' && field.label !== '错误'))

  const ok = steps[1]!.actions[0]!
  assert.equal(ok.failed, undefined)
  assert.equal(ok.result?.status, 'ok')
  // 短返回不报字数（报出来也只是噪音），但也不展示正文
  assert.equal(ok.result?.summary, '成功 · 0.1s')
  assert.equal(ok.result?.detail, undefined)
})

test('成功的工具返回正文不进抽屉、也不进缓存', async () => {
  const sink = new Map<string, string>()
  const sentinel = 'ticket-sentinel-success'
  const body = `${sentinel}\n${'x'.repeat(900)}`
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: { message: { content: [{ type: 'text', text: body }] } } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
    undefined,
    undefined,
    sink,
  ))!
  assert.ok(detail.steps![0]!.actions[0]!.result?.summary.includes(`${body.length} 字`), '成功只报体量')
  assert.ok(!JSON.stringify(detail).includes(sentinel), '返回正文不得出现在抽屉响应里')
  assert.equal(sink.size, 0, '成功返回不写全文缓存')
})

test('失败只有长 error.reason、正文为空时，原因仍可展开并按 id 取回', async () => {
  const sink = new Map<string, string>()
  // 真实 schema 常见形态：reason 很长，message.content 是空数组。
  const reason = `EACCES: permission denied, open /var/log/app.log（${'权限检查'.repeat(60)}）`
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'write', arguments: '{"path":"doc/a.md"}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: {
        error: { name: 'ToolError', code: 'EACCES', reason },
        message: { isError: true, content: [] },
      } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
    undefined,
    undefined,
    sink,
  ))!
  const action = detail.steps![0]!.actions[0]!
  assert.equal(action.failed, true)
  assert.ok(action.result!.summary.startsWith('失败 · 0.1s · EACCES'))
  assert.ok(action.result!.detail, '超过 200 字的原因要能展开')
  const full = sink.get(action.result!.detail!.id)!
  assert.ok(full.includes(reason), '展开的是完整原因，不是 80 字摘要')
  assert.equal(action.result!.detail!.length, full.length)
})

test('真实 schema 的 error 是对象：取可读原因，不序列化整个对象', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'write', arguments: '{"path":"doc/a.md"}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: {
        error: { name: 'ToolError', code: 'EACCES', reason: 'disk full' },
        message: { isError: true, content: [{ type: 'text', text: 'write failed' }] },
      } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
  ))!
  const action = detail.steps![0]!.actions[0]!
  assert.equal(action.failed, true)
  assert.equal(action.result?.status, 'error')
  assert.ok(action.result!.summary.startsWith('失败 · 0.1s · disk full'), action.result!.summary)
  assert.ok(!action.result!.summary.includes('{'), '不把 JSON 原样塞进摘要')
})

test('按 callId 配对返回：并行调用的结果不会挂错动作', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, callId: 'c1', name: 'read', arguments: '{"path":"a"}' } },
      { type: 'tool/call', time: Date.parse(base) + 110, data: { step: 0, callId: 'c2', name: 'write', arguments: '{"path":"b"}' } },
      // 返回顺序与调用顺序相反：按 id 配才不会挂反
      { type: 'tool/result', time: Date.parse(base) + 300, data: { message: { toolCallId: 'c2', isError: true, content: [] } } },
      { type: 'tool/result', time: Date.parse(base) + 310, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] } } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
  ))!
  const [read, write] = detail.steps![0]!.actions
  assert.equal(read!.tool, 'read')
  assert.equal(read!.failed, undefined)
  assert.equal(read!.result?.status, 'ok')
  assert.equal(write!.tool, 'write')
  assert.equal(write!.failed, true)
})

test('同一次调用多次返回合并成一行；没有返回就不编结果行', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, callId: 'c1', name: 'bash', arguments: '{"command":"cat a"}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'aaaa' }] } } },
      { type: 'tool/result', time: Date.parse(base) + 300, data: { message: { toolCallId: 'c1', content: [{ type: 'text', text: 'bb' }] } } },
      // 第二次调用没有返回（可能被时间窗截断）：不能写成「成功 · 无返回」
      { type: 'tool/call', time: Date.parse(base) + 400, data: { step: 1, callId: 'c2', name: 'read', arguments: '{"path":"a"}' } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
  ))!
  const merged = detail.steps![0]!.actions[0]!
  assert.equal(merged.result?.summary, '成功 · 0.2s · 2 条')
  const missing = detail.steps![1]!.actions[0]!
  assert.equal(missing.result, undefined, '没有返回就没有结果行')
  assert.equal(missing.failed, undefined)
})

test('成功的空返回才写「无返回」（这是已知的结果，不是推测）', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'bash', arguments: '{"command":"true"}' } },
      { type: 'tool/result', time: Date.parse(base) + 150, data: { message: { content: [] } } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
  ))!
  assert.equal(detail.steps![0]!.actions[0]!.result?.summary, '成功 · <0.1s · 无返回')
})

test('离散事件走领域数据，不去读会话日志', async () => {
  const detail = (await readSpanDetail(
    reader([]),
    'worker-t1',
    chain([{ id: 'event-ended', role: 'executor', kind: 'event', label: '工单结束', startMs: 1000, endMs: 1000 }]),
    'event-ended',
    undefined,
    {
      factsFor: () => [],
      eventFacts: (ticketId, spanId) => spanId === 'event-ended'
        ? {
            title: '工单结束',
            facts: [
              { label: '去向', value: 'completed', group: 'decision', tone: 'ok' },
              { label: '由谁结束', value: 'orchestrator', group: 'meta' },
            ],
          }
        : undefined,
    },
  ))!
  assert.equal(detail.title, '工单结束')
  assert.deepEqual(detail.facts?.map(row => row.label), ['去向', '由谁结束'])
  assert.deepEqual(detail.received, [])
  assert.deepEqual(detail.actions, [])
})

test('离散事件取不到素材时不留空白：抽屉由客户端给统一说明', async () => {
  const detail = (await readSpanDetail(
    reader([]),
    'worker-t1',
    chain([{ id: 'event-unknown', role: 'executor', kind: 'event', label: '未知事件', startMs: 0, endMs: 0 }]),
    'event-unknown',
  ))!
  assert.equal(detail.title, '未知事件')
  assert.equal(detail.facts, undefined)
  assert.equal(detail.note, undefined)
  assert.equal(detail.received.length + detail.thoughts.length + detail.actions.length, 0)
})

test('首行只取模型/系统自己写的字段：系统任务陈述优先', async () => {
  const detail = (await readSpanDetail(
    reader([]),
    'worker-t1',
    chain([{ id: 'decision-d1', role: 'router', kind: 'activity', label: '评估', startMs: 0, endMs: 0 }]),
    'decision-d1',
    undefined,
    {
      factsFor: () => [],
      leadFor: (ticketId, spanId) => spanId === 'decision-d1'
        ? { text: '整理本周周报并写入 doc/weekly.md', source: 'system' }
        : undefined,
    },
  ))
  assert.equal(detail?.lead, '整理本周周报并写入 doc/weekly.md')
  assert.equal(detail?.leadSource, 'system')
})

test('派工块首行取报告摘要首句，不改写', async () => {
  const detail = await readSpanDetail(
    reader([]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
    undefined,
    {
      factsFor: () => [],
      leadFor: () => ({
        text: '完成：整理本周周报并写入 doc/weekly.md。\n\n产出\n- doc/weekly.md',
        source: 'model',
      }),
    },
  )
  assert.equal(detail?.lead, '完成：整理本周周报并写入 doc/weekly.md。')
  assert.equal(detail?.leadSource, 'model')
})

test('没有报告摘要时退到它给工具写的说明，仍算模型自述', async () => {
  const detail = await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 200, data: { step: 0, name: 'bash', arguments: '{"command":"ls","description":"先看目录结构"}' } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
  )
  assert.equal(detail?.lead, '先看目录结构')
  assert.equal(detail?.leadSource, 'model')
})

test('子代理首行取末条输出首句', async () => {
  const detail = await readSpanDetail(
    reader([
      { type: 'assistant/message', time: Date.parse(base) + 100, data: { text: '共享盘里有 3 份数据。第二句不该出现。' } },
    ]),
    'worker-t1',
    chain([{ id: 'subagent-child', role: 'subagent', kind: 'activity', label: '子代理 #1', startMs: 0, endMs: 1000 }]),
    'subagent-child',
  )
  assert.equal(detail?.lead, '共享盘里有 3 份数据。')
})

test('长想法只回 200 字预览，整份抽屉不含原文', async () => {
  // 实测最长的一段推理流水：10,364 字
  const long = 'reason '.repeat(1482).slice(0, 10_364)
  const peeked: string[] = []
  const detail = (await readSpanDetail(
    reader([
      { type: 'assistant/message', time: Date.parse(base) + 100, data: { text: long } },
      { type: 'tool/call', time: Date.parse(base) + 200, data: { step: 0, name: 'bash', arguments: '{"command":"ls"}' } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
    {
      translate: async texts => texts.map(() => undefined),
      peek: texts => { peeked.push(...texts); return texts.map(() => undefined) },
    },
  ))!
  const thought = detail.steps?.[0]?.thoughts[0]
  assert.ok(thought)
  assert.equal(thought!.text.length, 200)
  assert.equal(thought!.length, 10_364)
  assert.equal(thought!.id, 'span/assignment-a1/steps/0/thoughts/0')
  assert.ok(JSON.stringify(detail).length < 2000, `抽屉响应应远小于原文，实际 ${JSON.stringify(detail).length}`)
  // 翻译缓存要拿全文去查：peek 收到的必须是 10,364 字原文，不能是 200 字预览
  assert.deepEqual(peeked, [long])
})

test('失败的完整正文仍可展开：原因拼在正文前，原文按 id 取', async () => {
  const sink = new Map<string, string>()
  const stack = `write failed: EACCES\n${'    at fs.writeFileSync (node:fs:1:1)\n'.repeat(20)}`
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'write', arguments: '{"path":"doc/a.md"}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: {
        error: { name: 'ToolError', code: 'EACCES', reason: 'disk full' },
        message: { isError: true, content: [{ type: 'text', text: stack }] },
      } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
    undefined,
    undefined,
    sink,
  ))!
  const result = detail.steps![0]!.actions[0]!.result!
  const body = sink.get('span/assignment-a1/steps/0/results/0')!
  // 展开后会替换摘要，所以原因必须拼进正文，否则「disk full」一展开就没了。
  assert.ok(body.startsWith('disk full · EACCES\n\n'), `正文开头：${body.slice(0, 30)}`)
  assert.ok(body.endsWith(stack))
  assert.equal(result.detail?.length, body.length)
  assert.equal(result.detail?.id, 'span/assignment-a1/steps/0/results/0')
  assert.ok(!JSON.stringify(detail).includes('fs.writeFileSync'), '堆栈不进抽屉响应')
})

test('译文按 Prose.id 缓存，不再按原文文本作键', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'assistant/message', time: Date.parse(base) + 100, data: { text: '先看目录' } },
      { type: 'tool/call', time: Date.parse(base) + 200, data: { step: 0, name: 'bash', arguments: '{"command":"ls"}' } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
    {
      translate: async texts => texts.map(() => undefined),
      peek: texts => texts.map(text => (text === '先看目录' ? '先看目录（译）' : undefined)),
    },
  ))!
  assert.deepEqual(detail.translations, { 'span/assignment-a1/steps/0/thoughts/0': '先看目录（译）' })
})

test('有分步时不再重复输出顶层 actions', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'bash', arguments: '{"command":"ls"}' } },
    ]),
    'worker-t1',
    chain([executorSpan]),
    'assignment-a1',
  ))!
  assert.deepEqual(detail.actions, [])
  assert.equal(detail.steps?.length, 1)
})

test('带了 id 却对不上任何在窗调用时，不把返回挂到别人头上', async () => {
  const sink = new Map<string, string>()
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, callId: 'c1', name: 'read', arguments: '{}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: {
        message: { toolCallId: 'c-outside-window', isError: true, content: [{ type: 'text', text: 'outside error' }] },
      } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1', undefined, undefined, sink,
  ))!
  const action = detail.steps![0]!.actions[0]!
  assert.equal(action.result, undefined, '不属于这次调用的返回不能挂上来')
  assert.equal(action.failed, undefined)
  assert.equal(sink.size, 0)
})

test('没有 id 的并行调用按先后配，不都挂到最后一次', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'read', arguments: '{}' } },
      { type: 'tool/call', time: Date.parse(base) + 150, data: { step: 0, name: 'bash', arguments: '{}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: { message: { content: [{ type: 'text', text: 'read-ok' }] } } },
      { type: 'tool/result', time: Date.parse(base) + 250, data: {
        error: { code: 'EIO', reason: 'disk full' },
        message: { isError: true, content: [{ type: 'text', text: 'write failed' }] },
      } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  const [first, second] = detail.steps![0]!.actions
  assert.equal(first!.result?.status, 'ok', '第一条返回归第一次调用')
  assert.equal(second!.result?.status, 'error', '第二条返回归第二次调用')
  assert.ok(second!.result?.summary.includes('disk full'))
})

test('顶层 isError 也算失败', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'bash', arguments: '{}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: {
        isError: true, content: [{ type: 'text', text: 'command failed: boom' }],
      } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  const result = detail.steps![0]!.actions[0]!.result!
  assert.equal(result.status, 'error')
  assert.ok(result.summary.includes('command failed: boom'), result.summary)
})

test('error 是空对象也算失败', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'bash', arguments: '{}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: {
        error: {}, message: { content: [{ type: 'text', text: 'partial' }] },
      } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  assert.equal(detail.steps![0]!.actions[0]!.result?.status, 'error')
})

test('短的失败正文不值得展开：不挂详情、也不占缓存', async () => {
  const sink = new Map<string, string>()
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'bash', arguments: '{}' } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: {
        error: { reason: 'exit 1' }, message: { isError: true, content: [{ type: 'text', text: 'boom' }] },
      } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1', undefined, undefined, sink,
  ))!
  const result = detail.steps![0]!.actions[0]!.result!
  assert.equal(result.status, 'error')
  assert.equal(result.detail, undefined)
  assert.equal(sink.size, 0)
})

test('已知工具给中文名，资源参数译成人话；没收录的工具只留原名', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: {
        step: 0, name: 'orchestrator_read',
        arguments: '{"resource":"ticket/c5faef17fff20441f4b105b70f265c13","offset":0}',
      } },
      { type: 'tool/result', time: Date.parse(base) + 200, data: { message: { content: [{ type: 'text', text: '工单卡片…' }] } } },
      { type: 'tool/call', time: Date.parse(base) + 300, data: { step: 1, name: 'bash', arguments: '{"command":"ls"}' } },
      { type: 'tool/result', time: Date.parse(base) + 400, data: { message: { content: [{ type: 'text', text: 'a.txt' }] } } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!

  const read = detail.steps![0]!.actions[0]!
  assert.equal(read.toolNote, '读取资源')
  assert.equal(read.tool, 'orchestrator read')
  assert.deepEqual(read.fields.map(field => [field.label, field.value]), [
    ['资源', '工单 Ticket c5faef17fff20441f4b105b70f265c13'],
    ['续读位置', '从头'],
  ])
  // 组头也用中文名，免得「第 0 步 · orchestrator read」看不懂
  assert.deepEqual(detail.steps![0]!.tools, ['读取资源'])

  const bash = detail.steps![1]!.actions[0]!
  assert.equal(bash.toolNote, undefined)
  assert.deepEqual(detail.steps![1]!.tools, ['bash'])
})

test('没有匹配到返回的动作也给中文名（另一处返回点）', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'orchestrator_eval_decide', arguments: '{}' } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  const action = detail.steps![0]!.actions[0]!
  assert.equal(action.toolNote, '作出准入决定')
  assert.equal(action.result, undefined)
})

test('事件超过读取上限时明说截断，且不拿窗口末尾冒充「结果」', async () => {
  const at = (offset: number) => Date.parse(base) + offset
  const thoughts = (count: number, from: number, prefix: string) => Array.from({ length: count }, (_, index) => ({
    type: 'assistant/message',
    time: at(from + index * 10),
    data: { text: `${prefix} ${index}` },
  }))
  // 400 条里有一个「想法 + 调用」，足够出现步骤；尾部再挂 100 条进入窗口外
  const long = [
    ...thoughts(399, 0, '想法'),
    { type: 'tool/call', time: at(3990), data: { step: 0, name: 'bash', arguments: '{}' } },
    { type: 'tool/result', time: at(4000), data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    ...thoughts(100, 4010, '尾部'),
  ]
  const detail = (await readSpanDetail(
    reader(long), 'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  assert.deepEqual(detail.truncated, { shown: 400, total: 501 })
  assert.equal(detail.outcome, undefined)

  // 没截断时照旧给结果（最后一步那条想法）
  const short = (await readSpanDetail(
    reader([
      { type: 'assistant/message', time: at(100), data: { text: '先看目录' } },
      { type: 'tool/call', time: at(200), data: { step: 0, name: 'bash', arguments: '{}' } },
      { type: 'tool/result', time: at(300), data: { message: { content: [{ type: 'text', text: 'ok' }] } } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  assert.equal(short.truncated, undefined)
  assert.equal(short.outcome?.text, '先看目录')
})

/** 「概要」段的一行：运行方 / 模型路由 / 推理强度。 */
const metaRow = (detail: { facts?: readonly { label: string; value: string }[] }, label: string): string | undefined =>
  detail.facts?.find(row => row.label === label)?.value

test('派工块抽屉标出运行方与模型路由：取会话事件，不读配置', async () => {
  const detail = (await readSpanDetail(
    reader([
      { type: 'request/header', time: Date.parse(base), data: {
        header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } } } },
      { type: 'request/context', time: Date.parse(base), data: {
        provider: 'deepseek-account', model: 'deepseek-flash', contextWindow: 1048576 } },
      { type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'bash', arguments: '{}' } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1', undefined,
    { factsFor: () => [], presetOf: () => 'dsh-superagent-worker' },
  ))!
  // 先答「属于谁」，再答「谁在跑」——顺序本身也锁住，合并顺序回退要能红
  assert.equal(detail.facts?.find(row => row.group === 'meta')?.label, '所属')
  assert.equal(metaRow(detail, '所属'), '工单 Ticket t1')
  assert.equal(metaRow(detail, '运行方'), 'DSH 内置 Worker（dsh-superagent-worker）')
  assert.equal(metaRow(detail, '模型路由'), 'deepseek-account · deepseek-flash')
  assert.equal(metaRow(detail, '推理强度'), 'high · 上下文 1,048,576')
})

test('没有模型事件说「没发起过请求」，会话读不到说「读不到」——不编造、不出现 undefined', async () => {
  const noModel = (await readSpanDetail(
    reader([{ type: 'tool/call', time: Date.parse(base) + 100, data: { step: 0, name: 'bash', arguments: '{}' } }]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  assert.equal(metaRow(noModel, '运行方'), '未记录')
  assert.match(metaRow(noModel, '模型路由')!, /还没有发起过模型请求/)
  assert.equal(metaRow(noModel, '推理强度'), '未记录')
  assert.ok(!JSON.stringify(noModel).includes('undefined'))

  // 读不到（归档/报错）与「读到了但还没发过请求」是两回事，文案不能混
  const broken = { readSession: async (): Promise<{ events: readonly Record<string, unknown>[] }> => { throw new Error('archived') } }
  const unreadable = (await readSpanDetail(
    broken, 'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  assert.match(metaRow(unreadable, '模型路由')!, /会话不可读/)

  // 空会话是可读的：仍说「没发起过请求」，不说「不可读」
  const empty = (await readSpanDetail(
    reader([]), 'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  assert.match(metaRow(empty, '模型路由')!, /还没有发起过模型请求/)
})

test('会话中途换模型：只标在变化的那一步，概要报最新模型', async () => {
  const at = (ms: number): number => Date.parse(base) + ms
  const detail = (await readSpanDetail(
    reader([
      { type: 'request/header', time: at(0), data: {
        header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
      { type: 'tool/call', time: at(100), data: { step: 0, name: 'bash', arguments: '{}' } },
      { type: 'tool/call', time: at(200), data: { step: 1, name: 'read', arguments: '{}' } },
      { type: 'request/header', time: at(250), data: {
        header: { config: { provider: 'anthropic', model: 'claude-sonnet-5' } } } },
      { type: 'tool/call', time: at(300), data: { step: 2, name: 'write', arguments: '{}' } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  // 第一步只建立基线，不该在每步重复；换模型的那一步才标
  assert.deepEqual(
    (detail.steps ?? []).map(step => step.model),
    [undefined, undefined, { provider: 'anthropic', model: 'claude-sonnet-5' }])
  assert.equal(metaRow(detail, '模型路由'), 'anthropic · claude-sonnet-5（这段活动里换过 1 次）')
})

test('子代理报自己会话的运行方与模型，不沿用父会话', async () => {
  const childSpan = {
    id: 'subagent-child-1', role: 'subagent' as const, kind: 'activity' as const,
    label: '子代理 #1', startMs: 0, endMs: 10_000, source: { sessionId: 'child-1' },
  }
  const detail = (await readSpanDetail(
    reader([{ type: 'request/header', time: Date.parse(base), data: {
      header: { config: { provider: 'deepseek-account', model: 'deepseek-reasoner' } } } }]),
    'worker-t1', chain([childSpan]), 'subagent-child-1', undefined,
    {
      factsFor: () => [],
      presetOf: (sessionId: string) => sessionId === 'child-1' ? 'standard' : 'dsh-superagent-worker',
    },
  ))!
  assert.equal(metaRow(detail, '所属'), '工单 Ticket t1 · 子代理')
  assert.equal(metaRow(detail, '运行方'), 'DSH 内置 Agent（standard）')
  assert.equal(metaRow(detail, '模型路由'), 'deepseek-account · deepseek-reasoner')
})

test('没有请求头时，子代理的 descriptor 仍是模型来源；未知 preset 原样显示', async () => {
  const childSpan = {
    id: 'subagent-child-2', role: 'subagent' as const, kind: 'activity' as const,
    label: '子代理 #2', startMs: 0, endMs: 10_000, source: { sessionId: 'child-2' },
  }
  const detail = (await readSpanDetail(
    reader([{ type: 'subagent/descriptor', time: Date.parse(base), data: {
      provider: 'spawn', agentProvider: 'openai-codex', agentModel: 'gpt-5-codex', agentReasoningEffort: 'medium' } }]),
    'worker-t1', chain([childSpan]), 'subagent-child-2', undefined,
    { factsFor: () => [], presetOf: () => 'external-worker' },
  ))!
  // 未知 preset 不翻译成猜出来的中文名
  assert.equal(metaRow(detail, '运行方'), 'external-worker')
  // provider 是模型路由，不是 agent 产品名——原样显示
  assert.equal(metaRow(detail, '模型路由'), 'openai-codex · gpt-5-codex')
  assert.equal(metaRow(detail, '推理强度'), 'medium')
})

test('多轮会话：step 号按轮重置，不同轮的同号步不能合并，换模型标在真正变化的那一步', async () => {
  const at = (ms: number): number => Date.parse(base) + ms
  const detail = (await readSpanDetail(
    reader([
      { type: 'request/header', time: at(0), data: {
        header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
      // turn 1：step 1、step 2
      { type: 'assistant/message', time: at(50), data: { text: '先确认收到' } },
      { type: 'tool/call', time: at(100), data: { turn: 1, step: 1, name: 'ack', arguments: '{}' } },
      { type: 'tool/call', time: at(200), data: { turn: 1, step: 2, name: 'bash', arguments: '{}' } },
      // turn 2 从 step 1 重新开始，并在这一步换了模型
      { type: 'request/header', time: at(250), data: {
        header: { config: { provider: 'anthropic', model: 'claude-sonnet-5' } } } },
      { type: 'tool/call', time: at(300), data: { turn: 2, step: 1, name: 'bash', arguments: '{}' } },
      { type: 'tool/call', time: at(400), data: { turn: 2, step: 2, name: 'orchestrator_report', arguments: '{}' } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  const steps = detail.steps ?? []
  // 四个步骤块，不是两个：turn 1 的 step 1 与 turn 2 的 step 1 是两件事
  assert.deepEqual(steps.map(step => [step.turn, step.step]), [[1, 1], [1, 2], [2, 1], [2, 2]])
  // 只有 turn 2 step 1 标了变化
  assert.deepEqual(steps.map(step => step.model), [
    undefined, undefined, { provider: 'anthropic', model: 'claude-sonnet-5' }, undefined,
  ])
  // 换过之后的新步（turn 2 step 2）不该再标一次
  assert.equal(metaRow(detail, '模型路由'), 'anthropic · claude-sonnet-5（这段活动里换过 1 次）')
  // 想法挂到轮内正确的步骤（id 带轮号，取全文不会撞车）
  assert.equal(steps[0]!.thoughts[0]!.id, 'span/assignment-a1/steps/1.1/thoughts/0')
})

test('概要只看这段活动的时间窗：窗口之后换的模型不算到本块头上', async () => {
  const at = (ms: number): number => Date.parse(base) + ms
  const detail = (await readSpanDetail(
    reader([
      { type: 'request/header', time: at(0), data: {
        header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } } } },
      { type: 'tool/call', time: at(100), data: { turn: 1, step: 1, name: 'bash', arguments: '{}' } },
      // 同一会话很晚才换模型（远超 span 结束时间）：本块不该报成 anthropic
      { type: 'request/header', time: at(600_000), data: {
        header: { config: { provider: 'anthropic', model: 'claude-sonnet-5' } } } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  assert.equal(metaRow(detail, '模型路由'), 'deepseek-account · deepseek-flash')
  assert.equal(metaRow(detail, '推理强度'), 'high')
})

test('换模型后不借用上一个模型的推理强度', async () => {
  const at = (ms: number): number => Date.parse(base) + ms
  const detail = (await readSpanDetail(
    reader([
      { type: 'request/header', time: at(0), data: {
        header: { config: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'high' } } } },
      { type: 'tool/call', time: at(100), data: { turn: 1, step: 1, name: 'bash', arguments: '{}' } },
      // 新模型的事件没有 reasoningEffort / contextWindow：不能把上一个模型的 high 借给它
      { type: 'request/header', time: at(200), data: {
        header: { config: { provider: 'anthropic', model: 'claude-sonnet-5' } } } },
      { type: 'tool/call', time: at(300), data: { turn: 1, step: 2, name: 'write', arguments: '{}' } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  assert.equal(metaRow(detail, '模型路由'), 'anthropic · claude-sonnet-5（这段活动里换过 1 次）')
  assert.equal(metaRow(detail, '推理强度'), '未记录')
})

test('模型也认 assistant/message 的 source；只「选中」没发请求的 model/selection 不算', async () => {
  const at = (ms: number): number => Date.parse(base) + ms
  const fromMessage = (await readSpanDetail(
    reader([
      { type: 'request/header', time: at(0), data: {
        header: { config: { provider: 'deepseek-account', model: 'deepseek-flash' } } } },
      // 只有模型消息自带的 source 报出了新模型（无 request/header 佐证时也要认）
      { type: 'assistant/message', time: at(100), data: {
        text: '好了',
        message: { source: { kind: 'model', provider: 'anthropic', model: 'claude-sonnet-5' } } } },
      { type: 'tool/call', time: at(200), data: { turn: 1, step: 1, name: 'bash', arguments: '{}' } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  assert.equal(metaRow(fromMessage, '模型路由'), 'anthropic · claude-sonnet-5（这段活动里换过 1 次）')

  const selectedOnly = (await readSpanDetail(
    reader([
      { type: 'model/selection', time: at(0), data: {
        provider: 'anthropic', model: 'claude-sonnet-5', reasoningEffort: 'high' } },
      { type: 'tool/call', time: at(100), data: { turn: 1, step: 1, name: 'bash', arguments: '{}' } },
    ]),
    'worker-t1', chain([executorSpan]), 'assignment-a1',
  ))!
  // 只「选中」不代表已经用过：仍说没发起过请求
  assert.match(metaRow(selectedOnly, '模型路由')!, /还没有发起过模型请求/)
})
