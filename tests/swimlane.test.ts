import { test } from 'node:test'
import assert from 'node:assert/strict'
import { present, ticksFor, formatDuration, durationOf } from '../src/presenter/swimlane.ts'
import type { Chain } from '../src/domain/model.ts'

const chain = (spans: Chain['spans']): Chain => ({
  ticketId: 't1', title: '示例', stage: '进行中', createdAt: '2026-01-01T00:00:00Z', spans,
})

test('时长取最早开始到最晚结束', () => {
  assert.equal(durationOf(chain([
    { id: 'a', role: 'router', kind: 'activity', label: 'A', startMs: 100, endMs: 300 },
    { id: 'b', role: 'executor', kind: 'activity', label: 'B', startMs: 400, endMs: 1400 },
  ])), 1300)
})

test('空链路不炸', () => {
  assert.equal(durationOf(chain([])), 0)
  const model = present(chain([]))
  assert.equal(model.nodes.length, 0)
})

test('节点有最小高度，短事件不会消失', () => {
  const model = present(chain([
    { id: 'a', role: 'router', kind: 'activity', label: 'A', startMs: 0, endMs: 2 },
  ]))
  assert.ok(model.nodes[0]!.height >= 42)
})

test('刻度用整数步长，且不超过上限', () => {
  const ticks = ticksFor(33_000, 8)
  assert.ok(ticks.length <= 9)
  assert.deepEqual(ticks.slice(0, 3), [0, 5000, 10000])
})

test('13 小时的链路刻度排到小时级，不会画出几百条横线', () => {
  const ticks = ticksFor(48_713_000)
  assert.ok(ticks.length <= 9, `实际 ${ticks.length} 条`)
  // 步长按 duration/maxTicks 取阶：811 分钟约 6.1M ms/格 ⇒ 2 小时一格
  assert.equal(ticks[1], 7_200_000)
  assert.ok(ticks.slice(1).every(tick => tick % 3_600_000 === 0))
})

test('时长格式化在分钟/小时/天处切换', () => {
  assert.equal(formatDuration(33_400), '33s')
  assert.equal(formatDuration(125_000), '2m5s')
  assert.equal(formatDuration(48_660_000), '13h31m')
  assert.equal(formatDuration(86_400_000), '1d')
  assert.equal(formatDuration(90_000_000), '1d1h')
})

test('单来源是三列，两条来源是四列', async () => {
  const { lanesFor } = await import('../src/presenter/swimlane.ts')
  const base = chain([])
  assert.equal(lanesFor({ ...base, source: 'demo' }).length, 3)
  const four = lanesFor({ ...base, source: 'feishu' }, ['github'])
  assert.equal(four.length, 4)
  // 来源名一律取数据里的 id，不写死中文名——换来源时视图不改
  assert.deepEqual(four.map(lane => lane.label), ['feishu', 'github', '主控', '执行器'])
  // 三个角色列带英文副名；来源列副名就是来源 id，视图不重复画
  assert.deepEqual(four.map(lane => lane.labelEn), ['feishu', 'github', 'Router', 'Worker'])
  const three = lanesFor({ ...base, source: 'demo' })
  assert.deepEqual(three.map(lane => lane.labelEn), ['demo', 'Router', 'Worker'])
  // 位置均分且不贴边
  const xs = four.map(lane => lane.x)
  assert.ok(xs.every((x, index) => index === 0 || x > xs[index - 1]!))
  assert.ok(xs[0]! > 0 && xs[xs.length - 1]! < 1)
})

test('相邻同角色在摘要里合并', async () => {
  const { chainSummary } = await import('../src/presenter/swimlane.ts')
  const summary = chainSummary({
    ...chain([
      { id: 'd', role: 'router', kind: 'activity', label: '评估', startMs: 0, endMs: 1700 },
      { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 1700, endMs: 12000 },
      { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 12000, endMs: 22000 },
    ]),
    source: 'demo',
  })
  assert.equal(summary, 'demo → 主控 ·2s → 执行器 ·20s → demo')
})

test('相邻同角色合并时耗时累加，不能只报第一段', async () => {
  const { chainSummary } = await import('../src/presenter/swimlane.ts')
  // 真实样本：三次派工 98s + 141s + 95s，左栏曾只写第一段的 1m38s，而图上时长是 5m40s
  const summary = chainSummary({
    ...chain([
      { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 85, endMs: 98_529 },
      { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 98_619, endMs: 239_935 },
      { id: 'a3', role: 'executor', kind: 'activity', label: '派工 #3', startMs: 240_047, endMs: 335_457 },
    ]),
    source: 'fixture',
  })
  assert.equal(summary, 'fixture → 执行器 ·5m35s → fixture')
})

test('编号按语义顺序：事件 → 确认 → 评估 → 派工 → 执行块 → 报告 → 回复', () => {
  const model = present({
    ...chain([
      { id: 'r', role: 'router', kind: 'activity', label: '评估', badge: '准入放行', startMs: 0, endMs: 0 },
      { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 78, endMs: 13213, reportState: 'ready' },
    ]),
    source: 'demo',
  })
  const labels = [
    ...model.arrows.map(arrow => ({ step: arrow.step, label: arrow.label })),
    ...model.nodes.map(node => ({ step: node.step ?? 0, label: node.label })),
  ]
    .filter(item => item.step > 0)
    .sort((left, right) => left.step - right.step)
    .map(item => item.label)

  // 没有 ack/reply 的证据时，不画这两条箭头
  assert.deepEqual(labels, ['事件', '评估', '派工 #1', '派工 #1', '报告：就绪'])
})

test('有日志证据时才补上确认收到与回复', () => {
  const base = Date.parse('2026-01-01T00:00:00Z')
  const model = present({
    ...chain([
      { id: 'r', role: 'router', kind: 'activity', label: '评估', startMs: 0, endMs: 0 },
      { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 78, endMs: 13213, reportState: 'ready' },
    ]),
    source: 'demo',
    marks: { ackMs: base + 1200, replyMs: base + 13500 },
  })
  const labels = [
    ...model.arrows.map(arrow => ({ step: arrow.step, label: arrow.label })),
    ...model.nodes.map(node => ({ step: node.step ?? 0, label: node.label })),
  ]
    .filter(item => item.step > 0)
    .sort((left, right) => left.step - right.step)
    .map(item => item.label)

  // 1.2 秒的 ack 排在派工之后：编号按真实时间，不按"看起来该先"的顺序
  assert.deepEqual(labels, ['事件', '评估', '派工 #1', '派工 #1', '确认收到', '报告：就绪', '回复'])
})

test('报告箭头如实呈现六态，不再一律写「就绪」', () => {
  const states = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']
  const model = present(chain(states.map((state, index) => ({
    id: `a${index}`,
    role: 'executor' as const,
    kind: 'activity' as const,
    label: `派工 #${index + 1}`,
    startMs: index * 1000,
    endMs: index * 1000 + 500,
    reportState: state,
  }))))
  assert.deepEqual(
    model.arrows.filter(arrow => arrow.id.startsWith('arrow-report')).map(arrow => arrow.label),
    ['报告：进行中', '报告：等待触发', '报告：就绪', '报告：受阻', '报告：失败', '报告：无需处理'],
  )
})

test('没有报告的派工只画派工箭头，不凭空画一支报告箭头', () => {
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 1000, endMs: 2000 },
  ]))
  assert.equal(model.arrows.filter(arrow => arrow.id.startsWith('arrow-dispatch')).length, 1)
  assert.deepEqual(model.arrows.filter(arrow => arrow.id.startsWith('arrow-report')), [])
})

test('每个派工各画一支回复箭头，不再只画第 0 条', () => {
  const base = Date.parse('2026-01-01T00:00:00Z')
  const model = present({
    ...chain([
      { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 1000, endMs: 2000 },
      { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 3000, endMs: 4000 },
    ]),
    source: 'demo',
    marks: { replies: [base + 2500, base + 4500] },
  })
  assert.deepEqual(
    model.arrows.filter(arrow => arrow.id.startsWith('arrow-reply')).map(arrow => arrow.id),
    ['arrow-reply-0', 'arrow-reply-1'],
  )
})

test('batch 的两条触发各画一支事件箭头，时刻取 trigger.at', () => {
  const at = (seconds: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000).toISOString()
  const model = present({
    ...chain([
      { id: 'r', role: 'router', kind: 'activity', label: '评估', startMs: 4000, endMs: 4000 },
    ]),
    source: 'demo',
    origins: [{ triggerId: 't1', at: at(1) }, { triggerId: 't2', at: at(2) }],
  })
  const triggers = model.arrows.filter(arrow => arrow.id.startsWith('arrow-trigger'))
  assert.equal(triggers.length, 2)
  // 两条箭头按事件时刻分开，而不是叠在评估块上
  assert.ok(triggers[1]!.top > triggers[0]!.top)
})

const bandChain = (startsApprox?: boolean): Chain => ({
  ...chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 8000 },
  ]),
  source: 'demo',
  stateBands: [{
    id: 'sb1', tag: 'working/queued', label: '执行中', startMs: 0, endMs: 5000,
    ...(startsApprox ? { startsApprox: true } : {}),
  }],
})

test('状态带标签放在色块右侧留白，不再压块标题', async () => {
  const { present } = await import('../src/presenter/swimlane.ts')
  const model = present(bandChain())
  const band = model.stateBands[0]!
  const cx = model.lanes.find(lane => lane.role === 'executor')!.x * model.canvasWidth
  // 132 宽的色块右缘 = cx+66，标签再右移 6px 起笔
  assert.equal(band.labelX, cx + 66 + 6)
  assert.equal(band.labelY, band.top + 13)
  assert.equal(band.labelAnchor, 'start')
  // 不变量：标签起点在块（130 宽）右缘之外，横向不可能再与块标题重叠
  assert.ok(band.labelX! > cx + 65)
})

test('起点近似的带把标签下移，避让顶部虚线', async () => {
  const { present } = await import('../src/presenter/swimlane.ts')
  const band = present(bandChain(true)).stateBands[0]!
  assert.equal(band.labelY, band.top + 26)
})

test('留白放不下时不画字，但带本身还在', async () => {
  const { present } = await import('../src/presenter/swimlane.ts')
  // 1 来源 + 3 个额外来源 + 主控 + 执行器 = 6 列，执行器右缘距画布边缘只剩 31px
  const model = present(bandChain(), { extraSources: ['a', 'b', 'c'] })
  assert.equal(model.lanes.length, 6)
  const band = model.stateBands[0]!
  assert.equal(band.labelX, undefined)
  assert.equal(band.label, '执行中')
  // 没有标签也不能变成不可点：id/坐标仍在
  assert.ok(band.height > 34)
})

test('太薄的带不画标签', async () => {
  const { present } = await import('../src/presenter/swimlane.ts')
  const model = present({
    ...bandChain(),
    stateBands: [{ id: 'sb1', tag: 'working/queued', label: '执行中', startMs: 0, endMs: 200 }],
  })
  // 阈值 14px：200ms × 0.034px/ms ≈ 7px，连一行 9.5px 的字都放不下
  assert.ok(model.stateBands[0]!.height < 14)
  assert.equal(model.stateBands[0]!.labelX, undefined)
})

test('811 分钟的链路压进固定画布，不再随时间线性变长', () => {
  const durationMs = 48_713_000
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 1000 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 24_356_500, endMs: 24_357_500 },
    { id: 'a3', role: 'executor', kind: 'activity', label: '派工 #3', startMs: 48_712_000, endMs: durationMs },
  ]))
  // 旧口径：48,713,000ms × 0.034px/ms ≈ 1,656,000px
  assert.ok(model.heightPx <= 760, `实际 ${model.heightPx}px`)
  // 内容区按 600px 适配：半程应落在 300px 处
  const top = (id: string): number => model.nodes.find(node => node.id === id)!.top
  assert.ok(Math.abs((top('a2') - top('a1')) - 300) < 1, `半程 ${top('a2') - top('a1')}px`)
  // 刻度也压缩到小时级
  assert.ok(model.ticks.length <= 9)
})

test('短链路保持 34px/秒：自适应不放大也不缩小观感', () => {
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 1000 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 5000, endMs: 6000 },
  ]))
  const top = (id: string): number => model.nodes.find(node => node.id === id)!.top
  assert.equal(top('a2') - top('a1'), 170) // 5000ms × 0.034
})

test('时间仍是线性的：两段间隔之比等于时长比', () => {
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 1000 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 10_000, endMs: 11_000 },
    { id: 'a3', role: 'router', kind: 'activity', label: '评估', startMs: 30_000, endMs: 30_000 },
  ]))
  const top = (id: string): number => model.nodes.find(node => node.id === id)!.top
  assert.ok(Math.abs((top('a3') - top('a2')) / (top('a2') - top('a1')) - 2) < 0.01)
})

test('空档够长时相邻派工之间留出 8px 缝', () => {
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 500 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 2500, endMs: 3000 },
    { id: 'a3', role: 'executor', kind: 'activity', label: '派工 #3', startMs: 29_000, endMs: 30_000 },
  ]))
  const top = (id: string): number => model.nodes.find(node => node.id === id)!.top
  const bottom = (id: string): number => {
    const node = model.nodes.find(item => item.id === id)!
    return node.top + node.height
  }
  // 30s 链路 fit 20px/s 下这张 42px 卡已放得下 2s 空档（(0.5+2)*20 = 50 ≥ 42+8），
  // 所以这条测的是「不在 fit 之上无谓长高」，抬高比例那条由「被最小高撑开」用例覆盖。
  assert.ok(top('a2') - bottom('a1') >= 8, `间隙 ${top('a2') - bottom('a1')}px`)
  // 比例仍是 fit 的 20px/s（末块底边 670 + 页尾 24），没有为了这 8px 抬高画布。
  assert.equal(model.heightPx, 694)
})

test('跨过下一条派工起点的子代理不参与防重叠计算', () => {
  // 子代理 s1 [1072,6072] 跨过 a1 的起点 5051。若把子代理也算进执行器泳道，
  // startMs 排序后的相邻对变成 (a0,s1)、(s1,a1)，两对 gap 都为负被跳过，
  // 真正的 a0→a1（只隔 50ms）反而没人算，两张派工卡会压在一起。
  const model = present(chain([
    { id: 'a0', role: 'executor', kind: 'activity', label: '派工 #0', startMs: 1, endMs: 5001 },
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 5051, endMs: 105_051 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 105_151, endMs: 106_151 },
    { id: 's0', role: 'subagent', kind: 'activity', label: '子代理 #1', startMs: 633, endMs: 1633 },
    { id: 's1', role: 'subagent', kind: 'activity', label: '子代理 #2', startMs: 1072, endMs: 6072 },
  ]))
  const node = (id: string): { top: number; height: number } => model.nodes.find(item => item.id === id)!
  assert.ok(node('a1').top >= node('a0').top + node('a0').height - 0.01,
    `重叠 ${(node('a0').top + node('a0').height - node('a1').top).toFixed(2)}px`)
  assert.ok(model.heightPx < 1200, `高度 ${model.heightPx}px`)
})

test('短链路挤不下时允许突破 34px/秒，不拿重叠换密度', () => {
  // 2s 链路：两张 1s 卡只隔 10ms，不重叠需要 41.6px/秒。旧实现用 34 封顶把下界吃掉，卡片压 7.66px。
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 1000 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 1010, endMs: 2000 },
  ]))
  const [a1, a2] = model.nodes
  assert.ok(a2!.top >= a1!.top + a1!.height - 0.01,
    `重叠 ${(a1!.top + a1!.height - a2!.top).toFixed(2)}px`)
  assert.ok(model.heightPx > 2 * 34 + 72, `密度没放开：${model.heightPx}px`)
  assert.ok(model.heightPx <= 1200, `越过硬上限：${model.heightPx}px`)
})

test('早于第一段活动的状态带不被画到画布上方', () => {
  // 状态带从 createdAt（偏移 0）起画；若第一段活动在 100s，零点必须带上状态带，否则 top 为负、整段被裁。
  const model = present({
    ...chain([{ id: 'a', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 100_000, endMs: 200_000 }]),
    stateBands: [{ id: 'sb1', tag: 'working', label: '执行中', startMs: 0, endMs: 5000 }],
  })
  const band = model.stateBands[0]!
  assert.ok(band.top >= 48 - 0.01, `带顶 ${band.top}`)
  assert.ok(band.height > 0)
  assert.ok(model.heightPx <= 1200, `高度 ${model.heightPx}px`)
})

test('同泳道再挤也不许把画布撑过 1200px', () => {
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 100 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 400, endMs: 500 },
    { id: 'a3', role: 'executor', kind: 'activity', label: '派工 #3', startMs: 7_199_000, endMs: 7_200_000 },
  ]))
  assert.ok(model.heightPx <= 1200.5, `实际 ${model.heightPx}px`)
})

test('状态带晚于最后一段活动时也不被裁掉', () => {
  const model = present({
    ...chain([
      { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 1000 },
    ]),
    source: 'demo',
    stateBands: [{ id: 'sb1', tag: 'person/review', label: '待人验收', startMs: 1000, endMs: 5000 }],
  })
  assert.equal(model.durationMs, 5000)
  const band = model.stateBands[0]!
  assert.ok(model.heightPx > band.top + band.height)
})

test('不落笔的事件（filtered）不参与时间范围：不能把真实活动压成一条线', () => {
  const at = (seconds: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + seconds * 1000).toISOString()
  const model = present({
    ...chain([
      { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 10_000 },
    ]),
    source: 'demo',
  }, {
    events: [
      { path: 'direct', at: at(10) },
      // 同一条链路上混进一条 13 小时后的噪音消息：它不画箭头，不该拉长轴
      { path: 'filtered', at: at(48_000) },
    ],
  })
  assert.equal(model.durationMs, 10_000)
  assert.ok(model.heightPx <= 760)
})

test('显式 pxPerSecond 仍可覆盖自适应（测试与调试用）', () => {
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 1000 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 5000, endMs: 6000 },
  ]), { pxPerSecond: 10 })
  const top = (id: string): number => model.nodes.find(node => node.id === id)!.top
  assert.equal(top('a2') - top('a1'), 50)
})

test('回复晚于最后一段活动时，画布高度也要容纳它', () => {
  const base = Date.parse('2026-01-01T00:00:00Z')
  const model = present({
    ...chain([
      { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 1000, endMs: 2000 },
    ]),
    source: 'demo',
    marks: { replies: [base + 60_000] },
  })
  const reply = model.arrows.find(arrow => arrow.id === 'arrow-reply-0')!
  assert.ok(model.heightPx > reply.top + 10)
})

test('空档比前一段活动还短时，仍然要保证卡片不叠', () => {
  // A 持续 2s，1s 后就起 B：gapMs(1000) < dA(2000)，旧实现直接跳过这一对。
  const c = chain([
    { id: 'a', role: 'executor', kind: 'activity', label: 'A', startMs: 0, endMs: 2000 },
    { id: 'b', role: 'executor', kind: 'activity', label: 'B', startMs: 3000, endMs: 4000 },
    { id: 'c', role: 'executor', kind: 'activity', label: 'C', startMs: 50_000, endMs: 51_000 },
  ])
  const model = present(c)
  const [a, b] = model.nodes
  // 真实根：(42+8)/(2000+1000) = 16.667px/s（fit 只有 11.76，撑开时才有这张卡）
  assert.ok(b!.top - (a!.top + a!.height) >= 8 - 0.01,
    `实际间隙 ${(b!.top - (a!.top + a!.height)).toFixed(2)}px`)
})

test('事件早于第一段活动时，跨度不能被少算（画布仍在硬上限内）', () => {
  const model = present(chain([
    { id: 'a', role: 'executor', kind: 'activity', label: 'A', startMs: 100_000, endMs: 200_000 },
  ]), { events: [{ path: 'direct', at: '2026-01-01T00:00:00Z' }] })
  assert.equal(model.durationMs, 200_000)
  assert.ok(model.heightPx <= 1200, `高度 ${model.heightPx}`)
})

test('薄状态带的「起点近似」标签也落在带内', async () => {
  const { present } = await import('../src/presenter/swimlane.ts')
  const model = present({
    ...bandChain(),
    stateBands: [{ id: 'sb1', tag: 'person/answer', label: '已回复', startMs: 0, endMs: 700, startsApprox: true }],
  })
  const band = model.stateBands[0]!
  assert.ok(band.height > 14 && band.height < 26, `带高 ${band.height}`)
  assert.equal(band.labelX !== undefined, true, '这么薄也该有标签')
  assert.ok(band.labelY! > band.top && band.labelY! <= band.top + band.height - 3,
    `基线 ${band.labelY} 越出带底 ${band.top + band.height}`)
})

test('时间戳解析失败时不产出 NaN 坐标', () => {
  const model = present(chain([
    { id: 'a', role: 'executor', kind: 'activity', label: 'A', startMs: 0, endMs: 1000 },
  ]), { events: [{ path: 'direct', at: 'not-a-date' }] })
  assert.ok(Number.isFinite(model.heightPx))
  assert.ok(model.notices.every(notice => Number.isFinite(notice.top)))
  assert.ok(model.arrows.every(arrow => Number.isFinite(arrow.top)))
})

test('相邻派工几乎首尾相接（真实工单形态）时，画布不被抬到上限', () => {
  // 夹具工单：三段派工各 98~141 秒，间隔只有几十毫秒。
  // 若强行要求「任何时候都留 8px」，这根下界会到 89px/秒，335 秒直接顶到 1200px。
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 85, endMs: 98_529 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 98_619, endMs: 239_935 },
    { id: 'a3', role: 'executor', kind: 'activity', label: '派工 #3', startMs: 240_047, endMs: 335_457 },
  ]))
  assert.ok(model.heightPx <= 760, `高度 ${model.heightPx}`)
  const [a1, a2, a3] = model.nodes
  assert.ok(a2!.top >= a1!.top + a1!.height - 0.01, '相邻块不能互相压住')
  assert.ok(a3!.top >= a2!.top + a2!.height - 0.01)
})

test('被最小高撑开的短卡片会被抬高到刚好不压住下一块', () => {
  // 10s 卡片、1s 空档在 201 秒链路里 fit 只有 3px/秒，卡片会被撑到 42px 并压住下一块。
  const model = present(chain([
    { id: 'a1', role: 'executor', kind: 'activity', label: '派工 #1', startMs: 0, endMs: 10_000 },
    { id: 'a2', role: 'executor', kind: 'activity', label: '派工 #2', startMs: 11_000, endMs: 12_000 },
    { id: 'a3', role: 'executor', kind: 'activity', label: '派工 #3', startMs: 200_000, endMs: 201_000 },
  ]))
  const [a1, a2] = model.nodes
  // 空档只有 1s（比 8px 缝所需的比例还短），只要求不重叠，不强求 8px。
  assert.ok(a2!.top >= a1!.top + a1!.height - 0.01,
    `间隙 ${(a2!.top - (a1!.top + a1!.height)).toFixed(2)}px`)
  // 若这 1s 空档也强求 8px 缝：4.55px/秒、高度 977px；只求不重叠：3.82px/秒、877px。
  assert.ok(model.heightPx <= 900, `高度 ${model.heightPx}`)
})

test('直通箭头压在评估块上、且块没有徽章时，内联进块标题行', () => {
  // 注：真实适配器给评估块必带徽章（准入放行/规则拒绝…），所以生产里走的是
  // 下面的「挪到块右侧」；这条覆盖的是 presenter 支持的另一种形状（无徽章的块）。
  const model = present({
    ...chain([
      { id: 'r', role: 'router', kind: 'activity', label: '评估', startMs: 0, endMs: 20_000 },
    ]),
    source: 'demo',
  }, { events: [{ path: 'direct', at: '2026-01-01T00:00:10Z' }] })

  const fast = model.arrows.find(arrow => arrow.id === 'arrow-fast-0')!
  const evaluation = model.nodes[0]!
  assert.equal(fast.inline, true, '标签不该再单独画在块上')
  assert.equal(evaluation.badge, '订阅直通')
  assert.equal(evaluation.badgeKind, 'fast', '内联注解跟着箭头配色')
  assert.equal(evaluation.badgeStep, fast.step, '内联后仍要带工序号')
})

test('块已有徽章时（准入放行 ≠ 订阅直通）标签挪到块右侧，两个注解都不丢', () => {
  // 实机形态：评估块徽章是「准入放行」，直通箭头标签是「订阅直通」，讲的是两件事。
  const model = present({
    ...chain([
      { id: 'r', role: 'router', kind: 'activity', label: '评估', badge: '准入放行', startMs: 0, endMs: 20_000 },
    ]),
    source: 'demo',
  }, { events: [{ path: 'direct', at: '2026-01-01T00:00:10Z' }] })

  const fast = model.arrows.find(arrow => arrow.id === 'arrow-fast-0')!
  const evaluation = model.nodes[0]!
  assert.equal(fast.inline, undefined)
  assert.equal(evaluation.badge, '准入放行', '原有徽章不能被顶掉')
  // 主控列在第 500px，块宽 130 ⇒ 右缘 565，标签从 571 起左对齐
  assert.equal(fast.labelX, 571)
  assert.equal(fast.labelAnchor, 'start')
  assert.equal(fast.halo, undefined, '挪得开就不用白描边兜底')
})

test('标签没压到任何块时不动它（保持居中在原位）', () => {
  const model = present({
    ...chain([
      { id: 'r', role: 'router', kind: 'activity', label: '评估', startMs: 0, endMs: 20_000 },
    ]),
    source: 'demo',
  }, { events: [{ path: 'direct', at: '2026-01-01T00:00:40Z' }] })

  const fast = model.arrows.find(arrow => arrow.id === 'arrow-fast-0')!
  assert.equal(fast.inline, undefined)
  assert.equal(fast.labelX, undefined)
  assert.equal(fast.labelAnchor, undefined)
})

test('标签的真实宽度要算上圈码和英文副标，四列布局下不会漏判压在块上', () => {
  // 四列：来源①②（0.2/0.4）→ 主控（0.6）→ 执行器（0.8）。直通箭头中点在 500px，
  // 只按「订阅直通」四个中文字估宽（40px）时盒子是 [480,520]，够不到 535px 的主控块；
  // 实际渲染是「⑤ 订阅直通 Fast path」约 97px，右缘到 548px，压住主控块 13px。
  const model = present({
    ...chain([
      { id: 'r', role: 'router', kind: 'activity', label: '评估', badge: '准入放行', startMs: 10_000, endMs: 10_000 },
    ]),
    source: 'feishu',
  }, { extraSources: ['github'], events: [{ path: 'direct', at: '2026-01-01T00:00:10.200Z' }] })

  const fast = model.arrows.find(arrow => arrow.id === 'arrow-fast-0')!
  // 主控块右缘 665 ⇒ 标签从 671 起
  assert.equal(fast.labelX, 671, '漏判的话这里会是 undefined（标签默认仍居中在 500px）')
  assert.equal(fast.labelAnchor, 'start')
})

test('块顶有「起点未知」注记时，右移的标签再让开注记', () => {
  // 评估块只在判定点画、起点标为近似：块顶那行「起点未知」就在块右缘外。
  // 直通箭头落点贴着块顶时，标签会与注记同高，必须整体再往右让开注记的宽度。
  const model = present({
    ...chain([
      { id: 'r', role: 'router', kind: 'activity', label: '评估', badge: '准入放行', startMs: 10_000, endMs: 10_000, startsApprox: true },
    ]),
    source: 'demo',
  }, { events: [{ path: 'direct', at: '2026-01-01T00:00:10.300Z' }] })

  const fast = model.arrows.find(arrow => arrow.id === 'arrow-fast-0')!
  const evaluation = model.nodes[0]!
  assert.equal(evaluation.approxStart, true)
  // 块右缘 565 + 6 + 「起点未知」(4×8.5=34) + 6 = 611
  assert.equal(fast.labelX, 611, `注记从 571 起、宽 34px，标签不能压上去（实际 ${fast.labelX}）`)
  assert.equal(fast.labelAnchor, 'start')
})

test('同一块上压着两条箭头时，第二条挪到左边，不叠在第一条上', () => {
  const model = present({
    ...chain([
      { id: 'r', role: 'router', kind: 'activity', label: '评估', badge: '准入放行', startMs: 0, endMs: 20_000 },
    ]),
    source: 'demo',
  }, { events: [
    { path: 'direct', at: '2026-01-01T00:00:10Z' },
    { path: 'context', at: '2026-01-01T00:00:10Z' },
  ] })

  const fast = model.arrows.filter(arrow => arrow.id.startsWith('arrow-fast'))
  assert.equal(fast.length, 2)
  assert.deepEqual(fast.map(arrow => [arrow.labelX, arrow.labelAnchor]), [[571, 'start'], [429, 'end']])
})
