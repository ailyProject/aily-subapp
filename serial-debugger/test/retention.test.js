'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { pruneRuntimeSessions } = require('../runtime/retention');

test('prunes expired Serial Runtime sessions but preserves unrelated directories', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-retention-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const now = Date.now();
  const expired = createSession(runtimeRoot, 'expired-session', now - 9 * 24 * 60 * 60 * 1000, 4096);
  const recent = createSession(runtimeRoot, 'recent-session', now - 24 * 60 * 60 * 1000, 2048);
  const unrelated = path.join(runtimeRoot, 'unrelated');
  fs.mkdirSync(unrelated);
  fs.writeFileSync(path.join(unrelated, 'keep.txt'), 'keep');

  const result = pruneRuntimeSessions({
    runtimeRoot,
    retentionDays: 7,
    maxTotalBytes: 1024 * 1024,
    now
  });

  assert.equal(fs.existsSync(expired), false);
  assert.equal(fs.existsSync(recent), true);
  assert.equal(fs.existsSync(unrelated), true);
  assert.equal(result.removedSessions, 1);
  assert.equal(result.removed[0].reason, 'expired');
});

test('prunes oldest sessions when the configured storage budget is exceeded', t => {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-serial-retention-size-'));
  t.after(() => fs.rmSync(runtimeRoot, { recursive: true, force: true }));
  const now = Date.now();
  const oldest = createSession(runtimeRoot, 'oldest-session', now - 3 * 60 * 60 * 1000, 10 * 1024 * 1024);
  const newest = createSession(runtimeRoot, 'newest-session', now - 60 * 60 * 1000, 10 * 1024 * 1024);

  const result = pruneRuntimeSessions({
    runtimeRoot,
    retentionDays: 7,
    maxTotalBytes: 16 * 1024 * 1024,
    now
  });

  assert.equal(fs.existsSync(oldest), false);
  assert.equal(fs.existsSync(newest), true);
  assert.equal(result.removed[0].reason, 'storage-limit');
});

function createSession(runtimeRoot, sessionId, updatedAt, payloadBytes) {
  const sessionDir = path.join(runtimeRoot, sessionId);
  fs.mkdirSync(sessionDir);
  fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify({
    protocolVersion: 1,
    sessionId,
    updatedAt
  }));
  fs.writeFileSync(path.join(sessionDir, 'journal-000001.jsonl'), Buffer.alloc(payloadBytes, 0x41));
  return sessionDir;
}
