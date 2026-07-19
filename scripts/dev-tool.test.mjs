import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { classifyChange } from './dev-tool.mjs';

const toolDir = path.resolve('test-tool');

test('classifies editable frontend files', () => {
  assert.equal(classifyChange(toolDir, path.join(toolDir, 'ui', 'src', 'app.ts')), 'frontend');
  assert.equal(classifyChange(toolDir, path.join(toolDir, 'i18n', 'zh_cn.json')), 'frontend');
});

test('ignores frontend build outputs and caches', () => {
  const ignoredPaths = [
    ['ui', '.angular', 'cache', '21.2.19', 'ui', '.tsbuildinfo'],
    ['ui', '.vite', 'deps', 'metadata.json'],
    ['ui', '.parcel-cache', 'data.mdb'],
    ['ui', 'dist', 'browser', 'main.js'],
    ['dist', 'video-converter', 'ui', 'main.js'],
  ];

  for (const segments of ignoredPaths) {
    assert.equal(classifyChange(toolDir, path.join(toolDir, ...segments)), '');
  }
});
