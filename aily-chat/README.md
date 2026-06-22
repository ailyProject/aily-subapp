# Aily Chat React 子应用

这是 Aily Chat 的 React 等价重构。UI 布局、surface 状态、消息 Part、composer 控件顺序和主要交互以 Blockly 内现有 Angular Aily Chat 为唯一基准；React 子应用不导入 Angular 源码，也不直接访问 Electron、文件系统、模型 API 或工具运行时，真实能力全部通过宿主交互协议复用现有 ChatEngine。

## 架构

```text
React UI
  ├─ Penpal 控制面：主题、语言、关闭生命周期
  └─ sendToolSignal 请求/事件协议
       └─ Aily Blockly host adapter
            ├─ ChatEngine / session runtime
            ├─ model and permission routing
            ├─ project context
            └─ tool execution and approvals
```

子应用 Node 后端只负责标准 child-tool 生命周期、静态资源、健康检查和 WebSocket status，不代理聊天数据。宿主通过 `AilyChatChildProtocolService` 将现有 `ChatViewService`、`ChatEngineService`、资源、TODO、模型、权限和配额状态投影给 React。

协议见 [PROTOCOL.md](PROTOCOL.md)。

## 开发

```bash
npm install
npm install --prefix ui
npm run build:ui
node index.js status
node index.js serve --host 127.0.0.1 --port 0
```

从 `aily-subapp` 仓库根目录运行：

```bash
npm run dev -- aily-chat --open
npm run build -- aily-chat
```

独立浏览器打开时，UI 使用本地协议模拟器展示完整界面。嵌入 Aily Blockly 后不会回退到模拟数据；宿主必须实现 `PROTOCOL.md` 中的请求处理。

## 性能策略

- React DOM 层沿用现有 `chat-main-layout`、`dialog-list`、`dialog-box`、`sender`、`input-box` 等布局契约。
- React 状态使用 `useSyncExternalStore`，避免把高速流事件塞进组件级 Context。
- 宿主事件在 `requestAnimationFrame` 内合并，最多每帧提交一次视图更新。
- turn/activity 组件使用 `memo`，消息对象采用不可变快照。
- 历史 turn 使用 `content-visibility: auto` 和 intrinsic size，减少长会话布局与绘制成本。
- 输入框草稿与流式会话状态分离，token 更新不会重建 composer。
- UI bundle 不引入组件库和 markdown 大依赖，保持首次加载体积可控。
