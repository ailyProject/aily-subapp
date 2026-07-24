'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { resolveRuntimeRoot } = require('./runtime-paths');
const { callSerialRuntime, createRpcClientError } = require('./rpc-client');

function runtimeFiles(runtimeRoot = '') {
  const rootDir = resolveRuntimeRoot(runtimeRoot);
  return {
    rootDir,
    descriptorPath: path.join(rootDir, 'runtime.json'),
    lockPath: path.join(rootDir, 'runtime.lock'),
    daemonLogPath: path.join(rootDir, 'daemon.log')
  };
}

function loadRuntimeDescriptor(runtimeRoot = '') {
  const files = runtimeFiles(runtimeRoot);
  try {
    const descriptor = JSON.parse(fs.readFileSync(files.descriptorPath, 'utf8'));
    return { ...descriptor, runtimeRoot: files.rootDir };
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw createDaemonError('SERIAL_RUNTIME_DESCRIPTOR_INVALID', 'Serial Runtime descriptor is invalid', {
      path: files.descriptorPath,
      cause: error?.message || String(error)
    });
  }
}

async function daemonStatus(options = {}) {
  const files = runtimeFiles(options.runtimeRoot);
  const descriptor = loadRuntimeDescriptor(files.rootDir);
  if (!descriptor) {
    return {
      running: false,
      runtimeRoot: files.rootDir,
      descriptorPath: files.descriptorPath,
      daemonLogPath: files.daemonLogPath
    };
  }

  const health = await requestHealth(descriptor.origin, options.timeoutMs || 1000).catch(() => null);
  const running = Boolean(health?.ok) && isProcessRunning(descriptor.pid);
  return {
    running,
    runtimeRoot: files.rootDir,
    descriptorPath: files.descriptorPath,
    daemonLogPath: files.daemonLogPath,
    pid: Number(descriptor.pid || 0),
    startedAt: Number(descriptor.startedAt || 0),
    origin: descriptor.origin || '',
    url: descriptor.origin || '',
    sessionId: descriptor.sessionId || '',
    journalRoot: descriptor.journalRoot || '',
    lease: descriptor.lease || null,
    state: health?.state || null,
    stale: !running
  };
}

async function startDaemon(options = {}) {
  const files = runtimeFiles(options.runtimeRoot);
  fs.mkdirSync(files.rootDir, { recursive: true });
  const current = await daemonStatus({ runtimeRoot: files.rootDir });
  if (current.running) {
    const descriptor = loadRuntimeDescriptor(files.rootDir);
    const lease = await registerRuntimeLease(descriptor, options);
    return { ...current, alreadyRunning: true, ...(lease ? { lease } : {}) };
  }
  cleanupStaleRuntime(files);

  const logFd = fs.openSync(files.daemonLogPath, 'a');
  const args = [
    path.resolve(options.entryPath),
    'daemon-run',
    '--runtime-dir',
    files.rootDir,
    '--host',
    options.host || '127.0.0.1',
    '--port',
    String(Number(options.port || 0))
  ];
  if (options.persist === true) args.push('--persist');
  if (options.leaseFile) {
    args.push('--lease-file', path.resolve(options.leaseFile));
    if (options.leaseSessionId) {
      args.push('--lease-session-id', String(options.leaseSessionId));
    }
    if (options.leaseOwnerPid) {
      args.push('--lease-owner-pid', String(options.leaseOwnerPid));
    }
  }
  const child = childProcess.spawn(process.execPath, args, {
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    cwd: path.dirname(path.resolve(options.entryPath)),
    env: {
      ...process.env,
      AILY_SERIAL_RUNTIME_DIR: files.rootDir
    }
  });
  fs.closeSync(logFd);
  child.unref();

  const deadline = Date.now() + Math.max(1000, Number(options.startTimeoutMs || 8000));
  while (Date.now() < deadline) {
    await delay(100);
    const status = await daemonStatus({ runtimeRoot: files.rootDir, timeoutMs: 500 });
    if (status.running) {
      const descriptor = loadRuntimeDescriptor(files.rootDir);
      const lease = await registerRuntimeLease(descriptor, options);
      return { ...status, started: true, ...(lease ? { lease } : {}) };
    }
    if (!isProcessRunning(child.pid)) break;
  }
  throw createDaemonError(
    'SERIAL_DAEMON_START_FAILED',
    'Serial Runtime daemon did not become ready',
    {
      pid: child.pid,
      daemonLogPath: files.daemonLogPath
    }
  );
}

async function registerRuntimeLease(descriptor, options = {}) {
  if (!descriptor || descriptor.mode !== 'daemon' || !options.leaseFile) return null;
  return await callSerialRuntime(descriptor, 'runtime.lease.acquire', {
    leaseFile: path.resolve(options.leaseFile),
    sessionId: String(options.leaseSessionId || ''),
    ownerPid: Number(options.leaseOwnerPid || 0)
  }, { timeoutMs: 5000 });
}

async function stopDaemon(options = {}) {
  const files = runtimeFiles(options.runtimeRoot);
  const descriptor = loadRuntimeDescriptor(files.rootDir);
  if (!descriptor) {
    cleanupStaleRuntime(files);
    return { stopped: true, wasRunning: false, runtimeRoot: files.rootDir };
  }

  try {
    await callSerialRuntime(descriptor, 'shutdown', {}, { timeoutMs: 5000 });
  } catch (error) {
    if (isProcessRunning(descriptor.pid)) throw error;
  }
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline && isProcessRunning(descriptor.pid)) {
    await delay(100);
  }
  if (!isProcessRunning(descriptor.pid)) cleanupStaleRuntime(files, descriptor.pid);
  return {
    stopped: !isProcessRunning(descriptor.pid),
    wasRunning: true,
    pid: descriptor.pid,
    runtimeRoot: files.rootDir
  };
}

function acquireDaemonLock(runtimeRoot = '') {
  const files = runtimeFiles(runtimeRoot);
  fs.mkdirSync(files.rootDir, { recursive: true });
  let fd;
  try {
    fd = fs.openSync(files.lockPath, 'wx', 0o600);
    fs.writeFileSync(fd, `${process.pid}\n`, 'utf8');
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    throw createDaemonError('SERIAL_DAEMON_ALREADY_RUNNING', 'Serial Runtime daemon lock is already held', {
      lockPath: files.lockPath
    });
  }
  fs.closeSync(fd);
  return files;
}

function writeRuntimeDescriptor(files, descriptor) {
  const temporaryPath = `${files.descriptorPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(descriptor, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  fs.renameSync(temporaryPath, files.descriptorPath);
}

function cleanupOwnedRuntime(files, pid = process.pid) {
  const descriptor = loadRuntimeDescriptor(files.rootDir);
  if (!descriptor || Number(descriptor.pid) === Number(pid)) {
    removeFile(files.descriptorPath);
  }
  let lockPid = 0;
  try {
    lockPid = Number(fs.readFileSync(files.lockPath, 'utf8').trim());
  } catch {
    lockPid = 0;
  }
  if (!lockPid || lockPid === Number(pid)) removeFile(files.lockPath);
}

function cleanupStaleRuntime(files, expectedPid = 0) {
  const descriptor = loadRuntimeDescriptor(files.rootDir);
  if (descriptor && (!expectedPid || Number(descriptor.pid) === Number(expectedPid))) {
    if (!isProcessRunning(descriptor.pid)) removeFile(files.descriptorPath);
  }
  let lockPid = 0;
  try {
    lockPid = Number(fs.readFileSync(files.lockPath, 'utf8').trim());
  } catch {
    lockPid = 0;
  }
  if (!lockPid || !isProcessRunning(lockPid)) removeFile(files.lockPath);
}

function isProcessRunning(pid) {
  const processId = Number(pid);
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function requestHealth(origin, timeoutMs = 1000) {
  if (!origin) return Promise.reject(new Error('Missing Runtime origin'));
  return new Promise((resolve, reject) => {
    const request = http.get(`${origin}/health`, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        if (body.length < 1024 * 1024) body += chunk;
      });
      response.on('end', () => {
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Health check timed out')));
    request.on('error', reject);
  });
}

function sanitizeDescriptor(descriptor = {}) {
  const {
    token: _token,
    wsUrl: _wsUrl,
    shutdownUrl: _shutdownUrl,
    url: _url,
    ...safe
  } = descriptor;
  return safe;
}

function createDaemonError(code, message, details = {}) {
  return createRpcClientError(code, message, details);
}

function removeFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function delay(durationMs) {
  return new Promise(resolve => setTimeout(resolve, durationMs));
}

module.exports = {
  acquireDaemonLock,
  cleanupOwnedRuntime,
  daemonStatus,
  loadRuntimeDescriptor,
  runtimeFiles,
  sanitizeDescriptor,
  registerRuntimeLease,
  startDaemon,
  stopDaemon,
  writeRuntimeDescriptor
};
