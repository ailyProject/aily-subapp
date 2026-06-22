# Aily Chat Host Protocol v1

所有业务数据通过 ChildToolHost 已有 `sendToolSignal` / `handleToolSignal` 通道传输。协议不要求 React 子应用读取 Angular 服务，也不把聊天流量转发到子应用 Node WebSocket。

## Child -> Host request

Signal name: `aily-chat:request`

```json
{
  "protocolVersion": 1,
  "id": "chat-mabc-1",
  "method": "turn.send",
  "params": {
    "sessionId": "lex-123",
    "text": "分析当前项目",
    "modelId": "gpt-5.1-codex",
    "permissionMode": "default"
  }
}
```

宿主 adapter 应监听 `UiService.toolAction$` 中该 signal，调用现有 Aily Chat service/engine，并通过同一 tool signal bus 返回 response。

## Host -> Child response

Signal name: `aily-chat:response`

```json
{
  "kind": "response",
  "id": "chat-mabc-1",
  "ok": true,
  "result": {}
}
```

失败响应：

```json
{
  "kind": "response",
  "id": "chat-mabc-1",
  "ok": false,
  "error": "Session not found"
}
```

## Host -> Child event

Signal name: `aily-chat:event`

```json
{
  "kind": "event",
  "event": {
    "type": "turn.upsert",
    "sessionId": "lex-123",
    "payload": {
      "id": "turn-9",
      "role": "assistant",
      "createdAt": 1782100000000,
      "parts": []
    }
  }
}
```

UI 将同一 animation frame 内的事件合并后一次提交，宿主可按不可变 turn snapshot 推送，不需要发送 DOM 级 patch。

## Required methods

| Method | Purpose |
| --- | --- |
| `bootstrap` | 返回 session 列表、当前 session、turns、模型、权限与运行状态 |
| `session.create` | 创建并选择新会话 |
| `session.select` | 切换会话，随后返回 response 或推送 `session.changed` |
| `turn.send` | 提交用户消息并启动流式执行 |
| `turn.stop` | 停止当前会话执行 |
| `settings.update` | 更新当前模式、模型或权限模式 |
| `resource.addFile` / `resource.addFolder` / `resource.remove` | 复用宿主资源选择与上下文管理 |
| `todo.toggle` / `todo.clear` | 操作当前会话 TODO |
| `surface.back` / `surface.toggleSettings` | 切换现有 pane surface |
| `interaction.respond` | 回答问题、确认或计划操作 |

后续可扩展 `session.rename`、`session.delete`、`interaction.respond`、`checkpoint.restore`、`memory.list` 等方法。新增字段保持向后兼容；破坏性改动递增 `protocolVersion`。

## Bootstrap result

```ts
interface ChatBootstrap {
  sessions: Array<{ id: string; title: string; updatedAt: number; unread?: boolean }>;
  activeSessionId: string | null;
  turns: ChatTurn[];
  runState: 'idle' | 'running' | 'waiting' | 'error';
  models: Array<{ id: string; label: string }>;
  activeModelId: string;
  permissionMode: 'default' | 'full';
}
```

`ChatTurn.parts` 对应原 Angular Aily Chat 的 part 模型，React renderer 支持：

- `markdown`
- `thinking`
- `tool`
- `terminal`
- `state`
- `error`
- `question`
- `confirmation`
- `plan`
- `progress`

question、confirmation、diff、plan 等交互 part 应继续以独立 discriminated union 扩展，避免回退为 HTML 字符串。
