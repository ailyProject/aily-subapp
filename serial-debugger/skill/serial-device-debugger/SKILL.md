---
name: serial-device-debugger
description: "Use when developing or debugging MCU serial communication in Aily Blockly or Aily Chat AI IDE, including UART logs, baud rate mismatches, text or HEX payloads, line endings, DTR/RTS reset behavior, bootloader entry, framing issues, and the serial-debugger child tool."
---

# Serial Device Debugger

Use this skill to debug MCU UART and serial workflows with Aily's Serial Debugger child tool.

## First Pass

Start by pinning down the serial contract:

1. Confirm the board, MCU, USB-UART bridge, OS port name, firmware stack, and expected baud rate.
2. Capture data bits, stop bits, parity, flow control, line endings, and whether the device expects text, binary, or HEX frames.
3. Ask for observed RX/TX snippets, firmware logs, and whether reset or boot mode depends on DTR/RTS.
4. Separate physical connection problems from protocol problems: no port, open denied, no data, garbled data, wrong framing, missing newline, or device resets.
5. Treat tool output as evidence for firmware debugging, not as a replacement for device-side logs or oscilloscope/logic analyzer checks.

## Tool Map

Use the existing child-tool boundaries:

- Source lives in `serial-debugger/` in the `aily-tools` repo, and is packaged as `child/tools/serial-debugger` or `tools/serial-debugger` when integrated.
- `serial-debugger/index.js` selects RPC, serve, or CLI mode.
- `serial-debugger/core.js` owns `serialport` enumeration, connection, read/write, DTR/RTS/BRK signals, and status metadata.
- `serial-debugger/server.js` serves the UI, hosts `/ws`, validates the token, maps RPC methods, and exposes `/health` plus `/api/shutdown`.
- `serial-debugger/ui/src/app/app.ts`, `app.html`, and `src/styles.scss` render serial settings, traffic logs, view toggles, quick sends, and text/HEX input.
- `serial-debugger/dist/serial-debugger/ui/` is Angular compiled output. Do not hand-edit it unless you are deliberately patching generated code.
- `serial-debugger/i18n/*.json` owns visible child-tool strings. Update every locale file when adding visible UI text.

Do not put serial hardware access in Angular or the browser UI. Hardware operations belong in `core.js`, static serving and RPC belong in `server.js`, and interaction state belongs in `ui/src/app/` plus `ui/src/styles.scss`.

## CLI Checks

Use these commands from the repo root:

```powershell
node serial-debugger/index.js --help
node serial-debugger/index.js status
node serial-debugger/index.js ports
node serial-debugger/index.js write --port COM3 --baud 115200 --text "hello" --cr --lf
node serial-debugger/index.js write --port COM3 --baud 115200 --hex "01 02 03"
node serial-debugger/index.js signal --port COM3 --baud 115200 --dtr true
```

All non-help CLI commands write one JSON object to stdout. If hardware is unavailable, report that limitation and run code-level checks instead of inventing serial output.

## Debugging Path

Follow the failure stage:

- No port: check cable type, USB driver, permissions, device manager, and whether another process owns the port.
- Open denied: close IDE monitors, upload tools, terminal sessions, or stale child-tool processes.
- Garbled data: verify baud rate first, then data bits, parity, stop bits, clock source, and voltage level.
- No RX: check MCU TX pin, ground, firmware log enablement, reset state, and whether the board is in bootloader mode.
- No TX effect: confirm newline policy, command terminator, text versus HEX mode, checksum, and protocol framing.
- Resets unexpectedly: inspect DTR/RTS behavior, auto-reset circuit, boot strapping pins, and quick-send signal toggles.
- UI is stuck: check backend ready JSON, WebSocket token, `/health`, Penpal `childReady`, and browser console errors.

## Firmware Guidance

When designing MCU serial firmware:

- Print startup metadata: firmware version, baud rate, board/chip, protocol mode, and reset reason.
- Keep command parsing explicit. Define terminators, binary frame headers, length, checksum, and timeout.
- Log parse failures with byte counts or HEX snippets, but avoid flooding logs in high-rate streams.
- Use a known hello command and response so serial path validation is deterministic.
- For bootloader flows, document the DTR/RTS pulse sequence and expected timing.

## Modifying The Tool

When changing the Serial Debugger tool itself:

- Put serial enumeration, open/close, read/write, and signal behavior in `core.js`.
- Put static serving, token validation, WebSocket RPC, `/health`, and shutdown behavior in `server.js`.
- Put CLI parsing and JSON output behavior in `cli.js`.
- Put UI state, settings, logs, filters, quick sends, and export behavior in the Angular UI under `ui/src/`, then rebuild `dist/serial-debugger/ui/`.
- Keep the JSON RPC contract stable unless UI, CLI, server, and host are updated together.

## Verification

Choose checks that match the change:

```powershell
python C:\Users\coloz\.codex\skills\.system\skill-creator\scripts\quick_validate.py serial-debugger/skill/serial-device-debugger
node serial-debugger/index.js --help
node serial-debugger/index.js status
node serial-debugger/index.js ports
npm --prefix serial-debugger run build:ui
node --check serial-debugger/index.js
node --check serial-debugger/core.js
node --check serial-debugger/cli.js
node --check serial-debugger/server.js
npm --prefix serial-debugger/ui run build
npm run build -- serial-debugger
```

For real serial behavior, verify against a connected MCU and report port, baud rate, serial options, TX payload, RX payload, DTR/RTS state, and firmware log context.
