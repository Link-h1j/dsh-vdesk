// Child runner for the P2-B/C self-test: loads the plugin host half fresh (its transport cache is
// per process, like a real DSH session) and prints one tool result as JSON.
import { pathToFileURL } from "node:url";

const INDEX = "C:\\Users\\Administrator\\Documents\\deepseek-harness\\默认工作区\\tools\\vdesk-childsession\\plugin\\dsh-vdesk\\index.js";
const which = process.argv[2];

const mod = await import(pathToFileURL(INDEX).href);
const regs = [];
mod.apply({ tools: { register(d) { regs.push(d); return () => {}; } }, effect() { return () => {}; } });
const byName = Object.fromEntries(regs.map((d) => [d.name, d]));

const ARGS = {
  "apps-list": { action: "list" },
  "apps-limit": { action: "list", limit: 2 },
  "apps-launch-notepad": { action: "launch", name: "记事本" },
  "apps-launch-doubao": { action: "launch", name: "doubao" },
  "apps-launch-zzz": { action: "launch", name: "zzz-not-an-app" },
};
let out;
if (which === "status-health") out = await byName.vdesk_click.execute({ x: 0.5, y: 0.5, after: false }, {});
else if (ARGS[which]) out = await byName.vdesk_apps.execute(ARGS[which], {});
else out = { ok: false, error: "unknown runner case: " + which };
process.stdout.write(JSON.stringify(out));
process.exit(0);
