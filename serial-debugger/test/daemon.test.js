'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  daemonStatus,
  loadRuntimeDescriptor,
  startDaemon,
  stopDaemon
} = require('../runtime/daemon');
const { callSerialRuntime } = require('../runtime/rpc-client');

test('daemon keeps one Runtime alive across short-lived CLI-style clients', { timeout: 20000 }, async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-daemon-'));
  t.after(async () => {
    await stopDaemon({ runtimeRoot }).catch(() => undefined);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  const started = await startDaemon({
    entryPath: path.join(__dirname, '..', 'index.js'),
    runtimeRoot,
    startTimeoutMs: 10000
  });
  assert.equal(started.running, true);

  const descriptor = loadRuntimeDescriptor(runtimeRoot);
  const first = await callSerialRuntime(descriptor, 'runtime.snapshot');
  const second = await callSerialRuntime(descriptor, 'runtime.snapshot');
  assert.equal(first.sessionId, second.sessionId);

  const status = await daemonStatus({ runtimeRoot });
  assert.equal(status.running, true);
  assert.equal(status.sessionId, first.sessionId);

  const stopped = await stopDaemon({ runtimeRoot });
  assert.equal(stopped.stopped, true);
});

test('session-leased daemon stops after its host lease is removed', { timeout: 20000 }, async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-leased-daemon-'));
  const leaseFile = path.join(runtimeRoot, 'host-session.json');
  const sessionId = 'chat-session-fixture';
  fs.writeFileSync(leaseFile, JSON.stringify({
    protocolVersion: 1,
    sessionId,
    ownerPid: process.pid,
    updatedAt: Date.now()
  }));
  t.after(async () => {
    await stopDaemon({ runtimeRoot }).catch(() => undefined);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  const started = await startDaemon({
    entryPath: path.join(__dirname, '..', 'index.js'),
    runtimeRoot,
    leaseFile,
    leaseSessionId: sessionId,
    leaseOwnerPid: process.pid,
    startTimeoutMs: 10000
  });
  assert.equal(started.running, true);
  assert.equal(started.lease.mode, 'session-leased');
  assert.deepEqual(started.lease.sessions, [sessionId]);

  fs.unlinkSync(leaseFile);
  await waitUntil(async () => !(await daemonStatus({
    runtimeRoot,
    timeoutMs: 100
  })).running, 12000);
  assert.equal((await daemonStatus({ runtimeRoot, timeoutMs: 100 })).running, false);
});

test('host serve mode attaches to an existing daemon without owning its lifecycle', { timeout: 20000 }, async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-attach-'));
  const entryPath = path.join(__dirname, '..', 'index.js');
  let proxy;
  t.after(async () => {
    if (proxy && proxy.exitCode === null) proxy.kill('SIGTERM');
    await stopDaemon({ runtimeRoot }).catch(() => undefined);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  const started = await startDaemon({
    entryPath,
    runtimeRoot,
    startTimeoutMs: 10000
  });
  proxy = childProcess.spawn(process.execPath, [
    entryPath,
    'serve',
    '--runtime-dir',
    runtimeRoot,
    '--host',
    '127.0.0.1',
    '--port',
    '0'
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const ready = await waitForReadyLine(proxy);
  assert.equal(ready.event, 'ready');
  assert.equal(ready.data.mode, 'serve-attached');
  assert.equal(ready.data.sharedRuntime, true);
  assert.equal(ready.data.runtimePid, started.pid);
  assert.equal(ready.data.shutdownUrl, undefined);

  proxy.kill('SIGTERM');
  await new Promise(resolve => proxy.once('exit', resolve));
  const status = await daemonStatus({ runtimeRoot });
  assert.equal(status.running, true);
});

test('CLI clients discover the Runtime when host serve mode starts first', { timeout: 20000 }, async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-serve-first-'));
  const entryPath = path.join(__dirname, '..', 'index.js');
  let serveProcess = childProcess.spawn(process.execPath, [
    entryPath,
    'serve',
    '--runtime-dir',
    runtimeRoot,
    '--host',
    '127.0.0.1',
    '--port',
    '0'
  ], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(async () => {
    if (serveProcess && serveProcess.exitCode === null) serveProcess.kill('SIGTERM');
    await stopDaemon({ runtimeRoot }).catch(() => undefined);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  const ready = await waitForReadyLine(serveProcess);
  const descriptor = loadRuntimeDescriptor(runtimeRoot);
  const snapshot = await callSerialRuntime(descriptor, 'runtime.snapshot');
  assert.equal(snapshot.sessionId, ready.data.sessionId);
  assert.equal((await daemonStatus({ runtimeRoot })).running, true);

  serveProcess.kill('SIGTERM');
  await new Promise(resolve => serveProcess.once('exit', resolve));
  serveProcess = null;
  assert.equal((await daemonStatus({ runtimeRoot })).running, false);
});

test('restarts cleanly after an abnormal daemon exit leaves a stale descriptor and lock', {
  timeout: 30000
}, async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-daemon-recovery-'));
  const entryPath = path.join(__dirname, '..', 'index.js');
  t.after(async () => {
    await stopDaemon({ runtimeRoot }).catch(() => undefined);
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
  });

  const first = await startDaemon({
    entryPath,
    runtimeRoot,
    startTimeoutMs: 10000
  });
  const firstPid = first.pid;
  const firstSessionId = first.sessionId;
  process.kill(firstPid, 'SIGTERM');
  await waitUntil(async () => !(await daemonStatus({ runtimeRoot, timeoutMs: 100 })).running);

  const stale = await daemonStatus({ runtimeRoot, timeoutMs: 100 });
  assert.equal(stale.running, false);
  assert.equal(stale.stale, true);
  assert.equal(stale.pid, firstPid);

  const recovered = await startDaemon({
    entryPath,
    runtimeRoot,
    startTimeoutMs: 10000
  });
  assert.equal(recovered.running, true);
  assert.notEqual(recovered.pid, firstPid);
  assert.notEqual(recovered.sessionId, firstSessionId);
  assert.equal((await callSerialRuntime(loadRuntimeDescriptor(runtimeRoot), 'runtime.snapshot')).sessionId,
    recovered.sessionId);
});

function waitForReadyLine(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => reject(new Error(`serve ready timeout: ${stderr}`)), 8000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.stdout.on('data', chunk => {
      stdout += chunk;
      const lines = stdout.split(/\r?\n/);
      stdout = lines.pop() || '';
      for (const line of lines) {
        try {
          const message = JSON.parse(line);
          if (message.event === 'ready') {
            clearTimeout(timer);
            resolve(message);
            return;
          }
        } catch {
          // Ignore non-JSON diagnostic lines while waiting for the ready envelope.
        }
      }
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`serve process exited before ready (${code}): ${stderr}`));
    });
  });
}

async function waitUntil(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for condition');
}
