'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { runCli } = require('../cli');

function outputBuffer() {
  let value = '';
  return {
    stdout: {
      write(chunk) {
        value += String(chunk);
      }
    },
    json() {
      return JSON.parse(value);
    }
  };
}

test('CLI transact forwards expectation options and returns one JSON document', async () => {
  const output = outputBuffer();
  const calls = [];
  const core = {
    async connect(options) {
      calls.push(['connect', options]);
    },
    async transact(options) {
      calls.push(['transact', options]);
      return { matched: true, capture: { text: 'OK\r\n' } };
    },
    async cleanup() {
      calls.push(['cleanup']);
    }
  };

  const exitCode = await runCli('transact', [
    '--port', 'COM5',
    '--baud', '115200',
    '--text', 'AT',
    '--cr',
    '--lf',
    '--expect-regex', 'OK|ERROR',
    '--timeout', '2500'
  ], {
    createCore: () => core,
    stdout: output.stdout
  });

  assert.equal(exitCode, 0);
  assert.equal(output.json().ok, true);
  assert.deepEqual(calls[1], ['transact', {
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
    timeoutMs: 2500,
    quietMs: 200,
    maxBytes: 65536
  }]);
  assert.deepEqual(calls.at(-1), ['cleanup']);
});

test('CLI returns structured error metadata', async () => {
  const output = outputBuffer();
  const expectedError = new Error('Expected OK was not observed');
  expectedError.code = 'EXPECT_TIMEOUT';
  expectedError.details = { timeoutMs: 20 };
  const core = {
    async connect() {},
    async transact() {
      throw expectedError;
    },
    async cleanup() {}
  };

  const exitCode = await runCli('transact', [
    '--port', 'COM5',
    '--text', 'AT',
    '--expect', 'OK'
  ], {
    createCore: () => core,
    stdout: output.stdout
  });

  const result = output.json();
  assert.equal(exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'EXPECT_TIMEOUT');
  assert.deepEqual(result.details, { timeoutMs: 20 });
});

test('CLI rejects host UI presentation flags instead of silently claiming success', async () => {
  const output = outputBuffer();
  let daemonCalled = false;

  const exitCode = await runCli('open', [
    '--port', 'COM3',
    '--baud', '115200',
    '--present-ui', 'embedded'
  ], {
    daemonClient: {
      async command() {
        daemonCalled = true;
        return { state: 'connected' };
      }
    },
    stdout: output.stdout
  });

  const result = output.json();
  assert.equal(exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'CLI_UI_PRESENTATION_UNSUPPORTED');
  assert.match(result.error, /cannot present an embedded\/window host UI/i);
  assert.equal(daemonCalled, false);
});

test('CLI daemon mode reuses the persistent client instead of creating a core', async () => {
  const output = outputBuffer();
  const calls = [];
  const daemonClient = {
    async start(options) {
      calls.push(['start', options.runtimeDir]);
      return { running: true, sessionId: 'serial-daemon-test' };
    },
    async status() {
      return { running: true };
    },
    async stop() {
      return { stopped: true };
    },
    async command(request) {
      calls.push(['command', request]);
      return { sessionId: 'serial-daemon-test', state: { connected: false } };
    }
  };

  const exitCode = await runCli('daemon', [
    'start',
    '--runtime-dir',
    'D:\\runtime'
  ], {
    daemonClient,
    createCore: () => {
      throw new Error('one-shot core must not be created');
    },
    stdout: output.stdout
  });

  assert.equal(exitCode, 0);
  const result = output.json();
  assert.equal(result.data.sessionId, 'serial-daemon-test');
  assert.equal(result.lifecycle.cleanupRequired, true);
  assert.deepEqual(result.lifecycle.cleanupCommands, [
    'aily-serial-debugger close',
    'aily-serial-debugger daemon stop'
  ]);
  assert.deepEqual(calls, [['start', 'D:\\runtime']]);
});

test('CLI open reports that the persistent daemon may still hold the serial port', async () => {
  const output = outputBuffer();

  const exitCode = await runCli('open', [
    '--port', 'COM3',
    '--baud', '115200'
  ], {
    daemonClient: {
      async command() {
        return {
          state: 'connected',
          connected: true,
          portPath: 'COM3'
        };
      }
    },
    stdout: output.stdout
  });

  const result = output.json();
  assert.equal(exitCode, 0);
  assert.equal(result.lifecycle.persistentRuntime, true);
  assert.equal(result.lifecycle.serialPortMayRemainOpen, true);
  assert.equal(result.lifecycle.cleanupRequired, true);
  assert.match(result.lifecycle.guidance, /before firmware upload/i);
});

test('CLI reports automatic cleanup for an Agent-hosted session lease', async () => {
  const output = outputBuffer();

  const exitCode = await runCli('open', [
    '--port', 'COM3',
    '--lease-file', 'D:\\runtime\\session-lease.json'
  ], {
    daemonClient: {
      async command() {
        return { connected: true, portPath: 'COM3' };
      }
    },
    stdout: output.stdout
  });

  const result = output.json();
  assert.equal(exitCode, 0);
  assert.equal(result.lifecycle.persistentRuntime, false);
  assert.equal(result.lifecycle.sessionLeasedRuntime, true);
  assert.equal(result.lifecycle.cleanupRequired, false);
  assert.equal(result.lifecycle.automaticCleanup, true);
  assert.match(result.lifecycle.cleanupTrigger, /session end/i);
});

test('CLI preserves explicit cleanup guidance for a user-owned persistent daemon', async () => {
  const output = outputBuffer();

  const exitCode = await runCli('open', [
    '--port', 'COM3',
    '--lease-file', 'D:\\runtime\\session-lease.json'
  ], {
    daemonClient: {
      async command() {
        return {
          connected: true,
          portPath: 'COM3',
          runtimeLease: { mode: 'persistent', active: 1 }
        };
      }
    },
    stdout: output.stdout
  });

  const result = output.json();
  assert.equal(exitCode, 0);
  assert.equal(result.lifecycle.persistentRuntime, true);
  assert.equal(result.lifecycle.cleanupRequired, true);
  assert.equal(result.lifecycle.automaticCleanup, undefined);
});

test('CLI daemon status reports no cleanup debt when the daemon is stopped', async () => {
  const output = outputBuffer();

  const exitCode = await runCli('daemon', ['status'], {
    daemonClient: {
      async status() {
        return { running: false };
      }
    },
    stdout: output.stdout
  });

  const result = output.json();
  assert.equal(exitCode, 0);
  assert.equal(result.lifecycle.persistentRuntime, false);
  assert.equal(result.lifecycle.serialPortReleased, true);
  assert.equal(result.lifecycle.cleanupRequired, false);
});

test('CLI applies a hard result budget before writing stdout', async () => {
  const output = outputBuffer();
  const exitCode = await runCli('logs', [], {
    daemonClient: {
      async command() {
        return { events: [{ data: { text: 'A'.repeat(60 * 1024) } }] };
      }
    },
    stdout: output.stdout
  });

  const result = output.json();
  assert.equal(exitCode, 1);
  assert.equal(result.ok, false);
  assert.equal(result.errorCode, 'SERIAL_CLI_RESULT_TOO_LARGE');
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') < 48 * 1024);
});

test('CLI scenario forwards bounded JSON workflow to the persistent daemon', async () => {
  const output = outputBuffer();
  const requests = [];
  const scenario = {
    name: 'boot-check',
    timeoutMs: 3000,
    steps: [
      {
        action: 'transact',
        send: { mode: 'text', data: 'HELLO', appendLf: true },
        expect: { type: 'text', value: 'READY' }
      }
    ]
  };

  const exitCode = await runCli('scenario', [
    '--json', JSON.stringify(scenario)
  ], {
    daemonClient: {
      async command(request) {
        requests.push(request);
        return { status: 'completed', runId: 'scenario-test' };
      }
    },
    stdout: output.stdout
  });

  assert.equal(exitCode, 0);
  assert.equal(output.json().data.status, 'completed');
  assert.deepEqual(requests, [{
    method: 'serial.scenario.run',
    params: scenario,
    timeoutMs: 8000
  }]);
});

test('CLI scenario-control forwards takeover lifecycle commands to the persistent daemon', async () => {
  const output = outputBuffer();
  const requests = [];

  const exitCode = await runCli('scenario-control', [
    'takeover',
    '--scenario-id', 'scenario-test',
    '--reason', 'manual probe'
  ], {
    daemonClient: {
      async command(request) {
        requests.push(request);
        return {
          active: true,
          scenario: { scenarioId: 'scenario-test', state: 'takeover_pending' }
        };
      }
    },
    stdout: output.stdout
  });

  assert.equal(exitCode, 0);
  assert.equal(output.json().data.scenario.state, 'takeover_pending');
  assert.deepEqual(requests, [{
    method: 'serial.scenario.control',
    params: {
      action: 'takeover',
      scenarioId: 'scenario-test',
      reason: 'manual probe'
    },
    timeoutMs: 30000
  }]);
});

test('CLI analysis forwards Journal range and bounded analysis limits', async () => {
  const output = outputBuffer();
  const requests = [];

  const exitCode = await runCli('analysis', [
    '--source', 'journal',
    '--after-seq', '10',
    '--before-seq', '900',
    '--from-timestamp', '1000',
    '--to-timestamp', '2000',
    '--max-events', '99999',
    '--max-findings', '999'
  ], {
    daemonClient: {
      async command(request) {
        requests.push(request);
        return { verdict: 'warning', findings: [] };
      }
    },
    stdout: output.stdout
  });

  assert.equal(exitCode, 0);
  assert.equal(output.json().data.verdict, 'warning');
  assert.deepEqual(requests, [{
    method: 'serial.analysis.run',
    params: {
      source: 'journal',
      afterSeq: 10,
      beforeSeq: 900,
      fromTimestamp: 1000,
      toTimestamp: 2000,
      maxEvents: 5000,
      maxFindings: 50
    },
    timeoutMs: 60000
  }]);
});
