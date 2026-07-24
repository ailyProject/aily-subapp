'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createSerialDebuggerCore,
  encodePayload,
  normalizeSerialError,
  normalizeSerialOptions
} = require('../core');
const { FakeSerialPort } = require('./fake-serial-port');

test.beforeEach(() => {
  FakeSerialPort.reset();
});

test('normalizes the default baud rate consistently', () => {
  assert.equal(normalizeSerialOptions({ port: 'COM_TEST' }).baudRate, 115200);
});

test('rejects malformed HEX instead of silently changing it', () => {
  assert.throws(
    () => encodePayload({ mode: 'hex', data: '01 GG 03' }),
    error => error.code === 'INVALID_HEX'
  );
  assert.throws(
    () => encodePayload({ mode: 'hex', data: '01 2' }),
    error => error.code === 'INVALID_HEX'
  );
  assert.deepEqual(
    encodePayload({ mode: 'hex', data: '0x01, 0x02:03' }),
    Buffer.from([1, 2, 3])
  );
});

test('normalizes Windows access denied as a recoverable port ownership conflict', () => {
  const error = normalizeSerialError(
    new Error('Opening COM3: Access denied'),
    'open',
    { portPath: 'COM3' }
  );
  assert.equal(error.code, 'PORT_BUSY');
  assert.equal(error.details.portPath, 'COM3');
  assert.equal(error.details.recoverable, true);
  assert.match(error.details.guidance, /Close other serial monitors/i);
});

test('uses the injected SerialPort class for listing and sessions', async () => {
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  const ports = await core.listSerialPorts();
  assert.equal(ports.length, 1);
  assert.equal(ports[0].path, 'COM_TEST');

  await core.connect({ port: 'COM_TEST' });
  assert.equal(FakeSerialPort.instances.length, 1);
  assert.equal(core.status().connected, true);
  await core.cleanup();
});

test('emits serial.closed only once for an intentional disconnect', async () => {
  const receivedEvents = [];
  const core = createSerialDebuggerCore({
    SerialPortClass: FakeSerialPort,
    sendEvent: (event, _data, envelope) => receivedEvents.push(envelope || { event })
  });

  await core.connect({ port: 'COM_TEST' });
  await core.disconnect();
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(receivedEvents.filter(event => event.event === 'serial.closed').length, 1);
});

test('distinguishes an unexpected device disconnect from an intentional close', async () => {
  const receivedEvents = [];
  const core = createSerialDebuggerCore({
    SerialPortClass: FakeSerialPort,
    sendEvent: (event, _data, envelope) => receivedEvents.push(envelope || { event })
  });

  await core.connect({ port: 'COM_TEST' });
  await new Promise(resolve => FakeSerialPort.instances[0].close(resolve));
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(core.status().state, 'disconnected');
  assert.equal(core.status().connected, false);
  assert.equal(core.status().portPath, 'COM_TEST');
  assert.equal(core.status().lastError.code, 'DEVICE_DISCONNECTED');
  assert.equal(receivedEvents.filter(event => event.event === 'serial.disconnected').length, 1);
  assert.equal(receivedEvents.filter(event => event.event === 'serial.closed').length, 0);
  await core.cleanup();
});

test('fails a pending transaction immediately when the device disconnects', async () => {
  FakeSerialPort.onWrite = port => queueMicrotask(() => port.close());
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });

  await assert.rejects(
    core.transact({
      send: { mode: 'text', data: 'PING' },
      expect: { type: 'text', value: 'PONG' },
      timeoutMs: 10000
    }),
    error => error.code === 'DEVICE_DISCONNECTED'
  );
  const failed = core.readLogs({
    afterSeq: 0,
    events: ['serial.transaction.failed']
  }).events;
  assert.equal(failed[0].data.errorCode, 'DEVICE_DISCONNECTED');
  assert.equal(core.status().state, 'disconnected');
  await core.cleanup();
});

test('decodes UTF-8 characters that span serial chunks', async () => {
  const receivedEvents = [];
  const core = createSerialDebuggerCore({
    SerialPortClass: FakeSerialPort,
    sendEvent: (event, _data, envelope) => receivedEvents.push(envelope || { event })
  });
  await core.connect({ port: 'COM_TEST' });
  const port = FakeSerialPort.instances[0];
  const bytes = Buffer.from('温度');
  port.receive(bytes.subarray(0, 2));
  port.receive(bytes.subarray(2, 4));
  port.receive(bytes.subarray(4));

  const text = receivedEvents
    .filter(event => event.event === 'serial.rx')
    .map(event => event.data.text)
    .join('');
  assert.equal(text, '温度');
  await core.cleanup();
});

test('transact sends data and waits for a matching response', async () => {
  FakeSerialPort.onWrite = (port, payload) => {
    assert.equal(payload.toString('utf8'), 'AT\r\n');
    queueMicrotask(() => port.receive('OK\r\n'));
  };
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST', baudRate: 115200 });

  const result = await core.transact({
    send: {
      mode: 'text',
      data: 'AT',
      appendCr: true,
      appendLf: true
    },
    expect: {
      type: 'regex',
      pattern: 'OK|ERROR'
    },
    timeoutMs: 1000
  });

  assert.equal(result.matched, true);
  assert.equal(result.capture.text, 'OK\r\n');
  assert.ok(result.startSeq > 0);
  const logs = core.readLogs({ afterSeq: 0, limit: 100 });
  assert.deepEqual(
    logs.events.map(event => event.event),
    [
      'serial.opened',
      'serial.transaction.started',
      'serial.tx',
      'serial.rx',
      'serial.transaction.completed'
    ]
  );
  assert.ok(result.transactionId);
  await core.cleanup();
});

test('transact returns a bounded preview for a large serial response', async () => {
  const payload = '温'.repeat(40000);
  FakeSerialPort.onWrite = port => queueMicrotask(() => port.receive(payload));
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });

  const result = await core.transact({
    send: { mode: 'text', data: 'DUMP' },
    expect: { type: 'any' },
    maxBytes: 256 * 1024,
    previewBytes: 2048,
    timeoutMs: 1000
  });

  assert.equal(result.matched, true);
  assert.equal(result.capture.byteLength, Buffer.byteLength(payload, 'utf8'));
  assert.equal(result.capture.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 48 * 1024);
  await core.cleanup();
});

test('transact returns a structured timeout error with captured evidence', async () => {
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });

  await assert.rejects(
    core.transact({
      send: { mode: 'text', data: 'NO_REPLY' },
      expect: { type: 'text', value: 'OK' },
      timeoutMs: 20
    }),
    error => error.code === 'EXPECT_TIMEOUT'
      && error.details.timeoutMs === 20
      && error.details.capture.byteLength === 0
  );
  const failed = core.readLogs({
    afterSeq: 0,
    events: ['serial.transaction.failed']
  }).events;
  assert.equal(failed.length, 1);
  assert.equal(failed[0].data.errorCode, 'EXPECT_TIMEOUT');
  await core.cleanup();
});

test('pulses DTR explicitly and restores the final state', async () => {
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });
  const result = await core.pulseSignal({
    signal: 'dtr',
    activeState: 'true',
    finalState: 'false',
    durationMs: 1
  });

  assert.equal(result.activeState, true);
  assert.equal(result.finalState, false);
  assert.equal(FakeSerialPort.instances[0].signals.dtr, false);
  await core.cleanup();
});

test('cleans up a failed open attempt', async () => {
  const openError = new Error('Access denied');
  openError.code = 'EACCES';
  FakeSerialPort.failOpen = openError;
  const events = [];
  const core = createSerialDebuggerCore({
    SerialPortClass: FakeSerialPort,
    sendEvent: (event, data) => events.push({ event, data })
  });

  await assert.rejects(
    core.connect({ port: 'COM_TEST' }),
    error => error.code === 'PORT_BUSY' && /Access denied/.test(error.message)
  );
  assert.equal(core.status().connected, false);
  assert.equal(core.status().state, 'error');
  assert.equal(FakeSerialPort.instances[0].listenerCount('data'), 0);
  assert.equal(events.at(-1).event, 'serial.error');
  assert.equal(events.at(-1).data.code, 'PORT_BUSY');
});
