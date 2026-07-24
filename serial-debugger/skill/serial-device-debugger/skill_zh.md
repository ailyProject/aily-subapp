---
name: serial-device-debugger
description: "使用宿主无关的 serial-debugger 子应用调试 MCU 串口通信，包括 UART 日志、波特率不匹配、文本或 HEX 数据、行结束符、DTR/RTS 复位行为、bootloader 进入、帧格式问题、持久 CLI 会话、有界日志证据、自动测试场景、安全暂停/恢复和人工接管。"
---

# 串口设备调试器

使用这个 skill，通过 Aily 的 Serial Debugger 子工具调试 MCU UART 和串口工作流。Skill 负责流程与判断，领域 Tool 或 daemon-backed CLI 负责实际串口操作。

## 首轮排查

先明确串口契约：

1. 确认开发板、MCU、USB-UART 芯片、系统串口名、固件栈和期望波特率。
2. 记录 data bits、stop bits、parity、flow control、行结束符，以及设备期望的是文本、二进制还是 HEX 帧。
3. 索要实际 RX/TX 片段、固件日志，以及复位或 boot 模式是否依赖 DTR/RTS。
4. 区分物理连接问题和协议问题：无串口、打开被占用、无数据、乱码、帧格式错误、缺少换行、设备被复位。
5. 将工具输出视为固件调试证据，而不是设备端日志或示波器/逻辑分析仪检查的替代品。

## 工具边界

使用现有 child-tool 边界：

- 源码位于 `aily-subapp` 仓库的 `serial-debugger/`，集成后通常映射为 `child/tools/serial-debugger` 或 `tools/serial-debugger`。
- `serial-debugger/index.js` 选择 RPC、serve 或 CLI 模式。
- `serial-debugger/core.js` 和 `serial-debugger/runtime/` 负责持久串口会话、热事件历史、响应匹配、JSONL Journal、注册制 artifact、读写以及 DTR/RTS/BRK 信号。
- `serial-debugger/server.js` 提供 UI、`/ws`、token 校验、RPC method 映射，以及 `/health` 和 `/api/shutdown`。
- `serial-debugger/ui/src/app/app.ts`、`app.html` 和 `src/styles.scss` 渲染串口设置、收发日志、显示开关、快捷发送和文本/HEX 输入。
- `serial-debugger/dist/serial-debugger/ui/` 是 Angular 编译产物。除非明确要 patch 生成代码，否则不要手改。
- `serial-debugger/i18n/*.json` 拥有子工具可见文案。新增可见字符串时要更新每个 locale 文件。

不要把串口硬件访问放到 Angular 或浏览器 UI。硬件操作属于 `core.js`，静态服务和 RPC 属于 `server.js`，交互状态属于 `ui/src/app/` 和 `ui/src/styles.scss`。

## CLI 检查

纯 shell 场景先启动一个后台 Runtime，再跨命令复用：

```powershell
node serial-debugger/index.js daemon start
node serial-debugger/index.js daemon status
node serial-debugger/index.js ports
node serial-debugger/index.js open --port COM3 --baud 115200
node serial-debugger/index.js transact --text "AT" --cr --lf --expect-regex "OK|ERROR" --timeout 3000
node serial-debugger/index.js listen --duration 2000
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

只要发送后需要设备反馈，就优先使用 `transact`：它通过共享会话发送数据、等待期望的文本/正则/HEX 响应，并返回有界预览、游标和 artifact 引用。`write` 只用于单向发送。如果没有硬件可用，要说明限制并运行代码级检查，不要编造串口输出。

## Agent 工作流

当宿主暴露清单声明的领域 Tool 时，优先使用它们：

1. `serial_ports_list` 获取真实端口。
2. `serial_session_manage(action="open")` 打开共享会话；需要可视化时传 `presentUi="embedded"` 或 `"window"`。
3. `serial_transact` 执行一次发送并等待。
4. `serial_scenario_run` 在同一会话内执行由 `transact`、`send`、`wait`、`signal`、`capture` 组成的可重复流程；场景最多 50 步、120 秒。
5. 需要观察或人工介入时使用 `serial_scenario_control`。用 `pause` 请求在安全边界暂停；手动 TX 或切换信号前用 `takeover`，并等待状态变为 `paused` 或 `taken_over`。
6. 接管后只有 takeover owner 可以修改串口。人工检查结束后先 `release`；释放会故意保持 paused，确认后再单独 `resume`。用 `cancel` 可终止场景而不关闭串口。
7. 不要为了更快暂停而重试或重放非幂等发送。正在执行的 transact/send 到下一个安全边界再停；wait 步骤可协作式暂停。
8. 场景完成、超时或数据异常后，用 `serial_analysis_run` 做有界规则初筛。规则命中只是待验证的假设，必须结合对应 seq 的 Journal/artifact 页再判断根因。
9. `serial_logs_read` 读取小型增量事件页；需要跨分段或读取热内存窗口之外的时间范围时传 `source: "journal"`。
10. 大日志先从 `evidence.artifacts` 取 artifactId，用 `serial_artifact_search` 定位，再用 `serial_artifact_read` 读取相关页。
11. 完成整个调试流程后再关闭共享会话。

不要要求或返回完整的数 MB 串口日志。Tool 结果上限为 48 KiB，预览默认每种格式 2 KiB，日志与 artifact 页面默认 32 KiB；完整证据保存在 JSONL Journal 和 RX 文本 artifact 中。

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
- 将 daemon 发现、生命周期、锁和短命 WebSocket 客户端放在 `runtime/daemon.js` 与 `runtime/rpc-client.js`。
- 将持久化和 artifact 访问放在 `runtime/journal.js` 与 `runtime/artifact-store.js`；Agent Tool 不得接收任意文件路径。
- 将可重复场景执行放在 `runtime/scenario-runner.js`，暂停/接管所有权放在 `runtime/scenario-controller.js`，规则初筛放在 `runtime/analyzer.js`，旧会话安全清理放在 `runtime/retention.js`。
- 将 UI 状态、设置、日志、过滤、快捷发送和导出放在 `ui/src/` 的 Angular UI 中，然后重新构建 `dist/serial-debugger/ui/`。
- 除非 UI、CLI、server 和 host 同步更新，否则保持 JSON RPC contract 稳定。

## 验证

选择与变更匹配的检查：

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

验证真实串口行为时，报告 port、baud rate、serial options、TX payload、RX payload、DTR/RTS 状态和固件日志上下文。
