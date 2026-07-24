'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startSerialDebuggerServer } = require('../serial-debugger/server');

test('Serial and Mock Subapp Runtimes coexist and stop independently', async t => {
  const uiRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aily-subapp-coexistence-'));
  fs.writeFileSync(
    path.join(uiRoot, 'index.html'),
    '<!doctype html><html><body>Subapp fixture</body></html>',
    'utf8',
  );

  let serialRuntime;
  let mockRuntime;
  t.after(async () => {
    await Promise.allSettled([
      serialRuntime?.stop(),
      mockRuntime?.stop(),
    ]);
    fs.rmSync(uiRoot, { recursive: true, force: true });
  });

  [serialRuntime, mockRuntime] = await Promise.all([
    startSerialDebuggerServer({
      host: '127.0.0.1',
      port: 0,
      uiRoot,
      journal: false,
    }),
    startMockSubappServer(),
  ]);

  assert.notEqual(serialRuntime.port, mockRuntime.port);
  const [serialHealth, mockHealth, serialSnapshot] = await Promise.all([
    fetch(`${serialRuntime.origin}/health`).then(response => response.json()),
    fetch(`${mockRuntime.origin}/health`).then(response => response.json()),
    serialRuntime.core.executeAction({ action: 'runtime.snapshot' }),
  ]);

  assert.equal(serialHealth.ok, true);
  assert.equal(mockHealth.ok, true);
  assert.equal(serialSnapshot.state.connected, false);

  await serialRuntime.stop();
  const retainedMockHealth = await fetch(`${mockRuntime.origin}/health`)
    .then(response => response.json());
  assert.equal(retainedMockHealth.ok, true);
});

async function startMockSubappServer() {
  const server = http.createServer((request, response) => {
    if (request.url === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end('{"ok":true,"state":"ready"}\n');
      return;
    }
    response.writeHead(404);
    response.end('Not found');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    port,
    origin: `http://127.0.0.1:${port}`,
    stop: () => new Promise(resolve => server.close(resolve)),
  };
}
