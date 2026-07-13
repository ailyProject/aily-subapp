'use strict';

const TOOL_ID = 'video-converter';

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function createVideoConverterCore() {
  const startedAt = Date.now();

  function status() {
    return {
      state: 'ready',
      toolId: TOOL_ID,
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      conversionRuntime: 'browser-webcodecs'
    };
  }

  function formatInfo() {
    return {
      magic: 'AILY',
      version: 1,
      headerSize: 40,
      byteOrder: 'little-endian',
      formats: {
        rgb565: { code: 1, imageExtension: '.rgb565', videoExtension: '.rgb565v', bytesPerPixel: 2 },
        rgb332: { code: 2, imageExtension: '.rgb332', videoExtension: '.rgb332v', bytesPerPixel: 1 },
        mono: { code: 3, imageExtension: '.mono', videoExtension: '.monov', bitOrder: 'XBM LSB-first' }
      },
      supportedSources: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'mp4'],
      note: 'Media conversion runs in the child UI Web Worker because it requires browser WebCodecs.'
    };
  }

  async function executeAction(message = {}) {
    const action = message.action || message.method;

    switch (action) {
      case 'status':
        return status();
      case 'format-info':
      case 'format.info':
        return formatInfo();
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
    formatInfo,
    executeAction,
    shutdown,
    cleanup
  };
}

module.exports = {
  asError,
  createVideoConverterCore
};
