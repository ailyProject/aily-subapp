# 工业总线调试器

工业总线调试器是用于 MCU 工业通信协议开发的独立子应用，覆盖 CAN、CAN FD、RS485 和 Modbus RTU/TCP 的帧构建、解析、CRC 校验和日志记录。当前工具主要是协议帧构建器、解析器和调试辅助工具，不直接驱动物理 CAN 或 RS485 硬件发送。

## 适用场景

- 构建和校验 CAN 标准帧、扩展帧、数据帧、远程帧和 CAN FD 配置。
- 解析 CAN trace，例如 `123#DEADBEEF`。
- 为 RS485 payload 生成十六进制输出，并可追加 Modbus CRC。
- 构建 Modbus RTU/TCP 请求，解析响应、异常码、寄存器值和 CRC/MBAP 信息。
- 在固件调试时对照设备串口日志、总线分析仪输出和工具解析结果。

## 运行方式

在本仓库根目录安装该子应用依赖：

```powershell
npm install --prefix industrial-bus-debugger
```

本地启动浏览器 UI：

```powershell
node industrial-bus-debugger/index.js serve --host 127.0.0.1 --port 0
```

`serve` 模式会输出 `ready` JSON，里面的 `url` 可直接打开。集成到 IDE 时由宿主启动该模式，并通过 iframe 和 WebSocket RPC 使用工具能力。

查看 CLI 帮助和状态：

```powershell
node industrial-bus-debugger/index.js --help
node industrial-bus-debugger/index.js status
```

构建分发包：

```powershell
npm run build -- industrial-bus-debugger
```

## 界面用法

1. 在顶部选择 CAN、RS485 或 Modbus 标签页。
2. CAN 模式下填写帧 ID、帧格式、帧类型、payload、DLC、过滤条件，生成或解析 trace。
3. RS485 模式下选择串口参数语义、payload 模式和内容，可选择追加 Modbus CRC。
4. Modbus 模式下选择 RTU/TCP、unit id、function code、address、quantity 或写入值，构建请求并解析响应。
5. 在日志面板中查看每次构建、解析、校验和错误信息。

## CLI 用法

命令名中的 `send` 表示生成调试记录或协议输出，不代表已经发生物理总线发送：

```powershell
node industrial-bus-debugger/index.js can-send --frame-id 123 --payload "01 02 03 04"
node industrial-bus-debugger/index.js can-parse --trace "123#DEADBEEF"
node industrial-bus-debugger/index.js rs485-tx --payload "01 03 00 00 00 02" --append-crc true
node industrial-bus-debugger/index.js modbus-build --protocol rtu --unit-id 1 --function 03 --address 0 --quantity 2
node industrial-bus-debugger/index.js modbus-parse --protocol rtu --response-hex "01 03 04 00 2A 00 64 DA 3F"
```

所有非 help 命令都会输出一个 JSON 对象。

## 目录结构

- `index.js`：根据参数进入 `rpc`、`serve` 或 CLI 模式。
- `core.js`：实现 CAN 帧校验和解析、RS485 payload 处理、Modbus 构建/解析、CRC16 和日志记录。
- `server.js`：提供本地 HTTP 静态服务、WebSocket RPC、token 校验和关闭接口。
- `cli.js`：提供 CAN、RS485、Modbus 命令行入口。
- `ui/`：CAN、RS485、Modbus 三个标签页的浏览器界面。
- `i18n/`：多语言文案。
- `skill/`：AI 调试工作流说明。

## 注意事项

- 物理总线问题仍需要结合总线分析仪、USB 适配器或设备端串口日志验证。
- CAN 标准 ID 范围是 `0x000-0x7FF`，扩展 ID 范围是 `0x00000000-0x1FFFFFFF`。
- Modbus RTU 使用 CRC16，CRC 在线路字节中为 little-endian；Modbus TCP 使用 MBAP，不追加 RTU CRC。
- 寄存器地址要明确是协议中的 zero-based address，还是文档中的 one-based label。
