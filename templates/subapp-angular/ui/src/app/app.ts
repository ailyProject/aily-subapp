import { CommonModule } from '@angular/common';
import { Component, OnDestroy, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';

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
  timeout: number;
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
const DRAFT_KEY = '{{tool-id}}.angular.ui.draft.v1';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy {
  hostContext: HostContext = {
    lang: 'en',
    theme: 'dark',
    platform: 'browser'
  };
  i18n: Record<string, string> = {};
  token = '';
  backendStatus = 'connecting';
  backendPid = 0;
  message = 'hello';
  result = '';
  logs: LogItem[] = [];

  private backendWs: WebSocket | null = null;
  private hostRemote: HostRemote | null = null;
  private requestSeq = 0;
  private logSeq = 0;
  private pendingRequests = new Map<number, PendingRequest>();

  get title(): string {
    return this.t('TITLE', TOOL_NAME);
  }

  get descriptionText(): string {
    return this.t('DESCRIPTION', TOOL_DESCRIPTION);
  }

  get statusLabel(): string {
    return this.t(`STATUS_${this.backendStatus.toUpperCase()}`, this.backendStatus);
  }

  ngOnInit(): void {
    const query = new URLSearchParams(window.location.search);
    this.token = query.get('token') || '';
    this.hostContext = {
      lang: this.normalizeLang(query.get('lang') || navigator.language || 'en'),
      theme: 'dark',
      platform: 'browser'
    };

    void this.bootstrap();
  }

  private async bootstrap(): Promise<void> {
    document.documentElement.lang = this.hostContext.lang;
    await this.connectHost();
    this.applyTheme(this.hostContext.theme);
    this.loadDraft();
    void this.loadI18n(this.hostContext.lang);
    this.connectBackend();
  }

  ngOnDestroy(): void {
    this.saveDraft();
    this.rejectPending(new Error('Backend WebSocket closed'));
    this.backendWs?.close();
  }

  t(key: string, fallback = key): string {
    return this.i18n[key] || fallback;
  }

  async runEcho(): Promise<void> {
    const text = this.message.trim() || 'hello';
    this.pushLog('request', 'ECHO_REQUEST', text);

    try {
      const data = await this.request<Record<string, unknown>>('sample.echo', { message: text });
      this.result = JSON.stringify(data, null, 2);
      this.saveDraft();
      this.pushLog('response', 'ECHO_RESPONSE', String(data['message'] || ''));
    } catch (error) {
      this.pushLog('error', 'ECHO_FAILED', this.errorMessage(error));
      this.notifyHostError(error);
    }
  }

  clearOutput(): void {
    this.result = '';
    this.logs = [];
    this.saveDraft();
  }

  saveDraft(): void {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        message: this.message,
        result: this.result
      }));
    } catch {
      // Storage may be unavailable in some browser modes.
    }
  }

  private loadDraft(): void {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') as Partial<Record<'message' | 'result', string>> | null;
      if (!draft || typeof draft !== 'object') return;
      if (typeof draft.message === 'string') this.message = draft.message;
      if (typeof draft.result === 'string') this.result = draft.result;
    } catch {
      // Ignore invalid persisted draft data.
    }
  }

  private normalizeLang(lang: string | null): string {
    const normalized = String(lang || 'en').toLowerCase().replace(/-/g, '_');
    if (normalized === 'zh' || normalized.startsWith('zh_cn')) return 'zh_cn';
    if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
    return normalized || 'en';
  }

  private normalizeTheme(theme: string | null | undefined): ThemeName {
    return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
  }

  private applyTheme(theme: ThemeName): void {
    document.documentElement.dataset['theme'] = theme;
    document.documentElement.style.colorScheme = theme;

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

  private async applyHostContext(context: Partial<HostContext> = {}): Promise<void> {
    const lang = this.normalizeLang(context.lang || this.hostContext.lang);
    const theme = this.normalizeTheme(context.theme || this.hostContext.theme);
    this.hostContext = {
      ...this.hostContext,
      ...context,
      lang,
      theme
    };
    document.documentElement.lang = lang;
    this.applyTheme(theme);
    await this.loadI18n(lang);
  }

  private async loadI18n(lang: string): Promise<void> {
    const normalized = this.normalizeLang(lang);
    const candidates = normalized === 'en' ? ['en'] : [normalized, 'en'];

    for (const candidate of candidates) {
      try {
        const response = await fetch(`/i18n/${candidate}.json`, { cache: 'no-store' });
        if (!response.ok) continue;
        const data = await response.json() as Record<string, Record<string, string>>;
        this.i18n = data[TOOL_NAMESPACE] || {};
        document.title = this.title;
        return;
      } catch {
        // Try the fallback language.
      }
    }
  }

  private async connectHost(): Promise<void> {
    if (!window.Penpal || !window.parent || window.parent === window) return;

    const messenger = new window.Penpal.WindowMessenger({
      remoteWindow: window.parent,
      allowedOrigins: ['*']
    });
    const connection = window.Penpal.connect({
      messenger,
      methods: {
        setHostContext: (context: Partial<HostContext> = {}) => {
          void this.applyHostContext(context);
          return { ok: true };
        },
        focusTool: () => {
          window.focus();
          return { ok: true };
        },
        beforeClose: () => {
          this.saveDraft();
          return {
            canClose: true,
            connected: this.backendWs?.readyState === WebSocket.OPEN,
            draftSaved: true
          };
        }
      }
    });

    try {
      const remote = await connection.promise;
      this.hostRemote = remote;
      if (typeof remote.getHostContext === 'function') {
        const context = await remote.getHostContext();
        if (context) await this.applyHostContext(context);
      }
      if (this.backendStatus === 'ready') this.notifyHostReady();
    } catch (error) {
      this.pushLog('error', 'HOST_CONNECTION_FAILED', this.errorMessage(error));
    }
  }

  private notifyHostReady(): void {
    if (typeof this.hostRemote?.childReady !== 'function') return;
    this.hostRemote.childReady({
      wsConnected: this.backendWs?.readyState === WebSocket.OPEN,
      backendStatus: this.backendStatus,
      pid: this.backendPid
    });
  }

  private notifyHostError(error: unknown): void {
    if (typeof this.hostRemote?.childError !== 'function') return;
    this.hostRemote.childError({ message: this.errorMessage(error) });
  }

  private connectBackend(): void {
    this.backendWs?.close();
    this.rejectPending(new Error('Backend reconnecting'));
    this.backendStatus = 'connecting';

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.backendWs = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.backendWs.addEventListener('open', () => {
      void this.handleBackendOpen();
    });
    this.backendWs.addEventListener('message', event => {
      this.handleBackendMessage(String(event.data));
    });
    this.backendWs.addEventListener('close', () => {
      this.backendStatus = this.backendStatus === 'error' ? 'error' : 'closed';
      this.rejectPending(new Error('Backend WebSocket closed'));
    });
    this.backendWs.addEventListener('error', () => {
      this.backendStatus = 'error';
      const error = new Error('Backend WebSocket connection failed');
      this.pushLog('error', 'HOST_CONNECTION_FAILED', error.message);
      this.notifyHostError(error);
    });
  }

  private async handleBackendOpen(): Promise<void> {
    try {
      const status = await this.request<Record<string, unknown>>('status');
      this.backendStatus = 'ready';
      this.backendPid = Number(status['pid'] || this.backendPid || 0);
      this.pushLog('system', 'BACKEND_READY', `pid=${this.backendPid}`);
      this.notifyHostReady();
    } catch (error) {
      this.backendStatus = 'error';
      this.notifyHostError(error);
    }
  }

  private request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15000
  ): Promise<T> {
    if (!this.backendWs || this.backendWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not connected'));
    }

    const id = ++this.requestSeq;
    const payload = JSON.stringify({ id, method, params });
    const response = new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeout
      });
    });

    this.backendWs.send(payload);
    return response;
  }

  private handleBackendMessage(raw: string): void {
    let message: Partial<RpcResponseMessage & RpcEventMessage>;
    try {
      message = JSON.parse(raw) as Partial<RpcResponseMessage & RpcEventMessage>;
    } catch (error) {
      this.notifyHostError(error);
      return;
    }

    if (typeof message.id === 'number') {
      this.handleRpcResponse(message as RpcResponseMessage);
      return;
    }

    if (message.event) this.handleBackendEvent(message as RpcEventMessage);
  }

  private handleRpcResponse(message: RpcResponseMessage): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;

    window.clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || `${TOOL_NAME} request failed`));
    }
  }

  private handleBackendEvent(message: RpcEventMessage): void {
    if (message.event === 'ready') {
      this.backendStatus = 'ready';
      this.backendPid = Number(message.data?.['pid'] || this.backendPid || 0);
      this.notifyHostReady();
      return;
    }

    this.pushLog('event', message.event, JSON.stringify(message.data || {}));
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private pushLog(type: string, label: string, detail = ''): void {
    this.logs = [{
      id: ++this.logSeq,
      type,
      label,
      detail,
      time: new Date().toLocaleTimeString()
    }, ...this.logs].slice(0, 80);
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message || String(error);
    return String(error || '');
  }
}
