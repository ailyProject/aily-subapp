import {
  AfterViewChecked,
  ChangeDetectorRef,
  Component,
  ElementRef,
  inject,
  OnDestroy,
  OnInit,
  ViewChild
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { CompactSurfaceComponent } from './compact-surface.component';

type ThemeName = 'dark' | 'light';
type DataDirection = 'TX' | 'RX' | 'SYS';
type QuickSendType = 'signal' | 'text' | 'hex';

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

declare global {
  interface Window {
    Penpal?: PenpalApi;
  }
}

interface SerialPortInfo {
  path: string;
  name?: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  pnpId?: string;
  locationId?: string;
}

interface SerialSignals {
  dtr: boolean;
  rts: boolean;
  brk: boolean;
}

interface SerialStatus {
  connected: boolean;
  portPath: string;
  rxBytes: number;
  txBytes: number;
  connectedAt: number;
  pid: number;
  signals: Partial<SerialSignals>;
  owner?: {
    actor?: string;
    actorId?: string;
  } | null;
  lastError?: {
    code?: string;
    message?: string;
    details?: Record<string, unknown>;
    timestamp?: number;
  } | null;
}

interface SerialPayload {
  hex: string;
  text: string;
  byteLength: number;
  portPath: string;
  rxBytes?: number;
  txBytes?: number;
  timestamp: number;
}

interface DataItem {
  id: number;
  time: string;
  data: string;
  hex: string;
  dir: DataDirection;
  byteLength: number;
  firstAt: number;
  lastAt: number;
  isError?: boolean;
  searchHighlight?: boolean;
  showHex?: boolean;
  highlight?: boolean;
  actor?: string;
}

interface QuickSendItem {
  name: string;
  type: QuickSendType;
  data: string;
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
  errorCode?: string;
  details?: unknown;
}

interface RpcEventMessage {
  event: string;
  data?: unknown;
  seq?: number;
  timestamp?: number;
  sessionId?: string;
  actor?: string;
  actorId?: string;
}

interface RuntimeSnapshot {
  protocolVersion: number;
  sessionId: string;
  state: SerialStatus;
  eventStore: {
    firstSeq: number;
    lastSeq: number;
    droppedBeforeSeq: number;
  };
  journal?: {
    enabled: boolean;
    rootDir?: string;
    recordedBytes?: number;
    droppedBytes?: number;
    writeBlocked?: boolean;
    health?: {
      state?: string;
      code?: string;
      message?: string;
      freeBytes?: number;
      totalBytes?: number;
    };
    artifacts?: RuntimeArtifact[];
  };
  scenario?: ScenarioControlStatus;
}

type ScenarioControlState =
  | 'running'
  | 'pausing'
  | 'paused'
  | 'takeover_pending'
  | 'taken_over'
  | 'cancelling'
  | 'completed'
  | 'failed'
  | 'cancelled';

interface ActorIdentity {
  actor: string;
  actorId: string;
}

interface ScenarioControlSummary {
  scenarioId: string;
  name: string;
  state: ScenarioControlState;
  owner?: ActorIdentity | null;
  takeoverOwner?: ActorIdentity | null;
  reason?: string;
  stepCount?: number;
  completedSteps?: number;
  currentStep?: {
    stepId?: string;
    index?: number;
    action?: string;
    name?: string;
  } | null;
  pausedDurationMs?: number;
}

interface ScenarioControlStatus {
  active: boolean;
  scenario: ScenarioControlSummary | null;
  lastScenario?: ScenarioControlSummary | null;
}

interface RuntimeArtifact {
  artifactId: string;
  type: string;
  size: number;
}

interface PersistedSearchMatch {
  artifactId: string;
  line: number;
  offset: number;
  text: string;
  truncated?: boolean;
}

interface ArtifactSearchResult {
  matches?: Array<Omit<PersistedSearchMatch, 'artifactId'>>;
}

interface RuntimeLogPage {
  count: number;
  hasMore: boolean;
  nextAfterSeq: number;
  events: RpcEventMessage[];
}

interface ChartPoint {
  x: number;
  value: number;
}

interface SelectItem<T = string | number> {
  name: string;
  value: T;
}

const SERIAL_NAMESPACE = 'SERIAL_DEBUGGER';
const CONFIG_KEY = 'serial-debugger.monitor.config';
const QUICK_SEND_KEY = 'serial-debugger.quick-send-list';
const MAX_DATA_SIZE = 100000;
const TRIM_TARGET_SIZE = 90000;
const RX_NEW_ITEM_GAP_MS = 1000;
const RX_MAX_ITEM_SPAN_MS = 10000;

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule, CompactSurfaceComponent],
  templateUrl: './app.html',
  styleUrl: './app.scss'
})
export class App implements OnInit, OnDestroy, AfterViewChecked {
  private readonly changeDetectorRef = inject(ChangeDetectorRef);
  readonly isCompactSurface = new URLSearchParams(window.location.search).get('surface') === 'compact';
  @ViewChild('dataListBox') private dataListBox?: ElementRef<HTMLDivElement>;
  @ViewChild('chartCanvas') private chartCanvas?: ElementRef<HTMLCanvasElement>;

  readonly baudList: SelectItem<number>[] = [
    { name: '4800', value: 4800 },
    { name: '9600', value: 9600 },
    { name: '19200', value: 19200 },
    { name: '38400', value: 38400 },
    { name: '57600', value: 57600 },
    { name: '115200', value: 115200 },
    { name: '230400', value: 230400 },
    { name: '460800', value: 460800 },
    { name: '921600', value: 921600 },
    { name: '1000000', value: 1000000 },
    { name: '2000000', value: 2000000 },
    { name: '3000000', value: 3000000 },
    { name: '4000000', value: 4000000 }
  ];
  readonly dataBitsList: SelectItem<number>[] = [
    { name: '5', value: 5 },
    { name: '6', value: 6 },
    { name: '7', value: 7 },
    { name: '8', value: 8 }
  ];
  readonly stopBitsList: SelectItem<number>[] = [
    { name: '1', value: 1 },
    { name: '1.5', value: 1.5 },
    { name: '2', value: 2 }
  ];
  readonly parityList: SelectItem[] = [
    { name: 'None', value: 'none' },
    { name: 'Odd', value: 'odd' },
    { name: 'Even', value: 'even' },
    { name: 'Mark', value: 'mark' },
    { name: 'Space', value: 'space' }
  ];
  readonly flowControlList: SelectItem[] = [
    { name: 'None', value: 'none' },
    { name: 'RTS/CTS', value: 'hardware' },
    { name: 'XON/XOFF', value: 'software' }
  ];

  hostContext: HostContext = {
    lang: 'en',
    theme: 'dark',
    platform: 'browser'
  };
  i18n: Record<string, string> = {};
  token = '';
  backendStatus = 'connecting';
  backendPid = 0;
  ports: SerialPortInfo[] = [];
  portList: SerialPortInfo[] = [];
  currentPort = '';
  currentBaudRate = '115200';
  connectedPort: string | null = null;
  switchValue = false;
  connecting = false;
  loadingPorts = false;
  showPortList = false;
  showBaudList = false;
  showMoreSettings = false;
  showSearchBox = false;
  showQuickSendEditor = false;
  showChartBox = false;
  showContextMenu = false;
  contextMenuPosition = { x: 0, y: 0 };
  contextMenuItem: DataItem | null = null;
  bottomHeight = 210;

  dataBits = '8';
  stopBits = '1';
  parity = 'none';
  flowControl = 'none';

  viewMode = {
    showHex: false,
    showCtrlChar: false,
    autoWrap: true,
    autoScroll: true,
    showTimestamp: true
  };

  inputMode = {
    hexMode: false,
    sendByEnter: false,
    endR: true,
    endN: true
  };

  inputValue = '';
  dataList: DataItem[] = [];
  quickSendList: QuickSendItem[] = [];
  quickSendEditorValue = '';
  quickSendEditorError = '';
  sendHistoryList: string[] = [];
  searchKeyword = '';
  searchResults: number[] = [];
  currentSearchIndex = -1;
  rxBytes = 0;
  txBytes = 0;
  signals: SerialSignals = {
    dtr: false,
    rts: false,
    brk: false
  };
  agentControlled = false;
  historyRestored = 0;
  journalEnabled = false;
  journalRoot = '';
  journalArtifactCount = 0;
  journalArtifacts: RuntimeArtifact[] = [];
  journalHealthState = 'ok';
  journalHealthMessage = '';
  persistedSearchResults: PersistedSearchMatch[] = [];
  persistedSearchLoading = false;
  persistedSearchError = '';
  activeScenarioName = '';
  scenarioControl: ScenarioControlStatus = { active: false, scenario: null };
  scenarioControlBusy = false;
  analysisRunning = false;

  private backendWs: WebSocket | null = null;
  private hostRemote: HostRemote | null = null;
  private requestSeq = 0;
  private logSeq = 0;
  private pendingRequests = new Map<number, PendingRequest>();
  private needsScroll = false;
  private needsChartDraw = false;
  private userFollowingTail = true;
  private chartBuffer = '';
  private chartSeries = new Map<number, ChartPoint[]>();
  private chartIndex = 0;
  private resizeCleanup: (() => void) | null = null;
  private runtimeSessionId = '';
  private readonly uiActorId = typeof globalThis.crypto?.randomUUID === 'function'
    ? `ui-${globalThis.crypto.randomUUID()}`
    : `ui-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  private lastEventSeq = 0;
  private hydratingHistory = true;
  private bufferedRuntimeEvents: RpcEventMessage[] = [];

  get isConnected(): boolean {
    return this.switchValue && Boolean(this.connectedPort);
  }

  get windowInfo(): string {
    return this.currentPort
      ? `${this.t('TITLE', 'Serial Debugger')} (${this.currentPort} - ${this.currentBaudRate})`
      : this.t('TITLE', 'Serial Debugger');
  }

  get selectedPortLabel(): string {
    return this.currentPort || this.t('SELECT_PORT', 'Select port');
  }

  get filteredSearchStatus(): string {
    if (!this.searchKeyword) return '';
    if (!this.searchResults.length) return '0/0';
    return `${this.currentSearchIndex + 1}/${this.searchResults.length}`;
  }

  get hasChartData(): boolean {
    return this.chartSeries.size > 0;
  }

  get scenarioState(): ScenarioControlState | '' {
    return this.scenarioControl.scenario?.state || '';
  }

  get scenarioActive(): boolean {
    return this.scenarioControl.active === true && Boolean(this.scenarioControl.scenario);
  }

  get uiHasManualControl(): boolean {
    const scenario = this.scenarioControl.scenario;
    return scenario?.state === 'taken_over'
      && scenario.takeoverOwner?.actor === 'ui'
      && scenario.takeoverOwner.actorId === this.uiActorId;
  }

  get manualSerialControlAllowed(): boolean {
    return !this.scenarioActive || this.uiHasManualControl;
  }

  get scenarioStateLabel(): string {
    switch (this.scenarioState) {
      case 'pausing':
        return this.t('SCENARIO_PAUSING', 'Pausing at safe boundary');
      case 'paused':
        return this.t('SCENARIO_PAUSED', 'Scenario paused');
      case 'takeover_pending':
        return this.t('SCENARIO_TAKEOVER_PENDING', 'Manual takeover pending');
      case 'taken_over':
        return this.uiHasManualControl
          ? this.t('SCENARIO_TAKEN_OVER', 'Manual control')
          : this.t('SCENARIO_TAKEN_OVER_OTHER', 'Controlled by another client');
      case 'cancelling':
        return this.t('SCENARIO_CANCELLING', 'Cancelling');
      default:
        return this.t('SCENARIO_RUNNING', 'Scenario running');
    }
  }

  ngOnInit(): void {
    if (this.isCompactSurface) return;
    const query = new URLSearchParams(window.location.search);
    this.token = query.get('token') || '';
    this.hostContext = {
      lang: this.normalizeLang(query.get('lang') || navigator.language || 'en'),
      theme: 'dark',
      platform: 'browser'
    };

    void this.bootstrap().finally(() => this.scheduleRender());
  }

  private async bootstrap(): Promise<void> {
    document.documentElement.lang = this.hostContext.lang;
    await this.connectHost();
    this.applyTheme(this.hostContext.theme);
    this.loadSavedConfig();
    this.loadQuickSendList();
    void this.loadI18n(this.hostContext.lang);
    this.connectBackend();
  }

  ngAfterViewChecked(): void {
    if (this.isCompactSurface) return;
    if (this.needsScroll && this.viewMode.autoScroll && this.userFollowingTail && this.dataListBox) {
      const element = this.dataListBox.nativeElement;
      element.scrollTop = element.scrollHeight;
      this.needsScroll = false;
    }

    if (this.needsChartDraw) {
      this.needsChartDraw = false;
      this.drawChart();
    }
  }

  ngOnDestroy(): void {
    this.closeBackend();
    this.resizeCleanup?.();
  }

  t(key: string, fallback = key): string {
    return this.i18n[key] || fallback;
  }

  portLabel(port: SerialPortInfo): string {
    const name = port.name && port.name !== port.path ? ` - ${port.name}` : '';
    return `${port.path}${name}`;
  }

  portMeta(port: SerialPortInfo): string {
    return [
      port.manufacturer,
      port.vendorId && port.productId ? `${port.vendorId}:${port.productId}` : '',
      port.serialNumber
    ].filter(Boolean).join(' / ');
  }

  optionLabel(prefix: string, item: SelectItem): string {
    return this.t(`${prefix}${String(item.value).toUpperCase()}`, item.name);
  }

  async openPortList(): Promise<void> {
    this.showBaudList = false;
    this.showPortList = !this.showPortList;
    if (this.showPortList) await this.refreshPorts();
  }

  selectPort(port: SerialPortInfo): void {
    this.currentPort = port.path;
    this.showPortList = false;
    this.saveSerialConfig();
  }

  openBaudList(): void {
    this.showPortList = false;
    this.showBaudList = !this.showBaudList;
  }

  selectBaud(item: SelectItem<number>): void {
    this.currentBaudRate = String(item.value);
    this.showBaudList = false;
    this.saveSerialConfig();
  }

  async refreshPorts(): Promise<void> {
    this.loadingPorts = true;
    try {
      const result = await this.request<{ ports?: SerialPortInfo[] }>('serial.list', {}, 15000);
      this.ports = result.ports || [];
      this.portList = this.ports;
      if (!this.currentPort && this.ports.length === 1) {
        this.currentPort = this.ports[0].path;
      }
    } catch (error) {
      this.pushSystem(this.t('PORTS_FAILED', 'Failed to refresh ports'), this.errorMessage(error), true);
      this.notifyHostError(error);
    } finally {
      this.loadingPorts = false;
    }
  }

  async switchPort(): Promise<void> {
    if (this.connecting) return;
    if (!this.manualSerialControlAllowed) {
      this.pushSystem(
        this.t('SCENARIO_CONTROL_REQUIRED', 'Take over the active scenario before changing the port'),
        this.scenarioStateLabel,
        true
      );
      return;
    }

    if (this.switchValue) {
      await this.disconnectSerial(true);
      return;
    }

    if (!this.currentPort) {
      this.pushSystem(this.t('SELECT_PORT_FIRST', 'Please select a serial port first'), '', true);
      return;
    }

    this.switchValue = true;
    this.connecting = true;
    try {
      const status = await this.request<SerialStatus>('serial.connect', this.getConnectOptions(), 30000);
      this.applyStatus(status);
      this.connectedPort = this.currentPort;
      this.saveSerialConfig();
    } catch (error) {
      this.connectedPort = null;
      this.switchValue = false;
      this.pushSystem(this.t('HOST_CONNECTION_FAILED', 'Host connection failed'), this.errorMessage(error), true);
      this.notifyHostError(error);
    } finally {
      this.connecting = false;
    }
  }

  async disconnectSerial(showMessage = false): Promise<void> {
    if (!this.manualSerialControlAllowed) return;
    try {
      const status = await this.request<SerialStatus>('serial.disconnect', {}, 15000);
      this.applyStatus(status);
      this.connectedPort = null;
      this.switchValue = false;
      if (showMessage) this.pushSystem(this.t('PORT_CLOSED', 'Serial port closed'));
    } catch (error) {
      this.pushSystem(this.t('PORT_CLOSED', 'Serial port closed'), this.errorMessage(error), true);
    }
  }

  changeViewMode(name: keyof App['viewMode']): void {
    this.viewMode[name] = !this.viewMode[name];
    if (name === 'autoScroll' && this.viewMode.autoScroll) {
      this.userFollowingTail = true;
      this.needsScroll = true;
    }
  }

  changeInputMode(name: keyof App['inputMode']): void {
    this.inputMode[name] = !this.inputMode[name];
  }

  async applyAdvancedSettings(): Promise<void> {
    this.saveSerialConfig();
    if (!this.isConnected) return;

    await this.disconnectSerial();
    window.setTimeout(() => {
      void this.switchPort();
    }, 300);
  }

  async send(data?: string): Promise<void> {
    const fromTextarea = arguments.length === 0;
    const payload = fromTextarea ? this.inputValue : String(data ?? '');
    if (!payload) return;

    const ok = await this.writePayload({
      data: payload,
      mode: this.inputMode.hexMode ? 'hex' : 'text',
      appendCr: !this.inputMode.hexMode && this.inputMode.endR,
      appendLf: !this.inputMode.hexMode && this.inputMode.endN
    });

    if (ok && payload.trim()) this.addHistory(payload);
    if (ok && fromTextarea) this.inputValue = '';
  }

  async controlScenario(
    action: 'pause' | 'resume' | 'takeover' | 'release' | 'cancel'
  ): Promise<void> {
    if (this.scenarioControlBusy) return;
    this.scenarioControlBusy = true;
    try {
      const status = await this.request<ScenarioControlStatus>('serial.scenario.control', {
        action,
        ...(this.scenarioControl.scenario?.scenarioId
          ? { scenarioId: this.scenarioControl.scenario.scenarioId }
          : {})
      }, 30000);
      this.applyScenarioControl(status);
    } catch (error) {
      this.pushSystem(
        this.t('SCENARIO_CONTROL_FAILED', 'Scenario control failed'),
        this.errorMessage(error),
        true
      );
    } finally {
      this.scenarioControlBusy = false;
    }
  }

  onKeyDown(event: KeyboardEvent): void {
    if (this.inputMode.sendByEnter) {
      if (event.key === 'Enter') {
        event.preventDefault();
        void this.send();
      }
      return;
    }

    if (event.ctrlKey && event.key === 'Enter') {
      event.preventDefault();
      void this.send();
    }
  }

  async sendQuick(item: QuickSendItem): Promise<void> {
    if (item.type === 'signal') {
      await this.sendSignal(item.data);
      return;
    }

    const ok = await this.writePayload({
      data: item.data,
      mode: item.type,
      appendCr: false,
      appendLf: false
    });
    if (ok) this.addHistory(item.data);
  }

  openQuickSendEditor(): void {
    this.showQuickSendEditor = !this.showQuickSendEditor;
    this.quickSendEditorError = '';
    this.quickSendEditorValue = JSON.stringify(this.quickSendList, null, 2);
  }

  saveQuickSendEditor(): void {
    try {
      const data = JSON.parse(this.quickSendEditorValue) as unknown;
      if (!this.isQuickSendList(data)) {
        throw new Error('Invalid quick send item list.');
      }
      this.quickSendList = data;
      localStorage.setItem(QUICK_SEND_KEY, JSON.stringify(this.quickSendList));
      this.showQuickSendEditor = false;
      this.quickSendEditorError = '';
    } catch (error) {
      this.quickSendEditorError = this.errorMessage(error) || 'Invalid JSON';
    }
  }

  clearView(): void {
    this.dataList = [];
    this.chartSeries.clear();
    this.chartBuffer = '';
    this.chartIndex = 0;
    this.searchResults = [];
    this.currentSearchIndex = -1;
    this.persistedSearchResults = [];
    this.persistedSearchError = '';
    this.userFollowingTail = true;
    this.needsChartDraw = true;
  }

  exportData(): void {
    if (!this.dataList.length) return;

    const text = this.dataList.map(item => {
      const prefix = this.viewMode.showTimestamp ? `[${item.time}] ${item.dir} ` : '';
      return `${prefix}${this.renderDataText(item)}`;
    }).join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `log_${new Date().toISOString().replace(/[:.]/g, '_')}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }

  openSearchBox(): void {
    this.showSearchBox = !this.showSearchBox;
    if (!this.showSearchBox) this.keywordChange('');
  }

  keywordChange(keyword: string, resetPersisted = true): void {
    this.searchKeyword = keyword;
    this.searchResults = [];
    this.currentSearchIndex = -1;
    if (resetPersisted) {
      this.persistedSearchResults = [];
      this.persistedSearchError = '';
    }
    for (const item of this.dataList) item.searchHighlight = false;

    const normalized = keyword.trim().toLowerCase();
    if (!normalized) return;

    this.dataList.forEach((item, index) => {
      if (item.data.toLowerCase().includes(normalized) || item.hex.toLowerCase().includes(normalized)) {
        this.searchResults.push(index);
      }
    });
    if (this.searchResults.length) this.navigateToResult(0);
  }

  async searchPersistedHistory(): Promise<void> {
    const query = this.searchKeyword.trim();
    if (!query || this.persistedSearchLoading) return;

    this.persistedSearchLoading = true;
    this.persistedSearchResults = [];
    this.persistedSearchError = '';
    try {
      const snapshot = await this.request<RuntimeSnapshot>('runtime.snapshot');
      this.applyJournalSnapshot(snapshot);
      const artifacts = [...this.journalArtifacts]
        .filter(artifact => artifact.type === 'serial-rx-text' || artifact.type === 'serial-journal')
        .sort((left, right) => {
          const typeOrder = Number(right.type === 'serial-rx-text') - Number(left.type === 'serial-rx-text');
          if (typeOrder) return typeOrder;
          return right.artifactId.localeCompare(left.artifactId, undefined, { numeric: true });
        })
        .slice(0, 8);

      for (const artifact of artifacts) {
        const remaining = 20 - this.persistedSearchResults.length;
        if (remaining <= 0) break;
        const result = await this.request<ArtifactSearchResult>('serial.artifact.search', {
          artifactId: artifact.artifactId,
          query,
          limit: remaining,
          maxScanBytes: 16 * 1024 * 1024
        }, 30000);
        for (const match of result.matches || []) {
          this.persistedSearchResults.push({
            artifactId: artifact.artifactId,
            ...match
          });
        }
      }

      if (!this.persistedSearchResults.length) {
        this.persistedSearchError = this.t('JOURNAL_SEARCH_EMPTY', 'No persisted matches');
      }
    } catch (error) {
      this.persistedSearchError = `${this.t('ERROR', 'Error')}: ${this.errorMessage(error)}`;
    } finally {
      this.persistedSearchLoading = false;
    }
  }

  selectPersistedSearchResult(match: PersistedSearchMatch): void {
    const location = `${match.artifactId}:${match.line}`;
    this.pushSystem(
      this.t('JOURNAL_SEARCH', 'Search Journal'),
      `${location} · ${match.text}${match.truncated ? '…' : ''}`
    );
  }

  navigatePrev(): void {
    this.navigateToResult(this.currentSearchIndex - 1);
  }

  navigateNext(): void {
    this.navigateToResult(this.currentSearchIndex + 1);
  }

  navigateToResult(index: number): void {
    if (!this.searchResults.length) return;
    if (index < 0) index = this.searchResults.length - 1;
    if (index >= this.searchResults.length) index = 0;

    this.currentSearchIndex = index;
    const dataIndex = this.searchResults[index];
    this.dataList.forEach((item, idx) => {
      item.searchHighlight = idx === dataIndex;
    });
    window.setTimeout(() => {
      const el = this.dataListBox?.nativeElement.querySelector(`[data-row-index="${dataIndex}"]`);
      el?.scrollIntoView({ block: 'center' });
    });
  }

  onDataListScroll(): void {
    const el = this.dataListBox?.nativeElement;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
    if (distanceFromBottom >= 100) this.userFollowingTail = false;
    if (distanceFromBottom <= 40) this.userFollowingTail = true;
  }

  onDataItemContextMenu(event: MouseEvent, item: DataItem): void {
    if (!this.viewMode.showTimestamp) return;
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuPosition = { x: event.clientX, y: event.clientY };
    this.contextMenuItem = item;
    this.viewMode.autoScroll = false;
    this.showContextMenu = true;
  }

  closeContextMenu(): void {
    this.showContextMenu = false;
    this.contextMenuItem = null;
  }

  copyContextItem(): void {
    if (!this.contextMenuItem) return;
    void navigator.clipboard.writeText(this.renderDataText(this.contextMenuItem));
    this.closeContextMenu();
  }

  toggleContextHex(): void {
    if (!this.contextMenuItem) return;
    this.contextMenuItem.showHex = !this.contextMenuItem.showHex;
    this.closeContextMenu();
  }

  toggleContextHighlight(): void {
    if (!this.contextMenuItem) return;
    this.contextMenuItem.highlight = !this.contextMenuItem.highlight;
    this.closeContextMenu();
  }

  openChartBox(): void {
    this.showChartBox = !this.showChartBox;
    if (this.showChartBox) {
      window.setTimeout(() => {
        this.needsChartDraw = true;
        this.drawChart();
      }, 50);
    }
  }

  startSenderResize(event: PointerEvent): void {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = this.bottomHeight;
    const onMove = (moveEvent: PointerEvent) => {
      const next = startHeight - (moveEvent.clientY - startY);
      this.bottomHeight = Math.min(600, Math.max(210, next));
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.resizeCleanup = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    this.resizeCleanup = onUp;
  }

  renderDataText(item: DataItem): string {
    if (this.viewMode.showHex || item.showHex) return item.hex;
    if (this.viewMode.showCtrlChar) return this.showControlChars(item.data);
    return item.data;
  }

  private getConnectOptions(): Record<string, unknown> {
    return {
      portPath: this.currentPort,
      baudRate: Number(this.currentBaudRate) || 115200,
      dataBits: Number(this.dataBits) || 8,
      stopBits: Number(this.stopBits) || 1,
      parity: this.parity,
      flowControl: this.flowControl
    };
  }

  private async writePayload(options: {
    data: string;
    mode: 'text' | 'hex';
    appendCr: boolean;
    appendLf: boolean;
  }): Promise<boolean> {
    if (!this.isConnected) {
      this.pushSystem(this.t('DISCONNECTED', 'Disconnected'), '', true);
      return false;
    }
    if (!this.manualSerialControlAllowed) {
      this.pushSystem(
        this.t('SCENARIO_CONTROL_REQUIRED', 'Take over the active scenario before sending manually'),
        this.scenarioStateLabel,
        true
      );
      return false;
    }

    try {
      await this.request<SerialPayload>('serial.write', {
        mode: options.mode,
        data: options.data,
        appendCr: options.appendCr,
        appendLf: options.appendLf
      }, 15000);
      return true;
    } catch (error) {
      this.pushSystem(this.t('SEND_FAILED', 'Send failed'), this.errorMessage(error), true);
      return false;
    }
  }

  private async sendSignal(signalType: string): Promise<boolean> {
    if (!this.isConnected) {
      this.pushSystem(this.t('DISCONNECTED', 'Disconnected'), '', true);
      return false;
    }
    if (!this.manualSerialControlAllowed) {
      this.pushSystem(
        this.t('SCENARIO_CONTROL_REQUIRED', 'Take over the active scenario before changing signals'),
        this.scenarioStateLabel,
        true
      );
      return false;
    }

    const signal = signalType.toLowerCase();
    try {
      const result = await this.request<{ signals?: Partial<SerialSignals> }>('serial.signal', { signal }, 15000);
      if (result.signals) this.signals = { ...this.signals, ...result.signals };
      return true;
    } catch (error) {
      this.pushSystem(this.t('SIGNAL_FAILED', 'Signal failed'), this.errorMessage(error), true);
      return false;
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
        this.i18n = data[SERIAL_NAMESPACE] || {};
        document.title = this.t('TITLE', 'Serial Debugger');
        this.scheduleRender();
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
          void this.applyHostContext(context).finally(() => this.scheduleRender());
          return { ok: true };
        },
        focusTool: () => {
          window.focus();
          return { ok: true };
        },
        beforeClose: () => ({
          canClose: true,
          connected: this.isConnected
        })
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
      this.pushSystem(this.t('HOST_CONNECTION_FAILED', 'Host connection failed'), this.errorMessage(error), true);
    } finally {
      this.scheduleRender();
    }
  }

  private notifyHostReady(): void {
    if (typeof this.hostRemote?.childReady !== 'function') return;
    this.hostRemote.childReady({
      backendStatus: this.backendStatus,
      connected: this.isConnected,
      portPath: this.connectedPort || '',
      pid: this.backendPid
    });
  }

  private notifyHostError(error: unknown): void {
    if (typeof this.hostRemote?.childError !== 'function') return;
    this.hostRemote.childError({ message: this.errorMessage(error) });
  }

  private connectBackend(): void {
    this.closeBackend();
    this.backendStatus = 'connecting';
    this.hydratingHistory = true;
    this.bufferedRuntimeEvents = [];
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.backendWs = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.backendWs.addEventListener('open', () => {
      void this.handleBackendOpen().finally(() => this.scheduleRender());
    });
    this.backendWs.addEventListener('message', event => {
      this.handleBackendMessage(String(event.data));
      this.scheduleRender();
    });
    this.backendWs.addEventListener('close', () => {
      this.backendStatus = this.backendStatus === 'error' ? 'error' : 'closed';
      this.rejectPending(new Error('Backend WebSocket closed'));
      this.scheduleRender();
    });
    this.backendWs.addEventListener('error', () => {
      this.backendStatus = 'error';
      const error = new Error('Backend WebSocket connection failed');
      this.pushSystem(this.t('HOST_CONNECTION_FAILED', 'Host connection failed'), error.message, true);
      this.notifyHostError(error);
      this.scheduleRender();
    });
  }

  private async handleBackendOpen(): Promise<void> {
    try {
      const snapshot = await this.request<RuntimeSnapshot>('runtime.snapshot');
      if (this.runtimeSessionId && this.runtimeSessionId !== snapshot.sessionId) {
        this.lastEventSeq = 0;
        this.pushSystem(this.t('RUNTIME_RESTARTED', 'Serial Runtime restarted'));
      }
      this.runtimeSessionId = snapshot.sessionId;
      this.applyJournalSnapshot(snapshot);
      this.applyScenarioControl(snapshot.scenario);
      await this.restoreRuntimeHistory();
      this.backendStatus = 'ready';
      this.applyStatus(snapshot.state);
      await this.refreshPorts();
      this.notifyHostReady();
    } catch (error) {
      this.finishHistoryHydration();
      this.backendStatus = 'error';
      this.notifyHostError(error);
    }
  }

  private closeBackend(): void {
    this.rejectPending(new Error('Backend WebSocket closed'));
    if (!this.backendWs) return;
    this.backendWs.close();
    this.backendWs = null;
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
    const payload = JSON.stringify({
      id,
      method,
      params,
      context: {
        actor: 'ui',
        actorId: this.uiActorId
      }
    });
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

    if (message.event) {
      const runtimeEvent = message as RpcEventMessage;
      if (typeof runtimeEvent.seq === 'number' && this.hydratingHistory) {
        this.bufferedRuntimeEvents.push(runtimeEvent);
        return;
      }
      this.consumeRuntimeEvent(runtimeEvent);
    }
  }

  private handleRpcResponse(message: RpcResponseMessage): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;

    window.clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      const error = new Error(message.error || 'Serial debugger request failed') as Error & {
        code?: string;
        details?: unknown;
      };
      error.code = message.errorCode;
      error.details = message.details;
      pending.reject(error);
    }
  }

  private consumeRuntimeEvent(message: RpcEventMessage): void {
    if (typeof message.seq === 'number') {
      if (message.seq <= this.lastEventSeq) return;
      this.lastEventSeq = message.seq;
    }
    this.handleBackendEvent(message);
  }

  private handleBackendEvent(message: RpcEventMessage): void {
    const data = (message.data || {}) as Partial<SerialStatus & SerialPayload & {
      code: string;
      errorCode: string;
      message: string;
      reason: string;
      signals: Partial<SerialSignals>;
    }>;
    const timestamp = Number(message.timestamp || data.timestamp || Date.now());
    const actor = String(message.actor || '');

    switch (message.event) {
      case 'ready':
        this.backendStatus = 'ready';
        this.applyStatus(((data as { state?: Partial<SerialStatus> }).state || data) as Partial<SerialStatus>);
        this.notifyHostReady();
        break;
      case 'serial.opened':
        this.applyStatus(data);
        this.connectedPort = data.portPath || this.currentPort;
        this.switchValue = true;
        this.agentControlled = actor === 'agent';
        this.pushSystem(this.connectedMessage(data.portPath || this.currentPort), '', false, timestamp, actor);
        break;
      case 'serial.closed': {
        const closedPort = this.connectedPort || data.portPath || this.currentPort;
        this.applyStatus(data);
        this.connectedPort = null;
        this.switchValue = false;
        this.agentControlled = false;
        this.pushSystem(
          this.t('PORT_CLOSED', 'Serial port closed'),
          closedPort,
          false,
          timestamp,
          actor
        );
        break;
      }
      case 'serial.disconnected': {
        this.applyStatus(data);
        this.connectedPort = null;
        this.switchValue = false;
        this.agentControlled = false;
        const code = String(data.errorCode || data.lastError?.code || 'DEVICE_DISCONNECTED');
        const reason = String(data.reason || data.lastError?.message || 'Serial device disconnected unexpectedly');
        this.pushSystem(this.t('ERROR', 'Error'), `[${code}] ${reason}`, true, timestamp, actor);
        break;
      }
      case 'serial.rx':
        this.processRx(data);
        if (typeof data.rxBytes === 'number') this.rxBytes = data.rxBytes;
        break;
      case 'serial.tx':
        this.pushDataItem('TX', data.text || '', data.hex || '', Number(data.byteLength || 0), timestamp, false, actor);
        if (typeof data.txBytes === 'number') this.txBytes = data.txBytes;
        break;
      case 'serial.signal':
        if (data.signals) this.signals = { ...this.signals, ...data.signals };
        this.pushSystem(this.signalMessage(data.signals), '', false, timestamp, actor);
        break;
      case 'serial.error':
        this.pushSystem(
          this.t('ERROR', 'Error'),
          `${data.code ? `[${data.code}] ` : ''}${data.message || ''}`,
          true,
          timestamp,
          actor,
        );
        break;
      case 'serial.journal.low_disk':
      case 'serial.journal.write_blocked':
      case 'serial.journal.write_failed':
      case 'serial.journal.health_unknown':
      case 'serial.journal.recovered': {
        const health = data as Record<string, unknown>;
        this.journalHealthState = String(health['state'] || (
          message.event === 'serial.journal.recovered' ? 'ok' : 'unknown'
        ));
        this.journalHealthMessage = String(health['message'] || health['code'] || '');
        this.pushSystem(
          String(health['code'] || this.t('JOURNAL_RECORDING', 'Journal recording')),
          this.journalHealthMessage,
          this.journalHealthState !== 'ok',
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.transaction.started': {
        const transaction = data as Record<string, unknown>;
        const expectation = transaction['expectation'] as Record<string, unknown> | null;
        const expected = expectation
          ? String(expectation['pattern'] || expectation['value'] || expectation['type'] || 'response')
          : this.t('SERIAL_RESPONSE', 'serial response');
        this.pushSystem(
          this.t('AGENT_WAITING', 'Agent waiting'),
          `${expected} · ${Number(transaction['timeoutMs'] || 0)} ms`,
          false,
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.transaction.completed': {
        const transaction = data as Record<string, unknown>;
        this.pushSystem(
          this.t('AGENT_MATCHED', 'Agent matched response'),
          `${Number(transaction['byteLength'] || 0)} B · ${Number(transaction['durationMs'] || 0)} ms`,
          false,
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.transaction.failed': {
        const transaction = data as Record<string, unknown>;
        const cancelled = String(transaction['errorCode'] || '') === 'OPERATION_CANCELLED';
        this.pushSystem(
          cancelled
            ? this.t('AGENT_CANCELLED', 'Agent operation cancelled')
            : this.t('AGENT_STEP_FAILED', 'Agent transaction failed'),
          String(transaction['errorCode'] || transaction['error'] || ''),
          !cancelled,
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.scenario.started': {
        const scenario = data as Record<string, unknown>;
        this.activeScenarioName = String(scenario['name'] || 'Serial scenario');
        this.applyScenarioControl({
          active: true,
          scenario: {
            scenarioId: String(scenario['scenarioId'] || ''),
            name: this.activeScenarioName,
            state: 'running',
            owner: { actor, actorId: String(message.actorId || '') },
            stepCount: Number(scenario['stepCount'] || 0),
            completedSteps: 0
          }
        });
        this.pushSystem(
          this.t('SCENARIO_RUNNING', 'Scenario running'),
          `${this.activeScenarioName} · ${Number(scenario['stepCount'] || 0)} steps`,
          false,
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.scenario.pause.requested':
      case 'serial.scenario.paused':
      case 'serial.scenario.resumed':
      case 'serial.scenario.takeover.requested':
      case 'serial.scenario.takeover.granted':
      case 'serial.scenario.takeover.released':
      case 'serial.scenario.cancel.requested': {
        const control = data as Record<string, unknown>;
        const scenario = control['scenario'] as ScenarioControlSummary | undefined;
        if (scenario) this.applyScenarioControl({ active: true, scenario });
        const labels: Record<string, string> = {
          'serial.scenario.pause.requested': this.t('SCENARIO_PAUSING', 'Pausing at safe boundary'),
          'serial.scenario.paused': this.t('SCENARIO_PAUSED', 'Scenario paused'),
          'serial.scenario.resumed': this.t('SCENARIO_RESUMED', 'Scenario resumed'),
          'serial.scenario.takeover.requested': this.t('SCENARIO_TAKEOVER_PENDING', 'Manual takeover pending'),
          'serial.scenario.takeover.granted': this.t('SCENARIO_TAKEN_OVER', 'Manual control granted'),
          'serial.scenario.takeover.released': this.t('SCENARIO_TAKEOVER_RELEASED', 'Manual control released'),
          'serial.scenario.cancel.requested': this.t('SCENARIO_CANCELLING', 'Cancelling')
        };
        this.pushSystem(
          labels[message.event] || this.t('SCENARIO_RUNNING', 'Scenario running'),
          String(control['reason'] || ''),
          false,
          timestamp,
          actor
        );
        break;
      }
      case 'serial.scenario.step.started': {
        const step = data as Record<string, unknown>;
        this.pushSystem(
          this.t('AGENT_WAITING', 'Agent waiting'),
          `${Number(step['index'] || 0) + 1}. ${String(step['name'] || step['action'] || 'step')}`,
          false,
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.scenario.step.completed': {
        const step = data as Record<string, unknown>;
        this.pushSystem(
          this.t('AGENT_MATCHED', 'Agent matched response'),
          `${Number(step['index'] || 0) + 1}. ${String(step['name'] || step['action'] || 'step')} · ${Number(step['durationMs'] || 0)} ms`,
          false,
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.scenario.step.failed': {
        const step = data as Record<string, unknown>;
        const cancelled = String(step['errorCode'] || '') === 'OPERATION_CANCELLED';
        this.pushSystem(
          cancelled
            ? this.t('AGENT_CANCELLED', 'Agent operation cancelled')
            : this.t('AGENT_STEP_FAILED', 'Agent transaction failed'),
          `${Number(step['index'] || 0) + 1}. ${String(step['name'] || step['action'] || 'step')} · ${String(step['errorCode'] || step['error'] || '')}`,
          !cancelled,
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.scenario.completed':
      case 'serial.scenario.failed':
      case 'serial.scenario.cancelled': {
        const scenario = data as Record<string, unknown>;
        const failed = message.event.endsWith('.failed');
        const cancelled = message.event.endsWith('.cancelled');
        this.activeScenarioName = '';
        this.applyScenarioControl({
          active: false,
          scenario: null,
          lastScenario: {
            scenarioId: String(scenario['scenarioId'] || ''),
            name: String(scenario['name'] || 'Serial scenario'),
            state: cancelled ? 'cancelled' : failed ? 'failed' : 'completed',
            completedSteps: Number(scenario['completedSteps'] || 0),
            stepCount: Number(scenario['stepCount'] || 0),
            pausedDurationMs: Number(scenario['pausedDurationMs'] || 0)
          }
        });
        this.pushSystem(
          cancelled
            ? this.t('AGENT_CANCELLED', 'Agent operation cancelled')
            : failed
              ? this.t('AGENT_STEP_FAILED', 'Agent transaction failed')
              : this.t('SCENARIO_COMPLETED', 'Scenario completed'),
          `${String(scenario['name'] || 'Serial scenario')} · ${Number(scenario['completedSteps'] || 0)}/${Number(scenario['stepCount'] || 0)} · ${Number(scenario['durationMs'] || 0)} ms`,
          failed,
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.analysis.started': {
        const analysis = data as Record<string, unknown>;
        this.analysisRunning = true;
        this.pushSystem(
          this.t('ANALYSIS_RUNNING', 'Analysis running'),
          `${String(analysis['source'] || 'auto')} · ${Number(analysis['eventCount'] || 0)} events`,
          false,
          timestamp,
          actor,
        );
        break;
      }
      case 'serial.analysis.completed': {
        const analysis = data as Record<string, unknown>;
        this.analysisRunning = false;
        this.pushSystem(
          this.t('ANALYSIS_COMPLETED', 'Analysis completed'),
          `${String(analysis['verdict'] || 'ok')} · ${Number(analysis['findingCount'] || 0)} findings`,
          String(analysis['verdict'] || 'ok') === 'error',
          timestamp,
          actor,
        );
        break;
      }
      default:
        break;
    }
  }

  private async restoreRuntimeHistory(): Promise<void> {
    let afterSeq = this.lastEventSeq;
    let restored = 0;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = await this.request<RuntimeLogPage>('serial.log.read', {
        afterSeq,
        limit: 1000,
      });
      const events = Array.isArray(page.events) ? page.events : [];
      for (const event of events) {
        this.consumeRuntimeEvent(event);
        restored += 1;
      }
      const nextAfterSeq = Number(page.nextAfterSeq || afterSeq);
      if (!page.hasMore || nextAfterSeq <= afterSeq) break;
      afterSeq = nextAfterSeq;
    }
    this.historyRestored += restored;
    this.finishHistoryHydration();
  }

  private finishHistoryHydration(): void {
    this.hydratingHistory = false;
    const buffered = this.bufferedRuntimeEvents
      .splice(0)
      .sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0));
    for (const event of buffered) this.consumeRuntimeEvent(event);
  }

  private applyStatus(status: Partial<SerialStatus> = {}): void {
    const connected = Boolean(status.connected);
    this.connectedPort = connected ? status.portPath || this.connectedPort || this.currentPort : null;
    this.switchValue = connected;
    if (status.portPath) this.currentPort = status.portPath;
    this.rxBytes = Number(status.rxBytes || 0);
    this.txBytes = Number(status.txBytes || 0);
    this.backendPid = Number(status.pid || this.backendPid || 0);
    if (status.signals) this.signals = { ...this.signals, ...status.signals };
    if (connected && status.owner) {
      this.agentControlled = status.owner.actor === 'agent';
    } else if (!connected) {
      this.agentControlled = false;
    }
    this.scheduleRender();
  }

  private applyJournalSnapshot(snapshot: RuntimeSnapshot): void {
    this.journalEnabled = snapshot.journal?.enabled === true;
    this.journalRoot = String(snapshot.journal?.rootDir || '');
    this.journalArtifacts = snapshot.journal?.artifacts || [];
    this.journalArtifactCount = this.journalArtifacts.length;
    this.journalHealthState = String(snapshot.journal?.health?.state || 'ok');
    this.journalHealthMessage = String(
      snapshot.journal?.health?.message
      || (snapshot.journal?.writeBlocked ? 'Serial Journal writes are paused' : '')
    );
  }

  private applyScenarioControl(status?: ScenarioControlStatus): void {
    if (!status) return;
    this.scenarioControl = status;
    this.activeScenarioName = status.active
      ? String(status.scenario?.name || this.activeScenarioName || 'Serial scenario')
      : '';
  }

  private processRx(payload: Partial<SerialPayload>): void {
    const now = Number(payload.timestamp || Date.now());
    const text = payload.text || '';
    const hex = payload.hex || '';
    const last = this.dataList[this.dataList.length - 1];
    const shouldCreate = !last ||
      last.dir !== 'RX' ||
      now - last.lastAt > RX_NEW_ITEM_GAP_MS ||
      now - last.firstAt > RX_MAX_ITEM_SPAN_MS;

    if (shouldCreate) {
      this.pushDataItem('RX', text, hex, Number(payload.byteLength || 0), now);
    } else {
      last.data += text;
      last.hex = [last.hex, hex].filter(Boolean).join(' ');
      last.byteLength += Number(payload.byteLength || 0);
      last.lastAt = now;
      last.isError = last.isError || /error:/i.test(last.data);
      this.afterDataChanged();
    }

    this.processChartText(text);
  }

  private pushDataItem(
    dir: DataDirection,
    text: string,
    hex = '',
    byteLength = 0,
    timestamp = Date.now(),
    isError = false,
    actor = '',
  ): void {
    this.dataList.push({
      id: ++this.logSeq,
      time: new Date(timestamp).toLocaleTimeString(),
      data: text,
      hex: hex || this.toHex(text),
      dir,
      byteLength,
      firstAt: timestamp,
      lastAt: timestamp,
      isError: isError || /error:/i.test(text),
      actor,
    });
    this.afterDataChanged();
    this.scheduleRender();
  }

  private scheduleRender(): void {
    this.changeDetectorRef.markForCheck();
  }

  private pushSystem(
    label: string,
    detail = '',
    isError = false,
    timestamp = Date.now(),
    actor = '',
  ): void {
    const text = detail ? `[${label}: ${detail}]` : `[${label}]`;
    this.pushDataItem('SYS', text, this.toHex(text), text.length, timestamp, isError, actor);
  }

  private afterDataChanged(): void {
    if (this.dataList.length > MAX_DATA_SIZE) {
      this.dataList = this.dataList.slice(this.dataList.length - TRIM_TARGET_SIZE);
    }
    if (this.searchKeyword) this.keywordChange(this.searchKeyword, false);
    this.needsScroll = true;
    this.needsChartDraw = true;
  }

  private addHistory(content: string): void {
    if (!content.trim()) return;
    this.sendHistoryList = [content, ...this.sendHistoryList.filter(item => item !== content)].slice(0, 20);
  }

  private loadSavedConfig(): void {
    try {
      const config = JSON.parse(localStorage.getItem(CONFIG_KEY) || '{}') as Record<string, string>;
      this.currentPort = config['port'] || this.currentPort;
      this.currentBaudRate = config['baudRate'] || this.currentBaudRate;
      this.dataBits = config['dataBits'] || this.dataBits;
      this.stopBits = config['stopBits'] || this.stopBits;
      this.parity = config['parity'] || this.parity;
      this.flowControl = config['flowControl'] || this.flowControl;
    } catch {
      // Ignore invalid persisted configuration.
    }
  }

  private saveSerialConfig(): void {
    localStorage.setItem(CONFIG_KEY, JSON.stringify({
      port: this.currentPort,
      baudRate: this.currentBaudRate,
      dataBits: this.dataBits,
      stopBits: this.stopBits,
      parity: this.parity,
      flowControl: this.flowControl
    }));
  }

  private loadQuickSendList(): void {
    try {
      const data = JSON.parse(localStorage.getItem(QUICK_SEND_KEY) || 'null') as unknown;
      if (this.isQuickSendList(data)) {
        this.quickSendList = data;
        return;
      }
    } catch {
      // Fall back to default list.
    }

    this.quickSendList = [
      { name: 'DTR', type: 'signal', data: 'DTR' },
      { name: 'RTS', type: 'signal', data: 'RTS' },
      { name: '发送文本', type: 'text', data: 'Hello from Aily' },
      { name: '发送Hex', type: 'hex', data: 'FF FF A1 A2 A3 A4 A5' }
    ];
  }

  private isQuickSendList(data: unknown): data is QuickSendItem[] {
    return Array.isArray(data) && data.every(item => {
      if (!item || typeof item !== 'object') return false;
      const record = item as Record<string, unknown>;
      return typeof record['name'] === 'string' &&
        typeof record['data'] === 'string' &&
        (record['type'] === 'signal' || record['type'] === 'text' || record['type'] === 'hex');
    });
  }

  private showControlChars(text: string): string {
    return text
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n\n')
      .replace(/\t/g, '\\t')
      .replace(/\f/g, '\\f')
      .replace(/\v/g, '\\v')
      .replace(/\0/g, '\\0');
  }

  private toHex(text: string): string {
    return Array.from(new TextEncoder().encode(text))
      .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
  }

  private processChartText(text: string): void {
    this.chartBuffer += text;
    const lines = this.chartBuffer.split(/\r?\n/);
    this.chartBuffer = lines.pop() || '';

    for (const line of lines) {
      const values = line.split(',')
        .map(part => Number.parseFloat(part.trim()))
        .filter(value => Number.isFinite(value));
      if (!values.length) continue;

      const x = ++this.chartIndex;
      values.forEach((value, index) => {
        const series = this.chartSeries.get(index) || [];
        series.push({ x, value });
        if (series.length > 1000) series.splice(0, series.length - 800);
        this.chartSeries.set(index, series);
      });
    }
  }

  private drawChart(): void {
    if (!this.showChartBox || !this.chartCanvas) return;

    const canvas = this.chartCanvas.nativeElement;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--panel-dark').trim() || '#292929';
    ctx.fillRect(0, 0, rect.width, rect.height);

    const allPoints = Array.from(this.chartSeries.values()).flat();
    if (!allPoints.length) return;

    const minX = Math.min(...allPoints.map(point => point.x));
    const maxX = Math.max(...allPoints.map(point => point.x));
    const minValue = Math.min(...allPoints.map(point => point.value));
    const maxValue = Math.max(...allPoints.map(point => point.value));
    const valueRange = maxValue - minValue || 1;
    const xRange = maxX - minX || 1;
    const pad = 18;
    const chartWidth = rect.width - pad * 2;
    const chartHeight = rect.height - pad * 2;
    const colors = ['#4db2ff', '#ff8a65', '#50c878', '#ffd166', '#b388ff', '#26c6da'];

    ctx.strokeStyle = 'rgba(127,127,127,0.18)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i += 1) {
      const y = pad + chartHeight * i / 4;
      ctx.beginPath();
      ctx.moveTo(pad, y);
      ctx.lineTo(rect.width - pad, y);
      ctx.stroke();
    }

    this.chartSeries.forEach((series, index) => {
      if (!series.length) return;
      ctx.strokeStyle = colors[index % colors.length];
      ctx.lineWidth = 2;
      ctx.beginPath();
      series.forEach((point, pointIndex) => {
        const x = pad + ((point.x - minX) / xRange) * chartWidth;
        const y = pad + chartHeight - ((point.value - minValue) / valueRange) * chartHeight;
        if (pointIndex === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    });
  }

  private connectedMessage(portPath: string): string {
    return `${this.t('PORT_OPENED', 'Serial port opened')}: ${portPath} ${this.currentBaudRate}`;
  }

  private signalMessage(signals?: Partial<SerialSignals>): string {
    if (!signals) return this.t('SIGNAL_CHANGED', 'Signal changed');
    const active = Object.entries(signals)
      .map(([key, value]) => `${key.toUpperCase()} ${value ? 'ON' : 'OFF'}`)
      .join(' ');
    return `${this.t('SIGNAL_CHANGED', 'Signal changed')}: ${active}`;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message || String(error);
    return String(error || '');
  }
}
