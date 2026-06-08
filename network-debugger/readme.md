# 网络调试器

网络调试器是用于 MCU 网络功能开发的独立子应用，提供 HTTP 请求调试和 WebSocket 连接测试能力。它适合验证 URL、method、headers、body、timeout、TLS、响应状态、响应体，以及设备端 HTTP / WebSocket 固件行为。

## 适用场景

- 向 HTTP 或 HTTPS endpoint 发送 GET、POST、PUT、PATCH、DELETE、HEAD、OPTIONS 请求。
- 调整请求头、请求体和超时时间，观察状态码、耗时、响应头和响应体。
- 连接外部 WebSocket endpoint，发送消息并查看返回数据。
- 对照 MCU 固件日志排查 DNS、TCP、TLS、timeout、body parse 和 WebSocket handshake 问题。
- 通过 CLI 给 AI、脚本或自动化流程提供 HTTP 请求 JSON 结果。

## 运行方式

在本仓库根目录安装该子应用依赖：

```powershell
npm install --prefix network-debugger
```

本地启动浏览器 UI：

```powershell
node network-debugger/index.js serve --host 127.0.0.1 --port 0
```

`serve` 模式会输出 `ready` JSON，里面的 `url` 可直接打开。HTTP 请求通过 Node 后端执行，外部 WebSocket 测试在浏览器 UI 中运行。

查看 CLI 帮助和状态：

```powershell
node network-debugger/index.js --help
node network-debugger/index.js status
```

构建分发包：

```powershell
npm run build -- network-debugger
```

## 界面用法

1. 在 HTTP 模式中选择 method，填写 URL、headers、body 和 timeout。
2. 发送请求后查看 status、duration、size、response headers 和 response body。
3. 切换到 WebSocket 模式，填写 WebSocket URL 并连接。
4. 输入消息并发送，观察收发日志和连接状态。
5. 用工具结果对照 MCU 串口日志或服务端日志，定位网络路径中的失败点。

## CLI 用法

HTTP 请求可通过 CLI 直接执行，所有非 help 命令都会输出 JSON：

```powershell
node network-debugger/index.js request --url http://127.0.0.1:8080/health --method GET --timeout-ms 5000
node network-debugger/index.js request --url https://example.com/api --method POST --header "Content-Type: application/json" --body "{\"ping\":true}"
```

可使用多个 `--header "Name: value"` 参数，或使用请求体字符串传入 JSON、文本等内容。

## 目录结构

- `index.js`：根据参数进入 `rpc`、`serve` 或 CLI 模式。
- `core.js`：实现 Node HTTP request、header 解析、timeout、响应格式化和状态信息。
- `server.js`：提供本地 HTTP 静态服务、WebSocket RPC、token 校验和关闭接口。
- `cli.js`：提供 HTTP request 命令行入口。
- `ui/`：HTTP 表单、响应面板、WebSocket 测试和日志界面。
- `i18n/`：多语言文案。
- `skill/`：AI 调试工作流说明。

## 注意事项

- TLS 问题通常与系统时间、CA 证书、SNI/hostname、证书链或内存限制有关。
- timeout 要和 MCU 固件中的 timeout 配置一起分析，避免把服务端延迟误判为固件错误。
- 调试含认证的请求时，不要把 token、API key 或 password 写入公开日志。
- WebSocket 静默时优先检查 URL scheme、握手路径、headers、ping/pong、close code 和重连逻辑。
