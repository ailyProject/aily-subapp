'use strict';

const { summarizeCapture } = require('./result-budget');

const MAX_REGEX_LENGTH = 500;
const DEFAULT_TIMEOUT_MS = 3000;
const DEFAULT_MAX_BYTES = 64 * 1024;

function numberInRange(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeHex(value) {
  return String(value || '').replace(/\s+/g, '').toLowerCase();
}

function createMatcher(expectation = {}) {
  const type = String(expectation.type || (expectation.pattern ? 'regex' : 'any')).toLowerCase();
  if (type === 'any') {
    return {
      type,
      test: aggregate => aggregate.byteLength > 0,
      describe: 'any serial response'
    };
  }
  if (type === 'text' || type === 'line') {
    const expected = String(expectation.value ?? expectation.text ?? expectation.pattern ?? '');
    if (!expected) throw createError('INVALID_EXPECTATION', 'Text expectation cannot be empty');
    return {
      type,
      test: aggregate => type === 'line'
        ? aggregate.text.split(/\r\n|\n|\r/).some(line => line.includes(expected))
        : aggregate.text.includes(expected),
      describe: expected
    };
  }
  if (type === 'hex') {
    const expected = normalizeHex(expectation.value ?? expectation.hex ?? expectation.pattern);
    if (!expected || expected.length % 2) {
      throw createError('INVALID_EXPECTATION', 'HEX expectation must contain complete bytes');
    }
    return {
      type,
      test: aggregate => normalizeHex(aggregate.hex).includes(expected),
      describe: expected
    };
  }
  if (type === 'regex') {
    const pattern = String(expectation.pattern ?? expectation.value ?? '');
    if (!pattern) throw createError('INVALID_EXPECTATION', 'Regex expectation cannot be empty');
    if (pattern.length > MAX_REGEX_LENGTH) {
      throw createError('INVALID_EXPECTATION', `Regex expectation exceeds ${MAX_REGEX_LENGTH} characters`);
    }
    const flags = String(expectation.flags || '').replace(/[^gimsuy]/g, '').replace(/g/g, '');
    let regex;
    try {
      regex = new RegExp(pattern, flags);
    } catch (error) {
      throw createError('INVALID_EXPECTATION', `Invalid regular expression: ${error.message}`);
    }
    return {
      type,
      test: aggregate => regex.test(aggregate.text),
      describe: `/${pattern}/${flags}`
    };
  }
  throw createError('INVALID_EXPECTATION', `Unsupported expectation type: ${type}`);
}

function aggregateRxEvents(events) {
  const rxEvents = events.filter(event => event.event === 'serial.rx');
  return {
    text: rxEvents.map(event => String(event.data?.text || '')).join(''),
    hex: rxEvents.map(event => String(event.data?.hex || '')).filter(Boolean).join(' '),
    base64Chunks: rxEvents.map(event => String(event.data?.base64 || '')).filter(Boolean),
    byteLength: rxEvents.reduce((sum, event) => sum + Number(event.data?.byteLength || 0), 0),
    startSeq: rxEvents[0]?.seq || 0,
    endSeq: rxEvents[rxEvents.length - 1]?.seq || 0,
    events: rxEvents
  };
}

function waitForExpectation(eventStore, options = {}) {
  const matcher = createMatcher(options.expect || options.expectation || options);
  const afterSeq = options.afterSeq === undefined
    ? eventStore.lastSeq
    : Math.max(0, Number(options.afterSeq) || 0);
  const timeoutMs = numberInRange(options.timeoutMs, DEFAULT_TIMEOUT_MS, 1, 120000);
  const maxBytes = numberInRange(options.maxBytes, DEFAULT_MAX_BYTES, 1, 16 * 1024 * 1024);
  const signal = options.signal;
  const startedAt = Date.now();
  const events = eventStore.read({
    afterSeq,
    limit: 5000,
    events: ['serial.rx', 'serial.error', 'serial.closed', 'serial.disconnected']
  }).events;

  return new Promise((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => undefined;
    let timer;
    const abortHandler = () => finish(reject, createError('OPERATION_CANCELLED', 'Serial expectation was cancelled', {
      afterSeq,
      lastSeq: eventStore.lastSeq
    }));

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener?.('abort', abortHandler);
      callback(value);
    };

    const evaluate = () => {
      const aggregate = aggregateRxEvents(events);
      if (aggregate.byteLength > maxBytes) {
        finish(reject, createError('CAPTURE_LIMIT_REACHED', `Captured serial data exceeds ${maxBytes} bytes`, {
          afterSeq,
          lastSeq: aggregate.endSeq,
          maxBytes
        }));
        return;
      }
      if (matcher.test(aggregate)) {
        finish(resolve, {
          matched: true,
          expectation: {
            type: matcher.type,
            description: matcher.describe
          },
          afterSeq,
          startSeq: aggregate.startSeq,
          endSeq: aggregate.endSeq,
          durationMs: Date.now() - startedAt,
          capture: aggregate
        });
      }
    };

    unsubscribe = eventStore.subscribe(event => {
      if (event.seq <= afterSeq) return;
      if (event.event === 'serial.error') {
        finish(reject, createError(
          event.data?.code || 'SERIAL_ERROR',
          event.data?.message || 'Serial port error',
          {
            seq: event.seq,
            ...(event.data?.details || {})
          }
        ));
        return;
      }
      if (event.event === 'serial.disconnected') {
        finish(reject, createError('DEVICE_DISCONNECTED', 'Serial device disconnected while waiting for a response', {
          seq: event.seq,
          ...(event.data?.lastError?.details || {})
        }));
        return;
      }
      if (event.event === 'serial.closed') {
        finish(reject, createError('PORT_DISCONNECTED', 'Serial session closed while waiting for a response', {
          seq: event.seq
        }));
        return;
      }
      if (event.event !== 'serial.rx') return;
      events.push(event);
      evaluate();
    });

    timer = setTimeout(() => {
      const aggregate = aggregateRxEvents(events);
      finish(reject, createError('EXPECT_TIMEOUT', `Expected ${matcher.describe} was not observed before timeout`, {
        afterSeq,
        lastSeq: aggregate.endSeq || eventStore.lastSeq,
        timeoutMs,
        capture: summarizeCapture(aggregate)
      }));
    }, timeoutMs);

    if (signal?.aborted) {
      abortHandler();
      return;
    }
    signal?.addEventListener?.('abort', abortHandler, { once: true });
    evaluate();
  });
}

function captureSerialData(eventStore, options = {}) {
  const afterSeq = options.afterSeq === undefined
    ? eventStore.lastSeq
    : Math.max(0, Number(options.afterSeq) || 0);
  const durationMs = numberInRange(options.durationMs ?? options.timeoutMs, 1000, 1, 120000);
  const quietMs = numberInRange(options.quietMs, 0, 0, 30000);
  const maxBytes = numberInRange(options.maxBytes, DEFAULT_MAX_BYTES, 1, 16 * 1024 * 1024);
  const signal = options.signal;
  const startedAt = Date.now();
  const events = [];

  return new Promise((resolve, reject) => {
    let settled = false;
    let durationTimer;
    let quietTimer;
    let unsubscribe = () => undefined;
    const abortHandler = () => {
      if (settled) return;
      settled = true;
      clearTimeout(durationTimer);
      clearTimeout(quietTimer);
      unsubscribe();
      signal?.removeEventListener?.('abort', abortHandler);
      reject(createError('OPERATION_CANCELLED', 'Serial capture was cancelled', {
        afterSeq,
        lastSeq: eventStore.lastSeq
      }));
    };

    const finish = (reason) => {
      if (settled) return;
      settled = true;
      clearTimeout(durationTimer);
      clearTimeout(quietTimer);
      unsubscribe();
      signal?.removeEventListener?.('abort', abortHandler);
      const aggregate = aggregateRxEvents(events);
      resolve({
        reason,
        afterSeq,
        startSeq: aggregate.startSeq,
        endSeq: aggregate.endSeq,
        durationMs: Date.now() - startedAt,
        capture: aggregate
      });
    };

    const scheduleQuiet = () => {
      if (!quietMs) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(() => finish('quiet'), quietMs);
    };

    const fail = (code, message, details = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(durationTimer);
      clearTimeout(quietTimer);
      unsubscribe();
      signal?.removeEventListener?.('abort', abortHandler);
      reject(createError(code, message, details));
    };

    unsubscribe = eventStore.subscribe(event => {
      if (event.seq <= afterSeq) return;
      if (event.event === 'serial.error') {
        fail(event.data?.code || 'SERIAL_ERROR', event.data?.message || 'Serial port error', {
          seq: event.seq,
          ...(event.data?.details || {})
        });
        return;
      }
      if (event.event === 'serial.disconnected') {
        fail('DEVICE_DISCONNECTED', 'Serial device disconnected while capturing data', {
          seq: event.seq,
          ...(event.data?.lastError?.details || {})
        });
        return;
      }
      if (event.event === 'serial.closed') {
        fail('PORT_DISCONNECTED', 'Serial session closed while capturing data', {
          seq: event.seq
        });
        return;
      }
      if (event.event !== 'serial.rx') return;
      events.push(event);
      const aggregate = aggregateRxEvents(events);
      if (aggregate.byteLength > maxBytes) {
        settled = true;
        clearTimeout(durationTimer);
        clearTimeout(quietTimer);
        unsubscribe();
        signal?.removeEventListener?.('abort', abortHandler);
        reject(createError('CAPTURE_LIMIT_REACHED', `Captured serial data exceeds ${maxBytes} bytes`, {
          afterSeq,
          lastSeq: aggregate.endSeq,
          maxBytes
        }));
        return;
      }
      scheduleQuiet();
    });

    durationTimer = setTimeout(() => finish('duration'), durationMs);
    if (signal?.aborted) {
      abortHandler();
      return;
    }
    signal?.addEventListener?.('abort', abortHandler, { once: true });
  });
}

function createError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

module.exports = {
  aggregateRxEvents,
  captureSerialData,
  createError,
  createMatcher,
  waitForExpectation
};
