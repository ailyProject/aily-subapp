# Serial Debugger Angular UI

This Angular project is the browser UI for `serial-debugger`. It is served by the child tool backend, receives `lang` and `theme` context from the host through Penpal, and talks to the serial backend through `/ws`.

## Development

Install UI dependencies:

```powershell
npm install --prefix serial-debugger/ui
```

Build the UI for the child server:

```powershell
npm --prefix serial-debugger run build:ui
```

Run the complete standalone child tool from the repository root:

```powershell
npm run dev -- serial-debugger --open
```

The Angular source lives under `src/`. Hardware access stays in `../core.js`; the UI should only call backend RPC methods such as `serial.list`, `serial.connect`, `serial.write`, `serial.signal`, and `serial.disconnect`.
