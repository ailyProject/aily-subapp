'use strict';

const app = document.getElementById('app');
const query = new URLSearchParams(window.location.search);
const token = query.get('token') || '';
const host = {
  remote: null,
  context: {
    lang: normalizeLang(query.get('lang') || navigator.language || 'en'),
    theme: normalizeTheme(query.get('theme')),
    platform: 'browser'
  }
};
const i18n = {
  lang: 'en',
  bundle: {}
};
const state = {
  backendStatus: 'connecting',
  backendPid: 0,
  message: 'hello',
  result: '',
  logs: []
};
const DRAFT_KEY = '{{tool-id}}.ui.draft.v1';
const DRAFT_FIELDS = ['message', 'result'];

let backendWs = null;
let requestSeq = 0;
let logSeq = 0;
const pendingRequests = new Map();

document.documentElement.lang = host.context.lang;
applyTheme(host.context.theme);
loadDraft();

function normalizeLang(lang) {
  const normalized = String(lang || 'en').toLowerCase().replace(/-/g, '_');
  if (normalized.startsWith('zh_cn') || normalized === 'zh') return 'zh_cn';
  if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
  return normalized || 'en';
}

async function loadI18n(lang) {
  const normalized = normalizeLang(lang);
  const candidates = normalized === 'en' ? ['en'] : [normalized, 'en'];

  for (const candidate of candidates) {
    try {
      const response = await fetch(`/i18n/${candidate}.json`, { cache: 'no-store' });
      if (!response.ok) continue;
      const data = await response.json();
      i18n.lang = candidate;
      i18n.bundle = data['{{TOOL_NAMESPACE}}'] || {};
      document.title = t('TITLE', '{{Tool Name}}');
      render();
      return;
    } catch {
      // Try the fallback language.
    }
  }
}

function t(key, fallback = key) {
  return i18n.bundle[key] || fallback;
}

function normalizeTheme(theme) {
  return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  const normalized = normalizeTheme(theme);
  document.documentElement.dataset.theme = normalized;
  document.documentElement.style.colorScheme = normalized;

  let themeLink = document.getElementById('theme-style');
  if (!themeLink) {
    themeLink = document.createElement('link');
    themeLink.id = 'theme-style';
    themeLink.rel = 'stylesheet';
    document.head.appendChild(themeLink);
  }

  const href = `./${normalized}.css`;
  if (themeLink.getAttribute('href') !== href) {
    themeLink.setAttribute('href', href);
  }

  return normalized;
}

async function applyHostContext(context = {}) {
  const lang = normalizeLang(context.lang || host.context.lang);
  const theme = normalizeTheme(context.theme || host.context.theme);
  host.context = {
    ...host.context,
    ...context,
    lang,
    theme
  };
  document.documentElement.lang = lang;
  applyTheme(theme);
  await loadI18n(lang);
}

function connectHost() {
  if (!window.Penpal || !window.parent || window.parent === window) {
    return;
  }

  const messenger = new window.Penpal.WindowMessenger({
    remoteWindow: window.parent,
    allowedOrigins: ['*']
  });

  const connection = window.Penpal.connect({
    messenger,
    methods: {
      setHostContext(context = {}) {
        void applyHostContext(context);
        return { ok: true };
      },
      focusTool() {
        window.focus();
        return { ok: true };
      },
      beforeClose() {
        saveDraft();
        return {
          canClose: true,
          connected: backendWs?.readyState === WebSocket.OPEN
        };
      }
    }
  });

  connection.promise
    .then(async remote => {
      host.remote = remote;
      if (typeof remote.getHostContext === 'function') {
        const context = await remote.getHostContext();
        if (context) {
          await applyHostContext(context);
        }
      }
      if (state.backendStatus === 'ready') {
        notifyHostReady();
      }
    })
    .catch(error => {
      pushLog('error', 'HOST_CONNECTION_FAILED', error.message || String(error));
    });
}

function notifyHostReady() {
  if (!host.remote || typeof host.remote.childReady !== 'function') return;
  void host.remote.childReady({
    wsConnected: !!backendWs && backendWs.readyState === WebSocket.OPEN,
    backendStatus: state.backendStatus,
    pid: state.backendPid
  });
}

function notifyHostError(error) {
  if (!host.remote || typeof host.remote.childError !== 'function') return;
  void host.remote.childError({
    message: error?.message || String(error || '{{Tool Name}} error')
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}

function text(key, fallback = key) {
  return escapeHtml(t(key, fallback));
}

function now() {
  return new Date().toLocaleTimeString();
}

function pushLog(type, label, detail = '') {
  state.logs.unshift({
    id: ++logSeq,
    type,
    label,
    detail,
    time: now()
  });
  state.logs = state.logs.slice(0, 80);
  render();
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (!draft || typeof draft !== 'object') return;
    for (const field of DRAFT_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(draft, field)) {
        state[field] = draft[field];
      }
    }
  } catch {
    // Ignore invalid persisted draft data.
  }
}

function saveDraft() {
  try {
    const draft = {};
    for (const field of DRAFT_FIELDS) {
      draft[field] = state[field];
    }
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage may be unavailable in some browser modes.
  }
}

function request(method, params = {}, timeoutMs = 15000) {
  if (!backendWs || backendWs.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error('WebSocket is not connected'));
  }

  const id = ++requestSeq;
  const payload = JSON.stringify({ id, method, params });
  const response = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Request timed out: ${method}`));
    }, timeoutMs);
    pendingRequests.set(id, { resolve, reject, timeout });
  });

  backendWs.send(payload);
  return response;
}

function handleBackendMessage(raw) {
  const message = JSON.parse(raw);
  if (typeof message.id === 'number') {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || '{{Tool Name}} request failed'));
    }
    return;
  }

  if (message.event === 'ready') {
    state.backendStatus = 'ready';
    state.backendPid = Number(message.data?.pid) || 0;
    notifyHostReady();
    render();
    return;
  }

  pushLog('event', message.event || 'EVENT', JSON.stringify(message.data || {}));
}

function connectBackend() {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('Backend reconnecting'));
  }
  pendingRequests.clear();

  if (backendWs) {
    backendWs.close();
    backendWs = null;
  }

  state.backendStatus = 'connecting';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  backendWs = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

  backendWs.addEventListener('open', async () => {
    try {
      const status = await request('status');
      state.backendStatus = 'ready';
      state.backendPid = Number(status.pid) || state.backendPid;
      pushLog('system', 'BACKEND_READY', `pid=${state.backendPid}`);
      notifyHostReady();
    } catch (error) {
      state.backendStatus = 'error';
      notifyHostError(error);
    } finally {
      render();
    }
  });

  backendWs.addEventListener('message', event => {
    try {
      handleBackendMessage(event.data);
    } catch (error) {
      notifyHostError(error);
    }
  });

  backendWs.addEventListener('close', () => {
    if (state.backendStatus !== 'error') {
      state.backendStatus = 'closed';
    }
    render();
  });

  backendWs.addEventListener('error', () => {
    state.backendStatus = 'error';
    notifyHostError(new Error('Backend WebSocket connection failed'));
    render();
  });
}

async function runEcho() {
  const message = state.message.trim() || 'hello';
  pushLog('request', 'ECHO_REQUEST', message);

  try {
    const result = await request('sample.echo', { message });
    state.result = JSON.stringify(result, null, 2);
    saveDraft();
    pushLog('response', 'ECHO_RESPONSE', result.message || '');
  } catch (error) {
    pushLog('error', 'ECHO_FAILED', error.message || String(error));
  }
}

function renderLogList() {
  return state.logs.map(log => `
    <div class="log-row ${escapeAttr(log.type)}">
      <span class="time">${escapeHtml(log.time)}</span>
      <span class="label">${escapeHtml(t(log.label, log.label))}</span>
      <span class="detail mono">${escapeHtml(log.detail)}</span>
    </div>
  `).join('');
}

function render() {
  app.innerHTML = `
    <section class="toolbar">
      <div>
        <h1>${text('TITLE', '{{Tool Name}}')}</h1>
        <p>${text('DESCRIPTION', '{{tool-description}}')}</p>
      </div>
      <span class="status ${state.backendStatus === 'ready' ? 'ready' : ''}">
        ${escapeHtml(t(`STATUS_${state.backendStatus.toUpperCase()}`, state.backendStatus))}
      </span>
    </section>
    <section class="workspace">
      <div class="panel">
        <div class="panel-title">${text('COMMAND', 'Command')}</div>
        <label class="field">
          <span>${text('MESSAGE', 'Message')}</span>
          <input type="text" data-field="message" value="${escapeAttr(state.message)}">
        </label>
        <div class="actions">
          <button type="button" class="primary" data-action="echo">${text('RUN', 'Run')}</button>
          <button type="button" data-action="clear">${text('CLEAR', 'Clear')}</button>
        </div>
      </div>
      <div class="panel">
        <div class="panel-title">${text('RESULT', 'Result')}</div>
        <pre class="mono">${escapeHtml(state.result)}</pre>
      </div>
      <div class="panel log-panel">
        <div class="panel-title">${text('LOG', 'Log')}</div>
        <div class="log-list">${renderLogList()}</div>
      </div>
    </section>
  `;
}

function updateFromInputs() {
  for (const element of app.querySelectorAll('[data-field]')) {
    const field = element.dataset.field;
    if (!field) continue;
    state[field] = element.value;
  }
}

app.addEventListener('input', event => {
  if (event.target.matches('[data-field]')) {
    updateFromInputs();
    saveDraft();
  }
});

app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  updateFromInputs();
  const action = target.dataset.action;

  if (action === 'echo') void runEcho();
  if (action === 'clear') {
    state.result = '';
    state.logs = [];
    saveDraft();
    render();
  }
});

window.addEventListener('beforeunload', () => {
  saveDraft();
  if (backendWs) backendWs.close();
});

render();
void loadI18n(host.context.lang);
connectHost();
connectBackend();
