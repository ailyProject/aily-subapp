'use strict';

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function normalizeMessage(value) {
  const text = String(value || '').trim();
  return text || 'hello';
}

function createToolCore(options = {}) {
  const startedAt = Date.now();
  const sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : () => undefined;

  function status() {
    return {
      state: 'ready',
      pid: process.pid,
      uptimeMs: Date.now() - startedAt
    };
  }

  async function echo(params = {}) {
    const message = normalizeMessage(params.message || params.text || params.value);
    const result = {
      message,
      echoedAt: new Date().toISOString()
    };
    sendEvent('sample.echoed', result);
    return result;
  }

  async function executeAction(message = {}) {
    const action = message.action || message.method;
    const params = message.params || message.data || message;

    switch (action) {
      case 'status':
        return status();
      case 'echo':
      case 'sample.echo':
        return await echo(params);
      case 'shutdown':
        return { closing: true };
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  async function shutdown() {
    return { closing: true };
  }

  async function cleanup() {
    return { ok: true };
  }

  return {
    status,
    echo,
    executeAction,
    shutdown,
    cleanup
  };
}

module.exports = {
  asError,
  createToolCore
};
