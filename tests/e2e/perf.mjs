/**
 * 性能实测（M4 §6.2 预算）。用法：
 *   node tests/e2e/perf.mjs <url> [轮数]
 *
 * 只测**界面上真实发生的事**：点侧边栏 → 左栏出现、点工单 → 覆盖层出现、
 * 覆盖层里滚动取样帧间隔。不模拟假数据，不拿接口耗时冒充首屏。
 *
 * 输出最后一行是 JSON，方便抄进文档；人读的是上面的表格。
 */
const PORT = 9333
const url = process.argv[2]
const ROUNDS = Number(process.argv[3] ?? 3)
if (!url) { console.error('用法：node tests/e2e/perf.mjs <url> [轮数]'); process.exit(2) }

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
await send('Network.enable')
await send('Network.setCacheDisabled', { cacheDisabled: true })
// headless 页默认 `visibilityState === 'hidden'`，rAF 被暂停：
// 只 bringToFront 不够（实测仍 hidden），要加焦点模拟，visibility 才会变 visible。
await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
await send('Page.bringToFront')

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

/** 每个来源都重开一次页面：首屏要从「点了侧边栏」算起，不能沾上一次的缓存与挂载。 */
const openRail = async () => {
  await send('Page.navigate', { url })
  await send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {})
  await send('Page.bringToFront')
  await new Promise(r => setTimeout(r, 3500))
  // 侧边栏入口要先挂出来；点开它，用 rAF 轮询第一行来源出现的时刻。
  return evaluate(`new Promise(resolve => {
    const entry = () => [...document.querySelectorAll('button,a,div,span')]
      .find(n => n.textContent?.trim() === '来源与工单')
    let t0 = 0
    const start = () => {
      t0 = performance.now()
      entry()?.click()
      requestAnimationFrame(tick)
    }
    // 用定时器轮询，不用 rAF：page 被后台化时 rAF 会停，整个脚本会挂死。
    setTimeout(() => resolve(-1), 9000)
    const tick = () => {
      if (document.querySelector('[data-source-row]')) return resolve(performance.now() - t0)
      if (performance.now() - t0 > 8000) return resolve(-1)
      setTimeout(tick, 4)
    }
    if (entry()?.click) start()
    else resolve(-1)
  })`)
}

/** 打开左栏第 index 张工单，量到覆盖层里画出第一个节点为止。 */
const openTicketAt = async index => evaluate(`new Promise(resolve => {
  const row = [...document.querySelectorAll('[data-ticket-row]')][${index}]
  if (!row) return resolve({ ms: -1, spans: 0, label: '' })
  const label = row.textContent?.trim().slice(0, 20) ?? ''
  const t0 = performance.now()
  setTimeout(() => resolve({ ms: -1, spans: 0, label }), 12000)
  row.click()
  const tick = () => {
    const overlay = document.querySelector('[data-ticket-overlay]')
    const spans = overlay?.querySelectorAll('[data-span]').length ?? 0
    if (overlay && spans > 0) return resolve({ ms: performance.now() - t0, spans, label })
    setTimeout(tick, 4)
  }
  setTimeout(tick, 4)
})`)

const closeOverlay = async () => {
  await evaluate(`(() => {
    const overlay = document.querySelector('[data-ticket-overlay]')
    const back = [...(overlay?.querySelectorAll('button') ?? [])]
      .find(button => button.textContent?.includes('返回来源'))
    back?.click()
    return true
  })()`)
  await new Promise(r => setTimeout(r, 250))
}

/**
 * 滚动取样：把覆盖层里所有可滚动的容器都来回滚，rAF 记录帧间隔。
 * 同时报出链路节点数——帧率离开节点数没有意义。
 */
const sampleScroll = async (durationMs = 2500) => evaluate(`new Promise(resolve => {
  const overlay = document.querySelector('[data-ticket-overlay]')
  if (!overlay) return resolve({ fps: -1, p95Ms: -1, nodes: 0, frames: 0 })
  const scrollers = [...overlay.querySelectorAll('*')].filter(n => n.scrollHeight - n.clientHeight > 40)
  const nodes = overlay.querySelectorAll('[data-span]').length
  const deltas = []
  let last = performance.now()
  let dir = 1
  const end = last + ${durationMs}
  // 同样的兜底：rAF 停了也要在预算时间后给出结果，不能让调用方永久等待。
  setTimeout(() => resolve({ deltas, nodes, frames: deltas.length, scrollers: scrollers.length }), ${durationMs} + 2000)
  const step = () => {
    const now = performance.now()
    deltas.push(now - last)
    last = now
    for (const node of scrollers) {
      node.scrollTop += dir * 24
      if (node.scrollTop <= 0) dir = 1
      if (node.scrollTop + node.clientHeight >= node.scrollHeight - 1) dir = -1
    }
    if (now < end) requestAnimationFrame(step)
    else {
      deltas.shift()
      resolve({ deltas, nodes, frames: deltas.length, scrollers: scrollers.length })
    }
  }
  requestAnimationFrame(step)
})`)

const railMs = []
for (let round = 0; round < ROUNDS; round += 1) railMs.push(await openRail())

// 每个来源的工单都开一遍：只测当前来源、只测第一张，会漏掉更重的链路。
const sourceIds = JSON.parse(
  await evaluate(`JSON.stringify([...document.querySelectorAll('[data-source-row]')]
    .map(row => row.getAttribute('data-source-row')))`) ?? '[]')
const origin = new URL(url).origin
const tickets = []
for (const sourceId of sourceIds) {
  // 切来源后旧工单行还在，等「行集合 = 接口给这个来源的集合」才算切换完成（最多 4s）。
  const expected = await fetch(`${origin}/agent-trace/chains?limit=50&source=${encodeURIComponent(sourceId)}`)
    .then(response => response.json()).then(data => (data.items ?? []).map(item => item.ticketId))
    .catch(() => null)
  const rowCount = await evaluate(`new Promise(resolve => {
    [...document.querySelectorAll('[data-source-row]')]
      .find(row => row.getAttribute('data-source-row') === ${JSON.stringify(sourceId)})?.click()
    const want = ${JSON.stringify(expected ?? null)}
    const ids = () => [...document.querySelectorAll('[data-ticket-row]')]
      .map(row => row.getAttribute('data-ticket-row'))
    const t0 = performance.now()
    const ok = () => want === null ? ids().length > 0
      : (ids().length === want.length && want.every(id => ids().includes(id)))
    const tick = () => {
      if (ok() || performance.now() - t0 > 4000) return resolve(ids().length)
      setTimeout(tick, 20)
    }
    tick()
  })`) ?? 0
  for (let index = 0; index < rowCount; index += 1) {
    const opened = await openTicketAt(index)
    tickets.push({ ...opened, source: sourceId, index })
    await closeOverlay()
  }
}
const ticketTimes = tickets.map(item => item.ms).filter(ms => ms >= 0)
const ticketMedian = ticketTimes.length ? median(ticketTimes) : -1
const ticketWorst = ticketTimes.length ? Math.max(...ticketTimes) : -1

// 滚动取样要有一张开着覆盖层的工单：开节点最多的那张。
const heaviest = tickets.reduce((best, item) => (item.spans > (best?.spans ?? -1) ? item : best), null)
if (heaviest) {
  // 左栏当前停在最后一个来源上：先把来源切回它自己那张工单所在的来源。
  await evaluate(`new Promise(resolve => {
    [...document.querySelectorAll('[data-source-row]')]
      .find(row => row.getAttribute('data-source-row') === ${JSON.stringify(heaviest.source)})?.click()
    setTimeout(resolve, 400)
  })`)
  await openTicketAt(heaviest.index)
}
const scroll = await sampleScroll()
const deltas = scroll.deltas ?? []
const fps = deltas.length ? 1000 / median(deltas) : -1

const result = {
  rounds: ROUNDS,
  railMs: { values: railMs, median: median(railMs) },
  ticketMs: { values: ticketTimes, median: ticketMedian, worst: ticketWorst, tickets },
  scroll: {
    nodes: scroll.nodes,
    scrollers: scroll.scrollers,
    frames: scroll.frames,
    fps: Number(fps.toFixed(1)),
    p95FrameMs: deltas.length ? Number(percentile(deltas, 0.95).toFixed(1)) : -1,
  },
}

console.log(`左栏首屏（点侧边栏→来源行）  ${result.railMs.median.toFixed(0)} ms（3 轮）      < 100 ms      ${result.railMs.median >= 0 && result.railMs.median < 100 ? '✅' : '未测到'}`)
console.log(`打开工单（点行→链路画出）    中位 ${ticketMedian.toFixed(0)} ms / 最慢 ${ticketWorst.toFixed(0)} ms（${ticketTimes.length} 张）  < 1000 ms  ${ticketWorst >= 0 && ticketWorst < 1000 ? '✅' : (ticketWorst < 0 ? '未测到' : '❌')}`)
for (const item of tickets) console.log(`  · ${item.label || '(无标题)'} — ${item.ms.toFixed(0)} ms / ${item.spans} 节点`)
console.log(`滚动帧率                      ${scroll.scrollers > 0 ? `${fps.toFixed(1)} fps（${scroll.nodes} 节点）` : '未测到：当前数据没有需要滚动的内容'}        ≥ 55 fps      ${scroll.scrollers > 0 ? (fps >= 55 ? '✅' : '❌') : 'UNVERIFIED'}`)
if (scroll.scrollers > 0) console.log(`  （p95 帧间隔 ${result.scroll.p95FrameMs} ms，${scroll.frames} 帧）`)
console.log(`PERF ${JSON.stringify(result)}`)

socket.close()
