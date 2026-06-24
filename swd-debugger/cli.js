'use strict';

const { asError } = require('./core');

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
    const key = rawKey.replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
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
    'SWD Debugger CLI',
    '',
    'Usage:',
    '  node index.js rpc',
    '  node index.js serve [--host 127.0.0.1] [--port 0]',
    '  node index.js status',
    '  node index.js version [--probe-rs probe-rs]',
    '  node index.js list [--probe-rs probe-rs]',
    '  node index.js info --chip STM32F103C8 [--probe <selector>] [--speed-khz 4000] [--connect-under-reset]',
    '  node index.js attach --chip STM32F103C8 [--timeout-ms 10000]',
    '  node index.js run --chip STM32F103C8 --firmware path/to/firmware.elf [--timeout-ms 30000]',
    '  node index.js auto --chip STM32F103C8 [--include-attach] [--firmware path/to/firmware.elf --include-flash]',
    '',
    'All non-help CLI commands write one JSON object to stdout.'
  ].join('\n');
}

function writeCliJson(stdout, ok, command, data = {}, error = '') {
  stdout.write(`${JSON.stringify({ ok, command, data, error }, null, 2)}\n`);
}

function toParams(options) {
  return {
    probeRsPath: options.probeRs || options.probeRsPath,
    chip: options.chip || options.target || options._[0],
    probe: options.probe || options.probeSelector,
    protocol: options.protocol || 'swd',
    speedKHz: options.speedKHz || options.speed || options.swclkKHz,
    connectUnderReset: options.connectUnderReset,
    timeoutMs: options.timeoutMs,
    firmwarePath: options.firmware || options.firmwarePath || options.elf || options.binary,
    includeAttach: options.includeAttach,
    includeFlash: options.includeFlash || options.includeRun,
    attachTimeoutMs: options.attachTimeoutMs,
    runTimeoutMs: options.runTimeoutMs
  };
}

async function runCli(command, rawArgs, runtime = {}) {
  const stdout = runtime.stdout || process.stdout;
  const createCore = runtime.createCore;
  const version = runtime.version || require('./package.json').version;
  const options = parseCliArgs(rawArgs);
  let core = null;

  try {
    let data;
    switch (command) {
      case 'help':
        stdout.write(`${helpText()}\n`);
        return 0;
      case 'version':
        if (!rawArgs.length) {
          writeCliJson(stdout, true, command, { version });
          return 0;
        }
        break;
      default:
        break;
    }

    if (typeof createCore !== 'function') {
      throw new Error('SWD Debugger core factory is not available');
    }
    core = createCore();
    const params = toParams(options);

    switch (command) {
      case 'status':
        data = core.status();
        break;
      case 'version':
      case 'probe-version':
        data = await core.version(params);
        break;
      case 'list':
      case 'probes':
        data = await core.list(params);
        break;
      case 'info':
        data = await core.info(params);
        break;
      case 'attach':
        data = await core.attach(params);
        break;
      case 'run':
      case 'flash-run':
        data = await core.runFirmware(params);
        break;
      case 'reset':
        data = await core.reset(params);
        break;
      case 'auto':
      case 'diagnose':
        data = await core.auto(params);
        break;
      default:
        throw new Error(`Unknown CLI command: ${command}. Run node index.js --help`);
    }

    writeCliJson(stdout, true, command, data);
    await core.cleanup();
    if (data?.errorCode || data?.timedOut || data?.ok === false) return 1;
    if (Number.isInteger(data?.exitCode) && data.exitCode !== 0) return 1;
    return 0;
  } catch (error) {
    if (core) await core.cleanup();
    writeCliJson(stdout, false, command, {}, asError(error));
    return 1;
  }
}

module.exports = {
  requestedCommandFromArgs,
  runCli,
  helpText,
  parseCliArgs
};
