---
name: serial-device-debugger
description: "Debug MCU serial communication with the host-independent serial-debugger subapp, including UART logs, baud-rate mismatches, text or HEX payloads, line endings, DTR/RTS reset behavior, bootloader entry, framing issues, persistent CLI sessions, bounded log evidence, automated scenarios, safe pause/resume, and manual takeover."
---

# Serial Device Debugger

Use this skill to debug MCU UART and serial workflows with Aily's Serial Debugger child tool. The skill explains the workflow; semantic tools or the daemon-backed CLI perform the actual serial operations.

## Execution Priority

- When the host exposes `serial_ports_list`, `serial_session_manage`, `serial_transact`, or the other manifest-declared `serial_*` tools, use those tools. Do not invoke the Serial Debugger CLI through `command_exec` or another shell tool.
- A visible semantic `serial_*` tool that returns an error is still exposed. In an integrated host, report the bridge error and stop; never fall back to the CLI or start a daemon after a semantic-tool failure.
- Use the CLI only in a standalone shell environment where the semantic `serial_*` tools are unavailable.
- For a request that sends data and expects a reply, use `serial_transact`. Never substitute a one-shot `write` command and assume it can capture later RX feedback.
- The embedded/window UI and Agent tools share the same persistent Runtime. Opening the UI is for synchronized observation and manual takeover, not a reason to create a second serial process.

## First Pass

Start by pinning down the serial contract:

1. Confirm the board, MCU, USB-UART bridge, OS port name, firmware stack, and expected baud rate.
2. Capture data bits, stop bits, parity, flow control, line endings, and whether the device expects text, binary, or HEX frames.
3. Ask for observed RX/TX snippets, firmware logs, and whether reset or boot mode depends on DTR/RTS.
4. Separate physical connection problems from protocol problems: no port, open denied, no data, garbled data, wrong framing, missing newline, or device resets.
5. Treat tool output as evidence for firmware debugging, not as a replacement for device-side logs or oscilloscope/logic analyzer checks.

## Tool Map

Use the existing child-tool boundaries:

- Source lives in `serial-debugger/` in the `aily-subapp` repo. Installed builds are resolved from the host's npm install root (for example `%LOCALAPPDATA%/aily-project/npm-global/app/node_modules/@aily-project/subapp-serial-debugger`); do not depend on legacy `child/tools/serial-debugger` copies.
- `serial-debugger/index.js` selects RPC, serve, or CLI mode.
- `serial-debugger/core.js` and `serial-debugger/runtime/` own the persistent serial session, hot event history, response matching, JSONL Journal, registered artifacts, read/write, and DTR/RTS/BRK signals.
- `serial-debugger/server.js` serves the UI, hosts `/ws`, validates the token, maps RPC methods, and exposes `/health` plus `/api/shutdown`.
- `serial-debugger/ui/src/app/app.ts`, `app.html`, and `src/styles.scss` render serial settings, traffic logs, view toggles, quick sends, and text/HEX input.
- `serial-debugger/dist/serial-debugger/ui/` is Angular compiled output. Do not hand-edit it unless you are deliberately patching generated code.
- `serial-debugger/i18n/*.json` owns visible child-tool strings. Update every locale file when adding visible UI text.

Do not put serial hardware access in Angular or the browser UI. Hardware operations belong in `core.js`, static serving and RPC belong in `server.js`, and interaction state belongs in `ui/src/app/` plus `ui/src/styles.scss`.

## Standalone CLI Fallback

For shell-only work, start one background Runtime and reuse it across commands:

```powershell
node serial-debugger/index.js daemon start
node serial-debugger/index.js daemon status
node serial-debugger/index.js ports
node serial-debugger/index.js open --port COM3 --baud 115200
node serial-debugger/index.js transact --text "AT" --cr --lf --expect-regex "OK|ERROR" --timeout 3000
node serial-debugger/index.js listen --duration 2000
node serial-debugger/index.js write --hex "01 02 03"
node serial-debugger/index.js signal --dtr true
node serial-debugger/index.js logs --after-seq 0 --max-bytes 32768
node serial-debugger/index.js scenario --file serial-scenario.json
node serial-debugger/index.js scenario-control status
node serial-debugger/index.js scenario-control takeover --reason "manual probe"
node serial-debugger/index.js scenario-control release
node serial-debugger/index.js scenario-control resume
node serial-debugger/index.js analysis --source journal --max-events 5000 --max-findings 20
node serial-debugger/index.js artifact-search --artifact-id journal-000001 --query ERROR
node serial-debugger/index.js artifact-read --artifact-id journal-000001 --offset 0 --max-bytes 32768
node serial-debugger/index.js daemon stop
```

Prefer `transact` whenever a sent command should produce a reply. It sends through the already-open shared session, waits for expected text/regex/HEX, and returns a bounded preview plus event cursors and artifact references. Use `write` only for one-way data. If hardware is unavailable, report that limitation and run code-level checks instead of inventing serial output.

The standalone CLI cannot ask Blockly (or another host) to open an embedded/window UI. Never pass `--present-ui` to a CLI command and never infer UI visibility from CLI output.

CLI fallback cleanup is mandatory. Run `close` and `daemon stop` in a `finally`-equivalent cleanup path, then verify `daemon status` reports `running: false`. Do this before any firmware build/upload step and when the serial task ends, including after errors or cancellation. A successful CLI result may include a top-level `lifecycle.cleanupRequired` reminder; do not claim completion while that reminder is unresolved.

## Agent Workflow

When the host exposes the manifest-declared semantic tools, prefer them over shell commands:

1. Call `serial_ports_list`.
2. Before firmware upload, call `serial_session_manage` with `action: "close"` and verify the port is released. After upload, call it with `action: "open"` and optionally `presentUi: "embedded"` or `"window"` so the user can watch the same shared Runtime.
3. Call `serial_transact` for one send-and-observe step.
4. Call `serial_scenario_run` for a repeatable multi-step flow made of `transact`, `send`, `wait`, `signal`, and `capture` steps. Keep the scenario under 50 steps and 120 seconds.
5. Use `serial_scenario_control` when observation or human intervention is needed. Request `pause` for a safe-boundary stop, or `takeover` before manual TX or signal changes. Wait until state is `paused` or `taken_over`.
6. After takeover, let only the takeover owner mutate the serial session. Call `release` when manual checks end; release intentionally leaves the scenario paused, so call `resume` separately. Use `cancel` to stop the scenario without closing the port.
7. Never retry or replay a non-idempotent send merely to make pause immediate. A running transact/send reaches its next safe boundary; a wait step can pause cooperatively.
8. After a scenario, timeout, or suspicious stream, call `serial_analysis_run` for bounded rule-based triage. Treat findings as hypotheses and correlate their sequence evidence with Journal/artifact pages before naming a root cause.
9. Use `serial_logs_read` for a small cursor-based event page. Set `source: "journal"` for cross-segment or time-range history outside the hot in-memory window.
10. When a result returns `evidence.artifacts`, use `serial_artifact_search` first, then `serial_artifact_read` only for the relevant bounded pages.
11. Always close the session when the workflow is finished, before firmware upload, and on error/cancellation cleanup.

Only tell the user that the UI opened when the successful semantic tool response contains `presentation.ok: true`, the expected `presentation.requestedMode`, and `presentation.visible: true` for embedded mode. Supplying `presentUi` in the request is not itself proof that the host displayed the page.

Never request or return an entire multi-megabyte serial log. Tool results are limited to 48 KiB, previews default to 2 KiB per format, and log/artifact pages default to 32 KiB. The JSONL Journal and RX text artifacts remain on disk as the full evidence source.

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
- Put daemon discovery, lifecycle, locks, and short-lived WebSocket clients in `runtime/daemon.js` and `runtime/rpc-client.js`.
- Put JSONL persistence and artifact access in `runtime/journal.js` and `runtime/artifact-store.js`; never accept arbitrary filesystem paths from an Agent tool.
- Put repeatable workflow execution in `runtime/scenario-runner.js`, pause/takeover ownership in `runtime/scenario-controller.js`, rule-based triage in `runtime/analyzer.js`, and safe old-session cleanup in `runtime/retention.js`.
- Put UI state, settings, logs, filters, quick sends, and export behavior in the Angular UI under `ui/src/`, then rebuild `dist/serial-debugger/ui/`.
- Keep the JSON RPC contract stable unless UI, CLI, server, and host are updated together.

## Verification

Choose checks that match the change:

```powershell
python C:\Users\LENOVO\.codex\skills\.system\skill-creator\scripts\quick_validate.py serial-debugger/skill/serial-device-debugger
node serial-debugger/index.js --help
node serial-debugger/index.js daemon start
node serial-debugger/index.js daemon status
node serial-debugger/index.js daemon stop
npm --prefix serial-debugger test
npm --prefix serial-debugger run build:ui
node --check serial-debugger/index.js
node --check serial-debugger/core.js
node --check serial-debugger/cli.js
node --check serial-debugger/server.js
npm --prefix serial-debugger/ui run build
npm run build -- serial-debugger
```

For real serial behavior, verify against a connected MCU and report port, baud rate, serial options, TX payload, RX payload, DTR/RTS state, and firmware log context.
