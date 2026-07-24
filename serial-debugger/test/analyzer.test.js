'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createSerialDebuggerCore } = require('../core');
const { analyzeSerialEvents } = require('../runtime/analyzer');
const { FakeSerialPort } = require('./fake-serial-port');

test.beforeEach(() => {
  FakeSerialPort.reset();
});

test('detects timeout, missing RX, and firmware fault evidence with bounded findings', () => {
  const events = [
    event(1, 'serial.tx', { text: 'AT', byteLength: 2 }),
    event(2, 'serial.transaction.failed', { errorCode: 'EXPECT_TIMEOUT' }),
    event(3, 'serial.rx', { text: 'HardFault in task\n', byteLength: 18 }),
    event(4, 'serial.error', { message: 'device disconnected' })
  ];
  const result = analyzeSerialEvents(events);

  assert.equal(result.verdict, 'errors-detected');
  assert.ok(result.findings.some(finding => finding.code === 'EXPECT_TIMEOUT'));
  assert.ok(result.findings.some(finding => finding.code === 'FIRMWARE_FAULT_TEXT'));
  assert.ok(result.findings.some(finding => finding.code === 'SERIAL_RUNTIME_ERROR'));
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 48 * 1024);
});

test('runs analysis through the shared Runtime and emits visible lifecycle events', async () => {
  const core = createSerialDebuggerCore({ SerialPortClass: FakeSerialPort });
  await core.connect({ port: 'COM_TEST' });
  FakeSerialPort.instances[0].receive('booting\n');
  FakeSerialPort.instances[0].receive('reset reason: watchdog\n');
  FakeSerialPort.instances[0].receive('booting\n');

  const result = await core.runAnalysis({ afterSeq: 0 });
  assert.equal(result.source, 'memory');
  assert.ok(result.findings.some(finding => finding.code === 'POSSIBLE_RESET_LOOP'));
  const lifecycle = core.readLogs({
    afterSeq: 0,
    events: ['serial.analysis.started', 'serial.analysis.completed']
  }).events;
  assert.deepEqual(lifecycle.map(item => item.event), [
    'serial.analysis.started',
    'serial.analysis.completed'
  ]);
  await core.cleanup();
});

function event(seq, name, data) {
  return {
    protocolVersion: 1,
    seq,
    timestamp: 1000 + seq * 10,
    sessionId: 'serial-analysis-test',
    actor: name === 'serial.rx' ? 'device' : 'agent',
    event: name,
    data
  };
}
