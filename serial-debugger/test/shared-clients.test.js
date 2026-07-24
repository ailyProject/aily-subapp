'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { WebSocket } = require('ws');
const { startSerialDebuggerServer } = require('../server');
const { callSerialRuntime } = require('../runtime/rpc-client');
const { FakeSerialPort } = require('./fake-serial-port');

test.beforeEach(() => {
  FakeSerialPort.reset();
});

test('UI, Agent, and CLI clients share one Runtime session and event stream', { timeout: 10000 }, async t => {
  FakeSerialPort.onWrite = (port, payload) => {
    if (payload.toString('utf8') === 'AGENT_PING\n') {
      queueMicrotask(() => port.receive('DEVICE_PONG\n'));
    }
  };
  const server = await startSerialDebuggerServer({
    host: '127.0.0.1',
    port: 0,
    token: 'shared-clients-token',
    journal: false,
    SerialPortClass: FakeSerialPort
  });
  const ui = await connectClient(server.wsUrl, 'ui');
  const agent = await connectClient(server.wsUrl, 'agent');
  t.after(async () => {
    await Promise.allSettled([ui.close(), agent.close()]);
    await server.stop().catch(() => undefined);
  });

  const opened = await ui.request('serial.session.open', {
    port: 'COM_TEST',
    baudRate: 115200
  });
  assert.equal(opened.connected, true);

  const [uiSnapshot, agentSnapshot, cliSnapshot] = await Promise.all([
    ui.request('runtime.snapshot'),
    agent.request('runtime.snapshot'),
    callSerialRuntime({ wsUrl: server.wsUrl }, 'runtime.snapshot', {}, {
      actor: 'cli',
      actorId: 'shared-client-test'
    })
  ]);
  assert.equal(uiSnapshot.sessionId, agentSnapshot.sessionId);
  assert.equal(agentSnapshot.sessionId, cliSnapshot.sessionId);

  const transaction = await agent.request('serial.transact', {
    send: {
      mode: 'text',
      data: 'AGENT_PING',
      appendLf: true
    },
    expect: {
      type: 'text',
      value: 'DEVICE_PONG'
    },
    timeoutMs: 1000
  });
  assert.equal(transaction.matched, true);
  assert.equal(transaction.capture.text, 'DEVICE_PONG\n');

  await callSerialRuntime({ wsUrl: server.wsUrl }, 'serial.send', {
    mode: 'text',
    data: 'CLI_WRITE',
    appendLf: true
  }, {
    actor: 'cli',
    actorId: 'shared-client-test'
  });

  await waitForMessage(ui.messages, message =>
    message.event === 'serial.tx' && message.actor === 'cli'
  );
  await waitForMessage(agent.messages, message =>
    message.event === 'serial.tx' && message.actor === 'cli'
  );
  assert.ok(ui.messages.some(message =>
    message.event === 'serial.transaction.completed' && message.actor === 'agent'
  ));
  assert.ok(agent.messages.some(message =>
    message.event === 'serial.rx' && message.actor === 'device'
  ));

  const status = await agent.request('serial.session.status');
  assert.equal(status.connected, true);
  assert.equal(status.portPath, 'COM_TEST');

  const abortController = new AbortController();
  const cliTransaction = callSerialRuntime({ wsUrl: server.wsUrl }, 'serial.transact', {
    send: { mode: 'text', data: 'CLI_CANCEL' },
    expect: { type: 'text', value: 'NEVER' },
    timeoutMs: 10000
  }, {
    actor: 'cli',
    actorId: 'shared-client-test',
    timeoutMs: 15000,
    signal: abortController.signal
  });
  const cliCancelled = assert.rejects(
    cliTransaction,
    error => error.code === 'SERIAL_RPC_CANCELLED'
  );
  await waitForMessage(ui.messages, message =>
    message.event === 'serial.transaction.started' && message.actor === 'cli'
  );
  abortController.abort();
  await cliCancelled;
  await waitForMessage(agent.messages, message =>
    message.event === 'serial.transaction.failed'
    && message.actor === 'cli'
    && message.data?.errorCode === 'OPERATION_CANCELLED'
  );

  await ui.request('serial.session.close');
  await Promise.all([ui.close(), agent.close()]);
  await server.stop();
});

async function connectClient(wsUrl, actor) {
  const socket = new WebSocket(wsUrl);
  const messages = [];
  const pending = new Map();
  let requestSequence = 0;

  socket.on('message', raw => {
    const message = JSON.parse(String(raw));
    messages.push(message);
    const request = pending.get(String(message.id || ''));
    if (!request) return;
    pending.delete(String(message.id));
    if (message.ok === true) request.resolve(message.result);
    else {
      const error = new Error(message.error || 'Runtime request failed');
      error.response = message;
      request.reject(error);
    }
  });
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });

  return {
    messages,
    request(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = `${actor}-${++requestSequence}`;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({
          id,
          method,
          params,
          context: {
            actor,
            actorId: `${actor}-shared-client-test`
          }
        }));
      });
    },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
      const closed = new Promise(resolve => socket.once('close', resolve));
      socket.close();
      return closed;
    }
  };
}

async function waitForMessage(messages, predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (messages.some(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for shared Runtime event');
}
