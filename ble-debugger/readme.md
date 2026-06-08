# BLE 调试器

BLE 调试器是 Aily Blockly / Aily Chat AI IDE 的独立子应用，用于扫描 BLE 设备、连接外设、查看 GATT 服务，并对 characteristic 执行读取、写入和通知订阅。它适合调试 MCU BLE 固件的广播、UUID、GATT 属性、载荷格式和适配器状态问题。

## 适用场景

- 验证设备是否正在广播，广播名、地址、RSSI 和 advertised service UUID 是否符合预期。
- 连接 BLE peripheral，刷新并检查 GATT service / characteristic 列表。
- 对可读 characteristic 执行 read，对可写 characteristic 执行 write 或 writeWithoutResponse。
- 订阅 notify / indicate characteristic，观察 MCU 上报的数据和事件。
- 通过 CLI 给 AI、脚本或自动化流程提供 JSON 结果。

## 运行方式

在本仓库根目录安装该子应用依赖：

```powershell
npm install --prefix ble-debugger
```

本地启动浏览器 UI：

```powershell
node ble-debugger/index.js serve --host 127.0.0.1 --port 0
```

`serve` 模式会在 stdout 输出一行 `ready` JSON，其中 `url` 可直接在浏览器或 IDE iframe 中打开，`wsUrl` 是 UI 调用后端的 WebSocket 地址，`shutdownUrl` 用于关闭子进程。集成到 IDE 时通常由宿主自动启动该命令，并附加 `lang` 和 `theme` 参数。

查看 CLI 帮助和状态：

```powershell
node ble-debugger/index.js --help
node ble-debugger/index.js status
```

构建分发包：

```powershell
npm run build -- ble-debugger
```

## 界面用法

1. 打开工具后确认后端状态和蓝牙适配器状态为可用。
2. 可选填写 service UUID 过滤条件，点击开始扫描。
3. 在设备列表中选择目标设备并连接。
4. 连接后刷新 GATT，选择 service 和 characteristic。
5. 根据 characteristic 属性执行读取、写入或订阅通知。
6. 在日志面板中查看扫描、连接、读写、通知和错误记录。

## CLI 用法

所有非 help 命令都会向 stdout 输出一个 JSON 对象，适合脚本读取：

```powershell
node ble-debugger/index.js scan --duration-ms 5000 --service 180D
node ble-debugger/index.js gatt --name-contains MyDevice --scan-ms 10000
node ble-debugger/index.js read --id <device-id> --service <uuid> --characteristic <uuid>
node ble-debugger/index.js write --id <device-id> --service <uuid> --characteristic <uuid> --payload "01 02" --mode hex
node ble-debugger/index.js notify --id <device-id> --service <uuid> --characteristic <uuid> --duration-ms 10000
```

设备选择器支持 `--id`、`--address`、`--name`、`--name-contains` 和 `--scan-service`。

## 目录结构

- `index.js`：根据参数进入 `rpc`、`serve` 或 CLI 模式。
- `core.js`：封装 `@abandonware/noble`，实现扫描、连接、GATT、读写、通知和清理。
- `server.js`：提供本地 HTTP 静态服务、WebSocket RPC、token 校验和关闭接口。
- `cli.js`：解析命令行参数并输出 JSON。
- `ui/`：浏览器界面、主题样式和 Penpal 宿主通信。
- `i18n/`：多语言文案。
- `skill/`：AI 调试工作流说明。

## 注意事项

- 本工具依赖本机 BLE 适配器和 `@abandonware/noble`，不同操作系统可能需要蓝牙权限或驱动支持。
- 扫描不到设备时先检查设备是否正在广播、是否可连接、service 过滤条件是否过窄。
- 写入前确认 payload 格式、字节序和 characteristic 的 write 属性。
- 大载荷应在固件协议层拆包，不要假设 BLE 可以一次传输任意长度数据。
