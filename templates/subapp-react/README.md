# {{Tool Name}}

`{{Tool Name}}` is a performance-oriented React child application template for Aily Blockly / Aily Chat AI IDE. Copy this directory, replace the placeholders, and then put the real tool behavior in `core.js`, `cli.js`, `server.js`, and `ui/src/`.

## Replace Placeholders

- `{{tool-id}}`: kebab-case tool id, for example `sensor-debugger`.
- `{{Tool Name}}`: display name, for example `Sensor Debugger`.
- `{{tool-description}}`: short package and README description.
- `{{TOOL_NAMESPACE}}`: i18n namespace, for example `SENSOR_DEBUGGER`.
- `{{tool_command}}`: short command name used in examples.
- `{{tool-skill-name}}`: skill name, for example `sensor-device-debugger`.

After replacing `{{tool-skill-name}}`, rename `skill/example-device-debugger/` to the final skill directory.

## Run

```powershell
npm install --prefix {{tool-id}}
npm install --prefix {{tool-id}}/ui
npm run build:ui --prefix {{tool-id}}
node {{tool-id}}/index.js --help
node {{tool-id}}/index.js status
node {{tool-id}}/index.js echo --message hello
node {{tool-id}}/index.js serve --host 127.0.0.1 --port 0
```

After replacing placeholders, run `npm install --prefix {{tool-id}}` if you want to generate or refresh a lockfile. `npm run build:ui --prefix {{tool-id}}` writes the deliverable browser UI to `dist/{{tool-id}}/ui`.

From the `aily-tools` root:

```powershell
npm run dev -- {{tool-id}} --open
npm run build -- {{tool-id}}
```

## Structure

- `index.js`: selects `rpc`, `serve`, or CLI mode.
- `core.js`: owns the real tool behavior and is independent from UI/HTTP.
- `cli.js`: parses arguments and writes one JSON object for every non-help command.
- `server.js`: serves the built React UI from `dist/{{tool-id}}/ui` in source mode, falls back to packaged `ui/`, exposes `/ws`, validates `token`, and handles `/health` plus `/api/shutdown`.
- `scripts/build-ui.mjs`: builds React/Vite into the static UI output directory expected by `build-tools.mjs`.
- `ui/`: React browser-only source. Built output may use generated JS/CSS names; only `ui/index.html` is fixed for the host.
- `i18n/`: child-tool language bundles for `en`, `zh_cn`, and `zh_hk`; app metadata uses `TITLE` and `DESCRIPTION`.
- `skill/`: optional AI workflow instructions for using this tool.
