'use strict';

const { WebSocket } = require('ws');

function callSerialRuntime(descriptor, method, params = {}, options = {}) {
  if (!descriptor?.wsUrl) {
    throw createRpcClientError('SERIAL_RUNTIME_NOT_RUNNING', 'Serial Runtime endpoint is unavailable');
  }
  const timeoutMs = Math.min(125000, Math.max(1000, Number(options.timeoutMs || 15000)));
  const id = `cli-${process.pid}-${Date.now()}`;
  const signal = options.signal;

  return new Promise((resolve, reject) => {
    const socket = new WebSocket(descriptor.wsUrl);
    let settled = false;
    const timer = setTimeout(() => {
      finish(reject, createRpcClientError(
        'SERIAL_RPC_TIMEOUT',
        `Serial Runtime request timed out after ${timeoutMs} ms`,
        { method, timeoutMs }
      ));
    }, timeoutMs);

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abortRequest);
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      callback(value);
    };

    const abortRequest = () => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          id: `cancel-${id}`,
          method: 'runtime.request.cancel',
          params: { requestId: id },
          context: {
            actor: options.actor || 'cli',
            actorId: options.actorId || `cli-${process.pid}`
          }
        }));
      }
      finish(reject, createRpcClientError(
        'SERIAL_RPC_CANCELLED',
        'Serial Runtime request was cancelled',
        { method }
      ));
    };

    if (signal?.aborted) {
      abortRequest();
      return;
    }
    signal?.addEventListener?.('abort', abortRequest, { once: true });

    socket.on('open', () => {
      socket.send(JSON.stringify({
        id,
        method,
        params,
        context: {
          actor: options.actor || 'cli',
          actorId: options.actorId || `cli-${process.pid}`
        }
      }));
    });
    socket.on('message', data => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (String(message.id || '') !== id) return;
      if (message.ok === true) {
        finish(resolve, message.result);
        return;
      }
      finish(reject, createRpcClientError(
        message.errorCode || 'SERIAL_RPC_FAILED',
        message.error || 'Serial Runtime request failed',
        message.details
      ));
    });
    socket.on('error', error => {
      finish(reject, createRpcClientError(
        'SERIAL_RUNTIME_UNREACHABLE',
        error?.message || 'Unable to connect to Serial Runtime'
      ));
    });
    socket.on('close', () => {
      if (!settled) {
        finish(reject, createRpcClientError(
          'SERIAL_RUNTIME_CLOSED',
          'Serial Runtime connection closed before returning a result'
        ));
      }
    });
  });
}

function createRpcClientError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

module.exports = {
  callSerialRuntime,
  createRpcClientError
};
