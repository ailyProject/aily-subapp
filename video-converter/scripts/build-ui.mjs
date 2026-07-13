#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_ID = 'video-converter';
const toolDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const uiDir = path.join(toolDir, 'ui');
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) continue;

    const eqIndex = arg.indexOf('=');
    const key = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    let value = eqIndex >= 0 ? arg.slice(eqIndex + 1) : true;
    if (eqIndex < 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      value = argv[index + 1];
      index += 1;
    }
    options[key] = value;
  }
  return options;
}

async function pathExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function assertWithin(parentDir, childPath) {
  const parent = path.resolve(parentDir);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);

  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing to operate outside ${parent}: ${child}`);
  }
}

async function emptyDirectory(dir) {
  assertWithin(toolDir, dir);
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    await rm(path.join(dir, entry.name), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

async function copyDirectoryContents(sourceDir, destinationDir) {
  await mkdir(destinationDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    await cp(path.join(sourceDir, entry.name), path.join(destinationDir, entry.name), { recursive: true });
  }
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      shell: process.platform === 'win32',
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
  });
}

const options = parseArgs(process.argv.slice(2));
const outdir = path.resolve(toolDir, options.outdir || path.join('dist', TOOL_ID, 'ui'));
const buildRoot = path.join(toolDir, 'dist', '.angular-ui-build');

assertWithin(toolDir, outdir);
assertWithin(toolDir, buildRoot);
await emptyDirectory(outdir);
await emptyDirectory(buildRoot);

await runCommand(npmCommand, [
  'run',
  'build',
  '--',
  '--configuration',
  'production',
  '--base-href',
  './',
  '--output-path',
  buildRoot
], { cwd: uiDir });

const browserDir = path.join(buildRoot, 'browser');
const sourceDir = await pathExists(path.join(browserDir, 'index.html')) ? browserDir : buildRoot;
await copyDirectoryContents(sourceDir, outdir);
await rm(buildRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

console.log(`Angular UI built -> ${path.relative(toolDir, outdir).replace(/\\/g, '/')}`);
