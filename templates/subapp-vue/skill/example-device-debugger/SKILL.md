---
name: {{tool-skill-name}}
description: "Use when developing or debugging MCU firmware workflows that rely on the {{Tool Name}} child tool."
---

# {{Tool Name}} Skill

Use this skill when the user needs to debug a workflow with the `{{tool-id}}` child tool.

## First Pass

1. Identify the board, firmware stack, transport, and expected tool workflow.
2. Capture the exact input data, expected output, timeout, and device-side logs.
3. Use the child tool output as evidence, not as a replacement for firmware logs.
4. Ask for missing hardware details only when they change the test path.

## Tool Map

- `child/tools/index.json` registers `{{tool-id}}` with route `/child-tool/{{tool-id}}`.
- `child/tools/{{tool-id}}/index.js` selects `rpc`, `serve`, or CLI mode.
- `child/tools/{{tool-id}}/server.js` serves the UI, hosts `/ws`, validates `token`, and exposes `/health` plus `/api/shutdown`.
- `child/tools/{{tool-id}}/core.js` owns the tool behavior.
- `child/tools/{{tool-id}}/cli.js` owns CLI parsing and JSON output.
- `child/tools/{{tool-id}}/ui/src/App.vue` owns Vue UI state and backend RPC calls.
- `child/tools/{{tool-id}}/i18n/*.json` owns visible child-tool text.

Keep tool behavior out of Angular host code. Host code should only manage iframe, process lifecycle, and Penpal control messages.

## CLI Checks

Run from the repository root:

```powershell
node child/tools/{{tool-id}}/index.js --help
node child/tools/{{tool-id}}/index.js status
node child/tools/{{tool-id}}/index.js echo --message hello
```

All non-help CLI commands write one JSON object to stdout.

## Verification

```powershell
node --check child/tools/{{tool-id}}/index.js
node --check child/tools/{{tool-id}}/core.js
node --check child/tools/{{tool-id}}/cli.js
node --check child/tools/{{tool-id}}/server.js
npm run build:ui --prefix child/tools/{{tool-id}}
```
