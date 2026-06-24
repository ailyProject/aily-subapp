'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 180000;
const KNOWN_PROBE_RS_COMMANDS = new Set([
  'version',
  'list',
  'info',
  'attach',
  'run',
  'reset'
]);

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function trimText(value) {
  return String(value ?? '').trim();
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function normalizeTimeoutMs(value, fallback = DEFAULT_TIMEOUT_MS) {
  return clampInteger(value, fallback, 1000, MAX_TIMEOUT_MS);
}

function normalizeProbeRsPath(value) {
  return trimText(value || process.env.PROBE_RS || 'probe-rs') || 'probe-rs';
}

function normalizeProtocol(value) {
  const protocol = trimText(value || 'swd').toLowerCase();
  return protocol === 'jtag' ? 'jtag' : 'swd';
}

function isTruthy(value) {
  if (value === true) return true;
  const text = trimText(value).toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
}

function oneLine(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function commandLine(executable, args) {
  return [executable, ...args].map(part => {
    const text = String(part);
    return /[\s"]/g.test(text) ? JSON.stringify(text) : text;
  }).join(' ');
}

function requireChip(params) {
  const chip = trimText(params.chip || params.target || params.targetChip);
  if (!chip) throw new Error('Target chip is required');
  return chip;
}

function optionalProbe(params) {
  return trimText(params.probe || params.probeSelector || params.probeId);
}

function optionalSpeed(params) {
  const value = trimText(params.speedKHz || params.speed || params.swclkKHz);
  if (!value) return '';
  if (!/^\d+$/.test(value)) throw new Error('SWD speed must be an integer kHz value');
  return value;
}

function addCommonTargetArgs(args, params = {}, options = {}) {
  const includeChip = options.requireChip || trimText(params.chip || params.target || params.targetChip);
  if (includeChip) {
    args.push('--chip', options.requireChip ? requireChip(params) : trimText(params.chip || params.target || params.targetChip));
  }

  const probe = optionalProbe(params);
  if (probe) args.push('--probe', probe);

  const protocol = normalizeProtocol(params.protocol);
  if (protocol) args.push('--protocol', protocol);

  const speed = optionalSpeed(params);
  if (speed) args.push('--speed', speed);

  if (isTruthy(params.connectUnderReset)) {
    args.push('--connect-under-reset');
  }

  return args;
}

function resolveFirmwarePath(params) {
  const rawPath = trimText(params.firmwarePath || params.firmware || params.elf || params.binary);
  if (!rawPath) throw new Error('Firmware path is required');
  const resolved = path.resolve(process.cwd(), rawPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Firmware file not found: ${resolved}`);
  }
  return resolved;
}

function parseProbeLines(output) {
  const lines = String(output || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  return lines.filter(line => (
    /probe|debug|st-?link|j-?link|dap|cmsis|serial|vid|pid/i.test(line) &&
    !/^warning:/i.test(line)
  )).slice(0, 40);
}

function appendDiagnostic(diagnostics, level, code, message) {
  if (diagnostics.some(item => item.code === code)) return;
  diagnostics.push({ level, code, message });
}

function analyzeProbeResult(result, operation) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}\n${result.error || ''}`;
  const lower = text.toLowerCase();
  const diagnostics = [];
  const suggestions = [];

  if (result.errorCode === 'ENOENT') {
    appendDiagnostic(diagnostics, 'error', 'PROBE_RS_NOT_FOUND', 'probe-rs executable was not found');
    suggestions.push('Install probe-rs and make sure it is available in PATH, or set the probe-rs path in the tool.');
  }

  if (/no (debug )?probe|no probe|probe not found|no probes/i.test(text)) {
    appendDiagnostic(diagnostics, 'error', 'NO_PROBE_FOUND', 'No debug probe was detected');
    suggestions.push('Check USB connection, driver permissions, and whether another program is holding the probe.');
  }

  if (/access denied|permission denied|udev|winusb|libusb/i.test(text)) {
    appendDiagnostic(diagnostics, 'error', 'PROBE_PERMISSION', 'The host cannot access the debug probe');
    suggestions.push('Check probe driver or OS permissions. On Windows, verify the probe driver; on Linux, verify udev rules.');
  }

  if (/connecting to the chip was unsuccessful|failed to attach|attach.*failed|unable to connect/i.test(text)) {
    appendDiagnostic(diagnostics, 'error', 'TARGET_ATTACH_FAILED', 'probe-rs could not attach to the target');
    suggestions.push('Try a lower SWD speed, verify SWDIO/SWCLK/GND/VTref wiring, and try connect-under-reset when NRST is connected.');
  }

  if (/swdapfault|swd ap fault|jtagnodeviceconnected|no device connected|timeout while attaching/i.test(text)) {
    appendDiagnostic(diagnostics, 'error', 'SWD_LINK_FAULT', 'The SWD/JTAG link reported a low-level fault');
    suggestions.push('Check target power, common ground, SWD pin remapping, reset wiring, and whether the firmware puts the MCU into deep sleep.');
  }

  if (/unknown chip|chip.*not found|target.*not found|failed to load.*chip/i.test(text)) {
    appendDiagnostic(diagnostics, 'error', 'UNKNOWN_CHIP', 'The chip name is not recognized by probe-rs');
    suggestions.push('Use the exact probe-rs chip name, for example STM32F103C8, nRF52840_xxAA, or a CMSIS-Pack target name.');
  }

  if (/rtt.*not.*found|failed to find.*rtt|defmt/i.test(text)) {
    appendDiagnostic(diagnostics, 'warning', 'RTT_NOT_READY', 'RTT or defmt output was not available');
    suggestions.push('Confirm the firmware initializes RTT/defmt early enough and does not crash before RTT control blocks are created.');
  }

  if (/connect-under-reset/i.test(text) && !isTruthy(result.params?.connectUnderReset)) {
    appendDiagnostic(diagnostics, 'info', 'TRY_CONNECT_UNDER_RESET', 'The output mentions connect-under-reset');
    suggestions.push('Run the same operation with connect-under-reset enabled if the reset wire is connected.');
  }

  if (result.exitCode === 0 && diagnostics.length === 0) {
    appendDiagnostic(diagnostics, 'success', 'COMMAND_OK', `${operation} completed successfully`);
  } else if (result.exitCode !== 0 && diagnostics.length === 0) {
    appendDiagnostic(diagnostics, 'error', 'COMMAND_FAILED', `${operation} exited with code ${result.exitCode}`);
    suggestions.push('Review stdout/stderr and rerun with a lower SWD speed or probe-rs --help for command-specific options.');
  }

  return {
    diagnostics,
    suggestions: Array.from(new Set(suggestions))
  };
}

function summarizeOutput(result) {
  const combined = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
  return combined
    .split(/\r?\n/)
    .map(oneLine)
    .filter(Boolean)
    .slice(-12);
}

function createSwdDebuggerCore(options = {}) {
  const startedAt = Date.now();
  const sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : () => undefined;
  let activeChild = null;
  let activeOperation = '';

  function status() {
    return {
      state: activeChild ? 'busy' : 'ready',
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      activeOperation,
      defaultProbeRsPath: normalizeProbeRsPath()
    };
  }

  function ensureIdle(operation) {
    if (activeChild) {
      throw new Error(`SWD debugger is busy running ${activeOperation || 'a command'}`);
    }
    activeOperation = operation;
  }

  function runProbeRs(operation, params, args, timeoutMs) {
    ensureIdle(operation);

    const executable = normalizeProbeRsPath(params.probeRsPath || params.probeRs);
    const startedAtMs = Date.now();
    const timeout = normalizeTimeoutMs(timeoutMs ?? params.timeoutMs, DEFAULT_TIMEOUT_MS);
    const result = {
      operation,
      command: commandLine(executable, args),
      args,
      cwd: process.cwd(),
      stdout: '',
      stderr: '',
      exitCode: null,
      signal: '',
      timedOut: false,
      durationMs: 0,
      params: {
        chip: trimText(params.chip || params.target || params.targetChip),
        probe: optionalProbe(params),
        protocol: normalizeProtocol(params.protocol),
        connectUnderReset: isTruthy(params.connectUnderReset)
      }
    };

    sendEvent('probe.command.started', {
      operation,
      command: result.command,
      timeoutMs: timeout
    });

    return new Promise(resolve => {
      let settled = false;
      let forceKillTimer = null;
      const finish = next => {
        if (settled) return;
        settled = true;
        if (forceKillTimer) clearTimeout(forceKillTimer);
        activeChild = null;
        activeOperation = '';
        result.durationMs = Date.now() - startedAtMs;
        Object.assign(result, next);
        const analysis = analyzeProbeResult(result, operation);
        Object.assign(result, analysis, {
          outputSummary: summarizeOutput(result),
          probes: operation === 'list' ? parseProbeLines(`${result.stdout}\n${result.stderr}`) : []
        });
        sendEvent('probe.command.finished', {
          operation,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          durationMs: result.durationMs,
          diagnostics: result.diagnostics
        });
        resolve(result);
      };

      let child;
      try {
        child = spawn(executable, args, {
          cwd: process.cwd(),
          env: process.env,
          shell: false,
          windowsHide: true
        });
      } catch (error) {
        finish({
          error: asError(error),
          errorCode: error?.code || 'SPAWN_FAILED'
        });
        return;
      }

      activeChild = child;
      const killTimer = setTimeout(() => {
        result.timedOut = true;
        child.kill('SIGTERM');
        forceKillTimer = setTimeout(() => {
          if (activeChild === child) child.kill('SIGKILL');
        }, 1000);
      }, timeout);

      child.stdout.on('data', chunk => {
        const text = chunk.toString('utf8');
        result.stdout += text;
        sendEvent('probe.output', { operation, stream: 'stdout', text });
      });

      child.stderr.on('data', chunk => {
        const text = chunk.toString('utf8');
        result.stderr += text;
        sendEvent('probe.output', { operation, stream: 'stderr', text });
      });

      child.on('error', error => {
        clearTimeout(killTimer);
        finish({
          error: asError(error),
          errorCode: error?.code || 'SPAWN_FAILED'
        });
      });

      child.on('close', (code, signal) => {
        clearTimeout(killTimer);
        finish({
          exitCode: typeof code === 'number' ? code : null,
          signal: signal || '',
          timedOut: result.timedOut
        });
      });
    });
  }

  async function version(params = {}) {
    return runProbeRs('version', params, ['--version'], normalizeTimeoutMs(params.timeoutMs, 5000));
  }

  async function list(params = {}) {
    return runProbeRs('list', params, ['list'], normalizeTimeoutMs(params.timeoutMs, 10000));
  }

  async function info(params = {}) {
    const args = addCommonTargetArgs(['info'], params);
    return runProbeRs('info', params, args, normalizeTimeoutMs(params.timeoutMs, 15000));
  }

  async function attach(params = {}) {
    const args = addCommonTargetArgs(['attach'], params, { requireChip: true });
    return runProbeRs('attach', params, args, normalizeTimeoutMs(params.timeoutMs, 10000));
  }

  async function runFirmware(params = {}) {
    const firmwarePath = resolveFirmwarePath(params);
    const args = addCommonTargetArgs(['run'], params, { requireChip: true });
    args.push(firmwarePath);
    return runProbeRs('run', { ...params, firmwarePath }, args, normalizeTimeoutMs(params.timeoutMs, 30000));
  }

  async function reset(params = {}) {
    const args = addCommonTargetArgs(['reset'], params, { requireChip: true });
    return runProbeRs('reset', params, args, normalizeTimeoutMs(params.timeoutMs, 10000));
  }

  async function customCommand(params = {}) {
    const command = trimText(params.command || params.operation);
    if (!KNOWN_PROBE_RS_COMMANDS.has(command)) {
      throw new Error(`Unsupported probe-rs command: ${command}`);
    }

    switch (command) {
      case 'version':
        return version(params);
      case 'list':
        return list(params);
      case 'info':
        return info(params);
      case 'attach':
        return attach(params);
      case 'run':
        return runFirmware(params);
      case 'reset':
        return reset(params);
      default:
        throw new Error(`Unsupported probe-rs command: ${command}`);
    }
  }

  async function auto(params = {}) {
    const steps = [];
    const started = Date.now();

    async function runStep(name, fn, stepParams = params) {
      const result = await fn(stepParams);
      steps.push(result);
      return result;
    }

    const versionResult = await runStep('version', version, { ...params, timeoutMs: 5000 });
    if (versionResult.errorCode === 'ENOENT') {
      return createAutomationReport(steps, started);
    }

    await runStep('list', list, { ...params, timeoutMs: 10000 });
    await runStep('info', info, { ...params, timeoutMs: normalizeTimeoutMs(params.timeoutMs, 15000) });

    if (isTruthy(params.includeAttach)) {
      await runStep('attach', attach, { ...params, timeoutMs: normalizeTimeoutMs(params.attachTimeoutMs || params.timeoutMs, 10000) });
    }

    if (isTruthy(params.includeFlash) || isTruthy(params.includeRun)) {
      await runStep('run', runFirmware, { ...params, timeoutMs: normalizeTimeoutMs(params.runTimeoutMs || params.timeoutMs, 30000) });
    }

    return createAutomationReport(steps, started);
  }

  function createAutomationReport(steps, started) {
    const diagnostics = [];
    const suggestions = [];
    for (const step of steps) {
      for (const item of step.diagnostics || []) appendDiagnostic(diagnostics, item.level, item.code, item.message);
      for (const suggestion of step.suggestions || []) suggestions.push(suggestion);
    }

    const failed = steps.filter(step => step.exitCode !== 0 || step.errorCode || step.timedOut);
    const summary = failed.length
      ? `Automation stopped with ${failed.length} failing step(s)`
      : 'Automation completed without command failures';

    return {
      operation: 'auto',
      summary,
      ok: failed.length === 0,
      durationMs: Date.now() - started,
      diagnostics,
      suggestions: Array.from(new Set(suggestions)),
      steps: steps.map(step => ({
        operation: step.operation,
        command: step.command,
        exitCode: step.exitCode,
        timedOut: step.timedOut,
        durationMs: step.durationMs,
        diagnostics: step.diagnostics,
        outputSummary: step.outputSummary,
        probes: step.probes
      }))
    };
  }

  async function executeAction(message = {}) {
    const action = message.action || message.method;
    const params = message.params || message.data || message;

    switch (action) {
      case 'status':
        return status();
      case 'probe.version':
      case 'version':
        return version(params);
      case 'probe.list':
      case 'list':
        return list(params);
      case 'probe.info':
      case 'info':
        return info(params);
      case 'probe.attach':
      case 'attach':
        return attach(params);
      case 'probe.run':
      case 'run':
      case 'flash-run':
        return runFirmware(params);
      case 'probe.reset':
      case 'reset':
        return reset(params);
      case 'probe.command':
      case 'command':
        return customCommand(params);
      case 'probe.auto':
      case 'auto':
      case 'diagnose':
        return auto(params);
      case 'shutdown':
        return { closing: true };
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async function cleanup() {
    if (activeChild) {
      activeChild.kill('SIGTERM');
      activeChild = null;
    }
    activeOperation = '';
    return { ok: true };
  }

  async function shutdown() {
    await cleanup();
    return { closing: true };
  }

  return {
    status,
    version,
    list,
    info,
    attach,
    runFirmware,
    reset,
    auto,
    executeAction,
    shutdown,
    cleanup
  };
}

module.exports = {
  asError,
  createSwdDebuggerCore,
  analyzeProbeResult,
  normalizeProtocol,
  normalizeTimeoutMs
};
