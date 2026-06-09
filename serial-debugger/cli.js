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
    '  node index.js status',
    '  node index.js ports',
    '  node index.js write --port <path> [--baud 115200] [--text "..."] [--hex "01 02"] [--cr] [--lf]',
    '  node index.js signal --port <path> [--baud 115200] --dtr true',
    '',
    'All non-help commands write one JSON object to stdout.'
  ].join('\n');
}

function writeCliJson(stdout, ok, command, data = {}, error = '') {
  stdout.write(`${JSON.stringify({ ok, command, data, error }, null, 2)}\n`);
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
    let data;
    switch (command) {
      case 'help':
        stdout.write(`${helpText()}\n`);
        return 0;
      case 'version':
        writeCliJson(stdout, true, command, { version });
        return 0;
      default:
        if (typeof createCore !== 'function') {
          throw new Error('Serial debugger core factory is not available');
        }
        core = createCore();
    }

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
    writeCliJson(stdout, true, command, data);
    return 0;
  } catch (error) {
    if (core) await core.cleanup().catch(() => undefined);
    writeCliJson(stdout, false, command, {}, asError(error));
    return 1;
  }
}

module.exports = {
  requestedCommandFromArgs,
  parseCliArgs,
  runCli,
  helpText
};
