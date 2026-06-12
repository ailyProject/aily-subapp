# Debugger UI / 适配标准

适用于 `*-debugger/ui/` 等嵌入式工具页。新增或改版 UI 时优先对齐 **mqtt-debugger** 现有实现。

## 1. 文件结构

```
ui/
  index.html      # viewport meta + styles.css + theme link
  styles.css      # 布局、组件、响应式（与主题无关）
  dark.css        # 仅覆盖 :root 语义变量
  light.css
  app.js          # 渲染与交互
```

- HTML 根容器：`#app` + 工具专属 class（如 `.mqtt-debugger`）
- 主题：`styles.css` 定义 token 默认值；`dark.css` / `light.css` 只改变量，不写布局
- 字体：`/fonts/MiSans-Regular.woff2`，fallback `"Segoe UI", Arial, sans-serif`

## 2. 设计 Token（:root）

**必须**使用语义变量，禁止在组件里硬编码色值：

| 语义变量 | 用途 |
|---------|------|
| `--bg` | 页面背景 |
| `--panel` / `--panel-soft` / `--panel-muted` | 卡片 / 输入框 / 次级底 |
| `--text` / `--muted` | 主文 / 标签 |
| `--primary` / `--primary-strong` / `--primary-soft` | 主操作、链接 |
| `--ok` / `--warn` / `--danger` | 连接成功 / 进行中 / 错误 |
| `--border-soft` | 列表分隔线 |
| `--control-hover` / `--selected-bg` | 按钮 hover / 选中 |

基础 token 前缀 `--aily-*`，在 `styles.css` 用 `@media (prefers-color-scheme: dark)` 提供系统主题兜底。

## 3. 全局与排版

```css
html, body, #app { width: 100%; height: 100%; margin: 0; }
body {
  overflow: hidden;       /* 页面不滚动，滚动交给内部区域 */
  user-select: none;
  font-size: 13px;
  letter-spacing: 0;
}
```

| 元素 | 规范 |
|------|------|
| 间距基准 | 外层 `gap: 10px`；面板内 `gap: 8px`；字段 `gap: 4px` |
| 圆角 | 面板 `5px`；控件 `3px`；代码块 `4px` |
| 标题 `.panel-title` | `12px` / `font-weight: 700` |
| 标签 `.field span` | `12px` / `color: var(--muted)` |
| 等宽 `.mono` | `Consolas, Monaco, "Courier New", monospace` |

## 4. 控件

### 按钮
- `min-height: 26px`，`padding: 0 8px`，无边框，透明底
- `.primary`：字色 `--primary`；hover 用 `--primary-soft`
- `:disabled` → `opacity: 0.48`
- 图标按钮 `.icon-action`：`28×28`，`padding: 0`

### 输入框 / 下拉 / 文本域
- `min-height: 26px`，`padding: 4px 8px`，`background: var(--panel-soft)`
- **Focus**：`box-shadow: 0 0 0 1px var(--primary) inset`
- **排除** checkbox / radio，二者 `box-shadow: none`，无蓝色 focus 框
- `textarea`：默认 `min-height: 80px`，`resize: vertical`

### 复选框 `.check-field`
- `inline-flex`，`gap: 6px`，checkbox `14×14`

### 状态 `.status`
- 默认 `--danger`；`.connecting` → `--warn`；`.connected` → `--ok`
- 后端连接状态、PID、宿主连接元信息由统一容器/宿主层处理；子应用 UI 中不要单独新增 `.backend-meta`、后端状态点或等价状态条。

## 5. 布局模式

### 5.1 页面壳（flex 列）

```css
.{tool}-debugger {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  min-height: 0;   /* 关键：允许子级收缩 */
  padding: 10px;
}
```

- 顶部连接/配置区 `.connection-panel`（或等价）：`flex-shrink: 0`；仅放本工具必要配置，不重复展示统一后端状态。
- 主工作区： `flex: 1; min-height: 0; overflow: hidden`

### 5.2 双列工作区（宽屏）

```css
.workspace-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);  /* 5:5 均分 */
  grid-template-rows: minmax(0, 1fr) minmax(0, 1fr);
  grid-template-areas:
    "area-a area-b"
    "area-c area-d";
  gap: 8px;
  min-height: 0;
  flex: 1;
  overflow: hidden;
}
```

- **必须**用 `grid-template-areas` + 各面板 `grid-area` 明确定位，禁止仅靠 auto-placement
- 列宽用 `minmax(0, 1fr)`，禁止 `minmax(240px, …)` 等固定最小宽导致溢出叠层
- 行高用 `minmax(0, 1fr)`，禁止 `minmax(220px, …)` 等硬最小高度

### 5.3 面板与可滚动列表

```css
.panel { display: flex; flex-direction: column; gap: 8px; min-height: 0; padding: 10px; }
/* 列表区 */
.message-list, .log-list { min-height: 0; flex: 1; overflow: auto; }
```

- 面板内 flex 子项需要滚动时，父级链路上每一层都要有 `min-height: 0`

## 6. 响应式适配（标准断点）

### 6.1 堆叠模式 — 满足任一条件即触发

```css
@media (max-width: 750px), (max-height: 820px) { ... }
```

| 条件 | 行为 |
|------|------|
| 宽度 ≤ 750px | 窄屏单列 |
| 高度 ≤ 820px | 矮视口单列（即使宽度 > 750px） |

**堆叠时工作区**改为 flex 列，禁止继续用双行 grid：

```css
.workspace-grid {
  display: flex;
  flex-direction: column;
  overflow-y: auto;          /* 工作区整体滚动 */
  grid-template-areas: none;
}
.panel-in-workspace {
  flex-shrink: 0;            /* 禁止压扁 */
  min-height: auto;
  overflow: visible;
}
```

- 列表区：`min-height: 96px`，`max-height: min(220px, 28vh)`
- 大 textarea：`min-height: 56px`，`max-height: 120px`
- `.field.grow` 在堆叠模式设为 `flex: 0 0 auto`
- 按钮点击、日志追加、表单状态切换等触发局部/全量重渲染时，必须保留当前可滚动容器的 `scrollTop`；不要因为 `innerHTML` 重建、列表刷新或日志清空把工作区自动滚回顶部。切换主模式/tab 属于新视图，可显式不恢复旧滚动。

### 6.2 连接表单 — 窄且矮时省高度

```css
@media (max-width: 750px) and (max-height: 820px) {
  .connection-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .span-2 { grid-column: 1 / -1; }
}
```

- 仅堆叠模式下连接区恢复双列；其余情况连接区单列

### 6.3 禁止写法

- ❌ 仅在 `max-width` 做堆叠，忽略矮视口（会导致 800px 高仍双列叠层）
- ❌ 堆叠模式仍设 `grid-template-rows: minmax(0, 1fr) …` 覆盖 flex
- ❌ 多面板 grid 不设 `grid-template-areas`（4 面板 2 行易错位）
- ❌ 外层 `body { overflow: auto }` 与内层滚动混用
- ❌ 点击发送/解析/清空日志后全量重渲染但不恢复 `.workspace-grid`、`.log-list` 等滚动容器位置，导致窄屏或矮视口跳回顶部

## 7. 列表与日志行

- 行分隔：`border-bottom: 1px solid var(--border-soft)`
- 长文本：`overflow-wrap: anywhere`；hex / code 用 `.mono`
- 日志行 grid 示例：`70px minmax(110px, 170px) minmax(0, 1fr)`
- 日志语义色：`.error` → danger；`.in`/`.rx` → ok；`.out`/`.tx` → primary
- 日志文案必须走 i18n：UI 内部日志用稳定 key；core/server 返回日志时优先返回可翻译的 `summary` key，动态 detail 使用 `{name}` 占位符或前端明确解析的结构化模式。
- 日志中的动态值（topic、URL、port、frame id、function code、hex、duration、status 等）保留原值，不翻译；固定词（连接失败、请求超时、CRC 正确、长度不匹配、过滤通过等）必须翻译。
- 日志面板是调试证据：应记录用户动作、收发方向、协议、关键参数、校验结果和错误原因；避免只记录“失败”这类不可诊断文案。
- 禁止在日志、示例或 readme 中暴露真实 username、password、token、API key 等敏感信息；必要时显示 masked value。
- CLI/RPC/core 的错误字符串如果会显示到 UI，必须在 UI 层映射到 i18n key 或由后端返回稳定错误 code。

## 8. 滚动条

统一 8px 细滚动条，thumb 用 `--aily-scrollbar-thumb`，track 透明。

## 9. 表单网格

```css
.connection-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.span-2 { grid-column: 1 / -1; }
.field.compact { max-width: 120px; }
```

## 10. 状态保留与关闭生命周期

Debugger 子应用关闭后再打开，必须保留用户可恢复的工作上下文。宿主会在关闭、重启或子窗口关闭前调用 iframe Penpal `beforeClose(...)`；子应用必须在该钩子里同步落盘可恢复草稿。

### 10.1 必须保存的状态

使用 `localStorage`、IndexedDB 或子应用后端 app data 保存以下轻量草稿态：

- 表单输入：URL、topic、port、baud rate、headers、body、payload、frame id、Modbus 参数等
- 当前模式/tab：HTTP/WebSocket、CAN/RS485/Modbus 等
- 用户配置：显示模式、常用发送项、非敏感连接参数
- 可复用结果：最近一次生成的 request hex、最近响应内容等用户可能继续编辑或复制的数据

纯前端轻量工具推荐模式：

```js
const DRAFT_KEY = 'tool-id.ui.draft.v1';
const DRAFT_FIELDS = ['mode', 'url', 'payload'];

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (!draft || typeof draft !== 'object') return;
    for (const field of DRAFT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(draft, field)) {
        state[field] = draft[field];
      }
    }
  } catch {
    // Ignore invalid persisted draft data.
  }
}

function saveDraft() {
  try {
    const draft = {};
    for (const field of DRAFT_FIELDS) draft[field] = state[field];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage may be unavailable in some browser modes.
  }
}
```

初始化顺序：先解析 URL `token/lang`，再连接宿主并通过 Penpal `getHostContext()` / `setHostContext()` 获取真实主题，随后应用主题、`loadDraft()`、加载 i18n、连接 backend。禁止依赖 URL `theme` 初始化主题。

### 10.2 禁止保存的状态

- ❌ 不保存 token、API key、password、session secret 等敏感信息；如需显示必须 mask
- ❌ 不保存 WebSocket/MQTT/Serial 的“已连接”状态；重开后应显示真实连接状态
- ❌ 不默认保存大日志流、持续采样数据、海量消息列表；日志是运行证据，不是草稿
- ❌ 不把后端 PID、随机端口、shutdown URL 等宿主生命周期数据写入草稿
- ❌ 不用草稿恢复来伪造设备连接、订阅状态或串口占用状态

### 10.3 `beforeClose` 规范

所有子应用 Penpal methods 必须实现或保留 `beforeClose()`。该方法必须同步调用 `saveDraft()`，并返回关闭结果：

```js
beforeClose() {
  saveDraft();
  return {
    canClose: true,
    connected: backendWs?.readyState === WebSocket.OPEN,
    draftSaved: true
  };
}
```

- 只有确实存在不可中断的危险操作时，才返回 `{ canClose: false, message }`
- 普通连接中、表单未保存、日志未清空等情况不得阻止关闭
- `beforeClose()` 不应做慢 I/O；若需要后端持久化，前端应提前在输入变更时保存，关闭时只做兜底
- 独立浏览器运行时还必须在 `beforeunload` 中调用 `saveDraft()`

### 10.4 保存触发点

- `input` / `change` 后：`updateFromInputs(); saveDraft();`
- 切换主模式/tab 后：更新 `state.mode` 并 `saveDraft()`
- 生成或清空可复用结果后：例如 `modbusRequestHex`、HTTP response body 更新后保存
- Vue 模板：`watch([fieldRefs...], () => saveDraft())`，`onBeforeUnmount(saveDraft)`
- Angular 模板：`(ngModelChange)="field = $event; saveDraft()"`，`ngOnDestroy()` 兜底保存

### 10.5 版本与容量

- `DRAFT_KEY` 必须包含工具 id 与 schema 版本，如 `network-debugger.ui.draft.v1`
- 草稿结构变更时递增版本，避免旧数据污染新 UI
- 大于 localStorage 合理容量的草稿使用 IndexedDB 或后端 app data JSON，不要硬塞进 `localStorage`

### 10.6 宿主上下文与主题同步

子应用嵌入主应用时，主题必须通过宿主上下文同步，不得作为 iframe URL 参数传递或读取。

- 主应用打开子应用 URL 时只追加 `lang` 等必要启动参数，禁止追加 `theme`
- 子应用首屏不要读取 `query.get('theme')`；默认值只作为独立浏览器开发兜底，例如 `theme: 'dark'`
- 子应用 `connectHost()` 建立 Penpal 后必须优先调用 `remote.getHostContext()`，拿到 `{ lang, theme }` 后再 `applyTheme(theme)` 和首次 `render()`
- `setHostContext(context)` 到达时必须重新归一化 `lang/theme`，更新 `document.documentElement.lang`、`data-theme` / `colorScheme`，并按需重载 i18n
- 纯 JS 子应用应在 `bootstrap()` 中按 `await connectHost() -> applyTheme() -> render() -> connectBackend()` 顺序初始化，避免先按默认主题渲染
- Angular / Vue 等框架 UI 若 CSS 默认值可能先绘制旧主题，必须在 `html:not([data-theme]) body` 或启动脚本中短暂隐藏 body，并在 `applyTheme()` 后恢复显示
- `index.html` 不要预置 `<link id="theme-style" href="./dark.css">`；由 `applyTheme()` 根据宿主上下文动态创建或切换主题样式
- 切换主题、多子应用互相切换、子应用复用进程或 iframe 快速重开时，不能出现先按旧 URL theme/default dark 闪烁后再同步的过程

## 11. 自检清单

改版后在以下视口验证：

1. **宽屏** ≥ 1000×900：双列 5:5，各面板内列表独立滚动
2. **临界宽** 751×900：仍双列
3. **临界堆叠宽** 750×900：单列可滚动
4. **矮视口** 821×800：触发堆叠（宽 > 750 但高 ≤ 820）
5. **极窄** 375×667：连接区 + 工作区均可滚动，面板不被压至不可读

确认：无面板几何重叠、checkbox 无蓝色 focus 框、主题切换仅改变量不影响布局；打开子应用 URL 中没有 `theme` 参数，切换主题后在多个子应用间来回切换无旧主题闪烁。
