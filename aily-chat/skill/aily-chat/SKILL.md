---
name: aily-chat
description: "Use when developing or debugging MCU firmware workflows that rely on the Aily Chat child tool."
---

# Aily Chat Skill

Use this skill when the user needs to debug a workflow with the `aily-chat` child tool.

## First Pass

1. Identify the board, firmware stack, transport, and expected tool workflow.
2. Capture the exact input data, expected output, timeout, and device-side logs.
3. Use the child tool output as evidence, not as a replacement for firmware logs.
4. Ask for missing hardware details only when they change the test path.

## Tool Map

- `child/tools/index.json` registers `aily-chat` with route `/child-tool/aily-chat`.
- `child/tools/aily-chat/index.js` selects `rpc`, `serve`, or CLI mode.
- `child/tools/aily-chat/server.js` serves the UI, hosts `/ws`, validates `token`, and exposes `/health` plus `/api/shutdown`.
- `child/tools/aily-chat/core.js` owns the tool behavior.
- `child/tools/aily-chat/cli.js` owns CLI parsing and JSON output.
- `child/tools/aily-chat/ui/src/App.tsx` owns React UI state and host protocol rendering.
- `child/tools/aily-chat/i18n/*.json` owns visible child-tool text.

Keep tool behavior out of Angular host code. Host code should only manage iframe, process lifecycle, and Penpal control messages.

## CLI Checks

Run from the repository root:

```powershell
node child/tools/aily-chat/index.js --help
node child/tools/aily-chat/index.js status
node child/tools/aily-chat/index.js echo --message hello
```

All non-help CLI commands write one JSON object to stdout.

## Verification

```powershell
node --check child/tools/aily-chat/index.js
node --check child/tools/aily-chat/core.js
node --check child/tools/aily-chat/cli.js
node --check child/tools/aily-chat/server.js
npm run build:ui --prefix child/tools/aily-chat
```
