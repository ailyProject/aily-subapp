import { useSyncExternalStore } from 'react';

export type ThemeName = 'dark' | 'light';
export type RunState = 'idle' | 'running' | 'waiting' | 'error';
export type PartState = 'doing' | 'done' | 'warn' | 'error' | 'info';

export interface HostContext {
  toolId: string;
  lang: string;
  theme: ThemeName;
  platform: string;
}

export interface ChatSession {
  id: string;
  title: string;
  updatedAt: number;
  unread?: boolean;
  current?: boolean;
  status?: string;
  detail?: string[];
  pinned?: boolean;
  archived?: boolean;
}

export interface ChatPart {
  id: string;
  type: 'markdown' | 'thinking' | 'tool' | 'tool_call' | 'terminal' | 'state' | 'error' | 'question' | 'confirmation' | 'plan' | 'progress';
  content?: string;
  contentLength?: number;
  isComplete?: boolean;
  isRunning?: boolean;
  streaming?: boolean;
  title?: string;
  detail?: string;
  state?: PartState;
  command?: string;
  output?: string;
  stderr?: string;
  exitCode?: number;
  progress?: number;
  kind?: string;
  toolName?: string;
  toolCallId?: string;
  resolved?: boolean;
  result?: string;
  args?: unknown;
  metadata?: Record<string, unknown>;
  questions?: Array<{
    id?: string;
    question: string;
    options?: Array<{ label: string; description?: string; recommended?: boolean }>;
    allowFreeform?: boolean;
  }>;
  actions?: Array<{ id: string; label: string; primary?: boolean; danger?: boolean }>;
  status?: string;
  text?: string;
}

export interface ChatTurn {
  id: string;
  role: 'user' | 'assistant' | 'aily';
  createdAt: number;
  parts: ChatPart[];
  doing?: boolean;
  modelName?: string;
  modelBillingLabel?: string;
  canEdit?: boolean;
  canRestore?: boolean;
  canFork?: boolean;
  feedback?: 'helpful' | 'unhelpful' | null;
}

export interface ChatResource {
  type: 'file' | 'folder' | 'url' | 'block';
  name: string;
  path?: string;
}

export interface ChatTodo {
  id: string;
  content: string;
  status: 'not-started' | 'in-progress' | 'completed';
}

export interface ChatNotice {
  id: string;
  title: string;
  description?: string;
  severity?: 'info' | 'warning' | 'error';
  actionLabel?: string;
}

export interface ChatMenuOption {
  id: string;
  label: string;
  description?: string;
  iconClass?: string;
  active?: boolean;
  disabled?: boolean;
  billingLabel?: string;
}

export interface ChatSettings {
  modelPresets: Array<{
    id: string;
    name: string;
    description?: string;
    enabled: boolean;
    isDefault?: boolean;
    unavailableReason?: string;
  }>;
  customModels: Array<{
    model: string;
    name: string;
    family?: string;
    speed?: string;
    enabled: boolean;
    isCustom: true;
    baseUrl: string;
    apiKey?: string;
    hasApiKey?: boolean;
  }>;
  modelCatalogStatusHint?: string;
  workspaceOptions: Array<{ name: string; displayName: string; enabled: boolean }>;
  agents: Array<{
    id: string;
    label: string;
    description?: string;
    tools: Array<{ name: string; displayName: string; description?: string; enabled: boolean }>;
  }>;
  maxRequests: number;
  autoSaveEdits: boolean;
  sessionViewerOrientation: 'sideBySide' | 'stacked';
  userInstructionFolders: string[];
  projectInstructionFolders: string[];
  userAgentFolders: string[];
  projectAgentFolders: string[];
  useChatSessionCustomizationsForCustomAgents: boolean;
  customAgents: Array<{ target: string; label: string; description?: string; visible: boolean }>;
  terminalAllowList: string[];
  terminalDenyList: string[];
  terminalInheritDefaultAllowList: boolean;
}

export interface ChatBootstrap {
  sessions: ChatSession[];
  activeSessionId: string | null;
  turns: ChatTurn[];
  runState: RunState;
  models: Array<{ id: string; label: string }>;
  activeModelId: string;
  permissionMode: 'default' | 'full';
  paneSurface?: 'chat' | 'blank-session' | 'session-loading' | 'entry' | 'welcome' | 'login';
  sessionListMode?: 'hidden' | 'stacked' | 'sidebar';
  sessionSidebarWidth?: number;
  title?: string;
  inputValue?: string;
  resources?: ChatResource[];
  todos?: ChatTodo[];
  notices?: ChatNotice[];
  modeId?: string;
  modeLabel?: string;
  modeOptions?: ChatMenuOption[];
  modelOptions?: ChatMenuOption[];
  permissionLabel?: string;
  contextUsage?: { percentage: number; label: string; estimated?: boolean; severity?: string } | null;
  interactionBudget?: { label?: string; detail?: string } | null;
  authQuota?: { label?: string; detail?: string } | null;
  requestQuota?: { label?: string; detail?: string } | null;
  showSettings?: boolean;
  settings?: ChatSettings;
}

export interface ProtocolEvent {
  type: 'snapshot' | 'sessions.changed' | 'session.changed' | 'turn.upsert' | 'turn.removed' | 'run.state';
  sessionId?: string;
  payload: unknown;
}

interface HostRemote {
  getHostContext?: () => Promise<Partial<HostContext> | null>;
  childReady?: (data: Record<string, unknown>) => void;
  childError?: (data: Record<string, unknown>) => void;
  reportHostMessage?: (data: Record<string, unknown>) => void;
  sendToolSignal?: (signal: string, payload?: object) => Promise<{ ok: boolean }>;
}

interface PenpalApi {
  WindowMessenger: new (options: Record<string, unknown>) => unknown;
  connect: (options: Record<string, unknown>) => { promise: Promise<HostRemote> };
}

interface PendingRequest {
  resolve(value: any): void;
  reject(reason?: unknown): void;
  timeout: number;
}

export interface ChatState extends ChatBootstrap {
  context: HostContext;
  connected: boolean;
  loading: boolean;
  protocolError: string;
  translations: Record<string, string>;
}

declare global {
  interface Window {
    Penpal?: PenpalApi;
  }
}

const PROTOCOL_VERSION = 1;
const listeners = new Set<() => void>();
const pending = new Map<string, PendingRequest>();
const eventQueue: ProtocolEvent[] = [];
let flushFrame = 0;
let requestSequence = 0;
let host: HostRemote | null = null;
let standaloneDemo = false;
let state: ChatState = {
  context: { toolId: 'aily-chat', lang: 'en', theme: 'dark', platform: 'browser' },
  connected: false,
  loading: true,
  protocolError: '',
  translations: {},
  sessions: [],
  activeSessionId: null,
  turns: [],
  runState: 'idle',
  models: [],
  activeModelId: '',
  permissionMode: 'default',
  paneSurface: 'entry',
  sessionListMode: 'stacked',
  sessionSidebarWidth: 280,
  title: '',
  inputValue: '',
  resources: [],
  todos: [],
  notices: [],
  modeId: 'agent',
  modeLabel: '代理',
  modeOptions: [],
  modelOptions: [],
  permissionLabel: '默认权限',
  contextUsage: null,
  interactionBudget: null,
  authQuota: null,
  requestQuota: null,
  showSettings: false,
  settings: undefined,
};

export function useChatState(): ChatState {
  return useSyncExternalStore(
    callback => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => state,
  );
}

export function t(key: string, fallback = key): string {
  return state.translations[key] || fallback;
}

export async function bootstrap(): Promise<void> {
  const query = new URLSearchParams(location.search);
  patch({
    context: {
      ...state.context,
      lang: normalizeLang(query.get('lang') || navigator.language),
    },
  });

  await connectHost();
  applyTheme(state.context.theme);
  await loadTranslations(state.context.lang);

  host?.childReady?.({
    backendStatus: standaloneDemo ? 'standalone-demo' : 'host-connected',
    adapterState: 'connecting',
  });

  try {
    const initial = await invoke<ChatBootstrap>('bootstrap');
    patch({ ...initial, loading: false, protocolError: '' });
  } catch (error) {
    const message = errorMessage(error);
    patch({ loading: false, protocolError: message });
    host?.reportHostMessage?.({
      state: 'warning',
      title: 'Aily Chat',
      message,
      detail: 'Aily Chat host protocol bootstrap failed',
      showMessage: false,
      sendToLog: true,
    });
  }
}

export async function invoke<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (standaloneDemo) {
    return demoInvoke(method, params) as Promise<T>;
  }
  if (!host?.sendToolSignal) {
    throw new Error('Aily Chat host protocol is unavailable');
  }

  const id = `chat-${Date.now().toString(36)}-${++requestSequence}`;
  const response = new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Host protocol timeout: ${method}`));
    }, 20_000);
    pending.set(id, { resolve, reject, timeout });
  });

  await host.sendToolSignal('aily-chat:request', {
    protocolVersion: PROTOCOL_VERSION,
    id,
    method,
    params,
  });
  return response;
}

export function saveDraft(text: string): void {
  try {
    localStorage.setItem('aily-chat.react.ui.draft.v1', text);
  } catch {
    // Storage can be unavailable in private browser contexts.
  }
}

export function loadDraft(): string {
  try {
    return localStorage.getItem('aily-chat.react.ui.draft.v1') || '';
  } catch {
    return '';
  }
}

async function connectHost(): Promise<void> {
  if (!window.Penpal || window.parent === window) {
    standaloneDemo = true;
    patch({ connected: true });
    return;
  }

  const messenger = new window.Penpal.WindowMessenger({
    remoteWindow: window.parent,
    allowedOrigins: ['*'],
  });
  const connection = window.Penpal.connect({
    messenger,
    methods: {
      setHostContext: async (next: Partial<HostContext>) => {
        await applyHostContext(next);
        return { ok: true };
      },
      focusTool: () => {
        document.querySelector<HTMLTextAreaElement>('[data-chat-composer]')?.focus();
        return { ok: true };
      },
      beforeClose: () => ({
        canClose: true,
        draftSaved: true,
        running: state.runState === 'running',
      }),
      handleToolSignal: (message: unknown) => {
        receiveSignal(message);
      },
    },
  });

  host = await connection.promise;
  const context = await host.getHostContext?.();
  if (context) await applyHostContext(context);
  patch({ connected: true });
}

function receiveSignal(raw: unknown): void {
  const envelope = asRecord(raw);
  const payload = asRecord(envelope['payload']);
  const nestedPayload = asRecord(payload['payload']);
  const nestedData = asRecord(payload['data']);
  const envelopeData = asRecord(envelope['data']);
  const data = Object.keys(nestedPayload).length > 0
    ? nestedPayload
    : Object.keys(nestedData).length > 0
      ? nestedData
      : Object.keys(envelopeData).length > 0
        ? envelopeData
        : payload;
  const signal = String(payload['signal'] || data['signal'] || (typeof envelope['data'] === 'string' ? envelope['data'] : ''));

  if (signal === 'aily-chat:response' || data['kind'] === 'response') {
    const id = String(data['id'] || '');
    const task = pending.get(id);
    if (!task) return;
    pending.delete(id);
    window.clearTimeout(task.timeout);
    if (data['ok'] === false) {
      task.reject(new Error(String(data['error'] || 'Host request failed')));
    } else {
      task.resolve(data['result']);
    }
    return;
  }

  if (signal === 'aily-chat:event' || data['kind'] === 'event') {
    enqueueEvent(data['event'] as ProtocolEvent);
  }
}

function enqueueEvent(event: ProtocolEvent): void {
  if (!event || typeof event !== 'object') return;
  eventQueue.push(event);
  if (flushFrame) return;
  flushFrame = requestAnimationFrame(flushEvents);
}

function flushEvents(): void {
  flushFrame = 0;
  if (!eventQueue.length) return;
  let next = state;
  for (const event of eventQueue.splice(0)) {
    next = reduceEvent(next, event);
  }
  state = next;
  listeners.forEach(listener => listener());
}

function reduceEvent(current: ChatState, event: ProtocolEvent): ChatState {
  switch (event.type) {
    case 'snapshot':
      return { ...current, ...(event.payload as ChatBootstrap) };
    case 'sessions.changed':
      return { ...current, sessions: event.payload as ChatSession[] };
    case 'session.changed': {
      const payload = event.payload as { activeSessionId: string; turns: ChatTurn[] };
      return { ...current, ...payload };
    }
    case 'turn.upsert': {
      if (event.sessionId && event.sessionId !== current.activeSessionId) return current;
      const turn = event.payload as ChatTurn;
      const index = current.turns.findIndex(item => item.id === turn.id);
      const turns = index < 0
        ? [...current.turns, turn]
        : current.turns.map(item => item.id === turn.id ? turn : item);
      return { ...current, turns };
    }
    case 'turn.removed':
      return { ...current, turns: current.turns.filter(turn => turn.id !== event.payload) };
    case 'run.state':
      return { ...current, runState: event.payload as RunState };
    default:
      return current;
  }
}

async function applyHostContext(next: Partial<HostContext>): Promise<void> {
  const context: HostContext = {
    toolId: String(next.toolId || state.context.toolId),
    lang: normalizeLang(next.lang || state.context.lang),
    theme: normalizeTheme(next.theme || state.context.theme),
    platform: String(next.platform || state.context.platform),
  };
  patch({ context });
  applyTheme(context.theme);
  await loadTranslations(context.lang);
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset['theme'] = theme;
  document.documentElement.style.colorScheme = theme;
  let link = document.querySelector<HTMLLinkElement>('#theme-style');
  if (!link) {
    link = document.createElement('link');
    link.id = 'theme-style';
    link.rel = 'stylesheet';
    document.head.append(link);
  }
  link.href = `./${theme}.css`;
}

async function loadTranslations(lang: string): Promise<void> {
  try {
    const response = await fetch(`/i18n/${lang}.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(String(response.status));
    const payload = await response.json() as Record<string, Record<string, string>>;
    patch({ translations: payload['AILY_CHAT'] || {} });
    document.documentElement.lang = lang;
  } catch {
    if (lang !== 'en') await loadTranslations('en');
  }
}

function patch(next: Partial<ChatState>): void {
  state = { ...state, ...next };
  listeners.forEach(listener => listener());
}

function asRecord(value: unknown): Record<string, any> {
  return value && typeof value === 'object' ? value as Record<string, any> : {};
}

function normalizeLang(value: string | null): string {
  const lang = String(value || 'en').toLowerCase().replace(/-/g, '_');
  if (lang === 'zh' || lang.startsWith('zh_cn')) return 'zh_cn';
  if (lang.startsWith('zh_hk') || lang.startsWith('zh_tw')) return 'zh_hk';
  return lang || 'en';
}

function normalizeTheme(value: string | null): ThemeName {
  return String(value).toLowerCase() === 'light' ? 'light' : 'dark';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

async function demoInvoke(method: string, params: Record<string, unknown>): Promise<unknown> {
  await new Promise(resolve => setTimeout(resolve, method === 'turn.send' ? 180 : 30));
  if (method === 'bootstrap') return demoBootstrap();
  if (method === 'session.select') {
    patch({ activeSessionId: String(params['sessionId']), turns: demoTurns() });
    return { ok: true };
  }
  if (method === 'session.create') {
    const session: ChatSession = { id: `demo-${Date.now()}`, title: t('NEW_CHAT', 'New chat'), updatedAt: Date.now() };
    patch({ sessions: [session, ...state.sessions], activeSessionId: session.id, turns: [] });
    return { session };
  }
  if (method === 'turn.send') {
    const text = String(params['text'] || '').trim();
    const userTurn: ChatTurn = {
      id: `user-${Date.now()}`,
      role: 'user',
      createdAt: Date.now(),
      parts: [{ id: 'text', type: 'markdown', content: text }],
    };
    const assistantTurn: ChatTurn = {
      id: `assistant-${Date.now()}`,
      role: 'assistant',
      createdAt: Date.now(),
      parts: [
        { id: 'think', type: 'thinking', title: t('ANALYZING', 'Analyzing request'), state: 'done', detail: t('DEMO_THINK', 'Mapped the request through the host protocol boundary.') },
        { id: 'answer', type: 'markdown', content: t('DEMO_REPLY', 'This standalone preview is using the local protocol simulator. Inside Aily Blockly, the same UI receives real session snapshots and streaming events from the host adapter.') },
      ],
    };
    patch({ turns: [...state.turns, userTurn, assistantTurn], runState: 'idle' });
    return { ok: true };
  }
  if (method === 'turn.stop') {
    patch({ runState: 'idle' });
    return { ok: true };
  }
  if (method === 'settings.update') {
    patch({
      activeModelId: String(params['modelId'] || state.activeModelId),
      permissionMode: params['permissionMode'] === 'full' || params['permissionMode'] === 'default'
        ? params['permissionMode']
        : state.permissionMode,
    });
    return { ok: true };
  }
  if (method === 'settings.save') {
    patch({ settings: params as unknown as ChatSettings });
    return { ok: true };
  }
  if (method === 'composer.update') {
    patch({ inputValue: String(params['value'] || '') });
    return { ok: true };
  }
  if (method === 'resource.remove') {
    const index = Number(params['index']);
    patch({ resources: state.resources?.filter((_item, itemIndex) => itemIndex !== index) });
    return { ok: true };
  }
  if (method === 'todo.toggle') {
    const id = String(params['id'] || '');
    patch({
      todos: state.todos?.map(todo => todo.id === id
        ? { ...todo, status: todo.status === 'completed' ? 'not-started' : 'completed' }
        : todo),
    });
    return { ok: true };
  }
  if (method === 'surface.toggleSettings') {
    patch({ showSettings: !state.showSettings });
    return { ok: true };
  }
  return { ok: true };
}

function demoBootstrap(): ChatBootstrap {
  return {
    sessions: [
      { id: 'demo-main', title: t('DEMO_SESSION', 'React subapp architecture'), updatedAt: Date.now() },
      { id: 'demo-perf', title: t('DEMO_PERF', 'Rendering performance pass'), updatedAt: Date.now() - 86_400_000 },
    ],
    activeSessionId: 'demo-main',
    turns: demoTurns(),
    runState: 'idle',
    models: [
      { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex' },
      { id: 'gpt-5.1-mini', label: 'GPT-5.1 Mini' },
    ],
    activeModelId: 'gpt-5.1-codex',
    permissionMode: 'default',
    paneSurface: 'chat',
    sessionListMode: 'sidebar',
    sessionSidebarWidth: 280,
    title: t('DEMO_SESSION', 'React subapp architecture'),
    inputValue: '',
    resources: [],
    todos: [
      { id: 'todo-1', content: '对齐会话列表与消息气泡', status: 'completed' },
      { id: 'todo-2', content: '接入宿主 ChatEngine 协议', status: 'in-progress' },
      { id: 'todo-3', content: '验证宽窄布局与主题', status: 'not-started' },
    ],
    notices: [],
    modeId: 'agent',
    modeLabel: '代理',
    modeOptions: [
      { id: 'agent', label: '代理', active: true },
      { id: 'ask', label: '问答' },
      { id: 'plan', label: '计划' },
    ],
    modelOptions: [
      { id: 'gpt-5.1-codex', label: 'GPT-5.1 Codex', active: true },
      { id: 'gpt-5.1-mini', label: 'GPT-5.1 Mini' },
    ],
    permissionLabel: '默认权限',
    contextUsage: { percentage: 18, label: '18%', estimated: true },
    interactionBudget: null,
    authQuota: null,
    requestQuota: null,
    showSettings: false,
    settings: demoSettings(),
  };
}

function demoSettings(): ChatSettings {
  return {
    modelPresets: [
      { id: 'auto', name: 'Auto', description: '软件内置默认 LLM', enabled: true, isDefault: true },
      { id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex', description: '面向代码任务的稳定预设', enabled: true },
    ],
    customModels: [],
    workspaceOptions: [
      { name: 'project', displayName: '项目文件', enabled: true },
      { name: 'library', displayName: '库文件', enabled: true },
    ],
    agents: [
      {
        id: 'main',
        label: '主 Agent',
        description: '处理用户请求的主要 Agent',
        tools: [
          { name: 'read_file', displayName: 'Read File', enabled: true },
          { name: 'edit_file', displayName: 'Edit File', enabled: true },
        ],
      },
      {
        id: 'SchematicAgent',
        label: '连线 Agent',
        description: '处理电路连线图相关任务的子 Agent',
        tools: [{ name: 'connect_blocks', displayName: 'Connect Blocks', enabled: true }],
      },
    ],
    maxRequests: 200,
    autoSaveEdits: false,
    sessionViewerOrientation: 'sideBySide',
    userInstructionFolders: [],
    projectInstructionFolders: [],
    userAgentFolders: [],
    projectAgentFolders: [],
    useChatSessionCustomizationsForCustomAgents: false,
    customAgents: [],
    terminalAllowList: [],
    terminalDenyList: [],
    terminalInheritDefaultAllowList: true,
  };
}

function demoTurns(): ChatTurn[] {
  return [
    {
      id: 'demo-user',
      role: 'user',
      createdAt: Date.now() - 60_000,
      parts: [{ id: 'question', type: 'markdown', content: t('DEMO_PROMPT', 'Analyze the current project and propose a clean React subapp boundary.') }],
    },
    {
      id: 'demo-assistant',
      role: 'assistant',
      createdAt: Date.now() - 30_000,
      parts: [
        { id: 'thinking', type: 'thinking', title: t('ANALYZED', 'Analyzed workspace'), detail: t('DEMO_ANALYSIS_DETAIL', 'Separated rendering, host state, and tool execution.'), state: 'done' },
        { id: 'tool', type: 'tool', title: t('READ_FILES', 'Read project files'), detail: '42 files · 11 modules', state: 'done' },
        { id: 'answer', type: 'markdown', content: t('DEMO_ANSWER', 'The React child owns presentation and interaction state. Session lifecycle, model routing, project access, and tool execution remain in the Blockly host and are exposed through a versioned request/event protocol.') },
      ],
    },
  ];
}
