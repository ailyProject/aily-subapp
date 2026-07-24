'use strict';

const fs = require('fs');
const path = require('path');
const { asError } = require('./core');
const {
  DEFAULT_RESULT_MAX_BYTES,
  jsonByteLength
} = require('./runtime/result-budget');

function requestedCommandFromArgs(args) {
  const first = args[0];
  if (!first) return 'rpc';
  if (first === '-h' || first === '--help') return 'help';
  if (first === '-v' || first === '--version') return 'version';
  return first;
}

function parseCliArgs(args) {
  const options = { _: [] };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      options._.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf('=');
    const rawKey = eqIndex >= 0 ? arg.slice(2, eqIndex) : arg.slice(2);
    const key = rawKey.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
    let value = eqIndex >= 0 ? arg.slice(eqIndex + 1) : true;

    if (eqIndex < 0 && args[index + 1] && !args[index + 1].startsWith('--')) {
      value = args[index + 1];
      index += 1;
    }

    if (options[key] === undefined) {
      options[key] = value;
    } else if (Array.isArray(options[key])) {
      options[key].push(value);
    } else {
      options[key] = [options[key], value];
    }
  }

  return options;
}

function helpText() {
  return [
    'Aily Serial Debugger CLI',
    '',
    'Usage:',
    '  node index.js rpc',
    '  node index.js serve [--host 127.0.0.1] [--port 0]',
    '  node index.js daemon start|status|stop [--runtime-dir <path>] [--persist]',
    '  node index.js status',
    '  node index.js ports',
    '  node index.js open --port <path> [--baud 115200]',
    '  node index.js close',
    '  node index.js write [--text "..."] [--hex "01 02"] [--cr] [--lf]',
    '  node index.js transact --text "AT" --expect-regex "OK|ERROR" [--timeout 3000]',
    '  node index.js listen [--duration 2000] [--quiet 200]',
    '  node index.js signal --dtr true',
    '  node index.js logs [--source auto|memory|journal] [--after-seq 0] [--from-timestamp <ms>] [--max-bytes 32768]',
    '  node index.js artifact-read --artifact-id <id> [--offset 0] [--max-bytes 32768]',
    '  node index.js artifact-search --artifact-id <id> --query <text> [--regex]',
    '  node index.js scenario --file <scenario.json> | --json <json>',
    '  node index.js scenario-control status|pause|resume|takeover|release|cancel [--scenario-id <id>] [--reason <text>]',
    '  node index.js analysis [--source auto|memory|journal] [--after-seq 0]',
    '',
    'Start the daemon once, then subsequent commands reuse the same serial session.',
    'Agent-hosted daemons follow AILY_AGENT_SESSION_LEASE_FILE and stop when that session ends; use --persist only for an explicitly user-owned daemon.',
    'The standalone CLI cannot open an embedded/window host UI; use the semantic serial_session_manage tool for presentUi.',
    'All non-help commands write one bounded JSON object to stdout.'
  ].join('\n');
}

function writeCliJson(stdout, ok, command, data = {}, error = '', metadata = {}) {
  let payload = { ok, command, data, error, ...metadata };
  const serializedBytes = jsonByteLength(payload);
  if (serializedBytes > DEFAULT_RESULT_MAX_BYTES) {
    payload = {
      ok: false,
      command,
      data: {},
      error: `CLI result exceeded the ${DEFAULT_RESULT_MAX_BYTES}-byte output budget`,
      errorCode: 'SERIAL_CLI_RESULT_TOO_LARGE',
      details: {
        serializedBytes,
        maxOutputBytes: DEFAULT_RESULT_MAX_BYTES,
        sessionId: data?.sessionId,
        transactionId: data?.transactionId,
        startSeq: data?.startSeq,
        endSeq: data?.endSeq,
        evidence: data?.evidence,
        guidance: 'Use artifact-search or artifact-read with a smaller page.'
      }
    };
  }
  stdout.write(`${JSON.stringify(payload)}\n`);
  return payload.ok === true;
}

function booleanOption(value, fallback = false) {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase());
}

function serialOptions(options) {
  const port = options.port || options.portPath || options.path || options._[0];
  if (!port) throw new Error('Missing --port <path>');
  return {
    port,
    portPath: port,
    baudRate: Number(options.baudRate || options.baud || 115200),
    dataBits: Number(options.dataBits || 8),
    stopBits: Number(options.stopBits || 1),
    parity: options.parity || 'none',
    flowControl: options.flowControl || 'none'
  };
}

async function runCli(command, rawArgs, runtime = {}) {
  const stdout = runtime.stdout || process.stdout;
  const createCore = runtime.createCore;
  const version = runtime.version || require('./package.json').version;
  const options = parseCliArgs(rawArgs);
  let core = null;

  try {
    if (options.presentUi !== undefined) {
      throw createCliError(
        'CLI_UI_PRESENTATION_UNSUPPORTED',
        'The standalone CLI cannot present an embedded/window host UI. Use serial_session_manage with presentUi in a compatible host.'
      );
    }
    let data;
    switch (command) {
      case 'help':
        stdout.write(`${helpText()}\n`);
        return 0;
      case 'version':
        return writeCliJson(stdout, true, command, { version }) ? 0 : 1;
    }

    if (runtime.daemonClient) {
      data = await runDaemonBackedCommand(command, options, runtime.daemonClient);
      const lifecycle = daemonLifecycleMetadata(command, options, data);
      return writeCliJson(stdout, true, command, data, '', lifecycle ? { lifecycle } : {}) ? 0 : 1;
    }

    if (typeof createCore !== 'function') {
      throw new Error('Serial debugger core factory is not available');
    }
    core = createCore();

    switch (command) {
      case 'status':
        data = core.status();
        break;
      case 'ports':
        data = { ports: await core.listSerialPorts() };
        break;
      case 'write':
        await core.connect(serialOptions(options));
        data = await core.write({
          mode: options.hex ? 'hex' : 'text',
          data: options.hex || options.text || options._[1] || '',
          appendCr: booleanOption(options.cr, false),
          appendLf: booleanOption(options.lf, false)
        });
        break;
      case 'transact':
        await core.connect(serialOptions(options));
        data = await core.transact({
          send: {
            mode: options.hex ? 'hex' : 'text',
            data: options.hex || options.text || options._[1] || '',
            appendCr: booleanOption(options.cr, false),
            appendLf: booleanOption(options.lf, false)
          },
          expect: cliExpectation(options),
          timeoutMs: Number(options.timeout || options.timeoutMs || 3000),
          quietMs: Number(options.quiet || options.quietMs || 200),
          maxBytes: Number(options.maxBytes || 65536)
        });
        break;
      case 'listen':
        await core.connect(serialOptions(options));
        data = await core.capture({
          durationMs: Number(options.duration || options.durationMs || 2000),
          quietMs: Number(options.quiet || options.quietMs || 0),
          maxBytes: Number(options.maxBytes || 65536)
        });
        break;
      case 'signal':
        await core.connect(serialOptions(options));
        data = await core.setSignals({
          dtr: options.dtr === undefined ? undefined : booleanOption(options.dtr),
          rts: options.rts === undefined ? undefined : booleanOption(options.rts),
          brk: options.brk === undefined ? undefined : booleanOption(options.brk)
        });
        break;
      default:
        throw new Error(`Unknown CLI command: ${command}. Run node index.js --help`);
    }

    await core.cleanup();
    return writeCliJson(stdout, true, command, data) ? 0 : 1;
  } catch (error) {
    if (core) await core.cleanup().catch(() => undefined);
    writeCliJson(stdout, false, command, {}, asError(error), {
      ...(error?.code ? { errorCode: String(error.code) } : {}),
      ...(error?.details ? { details: error.details } : {})
    });
    return 1;
  }
}

function daemonLifecycleMetadata(command, options, data) {
  const daemonAction = command === 'daemon'
    ? String(options._[0] || 'status').toLowerCase()
    : '';
  if (command === 'daemon' && daemonAction === 'stop') {
    return {
      persistentRuntime: false,
      serialPortReleased: true
    };
  }
  if (command === 'daemon' && daemonAction === 'status' && data?.running !== true) {
    return {
      persistentRuntime: false,
      serialPortReleased: true,
      cleanupRequired: false
    };
  }
  const reportedLeaseMode = String(
    data?.runtimeLease?.mode || data?.lease?.mode || ''
  ).toLowerCase();
  const sessionLeased = reportedLeaseMode
    ? reportedLeaseMode === 'session-leased'
    : !booleanOption(options.persist, false) && Boolean(
        options.leaseFile || process.env.AILY_AGENT_SESSION_LEASE_FILE
      );
  const connected = data?.connected === true
    || data?.state?.connected === true
    || data?.state === 'connected';
  if (
    sessionLeased
    && (command === 'daemon' || connected || ['open', 'close', 'write', 'transact', 'listen', 'signal'].includes(command))
  ) {
    return {
      persistentRuntime: false,
      sessionLeasedRuntime: true,
      serialPortReleased: command === 'close',
      serialPortMayRemainOpen: command === 'close' ? false : connected || command !== 'daemon',
      cleanupRequired: false,
      automaticCleanup: true,
      cleanupTrigger: 'Agent host session end',
      guidance: 'The Agent host lease stops this daemon and releases the serial port when the session ends.'
    };
  }
  if (command === 'close') {
    return {
      persistentRuntime: true,
      serialPortReleased: true,
      cleanupRequired: true,
      stopCommand: 'aily-serial-debugger daemon stop'
    };
  }
  if (command === 'daemon' || connected || ['open', 'write', 'transact', 'listen', 'signal'].includes(command)) {
    return {
      persistentRuntime: true,
      serialPortMayRemainOpen: connected || command !== 'daemon',
      cleanupRequired: true,
      cleanupCommands: [
        'aily-serial-debugger close',
        'aily-serial-debugger daemon stop'
      ],
      guidance: 'Run both cleanup commands when the serial workflow finishes and before firmware upload.'
    };
  }
  return null;
}

async function runDaemonBackedCommand(command, options, daemonClient) {
  if (command === 'daemon') {
    const action = String(options._[0] || 'status').toLowerCase();
    if (action === 'start') return await daemonClient.start(options);
    if (action === 'status') return await daemonClient.status(options);
    if (action === 'stop') return await daemonClient.stop(options);
    throw createCliError('INVALID_DAEMON_ACTION', `Unknown daemon action: ${action}`);
  }

  const call = async (method, params = {}, timeoutMs = 15000) => {
    return await daemonClient.command({ method, params, timeoutMs }, options);
  };
  const openIfRequested = async () => {
    if (options.port || options.portPath || options.path) {
      await call('serial.session.open', serialOptions(options), 60000);
    }
  };

  switch (command) {
    case 'status':
      return await call('runtime.snapshot');
    case 'ports':
      return await call('serial.ports.list');
    case 'open':
      return await call('serial.session.open', serialOptions(options), 60000);
    case 'close':
      return await call('serial.session.close');
    case 'write':
      await openIfRequested();
      return await call('serial.send', sendParams(options));
    case 'transact': {
      const timeoutMs = Number(options.timeout || options.timeoutMs || 3000);
      return await call('serial.transact', {
        ...(options.port || options.portPath || options.path
          ? { connect: serialOptions(options) }
          : {}),
        send: sendParams(options),
        expect: cliExpectation(options),
        timeoutMs,
        quietMs: Number(options.quiet || options.quietMs || 200),
        maxBytes: Number(options.maxBytes || 65536),
        previewBytes: Number(options.previewBytes || 2048)
      }, Math.min(125000, timeoutMs + 5000));
    }
    case 'listen':
      await openIfRequested();
      return await call('serial.capture', {
        durationMs: Number(options.duration || options.durationMs || 2000),
        quietMs: Number(options.quiet || options.quietMs || 0),
        maxBytes: Number(options.maxBytes || 65536),
        previewBytes: Number(options.previewBytes || 2048)
      }, Math.min(125000, Number(options.duration || options.durationMs || 2000) + 5000));
    case 'signal':
      await openIfRequested();
      return await call('serial.signal.set', {
        dtr: options.dtr === undefined ? undefined : booleanOption(options.dtr),
        rts: options.rts === undefined ? undefined : booleanOption(options.rts),
        brk: options.brk === undefined ? undefined : booleanOption(options.brk)
      });
    case 'logs':
      return await call('serial.log.read', {
        source: String(options.source || 'auto'),
        afterSeq: Number(options.afterSeq || 0),
        ...(options.beforeSeq !== undefined ? { beforeSeq: Number(options.beforeSeq) } : {}),
        ...(options.fromTimestamp !== undefined
          ? { fromTimestamp: Number(options.fromTimestamp) }
          : {}),
        ...(options.toTimestamp !== undefined ? { toTimestamp: Number(options.toTimestamp) } : {}),
        limit: Number(options.limit || 100),
        maxBytes: Math.min(32768, Number(options.maxBytes || 32768)),
        previewBytes: Math.min(4096, Number(options.previewBytes || 2048)),
        ...(options.events ? { events: commaList(options.events) } : {})
      });
    case 'artifact-read':
      return await call('serial.artifact.read', {
        artifactId: String(options.artifactId || options._[0] || ''),
        offset: Number(options.offset || 0),
        maxBytes: Math.min(32768, Number(options.maxBytes || 32768))
      });
    case 'artifact-search':
      return await call('serial.artifact.search', {
        artifactId: String(options.artifactId || options._[0] || ''),
        query: String(options.query || options.contains || options._[1] || ''),
        regex: booleanOption(options.regex, false),
        flags: String(options.flags || ''),
        caseSensitive: booleanOption(options.caseSensitive, false),
        limit: Math.min(50, Number(options.limit || 20)),
        maxScanBytes: Math.min(16 * 1024 * 1024, Number(options.maxScanBytes || 1024 * 1024))
      }, 30000);
    case 'scenario': {
      const scenario = readScenarioOptions(options);
      const timeoutMs = Math.min(120000, Math.max(1000, Number(scenario.timeoutMs || 120000)));
      return await call('serial.scenario.run', {
        ...scenario,
        timeoutMs
      }, Math.min(125000, timeoutMs + 5000));
    }
    case 'scenario-control':
      return await call('serial.scenario.control', {
        action: String(options.action || options._[0] || 'status').toLowerCase(),
        ...(options.scenarioId ? { scenarioId: String(options.scenarioId) } : {}),
        ...(options.reason ? { reason: String(options.reason) } : {})
      }, 30000);
    case 'analysis':
      return await call('serial.analysis.run', {
        source: String(options.source || 'auto'),
        afterSeq: Number(options.afterSeq || 0),
        ...(options.beforeSeq !== undefined ? { beforeSeq: Number(options.beforeSeq) } : {}),
        ...(options.fromTimestamp !== undefined
          ? { fromTimestamp: Number(options.fromTimestamp) }
          : {}),
        ...(options.toTimestamp !== undefined ? { toTimestamp: Number(options.toTimestamp) } : {}),
        maxEvents: Math.min(5000, Math.max(1, Number(options.maxEvents || 2000))),
        maxFindings: Math.min(50, Math.max(1, Number(options.maxFindings || 20)))
      }, 60000);
    default:
      throw createCliError(
        'UNKNOWN_CLI_COMMAND',
        `Unknown CLI command: ${command}. Run node index.js --help`
      );
  }
}

function sendParams(options) {
  return {
    mode: options.hex ? 'hex' : 'text',
    data: options.hex || options.text || options._[1] || '',
    appendCr: booleanOption(options.cr, false),
    appendLf: booleanOption(options.lf, false)
  };
}

function commaList(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap(item => String(item).split(',')).map(item => item.trim()).filter(Boolean);
}

function readScenarioOptions(options) {
  let text = '';
  if (options.json !== undefined) {
    text = String(options.json);
  } else if (options.file !== undefined) {
    text = fs.readFileSync(path.resolve(String(options.file)), 'utf8');
  } else {
    throw createCliError(
      'MISSING_SCENARIO',
      'Scenario requires --file <scenario.json> or --json <json>'
    );
  }
  let scenario;
  try {
    scenario = JSON.parse(text);
  } catch (error) {
    throw createCliError('INVALID_SCENARIO_JSON', `Invalid scenario JSON: ${error.message}`);
  }
  if (!scenario || typeof scenario !== 'object' || Array.isArray(scenario)) {
    throw createCliError('INVALID_SCENARIO_JSON', 'Scenario JSON must be an object');
  }
  return scenario;
}

function createCliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function cliExpectation(options) {
  if (options.expectRegex !== undefined) {
    return { type: 'regex', pattern: String(options.expectRegex) };
  }
  if (options.expectHex !== undefined) {
    return { type: 'hex', value: String(options.expectHex) };
  }
  if (options.expectText !== undefined || options.expect !== undefined) {
    return { type: 'text', value: String(options.expectText ?? options.expect) };
  }
  return { type: 'any' };
}

module.exports = {
  requestedCommandFromArgs,
  parseCliArgs,
  runCli,
  helpText
};
