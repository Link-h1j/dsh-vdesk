# P0-B：第三方插件注册 DSH 工具 —— 结论：**可行**（证据全套见下）

宿主**不打包**第三方插件：profile boot 时用 Node 原生 `import()` 直读磁盘，再由 `@deepseek-ai/dsh-app-boot` 的「profile 解析路由器」把裸包名 `@deepseek-ai/*` 指向 app.asar 里的安装副本；插件本身只要 `ctx.tools.register(...)`。

## 证据（文件:行号）
- `B:\DSHdesktop\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\index.js`（`main()`）：`const profile = loadProfileDirectory("dsh", projectDir, installAnchor);` → `runProfile({...})`。宿主入口就是 profile 目录加载器。
- `...@deepseek-ai\dsh-app-boot\lib\index.js:920` `loadProfileDirectory()` 读 profile 的 `dsh.profile.bundles`；`:925-939` 每个 bundle 必须声明 `dsh.bundle`，否则抛 `declares no dsh.bundle in its package.json` 且**静默 skip**（`reportSkippedBundles` 打印）。
- `dsh-app-boot\lib\index.js:3691-3701` `mountRootInclude()`：`if (name.startsWith(".") || name.startsWith("cordis:")) return super.import(...); ... return internal.import(specifier, bareModuleBaseUrl, {});` —— 按**包名** import，无 esbuild/rollup 打包、无 require 注入。
- `dsh-app-boot\lib\index.js:1157` 模块注释：`In-memory profile package routing for Node's default ESM and CommonJS loaders.`；`:1641-1643` `installRuntimeInterception()` 直接改写 Node 内部 ESM `resolveSync` 与 CJS `Module._resolveFilename`。
- `dsh-app-boot\lib\index.js:741-759` `createRuntimeResolution()`：`entries` = 安装包依赖闭包 + profile 包；安装闭包来自 `dsh\package.json` 的 `dependencies`，其中就有 `"@deepseek-ai/dsh-tools": "0.2.0-rc.2"`（已被我读过原文）。
- `dsh-app-boot\lib\index.js:1471-1524` `routeLinked()`：**link/junction 到 profiles 树之外**的插件，只有祖先目录（含插件自身）的 `package.json.peerDependencies` 声明了该包名才拦截 —— `:1479 if (ancestorSet.has(searchPath) && readPeerNames(directory).has(name))`；否则回落原生解析 → `import "@deepseek-ai/dsh-tools"` 直接 `ERR_MODULE_NOT_FOUND`。
- 对照：pnpm 正常装进 `profile/node_modules` 的**真目录**走 `:1459 target.scope === "installation" || layer.active` 分支 → 无需 peer 声明即可拿到 `@deepseek-ai/dsh-tools`。
- `dsh-app-boot\lib\index.js:286-300` `evaluatePluginCompatibility()`：一旦声明 peer，所有 `@deepseek-ai/dsh*` 都会 `semver.satisfies(运行时 0.2.0-rc.2, range, { includePrerelease: true })`，不满足则**整个 bundle 被 skip**（`:930-931`）；`:295-299` 把 `workspace:*` 映射为运行时版本，最稳。
- `...@deepseek-ai\dsh-tools\lib\index.js:2878-2887` `register(definition)` 只校验 `output{render,schema}`、`timeoutMs`、保留名 `run_code`，**没有 defineTool/marker 校验**；`:3039-3048` `schemaOf()` 把 `definition.parameters` 原样投影成模型 JSON Schema（`:2063` 注释也承认存在 raw `register()` 路径）。
- 服务名与插件形状：`dsh-tools\lib\index.js:2704 super(ctx, "tools")`；`...@deepseek-ai\dsh-tool-ask-user\lib\index.js:216 const inject = ["tools", "userQuestions"]`、`:218 function apply(ctx, config = {})`、`:324 export { Config, apply, inject, name }`。
- 第三方同类实证：`C:\Users\Administrator\.dsh\profiles\web\node_modules\dsh-better-sidebar\lib\index.js:13 import { defineTool } from "@deepseek-ai/dsh-tools"`、`:2566 ctx.tools.register(tool)`；它的 `package.json` 声明 `peerDependencies."@deepseek-ai/dsh-tools": "^0.1.5-rc.1"`，`cordis.patch.yml` 用 `- insert: [- id: better-sidebar, name: 'dsh-better-sidebar']` 挂载 —— 第三方注册工具在真实世界里就是这么做的。
- 关键版本差：`getDshRuntimeVersion()`（app-boot:271-273 读自身 package.json）= **桌面版 0.2.0-rc.2**（app.asar 里 `dsh/node_modules/@deepseek-ai/dsh-app-boot/package.json`），而 web profile 那份是 0.1.5-rc.3 —— 所以 better-sidebar 的 `^0.1.5-rc.1` 在桌面版**不满足**，桌面版插件的 peer range 必须按 0.2.0-rc.2 写（用 `workspace:*` 免维护）。

## 最小可跑配方 A（推荐：零 `@deepseek-ai/*` import，package.json 不用动）
`package.json` 保持现状（`"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}`）；`index.js` 追加（现有 `export function apply` 可保留，只要同文件再导出 `inject`）：
```js
export const inject = ["tools"];                    // 等 ctx.tools 服务就绪，再注册
export function apply(ctx) {
  ctx.tools.register({                              // 普通对象即可，无需 defineTool
    name: "vdesk_click",
    description: "Click a screen coordinate in the child-session virtual desktop.",
    parameters: { type: "object", required: ["x", "y"], additionalProperties: false,
      properties: { x: { type: "integer" }, y: { type: "integer" } } },
    output: { schema: { type: "object", properties: { ok: { type: "boolean" } } },
      render: (_args, value) => [{ type: "text", text: JSON.stringify(value) }] },
    async execute(args) { return { ok: await click(args.x, args.y) }; }   // 打 127.0.0.1:8791 即可
  });
}
```
配方 B（想用 `defineTool`/terse parameters，同官方插件）：`package.json` 加 `"peerDependencies": { "@deepseek-ai/dsh-tools": "workspace:*" }`，然后 `import { defineTool } from "@deepseek-ai/dsh-tools"` 照 `dsh-experimental-tool-agent-team\lib\index.js:242` 写。**注意**：`@local/dsh-vdesk` 现在是 junction（profiles 树之外）→ 不给 peerDependencies 就一定解析失败；给错范围会连整个 bundle 一起被 skip。

## 重启要求与替代方案
- host 半区改动必须**完整重启 DSH**（profile 的 `patchReload` 是 startup；client 半区才热刷）。工具注册在 `apply()` 里，重启后即对所有新会话可见。
- 若不想动 package.json / 不想重启：走 MCP——profile 的 `cordis.patch.yml` 里 `- insert: - name: '@deepseek-ai/dsh-mcp-client'`（本机 wincu 已是先例），工具以 `mcp__<server>__*` 出现；或在 apply 里直接 shell 出去调 `vdesk-cli.mjs`（现 `dsh-vdesk/index.js` 就是这么做的，零 import）。
