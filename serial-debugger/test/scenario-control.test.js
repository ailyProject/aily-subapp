'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSerialDebuggerCore } = require('../core');
const { FakeSerialPort } = require('./fake-serial-port');

test.beforeEach(() => {
  FakeSerialPort.reset();
});

test('pauses a scenario at a safe wait checkpoint, blocks external writes, and resumes', async () => {
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });

  const scenario = core.runScenario({
    name: 'pause-resume',
    steps: [
      { stepId: 'pause-window', action: 'wait', durationMs: 250 },
      { stepId: 'agent-write', action: 'send', send: { mode: 'text', data: 'AGENT' } }
    ]
  }, { actor: 'agent', actorId: 'agent-pause' });

  await waitFor(() => core.scenarioControl({ action: 'status' })
    .then(status => status.scenario?.currentStep?.stepId === 'pause-window'));
  await core.scenarioControl(
    { action: 'pause', reason: 'inspect device' },
    { actor: 'ui', actorId: 'ui-pause' }
  );
  await waitForState(core, 'paused');

  await assert.rejects(
    core.executeAction({
      action: 'serial.send',
      params: { mode: 'text', data: 'BLOCKED' },
      context: { actor: 'ui', actorId: 'ui-pause' }
    }),
    error => error.code === 'SCENARIO_CONTROL_REQUIRED'
  );
  assert.equal(FakeSerialPort.instances[0].writes.length, 0);

  await core.scenarioControl(
    { action: 'resume', reason: 'inspection complete' },
    { actor: 'ui', actorId: 'ui-pause' }
  );
  const result = await scenario;
  assert.equal(result.status, 'completed');
  assert.equal(FakeSerialPort.instances[0].writes[0].toString('utf8'), 'AGENT');
  assert.ok(result.pausedDurationMs > 0);
  assert.equal((await core.scenarioControl({ action: 'status' })).active, false);
  await core.cleanup();
});

test('manual takeover grants one UI actor serial control and release keeps the scenario paused', async () => {
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });

  let settled = false;
  const scenario = core.runScenario({
    name: 'manual-takeover',
    steps: [
      { stepId: 'manual-window', action: 'wait', durationMs: 300 },
      { stepId: 'agent-write', action: 'send', send: { mode: 'text', data: 'AGENT' } }
    ]
  }, { actor: 'agent', actorId: 'agent-owner' }).finally(() => {
    settled = true;
  });

  await waitFor(() => core.scenarioControl({ action: 'status' })
    .then(status => status.scenario?.currentStep?.stepId === 'manual-window'));
  await core.scenarioControl(
    { action: 'takeover', reason: 'manual probe' },
    { actor: 'ui', actorId: 'ui-owner' }
  );
  await waitForState(core, 'taken_over');

  await core.executeAction({
    action: 'serial.send',
    params: { mode: 'text', data: 'UI' },
    context: { actor: 'ui', actorId: 'ui-owner' }
  });
  await assert.rejects(
    core.executeAction({
      action: 'serial.send',
      params: { mode: 'text', data: 'OTHER' },
      context: { actor: 'agent', actorId: 'other-agent' }
    }),
    error => error.code === 'SCENARIO_CONTROL_REQUIRED'
  );

  const released = await core.scenarioControl(
    { action: 'release', reason: 'manual probe complete' },
    { actor: 'ui', actorId: 'ui-owner' }
  );
  assert.equal(released.scenario.state, 'paused');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(settled, false);

  await core.scenarioControl(
    { action: 'resume' },
    { actor: 'agent', actorId: 'agent-owner' }
  );
  const result = await scenario;
  assert.equal(result.status, 'completed');
  assert.deepEqual(
    FakeSerialPort.instances[0].writes.map(payload => payload.toString('utf8')),
    ['UI', 'AGENT']
  );
  await core.cleanup();
});

test('scenario control cancellation aborts the current transaction and keeps the port open', async () => {
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });

  const scenario = core.runScenario({
    name: 'cancel-control',
    steps: [{
      stepId: 'pending-transaction',
      action: 'transact',
      send: { mode: 'text', data: 'PING' },
      expect: { type: 'text', value: 'NEVER' },
      timeoutMs: 10000
    }]
  }, { actor: 'agent', actorId: 'agent-cancel' });

  await waitFor(() => core.readLogs({
    afterSeq: 0,
    events: ['serial.transaction.started'],
    limit: 10
  }).events.length === 1);
  const cancelling = await core.scenarioControl(
    { action: 'cancel', reason: 'user stop' },
    { actor: 'ui', actorId: 'ui-cancel' }
  );
  assert.equal(cancelling.scenario.state, 'cancelling');

  await assert.rejects(scenario, error => error.code === 'OPERATION_CANCELLED');
  const controlStatus = await core.scenarioControl({ action: 'status' });
  assert.equal(controlStatus.active, false);
  assert.equal(controlStatus.lastScenario.state, 'cancelled');
  assert.equal(core.status().connected, true);
  await core.cleanup();
});

async function waitForState(core, expectedState) {
  await waitFor(async () => {
    const status = await core.scenarioControl({ action: 'status' });
    return status.scenario?.state === expectedState;
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for scenario control state');
}
