import { useSyncExternalStore } from 'react';

export type ThemeName = 'dark' | 'light';

export interface HostContext {
  lang: string;
  theme: ThemeName;
  platform: string;
}

interface HostRemote {
  getHostContext?: () => Promise<Partial<HostContext> | null> | Partial<HostContext> | null;
  childReady?: (data: Record<string, unknown>) => void;
  childError?: (data: Record<string, unknown>) => void;
  reportHostMessage?: (data: Record<string, unknown>) => void;
}

interface PenpalApi {
  WindowMessenger: new (options: Record<string, unknown>) => unknown;
  connect: (options: Record<string, unknown>) => {
    promise: Promise<HostRemote>;
  };
}

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface PendingRequest {
  resolve(value: any): void;
  reject(reason?: unknown): void;
  timeout: number;
}

export interface RuntimeSnapshot {
  context: HostContext;
  backendState: 'connecting' | 'ready' | 'closed' | 'error';
  backendPid: number;
  translations: Record<string, string>;
}

declare global {
  interface Window {
    Penpal?: PenpalApi;
  }
}

const TOOL_NAMESPACE = '{{TOOL_NAMESPACE}}';
const listeners = new Set<() => void>();
const pending = new Map<number, PendingRequest>();
let requestSequence = 0;
let socket: WebSocket | null = null;
let remote: HostRemote | null = null;
let snapshot: RuntimeSnapshot = {
  context: { lang: 'en', theme: 'dark', platform: 'browser' },
  backendState: 'connecting',
  backendPid: 0,
  translations: {},
};

function emit(patch: Partial<RuntimeSnapshot>): void {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(listener => listener());
}

export function useRuntime(): RuntimeSnapshot {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}

export function translate(key: string, fallback = key): string {
  return snapshot.translations[key] || fallback;
}

export async function bootstrapRuntime(): Promise<void> {
  const query = new URLSearchParams(location.search);
  const context: HostContext = {
    lang: normalizeLang(query.get('lang') || navigator.language),
    theme: 'dark',
    platform: 'browser',
  };
  emit({ context });

  await connectHost();
  applyTheme(snapshot.context.theme);
  await loadTranslations(snapshot.context.lang);
  connectBackend(query.get('token') || '');
}

export function request<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('Backend is not connected'));
  }

  const id = ++requestSequence;
  return new Promise<T>((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC timeout: ${method}`));
    }, 12_000);

    pending.set(id, { resolve, reject, timeout });
    socket?.send(JSON.stringify({ id, method, params }));
  });
}

export function reportError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error || 'Unknown error');
  remote?.childError?.({ message });
}

function connectBackend(token: string): void {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  socket.addEventListener('open', () => {
    emit({ backendState: 'ready' });
    void request<{ pid?: number }>('status').then(status => {
      emit({ backendPid: Number(status.pid) || 0 });
      remote?.childReady?.({ wsConnected: true, backendStatus: 'ready', pid: status.pid });
    }).catch(reportError);
  });

  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data)) as RpcResponse | { event: string; data?: Record<string, unknown> };
    if ('event' in message) {
      if (message.event === 'ready') {
        emit({ backendPid: Number(message.data?.['pid']) || 0 });
      }
      return;
    }

    const task = pending.get(message.id);
    if (!task) return;
    pending.delete(message.id);
    window.clearTimeout(task.timeout);
    message.ok ? task.resolve(message.result) : task.reject(new Error(message.error || 'RPC failed'));
  });

  socket.addEventListener('close', () => {
    emit({ backendState: 'closed' });
    rejectPending(new Error('Backend WebSocket closed'));
  });

  socket.addEventListener('error', () => {
    emit({ backendState: 'error' });
  });
}

async function connectHost(): Promise<void> {
  if (!window.Penpal || window.parent === window) return;

  try {
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
          document.querySelector<HTMLElement>('input, textarea, button')?.focus();
          return { ok: true };
        },
        beforeClose: () => ({ canClose: true, connected: socket?.readyState === WebSocket.OPEN }),
      },
    });
    remote = await connection.promise;
    const context = await remote.getHostContext?.();
    if (context) await applyHostContext(context);
  } catch (error) {
    console.warn('[child-tool] host connection failed', error);
  }
}

async function applyHostContext(next: Partial<HostContext>): Promise<void> {
  const context: HostContext = {
    lang: normalizeLang(next.lang || snapshot.context.lang),
    theme: normalizeTheme(next.theme || snapshot.context.theme),
    platform: String(next.platform || snapshot.context.platform),
  };
  emit({ context });
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
    const payload = await response.json() as Record<string, Record<string, string>>;
    emit({ translations: payload[TOOL_NAMESPACE] || {} });
    document.documentElement.lang = lang;
  } catch {
    if (lang !== 'en') await loadTranslations('en');
  }
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

function rejectPending(reason: Error): void {
  pending.forEach(task => {
    window.clearTimeout(task.timeout);
    task.reject(reason);
  });
  pending.clear();
}
