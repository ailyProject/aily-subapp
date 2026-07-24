'use strict';

const { EventEmitter } = require('events');

class FakeSerialPort extends EventEmitter {
  static ports = [
    {
      path: 'COM_TEST',
      friendlyName: 'Fake Serial Port',
      manufacturer: 'Aily',
      vendorId: '1234',
      productId: '5678',
      serialNumber: 'FAKE-001'
    }
  ];

  static instances = [];
  static failOpen = null;
  static onWrite = null;

  static async list() {
    return this.ports.map(port => ({ ...port }));
  }

  static reset() {
    this.instances = [];
    this.failOpen = null;
    this.onWrite = null;
  }

  constructor(options = {}) {
    super();
    this.options = { ...options };
    this.path = options.path;
    this.isOpen = false;
    this.writes = [];
    this.signals = {};
    FakeSerialPort.instances.push(this);
  }

  open(callback) {
    queueMicrotask(() => {
      if (FakeSerialPort.failOpen) {
        callback(FakeSerialPort.failOpen);
        return;
      }
      this.isOpen = true;
      callback(null);
    });
  }

  close(callback) {
    if (!this.isOpen) {
      queueMicrotask(() => callback?.(null));
      return;
    }
    this.isOpen = false;
    queueMicrotask(() => {
      this.emit('close');
      callback?.(null);
    });
  }

  write(buffer, callback) {
    const payload = Buffer.from(buffer);
    this.writes.push(payload);
    queueMicrotask(() => {
      callback?.(null);
      if (typeof FakeSerialPort.onWrite === 'function') {
        FakeSerialPort.onWrite(this, payload);
      }
    });
  }

  drain(callback) {
    queueMicrotask(() => callback?.(null));
  }

  set(signals, callback) {
    this.signals = { ...this.signals, ...signals };
    queueMicrotask(() => callback?.(null));
  }

  receive(data) {
    if (!this.isOpen) return;
    this.emit('data', Buffer.from(data));
  }
}

module.exports = {
  FakeSerialPort
};
