#!/usr/bin/env node
'use strict';

const readline = require('readline');
const { asError, createSerialDebuggerCore } = require('./core');
const { parseCliArgs, requestedCommandFromArgs, runCli } = require('./cli');
const { startSerialDebuggerServer } = require('./server');
const {
  acquireDaemonLock,
  cleanupOwnedRuntime,
  daemonStatus,
  loadRuntimeDescriptor,
  sanitizeDescriptor,
  startDaemon,
  stopDaemon,
  writeRuntimeDescriptor
} = require('./runtime/daemon');
const { callSerialRuntime } = require('./runtime/rpc-client');
const { SerialJournal } = require('./runtime/journal');
const { RuntimeLeaseMonitor } = require('./runtime/lease-monitor');

const cliArgs = process.argv.slice(2);
const requestedCommand = requestedCommandFromArgs(cliArgs);

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function sendResponse(id, ok, data = {}, error = '') {
  write({ id, ok, data, error });
}

function startRpcServer() {
  const sendEvent = (event, data = {}, envelope) => write(envelope || { event, data });
  let core;

  try {
    const journal = new SerialJournal();
    core = createSerialDebuggerCore({
      sendEvent,
      journal,
      sessionId: journal.sessionId
    });
  } catch (error) {
    sendEvent('fatal', { message: asError(error) });
    process.exit(1);
    return;
  }

  let shuttingDown = false;
  const shutdownAndExit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    void core.cleanup().finally(() => {
      setTimeout(() => process.exit(0), 10);
    });
  };

  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity
  });

  rl.on('line', line => {
    const text = line.trim();
    if (!text) return;

    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      sendEvent('error', { message: asError(error) });
      return;
    }

    void handleRpcMessage(core, message).then(() => {
      if (message.action === 'shutdown' || message.method === 'shutdown') {
        shutdownAndExit();
      }
    });
  });

  process.on('SIGTERM', shutdownAndExit);
  process.on('SIGINT', shutdownAndExit);
  process.on('uncaughtException', error => {
    sendEvent('fatal', { message: asError(error) });
    process.exit(1);
  });
  process.on('unhandledRejection', error => {
    sendEvent('error', { message: asError(error) });
  });

  sendEvent('ready', {
    state: core.status(),
    pid: process.pid
  });
}

async function handleRpcMessage(core, message) {
  const id = message.id;
  try {
    const data = await core.executeAction(message);
    sendResponse(id, true, data);
  } catch (error) {
    sendResponse(id, false, {}, asError(error));
  }
}

async function startServeMode(rawArgs) {
  const options = parseCliArgs(rawArgs);
  let serverHandle;
  let files;
  let attachedKeepAlive;
  let shuttingDown = false;
  let ownsRuntime = false;
  let cleaned = false;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (attachedKeepAlive) clearInterval(attachedKeepAlive);
    if (ownsRuntime && files) cleanupOwnedRuntime(files, process.pid);
  };

  const shutdownAndExit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    const stop = serverHandle?.stop ? serverHandle.stop() : Promise.resolve();
    void stop.finally(() => {
      cleanup();
      setTimeout(() => process.exit(0), 10);
    });
  };

  process.once('exit', cleanup);
  process.on('SIGTERM', shutdownAndExit);
  process.on('SIGINT', shutdownAndExit);
  process.on('uncaughtException', error => {
    write({ event: 'fatal', data: { message: asError(error) } });
    process.exit(1);
  });
  process.on('unhandledRejection', error => {
    write({ event: 'error', data: { message: asError(error) } });
  });

  try {
    const existing = await daemonStatus({ runtimeRoot: options.runtimeDir });
    if (existing.running) {
      const descriptor = loadRuntimeDescriptor(options.runtimeDir);
      attachedKeepAlive = setInterval(() => undefined, 60_000);
      write({
        event: 'ready',
        data: {
          mode: 'serve-attached',
          url: descriptor.url,
          origin: descriptor.origin,
          wsUrl: descriptor.wsUrl,
          port: descriptor.port,
          pid: process.pid,
          runtimePid: descriptor.pid,
          sessionId: descriptor.sessionId,
          journalRoot: descriptor.journalRoot,
          sharedRuntime: true
        }
      });
      return;
    }

    files = acquireDaemonLock(options.runtimeDir);
    ownsRuntime = true;
    serverHandle = await startSerialDebuggerServer({
      host: options.host || '127.0.0.1',
      port: options.port === undefined ? 0 : Number(options.port),
      token: options.token,
      runtimeRoot: files.rootDir,
      onStopped: cleanup
    });
    const snapshot = serverHandle.core.snapshot();
    writeRuntimeDescriptor(files, {
      protocolVersion: 1,
      mode: 'serve',
      pid: process.pid,
      startedAt: Date.now(),
      host: serverHandle.host,
      port: serverHandle.port,
      origin: serverHandle.origin,
      url: serverHandle.url,
      wsUrl: serverHandle.wsUrl,
      shutdownUrl: serverHandle.shutdownUrl,
      token: serverHandle.token,
      sessionId: serverHandle.core.sessionId,
      journalRoot: snapshot.journal?.rootDir || ''
    });

    write({
      event: 'ready',
      data: {
        mode: 'serve',
        url: serverHandle.url,
        origin: serverHandle.origin,
        wsUrl: serverHandle.wsUrl,
        shutdownUrl: serverHandle.shutdownUrl,
        port: serverHandle.port,
        pid: process.pid,
        sessionId: serverHandle.core.sessionId,
        journalRoot: snapshot.journal?.rootDir || '',
        sharedRuntime: true
      }
    });
  } catch (error) {
    cleanup();
    write({ event: 'fatal', data: { message: asError(error) } });
    process.exit(1);
  }
}

async function startDaemonMode(rawArgs) {
  const options = parseCliArgs(rawArgs);
  const files = acquireDaemonLock(options.runtimeDir);
  let serverHandle;
  let leaseMonitor;
  let cleaned = false;
  let shuttingDown = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    leaseMonitor?.stop();
    cleanupOwnedRuntime(files, process.pid);
  };
  const stopAndExit = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    leaseMonitor?.stop();
    const stop = serverHandle?.stop ? serverHandle.stop() : Promise.resolve();
    void stop.finally(() => setTimeout(() => process.exit(0), 10));
  };

  process.once('exit', cleanup);
  process.once('SIGTERM', stopAndExit);
  process.once('SIGINT', stopAndExit);

  try {
    const leaseFile = typeof options.leaseFile === 'string' ? options.leaseFile : '';
    leaseMonitor = new RuntimeLeaseMonitor({
      persist: isTruthyFlag(options.persist) || !leaseFile,
      onExpired: stopAndExit
    });
    if (leaseFile) {
      leaseMonitor.acquire({
        leaseFile,
        sessionId: options.leaseSessionId,
        ownerPid: options.leaseOwnerPid
      });
    }
    serverHandle = await startSerialDebuggerServer({
      host: options.host || '127.0.0.1',
      port: options.port === undefined ? 0 : Number(options.port),
      runtimeRoot: files.rootDir,
      runtimeLifecycle: {
        acquireLease: params => leaseMonitor.acquire(params),
        leaseStatus: () => leaseMonitor.status()
      },
      onStopped: cleanup
    });
    const snapshot = serverHandle.core.snapshot();
    writeRuntimeDescriptor(files, {
      protocolVersion: 1,
      mode: 'daemon',
      pid: process.pid,
      startedAt: Date.now(),
      host: serverHandle.host,
      port: serverHandle.port,
      origin: serverHandle.origin,
      url: serverHandle.url,
      wsUrl: serverHandle.wsUrl,
      shutdownUrl: serverHandle.shutdownUrl,
      token: serverHandle.token,
      sessionId: serverHandle.core.sessionId,
      journalRoot: snapshot.journal?.rootDir || '',
      lease: leaseMonitor.status()
    });
  } catch (error) {
    cleanup();
    write({ event: 'fatal', data: { message: asError(error), errorCode: error?.code } });
    process.exit(1);
  }
}

const daemonClient = {
  async command(command, options = {}) {
    const runtimeRoot = options.runtimeDir;
    const descriptor = loadRuntimeDescriptor(runtimeRoot);
    if (!descriptor) {
      const error = new Error('Serial Runtime daemon is not running. Run "aily-serial-debugger daemon start".');
      error.code = 'SERIAL_RUNTIME_NOT_RUNNING';
      throw error;
    }
    const leaseOptions = agentLeaseOptions(options);
    let runtimeLease = descriptor.mode === 'daemon'
      ? descriptor.lease || null
      : { mode: 'process-owned', active: 0, sessions: [] };
    if (descriptor.mode === 'daemon' && leaseOptions.leaseFile) {
      runtimeLease = await callSerialRuntime(descriptor, 'runtime.lease.acquire', {
        leaseFile: leaseOptions.leaseFile,
        sessionId: leaseOptions.leaseSessionId,
        ownerPid: leaseOptions.leaseOwnerPid
      }, { timeoutMs: 5000 });
    }
    const result = await callSerialRuntime(descriptor, command.method, command.params, {
      timeoutMs: command.timeoutMs
    });
    return result && typeof result === 'object' && !Array.isArray(result)
      ? { ...result, ...(runtimeLease ? { runtimeLease } : {}) }
      : result;
  },
  status: options => daemonStatus({ runtimeRoot: options.runtimeDir }),
  start: options => startDaemon({
    entryPath: __filename,
    runtimeRoot: options.runtimeDir,
    host: options.host,
    port: options.port,
    ...agentLeaseOptions(options)
  }).then(sanitizeDescriptor),
  stop: options => stopDaemon({ runtimeRoot: options.runtimeDir })
};

function agentLeaseOptions(options = {}) {
  if (isTruthyFlag(options.persist)) return { persist: true };
  const leaseFile = String(
    options.leaseFile
    || process.env.AILY_AGENT_SESSION_LEASE_FILE
    || ''
  ).trim();
  if (!leaseFile) return { persist: true };
  return {
    persist: false,
    leaseFile,
    leaseSessionId: String(
      options.leaseSessionId
      || process.env.AILY_AGENT_SESSION_ID
      || ''
    ).trim(),
    leaseOwnerPid: Number(
      options.leaseOwnerPid
      || process.env.AILY_AGENT_SESSION_OWNER_PID
      || 0
    )
  };
}

function isTruthyFlag(value) {
  return value === true || String(value).toLowerCase() === 'true';
}

if (requestedCommand === 'rpc' || requestedCommand === 'server') {
  startRpcServer();
} else if (requestedCommand === 'serve') {
  void startServeMode(cliArgs.slice(1));
} else if (requestedCommand === 'daemon-run') {
  void startDaemonMode(cliArgs.slice(1));
} else {
  void runCli(requestedCommand, cliArgs.slice(1), {
    createCore: () => createSerialDebuggerCore(),
    stdout: process.stdout,
    daemonClient
  }).then(code => process.exit(code));
}
