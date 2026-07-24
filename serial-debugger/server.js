'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');
const { WebSocketServer, WebSocket } = require('ws');
const { asError, createSerialDebuggerCore } = require('./core');
const { SerialJournal } = require('./runtime/journal');

const TOOL_ID = 'serial-debugger';
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function createToken() {
  return crypto.randomBytes(24).toString('hex');
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'http://127.0.0.1',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

function safeStaticPath(uiRoot, requestPath) {
  const pathname = requestPath === '/' ? '/index.html' : requestPath;
  const decoded = decodeURIComponent(pathname);
  const resolvedRoot = path.resolve(uiRoot);
  const resolvedFile = path.resolve(path.join(resolvedRoot, decoded));
  const relative = path.relative(resolvedRoot, resolvedFile);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return resolvedFile;
}

function i18nPathFromRequest(requestPath) {
  const match = requestPath.match(new RegExp(`^/(?:tools/${TOOL_ID}/)?i18n/([a-zA-Z0-9_-]+\\.json)$`));
  if (!match) return '';
  return path.join(__dirname, 'i18n', match[1]);
}

function penpalVendorPath() {
  const bundledPath = path.join(__dirname, 'vendor', 'penpal.min.js');
  if (fs.existsSync(bundledPath)) return bundledPath;
  return path.join(__dirname, 'node_modules', 'penpal', 'dist', 'penpal.min.js');
}

function defaultUiRoot() {
  const candidates = [
    path.join(__dirname, 'dist', TOOL_ID, 'ui'),
    path.join(__dirname, 'ui')
  ];

  return candidates.find(candidate => fs.existsSync(path.join(candidate, 'index.html'))) || candidates[0];
}

function serveStatic(uiRoot, request, response) {
  const requestUrl = new URL(request.url, 'http://127.0.0.1');
  if (requestUrl.pathname === '/vendor/penpal.min.js') {
    serveFile(penpalVendorPath(), response);
    return;
  }

  const fontPath = fontPathFromRequest(requestUrl.pathname);
  if (fontPath) {
    serveFile(fontPath, response);
    return;
  }

  const i18nPath = i18nPathFromRequest(requestUrl.pathname);
  if (i18nPath) {
    serveFile(i18nPath, response);
    return;
  }

  const filePath = safeStaticPath(uiRoot, requestUrl.pathname);
  if (!filePath) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  serveFile(filePath, response);
}

function fontPathFromRequest(requestPath) {
  if (!requestPath.startsWith('/fonts/')) return '';

  const decoded = decodeURIComponent(requestPath.replace(/^\/fonts\//, ''));
  if (decoded.includes('\0')) return '';

  const candidates = [
    path.join(__dirname, 'ui', 'fonts'),
    path.resolve(__dirname, '..', '..', '..', 'public', 'fonts'),
    process.resourcesPath ? path.join(process.resourcesPath, 'renderer', 'fonts') : ''
  ].filter(Boolean);

  for (const root of candidates) {
    const resolvedRoot = path.resolve(root);
    const resolvedFile = path.resolve(path.join(resolvedRoot, decoded));
    const relative = path.relative(resolvedRoot, resolvedFile);
    if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
    if (fs.existsSync(resolvedFile)) return resolvedFile;
  }

  return path.join(candidates[0] || __dirname, decoded);
}

function serveFile(filePath, response) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500);
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Internal server error');
      return;
    }

    response.writeHead(200, {
      'Content-Type': MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream'
    });
    response.end(maybeInjectDevReload(filePath, content));
  });
}

function maybeInjectDevReload(filePath, content) {
  const reloadUrl = process.env.AILY_TOOL_DEV_RELOAD_URL;
  if (!reloadUrl || path.extname(filePath).toLowerCase() !== '.html') return content;

  const html = content.toString('utf8');
  const snippet = [
    '<script id="aily-tool-dev-reload">',
    '(() => {',
    `  const source = new EventSource(${JSON.stringify(reloadUrl)});`,
    "  source.addEventListener('reload', () => window.location.reload());",
    "  source.onerror = () => undefined;",
    '})();',
    '</script>'
  ].join('\n');

  const bodyClosePattern = /<\/body>/i;
  const nextHtml = bodyClosePattern.test(html)
    ? html.replace(bodyClosePattern, `${snippet}\n$&`)
    : `${html}\n${snippet}`;

  return Buffer.from(nextHtml, 'utf8');
}

function verifyToken(requestUrl, token) {
  return requestUrl.searchParams.get('token') === token;
}

function createRpcMessage(id, ok, result = {}, error = '') {
  return { id, ok, result, error };
}

function createRpcErrorMessage(id, error) {
  return {
    ...createRpcMessage(id, false, {}, asError(error)),
    ...(error?.code ? { errorCode: String(error.code) } : {}),
    ...(error?.details !== undefined ? { details: error.details } : {})
  };
}

async function startSerialDebuggerServer(options = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number.isFinite(Number(options.port)) ? Number(options.port) : 0;
  const token = options.token || createToken();
  const uiRoot = path.resolve(options.uiRoot || defaultUiRoot());
  const clients = new Set();
  let closing = false;
  let server;
  const journal = options.journal === false
    ? null
    : options.journal || new SerialJournal({
        rootDir: options.runtimeRoot,
        sessionId: options.sessionId,
        ...(options.journalOptions || {})
      });

  const broadcast = message => {
    const text = JSON.stringify(message);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(text);
    }
  };

  const core = createSerialDebuggerCore({
    ...(options.SerialPortClass ? { SerialPortClass: options.SerialPortClass } : {}),
    ...(options.eventStoreOptions ? { eventStoreOptions: options.eventStoreOptions } : {}),
    ...(options.runtimeLifecycle ? { runtimeLifecycle: options.runtimeLifecycle } : {}),
    ...(journal ? { journal, sessionId: journal.sessionId } : {}),
    sendEvent: (event, data = {}, envelope) => broadcast(envelope || { event, data })
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

  async function stop() {
    if (closing) return;
    closing = true;
    await core.cleanup().catch(() => undefined);
    for (const client of clients) client.close(1001, 'Serial debugger server closed');
    await new Promise(resolve => {
      let pending = 0;
      const done = () => {
        pending -= 1;
        if (pending <= 0) resolve();
      };
      pending += 1;
      wss.close(done);
      if (server) {
        pending += 1;
        server.close(done);
      }
      done();
    });
    await options.onStopped?.();
  }

  async function handleRpc(socket, message) {
    const id = message.id;
    const method = message.method || message.action;
    const activeRequests = socket.activeRequests;
    if (message.context?.actor || message.context?.actorId) {
      socket.clientContext = {
        actor: String(message.context.actor || 'unknown'),
        actorId: String(message.context.actorId || '')
      };
    }

    if (method === 'runtime.request.cancel') {
      const requestId = String(message.params?.requestId || '');
      const activeRequest = activeRequests.get(requestId);
      if (activeRequest) activeRequest.abort();
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(createRpcMessage(id, true, {
          requestId,
          cancelled: Boolean(activeRequest)
        })));
      }
      return;
    }

    const requestId = String(id ?? '');
    const abortController = new AbortController();
    if (requestId) activeRequests.set(requestId, abortController);

    try {
      const result = await core.executeAction({
        action: method,
        params: message.params || message.data || {},
        context: {
          ...(message.context || {}),
          ...(requestId ? { requestId } : {})
        },
        signal: abortController.signal
      });
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(createRpcMessage(id, true, result)));
      }
      if (method === 'shutdown') await stop();
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(createRpcErrorMessage(id, error)));
      }
    } finally {
      if (requestId && activeRequests.get(requestId) === abortController) {
        activeRequests.delete(requestId);
      }
    }
  }

  wss.on('connection', socket => {
    clients.add(socket);
    socket.activeRequests = new Map();
    socket.clientContext = null;
    socket.send(JSON.stringify({
      event: 'ready',
      data: {
        state: core.status(),
        pid: process.pid
      }
    }));

    socket.on('message', data => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch (error) {
        socket.send(JSON.stringify({ ok: false, error: asError(error) }));
        return;
      }
      void handleRpc(socket, message);
    });

    socket.on('close', () => {
      for (const activeRequest of socket.activeRequests.values()) activeRequest.abort();
      socket.activeRequests.clear();
      if (socket.clientContext?.actor === 'ui') {
        core.handleClientDisconnect?.(socket.clientContext);
      }
      clients.delete(socket);
    });
  });

  server = http.createServer((request, response) => {
    const requestUrl = new URL(request.url, `http://${host}`);

    if (request.method === 'OPTIONS') {
      sendJson(response, 204, {});
      return;
    }

    if (requestUrl.pathname === '/health') {
      sendJson(response, 200, { ok: true, state: core.status() });
      return;
    }

    if (requestUrl.pathname === '/api/shutdown') {
      if (!verifyToken(requestUrl, token)) {
        sendJson(response, 403, { ok: false, error: 'Invalid token' });
        return;
      }
      sendJson(response, 200, { ok: true });
      void stop();
      return;
    }

    serveStatic(uiRoot, request, response);
  });

  server.on('upgrade', (request, socket, head) => {
    const requestUrl = new URL(request.url, `http://${host}`);
    if (requestUrl.pathname !== '/ws' || !verifyToken(requestUrl, token)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, ws => {
      wss.emit('connection', ws, request);
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  const origin = `http://${host}:${actualPort}`;
  const url = `${origin}/?token=${encodeURIComponent(token)}`;

  return {
    core,
    host,
    port: actualPort,
    token,
    origin,
    url,
    wsUrl: `ws://${host}:${actualPort}/ws?token=${encodeURIComponent(token)}`,
    shutdownUrl: `${origin}/api/shutdown?token=${encodeURIComponent(token)}`,
    stop
  };
}

module.exports = {
  startSerialDebuggerServer
};
