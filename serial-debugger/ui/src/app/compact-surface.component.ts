import {
  AfterViewChecked,
  Component,
  ElementRef,
  effect,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';

import {
  SerialRuntimeStore,
  type CompactLogItem,
  type SerialPortInfo,
} from './serial-runtime-store.service';

type ThemeName = 'dark' | 'light';

interface CompactHostContext {
  lang?: string;
  theme?: ThemeName;
  surface?: string;
  placement?: string;
  density?: string;
  interactive?: boolean;
}

interface CompactHostRemote {
  getHostContext?: () => Promise<CompactHostContext | null> | CompactHostContext | null;
  childReady?: (data: Record<string, unknown>) => void;
  childError?: (data: Record<string, unknown>) => void;
  reportActivity?: (data: Record<string, string>) => Promise<unknown> | unknown;
}

const SERIAL_NAMESPACE = 'SERIAL_DEBUGGER';

@Component({
  selector: 'app-compact-surface',
  imports: [CommonModule, FormsModule],
  templateUrl: './compact-surface.component.html',
  styleUrl: './compact-surface.component.scss',
})
export class CompactSurfaceComponent implements OnInit, AfterViewChecked, OnDestroy {
  @ViewChild('compactLog') compactLog?: ElementRef<HTMLElement>;

  readonly baudRates = [9600, 19200, 38400, 57600, 115200, 230400, 460800, 921600];
  selectedPort = '';
  selectedBaudRate = 115200;
  operationError = '';
  hostContext: CompactHostContext = {
    lang: 'en',
    theme: 'dark',
    surface: 'compact',
    placement: 'chat-dock',
    density: 'compact',
    interactive: true,
  };

  private token = '';
  private hostRemote: CompactHostRemote | null = null;
  private readonly actorId = `compact-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  private i18n: Record<string, string> = {};
  private needsTailScroll = false;
  private activityReportTimer: number | null = null;

  constructor(readonly store: SerialRuntimeStore) {
    effect(() => {
      this.store.connectionState();
      this.store.connected();
      this.store.portPath();
      this.store.baudRate();
      this.store.agentControlled();
      this.store.analysisRunning();
      this.store.scenarioActive();
      this.store.rxBytes();
      this.scheduleActivityReport();
    });
  }

  ngOnInit(): void {
    const query = new URLSearchParams(window.location.search);
    this.token = query.get('token') || '';
    this.hostContext = {
      ...this.hostContext,
      lang: this.normalizeLang(query.get('lang') || navigator.language || 'en'),
      surface: query.get('surface') || 'compact',
      placement: query.get('placement') || 'chat-dock',
      density: query.get('density') || 'compact',
    };
    this.applyTheme(this.hostContext.theme || 'dark');
    void this.bootstrap();
  }

  ngAfterViewChecked(): void {
    if (!this.needsTailScroll || !this.compactLog) return;
    const element = this.compactLog.nativeElement;
    element.scrollTop = element.scrollHeight;
    this.needsTailScroll = false;
  }

  ngOnDestroy(): void {
    if (this.activityReportTimer !== null) {
      window.clearTimeout(this.activityReportTimer);
      this.activityReportTimer = null;
    }
    this.store.close();
  }

  t(key: string, fallback = key): string {
    return this.i18n[key] || fallback;
  }

  get ports(): readonly SerialPortInfo[] {
    return this.store.ports();
  }

  get logs(): readonly CompactLogItem[] {
    this.needsTailScroll = true;
    return this.store.logs();
  }

  get connectionLabel(): string {
    if (this.store.busy()) return this.t('CONNECTING', 'Connecting');
    return this.store.connected()
      ? this.t('CONNECTED', 'Connected')
      : this.t('DISCONNECTED', 'Disconnected');
  }

  get controlsDisabled(): boolean {
    return this.store.connectionState() !== 'ready'
      || this.store.busy()
      || this.store.scenarioActive();
  }

  async toggleConnection(): Promise<void> {
    this.operationError = '';
    try {
      if (this.store.connected()) {
        await this.store.closeSession();
        return;
      }
      if (!this.selectedPort) {
        this.operationError = this.t('SELECT_PORT_FIRST', 'Please select a serial port first');
        return;
      }
      await this.store.openSession(this.selectedPort, Number(this.selectedBaudRate));
    } catch (error) {
      this.operationError = this.errorText(error);
    }
  }

  async refreshPorts(): Promise<void> {
    this.operationError = '';
    try {
      await this.store.refreshPorts();
    } catch (error) {
      this.operationError = this.errorText(error);
    }
  }

  portLabel(port: SerialPortInfo): string {
    return port.name && port.name !== port.path ? `${port.name} · ${port.path}` : port.path;
  }

  formatBytes(value: number): string {
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  }

  formatTime(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  trackLog(_index: number, item: CompactLogItem): number {
    return item.seq;
  }

  private async bootstrap(): Promise<void> {
    try {
      await this.connectHost();
      await this.loadI18n(this.hostContext.lang || 'en');
      await this.store.connect(this.token, this.actorId);
      this.selectedPort = this.store.portPath() || this.ports[0]?.path || '';
      this.selectedBaudRate = this.store.baudRate();
      this.notifyHostReady();
    } catch (error) {
      this.operationError = this.errorText(error);
      this.notifyHostError(error);
    }
  }

  private async connectHost(): Promise<void> {
    const penpal = (window as any).Penpal;
    if (!penpal || !window.parent || window.parent === window) return;

    const messenger = new penpal.WindowMessenger({
      remoteWindow: window.parent,
      allowedOrigins: ['*'],
    });
    const connection = penpal.connect({
      messenger,
      methods: {
        setHostContext: async (context: CompactHostContext = {}) => {
          await this.applyHostContext(context);
          return { ok: true };
        },
        refreshHostSnapshot: async () => {
          await this.store.refreshSnapshot(true);
          return { ok: true };
        },
        focusTool: () => {
          window.focus();
          return { ok: true };
        },
        beforeClose: () => ({
          canClose: true,
          connected: this.store.connected(),
          observesRuntime: true,
        }),
      },
    });
    const remote = await connection.promise as CompactHostRemote;
    this.hostRemote = remote;
    if (typeof remote.getHostContext === 'function') {
      const context = await remote.getHostContext();
      if (context) await this.applyHostContext(context);
    }
    this.scheduleActivityReport();
  }

  private async applyHostContext(context: CompactHostContext): Promise<void> {
    this.hostContext = {
      ...this.hostContext,
      ...context,
      lang: this.normalizeLang(context.lang || this.hostContext.lang || 'en'),
      theme: this.normalizeTheme(context.theme || this.hostContext.theme),
    };
    document.documentElement.lang = this.hostContext.lang || 'en';
    this.applyTheme(this.hostContext.theme || 'dark');
    await this.loadI18n(this.hostContext.lang || 'en');
  }

  private notifyHostReady(): void {
    this.hostRemote?.childReady?.({
      surface: 'compact',
      backendStatus: this.store.connectionState(),
      connected: this.store.connected(),
      portPath: this.store.portPath(),
      observesRuntime: true,
      tailLimit: 200,
      rowLimit: 500,
    });
  }

  private notifyHostError(error: unknown): void {
    this.hostRemote?.childError?.({
      surface: 'compact',
      message: this.errorText(error),
    });
  }

  private scheduleActivityReport(): void {
    if (this.activityReportTimer !== null) return;
    this.activityReportTimer = window.setTimeout(() => {
      this.activityReportTimer = null;
      const remote = this.hostRemote;
      if (typeof remote?.reportActivity !== 'function') return;

      const connected = this.store.connected();
      const state = this.store.connectionState() === 'error'
        ? 'error'
        : connected || this.store.analysisRunning() || this.store.scenarioActive()
          ? 'active'
          : 'idle';
      const label = connected
        ? `${this.store.portPath()} · ${this.store.baudRate()}`
        : this.t('TITLE', 'Serial Debugger');
      const detail = this.store.analysisRunning()
        ? this.t('ANALYSIS_RUNNING', 'Analysis running')
        : this.store.scenarioActive()
          ? this.t('SCENARIO_RUNNING', 'Scenario running')
          : this.store.agentControlled()
            ? this.t('AGENT_CONTROLLED', 'Agent controlled')
            : connected
              ? this.t('CONNECTED', 'Connected')
              : this.t('DISCONNECTED', 'Disconnected');
      void Promise.resolve(remote.reportActivity({
        state,
        label,
        detail,
        badge: `RX ${this.formatBytes(this.store.rxBytes())}`,
      })).catch(() => undefined);
    }, 500);
  }

  private async loadI18n(lang: string): Promise<void> {
    const normalized = this.normalizeLang(lang);
    const candidates = normalized === 'en' ? ['en'] : [normalized, 'en'];
    for (const candidate of candidates) {
      try {
        const response = await fetch(`/i18n/${candidate}.json`, { cache: 'no-store' });
        if (!response.ok) continue;
        const data = await response.json() as Record<string, Record<string, string>>;
        this.i18n = data[SERIAL_NAMESPACE] || {};
        document.title = `${this.t('TITLE', 'Serial Debugger')} · Compact`;
        return;
      } catch {
        // Try the fallback language.
      }
    }
  }

  private applyTheme(theme: ThemeName): void {
    document.documentElement.dataset['theme'] = theme;
    document.documentElement.style.colorScheme = theme;
  }

  private normalizeLang(lang: string): string {
    const normalized = String(lang || 'en').trim().toLowerCase().replace(/-/g, '_');
    if (normalized === 'zh' || normalized.startsWith('zh_cn')) return 'zh_cn';
    if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
    return normalized || 'en';
  }

  private normalizeTheme(theme?: string): ThemeName {
    return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'Serial Runtime error');
  }
}
