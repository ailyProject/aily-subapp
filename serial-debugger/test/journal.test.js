'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createSerialDebuggerCore } = require('../core');
const { SerialJournal } = require('../runtime/journal');
const { FakeSerialPort } = require('./fake-serial-port');

test.beforeEach(() => {
  FakeSerialPort.reset();
});

test('persists canonical JSONL plus RX text and exposes only registered artifacts', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-journal-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const journal = new SerialJournal({
    rootDir: runtimeRoot,
    sessionId: 'serial-test-session',
    segmentMaxBytes: 1024
  });
  FakeSerialPort.onWrite = port => queueMicrotask(() => port.receive('PONG\n'));
  const core = createSerialDebuggerCore({
    SerialPortClass: FakeSerialPort,
    journal
  });

  await core.connect({ port: 'COM_TEST' });
  const transaction = await core.transact({
    send: { mode: 'text', data: 'PING\n' },
    expect: { type: 'text', value: 'PONG' },
    timeoutMs: 1000
  });
  await journal.flush();

  assert.ok(transaction.evidence.artifacts.length >= 1);
  const artifactId = transaction.evidence.artifacts[0].artifactId;
  const page = await core.executeAction({
    method: 'serial.artifact.read',
    params: { artifactId, maxBytes: 64 * 1024 }
  });
  assert.match(page.text, /"event":"serial\.rx"/);
  assert.ok(Buffer.byteLength(page.text, 'utf8') <= 64 * 1024);

  const search = await core.executeAction({
    method: 'serial.artifact.search',
    params: { artifactId, query: 'PONG' }
  });
  assert.equal(search.count, 1);

  const journalPage = await core.executeAction({
    method: 'serial.log.read',
    params: {
      source: 'journal',
      afterSeq: 0,
      events: ['serial.rx'],
      directions: ['RX'],
      maxBytes: 8192
    }
  });
  assert.equal(journalPage.source, 'journal');
  assert.equal(journalPage.count, 1);
  assert.match(journalPage.events[0].data.text, /PONG/);
  assert.ok(Buffer.byteLength(JSON.stringify(journalPage), 'utf8') <= 8192);

  await assert.rejects(
    core.executeAction({
      method: 'serial.artifact.read',
      params: { artifactId: '../../arbitrary-file' }
    }),
    error => error.code === 'ARTIFACT_NOT_FOUND'
  );
  await core.cleanup();

  const sessionRoot = path.join(runtimeRoot, 'serial-test-session');
  assert.equal(fs.existsSync(path.join(sessionRoot, 'session.json')), true);
  const rxArtifact = journal.artifactStore.list().find(item => item.type === 'serial-rx-text');
  assert.ok(rxArtifact);
  assert.match(fs.readFileSync(rxArtifact.path, 'utf8'), /PONG/);
});

test('automatically falls back to Journal when the hot event cursor was dropped', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-hot-fallback-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const journal = new SerialJournal({
    rootDir: runtimeRoot,
    sessionId: 'serial-fallback-session'
  });
  const core = createSerialDebuggerCore({
    SerialPortClass: FakeSerialPort,
    journal,
    eventStoreOptions: { maxEvents: 2, maxBytes: 1024 * 1024 }
  });
  await core.connect({ port: 'COM_TEST' });
  FakeSerialPort.instances[0].receive('one\n');
  FakeSerialPort.instances[0].receive('two\n');
  FakeSerialPort.instances[0].receive('three\n');
  await journal.flush();

  const page = await core.executeAction({
    method: 'serial.log.read',
    params: { afterSeq: 0, limit: 20, maxBytes: 16384 }
  });
  assert.equal(page.source, 'journal');
  assert.ok(page.events.some(event => event.event === 'serial.opened'));
  assert.ok(page.events.some(event => event.data?.text === 'one\n'));
  await core.cleanup();
});

test('reports low disk, blocks writes at the critical threshold, and reports recovery', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-journal-health-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  let freeBytes = 400;
  const journal = new SerialJournal({
    rootDir: runtimeRoot,
    sessionId: 'serial-health-session',
    lowDiskBytes: 500,
    criticalDiskBytes: 100,
    diskCheckIntervalMs: 1,
    getDiskSpace: () => ({ freeBytes, totalBytes: 1000 })
  });
  const events = [];
  journal.setHealthListener((event, data) => events.push({ event, data }));

  assert.equal(journal.stats().health.state, 'low');
  assert.equal(events.at(-1).event, 'serial.journal.low_disk');
  journal.append({ seq: 1, event: 'serial.rx', data: { text: 'still recorded' } });
  await journal.flush();

  freeBytes = 50;
  journal.refreshDiskHealth(true);
  const beforeDroppedBytes = journal.stats().droppedBytes;
  journal.append({ seq: 2, event: 'serial.rx', data: { text: 'not recorded' } });
  assert.equal(journal.stats().health.state, 'critical');
  assert.equal(journal.stats().writeBlocked, true);
  assert.ok(journal.stats().droppedBytes > beforeDroppedBytes);
  assert.equal(events.at(-1).event, 'serial.journal.write_blocked');

  freeBytes = 900;
  journal.refreshDiskHealth(true);
  assert.equal(journal.stats().health.state, 'ok');
  assert.equal(journal.stats().writeBlocked, false);
  assert.equal(events.at(-1).event, 'serial.journal.recovered');

  journal.append({ seq: 3, event: 'serial.rx', data: { text: 'recording resumed' } });
  await journal.close();
  const artifact = journal.artifactStore.list().find(item => item.type === 'serial-journal');
  const contents = fs.readFileSync(artifact.path, 'utf8');
  assert.match(contents, /still recorded/);
  assert.doesNotMatch(contents, /not recorded/);
  assert.match(contents, /recording resumed/);
});

test('contains Journal write failures without producing an unhandled rejection', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-journal-write-failure-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const journal = new SerialJournal({
    rootDir: runtimeRoot,
    sessionId: 'serial-write-failure-session',
    flushBytes: 1
  });
  const events = [];
  journal.setHealthListener((event, data) => events.push({ event, data }));
  const originalAppendFile = fs.promises.appendFile;
  fs.promises.appendFile = async () => {
    const error = new Error('simulated disk write failure');
    error.code = 'ENOSPC';
    throw error;
  };
  t.after(() => {
    fs.promises.appendFile = originalAppendFile;
  });

  journal.append({ seq: 1, event: 'serial.rx', data: { text: 'payload' } });
  await journal.flush();

  const stats = journal.stats();
  assert.equal(stats.writeBlocked, true);
  assert.equal(stats.lastWriteError.code, 'JOURNAL_WRITE_FAILED');
  assert.equal(events.at(-1).event, 'serial.journal.write_failed');
});

test('publishes Journal health warnings through the shared Runtime event stream', async t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-journal-runtime-health-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const journal = new SerialJournal({
    rootDir: runtimeRoot,
    sessionId: 'serial-runtime-health-session',
    lowDiskBytes: 500,
    criticalDiskBytes: 100,
    getDiskSpace: () => ({ freeBytes: 400, totalBytes: 1000 })
  });
  const core = createSerialDebuggerCore({
    SerialPortClass: FakeSerialPort,
    journal
  });

  const snapshot = core.snapshot();
  assert.equal(snapshot.journal.health.state, 'low');
  const events = core.readLogs({ afterSeq: 0, limit: 20 }).events;
  assert.equal(events[0].event, 'serial.journal.low_disk');
  assert.equal(events[0].data.code, 'JOURNAL_LOW_DISK');
  await core.cleanup();
});
