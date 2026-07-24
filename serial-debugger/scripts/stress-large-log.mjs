import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createSerialDebuggerCore } = require('../core');
const { SerialJournal } = require('../runtime/journal');
const { FakeSerialPort } = require('../test/fake-serial-port');

const payloadBytes = 10 * 1024 * 1024;
const chunkBytes = 256 * 1024;
const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-stress-'));
const startedAt = Date.now();

try {
  FakeSerialPort.reset();
  const journal = new SerialJournal({
    rootDir: runtimeRoot,
    sessionId: 'serial-stress-session',
    segmentMaxBytes: 2 * 1024 * 1024,
    sessionMaxBytes: 128 * 1024 * 1024
  });
  const core = createSerialDebuggerCore({
    SerialPortClass: FakeSerialPort,
    journal,
    eventStoreOptions: {
      maxEvents: 5000,
      maxBytes: 96 * 1024 * 1024
    }
  });
  const chunk = Buffer.alloc(chunkBytes, 0x41);
  FakeSerialPort.onWrite = port => {
    for (let offset = 0; offset < payloadBytes; offset += chunkBytes) {
      port.receive(chunk.subarray(0, Math.min(chunk.length, payloadBytes - offset)));
    }
  };

  await core.connect({ port: 'COM_TEST' });
  const result = await core.transact({
    send: { mode: 'text', data: 'DUMP' },
    durationMs: 1000,
    quietMs: 20,
    maxBytes: 16 * 1024 * 1024,
    previewBytes: 2048
  });
  await journal.flush();

  const resultBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
  assert.equal(result.capture.byteLength, payloadBytes);
  assert.equal(result.capture.truncated, true);
  assert.ok(resultBytes < 48 * 1024);
  assert.ok(result.evidence.artifacts.length > 1);

  const artifactId = result.evidence.artifacts[0].artifactId;
  const search = await core.executeAction({
    method: 'serial.artifact.search',
    params: {
      artifactId,
      query: 'serial.rx',
      limit: 2,
      maxScanBytes: 512 * 1024
    }
  });
  assert.ok(Buffer.byteLength(JSON.stringify(search), 'utf8') < 48 * 1024);
  await core.cleanup();

  const stats = journal.stats();
  assert.ok(stats.recordedBytes >= payloadBytes);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    payloadBytes,
    toolResultBytes: resultBytes,
    artifactCount: stats.artifacts.length,
    journalBytes: stats.recordedBytes,
    durationMs: Date.now() - startedAt
  })}\n`);
} finally {
  fs.rmSync(runtimeRoot, { recursive: true, force: true });
}
