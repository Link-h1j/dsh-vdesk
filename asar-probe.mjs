// asar-probe.mjs -- read an Electron .asar archive without any dependency.
//
// Usage:
//   node asar-probe.mjs <asar> list <regex> [max]
//   node asar-probe.mjs <asar> cat  <exact/path/inside/asar> [maxBytes]
//   node asar-probe.mjs <asar> grep <regex-in-path> <regex-in-content> [max]
//   node asar-probe.mjs <asar> dump <regex-in-path> <outDir>

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [, , asarPath, cmd, a1, a2, a3] = process.argv;
if (!asarPath || !cmd) { console.error("usage: node asar-probe.mjs <asar> list|cat|grep|dump ..."); process.exit(2); }

const buf = readFileSync(asarPath);

// Locate the JSON header reliably: it starts at the first '{' at/after offset 8 and ends at the
// matching '}' (brace counting, skipping string literals).
function readHeader() {
  let start = -1;
  for (let i = 8; i < 64; i++) { if (buf[i] === 0x7b /* { */) { start = i; break; } }
  if (start < 0) throw new Error("no JSON header found");
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < buf.length; i++) {
    const c = buf[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === 0x5c /* \ */) { esc = true; continue; }
      if (c === 0x22 /* " */) { inStr = false; continue; }
      continue;
    }
    if (c === 0x22) { inStr = true; continue; }
    if (c === 0x7b) depth++;
    else if (c === 0x7d) { depth--; if (depth === 0) return { json: buf.toString("utf8", start, i + 1), start, end: i + 1 }; }
  }
  throw new Error("unterminated JSON header");
}

const h = readHeader();
const header = JSON.parse(h.json);
const align = 4;
let dataStart = h.end;
while (dataStart % align !== 0) dataStart++;

const files = [];
(function walk(node, prefix) {
  for (const [name, entry] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + "/" + name : name;
    if (entry.files) walk(entry, p);
    else files.push({ path: p, offset: Number(entry.offset), size: entry.size });
  }
})(header, "");

const data = buf.subarray(dataStart);
const contentOf = (f) => data.subarray(f.offset, f.offset + f.size);
const short = (s, n) => (s.length > n ? s.slice(0, n) + `…(+${s.length - n})` : s);

if (cmd === "list") {
  const re = new RegExp(a1, "i");
  const max = Number(a2 || 120);
  const hits = files.filter((f) => re.test(f.path));
  console.log(`files=${files.length} match=${hits.length}`);
  for (const x of hits.slice(0, max)) console.log(`  ${String(x.size).padStart(9)}  ${x.path}`);
  if (hits.length > max) console.log(`  ... +${hits.length - max} more`);
} else if (cmd === "cat") {
  const f = files.find((x) => x.path === a1);
  if (!f) { console.error("not found: " + a1); process.exit(1); }
  const max = Number(a2 || 200000);
  process.stdout.write(short(contentOf(f).toString("utf8"), max) + "\n");
} else if (cmd === "grep") {
  const pathRe = new RegExp(a1, "i");
  const textRe = new RegExp(a2, "i");
  const max = Number(a3 || 40);
  let shown = 0, scanned = 0;
  for (const f of files) {
    if (!pathRe.test(f.path)) continue;
    if (f.size > 3_000_000) continue;
    scanned++;
    const text = contentOf(f).toString("utf8");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (textRe.test(lines[i])) {
        console.log(`${f.path}:${i + 1}: ${short(lines[i].trim(), 200)}`);
        if (++shown >= max) { console.log(`...(stopped at ${max})`); process.exit(0); }
      }
    }
  }
  console.log(`scanned ${scanned} file(s), ${shown} hit(s)`);
} else if (cmd === "dump") {
  const re = new RegExp(a1, "i");
  mkdirSync(a2, { recursive: true });
  let n = 0;
  for (const f of files) {
    if (!re.test(f.path) || f.size > 2_000_000) continue;
    writeFileSync(join(a2, f.path.replace(/[\\/]/g, "__")), contentOf(f));
    n++;
  }
  console.log(`dumped ${n} file(s) into ${a2}`);
} else {
  console.error("unknown cmd " + cmd);
  process.exit(2);
}
