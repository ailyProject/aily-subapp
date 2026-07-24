'use strict';

const DEFAULT_RESULT_MAX_BYTES = 48 * 1024;
const DEFAULT_PAGE_MAX_BYTES = 32 * 1024;
const DEFAULT_PREVIEW_BYTES = 2 * 1024;
const MAX_PAGE_MAX_BYTES = 256 * 1024;

function positiveInteger(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, maximum);
}

function jsonByteLength(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return Number.MAX_SAFE_INTEGER;
  }
}

function utf8Preview(value, maxBytes = DEFAULT_PREVIEW_BYTES) {
  const text = String(value || '');
  const budget = positiveInteger(maxBytes, DEFAULT_PREVIEW_BYTES);
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= budget) {
    return {
      value: text,
      originalBytes: buffer.length,
      returnedBytes: buffer.length,
      truncated: false
    };
  }

  const headBytes = Math.max(1, Math.floor(budget / 2));
  const tailBytes = Math.max(1, budget - headBytes);
  const head = buffer.subarray(0, headBytes).toString('utf8').replace(/\uFFFD+$/g, '');
  const tail = buffer.subarray(buffer.length - tailBytes).toString('utf8').replace(/^\uFFFD+/g, '');
  const valueWithMarker = `${head}\n…[${buffer.length - budget} bytes omitted]…\n${tail}`;

  return {
    value: valueWithMarker,
    head,
    tail,
    originalBytes: buffer.length,
    returnedBytes: Buffer.byteLength(valueWithMarker, 'utf8'),
    truncated: true
  };
}

function summarizeChunk(chunk = {}, options = {}) {
  const previewBytes = positiveInteger(options.previewBytes, DEFAULT_PREVIEW_BYTES);
  const text = utf8Preview(chunk.text || '', previewBytes);
  const hex = utf8Preview(chunk.hex || '', previewBytes);
  return {
    ...(chunk.portPath ? { portPath: String(chunk.portPath) } : {}),
    ...(chunk.timestamp ? { timestamp: Number(chunk.timestamp) } : {}),
    ...(chunk.rxBytes !== undefined ? { rxBytes: Number(chunk.rxBytes) } : {}),
    ...(chunk.txBytes !== undefined ? { txBytes: Number(chunk.txBytes) } : {}),
    byteLength: Number(chunk.byteLength || 0),
    text: text.value,
    hex: hex.value,
    truncated: text.truncated || hex.truncated
  };
}

function summarizeCapture(capture = {}, options = {}) {
  const previewBytes = positiveInteger(options.previewBytes, DEFAULT_PREVIEW_BYTES);
  const text = utf8Preview(capture.text || '', previewBytes);
  const hex = utf8Preview(capture.hex || '', previewBytes);
  const eventCount = Array.isArray(capture.events)
    ? capture.events.length
    : Number(capture.eventCount || 0);

  return {
    text: text.value,
    hex: hex.value,
    byteLength: Number(capture.byteLength || 0),
    startSeq: Number(capture.startSeq || 0),
    endSeq: Number(capture.endSeq || 0),
    eventCount,
    truncated: text.truncated || hex.truncated,
    preview: {
      maxBytesPerFormat: previewBytes,
      textBytes: text.originalBytes,
      hexBytes: hex.originalBytes
    }
  };
}

function summarizeObservation(observed = {}, options = {}) {
  return {
    ...(observed.matched !== undefined ? { matched: observed.matched === true } : {}),
    ...(observed.reason ? { reason: String(observed.reason) } : {}),
    ...(observed.expectation ? { expectation: observed.expectation } : {}),
    afterSeq: Number(observed.afterSeq || 0),
    startSeq: Number(observed.startSeq || observed.capture?.startSeq || 0),
    endSeq: Number(observed.endSeq || observed.capture?.endSeq || 0),
    durationMs: Number(observed.durationMs || 0),
    capture: summarizeCapture(observed.capture || {}, options)
  };
}

function summarizeErrorDetails(details = {}, options = {}) {
  if (!details || typeof details !== 'object') return details;
  return {
    ...details,
    ...(details.capture ? { capture: summarizeCapture(details.capture, options) } : {})
  };
}

function compactEvent(event = {}, options = {}) {
  const previewBytes = positiveInteger(options.previewBytes, DEFAULT_PREVIEW_BYTES);
  const data = event.data && typeof event.data === 'object'
    ? { ...event.data }
    : event.data;

  if (data && typeof data === 'object') {
    if (data.text !== undefined) data.text = utf8Preview(data.text, previewBytes).value;
    if (data.hex !== undefined) data.hex = utf8Preview(data.hex, previewBytes).value;
    delete data.base64;
    delete data.base64Chunks;
    delete data.events;
    data.truncated = true;
  }

  return {
    ...event,
    data
  };
}

module.exports = {
  DEFAULT_PAGE_MAX_BYTES,
  DEFAULT_PREVIEW_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
  MAX_PAGE_MAX_BYTES,
  compactEvent,
  jsonByteLength,
  positiveInteger,
  summarizeCapture,
  summarizeChunk,
  summarizeErrorDetails,
  summarizeObservation,
  utf8Preview
};
