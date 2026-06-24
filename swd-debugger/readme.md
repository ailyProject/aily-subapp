# SWD 调试器

`swd-debugger` 是一个基于 `probe-rs` CLI 的 Aily Blockly 子应用，用于通过 SWD 对多种 MCU 做自动化调试、连接诊断、目标信息读取和固件烧录运行。

## 能力

- 检查本机 `probe-rs` 版本。
- 列出已连接的调试器。
- 使用 `probe-rs info --protocol swd` 读取目标信息。
- 使用 `probe-rs attach` 做短时附加测试。
- 使用 `probe-rs run` 烧录并运行 ELF/BIN/IHEX 等固件。
- 自动串联 version、list、info、attach、run，并把 stdout/stderr 归纳成 JSON 诊断结果。

## 运行

先安装子应用依赖：

```powershell
npm install --prefix swd-debugger
```

启动本地 UI：

```powershell
node swd-debugger/index.js serve --host 127.0.0.1 --port 0
```

`serve` 会输出一行 `ready` JSON，其中的 `url` 可直接打开。

## CLI

所有非 help 命令都输出单个 JSON 对象：

```powershell
node swd-debugger/index.js status
node swd-debugger/index.js version --probe-rs probe-rs
node swd-debugger/index.js list
node swd-debugger/index.js info --chip STM32F103C8 --speed-khz 4000
node swd-debugger/index.js attach --chip STM32F103C8 --connect-under-reset --timeout-ms 10000
node swd-debugger/index.js run --chip STM32F103C8 --firmware target/thumbv7m-none-eabi/debug/app
node swd-debugger/index.js auto --chip STM32F103C8 --include-attach
```

如果 `probe-rs` 不在 PATH，可通过 `--probe-rs C:\path\to\probe-rs.exe` 指定。

## AI 自动化调试流程

建议按这个顺序使用：

1. `version`：确认 `probe-rs` 可执行文件存在。
2. `list`：确认调试器被系统识别。
3. `info`：确认 SWD 物理链路和目标供电有效。
4. `attach`：确认芯片名、SWD 速度、复位策略可用。
5. `run`：在前面都可用后再烧录并运行固件。

自动诊断会识别常见问题，例如 `probe-rs` 未安装、找不到调试器、权限/驱动问题、芯片名不匹配、SWD 链路故障、需要复位下连接、RTT/defmt 未就绪等。

## 目录

- `index.js`：RPC、serve、CLI 入口。
- `core.js`：封装 `probe-rs` 命令、超时、日志和诊断。
- `cli.js`：命令行参数和 JSON 输出。
- `server.js`：本地 HTTP/WebSocket 服务。
- `ui/`：浏览器工作台。
- `i18n/`：多语言文案。
- `skill/`：AI 调试工作流说明。

## 注意

- 本工具不会随包安装 `probe-rs`，需要用户本机已有可执行文件。
- `run` 会写入目标 flash；自动流程默认不执行烧录，除非勾选或传入 `--include-flash`。
- 复位下连接需要调试器和目标板之间连接 NRST，否则可能超时。
- SWD 失败时优先检查 VTref、GND、SWDIO、SWCLK、目标供电、芯片低功耗状态和调试引脚复用。
