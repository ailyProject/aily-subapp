'use strict';

const fs = require('fs');
const path = require('path');

class RuntimeLeaseMonitor {
  constructor(options = {}) {
    this.persist = options.persist === true;
    this.checkIntervalMs = boundedNumber(options.checkIntervalMs, 1000, 100, 30000);
    this.expiryGraceMs = boundedNumber(options.expiryGraceMs, 3000, 0, 60000);
    this.onExpired = typeof options.onExpired === 'function'
      ? options.onExpired
      : async () => undefined;
    this.leases = new Map();
    this.timer = null;
    this.expiring = false;
    this.everLeased = false;
  }

  acquire(input = {}) {
    const leaseFile = normalizeLeaseFile(input.leaseFile);
    const sessionId = normalizeText(input.sessionId, 256);
    const ownerPid = positivePid(input.ownerPid);
    const lease = readLease(leaseFile);
    if (!lease) {
      throw leaseError('SERIAL_RUNTIME_LEASE_INVALID', 'Runtime lease file is missing or invalid', {
        leaseFile
      });
    }
    if (sessionId && lease.sessionId && lease.sessionId !== sessionId) {
      throw leaseError('SERIAL_RUNTIME_LEASE_MISMATCH', 'Runtime lease session does not match', {
        expectedSessionId: sessionId,
        actualSessionId: lease.sessionId
      });
    }
    if (ownerPid && lease.ownerPid && lease.ownerPid !== ownerPid) {
      throw leaseError('SERIAL_RUNTIME_LEASE_MISMATCH', 'Runtime lease owner does not match', {
        expectedOwnerPid: ownerPid,
        actualOwnerPid: lease.ownerPid
      });
    }
    if (lease.ownerPid && !isProcessRunning(lease.ownerPid)) {
      throw leaseError('SERIAL_RUNTIME_LEASE_OWNER_EXITED', 'Runtime lease owner is not running', {
        ownerPid: lease.ownerPid
      });
    }

    this.everLeased = true;
    this.leases.set(leaseFile, {
      leaseFile,
      sessionId: sessionId || lease.sessionId,
      ownerPid: ownerPid || lease.ownerPid,
      lastSeenAt: Date.now()
    });
    this.start();
    return this.status();
  }

  status() {
    return {
      mode: this.persist ? 'persistent' : 'session-leased',
      active: this.leases.size,
      sessions: [...new Set(
        [...this.leases.values()].map(lease => lease.sessionId).filter(Boolean)
      )],
      expiring: this.expiring
    };
  }

  start() {
    if (this.persist || this.timer) return;
    this.timer = setInterval(() => {
      void this.check();
    }, this.checkIntervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.leases.clear();
  }

  async check() {
    if (this.persist || this.expiring) return;
    const now = Date.now();
    for (const [leaseFile, current] of this.leases) {
      const lease = readLease(leaseFile);
      const ownerAlive = lease?.ownerPid ? isProcessRunning(lease.ownerPid) : false;
      const matchesSession = !current.sessionId || !lease?.sessionId
        || current.sessionId === lease.sessionId;
      if (lease && ownerAlive && matchesSession) {
        current.ownerPid = lease.ownerPid;
        current.lastSeenAt = now;
        continue;
      }
      if (now - current.lastSeenAt >= this.expiryGraceMs) {
        this.leases.delete(leaseFile);
      }
    }

    if (!this.everLeased || this.leases.size > 0) return;
    this.expiring = true;
    try {
      await this.onExpired();
    } finally {
      this.stop();
    }
  }
}

function readLease(leaseFile) {
  try {
    const value = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const sessionId = normalizeText(value.sessionId, 256);
    const ownerPid = positivePid(value.ownerPid);
    if (!sessionId || !ownerPid) return null;
    return { sessionId, ownerPid };
  } catch {
    return null;
  }
}

function normalizeLeaseFile(value) {
  const leaseFile = normalizeText(value, 4096);
  if (!leaseFile || !path.isAbsolute(leaseFile)) {
    throw leaseError(
      'SERIAL_RUNTIME_LEASE_INVALID',
      'Runtime lease file must be an absolute path'
    );
  }
  return path.resolve(leaseFile);
}

function normalizeText(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

function positivePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 ? pid : 0;
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function boundedNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(min, Math.min(max, Math.round(number)));
}

function leaseError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

module.exports = {
  RuntimeLeaseMonitor,
  readLease
};
