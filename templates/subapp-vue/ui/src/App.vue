<template>
  <main class="tool-shell">
    <section class="toolbar">
      <div class="title-block">
        <h1>{{ title }}</h1>
        <p>{{ descriptionText }}</p>
      </div>
      <span class="status" :class="{ ready: backendStatus === 'ready' }">{{ statusLabel }}</span>
    </section>

    <section class="workspace">
      <form class="panel command-panel" @submit.prevent="runEcho">
        <div class="panel-title">{{ t('COMMAND', 'Command') }}</div>
        <label class="field">
          <span>{{ t('MESSAGE', 'Message') }}</span>
          <input v-model="message" type="text">
        </label>
        <div class="actions">
          <button class="primary" type="submit" :disabled="backendStatus !== 'ready'">
            {{ t('RUN', 'Run') }}
          </button>
          <button type="button" @click="clearOutput">
            {{ t('CLEAR', 'Clear') }}
          </button>
        </div>
      </form>

      <section class="panel result-panel">
        <div class="panel-title">{{ t('RESULT', 'Result') }}</div>
        <pre class="mono">{{ result }}</pre>
      </section>

      <section class="panel log-panel">
        <div class="panel-title">{{ t('LOG', 'Log') }}</div>
        <div class="log-list">
          <div v-for="log in logs" :key="log.id" class="log-row" :class="log.type">
            <span class="time">{{ log.time }}</span>
            <span class="label">{{ t(log.label, log.label) }}</span>
            <span class="detail mono">{{ log.detail }}</span>
          </div>
        </div>
      </section>
    </section>
  </main>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';

type ThemeName = 'dark' | 'light';

interface HostContext {
  lang: string;
  theme: ThemeName;
  platform: string;
}

interface HostRemote {
  getHostContext?: () => Promise<Partial<HostContext> | null> | Partial<HostContext> | null;
  childReady?: (data: Record<string, unknown>) => void;
  childError?: (data: Record<string, unknown>) => void;
}

interface PenpalApi {
  WindowMessenger: new (options: Record<string, unknown>) => unknown;
  connect: (options: Record<string, unknown>) => {
    promise: Promise<HostRemote>;
  };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: ReturnType<typeof window.setTimeout>;
}

interface RpcResponseMessage {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface RpcEventMessage {
  event: string;
  data?: Record<string, unknown>;
}

interface LogItem {
  id: number;
  type: string;
  label: string;
  detail: string;
  time: string;
}

declare global {
  interface Window {
    Penpal?: PenpalApi;
  }
}

const TOOL_NAMESPACE = '{{TOOL_NAMESPACE}}';
const TOOL_NAME = '{{Tool Name}}';
const TOOL_DESCRIPTION = '{{tool-description}}';
const DRAFT_KEY = '{{tool-id}}.vue.ui.draft.v1';

const hostContext = reactive<HostContext>({
  lang: 'en',
  theme: 'dark',
  platform: 'browser'
});
const i18n = ref<Record<string, string>>({});
const token = ref('');
const backendStatus = ref('connecting');
const backendPid = ref(0);
const message = ref('hello');
const result = ref('');
const logs = ref<LogItem[]>([]);

let backendWs: WebSocket | null = null;
let hostRemote: HostRemote | null = null;
let requestSeq = 0;
let logSeq = 0;
const pendingRequests = new Map<number, PendingRequest>();

if (!document.documentElement.dataset['theme']) {
  document.body.style.visibility = 'hidden';
}

const title = computed(() => t('TITLE', TOOL_NAME));
const descriptionText = computed(() => t('DESCRIPTION', TOOL_DESCRIPTION));
const statusLabel = computed(() => t(`STATUS_${backendStatus.value.toUpperCase()}`, backendStatus.value));

onMounted(() => {
  void bootstrap();
});

async function bootstrap(): Promise<void> {
  const query = new URLSearchParams(window.location.search);
  token.value = query.get('token') || '';
  hostContext.lang = normalizeLang(query.get('lang') || navigator.language || 'en');
  hostContext.theme = 'dark';
  hostContext.platform = 'browser';

  document.documentElement.lang = hostContext.lang;
  await connectHost();
  applyTheme(hostContext.theme);
  loadDraft();
  void loadI18n(hostContext.lang);
  connectBackend();
}

onBeforeUnmount(() => {
  saveDraft();
  rejectPending(new Error('Backend WebSocket closed'));
  backendWs?.close();
});

watch([message, result], () => saveDraft());

function t(key: string, fallback = key): string {
  return i18n.value[key] || fallback;
}

async function runEcho(): Promise<void> {
  const text = message.value.trim() || 'hello';
  pushLog('request', 'ECHO_REQUEST', text);

  try {
    const data = await request<Record<string, unknown>>('sample.echo', { message: text });
    result.value = JSON.stringify(data, null, 2);
    saveDraft();
    pushLog('response', 'ECHO_RESPONSE', String(data['message'] || ''));
  } catch (error) {
    pushLog('error', 'ECHO_FAILED', errorMessage(error));
    notifyHostError(error);
  }
}

function clearOutput(): void {
  result.value = '';
  logs.value = [];
  saveDraft();
}

function loadDraft(): void {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') as Partial<Record<'message' | 'result', string>> | null;
    if (!draft || typeof draft !== 'object') return;
    if (typeof draft.message === 'string') message.value = draft.message;
    if (typeof draft.result === 'string') result.value = draft.result;
  } catch {
    // Ignore invalid persisted draft data.
  }
}

function saveDraft(): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      message: message.value,
      result: result.value
    }));
  } catch {
    // Storage may be unavailable in some browser modes.
  }
}

function normalizeLang(lang: string | null): string {
  const normalized = String(lang || 'en').toLowerCase().replace(/-/g, '_');
  if (normalized === 'zh' || normalized.startsWith('zh_cn')) return 'zh_cn';
  if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
  return normalized || 'en';
}

function normalizeTheme(theme: string | null | undefined): ThemeName {
  return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
}

function applyTheme(theme: ThemeName): void {
  document.documentElement.dataset['theme'] = theme;
  document.documentElement.style.colorScheme = theme;
  document.body.style.visibility = '';

  let themeLink = document.getElementById('theme-style') as HTMLLinkElement | null;
  if (!themeLink) {
    themeLink = document.createElement('link');
    themeLink.id = 'theme-style';
    themeLink.rel = 'stylesheet';
    document.head.appendChild(themeLink);
  }

  const href = `./${theme}.css`;
  if (themeLink.getAttribute('href') !== href) {
    themeLink.setAttribute('href', href);
  }
}

async function applyHostContext(context: Partial<HostContext> = {}): Promise<void> {
  const lang = normalizeLang(context.lang || hostContext.lang);
  const theme = normalizeTheme(context.theme || hostContext.theme);
  Object.assign(hostContext, {
    ...context,
    lang,
    theme
  });
  document.documentElement.lang = lang;
  applyTheme(theme);
  await loadI18n(lang);
}

async function loadI18n(lang: string): Promise<void> {
  const normalized = normalizeLang(lang);
  const candidates = normalized === 'en' ? ['en'] : [normalized, 'en'];

  for (const candidate of candidates) {
    try {
      const response = await fetch(`/i18n/${candidate}.json`, { cache: 'no-store' });
      if (!response.ok) continue;
      const data = await response.json() as Record<string, Record<string, string>>;
      i18n.value = data[TOOL_NAMESPACE] || {};
      document.title = title.value;
      return;
    } catch {
      // Try the fallback language.
    }
  }
}

async function connectHost(): Promise<void> {
  if (!window.parent || window.parent === window) return;
  if (!(await ensurePenpal())) return;

  const penpal = window.Penpal;
  if (!penpal) return;

  const messenger = new penpal.WindowMessenger({
    remoteWindow: window.parent,
    allowedOrigins: ['*']
  });
  const connection = penpal.connect({
    messenger,
    methods: {
      setHostContext: (context: Partial<HostContext> = {}) => {
        void applyHostContext(context);
        return { ok: true };
      },
      focusTool: () => {
        window.focus();
        return { ok: true };
      },
      beforeClose: () => {
        saveDraft();
        return {
          canClose: true,
          connected: backendWs?.readyState === WebSocket.OPEN,
          draftSaved: true
        };
      }
    }
  });

  try {
    const remote = await connection.promise;
    hostRemote = remote;
    if (typeof remote.getHostContext === 'function') {
      const context = await remote.getHostContext();
      if (context) await applyHostContext(context);
    }
    if (backendStatus.value === 'ready') notifyHostReady();
  } catch (error) {
    pushLog('error', 'HOST_CONNECTION_FAILED', errorMessage(error));
  }
}

function ensurePenpal(): Promise<boolean> {
  if (window.Penpal) return Promise.resolve(true);

  return new Promise(resolve => {
    const existing = document.querySelector<HTMLScriptElement>('script[data-penpal-vendor]');
    if (existing) {
      existing.addEventListener('load', () => resolve(Boolean(window.Penpal)), { once: true });
      existing.addEventListener('error', () => resolve(false), { once: true });
      return;
    }

    const script = document.createElement('script');
    script.src = './vendor/penpal.min.js';
    script.async = true;
    script.dataset['penpalVendor'] = 'true';
    script.addEventListener('load', () => resolve(Boolean(window.Penpal)), { once: true });
    script.addEventListener('error', () => resolve(false), { once: true });
    document.head.appendChild(script);
  });
}

function notifyHostReady(): void {
  if (typeof hostRemote?.childReady !== 'function') return;
  hostRemote.childReady({
    wsConnected: backendWs?.readyState === WebSocket.OPEN,
    backendStatus: backendStatus.value,
    pid: backendPid.value
  });
}

function notifyHostError(error: unknown): void {
  if (typeof hostRemote?.childError !== 'function') return;
  hostRemote.childError({ message: errorMessage(error) });
}

function connectBackend(): void {
  backendWs?.close();
  rejectPending(new Error('Backend reconnecting'));
  backendStatus.value = 'connecting';

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  backendWs = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token.value)}`);
  backendWs.addEventListener('open', () => {
    void handleBackendOpen();
  });
  backendWs.addEventListener('message', event => {
    handleBackendMessage(String(event.data));
  });
  backendWs.addEventListener('close', () => {
    backendStatus.value = backendStatus.value === 'error' ? 'error' : 'closed';
    rejectPending(new Error('Backend WebSocket closed'));
  });
  backendWs.addEventListener('error', () => {
    backendStatus.value = 'error';
    const error = new Error('Backend WebSocket connection failed');
    pushLog('error', 'HOST_CONNECTION_FAILED', error.message);
    notifyHostError(error);
  });
}

async function handleBackendOpen(): Promise<void> {
  try {
    const status = await request<Record<string, unknown>>('status');
    backendStatus.value = 'ready';
    backendPid.value = Number(status['pid'] || backendPid.value || 0);
    pushLog('system', 'BACKEND_READY', `pid=${backendPid.value}`);
    notifyHostReady();
  } catch (error) {
    backendStatus.value = 'error';
    notifyHostError(error);
  }
}

function request<T = unknown>(
  method: string,
  params: Record<string, unknown> = {},
  timeoutMs = 15000
): Promise<T> {
  if (!backendWs || backendWs.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('WebSocket is not connected'));
  }

  const id = ++requestSeq;
  const payload = JSON.stringify({ id, method, params });
  const response = new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out: ${method}`));
    }, timeoutMs);
    pendingRequests.set(id, {
      resolve: value => resolve(value as T),
      reject,
      timeout
    });
  });

  backendWs.send(payload);
  return response;
}

function handleBackendMessage(raw: string): void {
  let message: Partial<RpcResponseMessage & RpcEventMessage>;
  try {
    message = JSON.parse(raw) as Partial<RpcResponseMessage & RpcEventMessage>;
  } catch (error) {
    notifyHostError(error);
    return;
  }

  if (typeof message.id === 'number') {
    handleRpcResponse(message as RpcResponseMessage);
    return;
  }

  if (message.event) handleBackendEvent(message as RpcEventMessage);
}

function handleRpcResponse(message: RpcResponseMessage): void {
  const pending = pendingRequests.get(message.id);
  if (!pending) return;

  window.clearTimeout(pending.timeout);
  pendingRequests.delete(message.id);
  if (message.ok) {
    pending.resolve(message.result);
  } else {
    pending.reject(new Error(message.error || `${TOOL_NAME} request failed`));
  }
}

function handleBackendEvent(message: RpcEventMessage): void {
  if (message.event === 'ready') {
    backendStatus.value = 'ready';
    backendPid.value = Number(message.data?.['pid'] || backendPid.value || 0);
    notifyHostReady();
    return;
  }

  pushLog('event', message.event, JSON.stringify(message.data || {}));
}

function rejectPending(error: Error): void {
  for (const pending of pendingRequests.values()) {
    window.clearTimeout(pending.timeout);
    pending.reject(error);
  }
  pendingRequests.clear();
}

function pushLog(type: string, label: string, detail = ''): void {
  logs.value = [{
    id: ++logSeq,
    type,
    label,
    detail,
    time: new Date().toLocaleTimeString()
  }, ...logs.value].slice(0, 80);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message || String(error);
  return String(error || '');
}
</script>

<style scoped>
.tool-shell {
  display: flex;
  height: 100%;
  min-height: 0;
  flex-direction: column;
}

.toolbar {
  display: flex;
  min-height: 58px;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}

.title-block {
  min-width: 0;
}

h1,
p {
  margin: 0;
}

h1 {
  overflow: hidden;
  font-size: 15px;
  line-height: 1.3;
  letter-spacing: 0;
  text-overflow: ellipsis;
  white-space: nowrap;
}

p {
  margin-top: 3px;
  overflow: hidden;
  color: var(--muted);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.status {
  flex: 0 0 auto;
  color: var(--danger);
  font-weight: 700;
}

.status.ready {
  color: var(--ok);
}

.workspace {
  display: grid;
  grid-template-columns: minmax(240px, 0.8fr) minmax(300px, 1.2fr);
  grid-template-rows: minmax(0, 1fr) 160px;
  gap: 10px;
  min-height: 0;
  flex: 1;
  padding: 10px;
}

.panel {
  display: flex;
  min-height: 0;
  flex-direction: column;
  gap: 8px;
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel);
}

.log-panel {
  grid-column: 1 / -1;
}

.panel-title {
  min-height: 22px;
  font-size: 12px;
  font-weight: 700;
}

.field {
  display: flex;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}

.field span {
  color: var(--muted);
  font-size: 12px;
}

input {
  min-height: 30px;
  padding: 4px 8px;
}

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.primary {
  color: var(--primary);
}

.primary:hover:not(:disabled) {
  color: var(--primary-strong);
  background: var(--primary-soft);
}

.mono {
  font-family: Consolas, Monaco, "Courier New", monospace;
}

pre,
.log-list {
  flex: 1;
  min-height: 0;
  margin: 0;
  overflow: auto;
}

pre {
  padding: 8px;
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 4px;
  background: var(--panel-soft);
}

.log-row {
  display: grid;
  grid-template-columns: 70px minmax(90px, 160px) minmax(0, 1fr);
  gap: 8px;
  padding: 5px 0;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}

.time {
  color: var(--muted);
}

.detail,
.label {
  overflow-wrap: anywhere;
}

.log-row.error .label {
  color: var(--danger);
}

.log-row.response .label {
  color: var(--ok);
}

.log-row.request .label {
  color: var(--primary);
}

@media (max-width: 760px) {
  .workspace {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(220px, 1fr) 160px;
  }
}
</style>
