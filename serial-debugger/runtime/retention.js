'use strict';

const fs = require('fs');
const path = require('path');
const { resolveRuntimeRoot } = require('./runtime-paths');

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024;

function pruneRuntimeSessions(options = {}) {
  const runtimeRoot = resolveRuntimeRoot(options.runtimeRoot);
  const currentSessionDir = options.currentSessionDir
    ? path.resolve(String(options.currentSessionDir))
    : '';
  const retentionDays = numberInRange(options.retentionDays, DEFAULT_RETENTION_DAYS, 1, 3650);
  const maxTotalBytes = numberInRange(
    options.maxTotalBytes,
    DEFAULT_MAX_TOTAL_BYTES,
    16 * 1024 * 1024,
    Number.MAX_SAFE_INTEGER
  );
  const now = Number(options.now || Date.now());
  const expiryBefore = now - retentionDays * 24 * 60 * 60 * 1000;
  fs.mkdirSync(runtimeRoot, { recursive: true });

  const sessions = [];
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sessionDir = path.resolve(runtimeRoot, entry.name);
    if (currentSessionDir && samePath(sessionDir, currentSessionDir)) continue;
    const metadataPath = path.join(sessionDir, 'session.json');
    if (!fs.existsSync(metadataPath)) continue;
    let metadata;
    try {
      metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch {
      continue;
    }
    if (Number(metadata.protocolVersion) !== 1 || !metadata.sessionId) continue;
    const stat = fs.statSync(sessionDir);
    sessions.push({
      sessionId: String(metadata.sessionId),
      sessionDir,
      updatedAt: Number(metadata.updatedAt || stat.mtimeMs || 0),
      bytes: directorySize(sessionDir)
    });
  }

  const removed = [];
  let totalBytes = sessions.reduce((sum, session) => sum + session.bytes, 0);
  for (const session of sessions
    .filter(item => item.updatedAt < expiryBefore)
    .sort((left, right) => left.updatedAt - right.updatedAt)) {
    removeSessionDirectory(runtimeRoot, session.sessionDir);
    removed.push({ ...session, reason: 'expired' });
    totalBytes -= session.bytes;
  }

  const remaining = sessions
    .filter(session => !removed.some(item => samePath(item.sessionDir, session.sessionDir)))
    .sort((left, right) => left.updatedAt - right.updatedAt);
  for (const session of remaining) {
    if (totalBytes <= maxTotalBytes) break;
    removeSessionDirectory(runtimeRoot, session.sessionDir);
    removed.push({ ...session, reason: 'storage-limit' });
    totalBytes -= session.bytes;
  }

  return {
    retentionDays,
    maxTotalBytes,
    scannedSessions: sessions.length,
    removedSessions: removed.length,
    reclaimedBytes: removed.reduce((sum, session) => sum + session.bytes, 0),
    remainingBytes: Math.max(0, totalBytes),
    removed: removed.map(session => ({
      sessionId: session.sessionId,
      bytes: session.bytes,
      reason: session.reason
    }))
  };
}

function removeSessionDirectory(runtimeRoot, sessionDir) {
  const root = path.resolve(runtimeRoot);
  const target = path.resolve(sessionDir);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Refusing to remove a session outside the Serial Runtime root');
  }
  const metadataPath = path.join(target, 'session.json');
  if (!fs.existsSync(metadataPath)) {
    throw new Error('Refusing to remove a directory without Serial Runtime session metadata');
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function directorySize(rootDir) {
  let total = 0;
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) total += directorySize(entryPath);
    else if (entry.isFile()) total += fs.statSync(entryPath).size;
  }
  return total;
}

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? String(left).toLowerCase() === String(right).toLowerCase()
    : String(left) === String(right);
}

module.exports = {
  DEFAULT_MAX_TOTAL_BYTES,
  DEFAULT_RETENTION_DAYS,
  pruneRuntimeSessions
};
