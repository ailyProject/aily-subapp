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
    options[key] = value;
  }

  return options;
}

function helpText() {
  return [
    'Aily Video Converter CLI',
    '',
    'Usage:',
    '  node index.js rpc',
    '  node index.js serve [--host 127.0.0.1] [--port 0]',
    '  node index.js status',
    '  node index.js format-info',
    '',
    'Media conversion is performed by the browser UI Web Worker through WebCodecs.',
    'All non-help CLI commands write one JSON object to stdout.'
  ].join('\n');
}

function writeCliJson(stdout, ok, command, data = {}, error = '') {
  stdout.write(`${JSON.stringify({ ok, command, data, error }, null, 2)}\n`);
}

async function runCli(command, _rawArgs, runtime = {}) {
  const stdout = runtime.stdout || process.stdout;
  const createCore = runtime.createCore;
  const version = runtime.version || require('./package.json').version;
  let core = null;

  try {
    if (command === 'help') {
      stdout.write(`${helpText()}\n`);
      return 0;
    }
    if (command === 'version') {
      writeCliJson(stdout, true, command, { version });
      return 0;
    }
    if (typeof createCore !== 'function') {
      throw new Error('Video converter core factory is not available');
    }
    core = createCore();

    let data;
    if (command === 'status') {
      data = core.status();
    } else if (command === 'format-info') {
      data = core.formatInfo();
    } else {
      throw new Error(`Unknown CLI command: ${command}. Run node index.js --help`);
    }

    writeCliJson(stdout, true, command, data);
    await core.cleanup();
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
