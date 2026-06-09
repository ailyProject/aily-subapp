---
name: serial-device-debugger
description: "当在 Aily Blockly 或 Aily Chat AI IDE 中开发或调试 MCU 串口通信时使用，包括 UART 日志、波特率不匹配、文本或 HEX 数据、行结束符、DTR/RTS 复位行为、bootloader 进入、帧格式问题，以及 serial-debugger 子工具。"
---

# 串口设备调试器

使用这个 skill，通过 Aily 的 Serial Debugger 子工具调试 MCU UART 和串口工作流。

## 首轮排查

先明确串口契约：

1. 确认开发板、MCU、USB-UART 芯片、系统串口名、固件栈和期望波特率。
2. 记录 data bits、stop bits、parity、flow control、行结束符，以及设备期望的是文本、二进制还是 HEX 帧。
3. 索要实际 RX/TX 片段、固件日志，以及复位或 boot 模式是否依赖 DTR/RTS。
4. 区分物理连接问题和协议问题：无串口、打开被占用、无数据、乱码、帧格式错误、缺少换行、设备被复位。
5. 将工具输出视为固件调试证据，而不是设备端日志或示波器/逻辑分析仪检查的替代品。

## 工具边界

使用现有 child-tool 边界：

- 源码位于 `aily-tools` 仓库的 `serial-debugger/`，集成后通常映射为 `child/tools/serial-debugger` 或 `tools/serial-debugger`。
- `serial-debugger/index.js` 选择 RPC、serve 或 CLI 模式。
- `serial-debugger/core.js` 负责 `serialport` 枚举、连接、读写、DTR/RTS/BRK 信号和状态信息。
- `serial-debugger/server.js` 提供 UI、`/ws`、token 校验、RPC method 映射，以及 `/health` 和 `/api/shutdown`。
- `serial-debugger/ui/App.svelte` 渲染串口设置、收发日志、显示开关、快捷发送和文本/HEX 输入。
- `serial-debugger/dist/serial-debugger/ui/app.js` 是编译产物。除非明确要 patch 生成代码，否则不要手改。
- `serial-debugger/i18n/*.json` 拥有子工具可见文案。新增可见字符串时要更新每个 locale 文件。

不要把串口硬件访问放到 Angular 或浏览器 UI。硬件操作属于 `core.js`，静态服务和 RPC 属于 `server.js`，交互状态属于 `ui/App.svelte`。

## CLI 检查

从仓库根目录运行：

```powershell
node serial-debugger/index.js --help
node serial-debugger/index.js status
node serial-debugger/index.js ports
node serial-debugger/index.js write --port COM3 --baud 115200 --text "hello" --cr --lf
node serial-debugger/index.js write --port COM3 --baud 115200 --hex "01 02 03"
node serial-debugger/index.js signal --port COM3 --baud 115200 --dtr true
```

所有非 help CLI 命令都向 stdout 输出一个 JSON 对象。如果没有硬件可用，要说明限制并运行代码级检查，不要编造串口输出。

## 调试路径

沿失败阶段排查：

- 无串口：检查线材类型、USB 驱动、权限、设备管理器，以及是否有其它进程占用串口。
- 打开被拒绝：关闭 IDE 监视器、上传工具、终端会话或残留子工具进程。
- 乱码：先验证波特率，再检查数据位、校验位、停止位、时钟源和电平。
- 无 RX：检查 MCU TX 引脚、GND、固件日志开关、复位状态，以及开发板是否处于 bootloader 模式。
- TX 无效果：确认换行策略、命令结束符、文本/HEX 模式、校验和与协议帧格式。
- 意外复位：检查 DTR/RTS 行为、自动复位电路、boot strapping 引脚和快捷信号切换。
- UI 卡住：检查后端 ready JSON、WebSocket token、`/health`、Penpal `childReady` 和浏览器控制台错误。

## 固件建议

设计 MCU 串口固件时：

- 启动时打印固件版本、波特率、板卡/芯片、协议模式和复位原因。
- 明确定义命令解析：结束符、二进制帧头、长度、校验和与超时。
- 解析失败时记录字节数或 HEX 片段，但避免在高频数据流中刷屏。
- 保留确定性的 hello 命令和响应，方便验证串口链路。
- 对 bootloader 流程，文档化 DTR/RTS 脉冲顺序和期望时序。

## 修改工具

修改 Serial Debugger 工具本身时：

- 将串口枚举、打开/关闭、读写和信号控制放在 `core.js`。
- 将静态服务、token 校验、WebSocket RPC、`/health` 和 shutdown 放在 `server.js`。
- 将 CLI 参数解析和 JSON 输出放在 `cli.js`。
- 将 UI 状态、设置、日志、过滤、快捷发送和导出放在 `ui/App.svelte`，然后重新构建 `dist/serial-debugger/ui/app.js`。
- 除非 UI、CLI、server 和 host 同步更新，否则保持 JSON RPC contract 稳定。

## 验证

选择与变更匹配的检查：

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
node --check serial-debugger/dist/serial-debugger/ui/app.js
npm run build -- serial-debugger
```

验证真实串口行为时，报告 port、baud rate、serial options、TX payload、RX payload、DTR/RTS 状态和固件日志上下文。
