/**
 * 隔离页验证：500 节点滚动帧率、事件抽屉的跨来源标签、渲染错误的兜底界面。
 *
 * 为什么用隔离页而不是真实实例：500 个节点的链路要往 `.dsh-home` 里造数据，
 * 那是宿主的库，不在测试里动。隔离页加载的是**同一份**组件产物（tests/perf/harness/entry.ts
 * 直接 import `src/client/*`），只把 `fetch` 换成合成数据。
 *
 * 用法：node tests/e2e/harness.mjs [--out 截图目录]
 * 前置：headless Chrome 的 CDP 在 9333（align.mjs 同样依赖它）。
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PLUGIN = resolve(HERE, '../..')
const OUT = resolve(PLUGIN, 'tmp/harness')
const SHOTS = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : join(OUT, 'shots')
const PORT = 9333
const COUNT = 500

// —— 1. 打一份隔离页产物（react 一起打进去）——
await new Promise((resolvePromise, reject) => {
  const child = spawn('node', ['node_modules/tsdown/dist/run.mjs', '-c', 'tests/perf/harness/tsdown.config.ts'], {
    cwd: PLUGIN, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.on('close', code => (code === 0 ? resolvePromise() : reject(new Error(`构建失败：\n${output}`))))
})

// 构建会 clean 掉 tmp/harness，截图目录必须在构建之后再建。
mkdirSync(SHOTS, { recursive: true })

const bundle = join(OUT, 'harness.iife.js')
const html = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;font:13px -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2937;background:#f7f8fa}
#root{height:700px;overflow:auto;background:#f7f8fa}</style></head>
<body><div id="root"></div><script src="${bundle}"></script></body></html>`
const pagePath = join(OUT, 'index.html')
writeFileSync(pagePath, html)

// —— 2. 连一个新标签页 ——
const created = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' })
  .then(r => r.json())
const socket = new WebSocket(created.webSocketDebuggerUrl)
await new Promise((resolvePromise, reject) => {
  socket.addEventListener('open', resolvePromise, { once: true })
  socket.addEventListener('error', reject, { once: true })
})
let sequence = 0
const pending = new Map()
socket.addEventListener('message', event => {
  const message = JSON.parse(String(event.data))
  const settle = pending.get(message.id)
  if (settle) { pending.delete(message.id); settle(message) }
})
const send = (method, params = {}) => new Promise((resolvePromise, reject) => {
  const id = ++sequence
  const timer = setTimeout(() => {
    pending.delete(id)
    reject(new Error(`${method} 超过 20s 未返回（浏览器是否已退出？）`))
  }, 20000)
  pending.set(id, message => {
    clearTimeout(timer)
    message.error ? reject(new Error(`${method}: ${message.error.message}`)) : resolvePromise(message.result)
  })
  socket.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression, timeoutMs = 15000) => {
  const work = (async () => {
    const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.text))
    return result.result?.value
  })()
  // 浏览器一旦崩掉（本轮实测 Chrome 会自己退出），CDP 的回应永远不会来，
  // 没有这条超时就会「无输出、无退出码」地挂住；宁可报错退出。
  const timer = new Promise((_, reject) => setTimeout(
    () => reject(new Error(`evaluate 超过 ${timeoutMs}ms 未返回：${expression.slice(0, 80)}`)), timeoutMs))
  return Promise.race([work, timer])
}
const shot = async name => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'))
}

await send('Page.enable')
await send('Runtime.enable')
// headless 页默认 visibilityState=hidden，rAF 会被暂停：不打开就永远等不到一帧。
await send('Emulation.setFocusEmulationEnabled', { enabled: true })
await send('Page.bringToFront')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? `  ${detail}` : ''}`)
}

/** 打开某个模式并等组件画出东西。 */
async function open(mode, query = '') {
  // 只改 hash 不会重新加载文档（同文档内的 fragment 跳转），会拿上一次的 DOM 冒充结果；
  // 每次都换一个查询参数，强制整页重来。
  const run = `run=${Date.now()}`
  const bust = `${query ? '&' : '?'}${run}`
  await send('Page.navigate', { url: `file://${pagePath}${query}${bust}#${mode}` })
  for (let attempt = 0; attempt < 80; attempt += 1) {
    // 导航返回时新文档未必已 commit，旧执行上下文的 __ready 会是 true（上一个模式留下的）；
    // 先确认 location 里确实是我们这一次的 run token，再看 __ready。
    const ready = await evaluate(
      `location.search.includes(${JSON.stringify(run)}) && !!window.__ready`).catch(() => false)
    if (ready) {
      // 每次导航后重设焦点模拟：rAF 一旦被暂停，采样会挂住（脚本内另有定时器兜底）。
      await send('Emulation.setFocusEmulationEnabled', { enabled: true })
      await send('Page.bringToFront')
      return
    }
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error(`隔离页没就绪：${mode}`)
}

// —— 3. 事件抽屉：跨来源关联工单要标来源，同来源不标 ——
await open('drawer')
const drawerText = String(await evaluate('document.querySelector("[data-drawer]")?.innerText ?? ""'))
check('抽屉里有「关联工单」段', drawerText.includes('关联工单'))
check('同来源工单不标来源', drawerText.includes('同源工单 · c5faef17') && !drawerText.includes('同源工单 · c5faef17 · 来源'))
check('跨来源工单标出来源', drawerText.includes('跨源工单 · f18e5e3c · 来源 demo'), drawerText.split('\n').filter(line => line.includes('来源')).join(' | '))
await shot('drawer-cross-source')

// —— 4. 渲染抛错：真实 TicketOverlay 与真实 Panel 的接线，各断一次 ——
//
// 这一条喂的是 `spans: null`（形状坏掉的真实响应），渲染的是生产代码里的
// `TicketOverlay`，不是重抄的一份 fallback——否则边界被挪走、顶栏被一起兜掉，测试照样绿。
await open('crash')
const crashText = String(await evaluate('document.body.innerText'))
check('覆盖层内兜底出现', crashText.includes('这张工单画不出来'), crashText.replace(/\n/g, ' | '))
check('兜底带标记，便于以后断言', await evaluate('!!document.querySelector("[data-boundary=ticket]")'))
check('顶栏「返回来源」还在兜底之外', await evaluate(
  '[...document.querySelectorAll("button")].some(b => b.textContent.includes("返回来源"))'))

// 左栏在覆盖层打开时仍可点：换一张工单只改 ticketId。边界状态若没跟着换，上一张的崩溃会一直盖住下一张。
await evaluate('window.__switchTicket("synthetic-500")')
let switched = false
for (let attempt = 0; attempt < 60; attempt += 1) {
  const ok = await evaluate(
    '!document.querySelector("[data-boundary=ticket]") && document.querySelectorAll("[data-span]").length > 0')
  if (ok) { switched = true; break }
  await new Promise(r => setTimeout(r, 100))
}
check('上一张崩过，换一张仍能画（边界状态不粘）', switched)

await evaluate('[...document.querySelectorAll("button")].find(b => b.textContent.includes("返回来源")).click()')
check('崩溃时「返回来源」仍能关掉覆盖层', await evaluate('!!window.__closed'))
await shot('boundary-fallback')

// 面板根边界同理：喂 `counts: null` 让 SourcePage 渲染抛错，渲染的是 `mount.tsx` 的真实 Panel。
await open('crash-panel')
const panelText = String(await evaluate('document.body.innerText'))
check('面板根兜底出现', panelText.includes('页面渲染出错'), panelText.replace(/\n/g, ' | '))
check('面板兜底带标记', await evaluate('!!document.querySelector("[data-boundary=panel]")'))
await shot('boundary-panel')

// 抽屉单独兜一层：坏掉的只是一条事件详情，左栏与来源列表不能跟着消失。
await open('crash-drawer')
await evaluate('document.querySelector("[data-event=\\"tr-broken\\"]").click()')
let drawerCrashed = false
for (let attempt = 0; attempt < 60; attempt += 1) {
  if (await evaluate('!!document.querySelector("[data-boundary=drawer]")').catch(() => false)) {
    drawerCrashed = true
    break
  }
  await new Promise(r => setTimeout(r, 100))
}
check('抽屉兜底出现', drawerCrashed)
check('抽屉兜底时面板其余部分仍在', await evaluate(
  '!!document.querySelector("[data-source-page]") && document.querySelectorAll("[data-source-row]").length > 0'))
await shot('boundary-drawer')
await evaluate('document.querySelector("[data-boundary=drawer] button").click()')
check('抽屉兜底留了关闭入口', await evaluate('!document.querySelector("[data-boundary=drawer]")'))

// —— 5. 500 节点：渲染成本与滚动帧率 ——
await open('scroll', `?count=${COUNT}`)
const spanCount = Number(await evaluate('window.__spanCount ?? 0'))
const renderMs = Number(await evaluate('window.__renderMs ?? -1'))
check(`画出 ${COUNT} 个节点`, spanCount === COUNT, `实际 ${spanCount}`)
check('渲染耗时 < 1000ms（首屏预算）', renderMs >= 0 && renderMs < 1000, `${renderMs.toFixed(1)} ms`)

check('量的是时序图自己的滚动容器', await evaluate('!!document.querySelector("[data-scroller]")'))
const scroll = await evaluate('window.__measureScroll(3000)')
check('滚动采样没有靠定时器兜底退出', !scroll?.timedOut,
  `frames=${scroll?.frames?.length ?? 0}`)
if (!scroll?.scrollable) {
  check('内容可滚动', false, `scrollHeight=${scroll?.scrollHeight} clientHeight=${scroll?.clientHeight}`)
} else {
  const frames = (scroll.frames ?? []).slice(2) // 前两帧含启动抖动
  const sorted = [...frames].sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  const fps = 1000 / median
  check('500 节点滚动 ≥ 55fps', fps >= 55,
    `fps=${fps.toFixed(1)}（中位帧 ${median.toFixed(1)}ms，p95 ${p95.toFixed(1)}ms，${frames.length} 帧）`)
  check('内容可滚动', true, `scrollHeight=${scroll.scrollHeight} clientHeight=${scroll.clientHeight}`)
}
await shot('scroll-500')

await send('Page.close').catch(() => {})
socket.close()

const failed = results.filter(item => !item.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
console.log(`截图：${SHOTS}`)
process.exit(failed.length === 0 ? 0 : 1)
