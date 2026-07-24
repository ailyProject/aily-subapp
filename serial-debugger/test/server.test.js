'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WebSocket } = require('ws');
const { startSerialDebuggerServer } = require('../server');
const { FakeSerialPort } = require('./fake-serial-port');

test.beforeEach(() => {
  FakeSerialPort.reset();
});

test('WebSocket RPC shares Runtime state and supports transact plus log replay', async () => {
  FakeSerialPort.onWrite = (port, payload) => {
    if (payload.toString('utf8') === 'PING\n') {
      queueMicrotask(() => port.receive('PONG\n'));
    }
  };
  const server = await startSerialDebuggerServer({
    host: '127.0.0.1',
    port: 0,
    token: 'test-token',
    journal: false,
    SerialPortClass: FakeSerialPort
  });
  const socket = new WebSocket(server.wsUrl);
  const messages = [];
  const pending = new Map();
  let requestId = 0;

  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) resolve(message.result);
      else {
        const error = new Error(message.error);
        error.response = message;
        reject(error);
      }
    }
  });

  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = `test-${++requestId}`;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, context: { actor: 'agent' } }));
  });

  const opened = await request('serial.session.open', {
    port: 'COM_TEST',
    baudRate: 115200
  });
  assert.equal(opened.connected, true);

  const transaction = await request('serial.transact', {
    send: {
      mode: 'text',
      data: 'PING',
      appendLf: true
    },
    expect: {
      type: 'text',
      value: 'PONG'
    },
    timeoutMs: 1000
  });
  assert.equal(transaction.matched, true);
  assert.equal(transaction.capture.text, 'PONG\n');

  const logs = await request('serial.log.read', { afterSeq: 0, limit: 100 });
  assert.ok(logs.events.some(event => event.event === 'serial.tx'));
  assert.ok(logs.events.some(event => event.event === 'serial.rx'));
  const tail = await request('serial.log.tail', { limit: 2, maxBytes: 8192 });
  assert.equal(tail.source, 'memory');
  assert.ok(tail.events.length <= 2);
  assert.ok(Buffer.byteLength(JSON.stringify(tail), 'utf8') <= 8192);
  assert.ok(messages.some(message => message.event === 'serial.tx' && message.actor === 'agent'));
  assert.ok(messages.some(message => message.event === 'serial.rx' && message.actor === 'device'));
  assert.ok(messages.some(message => message.event === 'serial.transaction.started' && message.actor === 'agent'));
  assert.ok(messages.some(message => message.event === 'serial.transaction.completed' && message.actor === 'agent'));

  await request('serial.session.close');
  await assert.rejects(
    request('serial.transact', {
      send: { mode: 'text', data: 'AFTER_CLOSE' },
      timeoutMs: 20
    }),
    error => error.response?.errorCode === 'PORT_DISCONNECTED'
  );

  socket.close();
  await new Promise(resolve => socket.once('close', resolve));
  await server.stop();
});

test('WebSocket RPC cancels active transact and scenario requests without closing the shared session', async () => {
  const server = await startSerialDebuggerServer({
    host: '127.0.0.1',
    port: 0,
    token: 'cancel-token',
    journal: false,
    SerialPortClass: FakeSerialPort
  });
  const socket = new WebSocket(server.wsUrl);
  const messages = [];
  const pending = new Map();
  let requestId = 0;

  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.ok) resolve(message.result);
      else {
        const error = new Error(message.error);
        error.response = message;
        reject(error);
      }
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  const request = (method, params = {}, explicitId = '') => new Promise((resolve, reject) => {
    const id = explicitId || `cancel-test-${++requestId}`;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, context: { actor: 'agent' } }));
  });

  await request('serial.session.open', { port: 'COM_TEST', baudRate: 115200 });

  const transactionStartedAt = Date.now();
  const transaction = request('serial.transact', {
    send: { mode: 'text', data: 'WAIT_FOREVER' },
    expect: { type: 'text', value: 'NEVER' },
    timeoutMs: 10000
  }, 'long-transaction');
  const transactionCancelled = assert.rejects(
    transaction,
    error => error.response?.errorCode === 'OPERATION_CANCELLED'
  );
  await waitForMessage(messages, message => message.event === 'serial.transaction.started');
  const cancelTransaction = await request('runtime.request.cancel', {
    requestId: 'long-transaction'
  });
  assert.equal(cancelTransaction.cancelled, true);
  await transactionCancelled;
  assert.ok(Date.now() - transactionStartedAt < 2000);
  assert.ok(messages.some(message =>
    message.event === 'serial.transaction.failed'
    && message.data?.errorCode === 'OPERATION_CANCELLED'
  ));

  const scenario = request('serial.scenario.run', {
    name: 'cancellable wait',
    timeoutMs: 10000,
    steps: [{ action: 'wait', durationMs: 8000 }]
  }, 'long-scenario');
  const scenarioCancelled = assert.rejects(
    scenario,
    error => error.response?.errorCode === 'OPERATION_CANCELLED'
  );
  await waitForMessage(messages, message => message.event === 'serial.scenario.step.started');
  const cancelScenario = await request('runtime.request.cancel', {
    requestId: 'long-scenario'
  });
  assert.equal(cancelScenario.cancelled, true);
  await scenarioCancelled;
  assert.ok(messages.some(message => message.event === 'serial.scenario.cancelled'));

  const status = await request('serial.session.status');
  assert.equal(status.connected, true);
  await request('serial.session.close');
  socket.close();
  await new Promise(resolve => socket.once('close', resolve));
  await server.stop();
});

async function waitForMessage(messages, predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (messages.some(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for WebSocket message');
}
