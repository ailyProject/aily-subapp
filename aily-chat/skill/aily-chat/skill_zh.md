---
name: aily-chat
description: "当开发或调试依赖 Aily Chat 子工具的 MCU 固件流程时使用。"
---

# Aily Chat Skill

当用户需要通过 `aily-chat` 子工具调试固件流程时使用此 skill。

## 首轮确认

1. 确认开发板、固件栈、通信方式和预期工具流程。
2. 记录精确输入、预期输出、超时时间和设备侧日志。
3. 将子工具输出作为证据，而不是设备日志的替代品。
4. 只有缺失的硬件信息会改变测试路径时，才追问。

## 工具边界

- `child/tools/index.json` 注册 `aily-chat`，route 为 `/child-tool/aily-chat`。
- `child/tools/aily-chat/index.js` 选择 `rpc`、`serve` 或 CLI mode。
- `child/tools/aily-chat/server.js` 提供 UI、托管 `/ws`、校验 `token`，并暴露 `/health` 和 `/api/shutdown`。
- `child/tools/aily-chat/core.js` 拥有工具核心能力。
- `child/tools/aily-chat/cli.js` 拥有 CLI 参数解析和 JSON 输出。
- `child/tools/aily-chat/ui/src/App.tsx` 负责 React UI 状态与宿主协议渲染。
- `child/tools/aily-chat/i18n/*.json` 拥有子工具可见文本。

不要把工具业务行为放进 Angular host。宿主代码只负责 iframe、进程生命周期和 Penpal 控制消息。

## CLI 检查

从仓库根目录运行：

```powershell
node child/tools/aily-chat/index.js --help
node child/tools/aily-chat/index.js status
node child/tools/aily-chat/index.js echo --message hello
```

所有非 help CLI 命令都向 stdout 输出一个 JSON object。

## 验证

```powershell
node --check child/tools/aily-chat/index.js
node --check child/tools/aily-chat/core.js
node --check child/tools/aily-chat/cli.js
node --check child/tools/aily-chat/server.js
npm run build:ui --prefix child/tools/aily-chat
```
