'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { SerialEventStore } = require('../runtime/event-store');

test('assigns ordered sequence numbers and reads from an explicit zero cursor', () => {
  const store = new SerialEventStore({ maxEvents: 10, maxBytes: 1024 * 1024 });
  store.append('serial.opened', { connected: true });
  store.append('serial.rx', { text: 'OK', byteLength: 2 });

  const result = store.read({ afterSeq: 0, limit: 10 });
  assert.deepEqual(result.events.map(event => event.seq), [1, 2]);
  assert.equal(result.firstSeq, 1);
  assert.equal(result.lastSeq, 2);
});

test('evicts old events and reports the dropped cursor', () => {
  const store = new SerialEventStore({ maxEvents: 2, maxBytes: 1024 * 1024 });
  store.append('one', {});
  store.append('two', {});
  store.append('three', {});

  const result = store.read({ afterSeq: 0, limit: 10 });
  assert.deepEqual(result.events.map(event => event.event), ['two', 'three']);
  assert.equal(result.droppedBeforeSeq, 1);
  assert.equal(result.firstSeq, 2);
});

test('filters event names case-insensitively', () => {
  const store = new SerialEventStore();
  store.append('serial.tx', {});
  store.append('serial.rx', {});

  const result = store.read({ afterSeq: 0, events: ['serial.rx'] });
  assert.deepEqual(result.events.map(event => event.event), ['serial.rx']);
});

test('derives RX, TX, and SYS directions for log filtering', () => {
  const store = new SerialEventStore();
  store.append('serial.opened', {});
  store.append('serial.tx', {});
  store.append('serial.rx', {});

  assert.deepEqual(
    store.read({ afterSeq: 0, directions: ['TX'] }).events.map(event => event.event),
    ['serial.tx']
  );
  assert.deepEqual(
    store.read({ afterSeq: 0, directions: ['SYS'] }).events.map(event => event.event),
    ['serial.opened']
  );
});

test('bounds a log page by serialized UTF-8 bytes and compacts oversized events', () => {
  const store = new SerialEventStore({ maxBytes: 1024 * 1024 });
  store.append('serial.rx', {
    text: '温'.repeat(10000),
    hex: 'aa '.repeat(10000),
    base64: 'A'.repeat(10000),
    byteLength: 30000
  });

  const result = store.read({
    afterSeq: 0,
    limit: 100,
    maxBytes: 8192,
    previewBytes: 1024
  });

  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 8192);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].data.base64, undefined);
  assert.equal(result.events[0].data.truncated, true);
});

test('returns only the newest bounded Runtime tail without scanning from sequence zero', () => {
  const store = new SerialEventStore({ maxEvents: 1000, maxBytes: 1024 * 1024 });
  for (let index = 0; index < 300; index += 1) {
    store.append(index % 2 === 0 ? 'serial.rx' : 'serial.tx', {
      text: `line-${index}`,
      byteLength: 8
    });
  }

  const result = store.tail({ limit: 25, maxBytes: 16 * 1024 });
  assert.equal(result.count, 25);
  assert.equal(result.events[0].data.text, 'line-275');
  assert.equal(result.events.at(-1).data.text, 'line-299');
  assert.equal(result.hasMore, true);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 16 * 1024);
});

test('hard-caps Runtime tail event and byte budgets', () => {
  const store = new SerialEventStore({ maxEvents: 1000, maxBytes: 4 * 1024 * 1024 });
  for (let index = 0; index < 700; index += 1) {
    store.append('serial.rx', {
      text: 'x'.repeat(2048),
      hex: 'aa '.repeat(2048),
      byteLength: 2048
    });
  }

  const result = store.tail({
    limit: 50000,
    maxBytes: 10 * 1024 * 1024,
    previewBytes: 4096
  });
  assert.ok(result.count <= 500);
  assert.equal(result.maxBytes, 128 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(result), 'utf8') <= 128 * 1024);
});
