'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('Agent manifest only exposes implemented and bounded Serial Runtime tools', () => {
  const manifestPath = path.join(__dirname, '..', 'agent', 'tools.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(manifest.protocolVersion, 1);
  assert.equal(manifest.transport, 'aily-child-rpc');
  assert.deepEqual(manifest.lifecycle, {
    sessionRelease: {
      method: 'serial.session.close',
      params: {},
      timeoutMs: 5000
    }
  });

  const names = manifest.tools.map(tool => tool.name);
  assert.deepEqual(names, [
    'serial_ports_list',
    'serial_session_manage',
    'serial_transact',
    'serial_logs_read',
    'serial_artifact_read',
    'serial_artifact_search',
    'serial_scenario_run',
    'serial_scenario_control',
    'serial_analysis_run'
  ]);
  for (const tool of manifest.tools) {
    assert.match(tool.name, /^serial_[a-z0-9_]+$/);
    assert.ok(tool.description);
    assert.ok(tool.inputSchema);
    assert.ok(tool.timeoutMs > 0);
    assert.ok(tool.maxTimeoutMs >= tool.timeoutMs);
    assert.ok(tool.maxOutputBytes > 0);
    assert.ok(tool.maxOutputBytes <= 48 * 1024);
  }

  const sessionTool = manifest.tools.find(tool => tool.name === 'serial_session_manage');
  assert.deepEqual(sessionTool.presentation, {
    mode: 'dock',
    surface: 'compact',
    autoOpen: 'first-active',
    when: {
      param: 'action',
      values: ['open']
    }
  });
  assert.equal(
    Object.hasOwn(sessionTool.inputSchema.properties.presentUi, 'default'),
    false,
    'an injected default must not suppress the host presentation policy'
  );
});

test('package.json points to existing Agent skill and tool manifest files', () => {
  const packageJson = require('../package.json');
  assert.equal(packageJson.ailySubapp.runtime.startupTimeoutMs, 20000);
  assert.deepEqual(packageJson.ailySubapp.ui.surfaces.compact, {
    minWidth: 280,
    minHeight: 180,
    preferredHeight: 320,
    interactive: true
  });
  const agent = packageJson.ailySubapp.agent;
  assert.equal(agent.protocolVersion, 1);
  for (const relativePath of agent.skills) {
    assert.equal(fs.existsSync(path.join(__dirname, '..', relativePath)), true);
  }
  assert.equal(fs.existsSync(path.join(__dirname, '..', agent.tools.manifest)), true);
});
