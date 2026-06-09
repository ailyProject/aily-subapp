'use strict';

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

function normalizeSerialOptions(options = {}) {
  const portPath = options.portPath || options.port || options.path;
  if (!portPath) throw new Error('Serial port path is required');

  const stopBits = Number(options.stopBits || 1);
  return {
    path: String(portPath),
    baudRate: numberOption(options.baudRate || options.baud, 9600, 1),
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

function stripHexText(value) {
  return String(value || '').replace(/[^0-9a-fA-F]/g, '');
}

function encodePayload(options = {}) {
  if (Buffer.isBuffer(options.data)) return Buffer.from(options.data);
  if (options.base64) return Buffer.from(String(options.base64), 'base64');

  const mode = String(options.mode || options.format || 'text').toLowerCase();
  const data = String(options.data ?? options.text ?? options.hex ?? '');

  if (mode === 'hex') {
    const hex = stripHexText(data);
    if (!hex) return Buffer.alloc(0);
    return Buffer.from(hex.length % 2 ? `0${hex}` : hex, 'hex');
  }

  let text = data;
  if (options.appendCr) text += '\r';
  if (options.appendLf) text += '\n';
  return Buffer.from(text, options.encoding || 'utf8');
}

function formatChunk(buffer) {
  const payload = Buffer.from(buffer || []);
  return {
    base64: payload.toString('base64'),
    hex: Array.from(payload).map(byte => byte.toString(16).padStart(2, '0')).join(' '),
    text: payload.toString('utf8'),
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

function writePort(port, buffer) {
  return new Promise((resolve, reject) => {
    port.write(buffer, error => {
      if (error) {
        reject(error);
        return;
      }
      port.drain(drainError => (drainError ? reject(drainError) : resolve()));
    });
  });
}

function setPortSignals(port, signals) {
  return new Promise((resolve, reject) => {
    port.set(signals, error => (error ? reject(error) : resolve()));
  });
}

class SerialSession {
  constructor(options = {}) {
    this.sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : null;
    this.SerialPortClass = options.SerialPortClass || loadSerialPortClass();
    this.port = null;
    this.options = null;
    this.rxBytes = 0;
    this.txBytes = 0;
    this.connectedAt = 0;
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
      state: this.connected ? 'connected' : 'idle',
      connected: this.connected,
      portPath: this.options?.path || '',
      options: this.options || {},
      signals: { ...this.signals },
      rxBytes: this.rxBytes,
      txBytes: this.txBytes,
      connectedAt: this.connectedAt,
      pid: process.pid
    };
  }

  async connect(options = {}) {
    const serialOptions = normalizeSerialOptions(options);
    if (this.connected) await this.disconnect();

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
    nextPort.on('data', data => this.handleData(data));
    nextPort.on('error', error => this.emit('serial.error', { message: asError(error) }));
    nextPort.on('close', () => {
      const wasConnected = this.port === nextPort;
      if (wasConnected) {
        this.port = null;
        this.options = null;
      }
      this.emit('serial.closed', this.status());
    });

    await openPort(nextPort);
    this.port = nextPort;
    this.options = serialOptions;
    this.rxBytes = 0;
    this.txBytes = 0;
    this.connectedAt = Date.now();
    this.emit('serial.opened', this.status());
    return this.status();
  }

  async disconnect() {
    const activePort = this.port;
    this.port = null;
    this.options = null;
    await closePort(activePort);
    const status = this.status();
    this.emit('serial.closed', status);
    return status;
  }

  async write(options = {}) {
    if (!this.connected || !this.port) throw new Error('Serial port is not connected');
    const payload = encodePayload(options);
    await writePort(this.port, payload);
    this.txBytes += payload.length;

    const data = {
      ...formatChunk(payload),
      portPath: this.options?.path || '',
      txBytes: this.txBytes,
      timestamp: Date.now()
    };
    this.emit('serial.tx', data);
    return data;
  }

  async setSignals(options = {}) {
    if (!this.connected || !this.port) throw new Error('Serial port is not connected');
    const signals = {};

    if (options.dtr !== undefined || options.dataTerminalReady !== undefined) {
      signals.dtr = Boolean(options.dtr ?? options.dataTerminalReady);
    }
    if (options.rts !== undefined || options.requestToSend !== undefined) {
      signals.rts = Boolean(options.rts ?? options.requestToSend);
    }
    if (options.brk !== undefined || options.break !== undefined) {
      signals.brk = Boolean(options.brk ?? options.break);
    }

    if (options.signal) {
      const key = String(options.signal).toLowerCase();
      if (key === 'dtr' || key === 'rts' || key === 'brk') {
        signals[key] = options.state === undefined ? !this.signals[key] : Boolean(options.state);
      }
    }

    if (!Object.keys(signals).length) throw new Error('No serial signal was provided');
    await setPortSignals(this.port, signals);
    this.signals = { ...this.signals, ...signals };
    const result = { signals: { ...this.signals }, timestamp: Date.now() };
    this.emit('serial.signal', result);
    return result;
  }

  async cleanup() {
    await this.disconnect();
    return { closing: true };
  }

  handleData(data) {
    const payload = Buffer.from(data || []);
    this.rxBytes += payload.length;
    this.emit('serial.rx', {
      ...formatChunk(payload),
      portPath: this.options?.path || '',
      rxBytes: this.rxBytes,
      timestamp: Date.now()
    });
  }

  emit(event, data = {}) {
    if (this.sendEvent) this.sendEvent(event, data);
  }
}

function createSerialDebuggerCore(options = {}) {
  const sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : null;
  const session = new SerialSession({ sendEvent });

  async function listSerialPorts() {
    const SerialPort = loadSerialPortClass();
    const ports = await SerialPort.list();
    return ports.map(serializePortInfo);
  }

  async function executeAction(message = {}) {
    const action = message.action || message.method;
    const params = message.params || message.data || message;

    switch (action) {
      case 'status':
        return session.status();
      case 'serial.list':
      case 'ports':
        return { ports: await listSerialPorts() };
      case 'serial.connect':
      case 'connect':
        return await session.connect(params);
      case 'serial.disconnect':
      case 'disconnect':
        return await session.disconnect();
      case 'serial.write':
      case 'write':
        return await session.write(params);
      case 'serial.signal':
      case 'signal':
        return await session.setSignals(params);
      case 'shutdown':
        return await session.cleanup();
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  return {
    status: () => session.status(),
    listSerialPorts,
    connect: options => session.connect(options),
    disconnect: () => session.disconnect(),
    write: options => session.write(options),
    setSignals: options => session.setSignals(options),
    cleanup: () => session.cleanup(),
    executeAction
  };
}

module.exports = {
  asError,
  createSerialDebuggerCore,
  encodePayload,
  formatChunk,
  normalizeSerialOptions
};
