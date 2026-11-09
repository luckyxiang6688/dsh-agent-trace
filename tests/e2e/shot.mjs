/**
 * 最小 E2E 工具：CDP 打开实例 → 点侧边栏条目 → 截图。
 * 不依赖 Playwright；Node 24 自带 WebSocket。
 * 用法：node tests/e2e/shot.mjs <url> <输出 png> [要点击的文本]
 */
import { writeFileSync } from 'node:fs'

const [url, out, label = '来源与工单', second] = process.argv.slice(2)
const PORT = 9333

const target = await (async () => {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(response => response.json())
      const page = list.find(item => item.type === 'page')
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
    } catch { /* 还没起来，继续等 */ }
    await new Promise(resolve => setTimeout(resolve, 250))
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
  const requestId = ++sequence
  pending.set(requestId, message => (message.error ? reject(new Error(message.error.message)) : resolve(message.result)))
  socket.send(JSON.stringify({ id: requestId, method, params }))
})

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url })
await new Promise(resolve => setTimeout(resolve, 5000))

const click = async (want) => {
  const result = await send('Runtime.evaluate', {
    expression: `(() => {
      const want = ${JSON.stringify(want)};
      const byAttr = document.querySelector('[data-span]');
      if (want === '__span__' && byAttr) { byAttr.dispatchEvent(new MouseEvent('click', { bubbles: true })); return 'clicked-span'; }
      const all = [...document.querySelectorAll('button,a,div,span')];
      const hit = all.find(node => node.textContent?.trim() === want && node.offsetParent !== null);
      if (!hit) return 'not-found';
      hit.click();
      return 'clicked';
    })()`,
    returnByValue: true,
  })
  console.error(`click "${want}":`, result.result?.value)
  await new Promise(resolve => setTimeout(resolve, 3000))
}
await click(label)
if (second) await click(second)

const shot = await send('Page.captureScreenshot', { format: 'png' })
writeFileSync(out, Buffer.from(shot.data, 'base64'))
console.error('saved:', out)
socket.close()
