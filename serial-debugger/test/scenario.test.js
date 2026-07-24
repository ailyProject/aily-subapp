'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSerialDebuggerCore } = require('../core');
const { FakeSerialPort } = require('./fake-serial-port');

test.beforeEach(() => {
  FakeSerialPort.reset();
});

test('runs a bounded multi-step scenario against one persistent serial session', async () => {
  FakeSerialPort.onWrite = (port, payload) => {
    if (payload.toString('utf8') === 'AT\r\n') {
      queueMicrotask(() => port.receive('OK\r\n'));
    }
  };
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });

  const result = await core.runScenario({
    name: 'AT smoke',
    steps: [
      {
        stepId: 'hello',
        action: 'transact',
        send: { mode: 'text', data: 'AT', appendCr: true, appendLf: true },
        expect: { type: 'text', value: 'OK' },
        timeoutMs: 1000
      },
      { stepId: 'settle', action: 'wait', durationMs: 1 },
      { stepId: 'dtr', action: 'signal', signal: 'dtr', state: true },
      { stepId: 'write', action: 'send', send: { mode: 'hex', data: '01 02' } }
    ]
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.completedSteps, 4);
  assert.equal(result.failedSteps, 0);
  assert.equal(result.steps[0].matched, true);
  assert.equal(FakeSerialPort.instances[0].signals.dtr, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 48 * 1024);

  const scenarioEvents = core.readLogs({
    afterSeq: 0,
    events: [
      'serial.scenario.started',
      'serial.scenario.step.started',
      'serial.scenario.step.completed',
      'serial.scenario.completed'
    ],
    limit: 100
  }).events;
  assert.equal(scenarioEvents[0].actor, 'agent');
  assert.equal(scenarioEvents.filter(event => event.event === 'serial.scenario.step.completed').length, 4);
  await core.cleanup();
});

test('stops a scenario on a failed expectation and preserves structured evidence', async () => {
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });

  const result = await core.runScenario({
    stopOnFailure: true,
    steps: [
      {
        stepId: 'timeout',
        action: 'transact',
        send: { mode: 'text', data: 'NO_REPLY' },
        expect: { type: 'text', value: 'OK' },
        timeoutMs: 20
      },
      {
        stepId: 'must-not-run',
        action: 'send',
        send: { mode: 'text', data: 'SECOND' }
      }
    ]
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.failedSteps, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].errorCode, 'EXPECT_TIMEOUT');
  assert.equal(FakeSerialPort.instances[0].writes.length, 1);
  await core.cleanup();
});
