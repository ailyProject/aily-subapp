import { useSyncExternalStore } from 'react';
import enMessages from '../../i18n/en.json';
import zhCnMessages from '../../i18n/zh_cn.json';
import zhHkMessages from '../../i18n/zh_hk.json';

export type ThemeName = 'dark' | 'light';
export type RunState = 'idle' | 'running' | 'waiting' | 'error';
export type PartState = 'doing' | 'done' | 'warn' | 'error' | 'info' | 'pending_approval';

export interface HostContext {
  toolId: string;
  lang: string;
  theme: ThemeName;
  platform: string;
}

export interface ChatSessionAction {
  icon: string;
  action: string;
  title: string;
  active?: boolean;
}

export interface ChatSession {
  id: string;
  title: string;
  createdAt?: number;
  updatedAt: number;
  unread?: boolean;
  current?: boolean;
  status?: string;
  detail?: string[];
  pinned?: boolean;
  archived?: boolean;
  read?: boolean;
  actions?: ChatSessionAction[];
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
  toolDisplayName?: string;
  displayTitle?: string;
  displaySubtitle?: string;
  displayMeta?: string;
  displayStatus?: string;
  displayTone?: string;
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
  turnId?: string;
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
  blockId?: string;
  blockContext?: string;
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
  detail?: string;
  iconClass?: string;
  active?: boolean;
  disabled?: boolean;
  billingLabel?: string;
  separatorBefore?: boolean;
  path?: number[];
  type?: 'item' | 'section';
  action?: string;
  children?: ChatMenuOption[];
}

export const CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_ID = 'workbench.action.chat.configure.customagents';
export const CHAT_PICKER_CONFIGURE_CUSTOM_AGENTS_ACTION_ID = 'workbench.action.chat.picker.customagents';

export function menuOptionOpensSettings(option: Pick<ChatMenuOption, 'id' | 'action' | 'label'>): boolean {
  const action = String(option.action || option.id || '').trim();
  if (
    action === CHAT_PICKER_CONFIGURE_CUSTOM_AGENTS_ACTION_ID
    || action === CHAT_CONFIGURE_CUSTOM_AGENTS_ACTION_ID
    || action === 'configure-custom-agents'
  ) {
    return true;
  }

  const label = String(option.label || '').trim().toLocaleLowerCase();
  return label.includes('configure custom agents')
    || label.includes('自定义代理')
    || label.includes('自定义配置');
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

export interface ChatRuntimeConfirmationAction {
  id: string;
  scope: string;
  label: string;
  description?: string;
  tooltip?: string;
  disabled?: boolean;
  isSecondary?: boolean;
}

export interface ChatRuntimeConfirmation {
  id: string;
  kind: 'approval' | 'confirmation';
  partId: string;
  toolCallId?: string;
  toolName?: string;
  askId?: string;
  title: string;
  subtitle?: string;
  message: string;
  args?: Record<string, unknown>;
  actions: ChatRuntimeConfirmationAction[];
  primaryScope?: string;
  primaryLabel?: string;
  rejectLabel?: string;
}

export interface ChatRuntimeQuestionOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ChatRuntimeQuestionItem {
  question: string;
  options: ChatRuntimeQuestionOption[];
  allowFreeform?: boolean;
  multiSelect?: boolean;
}

export interface ChatRuntimeQuestion {
  partId: string;
  questions: ChatRuntimeQuestionItem[];
}

export interface ChatRuntimePlanAction {
  id: string;
  label: string;
  description?: string;
  default?: boolean;
}

export interface ChatRuntimePlanReview {
  id: string;
  title: string;
  content: string;
  planUri?: string;
  canProvideFeedback?: boolean;
  actions: ChatRuntimePlanAction[];
}

export interface ChatBootstrap {
  theme?: ThemeName;
  sessions: ChatSession[];
  activeSessionId: string | null;
  turns: ChatTurn[];
  runState: RunState;
  models: Array<{ id: string; label: string }>;
  activeModelId: string;
  permissionMode: 'default' | 'full';
  permissionPreset?: 'default' | 'auto_review' | 'full';
  paneSurface?: 'chat' | 'blank-session' | 'session-loading' | 'entry' | 'welcome' | 'login';
  sessionListMode?: 'hidden' | 'stacked' | 'sidebar';
  sessionSidebarWidth?: number;
  sessionSidebarResizeMinWidth?: number;
  sessionSidebarMaxWidth?: number;
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
  pendingConfirmations?: ChatRuntimeConfirmation[];
  activeConfirmationIndex?: number;
  pendingQuestion?: ChatRuntimeQuestion | null;
  pendingPlanReview?: ChatRuntimePlanReview | null;
}

export interface ProtocolEvent {
  type: 'snapshot' | 'sessions.changed' | 'session.changed' | 'turn.upsert' | 'turn.removed' | 'run.state' | 'heartbeat';
  sessionId?: string;
  webStreamId?: number;
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

interface ActiveTurnStream {
  controller: AbortController;
  streamId: number;
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
const activeTurnStreams = new Map<string, ActiveTurnStream>();
const canceledTurnStreams = new Set<number>();
const eventQueue: ProtocolEvent[] = [];
let flushFrame = 0;
let requestSequence = 0;
let streamSequence = 0;
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
  permissionPreset: 'default',
  paneSurface: 'entry',
  sessionListMode: 'stacked',
  sessionSidebarWidth: 280,
  sessionSidebarResizeMinWidth: 240,
  sessionSidebarMaxWidth: 420,
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
  pendingConfirmations: [],
  activeConfirmationIndex: 0,
  pendingQuestion: null,
  pendingPlanReview: null,
};

const DEFAULT_WEB_API_BASE = 'http://127.0.0.1:3030';

function webApiBase(): string {
  const query = new URLSearchParams(location.search);
  const fromQuery = query.get('apiBase') || query.get('codexLearnApi');
  const fromEnv = import.meta.env.VITE_CODEX_LEARN_API as string | undefined;
  return String(fromQuery || fromEnv || DEFAULT_WEB_API_BASE).replace(/\/+$/, '');
}

export function useChatState(): ChatState {
  return useSyncExternalStore(
    callback => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => state,
  );
}

export function resolveTurnActionId(turn: Pick<ChatTurn, 'id' | 'turnId'>): string {
  return turn.turnId || turn.id;
}

export function t(key: string, fallback = key): string {
  return state.translations[key] || fallback;
}

export async function bootstrap(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const context: HostContext = {
    ...state.context,
    lang: normalizeLang(query.get('lang') || navigator.language),
    theme: normalizeTheme(query.get('theme') || state.context.theme),
    platform: 'web',
  };
  patch({ context, connected: true });
  applyTheme(state.context.theme);
  await loadTranslations(state.context.lang);

  try {
    const initial = await invoke<ChatBootstrap>('bootstrap', {
      sessionId: query.get('sessionId') || localStorage.getItem('codex-learn.web.active-session') || '',
      workspace: query.get('workspace') || '',
    });
    patch({ ...initial, loading: false, protocolError: '' });
  } catch (error) {
    const message = errorMessage(error);
    patch({ loading: false, protocolError: message });
  }
}

const DEFAULT_INVOKE_TIMEOUT_MS = 20_000;

// Methods that resolve only after the host finishes a long-running operation
// (e.g. a full generation turn). They must not be aborted by the default timeout,
// otherwise the UI would treat an in-flight turn as failed.
const UNBOUNDED_METHODS = new Set([
  'session.select',
  'turn.send',
  'turn.regenerate',
  'turn.edit',
  'turn.restore',
  'turn.fork',
]);

export async function invoke<T>(
  method: string,
  params: Record<string, unknown> = {},
  options: { timeoutMs?: number } = {},
): Promise<T> {
  void options;
  if (method === 'turn.send') {
    return streamTurnSend(params) as Promise<T>;
  }
  if (method === 'bootstrap') {
    const query = new URLSearchParams();
    const sessionId = String(params['sessionId'] || '');
    const workspace = String(params['workspace'] || '');
    if (sessionId) query.set('sessionId', sessionId);
    if (workspace) query.set('workspace', workspace);
    return apiFetch<ChatBootstrap>(`/api/bootstrap${query.size ? `?${query}` : ''}`) as Promise<T>;
  }

  const response = await apiFetch<{ ok: boolean; result: unknown }>('/api/invoke', {
    method: 'POST',
    body: JSON.stringify({ method, params }),
  });
  applyInvokeResult(method, response.result);
  return response.result as T;
}

export async function stopTurn(sessionId = state.activeSessionId || ''): Promise<void> {
  const id = String(sessionId || state.activeSessionId || '');
  if (id) {
    const active = activeTurnStreams.get(id);
    if (active) {
      canceledTurnStreams.add(active.streamId);
      active.controller.abort();
    }
    activeTurnStreams.delete(id);
  }
  patch({
    runState: 'idle',
    pendingConfirmations: [],
    activeConfirmationIndex: 0,
  });
  await invoke('turn.stop', { sessionId: id });
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${webApiBase()}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers || {}),
    },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const payload = await response.json() as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      // Keep the HTTP status fallback.
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

async function streamTurnSend(params: Record<string, unknown>): Promise<{ ok: boolean }> {
  let sessionId = String(params['sessionId'] || state.activeSessionId || '');
  if (!sessionId) {
    const created = await invoke<{ session?: ChatSession }>('session.create');
    sessionId = created.session?.id || state.activeSessionId || '';
  }

  const text = String(params['text'] || '').trim();
  if (!text) return { ok: true };

  const optimisticTurn: ChatTurn = {
    id: `local_user_${Date.now()}`,
    role: 'user',
    createdAt: Date.now(),
    parts: [{ id: 'text', type: 'markdown', content: text }],
  };
  const optimisticTitle = truncateSessionTitle(text);
  patch({
    activeSessionId: sessionId,
    paneSurface: 'chat',
    runState: 'running',
    title: optimisticTitle,
    sessions: state.sessions.map(session => session.id === sessionId
      ? { ...session, title: optimisticTitle, updatedAt: Date.now() }
      : session),
    turns: [...state.turns, optimisticTurn],
  });
  localStorage.setItem('codex-learn.web.active-session', sessionId);

  const controller = new AbortController();
  const streamId = ++streamSequence;
  activeTurnStreams.set(sessionId, { controller, streamId });

  let response: Response;
  try {
    response = await fetch(`${webApiBase()}/api/turn/send`, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        text,
        workspace: new URLSearchParams(location.search).get('workspace') || '',
      }),
    });
  } catch (error) {
    if (controller.signal.aborted) {
      return { ok: true };
    }
    activeTurnStreams.delete(sessionId);
    patch({ runState: 'error' });
    throw error;
  }
  if (!response.ok || !response.body) {
    activeTurnStreams.delete(sessionId);
    patch({ runState: 'error' });
    throw new Error(response.ok ? 'Empty stream response' : `${response.status} ${response.statusText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        consumeStreamLine(line, streamId);
      }
    }
    if (buffer.trim()) consumeStreamLine(buffer, streamId);
  } catch (error) {
    if (!controller.signal.aborted) {
      patch({ runState: 'error' });
      throw error;
    }
  } finally {
    const active = activeTurnStreams.get(sessionId);
    if (active?.streamId === streamId) {
      activeTurnStreams.delete(sessionId);
    }
    const wasCanceled = canceledTurnStreams.has(streamId);
    if (wasCanceled) {
      canceledTurnStreams.delete(streamId);
    } else {
      if (state.runState === 'running') {
        patch({ runState: 'idle' });
      }
      void refreshBootstrap();
    }
  }
  return { ok: true };
}

function truncateSessionTitle(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  return text.length > 48 ? `${text.slice(0, 48)}…` : text;
}

function consumeStreamLine(line: string, streamId?: number): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const event = JSON.parse(trimmed) as ProtocolEvent;
    if (streamId) {
      event.webStreamId = streamId;
    }
    if (event.type === 'heartbeat') {
      return;
    }
    enqueueEvent(event);
  } catch (error) {
    console.warn('Failed to parse codex-learn stream event', error, trimmed);
  }
}

function applyInvokeResult(method: string, result: unknown): void {
  const payload = asRecord(result);
  if (method === 'session.select') {
    const activeSessionId = String(payload['activeSessionId'] || '');
    if (activeSessionId) {
      localStorage.setItem('codex-learn.web.active-session', activeSessionId);
    }
    patch({
      activeSessionId,
      turns: Array.isArray(payload['turns']) ? payload['turns'] as ChatTurn[] : [],
      paneSurface: 'chat',
      runState: 'idle',
    });
    return;
  }
  if (method === 'session.create') {
    const session = payload['session'] as ChatSession | undefined;
    if (!session?.id) return;
    localStorage.setItem('codex-learn.web.active-session', session.id);
    patch({
      sessions: mergeSessions([session, ...state.sessions], session.id),
      activeSessionId: session.id,
      turns: [],
      paneSurface: 'chat',
      title: session.title,
    });
    return;
  }
  if (method === 'surface.toggleSettings') {
    patch({ showSettings: Boolean(payload['showSettings']) });
    return;
  }
  if (method === 'turn.stop') {
    patch({
      runState: 'idle',
      pendingConfirmations: [],
      activeConfirmationIndex: 0,
    });
    return;
  }
  if (method === 'interaction.respond') {
    patch({
      pendingConfirmations: [],
      activeConfirmationIndex: 0,
    });
    return;
  }
  if (method === 'session.action') {
    if (Array.isArray(payload['sessions'])) {
      const activeSessionId = payload['activeSessionId'] != null
        ? (String(payload['activeSessionId'] || '') || null)
        : state.activeSessionId;
      patch({
        sessions: payload['sessions'] as ChatSession[],
        activeSessionId,
        paneSurface: activeSessionId ? 'chat' : 'entry',
      });
      if (activeSessionId) {
        localStorage.setItem('codex-learn.web.active-session', activeSessionId);
      } else {
        localStorage.removeItem('codex-learn.web.active-session');
      }
    }
    void refreshBootstrap();
  }
}

async function refreshBootstrap(): Promise<void> {
  try {
    const next = await invoke<ChatBootstrap>('bootstrap', {
      sessionId: state.activeSessionId || '',
      workspace: new URLSearchParams(location.search).get('workspace') || '',
    });
    patch({ ...next, loading: false, protocolError: '' });
    const activeId = next.activeSessionId || '';
    if (activeId) {
      localStorage.setItem('codex-learn.web.active-session', activeId);
    } else {
      localStorage.removeItem('codex-learn.web.active-session');
    }
  } catch (error) {
    patch({ protocolError: errorMessage(error) });
  }
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
        document.querySelector<HTMLTextAreaElement>('.aily-chat-composer-input')?.focus();
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
  if (event.webStreamId && canceledTurnStreams.has(event.webStreamId)) {
    return current;
  }
  switch (event.type) {
    case 'snapshot': {
      const payload = event.payload as ChatBootstrap;
      return { ...current, ...payload };
    }
    case 'sessions.changed':
      return { ...current, sessions: event.payload as ChatSession[] };
    case 'session.changed': {
      const payload = event.payload as { activeSessionId: string; turns: ChatTurn[]; sessions?: ChatSession[]; title?: string };
      return {
        ...current,
        ...payload,
        sessions: payload.sessions ? mergeSessions(payload.sessions, payload.activeSessionId) : current.sessions,
      };
    }
    case 'turn.upsert': {
      if (event.sessionId && event.sessionId !== current.activeSessionId) return current;
      const turn = event.payload as ChatTurn;
      const index = current.turns.findIndex(item => item.id === turn.id);
      const turns = index < 0
        ? [...current.turns, turn]
        : current.turns.map(item => item.id === turn.id ? turn : item);
      return { ...current, turns, runState: turn.doing ? 'running' : current.runState };
    }
    case 'turn.removed':
      return { ...current, turns: current.turns.filter(turn => turn.id !== event.payload) };
    case 'run.state':
      if (event.webStreamId && canceledTurnStreams.has(event.webStreamId)) return current;
      return { ...current, runState: event.payload as RunState };
    default:
      return current;
  }
}

function mergeSessions(sessions: ChatSession[], activeSessionId?: string | null): ChatSession[] {
  const byId = new Map<string, ChatSession>();
  for (const session of sessions) {
    if (!session?.id) continue;
    const previous = byId.get(session.id);
    byId.set(session.id, {
      ...previous,
      ...session,
      current: Boolean(activeSessionId) && session.id === activeSessionId,
    });
  }
  return [...byId.values()].sort((left, right) => (right.updatedAt || 0) - (left.updatedAt || 0));
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
  const catalogs: Record<string, Record<string, Record<string, string>>> = {
    en: enMessages,
    zh_cn: zhCnMessages,
    zh_hk: zhHkMessages,
  };
  const normalized = catalogs[lang] ? lang : 'en';
  patch({ translations: catalogs[normalized]['AILY_CHAT'] || {} });
  document.documentElement.lang = normalized;
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
  if (method === 'session.action') {
    return demoSessionAction(params);
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
  if (method === 'menu.select') {
    const kind = String(params['kind'] || '');
    const path = Array.isArray(params['path']) ? params['path'].map(Number) : [];
    const option = findDemoMenuOption(
      kind === 'mode' ? state.modeOptions || [] : state.modelOptions || [],
      path,
    );
    if (kind === 'mode' && option?.id === 'configure-custom-agents') {
      patch({ showSettings: true });
    } else if (kind === 'mode' && option) {
      const builtinMode = ['agent', 'plan', 'ask', 'edit'].includes(option.id);
      patch({
        modeId: builtinMode ? option.id : 'agent',
        modeLabel: builtinMode ? '' : option.label,
      });
    } else if (kind === 'model' && option) {
      patch({ activeModelId: option.id });
    }
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

function demoSessionAction(params: Record<string, unknown>): { ok: boolean } {
  const sessionId = String(params['sessionId'] || '');
  const action = String(params['action'] || '');
  const sessions = state.sessions.map(session => {
    if (session.id !== sessionId) return session;
    switch (action) {
      case 'pin-session':
        return { ...session, pinned: true };
      case 'unpin-session':
        return { ...session, pinned: false };
      case 'mark-session-read':
        return { ...session, unread: false, read: true };
      case 'mark-session-unread':
        return { ...session, unread: true, read: false };
      case 'archive-session':
        return { ...session, archived: true, pinned: false };
      case 'unarchive-session':
        return { ...session, archived: false };
      case 'rename-session': {
        const title = String(params['title'] || '').trim();
        return title ? { ...session, title, updatedAt: Date.now() } : session;
      }
      default:
        return session;
    }
  }).filter(session => !(action === 'delete-session' && session.id === sessionId));

  const activeSessionId = action === 'delete-session' && state.activeSessionId === sessionId
    ? sessions[0]?.id ?? null
    : state.activeSessionId;
  const title = action === 'rename-session' && state.activeSessionId === sessionId
    ? String(params['title'] || state.title)
    : state.title;

  patch({ sessions, activeSessionId, title });
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
  sessionSidebarResizeMinWidth: 240,
  sessionSidebarMaxWidth: 420,
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
      { id: 'agent', label: '代理模式', active: true, iconClass: 'fa-light fa-user-astronaut', path: [0] },
      { id: 'plan', label: '计划', iconClass: 'fa-light fa-list-check', path: [1] },
      { id: 'ask', label: '问答模式', iconClass: 'fa-light fa-comment-smile', path: [2] },
      { id: 'custom-agent', label: 'Review Agent', iconClass: 'fa-light fa-user-astronaut', separatorBefore: true, path: [4] },
      { id: 'configure-custom-agents', label: 'Configure Custom Agents...', iconClass: 'fa-light fa-gear', separatorBefore: true, path: [6] },
    ],
    modelOptions: [
      {
        id: 'gpt-5.1-codex',
        label: 'GPT-5.1 Codex',
        active: true,
        path: [0],
        children: [
          { id: 'gpt-5.1-codex-low', label: 'Low', detail: '较快响应，较少推理', path: [0, 0] },
          { id: 'gpt-5.1-codex-medium', label: 'Medium', detail: '平衡速度与推理', active: true, path: [0, 1] },
          { id: 'gpt-5.1-codex-high', label: 'High', detail: '更深入推理', path: [0, 2] },
        ],
      },
      { id: 'gpt-5.1-mini', label: 'GPT-5.1 Mini', separatorBefore: true, path: [2] },
      { id: 'other-models', label: '其他模型', type: 'section', separatorBefore: true, path: [4] },
      { id: 'custom-model', label: 'Custom Model', path: [5] },
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

function findDemoMenuOption(options: ChatMenuOption[], path: number[]): ChatMenuOption | undefined {
  for (const option of options) {
    if (option.path?.length === path.length && option.path.every((value, index) => value === path[index])) {
      return option;
    }
    const child = option.children ? findDemoMenuOption(option.children, path) : undefined;
    if (child) {
      return child;
    }
  }
  return undefined;
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
        { id: 'thinking', type: 'thinking', content: t('DEMO_ANALYSIS_DETAIL', 'Separated rendering, host state, and tool execution.'), isComplete: true, state: 'done' },
        {
          id: 'tool',
          type: 'tool_call',
          toolName: 'read_file',
          toolDisplayName: 'ReadFile',
          displayTitle: t('READ_FILES', 'Read project files'),
          displaySubtitle: 'src/app/tools/aily-chat/aily-chat.component.ts · L1-L240',
          displayMeta: '1.2s',
          state: 'done',
          args: { filePath: 'src/app/tools/aily-chat/aily-chat.component.ts', startLine: 1, endLine: 240 },
        },
        { id: 'answer', type: 'markdown', content: t('DEMO_ANSWER', 'The React child owns presentation and interaction state. Session lifecycle, model routing, project access, and tool execution remain in the Blockly host and are exposed through a versioned request/event protocol.') },
      ],
    },
  ];
}
