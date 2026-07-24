'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const { SerialArtifactStore } = require('./artifact-store');
const {
  DEFAULT_PAGE_MAX_BYTES,
  DEFAULT_PREVIEW_BYTES,
  MAX_PAGE_MAX_BYTES,
  compactEvent,
  jsonByteLength,
  positiveInteger,
  utf8Preview
} = require('./result-budget');
const { eventDirection, normalizeStringSet } = require('./event-store');
const { pruneRuntimeSessions } = require('./retention');
const { resolveRuntimeRoot } = require('./runtime-paths');

const DEFAULT_SEGMENT_MAX_BYTES = 32 * 1024 * 1024;
const DEFAULT_SESSION_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_FLUSH_BYTES = 64 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 50;
const DEFAULT_LOW_DISK_BYTES = 512 * 1024 * 1024;
const DEFAULT_CRITICAL_DISK_BYTES = 128 * 1024 * 1024;
const DEFAULT_DISK_CHECK_INTERVAL_MS = 30 * 1000;

class SerialJournal {
  constructor(options = {}) {
    this.sessionId = String(options.sessionId || createJournalSessionId());
    this.runtimeRoot = resolveRuntimeRoot(options.rootDir);
    this.rootDir = path.join(this.runtimeRoot, safeDirectoryName(this.sessionId));
    this.segmentMaxBytes = positiveInteger(options.segmentMaxBytes, DEFAULT_SEGMENT_MAX_BYTES);
    this.sessionMaxBytes = positiveInteger(options.sessionMaxBytes, DEFAULT_SESSION_MAX_BYTES);
    this.flushBytes = positiveInteger(options.flushBytes, DEFAULT_FLUSH_BYTES);
    this.flushIntervalMs = positiveInteger(options.flushIntervalMs, DEFAULT_FLUSH_INTERVAL_MS);
    this.lowDiskBytes = positiveInteger(options.lowDiskBytes, DEFAULT_LOW_DISK_BYTES);
    this.criticalDiskBytes = Math.min(
      this.lowDiskBytes,
      positiveInteger(options.criticalDiskBytes, DEFAULT_CRITICAL_DISK_BYTES)
    );
    this.diskCheckIntervalMs = positiveInteger(
      options.diskCheckIntervalMs,
      DEFAULT_DISK_CHECK_INTERVAL_MS
    );
    this.getDiskSpace = typeof options.getDiskSpace === 'function'
      ? options.getDiskSpace
      : () => readDiskSpace(this.runtimeRoot);
    this.healthListener = null;
    this.health = {
      state: 'unknown',
      code: '',
      message: '',
      freeBytes: 0,
      totalBytes: 0,
      checkedAt: 0
    };
    this.writeBlocked = false;
    this.lastWriteError = null;
    this.artifactStore = options.artifactStore || new SerialArtifactStore({ rootDir: this.rootDir });
    this.jsonSegments = [];
    this.textSegments = [];
    this.currentJson = null;
    this.currentText = null;
    this.pending = new Map();
    this.pendingBytes = 0;
    this.recordedBytes = 0;
    this.droppedBytes = 0;
    this.closed = false;
    this.flushTimer = null;
    this.writeChain = Promise.resolve();
    fs.mkdirSync(this.rootDir, { recursive: true });
    this.retention = options.retention === false
      ? { enabled: false }
      : {
          enabled: true,
          ...pruneRuntimeSessions({
            runtimeRoot: this.runtimeRoot,
            currentSessionDir: this.rootDir,
            retentionDays: options.retentionDays,
            maxTotalBytes: options.maxTotalBytes
          })
        };
    this.refreshDiskHealth(true);
    this.safeWriteMetadata();
  }

  append(envelope = {}) {
    if (this.closed) return;
    this.refreshDiskHealth();
    const line = `${JSON.stringify(canonicalJournalEnvelope(envelope))}\n`;
    if (this.writeBlocked) {
      this.droppedBytes += Buffer.byteLength(line, 'utf8');
      if (envelope.event === 'serial.rx' && envelope.data?.text) {
        this.droppedBytes += Buffer.byteLength(String(envelope.data.text), 'utf8');
      }
      return;
    }
    this.appendToSegment('json', line, envelope.seq);
    if (envelope.event === 'serial.rx' && envelope.data?.text) {
      this.appendToSegment('text', String(envelope.data.text), envelope.seq);
    }
    if (this.pendingBytes >= this.flushBytes) {
      void this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  appendToSegment(kind, content, seq) {
    const buffer = Buffer.from(content, 'utf8');
    if (this.recordedBytes + buffer.length > this.sessionMaxBytes) {
      this.droppedBytes += buffer.length;
      return;
    }

    let segment = kind === 'json' ? this.currentJson : this.currentText;
    if (!segment || (segment.bytes > 0 && segment.bytes + buffer.length > this.segmentMaxBytes)) {
      segment = this.createSegment(kind);
      if (kind === 'json') this.currentJson = segment;
      else this.currentText = segment;
    }
    if (!segment.firstSeq) segment.firstSeq = Number(seq || 0);
    segment.lastSeq = Number(seq || segment.lastSeq || 0);
    segment.bytes += buffer.length;
    this.recordedBytes += buffer.length;
    this.queueWrite(segment.path, buffer);
    this.artifactStore.update(segment.artifactId, {
      firstSeq: segment.firstSeq,
      lastSeq: segment.lastSeq
    });
  }

  createSegment(kind) {
    const collection = kind === 'json' ? this.jsonSegments : this.textSegments;
    const index = collection.length + 1;
    const serial = String(index).padStart(6, '0');
    const isJson = kind === 'json';
    const artifactId = isJson ? `journal-${serial}` : `rx-text-${serial}`;
    const fileName = isJson ? `${artifactId}.jsonl` : `${artifactId}.log`;
    const segment = {
      artifactId,
      path: path.join(this.rootDir, fileName),
      bytes: 0,
      firstSeq: 0,
      lastSeq: 0
    };
    collection.push(segment);
    this.artifactStore.register({
      artifactId,
      type: isJson ? 'serial-journal' : 'serial-rx-text',
      contentType: isJson ? 'application/x-ndjson; charset=utf-8' : 'text/plain; charset=utf-8',
      path: fileName
    });
    return segment;
  }

  evidence(startSeq = 0, endSeq = 0) {
    const start = Number(startSeq || 0);
    const end = Number(endSeq || start);
    const artifacts = this.jsonSegments
      .filter(segment => {
        if (!segment.firstSeq && !segment.lastSeq) return false;
        return (!end || segment.firstSeq <= end) && (!start || segment.lastSeq >= start);
      })
      .map(segment => ({
        artifactId: segment.artifactId,
        type: 'serial-journal',
        firstSeq: segment.firstSeq,
        lastSeq: segment.lastSeq
      }));
    return {
      sessionId: this.sessionId,
      startSeq: start,
      endSeq: end,
      artifacts
    };
  }

  async query(options = {}) {
    await this.flush();
    const afterSeq = Math.max(0, Number(options.afterSeq) || 0);
    const beforeSeq = Math.max(0, Number(options.beforeSeq) || 0);
    const fromTimestamp = Math.max(0, Number(options.fromTimestamp) || 0);
    const toTimestamp = Math.max(0, Number(options.toTimestamp) || 0);
    const limit = Math.min(5000, positiveInteger(options.limit, 500));
    const maxBytes = positiveInteger(options.maxBytes, DEFAULT_PAGE_MAX_BYTES, MAX_PAGE_MAX_BYTES);
    const previewBytes = positiveInteger(
      options.previewBytes,
      DEFAULT_PREVIEW_BYTES,
      Math.max(256, Math.floor(maxBytes / 2))
    );
    const eventNames = normalizeStringSet(options.events || options.event);
    const directions = normalizeStringSet(options.directions || options.direction);
    const selected = [];
    const eventBudget = Math.max(0, maxBytes - 4096);
    let selectedBytes = 0;
    let hasMore = false;
    let parseErrors = 0;
    let scannedArtifacts = 0;
    let stop = false;

    const matchingSegments = this.jsonSegments.filter(segment => {
      if (afterSeq && segment.lastSeq <= afterSeq) return false;
      if (beforeSeq && segment.firstSeq >= beforeSeq) return false;
      return true;
    });

    for (const segment of matchingSegments) {
      if (stop || !fs.existsSync(segment.path)) break;
      scannedArtifacts += 1;
      const stream = fs.createReadStream(segment.path, { encoding: 'utf8' });
      const reader = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of reader) {
          if (!line.trim()) continue;
          let event;
          try {
            event = JSON.parse(line);
          } catch {
            parseErrors += 1;
            continue;
          }
          if (!matchesQuery(event, {
            afterSeq,
            beforeSeq,
            fromTimestamp,
            toTimestamp,
            eventNames,
            directions
          })) continue;
          if (selected.length >= limit) {
            hasMore = true;
            stop = true;
            break;
          }

          let candidate = event;
          let size = jsonByteLength(candidate);
          const remaining = Math.max(0, eventBudget - selectedBytes);
          if (size > remaining) {
            candidate = compactEvent(event, {
              previewBytes: Math.min(previewBytes, Math.max(256, remaining - 512))
            });
            size = jsonByteLength(candidate);
          }
          if (size > remaining) {
            hasMore = true;
            stop = true;
            break;
          }
          selected.push(candidate);
          selectedBytes += size;
        }
      } finally {
        reader.close();
        stream.destroy();
      }
    }

    const firstSeq = this.jsonSegments[0]?.firstSeq || 0;
    const lastSeq = this.jsonSegments.at(-1)?.lastSeq || 0;
    const result = {
      source: 'journal',
      firstSeq,
      lastSeq,
      afterSeq,
      beforeSeq,
      fromTimestamp,
      toTimestamp,
      maxBytes,
      count: selected.length,
      hasMore,
      nextAfterSeq: selected.at(-1)?.seq || afterSeq,
      nextTimestamp: selected.at(-1)?.timestamp || fromTimestamp,
      scannedArtifacts,
      parseErrors,
      events: selected
    };
    result.returnedBytes = jsonByteLength(result);
    while (result.returnedBytes > maxBytes && result.events.length) {
      result.events.pop();
      result.count = result.events.length;
      result.hasMore = true;
      result.nextAfterSeq = result.events.at(-1)?.seq || afterSeq;
      result.nextTimestamp = result.events.at(-1)?.timestamp || fromTimestamp;
      result.returnedBytes = jsonByteLength(result);
    }
    return result;
  }

  stats() {
    return {
      enabled: true,
      sessionId: this.sessionId,
      rootDir: this.rootDir,
      recordedBytes: this.recordedBytes,
      droppedBytes: this.droppedBytes,
      segmentMaxBytes: this.segmentMaxBytes,
      sessionMaxBytes: this.sessionMaxBytes,
      health: { ...this.health },
      writeBlocked: this.writeBlocked,
      lastWriteError: this.lastWriteError,
      retention: this.retention,
      artifacts: this.artifactStore.list()
    };
  }

  setHealthListener(listener) {
    this.healthListener = typeof listener === 'function' ? listener : null;
    if (this.healthListener && this.health.state !== 'ok' && this.health.code) {
      this.healthListener(healthEventName(this.health.state), this.healthEventData());
    }
  }

  refreshDiskHealth(force = false) {
    const now = Date.now();
    if (this.lastWriteError) return this.health;
    if (!force && now - this.health.checkedAt < this.diskCheckIntervalMs) {
      return this.health;
    }

    const previousState = this.health.state;
    try {
      const disk = normalizeDiskSpace(this.getDiskSpace(this.rootDir));
      let state = 'ok';
      let code = '';
      let message = '';
      if (disk.freeBytes <= this.criticalDiskBytes) {
        state = 'critical';
        code = 'JOURNAL_DISK_CRITICAL';
        message = 'Serial Journal writes are paused because available disk space is critically low';
      } else if (disk.freeBytes <= this.lowDiskBytes) {
        state = 'low';
        code = 'JOURNAL_LOW_DISK';
        message = 'Available disk space for the Serial Journal is low';
      }
      this.health = {
        state,
        code,
        message,
        freeBytes: disk.freeBytes,
        totalBytes: disk.totalBytes,
        checkedAt: now
      };
      this.writeBlocked = state === 'critical';
    } catch (error) {
      this.health = {
        state: 'unknown',
        code: 'JOURNAL_DISK_CHECK_FAILED',
        message: error?.message || String(error),
        freeBytes: 0,
        totalBytes: 0,
        checkedAt: now
      };
    }

    if (this.healthListener && this.health.state !== previousState) {
      this.healthListener(healthEventName(this.health.state), this.healthEventData());
    }
    return this.health;
  }

  async flush() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pending.size) return this.writeChain;
    const batch = this.pending;
    this.pending = new Map();
    this.pendingBytes = 0;
    this.writeChain = this.writeChain
      .then(async () => {
        for (const [filePath, chunks] of batch) {
          await fs.promises.appendFile(filePath, Buffer.concat(chunks));
        }
        this.safeWriteMetadata();
      })
      .catch(error => {
        this.handleWriteFailure(error);
      });
    return this.writeChain;
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    await this.writeChain;
    this.safeWriteMetadata();
  }

  queueWrite(filePath, buffer) {
    const chunks = this.pending.get(filePath) || [];
    chunks.push(buffer);
    this.pending.set(filePath, chunks);
    this.pendingBytes += buffer.length;
  }

  scheduleFlush() {
    if (this.flushTimer || this.closed) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  writeMetadata() {
    const metadataPath = path.join(this.rootDir, 'session.json');
    const payload = {
      protocolVersion: 1,
      sessionId: this.sessionId,
      pid: process.pid,
      updatedAt: Date.now(),
      recordedBytes: this.recordedBytes,
      droppedBytes: this.droppedBytes,
      health: this.health,
      writeBlocked: this.writeBlocked,
      lastWriteError: this.lastWriteError,
      retention: this.retention,
      artifacts: this.artifactStore.list()
    };
    fs.writeFileSync(metadataPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  }

  safeWriteMetadata() {
    if (this.writeBlocked) return false;
    try {
      this.writeMetadata();
      return true;
    } catch (error) {
      this.handleWriteFailure(error);
      return false;
    }
  }

  handleWriteFailure(error) {
    if (this.lastWriteError) return;
    this.writeBlocked = true;
    this.lastWriteError = {
      code: 'JOURNAL_WRITE_FAILED',
      message: error?.message || String(error),
      originalCode: String(error?.code || ''),
      timestamp: Date.now()
    };
    this.health = {
      ...this.health,
      state: 'error',
      code: this.lastWriteError.code,
      message: this.lastWriteError.message,
      checkedAt: Date.now()
    };
    this.healthListener?.('serial.journal.write_failed', this.healthEventData());
  }

  healthEventData() {
    return {
      code: this.health.code,
      message: this.health.message,
      state: this.health.state,
      freeBytes: this.health.freeBytes,
      totalBytes: this.health.totalBytes,
      lowDiskBytes: this.lowDiskBytes,
      criticalDiskBytes: this.criticalDiskBytes,
      writeBlocked: this.writeBlocked,
      recoverable: true,
      guidance: this.health.state === 'critical' || this.health.state === 'error'
        ? 'Free disk space or select a writable Runtime directory, then restart the Runtime.'
        : 'Free disk space before long-running serial capture continues.'
    };
  }
}

function readDiskSpace(targetPath) {
  if (typeof fs.statfsSync !== 'function') {
    throw new Error('Disk-space checks are not supported by this Node.js runtime');
  }
  const stat = fs.statfsSync(targetPath);
  const blockSize = Number(stat.bsize || 0);
  return {
    freeBytes: blockSize * Number(stat.bavail ?? stat.bfree ?? 0),
    totalBytes: blockSize * Number(stat.blocks || 0)
  };
}

function normalizeDiskSpace(value = {}) {
  const freeBytes = Number(value.freeBytes ?? value.availableBytes ?? 0);
  const totalBytes = Number(value.totalBytes ?? 0);
  if (!Number.isFinite(freeBytes) || freeBytes < 0) {
    throw new Error('Disk-space provider returned an invalid free-byte count');
  }
  return {
    freeBytes,
    totalBytes: Number.isFinite(totalBytes) && totalBytes >= 0 ? totalBytes : 0
  };
}

function healthEventName(state) {
  if (state === 'low') return 'serial.journal.low_disk';
  if (state === 'critical') return 'serial.journal.write_blocked';
  if (state === 'error') return 'serial.journal.write_failed';
  if (state === 'ok') return 'serial.journal.recovered';
  return 'serial.journal.health_unknown';
}

function matchesQuery(event, filters) {
  if (Number(event.seq || 0) <= filters.afterSeq) return false;
  if (filters.beforeSeq && Number(event.seq || 0) >= filters.beforeSeq) return false;
  if (filters.fromTimestamp && Number(event.timestamp || 0) < filters.fromTimestamp) return false;
  if (filters.toTimestamp && Number(event.timestamp || 0) > filters.toTimestamp) return false;
  if (filters.eventNames && !filters.eventNames.has(String(event.event || '').toUpperCase())) {
    return false;
  }
  if (filters.directions && !filters.directions.has(eventDirection(event))) return false;
  return true;
}

function canonicalJournalEnvelope(envelope = {}) {
  if (!['serial.rx', 'serial.tx'].includes(envelope.event) || !envelope.data) {
    return envelope;
  }
  const data = { ...envelope.data };
  if (data.hex) {
    data.hexPreview = utf8Preview(data.hex, 2048).value;
    delete data.hex;
  }
  data.payloadEncoding = 'base64';
  return {
    ...envelope,
    data
  };
}

function safeDirectoryName(value) {
  const safe = String(value).replace(/[^a-zA-Z0-9._-]/g, '_');
  return safe || `session-${Date.now()}`;
}

function createJournalSessionId() {
  if (typeof crypto.randomUUID === 'function') return `serial-${crypto.randomUUID()}`;
  return `serial-${process.pid}-${Date.now().toString(36)}-${crypto.randomBytes(6).toString('hex')}`;
}

module.exports = {
  DEFAULT_CRITICAL_DISK_BYTES,
  DEFAULT_LOW_DISK_BYTES,
  SerialJournal
};
