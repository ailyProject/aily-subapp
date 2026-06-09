# Aily Blockly 子应用开发 README

这个仓库用于维护 Aily Blockly 可加载的独立子应用工具。这里的“子应用”是一个独立 Node 项目：它自己启动本地 HTTP/WebSocket 服务，浏览器 UI 由 Aily Blockly 通过 iframe 加载，核心能力可以同时提供给 UI、CLI 和 AI 自动化流程。

更完整的规范见 [tool-development-spec.md](tool-development-spec.md)，可复制模板见 [templates/subapp](templates/subapp)，现有工具和模板说明见 [subapp-development-template.md](subapp-development-template.md)。

## 什么时候做子应用

适合做 child 独立子应用的工具：

- 需要独立 Node 后台、硬件能力、原生依赖或长时间运行进程。
- 需要提供 AI 或脚本可调用的 JSON CLI。
- UI 希望脱离主 Angular 包独立迭代。
- 需要像一个小应用一样独立调试、打包和部署。

如果只是轻量纯前端页面，且完全依赖主应用已有能力，通常继续做 Angular 内置工具；复杂调试器、协议工具、烧录/文件系统/设备类工具优先采用子应用架构。

## 当前目录形态

在 `aily-tools` 仓库中，源码项目直接放在根目录：

```text
<tool-id>/
  package.json
  package-lock.json
  index.js
  core.js
  cli.js
  server.js
  readme.md
  i18n/
  ui/
  skill/
```

当前可参考的工具包括：

- `network-debugger`: 最清晰的通用参考，覆盖 `core.js`、JSON CLI、本地 HTTP/WebSocket 服务和浏览器 UI。
- `mqtt-debugger`: UI 侧连接 MQTT over WebSocket，后端主要负责服务生命周期和 RPC。
- `serial-debugger`: 串口调试器，包含独立 UI 构建流程。
- `industrial-bus-debugger`: CAN、RS485、Modbus 等协议构建和解析。
- `ble-debugger`: BLE 扫描、连接、GATT、读写和通知，包含原生依赖。
- `ffs-manager`: Flash 文件系统管理器，包含串口、esptool、WASM 和复杂静态资产。

构建后，`scripts/build-tools.mjs` 会把工具发布到根目录 `dist/`，并生成 `dist/index.json`。`dist/index.json` 是产物，通常不要手工改；需要调整主应用登记信息时，优先更新 `index-backup.json`。

## 快速创建一个子应用

从模板复制：

```powershell
Copy-Item -Recurse templates/subapp sensor-debugger
npm install --prefix sensor-debugger
```

然后替换模板占位符：

| 占位符 | 示例 | 用途 |
| --- | --- | --- |
| `{{tool-id}}` | `sensor-debugger` | 目录名、工具 id、bin 名 |
| `{{Tool Name}}` | `Sensor Debugger` | UI 标题和 README 标题 |
| `{{tool-description}}` | `Sensor debugger` | package 描述 |
| `{{TOOL_NAMESPACE}}` | `SENSOR_DEBUGGER` | i18n namespace |
| `{{tool_command}}` | `sensor` | CLI 示例命令片段 |
| `{{tool-skill-name}}` | `sensor-device-debugger` | AI skill 名称 |

替换 `{{tool-skill-name}}` 后，同步把 `skill/example-device-debugger/` 重命名为最终 skill 目录。

启动开发模式：

```powershell
npm run dev -- sensor-debugger --open
```

常用开发参数：

```powershell
npm run dev -- sensor-debugger --lang en --theme light
npm run dev -- sensor-debugger --port 18450 --reload-port 19450
```

开发脚本会调用工具自己的 `node index.js serve`，并模拟主应用传入的 `lang`、`theme`。修改 `ui/` 或 `i18n/` 会刷新页面；修改 `index.js`、`server.js`、`core.js`、`cli.js`、`package.json` 等后端文件会重启服务。

## 核心分层

每个子应用建议保持这几个边界：

- `index.js`: 统一入口，根据参数选择 `serve`、`rpc` 或 CLI 模式。
- `core.js`: 放真实工具能力，不依赖 UI、HTTP、WebSocket 或 Angular。
- `cli.js`: 解析命令行参数，调用 `core.js`，非 help 命令必须输出一个 JSON 对象。
- `server.js`: 提供本地 HTTP 静态资源、`/ws` JSON-RPC、`/health`、`/api/shutdown` 和 token 校验。
- `ui/`: 浏览器页面，不直接使用 Node/Electron API。
- `i18n/`: 子应用自己的语言包，至少提供 `en.json` 和 `zh_cn.json`。
- `skill/`: 可选的 AI 工作流说明，建议同时保留 `SKILL.md` 和 `skill_zh.md`。

不要把工具核心逻辑分散复制到 UI、CLI 和 HTTP 层。先把能力写进 `core.js`，再由 CLI 和 WebSocket RPC 调用它。

## 运行契约

子应用服务模式命令：

```powershell
node sensor-debugger/index.js serve --host 127.0.0.1 --port 0
```

要求：

- 只监听 `127.0.0.1`。
- 默认 `--port 0`，由系统分配随机端口。
- 每次启动生成随机 token。
- stdout 必须输出一行 `ready` JSON。
- `/ws` 和敏感 API 必须校验 token。

`ready` 输出示例：

```json
{
  "event": "ready",
  "data": {
    "mode": "serve",
    "url": "http://127.0.0.1:54321/?token=...",
    "origin": "http://127.0.0.1:54321",
    "wsUrl": "ws://127.0.0.1:54321/ws?token=...",
    "shutdownUrl": "http://127.0.0.1:54321/api/shutdown?token=...",
    "port": 54321,
    "pid": 1234
  }
}
```

Aily Blockly 宿主拿到 `ready.url` 后，会在 iframe 加载前追加当前上下文：

```text
?token=...&lang=zh_cn&theme=dark
```

所以 UI 首屏必须先从 URL 读取 `token`、`lang`、`theme`，不能等 Penpal 建立后才处理语言和主题。

## 通信方式

子应用采用两层通信：

```text
Aily Blockly host <-> child UI iframe
  Penpal: 只负责宿主控制面

child UI <-> child backend
  WebSocket JSON-RPC: 负责工具数据面
```

Penpal 适合做：

- `childReady(...)`
- `childError(...)`
- `setHostContext(...)`
- `beforeClose()`
- `requestClose()`
- `requestRestart()`
- `openExternal(url)`

WebSocket 适合做：

- 设备扫描、连接、读写、订阅。
- 日志流、硬件事件、协议帧、请求响应。
- UI 到后端的实时 JSON-RPC。

高频数据不要经由 Angular 父页面转发，父页面只负责启动进程、加载 iframe、建立宿主控制面和关闭进程。

## UI、语言和主题

子应用 UI 必须能作为普通浏览器页面独立运行：

- 不依赖 Electron preload。
- 不直接 `require` Node 模块。
- 没有父页面 Penpal host 时也能完成基础渲染和后端连接。
- 从 `/i18n/<lang>.json` 加载语言包，缺失时回退到 `/i18n/en.json`。
- 从 `ui/light.css` 或 `ui/dark.css` 加载主题。
- `styles.css` 放布局、尺寸、状态等通用规则；`light.css` 和 `dark.css` 放颜色变量或主题覆盖。

语言包推荐结构：

```json
{
  "SENSOR_DEBUGGER": {
    "TITLE": "Sensor Debugger",
    "DESCRIPTION": "Debug sensor devices"
  }
}
```

新增可见文本时同步更新语言包。调试类工具 UI 应紧凑、可扫描，日志、UUID、长数据必须支持换行和滚动。

## 注册到 Aily Blockly

在 `aily-tools` 中，主应用登记模板来自 `index-backup.json`，构建后写入 `dist/index.json`。新增工具时添加类似条目：

```json
{
  "sensor-debugger": {
    "id": "sensor-debugger",
    "titleKey": "SENSOR_DEBUGGER.TITLE",
    "namespace": "SENSOR_DEBUGGER",
    "app": {
      "name": "SENSOR_DEBUGGER.TITLE",
      "description": "SENSOR_DEBUGGER.DESCRIPTION",
      "icon": "fa-light fa-puzzle-piece",
      "enabled": true
    },
    "childDir": "tools/sensor-debugger",
    "routePath": "/child-tool/sensor-debugger",
    "requiredDependencies": ["ws", "penpal"],
    "installHint": "Run npm run install:sensor-debugger in the project root."
  }
}
```

需要特别区分三件事：

- 源码目录：在本仓库通常是根目录 `<tool-id>/`。
- 构建产物：`npm run build -- <tool-id>` 后进入 `dist/<tool-id>/`。
- 宿主运行路径：Aily Blockly 中通常通过 `childDir: "tools/<tool-id>"` 找到打包后的工具。

`ffs-manager` 是一个历史特例：源码目录是 `ffs-manager/`，但登记 id 可以是 `ffs-manager-child`，通过 `childDir: "tools/ffs-manager"` 指向实际目录。新增工具尽量避免让 id、目录名和 `childDir` 不一致。

## 构建和发布

构建单个工具：

```powershell
npm run build -- sensor-debugger
```

构建所有工具：

```powershell
npm run build
```

构建脚本会：

- 自动发现根目录下带 `package.json` 的工具项目。
- 使用 esbuild 打包 Node 入口。
- 复制 `ui/`、`i18n/`、`skill/` 和 Penpal vendor。
- 为原生运行时依赖保留必要安装内容。
- 汇总所有工具到根目录 `dist/`。
- 根据 `index-backup.json` 和当前构建结果生成 `dist/index.json`。

如果工具需要 Vite、Svelte、React、Vue 等独立 UI 构建器，把构建脚本放在工具自己的 `package.json` 中，并保证最终 UI 产物进入构建目录的 `ui/`。

## 最小验证清单

语法检查：

```powershell
node --check sensor-debugger/index.js
node --check sensor-debugger/core.js
node --check sensor-debugger/cli.js
node --check sensor-debugger/server.js
node --check sensor-debugger/ui/app.js
```

CLI 检查：

```powershell
node sensor-debugger/index.js --help
node sensor-debugger/index.js status
```

服务检查：

```powershell
node sensor-debugger/index.js serve --host 127.0.0.1 --port 0
```

需要确认：

- stdout 输出 `ready` JSON。
- `ready.url` 追加 `lang`、`theme` 后能打开 UI。
- `/i18n/<lang>.json` 可加载，缺失语言能回退到 `en.json`。
- `light.css` 和 `dark.css` 能正确切换。
- `/ws?token=...` 能连接并执行 `status`。

构建检查：

```powershell
npm run build -- sensor-debugger
```

如果已经接入 Aily Blockly 主仓库，还要验证共享宿主链路：`ChildToolHostComponent` 启动进程、iframe 加载、Penpal ready、语言/主题同步、关闭或重启时进程退出。不要为每个 child 工具新增独立 Angular wrapper。

## 新工具开发顺序

1. 确定工具 id、名称、图标、i18n namespace 和是否需要原生依赖。
2. 从 `templates/subapp` 复制目录，替换占位符并重命名 skill 目录。
3. 在 `core.js` 中实现真实能力。
4. 在 `cli.js` 中暴露关键命令，并保证 JSON 输出。
5. 在 `server.js` 中添加 WebSocket RPC method 和事件广播。
6. 在 `ui/` 中实现浏览器页面，接入 token、i18n、theme、Penpal 和 WebSocket。
7. 在 `index-backup.json` 中添加登记信息。
8. 执行语法、CLI、serve 和构建检查。
9. 将 `dist/` 产物交给 Aily Blockly 宿主验证 iframe/Penpal 生命周期。

## 常见踩坑

- 只改 `dist/index.json`：它是构建产物，下次 build 会被覆盖；应改 `index-backup.json`。
- `childDir` 写错：源码目录在本仓库根部，但宿主通常找 `tools/<tool-id>`。
- UI 等 Penpal 后才加载语言和主题：首屏会短暂错语言或错主题；必须先读 URL 参数。
- 高频日志走 Penpal：会拖慢宿主控制面；日志和设备事件应走 WebSocket。
- CLI 输出混入普通文本：AI/脚本解析会失败；非 help 命令只输出 JSON。
- Windows 下批量写中文 JSON：容易出现编码问题；语言包建议用 UTF-8-aware 的 Node 脚本读写和 `JSON.parse` 验证。
