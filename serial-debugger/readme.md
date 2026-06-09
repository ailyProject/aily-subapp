# 串口调试器

`serial-debugger` 是从 Blockly 内置 `serial-monitor` 操作模型拆出的独立子应用，用于 MCU 串口日志查看、文本/HEX 发送、DTR/RTS 信号切换和常见串口参数调试。

## 适用场景

- 打开本机串口并实时查看 RX/TX 数据。
- 按文本或 HEX 模式发送数据。
- 配置 baud rate、data bits、stop bits、parity 和 flow control。
- 切换 DTR/RTS，用于复位、进入 boot 模式或验证硬件握手。
- 通过 CLI 为 AI、脚本或自动化流程提供串口枚举和一次性写入能力。

## 运行方式

安装依赖：

```powershell
npm install --prefix serial-debugger
```

启动独立 UI：

```powershell
node serial-debugger/index.js serve --host 127.0.0.1 --port 0
```

或使用仓库开发脚本：

```powershell
npm run dev -- serial-debugger --open
```

CLI 检查：

```powershell
node serial-debugger/index.js --help
node serial-debugger/index.js status
node serial-debugger/index.js ports
node serial-debugger/index.js write --port COM3 --baud 115200 --text "hello" --cr --lf
node serial-debugger/index.js write --port COM3 --baud 115200 --hex "01 02 03"
node serial-debugger/index.js signal --port COM3 --baud 115200 --dtr true
```

## 目录结构

- `index.js`：选择 `rpc`、`serve` 或 CLI 模式。
- `core.js`：封装 `serialport`，负责枚举、连接、收发和信号控制。
- `server.js`：提供本地 HTTP 静态服务、WebSocket RPC、token 校验、`/health` 和 `/api/shutdown`。
- `cli.js`：命令行参数解析和 JSON 输出。
- `ui/`：Angular UI 工程，使用 Penpal 接收宿主上下文，并通过 WebSocket 调后端。
- `dist/serial-debugger/ui/`：Angular 编译后的浏览器静态资源，由 `npm --prefix serial-debugger run build:ui` 或根目录 `npm run build -- serial-debugger` 生成。
- `i18n/`：子应用多语言文案。
- `skill/`：面向 AI 调试工作流的本地 skill。

## 设计边界

串口硬件能力只放在 `core.js`，UI 不直接访问 Node/Electron API。主应用只负责启动子进程、加载 iframe、传入 `lang/theme` 和处理 Penpal 生命周期。

## 验证

```powershell
node --check serial-debugger/index.js
node --check serial-debugger/core.js
node --check serial-debugger/cli.js
node --check serial-debugger/server.js
npm --prefix serial-debugger run build:ui
node serial-debugger/index.js --help
node serial-debugger/index.js status
node serial-debugger/index.js ports
npm run build -- serial-debugger
```
