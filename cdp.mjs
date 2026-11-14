// cdp.mjs -- minimal CDP driver for the DSH desktop renderer (needs --remote-debugging-port=9222).
//   node cdp.mjs eval "<js>"          evaluate an expression, print the JSON result
//   node cdp.mjs eval-file <file>     same, expression read from a file
//   node cdp.mjs reload               Page.reload (ignoreCache)
//   node cdp.mjs click "<selector>"   click the first element matching a CSS selector
//   node cdp.mjs console <ms>         collect console messages + exceptions for N ms
import fs from 'node:fs'
const port = process.env.DSH_CDP_PORT || '9222'
const base = 'http://127.0.0.1:' + port
const [cmd, arg] = process.argv.slice(2)

const list = await (await fetch(base + '/json/list')).json()
const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
if (!page) { console.error('no page target: ' + JSON.stringify(list.map((t) => t.type))); process.exit(2) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); setTimeout(() => rej(new Error('ws timeout')), 8000) })

let id = 0
const pending = new Map()
const logs = []
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data)
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return }
  if (m.method === 'Runtime.consoleAPICalled') {
    logs.push('[console.' + m.params.type + '] ' + (m.params.args || []).map((a) => a.value !== undefined ? String(a.value) : (a.description || a.type)).join(' '))
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails || {}
    logs.push('[EXCEPTION] ' + (d.exception && (d.exception.description || d.exception.value) || d.text))
  }
}
const send = (method, params) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })) })

await send('Runtime.enable', {})
await send('Page.enable', {})

if (cmd === 'reload') {
  await send('Page.reload', { ignoreCache: true })
  console.log('reload sent')
} else if (cmd === 'click') {
  const expr = '(() => { const el = document.querySelector(' + JSON.stringify(arg) + '); if (!el) return "NOT FOUND"; el.click(); return "clicked " + el.tagName + "." + el.className; })()'
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true })
  console.log(JSON.stringify(r.result && r.result.result && r.result.result.value))
} else if (cmd === 'console') {
  const ms = Number(arg) || 3000
  await new Promise((r) => setTimeout(r, ms))
  console.log(logs.length ? logs.join('\n') : '(no console messages / exceptions)')
} else if (cmd === 'eval' || cmd === 'eval-file') {
  const expr = cmd === 'eval' ? arg : fs.readFileSync(arg, 'utf8')
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.result && r.result.exceptionDetails) console.log('EXCEPTION: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 800))
  else console.log(typeof r.result.result.value === 'string' ? r.result.result.value : JSON.stringify(r.result.result.value, null, 2))
} else {
  console.log('usage: eval|eval-file|reload|click|console')
}
try { ws.close() } catch {}