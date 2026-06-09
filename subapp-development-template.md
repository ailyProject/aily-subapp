# Aily Tools 子应用总结与开发模板

本文档总结当前 `aily-tools` 仓库里的独立子应用，并提供一个可复制的开发模板。这里的“子应用”指每个独立工具目录，例如 `network-debugger/`、`ble-debugger/`，它们都可以通过 `node index.js serve` 启动本地 HTTP/WS 服务，再由主应用以 iframe 方式加载。

## 1. 现有子应用概览

| 子应用 | 定位 | 核心能力 | CLI / 后端边界 | 特殊依赖或资产 |
| --- | --- | --- | --- | --- |
| `mqtt-debugger` | MQTT 调试器 | 在浏览器 UI 中连接 MQTT over WebSocket broker，订阅、发布、查看消息和日志 | 后端主要负责生命周期、静态资源、WebSocket RPC、`status`；实际 MQTT 交互在 UI 中完成 | `penpal`、`ws` |
| `network-debugger` | 网络调试器 | HTTP 请求调试和外部 WebSocket 连接测试 | HTTP request 在 Node `core.js` 中执行；CLI 提供 `request`；外部 WebSocket 测试在 UI 中执行 | `penpal`、`ws` |
| `industrial-bus-debugger` | 工业总线协议调试器 | CAN/CAN FD、RS485、Modbus RTU/TCP 的帧构建、解析、CRC 校验和日志记录 | CLI 提供 CAN、RS485、Modbus 构建/解析命令；当前不直接驱动物理 CAN/RS485 硬件发送 | `penpal`、`ws` |
| `ble-debugger` | BLE 调试器 | 扫描 BLE 设备、连接外设、查看 GATT、读写 characteristic、订阅通知 | BLE 能力在 Node `core.js` 中通过 noble 封装；CLI 提供 scan/gatt/read/write/notify 等硬件调试入口 | `@abandonware/noble`、`penpal`、`ws` |
| `ffs-manager` | Flash 文件系统管理器 | 面向 ESP MCU 读取芯片/分区信息，导出/恢复镜像，浏览和编辑 SPIFFS/LittleFS/FATFS 文件 | 串口、esptool、分区读写在 Node 后端；文件系统镜像浏览/编辑在 UI + WASM 中完成；CLI 提供 ports/info/partitions/read/erase | `esptool-js`、`serialport`、`ws`、`penpal`、`ui/wasm/` |

注意：`ffs-manager` 的源码目录是 `ffs-manager/`，但历史宿主配置里可能使用 `ffs-manager-child` 作为 app/tool id，并通过 `childDir: "tools/ffs-manager"` 指向实际目录。新增工具时要避免 id、目录名和 `childDir` 混用导致“注册了但打不开”。

## 2. 共同架构

当前子应用基本采用同一套分层：

```text
<tool-id>/
  package.json
  index.js        # 入口：rpc / serve / CLI
  core.js         # 核心能力，不依赖 UI/HTTP/Angular
  cli.js          # 命令行解析，所有非 help 命令输出 JSON
  server.js       # 本地 HTTP + WebSocket JSON-RPC + token + shutdown
  readme.md
  i18n/
    en.json
    zh_cn.json
    ...
  ui/
    index.html      # required host entry
    ... static files, framework bundles, or assets referenced by index.html
  skill/
    <skill-name>/
      SKILL.md
      skill_zh.md
      agents/openai.yaml
```

运行契约：

- `node index.js serve --host 127.0.0.1 --port 0` 启动子应用服务。
- 服务只监听本机地址，并为每次启动生成或接收一个 `token`。
- stdout 输出一行 `{"event":"ready","data":{...}}`，其中包含 `url`、`wsUrl`、`shutdownUrl`、`port`、`pid`。
- UI 从 URL 读取 `token`、`lang`、`theme`，先完成基础渲染，再通过 WebSocket 调后端。
- UI 通过 `/i18n/<lang>.json` 加载语言包，服务端同时兼容 `/tools/<tool-id>/i18n/<lang>.json`，并在首屏和 `setHostContext` 中响应 `theme`。
- iframe 与宿主之间只用 Penpal 做控制面通信，例如 `childReady`、`childError`、`setHostContext`、`beforeClose`。
- 高频数据、硬件事件、日志流、RPC 请求都走子应用自己的 `/ws?token=...`。

根仓库脚本：

- `npm run dev -- <tool-id>`：由 `scripts/dev-tool.mjs` 启动单个工具，注入 `lang/theme`，监听 `ui/`、`i18n/` 热刷新，后端文件变更后自动重启。
- `npm run build -- <tool-id>`：由 `scripts/build-tools.mjs` 用 esbuild 打包 Node 入口，并复制 `i18n`、`skill` 和 Penpal vendor；没有 `build:ui` 时复制 `ui`，有 `build:ui` 时运行该脚本生成静态 UI。

## 3. 开发模板

模板目录已经放在：

```text
templates/subapp/
templates/subapp-angular/
templates/subapp-vue/
```

使用方式：

```powershell
Copy-Item -Recurse templates/subapp <tool-id>
```

复制后全局替换这些占位符：

| 占位符 | 示例 | 用途 |
| --- | --- | --- |
| `{{tool-id}}` | `sensor-debugger` | 目录名、服务工具 id、bin 名 |
| `{{Tool Name}}` | `Sensor Debugger` | UI 标题、README 标题 |
| `{{tool-description}}` | `Sensor debugger` | package 描述、说明文案 |
| `{{TOOL_NAMESPACE}}` | `SENSOR_DEBUGGER` | i18n namespace |
| `{{tool_command}}` | `sensor` | CLI/bin 友好命令片段 |
| `{{tool-skill-name}}` | `sensor-device-debugger` | skill 名称，复制后建议同步重命名 skill 子目录 |

替换占位符后再安装依赖并启动：

```powershell
npm install --prefix <tool-id>

# 仅 templates/subapp-angular 和 templates/subapp-vue 需要
npm install --prefix <tool-id>/ui
npm run build:ui --prefix <tool-id>

npm run dev -- <tool-id> --open
```

最小验证：

```powershell
node --check <tool-id>/index.js
node --check <tool-id>/core.js
node --check <tool-id>/cli.js
node --check <tool-id>/server.js

# 仅适用于 templates/subapp 纯 JS UI；Angular/Vue 等框架 UI 通过 build:ui 验证
node --check <tool-id>/ui/app.js

# 适用于 templates/subapp-angular 和 templates/subapp-vue
npm run build:ui --prefix <tool-id>
node <tool-id>/index.js --help
node <tool-id>/index.js status
node <tool-id>/index.js echo --message hello
npm run dev -- <tool-id> --open
npm run build -- <tool-id>
```

## 4. 集成到主应用时的登记模板

在主应用侧，子应用通常由 `child/tools/index.json` 或等价配置登记。以新工具 `<tool-id>` 为例：

```json
{
  "<tool-id>": {
    "id": "<tool-id>",
    "titleKey": "TOOL_NAMESPACE.TITLE",
    "namespace": "TOOL_NAMESPACE",
    "app": {
      "name": "TOOL_NAMESPACE.TITLE",
      "description": "TOOL_NAMESPACE.DESCRIPTION",
      "icon": "fa-light fa-puzzle-piece",
      "enabled": true
    },
    "childDir": "tools/<tool-id>",
    "routePath": "/child-tool/<tool-id>",
    "requiredDependencies": ["ws", "penpal"],
    "installHint": "Run npm run install:<tool-id> in the project root."
  }
}
```

在 `aily-tools` 仓库里，源码目录直接位于根目录 `<tool-id>/`；在主应用打包或部署时，通常会映射到 `child/tools/<tool-id>` 或 `tools/<tool-id>`。新增工具时要同时确认源码目录、打包复制路径、运行时 `childDir` 三者一致。

## 5. 新子应用开发检查表

- 先明确工具边界：哪些能力放 `core.js`，哪些交互放 UI，哪些命令要暴露给 AI/脚本 CLI。
- 创建工具目录并替换模板占位符。
- 添加 `i18n/en.json`、`i18n/zh_cn.json` 和 `i18n/zh_hk.json`，后续再补齐其它 locale。
- 如果需要硬件或原生模块，把依赖放在子应用自己的 `package.json`，不要依赖根项目。
- 在 `server.js` 中新增 RPC method 映射，在 `core.js` 中实现真实能力。
- 在 `cli.js` 中为关键能力提供 JSON CLI。
- UI 必须能在无父页面 Penpal host 的情况下独立打开和连接后端。
- UI 新增可见字符串时同步更新语言包。
- 纯静态 UI 修改主题时推荐保持 `styles.css` 放布局、`light.css` / `dark.css` 放颜色变量；Angular/Vue 等框架 UI 可以使用构建产物、CSS variables、class 或 data attribute 实现主题。
- 跑完语法检查、CLI 检查、serve 检查和构建检查，再接入主应用验证 iframe/Penpal 生命周期。
