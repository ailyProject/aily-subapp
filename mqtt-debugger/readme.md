# MQTT 调试器

MQTT 调试器是用于 MCU MQTT 固件开发的独立子应用，提供 MQTT over WebSocket 的连接、订阅、发布、消息查看和日志能力。它适合验证 broker 设置、topic 设计、QoS、retained message、payload 格式和设备端 publish/subscribe 行为。

## 适用场景

- 连接支持 MQTT over WebSocket 的 broker，例如 `ws://` 或 `wss://` endpoint。
- 配置 client id、username、password、keepalive 和 clean session。
- 订阅单个 topic 或通配 topic，观察设备上报的 telemetry 和 state。
- 发布命令或测试载荷到目标 topic，验证 MCU 是否收到并响应。
- 检查 retained message、QoS 和 payload 编码是否符合固件协议。

## 运行方式

在本仓库根目录安装该子应用依赖：

```powershell
npm install --prefix mqtt-debugger
```

本地启动浏览器 UI：

```powershell
node mqtt-debugger/index.js serve --host 127.0.0.1 --port 0
```

`serve` 模式会输出 `ready` JSON，里面的 `url` 可直接打开。MQTT 交互流程运行在浏览器 UI 中，后端主要负责子应用生命周期、静态资源、WebSocket RPC 和宿主通信。

查看 CLI 帮助和状态：

```powershell
node mqtt-debugger/index.js --help
node mqtt-debugger/index.js status
```

构建分发包：

```powershell
npm run build -- mqtt-debugger
```

## 界面用法

1. 填写 broker WebSocket URL，默认示例为 `wss://test.mosquitto.org:8081/mqtt`。
2. 设置 client id、认证信息、keepalive 和 clean session。
3. 点击连接，确认连接状态变为 connected。
4. 填写订阅 topic 和 QoS，点击订阅。
5. 填写发布 topic、payload 和 retain 选项，点击发布。
6. 在消息和日志面板中查看 inbound message、publish、subscribe、disconnect 和错误记录。

## CLI 用法

当前 CLI 只提供生命周期和状态检查：

```powershell
node mqtt-debugger/index.js status
```

实际 MQTT connect、subscribe 和 publish 在浏览器 UI 中完成，因为当前实现使用 UI 内的 MQTT WebSocket client。后续如果需要 Node 后端 MQTT transport，应放在 `core.js` 并通过 `server.js` 暴露给 UI。

## 目录结构

- `index.js`：根据参数进入 `rpc`、`serve` 或 CLI 模式。
- `core.js`：当前提供后端状态和关闭能力。
- `server.js`：提供本地 HTTP 静态服务、WebSocket RPC、token 校验和关闭接口。
- `cli.js`：提供 help、version、status。
- `ui/`：实现 MQTT WebSocket client、连接表单、订阅发布、消息列表和日志。
- `i18n/`：多语言文案。
- `skill/`：AI 调试工作流说明。

## 注意事项

- broker 必须支持 MQTT over WebSocket；普通 TCP MQTT 端口不能直接在该 UI 中使用。
- 不要在示例和日志中暴露真实 username、password、token 或 API key。
- retained message 适合持久状态，不适合一次性命令。
- MCU 断线重连后通常需要重新订阅 topic，调试时应同时查看设备端日志。
