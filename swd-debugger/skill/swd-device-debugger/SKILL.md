---
name: swd-device-debugger
description: "Use when developing or debugging MCU SWD workflows with probe-rs, including probe discovery, chip attach, target info, reset strategy, flashing, RTT/defmt logs, and the child/tools/swd-debugger tool."
---

# SWD Device Debugger

Use this skill to debug MCU SWD workflows with Aily's SWD Debugger child tool.

## First Pass

1. Identify the board, MCU chip name, probe type, wiring, target voltage, reset pin availability, firmware format, and whether the firmware uses RTT or defmt.
2. Start with non-destructive checks: `version`, `list`, and `info`.
3. Only attach, reset, or flash after the user has provided the chip name and the operation matches the debugging goal.
4. Treat probe-rs output as evidence and preserve exact error strings in the answer.

## Tool Map

- `child/tools/swd-debugger/index.js` selects `rpc`, `serve`, or CLI mode.
- `child/tools/swd-debugger/server.js` serves the UI, hosts `/ws`, validates `token`, and exposes `/health` plus `/api/shutdown`.
- `child/tools/swd-debugger/core.js` owns probe-rs command construction, timeout handling, stdout/stderr capture, and structured diagnostics.
- `child/tools/swd-debugger/cli.js` owns CLI parsing and JSON output.
- `child/tools/swd-debugger/ui/app.js` owns browser UI state and backend RPC calls.
- `child/tools/swd-debugger/i18n/*.json` owns visible child-tool text.

Keep SWD behavior in the child tool. Host code should only manage iframe, process lifecycle, and Penpal control messages.

## CLI Checks

Run from the repository root:

```powershell
node child/tools/swd-debugger/index.js --help
node child/tools/swd-debugger/index.js status
node child/tools/swd-debugger/index.js version
node child/tools/swd-debugger/index.js list
node child/tools/swd-debugger/index.js info --chip STM32F103C8 --speed-khz 4000
node child/tools/swd-debugger/index.js auto --chip STM32F103C8 --include-attach
```

For local source checkouts, replace `child/tools/swd-debugger` with `swd-debugger`.

## Debugging Path

- `PROBE_RS_NOT_FOUND`: install probe-rs or specify `--probe-rs`.
- `NO_PROBE_FOUND`: check USB, probe firmware, driver, permissions, and whether another debugger is connected.
- `PROBE_PERMISSION`: fix WinUSB/libusb/udev access.
- `UNKNOWN_CHIP`: use the exact probe-rs target name or add a CMSIS-Pack target.
- `TARGET_ATTACH_FAILED`: lower SWD speed, verify SWDIO/SWCLK/GND/VTref, and try connect-under-reset.
- `SWD_LINK_FAULT`: check target power, reset wiring, low-power firmware, SWD pin remapping, and board soldering.
- `RTT_NOT_READY`: verify RTT/defmt initialization and early crashes.

## Safety

- Do not run flash or erase operations unless the user asked to program the target or explicitly enabled it.
- Prefer `info` before `attach`, and `attach` before `run`.
- Connect-under-reset requires NRST wiring and may fail on probes or boards that cannot drive reset.
- Report whether a command is destructive when recommending it.

## Verification

```powershell
node --check child/tools/swd-debugger/index.js
node --check child/tools/swd-debugger/core.js
node --check child/tools/swd-debugger/cli.js
node --check child/tools/swd-debugger/server.js
node --check child/tools/swd-debugger/ui/app.js
node child/tools/swd-debugger/index.js status
```

Physical SWD behavior requires a real probe and target. If hardware is unavailable, report that only syntax, packaging, and fallback diagnostics were verified.
