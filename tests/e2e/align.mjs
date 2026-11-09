/**
 * 对齐断言：按 doc/08-对齐清单.md，逐个点击图上元素，断言抽屉有标题与内容。
 * 用法：node tests/e2e/align.mjs <url>
 */
const PORT = 9333
const url = process.argv[2]

const target = await (async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json())
      const page = list.find(item => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 等待 */ }
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('CDP 未就绪')
})()

const socket = new WebSocket(target)
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let sequence = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  const settle = pending.get(message.id)
  if (settle) { pending.delete(message.id); settle(message) }
})
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++sequence
  pending.set(id, m => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)))
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  return result.result?.value
}

await send('Page.enable')
await send('Runtime.enable')
// 插件包每次构建都会换 rev，但 Chrome 可能仍然复用旧模块；禁用缓存才能测到刚构建的产物。
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
await send('Page.navigate', { url })
await new Promise(r => setTimeout(r, 5000))

const origin = new URL(url).origin
const extras = []
const check = (name, ok, detail = '') => { extras.push({ name, ok, detail }) }

// —— 引导：点「来源与工单」→ 等来源页（B14：落地页是来源页，不再是工单列表）——
for (let attempt = 0; attempt < 12; attempt += 1) {
  await evaluate(`[...document.querySelectorAll('button,a,div,span')].find(n=>n.textContent?.trim()==='来源与工单')?.click()`)
  await new Promise(r => setTimeout(r, 1200))
  if (await evaluate(`!!document.querySelector('[data-source-page]')`)) break
}
const pageReady = await evaluate(`!!document.querySelector('[data-source-page]')`)
if (!pageReady) {
  console.log('来源页没加载出来，body 片段：')
  console.log(String(await evaluate('document.body.innerText.slice(0,400)')).replace(/\n/g,' | '))
}
check('引导后落地页是来源页', pageReady)

// 覆盖层内的一切断言都从这里取根：来源页同时挂载着，全局选择器会把两层混在一起。
await evaluate(`(() => {
  window.__overlay = () => document.querySelector('[data-ticket-overlay]');
  window.__q = selector => window.__overlay()?.querySelector(selector) ?? null;
  window.__qa = selector => [...(window.__overlay()?.querySelectorAll(selector) ?? [])];
  return true
})()`)

// —— 来源页：来源数、总数、两个滚动区、分隔条 ——
await new Promise(r => setTimeout(r, 1200))
const rowIds = JSON.parse(
  await evaluate(`JSON.stringify([...document.querySelectorAll('[data-source-row]')].map(n => n.getAttribute('data-source-row')))`) ?? '[]')
const sourceList = await fetch(`${origin}/agent-trace/sources`).then(r => r.json()).then(d => d.items ?? []).catch(() => [])
check('左栏来源数 = 接口返回数', rowIds.length === sourceList.length, `预期 ${sourceList.length}，实际 ${rowIds.length}`)

// 可选：第 4 个参数指定要检查的来源（点左栏那一行），默认第一条
const sourceArg = process.argv[4]
if (sourceArg && sourceList.some(item => item.source === sourceArg)) {
  await evaluate(`document.querySelector('[data-source-row="${sourceArg}"]')?.click()`)
  await new Promise(r => setTimeout(r, 1500))
}
const activeSource = sourceArg ?? rowIds[0]
const stats = String(await evaluate(`document.querySelector('[data-source-stats]')?.textContent ?? ''`))
const active = sourceList.find(item => item.source === activeSource)
check('来源页给出事件数与工单数', !!active && stats.includes(`${active.received} 条事件`) && stats.includes(`${active.tickets} 张工单`), stats)

// 事件行的去向分布必须与接口给的计数一一对上：少一类、错一类都算失败。
await new Promise(r => setTimeout(r, 800))
const fateCounts = JSON.parse(await evaluate(`JSON.stringify(
  [...document.querySelectorAll('[data-event]')].reduce((acc, n) => {
    const kind = n.getAttribute('data-fate'); acc[kind] = (acc[kind] ?? 0) + 1; return acc
  }, {}))`) ?? '{}')
// 只有来源全部装得进第一页（50 条）时才能逐类对等；否则界面只有一部分，
// 只要求「界面上的每一类不超过接口计数」。
const onePage = !!active && active.received <= 50
const expectCounts = active
  ? [...Object.entries(active.counts), ['unrecorded', active.unrecorded ?? 0]]
  : [['(来源不存在)', 0]]
const fateMismatch = expectCounts.filter(([kind, n]) =>
  onePage ? (fateCounts[kind] ?? 0) !== n : (fateCounts[kind] ?? 0) > n)
check(`事件行的去向分布${onePage ? ' = ' : ' ≤ '}接口给的计数`, !!active && fateMismatch.length === 0,
  fateMismatch.map(([kind, n]) => `${kind} 界面 ${fateCounts[kind] ?? 0} / 接口 ${n}`).join('，'))

const overflow = JSON.parse(await evaluate(`JSON.stringify({
  sources: getComputedStyle(document.querySelector('[data-rail-sources]')).overflowY,
  tickets: getComputedStyle(document.querySelector('[data-rail-tickets]')).overflowY,
})`) ?? '{}')
check('来源区与工单区各自滚动', overflow.sources === 'auto' && overflow.tickets === 'auto', JSON.stringify(overflow))

// 分隔条：拖动后上区高度变化，松手把比例写进 localStorage。
// 存储过的比例会被沿用（上一轮可能已拖到 85%），所以按当前比例选方向。
const beforeSplit = await evaluate(`(() => ({
  height: Math.round(document.querySelector('[data-rail-sources]')?.getBoundingClientRect().height ?? 0),
  ratio: Number(document.querySelector('[data-splitter]')?.getAttribute('aria-valuenow') ?? 55),
  splitter: !!document.querySelector('[data-splitter]'),
}))()`)
const dragTo = beforeSplit.ratio >= 70 ? -120 : 120
if (beforeSplit.splitter) {
  // 分成三次、每次之间留一拍：React 的状态与 rAF 要在事件之间落地，
  // 一口气同步派发三个事件时 dragging 还没生效，位移会被整个吞掉。
  const pointerAt = (type, offsetY) => evaluate(`(() => {
    const el = document.querySelector('[data-splitter]');
    const rect = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent('${type}', {
      bubbles: true, cancelable: true, pointerId: 1, isPrimary: true,
      clientX: Math.round(rect.left + rect.width / 2), clientY: Math.round(rect.top + ${offsetY}),
    }));
    return true
  })()`)
  await pointerAt('pointerdown', 2)
  await new Promise(r => setTimeout(r, 250))
  await pointerAt('pointermove', dragTo)
  await new Promise(r => setTimeout(r, 250))
  await pointerAt('pointerup', dragTo)
  await new Promise(r => setTimeout(r, 400))
  const afterSplit = await evaluate(`(() => ({
    height: Math.round(document.querySelector('[data-rail-sources]')?.getBoundingClientRect().height ?? 0),
    ratio: Number(document.querySelector('[data-splitter]')?.getAttribute('aria-valuenow') ?? 0),
    stored: localStorage.getItem('dsh-agent-trace:rail-split:v1'),
  }))()`)
  check('拖动分隔条改变上区高度', Math.abs(afterSplit.height - beforeSplit.height) > 20,
    `${beforeSplit.height} → ${afterSplit.height}px（${beforeSplit.ratio}% → ${afterSplit.ratio}%）`)
  // 存的必须是拖完那一刻的比例，不是默认值、也不是上一轮的旧值
  check('分隔比例写进 localStorage', Math.abs(Number(afterSplit.stored) * 100 - afterSplit.ratio) < 1,
    `存储 ${afterSplit.stored}，界面 ${afterSplit.ratio}%`)
} else {
  check('分隔条存在', false, '找不到 [data-splitter]')
}

// —— 工单区跟着来源走：左栏那批工单 = 选中来源名下的工单，不是全部 ——
// 用 id 比对，不看标题：标题可能重名，id 不会。
// limit 与界面一致（SourcePage 取 50）：两边取同一批才不会因为截断互相打架。
const idsOf = async query => fetch(`${origin}/agent-trace/chains?limit=50${query}`)
  .then(r => r.json()).then(d => (d.items ?? []).map(item => item.ticketId)).catch(() => [])
const scopedIds = await idsOf(`&source=${encodeURIComponent(activeSource)}`)
const allIds = await idsOf('')
const railIds = JSON.parse(await evaluate(`JSON.stringify(
  [...document.querySelectorAll('[data-ticket-row]')].map(n => n.getAttribute('data-ticket-row')))`) ?? '[]')
check('左栏工单跟着选中的来源走',
  railIds.length === scopedIds.length && scopedIds.every(id => railIds.includes(id)),
  `左栏 ${railIds.length} 张；该来源 ${scopedIds.length} 张；全部 ${allIds.length} 张`)

// —— 打开工单：从来源页进入覆盖层（不是一次页面切换）——
const wantTitle = process.argv[3]
let pickedItemOk = true
if (wantTitle) {
  pickedItemOk = !!(await evaluate(`(() => {
    const row = [...document.querySelectorAll('[data-ticket-row]')]
      .find(n => (n.getAttribute('title') ?? n.textContent ?? '').includes(${JSON.stringify(wantTitle)}))
    row?.click(); return !!row
  })()`))
} else {
  await evaluate(`document.querySelector('[data-ticket-row]')?.click()`)
}
await new Promise(r => setTimeout(r, 2500))
const overlayOpen = await evaluate(`!!document.querySelector('[data-ticket-overlay]')`)
check('点左栏工单打开覆盖层', overlayOpen)
check('覆盖层打开时来源页仍在（未卸载）',
  await evaluate(`!!document.querySelector('[data-source-page]') && !!document.querySelector('[data-source-pane]')`))
if (wantTitle) check(`能按标题选中「${wantTitle}」`, pickedItemOk)
// 命名空间：工单视图的 data-* 只属于覆盖层，来源页里一个都不许有
check('工单的 data-* 只在覆盖层里',
  await evaluate(`document.querySelector('[data-source-pane] [data-link], [data-source-pane] [data-span], [data-source-pane] [data-legend], [data-source-pane] [data-identity], [data-source-pane] [data-chart-title]') === null`))

// 知会点等比图形晚一拍出现（要等 dispositions 返回），多等一会再收集
await new Promise(r => setTimeout(r, 1500))
const ids = await evaluate(`JSON.stringify([
  ...[...__qa('[data-link]')].map(n => n.getAttribute('data-link')),
  ...[...__qa('[data-span]')].map(n => n.getAttribute('data-span')),
])`)
const elements = JSON.parse(ids ?? '[]')
// 每个元素必须出现的段落标题（来自 doc/07-抽屉内容规格.md）
const REQUIRED = {
  'arrow-trigger': ['消息', '它在工单里的位置'],
  'arrow-ack': ['发出去的话'],
  'arrow-fast': ['消息'],
  'arrow-dispatch': ['发生了什么'],
  'arrow-report': ['报告内容'],
  'arrow-reply': ['发出去的话'],
  notice: ['它收到的'],
  decision: ['判定依据 · 准入 Gate', '研判 Assessment', '决定 Decision'],
  assignment: ['它的动作'],
  subagent: ['它的动作'],
  'state-band': ['这段时间', '为什么是这个状态', '接下来'],
  // 比例带：段与图例都能点开，抽屉里是这条路径的事件清单 + 这条路径的含义
  'path-routed': ['主控评估'],
  'path-direct': ['不经过评估'],
  'path-context': ['不唤醒模型'],
  'path-filtered': ['按原因分组'],
  'event-ended': ['概要'],
  'event-attention': ['概要'],
  'event-delivery': ['概要'],
  'event-retry': ['概要'],
  'event-decision': ['决定 Decision'],
}

const expectedFor = id => {
  if (id.startsWith('state-band')) return REQUIRED['state-band']
  if (id.startsWith('path-')) return REQUIRED[id] ?? []
  if (id.startsWith('arrow-trigger')) return REQUIRED['arrow-trigger']
  if (id.startsWith('arrow-dispatch')) return REQUIRED['arrow-dispatch']
  if (id.startsWith('arrow-report')) return REQUIRED['arrow-report']
  if (id.startsWith('arrow-reply')) return REQUIRED['arrow-reply']
  if (id.startsWith('arrow-fast')) return REQUIRED['arrow-fast']
  if (id.startsWith('notice')) return REQUIRED.notice
  if (id.startsWith('decision')) return REQUIRED.decision
  if (id.startsWith('assignment')) return REQUIRED.assignment
  if (id.startsWith('subagent')) return REQUIRED.subagent
  if (id.startsWith('event-')) {
    // event-retry-<assignmentId> 这类带后缀的 id 按最长前缀匹配
    const hit = Object.entries(REQUIRED).find(([key]) => key.startsWith('event-') && id.startsWith(key))
    return hit?.[1] ?? []
  }
  return REQUIRED[id] ?? []
}

const results = []

/** 点开一个元素、核对抽屉，然后收起。attribute 用来区分同一 id 的两个入口（段 / 图例）。 */
async function openElement(id, attribute = 'data-link') {
  const clicked = await evaluate(`(() => {
    const el = __q('[${attribute}="${id}"]')
      ?? __q('[data-link="${id}"], [data-span="${id}"]');
    if (!el) return false;
    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return true;
  })()`)
  await new Promise(r => setTimeout(r, 600))
  const info = await evaluate(`(() => {
    const drawer = [...__qa('aside')].find(n => n.querySelector('b'));
    if (!drawer) return { ok: false, title: '', rows: 0 };
    const title = drawer.querySelector('b')?.textContent?.trim() ?? '';
    // 内容形状不固定（气泡/徽章/表格/步骤块），只要正文有实质文字就算通过
    const body = drawer.textContent?.replace(title, '').trim() ?? '';
    return { ok: title.length > 0 && body.length > 12, title, rows: body.length, body };
  })()`)
  // 抽屉若只有一句「这一段没有留下可读的记录」，那是约定的降级文案，不按缺段算。
  const degradedOnly = String(info.body ?? '').trim() === '这一段没有留下可读的记录'
  const missing = degradedOnly ? [] : expectedFor(id).filter(sectionTitle => !String(info.body ?? '').includes(sectionTitle))
  results.push({ id, clicked, ...info, missing, ok: info.ok && missing.length === 0 })
  await evaluate(`(() => {
    const drawer = [...__qa('aside')].find(n => n.querySelector('b'));
    drawer?.querySelector('button')?.click();
  })()`)
  await new Promise(r => setTimeout(r, 150))
}

for (const id of elements) await openElement(id)

// 比例带有两个入口：带子上的段、下面的图例。段能点不等于图例能点，图例单独点一遍。
const legends = JSON.parse(
  await evaluate(`JSON.stringify([...__qa('[data-legend]')].map(n => n.getAttribute('data-legend')))`) ?? '[]',
)
for (const id of legends) await openElement(id, 'data-legend')

/**
 * 元素数量必须等于数据决定的预期：图上多画一个、少画一个都算失败。
 * 这条把「通用」变成可执行的断言——换一个来源，只要数据变了，这里就跟着变。
 */
const listItems = await fetch(`${origin}/agent-trace/chains?limit=100`).then(r => r.json()).then(d => d.items ?? []).catch(() => [])
// 页面打开的那条（默认第一条，或按标题选中的那条），断言才对得上
const pickedItem = wantTitle ? listItems.find(item => item.title.includes(wantTitle)) : listItems[0]
const chainData = pickedItem
  ? await fetch(`${origin}/agent-trace/chains/${encodeURIComponent(pickedItem.ticketId)}`)
    .then(r => r.json()).then(d => d?.chain).catch(() => undefined)
  : undefined

if (chainData) {
  const activity = chainData.spans.filter(s => s.role === 'executor' && s.kind === 'activity').length
  const reports = chainData.spans.filter(s => s.role === 'executor' && s.kind === 'activity' && s.reportState).length
  const events = chainData.spans.filter(s => s.kind === 'event').length
  const subagents = chainData.spans.filter(s => s.role === 'subagent').length
  const triggers = Math.max(1, chainData.origins?.length ?? 1)
  const bands = chainData.stateBands?.length ?? 0
  const canReply = chainData.canReply !== false

  const dom = await evaluate(`JSON.stringify({
    trigger: [...__qa('[data-link]')].filter(n => /^arrow-trigger/.test(n.getAttribute('data-link'))).length,
    dispatch: [...__qa('[data-link]')].filter(n => n.getAttribute('data-link').startsWith('arrow-dispatch')).length,
    report: [...__qa('[data-link]')].filter(n => n.getAttribute('data-link').startsWith('arrow-report')).length,
    ack: [...__qa('[data-link]')].filter(n => n.getAttribute('data-link').startsWith('arrow-ack')).length,
    reply: [...__qa('[data-link]')].filter(n => n.getAttribute('data-link').startsWith('arrow-reply')).length,
    bands: [...__qa('[data-link]')].filter(n => n.getAttribute('data-link').startsWith('state-band')).length,
    events: [...__qa('[data-span]')].filter(n => n.getAttribute('data-span').startsWith('event-')).length,
    subagents: [...__qa('[data-span]')].filter(n => n.getAttribute('data-span').startsWith('subagent')).length,
  })`)
  const n = JSON.parse(dom ?? '{}')
  check('触发箭头数 = 来源触发数', n.trigger === triggers, `预期 ${triggers}，实际 ${n.trigger}`)
  check('派工箭头数 = 派工段数', n.dispatch === activity, `预期 ${activity}，实际 ${n.dispatch}`)
  check('报告箭头数 = 有报告的派工段数', n.report === reports, `预期 ${reports}，实际 ${n.report}`)
  check('状态带数 = 数据切段数', n.bands === bands, `预期 ${bands}，实际 ${n.bands}`)
  check('离散事件数 = 事件段数', n.events === events, `预期 ${events}，实际 ${n.events}`)
  check('子代理数', n.subagents === subagents, `预期 ${subagents}，实际 ${n.subagents}`)
  if (!canReply) check('没有回复通道就不画确认/回复', n.ack === 0 && n.reply === 0, `ack ${n.ack} / reply ${n.reply}`)

  // 列头：主控/执行器带英文副名；来源列画的是来源 id，不能重复画一遍同一个词
  const laneLabels = JSON.parse(await evaluate(`JSON.stringify(
    [...__qa('[data-lane]')].map(n => [n.getAttribute('data-lane'), n.textContent ?? '', n.getAttribute('data-lane-en')]))`) ?? '[]')
  const lanes = Object.fromEntries(laneLabels.map(([key, text, en]) => [key, { text, en }]))
  check('主控列头带英文 Router',
    lanes.router?.en === 'Router' && lanes.router?.text === '主控Router', JSON.stringify(lanes.router))
  check('执行器列头带英文 Worker',
    lanes.executor?.en === 'Worker' && lanes.executor?.text === '执行器Worker', JSON.stringify(lanes.executor))
  const sourceLanes = laneLabels.filter(([key]) => key !== 'router' && key !== 'executor')
  check('来源列不重复画同一个词',
    sourceLanes.every(([key, text, en]) => !en && text === key), JSON.stringify(sourceLanes))

  // 负例配色：被源头丢弃的事件是中性灰，不能是「通过」的绿色
  const filteredSwatch = await evaluate(`(() => {
    const item = [...__qa('span')].find(n => /^源头丢弃/.test(n.textContent ?? ''))
    const swatch = item?.querySelector('i')
    return swatch ? getComputedStyle(swatch).backgroundColor : ''
  })()`)
  if (filteredSwatch) {
    check('丢弃项用中性灰，不用通过色', !/rgb\((1[0-9]{2}), 2[0-9]{2}/.test(filteredSwatch), filteredSwatch)
  }

  // 状态带标签：只能落在矩形右侧留白里，且不得与任何块内的字相交（B8 修的重叠）。
  const bandGeom = JSON.parse(await evaluate(`JSON.stringify((() => {
    const others = [...__qa('[data-span] text')].map(t => t.getBoundingClientRect())
    return [...__qa('[data-link^="state-band"]')].map(g => {
      const rect = g.querySelector('rect')
      if (!rect) return null
      const text = g.querySelector('text')
      const r = rect.getBoundingClientRect()
      if (!text) return { hasLabel: false, hasTitle: !!g.querySelector('title') }
      const t = text.getBoundingClientRect()
      const overlap = others.some(o => t.left < o.right && o.left < t.right && t.top < o.bottom && o.top < t.bottom)
      return { hasLabel: true, hasTitle: !!g.querySelector('title'), inside: t.right >= r.right - 1, overlap, label: text.textContent }
    }).filter(Boolean)
  })())`) ?? '[]')
  const labelled = bandGeom.filter(band => band.hasLabel)
  check('状态带标签都在矩形右侧留白', labelled.every(band => band.inside),
    labelled.filter(band => !band.inside).map(band => band.label).join('、'))
  check('状态带标签不压到任何块内文字', labelled.every(band => !band.overlap),
    labelled.filter(band => band.overlap).map(band => band.label).join('、'))
  check('至少有一条状态带画得出标签', labelled.length > 0, `${labelled.length}/${bandGeom.length} 有标签`)
  check('放不下标签的带留了悬停标题', bandGeom.every(band => band.hasLabel || band.hasTitle),
    `${bandGeom.filter(band => !band.hasLabel && !band.hasTitle).length} 条带既无标签也无标题`)

  // 箭头标签不得压在活动块上（B10 修的重叠）：压上了就只能靠白描边兜底。
  const labelGeom = JSON.parse(await evaluate(`JSON.stringify((() => {
    const rects = [...__qa('[data-span] > rect')].map(n => n.getBoundingClientRect())
    return [...__qa('[data-link^="arrow-"]')].map(g => {
      const text = g.querySelector('text')
      if (!text) return null
      const t = text.getBoundingClientRect()
      const overlap = rects.some(r => t.left < r.right - 1 && r.left < t.right - 1 && t.top < r.bottom - 1 && r.top < t.bottom - 1)
      return { label: text.textContent, overlap, halo: getComputedStyle(text).paintOrder === 'stroke' }
    }).filter(Boolean)
  })())`) ?? '[]')
  check('箭头标签不压在活动块上（压上了必须有白描边）',
    labelGeom.every(item => !item.overlap || item.halo),
    labelGeom.filter(item => item.overlap && !item.halo).map(item => item.label).join('、'))

  // 注释行只有一行：徽章必须落在块内，不能被挤出右缘（B10 修的「第二行」）。
  const badgeGeom = JSON.parse(await evaluate(`JSON.stringify(
    [...__qa('[data-span]')].map(g => {
      const rect = g.querySelector('rect')
      const spans = g.querySelectorAll('tspan')
      if (!rect || spans.length === 0) return null
      const r = rect.getBoundingClientRect()
      const t = spans[spans.length - 1].getBoundingClientRect()
      return { badge: spans[spans.length - 1].textContent, overflow: t.right > r.right + 1 }
    }).filter(Boolean)
  )`) ?? '[]')
  check('内联徽章不出块右缘', badgeGeom.every(item => !item.overflow),
    badgeGeom.filter(item => item.overflow).map(item => item.badge).join('、'))

  // 画布不再一味变长（B9）：长链路压到目标高度，刻度按时长取阶、最多 9 条。
  const canvas = JSON.parse(await evaluate(`JSON.stringify((() => {
    // 页面里有很多 16×16 图标 svg；时序图是 viewBox 宽度 >500 的那个。
    const svg = [...__qa('svg')]
      .find(node => Number((node.getAttribute('viewBox') ?? '').split(/\\s+/)[2]) > 500)
    if (!svg) return null
    const [, , , height] = (svg.getAttribute('viewBox') ?? '').split(/\\s+/).map(Number)
    const ticks = [...svg.querySelectorAll('line')]
      .filter(line => line.getAttribute('x1') === '62' && line.getAttribute('x2') === '960').length
    return { height, cssHeight: Math.round(svg.getBoundingClientRect().height), ticks }
  })())`) ?? 'null')
  const durationMs = chainData.endedAt
    ? Date.parse(chainData.endedAt) - Date.parse(chainData.createdAt)
    : 0
  if (!canvas || !Number.isFinite(canvas.height)) {
    check('能取到时序图画布', false, '页面里没有 svg')
  } else {
    check('画布高度不超过硬上限 1200px', canvas.height <= 1200, `viewBox 高 ${canvas.height}px（CSS ${canvas.cssHeight}px）`)
    // 短链路按 34px/秒封顶、长链路压到 600px 内容区，两种形态都该 ≤760px。
    check('画布压到目标高度附近（≤760px）', canvas.height <= 760,
      `时长 ${Math.round(durationMs / 1000)}s，画布 ${canvas.height}px`)
    check('链路带结束时间，时长可核验', Boolean(chainData.endedAt))
    check('刻度至少 2 条（选择器没失配）', canvas.ticks >= 2, `${canvas.ticks} 条`)
    check('刻度不超过 9 条', canvas.ticks <= 9, `${canvas.ticks} 条`)
  }
} else {
  check('能取到链路数据', false, '接口没有返回 chain')
}

/** 模型路由的形状：`provider · model`；降级文案与「推理强度」行都不算。 */
const isRoute = value => /^(?![^\n]*(?:未记录|上下文|会话不可读))[^\s（）]+ · \S+$/.test(value)

// 抽屉只回预览：响应体里除译文外，任何字符串都不得超过预览长度；超长的点开才取全文。
// 派工块（工具返回/想法）与评估块（授权范围/研判理由/证据）都要查——只查一种会漏掉事实行。
const spansToCheck = [
  chainData?.spans?.find(span => span.role === 'executor' && span.kind === 'activity'),
  chainData?.spans?.find(span => span.role === 'router' && span.kind === 'activity'),
].filter(Boolean)
let sawProse = false
if (pickedItem) {
  if (spansToCheck.length === 0) check('能取到块详情', false, '链路里没有可检查的活动块')
  for (const span of spansToCheck) {
    const response = await fetch(`${origin}/agent-trace/spans/${encodeURIComponent(pickedItem.ticketId)}/${encodeURIComponent(span.id)}`)
      .then(r => r.json()).then(d => d?.detail).catch(() => undefined)
    if (!response) {
      check(`能取到块详情（${span.id}）`, false, '接口没有返回 detail')
      continue
    }
    const longStrings = []
    const prose = []
    const walk = (value, path) => {
      if (Array.isArray(value)) { value.forEach((item, index) => walk(item, `${path}[${index}]`)); return }
      if (!value || typeof value !== 'object') return
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'translations') continue
        if (typeof inner === 'string') {
          if (inner.length > 200) longStrings.push(`${path}.${key} (${inner.length})`)
        } else walk(inner, `${path}.${key}`)
      }
      if (typeof value.id === 'string' && typeof value.length === 'number' && value.length > 0) prose.push(value)
    }
    walk(response, 'detail')
    check(`详情响应不带原文（${span.id.slice(0, 16)}…，每段 ≤200 字）`, longStrings.length === 0, longStrings.slice(0, 3).join('、'))
    check(`详情响应体在预算内（${span.id.slice(0, 16)}…）`, JSON.stringify(response).length < 40_000, `${JSON.stringify(response).length} 字节`)
    // 谁在跑：运行方来自会话 header 的 preset，模型来自会话事件（provider · model）
    // 属于谁：抽屉自己回答这块归哪张工单，不用回看画布猜。
    if (span.role === 'executor') {
      const rows = response.facts ?? []
      const runtime = String(rows.find(row => row.label === '运行方')?.value ?? '')
      const route = String(rows.find(row => row.label === '模型路由')?.value ?? '')
      const owner = String(rows.find(row => row.label === '所属')?.value ?? '')
      check(`派工块标出运行方（${span.id.slice(0, 16)}…）`, runtime.includes('DSH 内置'), runtime)
      check(`派工块标出模型路由（${span.id.slice(0, 16)}…）`, isRoute(route), route)
      check(`派工块标出所属工单（${span.id.slice(0, 16)}…）`, owner === `工单 Ticket ${pickedItem.ticketId}`, owner)
    }
    const longest = prose.sort((left, right) => right.length - left.length)[0]
    if (longest) {
      const full = await fetch(`${origin}/agent-trace/texts/${encodeURIComponent(pickedItem.ticketId)}/${encodeURIComponent(longest.id)}`)
        .then(r => r.json()).then(d => d?.text).catch(() => undefined)
      check(`按 id 能取回整段原文（${longest.id.slice(0, 24)}…）`, full?.length === longest.length,
        `id 声明 ${longest.length} 字，实取 ${full?.length ?? 0} 字`)
      sawProse = true
    }
  }
  if (!sawProse) check('详情里有可展开的长正文', false, '没有 length > text 的段落，展开无从验证')

  // 子代理块（有子代理的链路才有）：运行方按它自己会话的 preset 走，模型也读它自己的会话
  const subagentSpan = chainData?.spans?.find(span => span.role === 'subagent')
  if (subagentSpan) {
    const detail = await fetch(`${origin}/agent-trace/spans/${encodeURIComponent(pickedItem.ticketId)}/${encodeURIComponent(subagentSpan.id)}`)
      .then(r => r.json()).then(d => d?.detail).catch(() => undefined)
    const rows = detail?.facts ?? []
    const runtime = String(rows.find(row => row.label === '运行方')?.value ?? '')
    const route = String(rows.find(row => row.label === '模型路由')?.value ?? '')
    const owner = String(rows.find(row => row.label === '所属')?.value ?? '')
    check('子代理块标出运行方', runtime.includes('DSH 内置'), runtime)
    check('子代理块标出模型路由', isRoute(route), route)
    check('子代理块标出所属工单与子代理身份', owner === `工单 Ticket ${pickedItem.ticketId} · 子代理`, owner)
  }

  // 不点抽屉也要知道这是哪张工单：标题下第一行是身份行，带 Ticket 与完整 id
  const identity = String(await evaluate(`__q('[data-identity]')?.textContent?.trim() ?? ''`))
  check('标题下有工单身份行（带 Ticket 与完整 id）',
    identity.includes(`工单 Ticket ${pickedItem.ticketId}`), identity)

  // 画布左上角要有图名：标题区只有工单标题，不看画布不知道这是什么图
  const chartTitle = String(await evaluate(
    `__q('[data-chart-title]')?.textContent?.trim() ?? ''`))
  check('画布左上角标出图名「工单时序图」', chartTitle === '工单时序图', chartTitle || '没有图名')

  // 抽屉的公共读法：点开 → 取整段文字 / 取某一行自己的值 → 收起。
  const openSpan = async id => {
    await evaluate(`(() => {
      const el = __q('[data-span="${id}"]');
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!el;
    })()`)
    await new Promise(r => setTimeout(r, 700))
  }
  const drawerText = () => evaluate(`(() => {
    const drawer = [...__qa('aside')].find(n => n.querySelector('b'));
    return drawer?.textContent ?? '';
  })()`)
  const closeDrawer = async () => {
    await evaluate(`(() => {
      const drawer = [...__qa('aside')].find(n => n.querySelector('b'));
      drawer?.querySelector('button')?.click();
    })()`)
    await new Promise(r => setTimeout(r, 200))
  }

  // 事件箭头先回答「它为什么在这张图上」：所有事件箭头里必须有一支是本工单的起点，
  // 且没有任何一支落到「归属没有记录」（batch 时索引 0 不一定是起点）。
  const triggerLinkIds = elements.filter(id => /^arrow-trigger(?:-\d+)?$/.test(id))
  if (triggerLinkIds.length > 0) {
    let sawOrigin = false
    let orphan = ''
    let blank = ''
    for (const id of triggerLinkIds) {
      await evaluate(`(() => {
        const el = __q('[data-link="${id}"]');
        el?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!el;
      })()`)
      await new Promise(r => setTimeout(r, 700))
      const text = String(await drawerText()).trim()
      // 空抽屉既不算孤儿也不算起点：单独记下来，别让它混进「另一支说了起点」的绿里。
      if (!text && !blank) blank = id
      if (text.includes('本工单的起点事件：')) sawOrigin = true
      if (text.includes('归属没有记录') && !orphan) orphan = `${id}: ${text.slice(0, 100)}`
      await closeDrawer()
    }
    check('事件箭头里有一支说明它是本工单的起点、且没有孤儿/空抽屉箭头',
      sawOrigin && !orphan && !blank,
      orphan || (blank ? `${blank}: 抽屉为空` : sawOrigin ? `${triggerLinkIds.length} 支` : '没有一支说起点'))
  }

  // 评估抽屉先回答从哪来 / 属于谁：概要里要有主控会话、评估对象、产出工单
  const decisionId = elements.find(id => id.startsWith('decision'))
  if (decisionId) {
    await openSpan(decisionId)
    const text = String(await drawerText())
    check('评估抽屉的概要回答从哪来 / 属于谁（评估会话、评估对象、产出）',
      text.includes('评估会话') && text.includes('评估对象') && text.includes('产出'), text.slice(0, 80))
    // 只认同一个「产出」行自己的值：别处出现「工单 Ticket」不算（路由决定那行也带 id）。
    const output = String(await evaluate(`(() => {
      const item = [...__qa('aside')].find(n => n.querySelector('b'))?.querySelector('[data-fact="产出"]');
      return item?.querySelectorAll(':scope > div')[1]?.textContent?.trim() ?? '';
    })()`))
    check('评估抽屉的产出自报工单 Ticket', output === `工单 Ticket ${pickedItem.ticketId}`, output || '没有产出行')
    await closeDrawer()
  } else {
    console.log('…这张工单没有评估块，跳过评估抽屉断言')
  }
}

// 抽屉关闭：Esc 与点外部都要收起
const firstId = elements[0]
if (firstId) {
  const open = async () => evaluate(`(() => {
    const el = __q('[data-link="${firstId}"], [data-span="${firstId}"]');
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!el;
  })()`)
  const isOpen = () => evaluate(`!!__q('aside b')`)
  await open(); await new Promise(r => setTimeout(r, 500))
  check('点击能打开抽屉', await isOpen())
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await new Promise(r => setTimeout(r, 300))
  check('Esc 收起抽屉', !(await isOpen()))
  await open(); await new Promise(r => setTimeout(r, 500))
  await evaluate(`document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`)
  await new Promise(r => setTimeout(r, 300))
  check('点外部收起抽屉', !(await isOpen()))
} else {
  check('页面上有可点元素', false)
}

// 展开原文：默认只有预览，点一次「展开原文」才取全文，抽屉变长、按钮变「收起」。
const assignId = elements.find(id => id.startsWith('assignment'))
if (assignId) {
  const snapshot = () => evaluate(`(() => {
    const drawer = [...__qa('aside')].find(n => n.querySelector('b'));
    const btn = [...(drawer?.querySelectorAll('button') ?? [])].find(b => /^(展开原文|收起|读取中)/.test(b.textContent ?? ''));
    return {
      chars: drawer?.textContent?.length ?? 0,
      height: Math.round(drawer?.getBoundingClientRect().height ?? 0),
      button: btn?.textContent?.trim() ?? '',
      prose: [...(drawer?.querySelectorAll('div') ?? [])].map(n => n.textContent ?? '').sort((a, b) => b.length - a.length)[0]?.length ?? 0,
    };
  })()`)
  await evaluate(`(() => {
    const el = __q('[data-span="${assignId}"]');
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`)
  await new Promise(r => setTimeout(r, 900))
  const before = await snapshot()
  if (!/^展开原文/.test(before.button)) {
    check('抽屉里有「展开原文」按钮', false, `按钮文案：${before.button || '(无)'}`)
  } else {
    await evaluate(`(() => {
      const drawer = [...__qa('aside')].find(n => n.querySelector('b'));
      [...(drawer?.querySelectorAll('button') ?? [])].find(b => /^展开原文/.test(b.textContent ?? ''))?.click();
    })()`)
    await new Promise(r => setTimeout(r, 1500))
    const after = await snapshot()
    check('点「展开原文」后按钮变「收起」', after.button === '收起', after.button)
    check('展开后抽屉变长（拿到全文）',
      after.chars > before.chars && after.prose > before.prose && after.height >= before.height,
      `正文 ${before.prose} → ${after.prose} 字，抽屉 ${before.height} → ${after.height}px`)
    check('展开的正文超过预览上限', after.prose > 200, `${after.prose} 字`)
  }
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
}

// —— Esc 的层级：抽屉套在覆盖层上，一个 Esc 只能关一层 ——
check('展开原文之后覆盖层仍在', await evaluate(`!!document.querySelector('[data-ticket-overlay]')`))
if (firstId) {
  await evaluate(`(() => {
    const el = __q('[data-link="${firstId}"], [data-span="${firstId}"]');
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  })()`)
  await new Promise(r => setTimeout(r, 600))
  check('抽屉可以再次打开', await evaluate(`!!__q('aside b')`))
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await new Promise(r => setTimeout(r, 300))
  check('第一个 Esc 只关抽屉，覆盖层还在',
    !(await evaluate(`!!__q('aside b')`)) && await evaluate(`!!document.querySelector('[data-ticket-overlay]')`))
} else {
  check('抽屉可再次打开', false, '没有可点元素')
}
await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
await new Promise(r => setTimeout(r, 500))
check('第二个 Esc 退回来源页，源视图恢复可见',
  !(await evaluate(`!!document.querySelector('[data-ticket-overlay]')`))
  && await evaluate(`(() => {
    const pane = document.querySelector('[data-source-pane]');
    return !!pane && getComputedStyle(pane).visibility === 'visible'
  })()`))

// —— 来源页：事件流与事件抽屉（事实 / 解释 / 没记录的事实）——
await new Promise(r => setTimeout(r, 600))
const eventRows = await evaluate(`document.querySelectorAll('[data-event]').length`)
check('来源页有事件行', eventRows > 0, `${eventRows} 行`)

const filteredRow = await evaluate(`(() => {
  const row = document.querySelector('[data-event][data-fate="filtered"]');
  row?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!row
})()`)
if (filteredRow) {
  await new Promise(r => setTimeout(r, 900))
  const eventDrawerText = String(await evaluate(`(() => {
    const d = [...document.querySelectorAll('aside')].find(n => n.querySelector('b'));
    return d?.textContent ?? ''
  })()`))
  // 逐节查标题，不用整段文本 substring：「解释」两个字在正文里也会出现。
  const drawerSections = JSON.parse(await evaluate(`JSON.stringify(
    [...document.querySelectorAll('[data-drawer-section]')].map(n => n.getAttribute('data-drawer-section')))`) ?? '[]')
  check('事件抽屉分「事实 / 解释 / 没记录的事实」',
    ['事实', '解释', '没记录的事实'].every(part => drawerSections.includes(part)), drawerSections.join(' / '))
  // 解释句不许混进事实段：这两段分开是本页的硬约束（D-35）。
  check('解释句没有混进事实段',
    await evaluate(`(() => {
      const head = [...document.querySelectorAll('[data-drawer-section]')]
        .find(n => n.getAttribute('data-drawer-section') === '事实');
      return !head?.parentElement?.querySelector('[data-interp]')
    })()`))
  check('丢弃事件给出原因码解释与「没有设置快照」的声明',
    eventDrawerText.includes('no_mention') && eventDrawerText.includes('设置快照'))
} else {
  console.log('…这个来源没有源头丢弃的事件，跳过事件抽屉断言（夹具跑会覆盖）')
}

// 事件行上的工单小徽章：直接开覆盖层，顺手把事件抽屉收起来
const chipClicked = await evaluate(`(() => {
  const chip = document.querySelector('[data-source-view] [data-ticket-chip]');
  chip?.dispatchEvent(new MouseEvent('click', { bubbles: true })); return !!chip
})()`)
check('事件行带工单小徽章', chipClicked)
if (chipClicked) {
  await new Promise(r => setTimeout(r, 2500))
  check('点工单小徽章直接打开覆盖层', await evaluate(`!!document.querySelector('[data-ticket-overlay]')`))
  check('开覆盖层时事件抽屉已收起',
    await evaluate(`![...document.querySelectorAll('aside')].some(n => n.querySelector('b'))`))
  await evaluate(`document.querySelector('[data-ticket-overlay]')?.querySelector('button')?.click()`)
  await new Promise(r => setTimeout(r, 900))
  check('「← 返回来源」回到来源页',
    !(await evaluate(`!!document.querySelector('[data-ticket-overlay]')`))
    && await evaluate(`!!document.querySelector('[data-source-view]')`))
}

// 比例带图例就是筛选器：点一次只看这一类，再点恢复
const totalRows = await evaluate(`document.querySelectorAll('[data-event]').length`)
const legendKind = String(await evaluate(`document.querySelector('[data-fate-legend]')?.getAttribute('data-fate-legend') ?? ''`))
await evaluate(`document.querySelector('[data-fate-legend]')?.click()`)
await new Promise(r => setTimeout(r, 500))
const filteredRows = await evaluate(`document.querySelectorAll('[data-event]').length`)
check('点图例后只剩这一类事件', !!legendKind && filteredRows > 0 && filteredRows < totalRows,
  `${legendKind}: ${totalRows} → ${filteredRows}`)
await evaluate(`document.querySelector('[data-fate-legend]')?.click()`)
await new Promise(r => setTimeout(r, 500))
check('再点一次恢复全部事件',
  (await evaluate(`document.querySelectorAll('[data-event]').length`)) === totalRows, `${totalRows} 行`)

const failedExtras = extras.filter(item => !item.ok)
for (const item of extras) console.log(`${item.ok ? '✔' : '✖'} ${item.name}${item.detail ? `  ${item.detail}` : ''}`)

const failed = results.filter(item => !item.ok)
for (const item of results) {
  console.log(`${item.ok ? '✔' : '✖'} ${item.id}  ${item.title || '(无标题)'}${item.missing?.length ? `  缺段落: ${item.missing.join('、')}` : ''}`)
}
const totalCount = results.length + extras.length
const passCount = totalCount - failed.length - failedExtras.length
console.log(`\n${passCount}/${totalCount} 通过`)
socket.close()
process.exit(failed.length === 0 && failedExtras.length === 0 ? 0 : 1)
