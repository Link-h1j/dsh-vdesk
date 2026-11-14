// reload-dsh.mjs -- reload the DSH desktop renderer over CDP.
// Requires DSH to run with --remote-debugging-port=9222 (tools/restart-dsh-debug.ps1 does that).
// Usage: node tools/reload-dsh.mjs [port]
const port = process.argv[2] || '9222'
const base = 'http://127.0.0.1:' + port
let list
try {
  list = await (await fetch(base + '/json/list')).json()
} catch (e) {
  console.error('CDP 不可达（DSH 没带调试端口运行？）: ' + (e && e.message))
  process.exit(2)
}
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) {
  console.error('没有 page target；targets=' + JSON.stringify(list.map((t) => t.type)))
  process.exit(3)
}
console.log('target: ' + (page.title || '(no title)') + '  ' + page.url)
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => {
  ws.onopen = res
  ws.onerror = (e) => rej(new Error('ws error'))
  setTimeout(() => rej(new Error('ws timeout')), 8000)
})
const send = (id, method, params) => ws.send(JSON.stringify({ id, method, params }))
send(1, 'Page.enable')
send(2, 'Page.reload', { ignoreCache: true })
await new Promise((r) => setTimeout(r, 1200))
try { ws.close() } catch {}
console.log('reload sent')