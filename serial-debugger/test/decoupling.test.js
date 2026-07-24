'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOTS = ['runtime', 'ui/src', 'agent', 'scripts', 'skill'];
const TOP_LEVEL_SOURCES = ['cli.js', 'core.js', 'index.js', 'server.js', 'package.json'];
const HOST_COUPLING_PATTERN = /aily-blockly|serial-agent-bridge|blockly-live-operation|serial_agent_call/i;

function sourceFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(target);
    return /\.(?:js|mjs|ts|html|scss|json)$/.test(entry.name) ? [target] : [];
  });
}

test('Serial Debugger implementation and Agent contract have no host-framework dependency', () => {
  const files = [
    ...TOP_LEVEL_SOURCES.map(file => path.join(ROOT, file)),
    ...SOURCE_ROOTS.flatMap(directory => sourceFiles(path.join(ROOT, directory))),
  ];
  const coupled = files.flatMap(file => {
    const contents = fs.readFileSync(file, 'utf8');
    return HOST_COUPLING_PATTERN.test(contents)
      ? [path.relative(ROOT, file)]
      : [];
  });

  assert.deepEqual(coupled, []);
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies,
  };
  assert.equal(Object.keys(dependencies).some(name => /blockly/i.test(name)), false);
});
