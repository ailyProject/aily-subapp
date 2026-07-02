#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { watch } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectoryNames = new Set([
  '.git',
  '.cache',
  'coverage',
  'dist',
  'build',
  'node_modules',
  'vendor'
]);
const frontendTopLevelDirs = new Set(['ui', 'i18n']);
const ignoredGeneratedFrontendFiles = new Set([
  'ui/public/fonts/fontawesome6/css/aily-chat-icons.css',
]);
const backendRootFiles = new Set([
  'cli.js',
  'core.js',
  'index.js',
  'package.json',
  'package-lock.json',
  'server.js'
]);
const npmCommand = 'npm';

function usage() {
  return [
    'Usage:',
    '  npm run dev -- <tool-id> [options]',
    '',
    'Options:',
    '  --host <host>             Host for the child tool server. Default: 127.0.0.1',
    '  --port <port>             Stable child tool port. Default: derived per tool',
    '  --reload-port <port>      Stable live reload port. Default: derived per tool',
    '  --lang <lang>             Startup lang query value. Default: zh_cn',
    '  --theme <light|dark>      Startup theme query value. Default: dark',
    '  --token <token>           Stable dev token. Default: derived per run',
    '  --open                    Open the tool URL in the system browser',
    '',
    'Examples:',
    '  npm run dev -- mqtt-debugger',
    '  npm run dev -- ffs-manager --lang zh_cn --theme light',
    '  npm run dev -- ffs-manager-child --port 18450'
  ].join('\n');
}

function parseArgs(argv) {
  const options = { _: [] };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const rawKey = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
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

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      shell: process.platform === 'win32',
      stdio: options.stdio || 'inherit'
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

async function runToolScriptIfPresent(toolDir, scriptName) {
  const packagePath = path.join(toolDir, 'package.json');
  if (!(await pathExists(packagePath))) return false;

  const packageJson = await readJson(packagePath);
  if (!packageJson.scripts?.[scriptName]) return false;

  console.log(`[dev] running ${scriptName}`);
  await runCommand(npmCommand, ['run', scriptName], { cwd: toolDir });
  return true;
}

function hashText(text) {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function derivedPort(toolId, base) {
  return base + (hashText(toolId) % 1000);
}

async function isPortFree(host, port) {
  return new Promise(resolve => {
    const server = createNetServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

async function pickPort(host, requestedPort, defaultPort) {
  if (requestedPort && Number(requestedPort) > 0) {
    return Number(requestedPort);
  }

  let port = defaultPort;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await isPortFree(host, port)) return port;
    port += 1;
  }

  throw new Error(`Could not find a free port near ${defaultPort}`);
}

async function resolveTool(toolArg) {
  const directDir = path.resolve(rootDir, toolArg);
  if (await pathExists(path.join(directDir, 'package.json'))) {
    return {
      id: toolArg,
      dir: directDir,
      config: null
    };
  }

  const configCandidates = [
    path.join(rootDir, 'index.json'),
    path.join(rootDir, 'index-backup.json'),
    path.join(rootDir, 'child', 'tools', 'index.json')
  ];

  for (const configPath of configCandidates) {
    if (!(await pathExists(configPath))) continue;
    const config = await readJson(configPath);
    const entry = config[toolArg] || Object.values(config).find(item => item?.id === toolArg);
    if (!entry) continue;

    const childDir = String(entry.childDir || `tools/${entry.id || toolArg}`).replace(/\\/g, '/');
    const childBaseName = childDir.split('/').filter(Boolean).pop() || toolArg;
    const dirCandidates = [
      path.join(rootDir, childDir),
      path.join(rootDir, 'child', childDir),
      path.join(rootDir, 'child', 'tools', childBaseName),
      path.join(rootDir, childBaseName)
    ];

    for (const dir of dirCandidates) {
      if (await pathExists(path.join(dir, 'package.json'))) {
        return {
          id: entry.id || toolArg,
          dir: path.resolve(dir),
          config: entry
        };
      }
    }
  }

  throw new Error(`Unknown tool: ${toolArg}`);
}

function appendContext(url, lang, theme) {
  const parsed = new URL(url);
  parsed.searchParams.set('lang', lang);
  parsed.searchParams.set('theme', theme);
  return parsed.toString();
}

async function startReloadServer(host, port) {
  const clients = new Set();
  let heartbeatTimer;

  const server = createHttpServer((request, response) => {
    const requestUrl = new URL(request.url || '/', `http://${host}`);
    if (requestUrl.pathname === '/health') {
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }

    if (requestUrl.pathname !== '/events') {
      response.writeHead(404);
      response.end('Not found');
      return;
    }

    response.writeHead(200, {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no'
    });
    response.write(': connected\n\n');
    clients.add(response);
    request.on('close', () => {
      clients.delete(response);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  heartbeatTimer = setInterval(() => {
    for (const client of clients) {
      client.write(': heartbeat\n\n');
    }
  }, 15000);

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    url: `http://${host}:${actualPort}/events`,
    broadcast(event, data = {}) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) {
        client.write(payload);
      }
    },
    async close() {
      clearInterval(heartbeatTimer);
      for (const client of clients) {
        client.end();
      }
      await new Promise(resolve => server.close(resolve));
    }
  };
}

function splitLines(onLine) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (line) onLine(line);
    }
  };
}

function printReady(toolId, readyUrl, data) {
  console.log(`[dev] ${toolId} ready`);
  console.log(`[dev] url: ${readyUrl}`);
  console.log(`[dev] ws: ${data.wsUrl || ''}`);
  console.log(`[dev] pid: ${data.pid || ''}`);
}

function openInBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

async function collectWatchDirs(dir) {
  const dirs = [dir];
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (ignoredDirectoryNames.has(entry.name)) continue;
    const childDir = path.join(dir, entry.name);
    dirs.push(...await collectWatchDirs(childDir));
  }

  return dirs;
}

function relativeToolPath(toolDir, filePath) {
  return path.relative(toolDir, filePath).replace(/\\/g, '/');
}

function classifyChange(toolDir, filePath) {
  const relative = relativeToolPath(toolDir, filePath);
  if (!relative || relative.startsWith('..')) return '';

  const segments = relative.split('/');
  if (segments.some(segment => ignoredDirectoryNames.has(segment))) return '';
  if (ignoredGeneratedFrontendFiles.has(relative)) return '';

  if (backendRootFiles.has(relative)) return 'backend';
  if (frontendTopLevelDirs.has(segments[0])) return 'frontend';
  if (segments[0] === 'skill') return '';
  if (segments[0] === 'scripts') return 'frontend';
  if (relative.endsWith('.js') || relative.endsWith('.cjs') || relative.endsWith('.mjs')) {
    return 'backend';
  }

  return '';
}

function createToolWatcher(toolDir, onChange) {
  const watchers = new Map();
  let closed = false;
  let refreshTimer = null;

  async function refresh() {
    if (closed) return;

    for (const watcher of watchers.values()) {
      watcher.close();
    }
    watchers.clear();

    const dirs = await collectWatchDirs(toolDir);
    for (const dir of dirs) {
      try {
        const watcher = watch(dir, (eventType, filename) => {
          const filePath = filename ? path.join(dir, String(filename)) : dir;
          onChange(filePath);

          if (eventType === 'rename') {
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(() => {
              void refresh().catch(error => {
                console.error(`[dev] watcher refresh failed: ${error.message}`);
              });
            }, 250);
          }
        });
        watchers.set(dir, watcher);
      } catch (error) {
        console.warn(`[dev] could not watch ${dir}: ${error.message}`);
      }
    }
  }

  return {
    async start() {
      await refresh();
    },
    close() {
      closed = true;
      clearTimeout(refreshTimer);
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
    }
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const toolArg = args._[0];
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  if (!toolArg) {
    console.log(usage());
    process.exit(1);
  }

  const tool = await resolveTool(toolArg);
  const host = String(args.host || '127.0.0.1');
  const lang = String(args.lang || 'zh_cn');
  const theme = args.theme === 'light' ? 'light' : 'dark';
  const childPort = await pickPort(host, args.port, derivedPort(tool.id, 18000));
  const reloadPort = await pickPort(host, args.reloadPort, derivedPort(tool.id, 19000));
  const token = String(args.token || `dev-${tool.id}-${Date.now().toString(36)}`);
  const restartDelayMs = Number(args.restartDelayMs || 150);
  const reloadServer = await startReloadServer(host, reloadPort);
  let child = null;
  let shuttingDown = false;
  let restarting = false;
  let currentReady = null;
  let opened = false;
  let debounceTimer = null;
  let pendingChangeKind = '';
  let pendingFiles = new Set();
  let uiBuildInProgress = false;

  async function runUiBuild() {
    if (uiBuildInProgress) return;
    uiBuildInProgress = true;
    try {
      await runToolScriptIfPresent(tool.dir, 'build:ui').catch(error => {
        console.error(`[dev] build:ui failed: ${error.message}`);
      });
    } finally {
      uiBuildInProgress = false;
    }
  }

  function childEnv() {
    return {
      ...process.env,
      ...(tool.config?.env || {}),
      AILY_TOOL_DEV: '1',
      AILY_TOOL_DEV_RELOAD_URL: reloadServer.url
    };
  }

  async function stopChild() {
    const runningChild = child;
    if (!runningChild || runningChild.exitCode !== null) return;

    await new Promise(resolve => {
      const timer = setTimeout(() => {
        if (runningChild.exitCode === null) runningChild.kill('SIGKILL');
      }, 2000);

      runningChild.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
      runningChild.kill('SIGTERM');
    });
  }

  async function startChild(reason = 'start') {
    currentReady = null;
    const childArgs = [
      'index.js',
      'serve',
      '--host',
      host,
      '--port',
      String(childPort),
      '--token',
      token
    ];

    console.log(`[dev] ${reason}: node ${childArgs.join(' ')}`);
    child = spawn(process.execPath, childArgs, {
      cwd: tool.dir,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe']
    });

    return new Promise((resolve, reject) => {
      const readyTimer = setTimeout(() => {
        reject(new Error(`${tool.id} did not become ready within 15000ms`));
      }, 15000);

      const finishReady = data => {
        clearTimeout(readyTimer);
        currentReady = data;
        const readyUrl = appendContext(data.url, lang, theme);
        printReady(tool.id, readyUrl, data);
        if (args.open && !opened) {
          opened = true;
          openInBrowser(readyUrl);
        }
        resolve(data);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', splitLines(line => {
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          console.log(`[${tool.id}] ${line}`);
          return;
        }

        if (message.event === 'ready' && message.data?.url) {
          finishReady(message.data);
          return;
        }

        if (message.event === 'fatal') {
          clearTimeout(readyTimer);
          reject(new Error(message.data?.message || `${tool.id} fatal startup error`));
        }

        console.log(`[${tool.id}] ${line}`);
      }));

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        for (const line of String(chunk).split(/\r?\n/)) {
          if (line.trim()) console.error(`[${tool.id}] ${line}`);
        }
      });

      child.once('exit', (code, signal) => {
        clearTimeout(readyTimer);
        if (!shuttingDown && !restarting) {
          console.warn(`[dev] ${tool.id} exited: code=${code ?? ''} signal=${signal ?? ''}`);
        }
      });
    });
  }

  async function restartChild(files) {
    restarting = true;
    console.log(`[dev] backend changed: ${Array.from(files).slice(0, 4).join(', ')}`);
    await stopChild();
    try {
      await startChild('restart');
      reloadServer.broadcast('reload', {
        reason: 'backend',
        time: Date.now()
      });
    } finally {
      restarting = false;
    }
  }

  async function flushChanges() {
    const changeKind = pendingChangeKind;
    const files = pendingFiles;
    pendingChangeKind = '';
    pendingFiles = new Set();

    if (!changeKind) return;
    if (changeKind === 'backend') {
      await restartChild(files).catch(error => {
        console.error(`[dev] restart failed: ${error.message}`);
      });
      return;
    }

    const fileList = Array.from(files);
    console.log(`[dev] frontend changed: ${fileList.slice(0, 4).join(', ')}`);
    if (fileList.some(file => file.startsWith('ui/') || file.startsWith('scripts/'))) {
      await runUiBuild();
    }
    reloadServer.broadcast('reload', {
      reason: 'frontend',
      time: Date.now()
    });
  }

  function scheduleChange(filePath) {
    const kind = classifyChange(tool.dir, filePath);
    if (!kind) return;

    const relativePath = relativeToolPath(tool.dir, filePath);
    pendingFiles.add(relativePath);
    pendingChangeKind = pendingChangeKind === 'backend' || kind === 'backend' ? 'backend' : 'frontend';

    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      void flushChanges();
    }, restartDelayMs);
  }

  const watcher = createToolWatcher(tool.dir, scheduleChange);

  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    clearTimeout(debounceTimer);
    watcher.close();
    await stopChild().catch(() => undefined);
    await reloadServer.close().catch(() => undefined);
  }

  process.on('SIGINT', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void shutdown().finally(() => process.exit(0));
  });
  process.on('uncaughtException', error => {
    console.error(`[dev] fatal: ${error.stack || error.message}`);
    void shutdown().finally(() => process.exit(1));
  });
  process.on('unhandledRejection', error => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(`[dev] fatal: ${message}`);
    void shutdown().finally(() => process.exit(1));
  });

  console.log(`[dev] tool: ${tool.id}`);
  console.log(`[dev] dir: ${path.relative(rootDir, tool.dir).replace(/\\/g, '/')}`);
  console.log(`[dev] reload: ${reloadServer.url}`);

  await runUiBuild();
  await startChild();
  await watcher.start();
  console.log('[dev] watching ui/i18n for reload and backend files for restart');
}

main().catch(error => {
  console.error(`[dev] ${error.message}`);
  process.exit(1);
});
