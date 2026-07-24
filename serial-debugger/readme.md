# 串口调试器

`serial-debugger` 是宿主无关的独立子应用，用于 MCU 串口日志查看、文本/HEX 发送、DTR/RTS 信号切换和常见串口参数调试。它不导入或依赖任何 Blockly 实现。

## 适用场景

- 打开本机串口并实时查看 RX/TX 数据。
- 按文本或 HEX 模式发送数据。
- 配置 baud rate、data bits、stop bits、parity 和 flow control。
- 切换 DTR/RTS，用于复位、进入 boot 模式或验证硬件握手。
- 通过 CLI 为 AI、脚本或自动化流程提供持久会话、发送并等待响应、多步骤场景执行和规则分析能力。

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
node serial-debugger/index.js daemon start
node serial-debugger/index.js daemon status
node serial-debugger/index.js ports
node serial-debugger/index.js open --port COM3 --baud 115200
node serial-debugger/index.js transact --text "AT" --cr --lf --expect-regex "OK|ERROR" --timeout 3000
node serial-debugger/index.js listen --duration 2000
node serial-debugger/index.js write --hex "01 02 03"
node serial-debugger/index.js signal --dtr true
node serial-debugger/index.js logs --after-seq 0 --max-bytes 32768
node serial-debugger/index.js logs --source journal --from-timestamp 1753200000000 --max-bytes 32768
node serial-debugger/index.js scenario --file serial-scenario.json
node serial-debugger/index.js analysis --source journal --max-events 5000 --max-findings 20
node serial-debugger/index.js artifact-search --artifact-id journal-000001 --query ERROR
node serial-debugger/index.js artifact-read --artifact-id journal-000001 --offset 0 --max-bytes 32768
node serial-debugger/index.js scenario-control status
node serial-debugger/index.js scenario-control pause --reason "inspect device"
node serial-debugger/index.js scenario-control takeover --reason "manual probe"
node serial-debugger/index.js scenario-control release
node serial-debugger/index.js scenario-control resume
node serial-debugger/index.js scenario-control cancel
node serial-debugger/index.js daemon stop
```

`daemon start` 启动唯一后台 Runtime，后续短命 CLI 命令复用同一个串口会话。独立终端启动的 daemon 默认持续运行，需显式执行 `daemon stop`；由 Agent Execution Host 启动时，CLI 会自动读取宿主注入的会话租约，宿主会话结束或宿主进程异常退出后 daemon 自动停止并释放串口。`--persist` 只用于用户明确拥有、需要跨 Agent 会话持续运行的 daemon。发送后需要读取设备反馈时应使用 `transact`；重复的真人测试流程使用 `scenario`，初步诊断使用 `analysis`。场景可通过独立 CLI、Agent Tool 或 UI 执行暂停、接管、释放、恢复和取消：暂停/接管在安全步骤边界生效，正在执行的非幂等发送不会重放；接管期间只有接管者可以修改串口；释放后场景仍保持暂停，必须显式恢复。完整 JSONL Journal 与 RX 文本日志写入磁盘，数 MB 日志不要直接返回 Agent。`logs --source journal` 支持跨分段 seq/时间范围查询；旧会话默认保留 7 天，并按总量预算安全清理。`write` 只适合不需要反馈的单向发送。

## Agent 与兼容宿主联动

子应用通过 `agent/tools.json` 声明九个领域 Tool：

- `serial_ports_list`：枚举真实串口。
- `serial_session_manage`：打开、查询、关闭共享持久会话；`presentUi` 可同步打开内嵌或独立页面。
- `serial_transact`：发送并等待匹配响应，返回有界 RX 预览、耗时、事件游标与 artifact。
- `serial_logs_read`：按 seq/时间范围和字节预算读取内存或跨分段 Journal 事件。
- `serial_artifact_search`：在已注册 Journal/文本日志中搜索，只返回匹配行预览。
- `serial_artifact_read`：按字节 offset 读取最多 32 KiB 的 artifact 页面。
- `serial_scenario_run`：在同一持久会话内按顺序执行 transact、send、wait、signal、capture，最多 50 步、120 秒。
- `serial_scenario_control`：查询、暂停、恢复、人工接管、释放或取消活动场景，不关闭共享串口会话。
- `serial_analysis_run`：对有界事件窗口执行确定性规则初筛，返回 findings、seq 证据和 artifact 引用。

兼容宿主从 npm 包的 `ailySubapp.agent` 声明发现 `agent/tools.json` 与 Skill，并通过通用 `aily-child-rpc` transport 调用领域 Tool；serial-debugger 不感知宿主框架。宿主调用、Serial Debugger UI、CLI 与手动操作共享同一个后端进程：CLI daemon 先启动时，`serve` 进程会附着它；`serve` 先启动时，CLI 从运行时描述文件发现它。页面会回放已有事件，显示 Journal 与自动场景运行状态，并用 `AGENT` 标识自动打开、发送、等待、匹配或失败步骤。页面搜索可继续查询已落盘的 RX/Journal artifact，而不会把整份日志装入浏览器或 Agent 上下文。Skill 负责调试策略与安全规则，Tool 负责有状态执行；Analyzer 的规则命中是待验证假设，不直接等同于最终根因。

支持取消的 Tool 使用 `runtime.request.cancel` 将宿主的 AbortSignal 传到 Runtime；transact、capture、expect、scenario wait 和 signal pulse 会停止等待并清理 timer/listener，pulse 取消时仍恢复最终信号状态。通用宿主在连接建立失败时只重新获取一次 Runtime endpoint；已经发送的领域请求绝不自动重放，避免重复 TX 或重复切换设备状态。

本地联调：

```powershell
cd D:\codes\aily-subapp
npm run dev:link -- serial-debugger

cd D:\codes\aily-blockly
npm run electron
```

## 目录结构

- `index.js`：选择 `rpc`、`serve` 或 CLI 模式。
- `core.js`：Serial Runtime 兼容入口，负责会话、枚举、连接、收发和信号控制。
- `runtime/`：事件历史、响应匹配、结果预算、daemon 发现、JSONL Journal、artifact、保留策略、场景执行、场景控制和规则分析。
- `server.js`：提供本地 HTTP 静态服务、WebSocket RPC、token 校验、`/health` 和 `/api/shutdown`。
- `cli.js`：daemon-backed 命令行参数解析和不超过 48 KiB 的 JSON 输出。
- `ui/`：Angular UI 工程，使用 Penpal 接收宿主上下文，并通过 WebSocket 调后端。
- `dist/serial-debugger/ui/`：Angular 编译后的浏览器静态资源，由 `npm --prefix serial-debugger run build:ui` 或根目录 `npm run build -- serial-debugger` 生成。
- `i18n/`：子应用多语言文案。
- `skill/`：面向 AI 调试工作流的本地 skill。
- `agent/tools.json`：Agent Tool 契约、权限、超时和输入上限。

## 设计边界

串口硬件能力只放在 `core.js`，UI 不直接访问 Node/Electron API。宿主只需要实现通用子应用生命周期、iframe 上下文和 `aily-child-rpc` transport；不得在 serial-debugger 内导入宿主代码，也不得要求宿主内置串口专用桥接。

## 验证

```powershell
node --check serial-debugger/index.js
node --check serial-debugger/core.js
node --check serial-debugger/cli.js
node --check serial-debugger/server.js
npm --prefix serial-debugger run build:ui
node serial-debugger/index.js --help
node serial-debugger/index.js daemon start
node serial-debugger/index.js daemon status
node serial-debugger/index.js daemon stop
npm --prefix serial-debugger test
npm run build -- serial-debugger
```
