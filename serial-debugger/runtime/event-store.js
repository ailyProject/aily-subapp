'use strict';

const { EventEmitter } = require('events');
const {
  DEFAULT_PAGE_MAX_BYTES,
  DEFAULT_PREVIEW_BYTES,
  MAX_PAGE_MAX_BYTES,
  compactEvent,
  jsonByteLength,
  positiveInteger
} = require('./result-budget');

const DEFAULT_MAX_EVENTS = 50000;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_TAIL_LIMIT = 200;
const MAX_TAIL_LIMIT = 500;
const DEFAULT_TAIL_MAX_BYTES = 64 * 1024;
const MAX_TAIL_MAX_BYTES = 128 * 1024;
const DEFAULT_TAIL_PREVIEW_BYTES = 1024;

function eventSize(event) {
  return Buffer.byteLength(JSON.stringify(event), 'utf8');
}

class SerialEventStore {
  constructor(options = {}) {
    this.maxEvents = positiveInteger(options.maxEvents, DEFAULT_MAX_EVENTS);
    this.maxBytes = positiveInteger(options.maxBytes, DEFAULT_MAX_BYTES);
    this.events = [];
    this.totalBytes = 0;
    this.nextSeq = 1;
    this.droppedBeforeSeq = 0;
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners(100);
  }

  get firstSeq() {
    return this.events[0]?.seq || this.nextSeq;
  }

  get lastSeq() {
    return this.events[this.events.length - 1]?.seq || this.nextSeq - 1;
  }

  append(event, data = {}, context = {}) {
    const envelope = {
      protocolVersion: 1,
      event,
      seq: this.nextSeq++,
      timestamp: Number(context.timestamp || data.timestamp || Date.now()),
      sessionId: String(context.sessionId || ''),
      actor: String(context.actor || 'runtime'),
      ...(context.actorId ? { actorId: String(context.actorId) } : {}),
      ...(context.runId ? { runId: String(context.runId) } : {}),
      ...(context.stepId ? { stepId: String(context.stepId) } : {}),
      data
    };
    const size = eventSize(envelope);
    this.events.push(envelope);
    this.totalBytes += size;
    this.trim();
    this.emitter.emit('event', envelope);
    return envelope;
  }

  read(options = {}) {
    const afterSeq = Math.max(0, Number(options.afterSeq) || 0);
    const limit = Math.min(5000, positiveInteger(options.limit, 500));
    const maxBytes = positiveInteger(
      options.maxBytes,
      DEFAULT_PAGE_MAX_BYTES,
      MAX_PAGE_MAX_BYTES
    );
    const previewBytes = positiveInteger(
      options.previewBytes,
      DEFAULT_PREVIEW_BYTES,
      Math.max(256, Math.floor(maxBytes / 2))
    );
    const eventNames = normalizeStringSet(options.events || options.event);
    const directions = normalizeStringSet(options.directions || options.direction);
    const matching = this.events.filter(event => {
      if (event.seq <= afterSeq) return false;
      if (eventNames && !eventNames.has(String(event.event).toUpperCase())) return false;
      if (directions) {
        const direction = eventDirection(event);
        if (!directions.has(direction)) return false;
      }
      return true;
    });
    const selected = [];
    const eventBudget = Math.max(0, maxBytes - 2048);
    let selectedBytes = 0;
    for (const event of matching) {
      if (selected.length >= limit) break;
      let candidate = event;
      let size = eventSize(candidate);
      if (size > Math.max(0, eventBudget - selectedBytes)) {
        candidate = compactEvent(event, {
          previewBytes: Math.min(previewBytes, Math.max(256, eventBudget - selectedBytes - 512))
        });
        size = eventSize(candidate);
      }
      if (size > Math.max(0, eventBudget - selectedBytes)) break;
      selected.push(candidate);
      selectedBytes += size;
    }
    const result = {
      firstSeq: this.firstSeq,
      lastSeq: this.lastSeq,
      droppedBeforeSeq: this.droppedBeforeSeq,
      afterSeq,
      maxBytes,
      count: selected.length,
      hasMore: matching.length > selected.length,
      nextAfterSeq: selected[selected.length - 1]?.seq || afterSeq,
      events: selected
    };
    result.returnedBytes = jsonByteLength(result);
    while (result.returnedBytes > maxBytes && result.events.length) {
      result.events.pop();
      result.count = result.events.length;
      result.hasMore = true;
      result.nextAfterSeq = result.events.at(-1)?.seq || afterSeq;
      result.returnedBytes = jsonByteLength(result);
    }
    return result;
  }

  tail(options = {}) {
    const limit = Math.min(
      MAX_TAIL_LIMIT,
      positiveInteger(options.limit, DEFAULT_TAIL_LIMIT)
    );
    const maxBytes = positiveInteger(
      options.maxBytes,
      DEFAULT_TAIL_MAX_BYTES,
      MAX_TAIL_MAX_BYTES
    );
    const previewBytes = positiveInteger(
      options.previewBytes,
      DEFAULT_TAIL_PREVIEW_BYTES,
      Math.max(256, Math.floor(maxBytes / 2))
    );
    const eventNames = normalizeStringSet(options.events || options.event);
    const directions = normalizeStringSet(options.directions || options.direction);
    const matching = this.events.filter(event => {
      if (eventNames && !eventNames.has(String(event.event).toUpperCase())) return false;
      if (directions && !directions.has(eventDirection(event))) return false;
      return true;
    });
    const selected = [];
    const eventBudget = Math.max(0, maxBytes - 2048);
    let selectedBytes = 0;

    for (let index = matching.length - 1; index >= 0; index -= 1) {
      if (selected.length >= limit) break;
      const event = matching[index];
      let candidate = event;
      let size = eventSize(candidate);
      if (size > Math.max(0, eventBudget - selectedBytes)) {
        candidate = compactEvent(event, {
          previewBytes: Math.min(previewBytes, Math.max(256, eventBudget - selectedBytes - 512))
        });
        size = eventSize(candidate);
      }
      if (size > Math.max(0, eventBudget - selectedBytes)) break;
      selected.unshift(candidate);
      selectedBytes += size;
    }

    const result = {
      source: 'memory',
      firstSeq: this.firstSeq,
      lastSeq: this.lastSeq,
      droppedBeforeSeq: this.droppedBeforeSeq,
      maxBytes,
      limit,
      count: selected.length,
      hasMore: matching.length > selected.length,
      truncated: matching.length > selected.length,
      events: selected
    };
    result.returnedBytes = jsonByteLength(result);
    while (result.returnedBytes > maxBytes && result.events.length) {
      result.events.shift();
      result.count = result.events.length;
      result.hasMore = true;
      result.truncated = true;
      result.returnedBytes = jsonByteLength(result);
    }
    return result;
  }

  subscribe(listener) {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  clear() {
    this.events = [];
    this.totalBytes = 0;
    this.droppedBeforeSeq = this.nextSeq - 1;
  }

  trim() {
    while (this.events.length > this.maxEvents || this.totalBytes > this.maxBytes) {
      const removed = this.events.shift();
      if (!removed) break;
      this.totalBytes = Math.max(0, this.totalBytes - eventSize(removed));
      this.droppedBeforeSeq = removed.seq;
    }
  }
}

function normalizeStringSet(value) {
  if (value === undefined || value === null || value === '') return null;
  const values = Array.isArray(value) ? value : [value];
  return new Set(values.map(item => String(item).toUpperCase()));
}

function eventDirection(event = {}) {
  const explicit = String(event.data?.direction || event.data?.dir || '').toUpperCase();
  if (explicit) return explicit;
  if (event.event === 'serial.rx') return 'RX';
  if (event.event === 'serial.tx') return 'TX';
  return 'SYS';
}

module.exports = {
  SerialEventStore,
  eventDirection,
  normalizeStringSet
};
