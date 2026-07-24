import { Injectable, NgZone, computed, signal } from '@angular/core';

export type RuntimeConnectionState = 'idle' | 'connecting' | 'ready' | 'closed' | 'error';
export type CompactLogDirection = 'RX' | 'TX' | 'SYS';

export interface SerialPortInfo {
  path: string;
  name?: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface RuntimeEvent {
  event: string;
  data?: Record<string, unknown>;
  seq?: number;
  timestamp?: number;
  sessionId?: string;
  actor?: string;
  actorId?: string;
}

export interface CompactLogItem {
  seq: number;
  timestamp: number;
  direction: CompactLogDirection;
  text: string;
  actor: string;
  error: boolean;
}

export interface SerialRuntimeStatus {
  state?: string;
  connected: boolean;
  portPath: string;
  options?: {
    path?: string;
    baudRate?: number;
  };
  rxBytes: number;
  txBytes: number;
  connectedAt?: number;
  pid?: number;
  owner?: {
    actor?: string;
    actorId?: string;
  } | null;
  lastError?: {
    code?: string;
    message?: string;
  } | null;
}

export interface SerialRuntimeSnapshot {
  protocolVersion: number;
  sessionId: string;
  state: SerialRuntimeStatus;
  eventStore: {
    firstSeq: number;
    lastSeq: number;
    droppedBeforeSeq: number;
  };
  journal?: {
    enabled?: boolean;
    writeBlocked?: boolean;
    health?: {
      state?: string;
      message?: string;
    };
  };
  scenario?: {
    active?: boolean;
    scenario?: {
      name?: string;
      state?: string;
    } | null;
  };
}

interface RuntimeLogTail {
  events?: RuntimeEvent[];
  lastSeq?: number;
  hasMore?: boolean;
  truncated?: boolean;
  returnedBytes?: number;
}

interface RpcResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
  details?: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: number;
}

const MAX_COMPACT_LOG_ITEMS = 500;
const COMPACT_TAIL_LIMIT = 200;
const COMPACT_TAIL_MAX_BYTES = 64 * 1024;
const COMPACT_EVENT_PREVIEW_CHARS = 2048;

@Injectable({ providedIn: 'root' })
export class SerialRuntimeStore {
  readonly connectionState = signal<RuntimeConnectionState>('idle');
  readonly connectionError = signal('');
  readonly snapshot = signal<SerialRuntimeSnapshot | null>(null);
  readonly ports = signal<readonly SerialPortInfo[]>([]);
  readonly logs = signal<readonly CompactLogItem[]>([]);
  readonly historyTruncated = signal(false);
  readonly busy = signal(false);
  readonly analysisRunning = signal(false);

  readonly connected = computed(() => this.snapshot()?.state?.connected === true);
  readonly portPath = computed(() => this.snapshot()?.state?.portPath || '');
  readonly baudRate = computed(() => Number(this.snapshot()?.state?.options?.baudRate || 115200));
  readonly rxBytes = computed(() => Number(this.snapshot()?.state?.rxBytes || 0));
  readonly txBytes = computed(() => Number(this.snapshot()?.state?.txBytes || 0));
  readonly ownerActor = computed(() => String(this.snapshot()?.state?.owner?.actor || ''));
  readonly agentControlled = computed(() => this.ownerActor() === 'agent');
  readonly journalEnabled = computed(() => this.snapshot()?.journal?.enabled === true);
  readonly journalState = computed(() => String(this.snapshot()?.journal?.health?.state || 'ok'));
  readonly scenarioActive = computed(() => this.snapshot()?.scenario?.active === true);
  readonly scenarioName = computed(() => String(this.snapshot()?.scenario?.scenario?.name || ''));

  private socket: WebSocket | null = null;
  private requestSeq = 0;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  private actorId = '';
  private hydratingTail = false;
  private bufferedEvents: RuntimeEvent[] = [];
  private lastEventSeq = 0;

  constructor(private readonly ngZone: NgZone) {}

  async connect(token: string, actorId: string): Promise<void> {
    this.close();
    this.actorId = actorId;
    this.connectionState.set('connecting');
    this.connectionError.set('');
    this.hydratingTail = true;
    this.bufferedEvents = [];
    this.lastEventSeq = 0;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const socket = new WebSocket(
      `${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`,
    );
    this.socket = socket;
    socket.addEventListener('message', event => this.handleMessage(String(event.data)));
    socket.addEventListener('close', () => {
      if (this.socket !== socket) return;
      this.ngZone.run(() => {
        this.connectionState.set(
          this.connectionState() === 'error' ? 'error' : 'closed',
        );
        this.rejectPending(new Error('Serial Runtime connection closed'));
      });
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      this.ngZone.run(() => {
        this.connectionState.set('error');
        this.connectionError.set('Unable to connect to the Serial Runtime');
      });
    });

    await new Promise<void>((resolve, reject) => {
      const handleOpen = () => {
        cleanup();
        resolve();
      };
      const handleError = () => {
        cleanup();
        reject(new Error('Unable to connect to the Serial Runtime'));
      };
      const cleanup = () => {
        socket.removeEventListener('open', handleOpen);
        socket.removeEventListener('error', handleError);
      };
      socket.addEventListener('open', handleOpen, { once: true });
      socket.addEventListener('error', handleError, { once: true });
    });

    try {
      const snapshot = await this.request<SerialRuntimeSnapshot>('runtime.snapshot');
      const [tail, portsResult] = await Promise.all([
        this.requestTail(snapshot),
        this.request<{ ports?: SerialPortInfo[] }>('serial.ports.list'),
      ]);
      this.ngZone.run(() => {
        this.snapshot.set(snapshot);
        this.ports.set(Array.isArray(portsResult.ports) ? portsResult.ports : []);
        this.historyTruncated.set(tail.truncated === true || tail.hasMore === true);
        const tailEvents = Array.isArray(tail.events)
          ? [...tail.events].sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0))
          : [];
        for (const event of tailEvents) this.consumeEvent(event);
        this.finishTailHydration();
        this.connectionState.set('ready');
      });
    } catch (error) {
      this.ngZone.run(() => {
        this.finishTailHydration();
        this.connectionState.set('error');
        this.connectionError.set(this.errorText(error));
      });
      throw error;
    }
  }

  close(): void {
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
    this.rejectPending(new Error('Serial Runtime connection closed'));
    this.connectionState.set('closed');
  }

  async refreshSnapshot(refreshTail = false): Promise<SerialRuntimeSnapshot> {
    const snapshot = await this.request<SerialRuntimeSnapshot>('runtime.snapshot');
    this.ngZone.run(() => this.snapshot.set(snapshot));
    if (refreshTail) await this.refreshTail();
    return snapshot;
  }

  async refreshPorts(): Promise<readonly SerialPortInfo[]> {
    const result = await this.request<{ ports?: SerialPortInfo[] }>('serial.ports.list');
    const ports = Array.isArray(result.ports) ? result.ports : [];
    this.ngZone.run(() => this.ports.set(ports));
    return ports;
  }

  async openSession(path: string, baudRate: number): Promise<SerialRuntimeStatus> {
    return this.runBusy(async () => {
      const status = await this.request<SerialRuntimeStatus>('serial.session.open', {
        path,
        baudRate,
        dataBits: 8,
        stopBits: 1,
        parity: 'none',
        flowControl: 'none',
      }, 30000);
      this.applyStatus(status);
      return status;
    });
  }

  async closeSession(): Promise<SerialRuntimeStatus> {
    return this.runBusy(async () => {
      const status = await this.request<SerialRuntimeStatus>('serial.session.close', {}, 15000);
      this.applyStatus(status);
      return status;
    });
  }

  private async refreshTail(): Promise<void> {
    const snapshot = this.snapshot() || await this.request<SerialRuntimeSnapshot>('runtime.snapshot');
    const tail = await this.requestTail(snapshot);
    this.ngZone.run(() => {
      this.logs.set([]);
      this.lastEventSeq = 0;
      this.historyTruncated.set(tail.truncated === true || tail.hasMore === true);
      for (const event of tail.events || []) this.consumeEvent(event);
    });
  }

  private async requestTail(snapshot: SerialRuntimeSnapshot): Promise<RuntimeLogTail> {
    try {
      return await this.request<RuntimeLogTail>('serial.log.tail', {
        limit: COMPACT_TAIL_LIMIT,
        maxBytes: COMPACT_TAIL_MAX_BYTES,
        previewBytes: 1024,
      });
    } catch (error) {
      if (!/unknown action:\s*serial\.log\.tail/i.test(this.errorText(error))) {
        throw error;
      }
      const lastSeq = Number(snapshot.eventStore?.lastSeq || 0);
      const firstSeq = Number(snapshot.eventStore?.firstSeq || 0);
      const afterSeq = Math.max(
        Number(snapshot.eventStore?.droppedBeforeSeq || 0),
        lastSeq - COMPACT_TAIL_LIMIT,
      );
      const page = await this.request<RuntimeLogTail>('serial.log.read', {
        afterSeq,
        limit: COMPACT_TAIL_LIMIT,
        maxBytes: COMPACT_TAIL_MAX_BYTES,
        previewBytes: 1024,
      });
      return {
        ...page,
        truncated: page.hasMore === true || afterSeq > Math.max(0, firstSeq - 1),
      };
    }
  }

  private request<T>(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = 15000,
  ): Promise<T> {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('Serial Runtime is not connected'));
    }

    const id = ++this.requestSeq;
    const response = new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeout,
      });
    });
    socket.send(JSON.stringify({
      id,
      method,
      params,
      context: {
        actor: 'ui',
        actorId: this.actorId,
        surface: 'compact',
      },
    }));
    return response;
  }

  private handleMessage(raw: string): void {
    let message: Partial<RpcResponse & RuntimeEvent>;
    try {
      message = JSON.parse(raw) as Partial<RpcResponse & RuntimeEvent>;
    } catch {
      return;
    }

    if (typeof message.id === 'number') {
      this.handleResponse(message as RpcResponse);
      return;
    }
    if (!message.event) return;

    const runtimeEvent = message as RuntimeEvent;
    this.ngZone.run(() => {
      if (this.hydratingTail && typeof runtimeEvent.seq === 'number') {
        this.bufferedEvents.push(runtimeEvent);
        return;
      }
      this.consumeEvent(runtimeEvent);
    });
  }

  private handleResponse(message: RpcResponse): void {
    const pending = this.pendingRequests.get(message.id);
    if (!pending) return;
    window.clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }
    const error = new Error(message.error || 'Serial Runtime request failed') as Error & {
      code?: string;
      details?: unknown;
    };
    error.code = message.errorCode;
    error.details = message.details;
    pending.reject(error);
  }

  private consumeEvent(event: RuntimeEvent): void {
    const seq = Number(event.seq || 0);
    if (seq > 0) {
      if (seq <= this.lastEventSeq) return;
      this.lastEventSeq = seq;
    }

    const data = event.data || {};
    switch (event.event) {
      case 'ready':
        if (data['state']) this.applyStatus(data['state'] as SerialRuntimeStatus);
        break;
      case 'serial.opened':
      case 'serial.closed':
      case 'serial.disconnected':
        this.applyStatus(data as unknown as SerialRuntimeStatus);
        break;
      case 'serial.rx':
      case 'serial.tx':
        this.applyTrafficCounters(event.event, data);
        break;
      case 'serial.analysis.started':
        this.analysisRunning.set(true);
        break;
      case 'serial.analysis.completed':
      case 'serial.analysis.failed':
        this.analysisRunning.set(false);
        break;
      case 'serial.scenario.started':
      case 'serial.scenario.state':
      case 'serial.scenario.completed':
      case 'serial.scenario.failed':
      case 'serial.scenario.cancelled':
        void this.refreshSnapshot().catch(() => undefined);
        break;
      default:
        break;
    }

    const logItem = this.toLogItem(event);
    if (logItem) {
      this.logs.update(items => [...items, logItem].slice(-MAX_COMPACT_LOG_ITEMS));
    }
  }

  private applyStatus(status: SerialRuntimeStatus): void {
    const current = this.snapshot();
    this.snapshot.set({
      protocolVersion: current?.protocolVersion || 1,
      sessionId: current?.sessionId || '',
      eventStore: current?.eventStore || {
        firstSeq: 0,
        lastSeq: this.lastEventSeq,
        droppedBeforeSeq: 0,
      },
      journal: current?.journal,
      scenario: current?.scenario,
      state: {
        ...(current?.state || {
          connected: false,
          portPath: '',
          rxBytes: 0,
          txBytes: 0,
        }),
        ...status,
      },
    });
  }

  private applyTrafficCounters(eventName: string, data: Record<string, unknown>): void {
    const current = this.snapshot()?.state;
    if (!current) return;
    this.applyStatus({
      ...current,
      ...(eventName === 'serial.rx'
        ? { rxBytes: Number(data['rxBytes'] || current.rxBytes || 0) }
        : { txBytes: Number(data['txBytes'] || current.txBytes || 0) }),
    });
  }

  private toLogItem(event: RuntimeEvent): CompactLogItem | null {
    const data = event.data || {};
    const timestamp = Number(event.timestamp || data['timestamp'] || Date.now());
    const base = {
      seq: Number(event.seq || timestamp),
      timestamp,
      actor: String(event.actor || ''),
      error: false,
    };

    if (event.event === 'serial.rx' || event.event === 'serial.tx') {
      const text = String(data['text'] || '').trimEnd()
        || String(data['hex'] || '').trim()
        || `${Number(data['byteLength'] || 0)} bytes`;
      return {
        ...base,
        direction: event.event === 'serial.rx' ? 'RX' : 'TX',
        text: this.preview(text),
      };
    }

    const systemText = this.systemEventText(event.event, data);
    if (!systemText) return null;
    return {
      ...base,
      direction: 'SYS',
      text: this.preview(systemText),
      error: /failed|error|disconnected|blocked/.test(event.event),
    };
  }

  private systemEventText(eventName: string, data: Record<string, unknown>): string {
    switch (eventName) {
      case 'serial.opened':
        return `Connected ${String(data['portPath'] || '')}`;
      case 'serial.closed':
        return `Disconnected ${String(data['portPath'] || '')}`;
      case 'serial.disconnected':
        return String(data['reason'] || data['errorCode'] || 'Device disconnected');
      case 'serial.error':
        return `${data['code'] ? `[${String(data['code'])}] ` : ''}${String(data['message'] || 'Serial error')}`;
      case 'serial.transaction.started':
        return 'Agent transaction started';
      case 'serial.transaction.completed':
        return `Agent transaction completed · ${Number(data['byteLength'] || 0)} B`;
      case 'serial.transaction.failed':
        return `Agent transaction failed · ${String(data['errorCode'] || data['error'] || '')}`;
      case 'serial.scenario.started':
        return `Scenario started · ${String(data['name'] || '')}`;
      case 'serial.scenario.completed':
        return `Scenario completed · ${String(data['name'] || '')}`;
      case 'serial.scenario.failed':
      case 'serial.scenario.cancelled':
        return `Scenario ${eventName.endsWith('failed') ? 'failed' : 'cancelled'} · ${String(data['reason'] || '')}`;
      case 'serial.analysis.started':
        return `Analysis started · ${Number(data['eventCount'] || 0)} events`;
      case 'serial.analysis.completed':
        return `Analysis completed · ${String(data['verdict'] || 'ok')}`;
      case 'serial.analysis.failed':
        return `Analysis failed · ${String(data['error'] || '')}`;
      case 'serial.journal.low_disk':
      case 'serial.journal.write_blocked':
        return String(data['message'] || eventName);
      default:
        return '';
    }
  }

  private finishTailHydration(): void {
    this.hydratingTail = false;
    const buffered = this.bufferedEvents
      .splice(0)
      .sort((left, right) => Number(left.seq || 0) - Number(right.seq || 0));
    for (const event of buffered) this.consumeEvent(event);
  }

  private async runBusy<T>(task: () => Promise<T>): Promise<T> {
    if (this.busy()) throw new Error('A serial operation is already running');
    this.busy.set(true);
    try {
      return await task();
    } finally {
      this.busy.set(false);
    }
  }

  private preview(value: string): string {
    if (value.length <= COMPACT_EVENT_PREVIEW_CHARS) return value;
    const half = Math.floor((COMPACT_EVENT_PREVIEW_CHARS - 24) / 2);
    return `${value.slice(0, half)}\n… compact preview …\n${value.slice(-half)}`;
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error || 'Serial Runtime error');
  }
}
