'use strict';

const crypto = require('crypto');
const { StringDecoder } = require('string_decoder');
const { SerialEventStore } = require('./runtime/event-store');
const {
  captureSerialData,
  waitForExpectation
} = require('./runtime/expectation-engine');
const {
  summarizeErrorDetails,
  summarizeObservation,
  summarizeChunk
} = require('./runtime/result-budget');
const { runSerialScenario } = require('./runtime/scenario-runner');
const { ScenarioController } = require('./runtime/scenario-controller');
const { analyzeSerialEvents } = require('./runtime/analyzer');

const SCENARIO_GUARDED_ACTIONS = new Set([
  'serial.connect',
  'serial.session.open',
  'connect',
  'serial.disconnect',
  'serial.session.close',
  'disconnect',
  'serial.write',
  'serial.send',
  'write',
  'serial.signal',
  'serial.signal.set',
  'serial.signal.pulse',
  'signal',
  'serial.transact',
  'transact'
]);

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function loadSerialPortClass() {
  const serialport = require('serialport');
  return serialport.SerialPort || serialport;
}

function numberOption(value, defaultValue, min = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return defaultValue;
  return Math.max(min, parsed);
}

function normalizeParity(value) {
  const parity = String(value || 'none').toLowerCase();
  return ['none', 'even', 'odd', 'mark', 'space'].includes(parity) ? parity : 'none';
}

function normalizeFlowControl(value) {
  const flowControl = String(value || 'none').toLowerCase();
  return ['none', 'hardware', 'software'].includes(flowControl) ? flowControl : 'none';
}

function createCancellationError(message = 'Serial operation was cancelled', details = {}) {
  const error = new Error(message);
  error.code = 'OPERATION_CANCELLED';
  error.details = details;
  return error;
}

function normalizeSerialError(error, operation = 'serial', details = {}) {
  if (error?.code && [
    'PORT_BUSY',
    'PORT_ACCESS_DENIED',
    'PORT_NOT_FOUND',
    'DEVICE_DISCONNECTED',
    'PORT_OPEN_FAILED',
    'SERIAL_WRITE_FAILED',
    'SERIAL_SIGNAL_FAILED'
  ].includes(String(error.code))) {
    return error;
  }

  const message = asError(error) || 'Serial operation failed';
  const rawCode = String(error?.code || '').toUpperCase();
  const normalizedMessage = message.toLowerCase();
  let code;
  let guidance;
  let recoverable = true;

  if (
    rawCode === 'EBUSY'
    || /resource busy|device busy|already in use|used by another|access denied/.test(normalizedMessage)
  ) {
    code = 'PORT_BUSY';
    guidance = 'Close other serial monitors, upload tools, or Runtime sessions that may own the port, then retry.';
  } else if (rawCode === 'EACCES' || rawCode === 'EPERM' || /permission denied/.test(normalizedMessage)) {
    code = process.platform === 'win32' ? 'PORT_BUSY' : 'PORT_ACCESS_DENIED';
    guidance = code === 'PORT_BUSY'
      ? 'Close the process that owns the port, then retry.'
      : 'Check serial-device permissions or group membership, then retry.';
  } else if (
    rawCode === 'ENOENT'
    || rawCode === 'ENODEV'
    || /cannot find|not found|no such file|does not exist/.test(normalizedMessage)
  ) {
    code = 'PORT_NOT_FOUND';
    guidance = 'Refresh the port list, reconnect the device, and select its current port path.';
  } else if (
    /disconnected|device.*removed|not connected|input\/output error|i\/o error|bad file descriptor/.test(
      normalizedMessage
    )
  ) {
    code = 'DEVICE_DISCONNECTED';
    guidance = 'Reconnect the device, refresh ports, and explicitly reopen the serial session.';
  } else if (operation === 'open') {
    code = 'PORT_OPEN_FAILED';
    guidance = 'Verify the port path and serial settings, then retry.';
  } else if (operation === 'write') {
    code = 'SERIAL_WRITE_FAILED';
    guidance = 'Check the device connection and inspect Runtime events before retrying the send.';
  } else if (operation === 'signal') {
    code = 'SERIAL_SIGNAL_FAILED';
    guidance = 'Check the device connection before changing serial signals again.';
  } else {
    code = 'SERIAL_ERROR';
    guidance = 'Inspect the serial session status and recent Runtime events.';
    recoverable = false;
  }

  const normalized = new Error(message);
  normalized.code = code;
  normalized.details = {
    operation,
    originalCode: rawCode,
    recoverable,
    guidance,
    ...details
  };
  return normalized;
}

function throwIfCancelled(signal, details = {}) {
  if (signal?.aborted) throw createCancellationError(undefined, details);
}

function linkAbortSignal(signal, controller) {
  if (!signal) return () => undefined;
  const abort = () => controller.abort();
  if (signal.aborted) abort();
  else signal.addEventListener?.('abort', abort, { once: true });
  return () => signal.removeEventListener?.('abort', abort);
}

function cancellableDelay(durationMs, signal) {
  return new Promise((resolve, reject) => {
    let timer;
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      reject(createCancellationError());
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', abort);
      resolve();
    }, durationMs);
    signal?.addEventListener?.('abort', abort, { once: true });
  });
}

function booleanOption(value) {
  if (typeof value === 'string') {
    return !['0', 'false', 'no', 'off'].includes(value.toLowerCase());
  }
  return Boolean(value);
}

function normalizeSerialOptions(options = {}) {
  const portPath = options.portPath || options.port || options.path;
  if (!portPath) throw new Error('Serial port path is required');

  const stopBits = Number(options.stopBits || 1);
  return {
    path: String(portPath),
    baudRate: numberOption(options.baudRate || options.baud, 115200, 1),
    dataBits: numberOption(options.dataBits, 8, 5),
    stopBits: [1, 1.5, 2].includes(stopBits) ? stopBits : 1,
    parity: normalizeParity(options.parity),
    flowControl: normalizeFlowControl(options.flowControl)
  };
}

function normalizePortPath(port = {}) {
  return port.path || port.comName || port.port || port.name || port.friendlyName || '';
}

function serializePortInfo(port = {}) {
  const portPath = normalizePortPath(port);
  return {
    path: portPath,
    name: port.friendlyName || port.name || portPath || '',
    manufacturer: port.manufacturer || '',
    serialNumber: port.serialNumber || '',
    vendorId: port.vendorId || '',
    productId: port.productId || '',
    pnpId: port.pnpId || '',
    locationId: port.locationId || ''
  };
}

function normalizeHexText(value) {
  const input = String(value || '').trim();
  if (!input) return '';
  const withoutPrefixes = input.replace(/0x/gi, '');
  if (/[^0-9a-fA-F\s,;:_-]/.test(withoutPrefixes)) {
    const error = new Error('HEX payload contains invalid characters');
    error.code = 'INVALID_HEX';
    throw error;
  }
  const normalized = withoutPrefixes.replace(/[\s,;:_-]+/g, '');
  if (normalized.length % 2 !== 0) {
    const error = new Error('HEX payload must contain complete bytes');
    error.code = 'INVALID_HEX';
    throw error;
  }
  return normalized;
}

function encodePayload(options = {}) {
  if (Buffer.isBuffer(options.data)) return Buffer.from(options.data);
  if (options.base64) return Buffer.from(String(options.base64), 'base64');

  const mode = String(options.mode || options.format || 'text').toLowerCase();
  const data = String(options.data ?? options.text ?? options.hex ?? '');

  if (mode === 'hex') {
    const hex = normalizeHexText(data);
    if (!hex) return Buffer.alloc(0);
    return Buffer.from(hex, 'hex');
  }

  let text = data;
  if (options.appendCr) text += '\r';
  if (options.appendLf) text += '\n';
  return Buffer.from(text, options.encoding || 'utf8');
}

function formatChunk(buffer, decodedText) {
  const payload = Buffer.from(buffer || []);
  return {
    base64: payload.toString('base64'),
    hex: Array.from(payload).map(byte => byte.toString(16).padStart(2, '0')).join(' '),
    text: decodedText === undefined ? payload.toString('utf8') : decodedText,
    byteLength: payload.length
  };
}

function openPort(port) {
  return new Promise((resolve, reject) => {
    port.open(error => (error ? reject(error) : resolve()));
  });
}

function closePort(port) {
  return new Promise(resolve => {
    try {
      if (!port || !port.isOpen) {
        resolve();
        return;
      }
      port.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function writePort(port, buffer, onWritten) {
  return new Promise((resolve, reject) => {
    port.write(buffer, error => {
      if (error) {
        reject(error);
        return;
      }
      if (onWritten) onWritten();
      port.drain(drainError => (drainError ? reject(drainError) : resolve()));
    });
  });
}

function setPortSignals(port, signals) {
  return new Promise((resolve, reject) => {
    port.set(signals, error => (error ? reject(error) : resolve()));
  });
}

function disconnectedSessionError(session) {
  const disconnected = session?.state === 'disconnected';
  const error = new Error(
    disconnected ? 'Serial device is disconnected' : 'Serial port is not connected'
  );
  error.code = disconnected ? 'DEVICE_DISCONNECTED' : 'PORT_DISCONNECTED';
  error.details = {
    state: session?.state || 'idle',
    portPath: session?.options?.path || '',
    recoverable: true,
    guidance: disconnected
      ? 'Reconnect the device, refresh ports, and explicitly reopen the serial session.'
      : 'Open a serial session before sending data.'
  };
  return error;
}

class SerialSession {
  constructor(options = {}) {
    this.sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : null;
    this.SerialPortClass = options.SerialPortClass || loadSerialPortClass();
    this.port = null;
    this.options = null;
    this.state = 'idle';
    this.rxBytes = 0;
    this.txBytes = 0;
    this.connectedAt = 0;
    this.decoder = new StringDecoder('utf8');
    this.ownerContext = { actor: 'user' };
    this.lastError = null;
    this.signals = {
      dtr: false,
      rts: false,
      brk: false
    };
  }

  get connected() {
    return Boolean(this.port && this.port.isOpen);
  }

  status() {
    return {
      state: this.state,
      connected: this.connected,
      portPath: this.options?.path || '',
      options: this.options || {},
      signals: { ...this.signals },
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      connectedAt: this.connectedAt,
      owner: this.connected ? { ...this.ownerContext } : null,
      lastError: this.lastError,
      pid: process.pid
    };
  }

  async connect(options = {}, context = {}) {
    const serialOptions = normalizeSerialOptions(options);
    const operationContext = { actor: 'user', ...context };
    if (this.port) await this.disconnect(operationContext);
    this.state = 'opening';
    this.ownerContext = operationContext;

    const ctorOptions = {
      path: serialOptions.path,
      baudRate: serialOptions.baudRate,
      dataBits: serialOptions.dataBits,
      stopBits: serialOptions.stopBits,
      parity: serialOptions.parity,
      autoOpen: false
    };

    if (serialOptions.flowControl === 'hardware') {
      ctorOptions.rtscts = true;
    } else if (serialOptions.flowControl === 'software') {
      ctorOptions.xon = true;
      ctorOptions.xoff = true;
    }

    const nextPort = new this.SerialPortClass(ctorOptions);
    this.port = nextPort;
    this.options = serialOptions;
    this.decoder = new StringDecoder('utf8');
    nextPort.on('data', data => this.handleData(data));
    nextPort.on('error', error => {
      const normalized = normalizeSerialError(error, 'runtime', {
        portPath: this.options?.path || serialOptions.path
      });
      this.lastError = {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
        timestamp: Date.now()
      };
      this.emit('serial.error', this.lastError, this.ownerContext);
    });
    nextPort.on('close', () => {
      const wasConnected = this.port === nextPort;
      if (!wasConnected) return;
      this.port = null;
      this.state = 'disconnected';
      this.decoder.end();
      this.decoder = new StringDecoder('utf8');
      if (!this.lastError) {
        this.lastError = {
          code: 'DEVICE_DISCONNECTED',
          message: 'Serial device disconnected unexpectedly',
          details: {
            portPath: this.options?.path || serialOptions.path,
            recoverable: true,
            guidance: 'Reconnect the device, refresh ports, and explicitly reopen the serial session.'
          },
          timestamp: Date.now()
        };
      }
      this.emit('serial.disconnected', {
        ...this.status(),
        errorCode: this.lastError.code,
        reason: this.lastError.message
      }, this.ownerContext);
    });

    try {
      await openPort(nextPort);
    } catch (error) {
      const normalized = normalizeSerialError(error, 'open', {
        portPath: serialOptions.path
      });
      if (this.port === nextPort) {
        this.port = null;
        this.options = null;
      }
      this.state = 'error';
      this.lastError = {
        code: normalized.code,
        message: normalized.message,
        details: normalized.details,
        timestamp: Date.now()
      };
      nextPort.removeAllListeners();
      await closePort(nextPort);
      this.emit(
        'serial.error',
        this.lastError,
        operationContext,
      );
      throw normalized;
    }
    this.state = 'connected';
    this.lastError = null;
    this.rxBytes = 0;
    this.txBytes = 0;
    this.connectedAt = Date.now();
    this.emit('serial.opened', this.status(), operationContext);
    return this.status();
  }

  async disconnect(context = {}) {
    const operationContext = { actor: 'user', ...context };
    const activePort = this.port;
    if (!activePort) {
      this.state = 'idle';
      this.options = null;
      this.lastError = null;
      return this.status();
    }
    this.state = 'closing';
    this.port = null;
    this.options = null;
    await closePort(activePort);
    this.decoder.end();
    this.decoder = new StringDecoder('utf8');
    this.state = 'idle';
    this.lastError = null;
    const status = this.status();
    this.emit('serial.closed', status, operationContext);
    return status;
  }

  async write(options = {}, context = {}) {
    if (!this.connected || !this.port) throw disconnectedSessionError(this);
    const payload = encodePayload(options);
    let data;
    try {
      await writePort(this.port, payload, () => {
        this.txBytes += payload.length;
        data = {
          ...formatChunk(payload),
          direction: 'TX',
          portPath: this.options?.path || '',
          txBytes: this.txBytes,
          timestamp: Date.now()
        };
        this.emit('serial.tx', data, { actor: 'user', ...context });
      });
    } catch (error) {
      throw normalizeSerialError(error, 'write', { portPath: this.options?.path || '' });
    }
    return data;
  }

  async setSignals(options = {}, context = {}) {
    if (!this.connected || !this.port) throw disconnectedSessionError(this);
    const signals = {};

    if (options.dtr !== undefined || options.dataTerminalReady !== undefined) {
      signals.dtr = booleanOption(options.dtr ?? options.dataTerminalReady);
    }
    if (options.rts !== undefined || options.requestToSend !== undefined) {
      signals.rts = booleanOption(options.rts ?? options.requestToSend);
    }
    if (options.brk !== undefined || options.break !== undefined) {
      signals.brk = booleanOption(options.brk ?? options.break);
    }

    if (options.signal) {
      const key = String(options.signal).toLowerCase();
      if (key === 'dtr' || key === 'rts' || key === 'brk') {
        signals[key] = options.state === undefined ? !this.signals[key] : booleanOption(options.state);
      }
    }

    if (!Object.keys(signals).length) throw new Error('No serial signal was provided');
    try {
      await setPortSignals(this.port, signals);
    } catch (error) {
      throw normalizeSerialError(error, 'signal', { portPath: this.options?.path || '' });
    }
    this.signals = { ...this.signals, ...signals };
    const result = { signals: { ...this.signals }, timestamp: Date.now() };
    this.emit('serial.signal', result, { actor: 'user', ...context });
    return result;
  }

  async cleanup() {
    if (this.port) await this.disconnect({ actor: 'runtime' });
    return { closing: true };
  }

  handleData(data) {
    const payload = Buffer.from(data || []);
    this.rxBytes += payload.length;
    this.emit('serial.rx', {
      ...formatChunk(payload, this.decoder.write(payload)),
      direction: 'RX',
      portPath: this.options?.path || '',
      rxBytes: this.rxBytes,
      timestamp: Date.now()
    }, { actor: 'device' });
  }

  emit(event, data = {}, context = {}) {
    if (this.sendEvent) this.sendEvent(event, data, {
      actor: 'runtime',
      ...context
    });
  }
}

function createSerialDebuggerCore(options = {}) {
  const sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : null;
  const runtimeLifecycle = options.runtimeLifecycle
    && typeof options.runtimeLifecycle === 'object'
    ? options.runtimeLifecycle
    : null;
  const SerialPortClass = options.SerialPortClass || loadSerialPortClass();
  const eventStore = options.eventStore || new SerialEventStore(options.eventStoreOptions);
  const journal = options.journal || null;
  const sessionId = String(options.sessionId || journal?.sessionId || createSessionId());
  const emitEvent = (event, data = {}, context = {}) => {
    const envelope = eventStore.append(event, data, {
      sessionId,
      ...context
    });
    journal?.append(envelope);
    if (sendEvent) sendEvent(event, data, envelope);
    return envelope;
  };
  journal?.setHealthListener?.((event, data) => {
    const envelope = eventStore.append(event, data, {
      sessionId,
      actor: 'runtime',
      actorId: `runtime-${process.pid}`
    });
    if (sendEvent) sendEvent(event, data, envelope);
  });
  const session = new SerialSession({
    SerialPortClass,
    sendEvent: emitEvent
  });
  const scenarioController = new ScenarioController({ emit: emitEvent });

  async function listSerialPorts() {
    const ports = await SerialPortClass.list();
    return ports.map(serializePortInfo);
  }

  function snapshot() {
    return {
      protocolVersion: 1,
      sessionId,
      state: session.status(),
      eventStore: {
        firstSeq: eventStore.firstSeq,
        lastSeq: eventStore.lastSeq,
        droppedBeforeSeq: eventStore.droppedBeforeSeq
      },
      journal: journal?.stats() || { enabled: false },
      scenario: scenarioController.status()
    };
  }

  async function expect(params = {}, signal) {
    ensureConnected(session);
    const observed = await waitForExpectation(eventStore, {
      ...params,
      signal,
      expect: params.expect || params.expectation || params
    });
    const result = summarizeObservation(observed, params);
    if (journal) result.evidence = journal.evidence(result.startSeq, result.endSeq);
    return result;
  }

  async function capture(params = {}, signal) {
    ensureConnected(session);
    const observed = await captureSerialData(eventStore, { ...params, signal });
    const result = summarizeObservation(observed, params);
    if (journal) result.evidence = journal.evidence(result.startSeq, result.endSeq);
    return result;
  }

  async function transact(params = {}, context = {}, signal) {
    const operationContext = { actor: 'user', ...context };
    throwIfCancelled(signal, { action: 'serial.transact' });
    if (!session.connected && (params.port || params.portPath || params.path || params.connect)) {
      await session.connect(params.connect || params, operationContext);
      if (signal?.aborted) {
        await session.disconnect({ actor: 'system', reason: 'cancelled' }).catch(() => undefined);
        throwIfCancelled(signal, { action: 'serial.transact', phase: 'connect' });
      }
    }
    ensureConnected(session);
    const afterSeq = eventStore.lastSeq;
    const transactionId = createSessionId();
    emitEvent('serial.transaction.started', {
      transactionId,
      afterSeq,
      expectation: params.expect || params.expectation || null,
      timeoutMs: Number(params.timeoutMs || 3000),
      timestamp: Date.now()
    }, operationContext);
    const abortController = new AbortController();
    const unlinkAbortSignal = linkAbortSignal(signal, abortController);
    let waitTask;
    try {
      waitTask = params.expect || params.expectation
        ? waitForExpectation(eventStore, {
            ...params,
            afterSeq,
            signal: abortController.signal,
            expect: params.expect || params.expectation
          })
        : captureSerialData(eventStore, {
            ...params,
            afterSeq,
            signal: abortController.signal,
            durationMs: params.durationMs || params.waitMs || params.timeoutMs || 500,
            quietMs: params.quietMs === undefined ? 100 : params.quietMs
          });
    } catch (error) {
      unlinkAbortSignal();
      throw error;
    }
    let sent;
    try {
      throwIfCancelled(signal, { action: 'serial.transact', phase: 'send' });
      sent = await session.write(params.send || params, operationContext);
    } catch (error) {
      abortController.abort();
      await waitTask.catch(() => undefined);
      unlinkAbortSignal();
      emitEvent('serial.transaction.failed', {
        transactionId,
        afterSeq,
        error: asError(error),
        errorCode: error?.code || 'SERIAL_WRITE_FAILED',
        details: error?.details,
        timestamp: Date.now()
      }, operationContext);
      throw error;
    }
    let observed;
    try {
      observed = await waitTask;
    } catch (error) {
      unlinkAbortSignal();
      error.details = summarizeErrorDetails(error?.details, params);
      if (journal) {
        error.details = {
          ...(error.details || {}),
          evidence: journal.evidence(
            Number(error.details?.capture?.startSeq || afterSeq),
            Number(error.details?.capture?.endSeq || eventStore.lastSeq)
          )
        };
      }
      emitEvent('serial.transaction.failed', {
        transactionId,
        afterSeq,
        error: asError(error),
        errorCode: error?.code || 'SERIAL_TRANSACTION_FAILED',
        details: error?.details,
        timestamp: Date.now()
      }, operationContext);
      throw error;
    }
    emitEvent('serial.transaction.completed', {
      transactionId,
      afterSeq,
      matched: observed.matched === true,
      reason: observed.reason || (observed.matched ? 'matched' : 'completed'),
      durationMs: observed.durationMs,
      startSeq: observed.startSeq,
      endSeq: observed.endSeq,
      byteLength: observed.capture?.byteLength || 0,
      timestamp: Date.now()
    }, operationContext);
    const result = {
      sessionId,
      transactionId,
      sent: summarizeChunk(sent, params),
      ...summarizeObservation(observed, params)
    };
    if (journal) {
      result.evidence = journal.evidence(
        result.startSeq || afterSeq,
        result.endSeq || eventStore.lastSeq
      );
    }
    unlinkAbortSignal();
    return result;
  }

  function requireArtifactStore() {
    if (journal?.artifactStore) return journal.artifactStore;
    const error = new Error('Serial artifact storage is not enabled for this Runtime');
    error.code = 'ARTIFACTS_DISABLED';
    throw error;
  }

  async function readLogPage(params = {}) {
    const source = String(params.source || 'auto').toLowerCase();
    const requiresJournal = source === 'journal'
      || Number(params.fromTimestamp || 0) > 0
      || Number(params.toTimestamp || 0) > 0
      || Number(params.beforeSeq || 0) > 0
      || (
        source === 'auto'
        && journal
        && Number(params.afterSeq || 0) < eventStore.droppedBeforeSeq
      );
    if (requiresJournal) {
      if (!journal) {
        const error = new Error('Serial Journal is not enabled for this Runtime');
        error.code = 'JOURNAL_DISABLED';
        throw error;
      }
      return await journal.query(params);
    }
    return {
      source: 'memory',
      ...eventStore.read(params)
    };
  }

  async function runScenario(params = {}, context = {}, signal) {
    const control = scenarioController.start(params, context, signal);
    try {
      const result = await runSerialScenario({
        status: () => session.status(),
        connect: (connectOptions, operationContext) => session.connect(connectOptions, operationContext),
        disconnect: operationContext => session.disconnect(operationContext),
        send: (sendOptions, operationContext) => session.write(sendOptions, operationContext),
        setSignals: (signalOptions, operationContext) => session.setSignals(signalOptions, operationContext),
        pulseSignal,
        capture,
        transact,
        scenarioControl: control,
        emit: emitEvent,
        lastSeq: () => eventStore.lastSeq,
        ...(journal ? { evidence: (startSeq, endSeq) => journal.evidence(startSeq, endSeq) } : {})
      }, {
        ...params,
        scenarioId: control.scenarioId
      }, context, control.signal);
      control.finish(result.status, result);
      return result;
    } catch (error) {
      control.finish(
        error?.code === 'OPERATION_CANCELLED' ? 'cancelled' : 'failed',
        { reason: error?.code || error?.message }
      );
      throw error;
    }
  }

  async function runAnalysis(params = {}, context = {}) {
    const operationContext = { actor: 'agent', ...context };
    const requestedSource = String(params.source || 'auto').toLowerCase();
    const maxEvents = Math.min(5000, Math.max(1, Number(params.maxEvents || 2000)));
    const useJournal = requestedSource === 'journal'
      || Number(params.fromTimestamp || 0) > 0
      || Number(params.toTimestamp || 0) > 0
      || Number(params.beforeSeq || 0) > 0
      || (
        requestedSource === 'auto'
        && journal
        && Number(params.afterSeq || 0) < eventStore.droppedBeforeSeq
      );
    let events;
    let source;
    let inputTruncated = false;
    if (useJournal) {
      if (!journal) {
        const error = new Error('Serial Journal is not enabled for this Runtime');
        error.code = 'JOURNAL_DISABLED';
        throw error;
      }
      const page = await journal.query({
        ...params,
        limit: maxEvents,
        maxBytes: 256 * 1024,
        previewBytes: Math.min(4096, Math.max(256, Number(params.previewBytes || 2048)))
      });
      events = page.events;
      source = 'journal';
      inputTruncated = page.hasMore || page.parseErrors > 0;
    } else {
      const matching = eventStore.events.filter(event => matchesAnalysisRange(event, params));
      inputTruncated = matching.length > maxEvents;
      events = matching.slice(Math.max(0, matching.length - maxEvents));
      source = 'memory';
    }

    emitEvent('serial.analysis.started', {
      source,
      eventCount: events.length,
      inputTruncated,
      timestamp: Date.now()
    }, operationContext);
    const result = analyzeSerialEvents(events, {
      maxFindings: params.maxFindings,
      inputTruncated
    });
    result.sessionId = sessionId;
    result.source = source;
    if (journal && result.startSeq) {
      result.evidence = journal.evidence(result.startSeq, result.endSeq);
      for (const finding of result.findings) {
        const evidence = journal.evidence(
          finding.evidence.startSeq,
          finding.evidence.endSeq
        );
        finding.evidence.artifactIds = evidence.artifacts
          .slice(0, 8)
          .map(artifact => artifact.artifactId);
      }
    }
    emitEvent('serial.analysis.completed', {
      analysisId: result.analysisId,
      source,
      verdict: result.verdict,
      eventCount: result.eventCount,
      findingCount: result.findings.length,
      severityCounts: result.severityCounts,
      startSeq: result.startSeq,
      endSeq: result.endSeq,
      timestamp: Date.now()
    }, operationContext);
    return result;
  }

  async function cleanup() {
    if (scenarioController.status().active) {
      await scenarioController.control(
        { action: 'cancel', reason: 'runtime_cleanup' },
        { actor: 'runtime', actorId: `runtime-${process.pid}` }
      ).catch(() => undefined);
    }
    const result = await session.cleanup();
    await journal?.close();
    return result;
  }

  async function pulseSignal(params = {}, context = {}, abortSignal) {
    const operationContext = { actor: 'user', ...context };
    ensureConnected(session);
    throwIfCancelled(abortSignal, { action: 'serial.signal.pulse' });
    const signalName = String(params.signal || '').toLowerCase();
    if (!['dtr', 'rts', 'brk'].includes(signalName)) {
      const error = new Error('Signal pulse requires dtr, rts, or brk');
      error.code = 'INVALID_SERIAL_OPTIONS';
      throw error;
    }
    const durationMs = Math.min(10000, Math.max(1, Number(params.durationMs || params.duration || 100)));
    const activeState = params.activeState === undefined ? true : booleanOption(params.activeState);
    const finalState = params.finalState === undefined ? !activeState : booleanOption(params.finalState);
    const startedAt = Date.now();
    await session.setSignals({ [signalName]: activeState }, operationContext);
    let cancellationError;
    try {
      await cancellableDelay(durationMs, abortSignal);
    } catch (error) {
      cancellationError = error;
    }
    const result = await session.setSignals({ [signalName]: finalState }, operationContext);
    if (cancellationError) throw cancellationError;
    return {
      signal: signalName,
      activeState,
      finalState,
      durationMs,
      startedAt,
      endedAt: Date.now(),
      ...result
    };
  }

  async function executeAction(message = {}) {
    const action = message.action || message.method;
    const params = message.params || message.data || message;
    const context = message.context || params.context || {};
    const signal = message.signal;

    if (SCENARIO_GUARDED_ACTIONS.has(action)) {
      scenarioController.authorizeMutation(context, action);
    }

    switch (action) {
      case 'runtime.capabilities':
        return {
          protocolVersion: 1,
          methods: [
            'runtime.capabilities',
            'runtime.lease.acquire',
            'runtime.lease.status',
            'runtime.request.cancel',
            'runtime.snapshot',
            'serial.ports.list',
            'serial.session.open',
            'serial.session.status',
            'serial.session.close',
            'serial.send',
            'serial.signal.set',
            'serial.signal.pulse',
            'serial.log.read',
            'serial.log.tail',
            'serial.artifact.info',
            'serial.artifact.read',
            'serial.artifact.search',
            'serial.capture',
            'serial.expect',
            'serial.transact',
            'serial.scenario.run',
            'serial.scenario.control',
            'serial.analysis.run'
          ]
        };
      case 'runtime.lease.acquire':
        if (typeof runtimeLifecycle?.acquireLease !== 'function') {
          throw new Error('Runtime session leases are not enabled');
        }
        return await runtimeLifecycle.acquireLease(params);
      case 'runtime.lease.status':
        return typeof runtimeLifecycle?.leaseStatus === 'function'
          ? await runtimeLifecycle.leaseStatus()
          : { mode: 'process-owned', active: 0, sessions: [] };
      case 'runtime.snapshot':
        return snapshot();
      case 'status':
      case 'serial.session.status':
        return session.status();
      case 'serial.list':
      case 'serial.ports.list':
      case 'ports':
        return { ports: await listSerialPorts() };
      case 'serial.connect':
      case 'serial.session.open':
      case 'connect':
        throwIfCancelled(signal, { action });
        {
          const result = await session.connect(params, context);
          if (signal?.aborted) {
            await session.disconnect({ actor: 'system', reason: 'cancelled' }).catch(() => undefined);
            throwIfCancelled(signal, { action, phase: 'connect' });
          }
          return result;
        }
      case 'serial.disconnect':
      case 'serial.session.close':
      case 'disconnect':
        return await session.disconnect(context);
      case 'serial.write':
      case 'serial.send':
      case 'write':
        return summarizeChunk(await session.write(params, context), params);
      case 'serial.signal':
      case 'serial.signal.set':
      case 'signal':
        return await session.setSignals(params, context);
      case 'serial.signal.pulse':
        return await pulseSignal(params, context, signal);
      case 'serial.log.read':
        return await readLogPage(params);
      case 'serial.log.tail':
        return eventStore.tail(params);
      case 'serial.artifact.info':
        return requireArtifactStore().info(params.artifactId);
      case 'serial.artifact.read':
        await journal?.flush();
        return await requireArtifactStore().read(params);
      case 'serial.artifact.search':
        await journal?.flush();
        return await requireArtifactStore().search(params);
      case 'serial.capture':
        return await capture(params, signal);
      case 'serial.expect':
        return await expect(params, signal);
      case 'serial.transact':
      case 'transact':
        return await transact(params, context, signal);
      case 'serial.scenario.run':
        return await runScenario(params, context, signal);
      case 'serial.scenario.control':
        return await scenarioController.control(params, context);
      case 'serial.analysis.run':
        return await runAnalysis(params, context);
      case 'shutdown':
        return await cleanup();
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  return {
    protocolVersion: 1,
    sessionId,
    eventStore,
    journal,
    status: () => session.status(),
    snapshot,
    listSerialPorts,
    connect: options => session.connect(options),
    disconnect: () => session.disconnect(),
    write: options => session.write(options),
    setSignals: options => session.setSignals(options),
    pulseSignal,
    readLogs: options => eventStore.read(options),
    queryLogs: readLogPage,
    capture,
    expect,
    transact,
    runScenario,
    scenarioControl: (params, context) => scenarioController.control(params, context),
    handleClientDisconnect: context => scenarioController.releaseActor(context),
    runAnalysis,
    cleanup,
    executeAction
  };
}

function ensureConnected(session) {
  if (!session.connected) {
    throw disconnectedSessionError(session);
  }
}

function matchesAnalysisRange(event, params = {}) {
  const afterSeq = Math.max(0, Number(params.afterSeq) || 0);
  const beforeSeq = Math.max(0, Number(params.beforeSeq) || 0);
  const fromTimestamp = Math.max(0, Number(params.fromTimestamp) || 0);
  const toTimestamp = Math.max(0, Number(params.toTimestamp) || 0);
  if (Number(event.seq || 0) <= afterSeq) return false;
  if (beforeSeq && Number(event.seq || 0) >= beforeSeq) return false;
  if (fromTimestamp && Number(event.timestamp || 0) < fromTimestamp) return false;
  if (toTimestamp && Number(event.timestamp || 0) > toTimestamp) return false;
  return true;
}

function createSessionId() {
  if (typeof crypto.randomUUID === 'function') return `serial-${crypto.randomUUID()}`;
  return `serial-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  asError,
  createSerialDebuggerCore,
  encodePayload,
  formatChunk,
  normalizeSerialError,
  normalizeHexText,
  normalizeSerialOptions
};
