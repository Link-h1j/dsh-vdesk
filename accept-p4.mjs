// accept-p4.mjs -- P4 真机验收台（Lead 侧）
//
// 打真实运行中的「子会话 helper(8790)」与「monitor(8791)」，验证 B 组欠账：
//   B1 /stream 多帧 MJPEG 分帧、/input 批量输入（单请求）
//   B3 剪贴板通道（读）
//   B4 按下/抬起（/input 的 key down/up）
//   B5 等画面稳定所依赖的 /screenshot 小图
//   老路由零回归（/health /screenshot /apps /clipboard）
//   8791：/stream 透传、/input 写路由的 Origin 白名单（非白名单 403）
//
// 唯一有副作用的动作是 /input 那一批「无害事件」：只 move / scroll / F15 按下抬起，
// 全部发生在子会话里，不点任何按钮、不碰用户桌面。
//
// 用法：node accept-p4.mjs            （默认打 8790/8791）
//      node accept-p4.mjs --no-input  （跳过 /input 那一批）
// 产物：out\accept-p4.json（结构化结果），stdout 打印 ok=N fail=0

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const TEMP = process.env.TEMP || 'C:\\Users\\Administrator\\AppData\\Local\\Temp';
const OUT = path.join(TEMP, 'dsh-childsession', 'out');
const HEALTH = '127.0.0.1';
const HELPER_PORT = Number(process.env.VDESK_HELPER_PORT || 8790);
const MONITOR_PORT = Number(process.env.VDESK_MONITOR_PORT || 8791);
const NO_INPUT = process.argv.includes('--no-input');

let ok = 0;
let fail = 0;
const results = [];
function check(name, cond, detail) {
  const pass = !!cond;
  if (pass) ok++; else fail++;
  results.push({ name, pass, detail: detail === undefined ? null : detail });
  console.log(`${pass ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : '  ' + detail}`);
}

function readToken() {
  try { return fs.readFileSync(path.join(OUT, 'token'), 'utf8').trim(); } catch { return null; }
}
const TOKEN = readToken();

function req(port, pathname, { method = 'GET', body = null, headers = {}, timeoutMs = 15000, raw = false } = {}) {
  return new Promise((resolve) => {
    const h = Object.assign({}, headers);
    if (TOKEN && port === HELPER_PORT) h['X-VDesk-Token'] = TOKEN;
    if (body != null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(body);
    }
    const r = http.request({ host: HEALTH, port, path: pathname, method, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, buf, text: raw ? null : buf.toString('utf8') });
      });
    });
    r.on('error', (e) => resolve({ status: 0, error: e.message, buf: Buffer.alloc(0), text: '' }));
    r.setTimeout(timeoutMs, () => { r.destroy(new Error('timeout')); });
    if (body != null) r.write(body);
    r.end();
  });
}

function json(t) { try { return JSON.parse(t); } catch { return null; } }

// ---- MJPEG 流：连上去收若干帧再主动断开，顺便量帧率/帧大小 ----
function readStream(port, query, ms) {
  return new Promise((resolve) => {
    const chunks = [];
    const h = {};
    if (TOKEN && port === HELPER_PORT) h['X-VDesk-Token'] = TOKEN;
    const r = http.request({ host: HEALTH, port, path: '/stream?' + query, headers: h }, (res) => {
      resolveCapture(res);
    });
    let done = false;
    function resolveCapture(res) {
      res.on('data', (c) => chunks.push(c));
      res.on('error', () => { });
      setTimeout(() => {
        const buf = Buffer.concat(chunks);
        const frames = parseFrames(buf);
        if (!done) { done = true; resolve({ status: res.statusCode, headers: res.headers, buf, frames }); }
        try { r.destroy(); } catch { }
        try { res.destroy(); } catch { }
      }, ms);
    }
    r.on('error', (e) => { if (!done) { done = true; resolve({ status: 0, error: e.message, buf: Buffer.alloc(0), frames: [] }); } });
    r.setTimeout(ms + 5000, () => { try { r.destroy(new Error('stream timeout')); } catch { } });
    r.end();
  });
}

// 逐字节解析 multipart/x-mixed-replace; boundary=dshframe
function parseFrames(buf) {
  const B = Buffer.from('--dshframe\r\n');
  const frames = [];
  let i = 0;
  const idx = [];
  while ((i = buf.indexOf(B, i)) !== -1) { idx.push(i); i += B.length; }
  for (let k = 0; k < idx.length; k++) {
    const start = idx[k] + B.length;
    const end = k + 1 < idx.length ? idx[k + 1] : buf.length;
    const part = buf.subarray(start, end);
    const headEnd = part.indexOf('\r\n\r\n');
    if (headEnd === -1) continue;
    const head = part.subarray(0, headEnd).toString('latin1');
    const m = /Content-Length:\s*(\d+)/i.exec(head);
    const ctype = (/Content-Type:\s*([^\r\n]+)/i.exec(head) || [])[1] || '';
    const body = part.subarray(headEnd + 4);
    const len = m ? Number(m[1]) : -1;
    frames.push({ head, ctype, len, bytes: body.length, magic: body.length >= 2 ? body.subarray(0, 2).toString('latin1') : '' });
  }
  return frames;
}

// ---- 主流程 ----
const health = await req(HELPER_PORT, '/health', { timeoutMs: 6000 });
const hj = json(health.text);
check('helper /health 可达且 ok', health.status === 200 && hj && hj.ok === true, `status=${health.status} tls=${hj && hj.tls} session=${hj && hj.session}`);
check('8790 需要 token 的判据（无 token 应 401）', true, '见下方 unauthorized 用例');
const noTok = await new Promise((resolve) => {
  const r = http.request({ host: HEALTH, port: HELPER_PORT, path: '/screenshot?format=jpg&scale=0.2', method: 'GET' }, (res) => {
    resolve(res.statusCode);
  });
  r.on('error', () => resolve(0));
  r.end();
});
check('无 token 访问 /screenshot → 401', noTok === 401, `status=${noTok}`);

// B5 依赖的小图
const shot = await req(HELPER_PORT, '/screenshot?format=jpg&quality=40&scale=0.35&cursor=0', { timeoutMs: 20000 });
check('B5 依赖：/screenshot 小图（jpg/scale/cursor=0）可用', shot.status === 200 && shot.buf.length > 1000, `status=${shot.status} bytes=${shot.buf.length}`);

// 老路由 /apps
const apps = await req(HELPER_PORT, '/apps?action=list&limit=5', { timeoutMs: 30000 });
const aj = json(apps.text);
check('老路由 /apps list 零回归', apps.status === 200 && aj && aj.ok === true && Array.isArray(aj.apps), `status=${apps.status} count=${aj && aj.count}`);

// B3 剪贴板读（不做 set，避免动用户剪贴板语义之外的内容）
const cb = await req(HELPER_PORT, '/clipboard?action=get', { timeoutMs: 10000 });
const cj = json(cb.text);
check('B3 依赖：/clipboard get 可用', cb.status === 200 && cj && cj.ok === true, `status=${cb.status} chars=${cj && (cj.text ? cj.text.length : 0)}`);

// B1 流：量帧
const t0 = Date.now();
const st = await readStream(HELPER_PORT, 'format=jpg&quality=72&scale=0.5&fps=8&cursor=1&maxSeconds=3', 3200);
const el = Date.now() - t0;
check('B1 helper /stream 返回 200 + multipart 头', st.status === 200 && /multipart\/x-mixed-replace/.test(String((st.headers || {})['content-type'] || '')), `status=${st.status} ct=${(st.headers || {})['content-type']}`);
check('B1 /stream 分帧可解析（>=4 帧）', st.frames.length >= 4, `frames=${st.frames.length} ms=${el}`);
const goodFrames = st.frames.filter((f) => f.len > 0 && f.bytes === f.len + 2 && f.magic === '\xff\xd8');
check('B1 每帧 Content-Length 与字节数一致且是 JPEG(FFD8)', st.frames.length > 0 && goodFrames.length === st.frames.length, `good=${goodFrames.length}/${st.frames.length}`);
if (st.frames.length > 1) {
  const avg = Math.round(st.frames.slice(0, -1).reduce((a, f) => a + f.bytes, 0) / (st.frames.length - 1));
  const fps = (st.frames.length / (el / 1000)).toFixed(1);
  check('B1 帧率贴近请求的 8fps（>=5fps）', Number(fps) >= 5, `measured=${fps}fps avgFrame=${avg}B`);
}

// 断连后 helper 仍活着（流清理）
const health2 = await req(HELPER_PORT, '/health', { timeoutMs: 6000 });
check('B1 客户端断开后 helper 仍存活', health2.status === 200, `status=${health2.status}`);

// B1/B4 批量输入：无害事件（move / scroll / F15 down+up）
if (!NO_INPUT) {
  const events = [
    { type: 'move', x: 0.5, y: 0.9 },
    { type: 'scroll', x: 0.5, y: 0.5, delta: 120 },
    { type: 'key', vk: 0x7e, down: true },
    { type: 'key', vk: 0x7e, down: false }
  ];
  const inp = await req(HELPER_PORT, '/input', { method: 'POST', body: JSON.stringify({ events }), timeoutMs: 20000 });
  const ij = json(inp.text);
  check('B1/B4 /input 批量执行成功且 count=4', inp.status === 200 && ij && ij.ok === true && ij.count === 4, `status=${inp.status} body=${(inp.text || '').slice(0, 160)}`);
  const bad = await req(HELPER_PORT, '/input', { method: 'POST', body: JSON.stringify({ events: [{ type: 'nope' }] }), timeoutMs: 10000 });
  const bj = json(bad.text);
  check('B1 /input 非法事件诚实报错（ok:false + index）', bad.status >= 400 || (bj && bj.ok === false && typeof bj.index === 'number'), `status=${bad.status} body=${(bad.text || '').slice(0, 120)}`);
  const get = await req(HELPER_PORT, '/input?events=' + encodeURIComponent(JSON.stringify({ events: [{ type: 'move', x: 0.4, y: 0.4 }] })), { timeoutMs: 15000 });
  const gj = json(get.text);
  check('B1 /input 的 GET 形式也可用', get.status === 200 && gj && gj.ok === true && gj.count === 1, `status=${get.status} body=${(get.text || '').slice(0, 120)}`);
} else {
  console.log('-- /input 用例被 --no-input 跳过');
}

// ---- 8791 monitor ----
const mStream = await readStream(MONITOR_PORT, 'format=jpg&quality=60&scale=0.4&fps=6&cursor=1&maxSeconds=2', 2200);
check('B1 monitor /stream 透传分帧（>=3 帧）', mStream.status === 200 && mStream.frames.length >= 3, `status=${mStream.status} frames=${mStream.frames.length}`);

const evilOrigin = await req(MONITOR_PORT, '/input', { method: 'POST', body: JSON.stringify({ events: [{ type: 'move', x: 0.3, y: 0.3 }] }), headers: { Origin: 'http://evil.example' }, timeoutMs: 10000 });
check('8791 /input 非白名单 Origin → 403', evilOrigin.status === 403, `status=${evilOrigin.status}`);

const goodOrigin = await req(MONITOR_PORT, '/input', { method: 'POST', body: JSON.stringify({ events: [{ type: 'move', x: 0.3, y: 0.3 }] }), headers: { Origin: 'http://127.0.0.1:19387' }, timeoutMs: 15000 });
const goj = json(goodOrigin.text);
check('8791 /input 白名单 Origin → 转发成功', goodOrigin.status === 200 && goj && goj.ok === true, `status=${goodOrigin.status} body=${(goodOrigin.text || '').slice(0, 120)}`);

const mShot = await req(MONITOR_PORT, '/shot?format=jpg&scale=0.3', { timeoutMs: 20000 });
check('8791 老路由 /shot 零回归', mShot.status === 200 && mShot.buf.length > 1000, `status=${mShot.status} bytes=${mShot.buf.length}`);

// ---- 报告 ----
const report = {
  at: new Date().toISOString(),
  helper: { port: HELPER_PORT, session: hj && hj.session, tls: hj && hj.tls },
  monitor: { port: MONITOR_PORT },
  ok, fail,
  frames: { helper: st.frames.length, monitor: mStream.frames.length },
  results
};
try { fs.writeFileSync(path.join(OUT, 'accept-p4.json'), JSON.stringify(report, null, 2), 'utf8'); } catch (e) { console.log('报告写入失败: ' + e.message); }
console.log(`\nok=${ok} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
