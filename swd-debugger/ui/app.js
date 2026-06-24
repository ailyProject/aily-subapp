'use strict';

const app = document.getElementById('app');
const query = new URLSearchParams(window.location.search);
const token = query.get('token') || '';
const host = {
  remote: null,
  context: {
    lang: normalizeLang(query.get('lang') || navigator.language || 'en'),
    theme: normalizeTheme(query.get('theme') || 'dark'),
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
  running: false,
  activeOperation: '',
  probeRsPath: 'probe-rs',
  chip: 'STM32F103C8',
  probe: '',
  protocol: 'swd',
  speedKHz: '4000',
  timeoutMs: 15000,
  connectUnderReset: false,
  includeAttach: true,
  includeFlash: false,
  firmwarePath: '',
  lastResult: '',
  diagnostics: [],
  suggestions: [],
  steps: [],
  logs: []
};
const DRAFT_KEY = 'swd-debugger.ui.draft.v1';
const DRAFT_FIELDS = [
  'probeRsPath',
  'chip',
  'probe',
  'speedKHz',
  'timeoutMs',
  'connectUnderReset',
  'includeAttach',
  'includeFlash',
  'firmwarePath'
];

let backendWs = null;
let requestSeq = 0;
let logSeq = 0;
const pendingRequests = new Map();

loadDraft();

function normalizeLang(lang) {
  const normalized = String(lang || 'en').toLowerCase().replace(/-/g, '_');
  if (normalized.startsWith('zh_cn') || normalized === 'zh') return 'zh_cn';
  if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
  return normalized || 'en';
}

function normalizeTheme(theme) {
  return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
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
      i18n.bundle = data.SWD_DEBUGGER || {};
      document.title = t('TITLE', 'SWD Debugger');
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

async function connectHost() {
  if (!window.Penpal || !window.parent || window.parent === window) return;

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
          canClose: !state.running,
          running: state.running,
          activeOperation: state.activeOperation
        };
      }
    }
  });

  try {
    const remote = await connection.promise;
    host.remote = remote;
    if (typeof remote.getHostContext === 'function') {
      const context = await remote.getHostContext();
      if (context) await applyHostContext(context);
    }
    if (state.backendStatus === 'ready') notifyHostReady();
  } catch (error) {
    pushLog('error', 'HOST_CONNECTION_FAILED', error.message || String(error));
  }
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
    message: error?.message || String(error || 'SWD Debugger error')
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

function localizedMessage(value) {
  const key = String(value || '');
  return t(key, key);
}

function pushLog(type, label, detail = '') {
  state.logs.unshift({
    id: ++logSeq,
    type,
    label,
    detail,
    time: now()
  });
  state.logs = state.logs.slice(0, 180);
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
    for (const field of DRAFT_FIELDS) draft[field] = state[field];
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    // Storage may be unavailable in some browser modes.
  }
}

function currentPayload() {
  return {
    probeRsPath: state.probeRsPath,
    chip: state.chip,
    probe: state.probe,
    protocol: 'swd',
    speedKHz: state.speedKHz,
    timeoutMs: Number(state.timeoutMs) || 15000,
    connectUnderReset: !!state.connectUnderReset,
    includeAttach: !!state.includeAttach,
    includeFlash: !!state.includeFlash,
    firmwarePath: state.firmwarePath
  };
}

function request(method, params = {}, timeoutMs = 30000) {
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
    state.running = false;
    state.activeOperation = '';
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || 'SWD debugger request failed'));
    }
    render();
    return;
  }

  if (message.event === 'ready') {
    state.backendStatus = 'ready';
    state.backendPid = Number(message.data?.pid) || 0;
    render();
    notifyHostReady();
    return;
  }

  if (message.event === 'probe.command.started') {
    state.running = true;
    state.activeOperation = message.data?.operation || '';
    pushLog('system', 'COMMAND_STARTED', message.data?.command || '');
    return;
  }

  if (message.event === 'probe.output') {
    const stream = message.data?.stream || 'stdout';
    const detail = String(message.data?.text || '').trim();
    if (detail) pushLog(stream === 'stderr' ? 'stderr' : 'stdout', stream.toUpperCase(), detail);
    return;
  }

  if (message.event === 'probe.command.finished') {
    state.running = false;
    state.activeOperation = '';
    pushLog('system', 'COMMAND_FINISHED', `exit=${message.data?.exitCode ?? '-'}, ${message.data?.durationMs || 0}ms`);
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
      const status = await request('status', {}, 5000);
      state.backendStatus = 'ready';
      state.backendPid = Number(status.pid) || state.backendPid;
      render();
      notifyHostReady();
    } catch (error) {
      state.backendStatus = 'error';
      render();
      notifyHostError(error);
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
    if (state.backendStatus !== 'error') state.backendStatus = 'closed';
    state.running = false;
    state.activeOperation = '';
    render();
  });

  backendWs.addEventListener('error', () => {
    state.backendStatus = 'error';
    state.running = false;
    state.activeOperation = '';
    render();
    notifyHostError(new Error('Backend WebSocket connection failed'));
  });
}

function storeResult(result) {
  state.lastResult = JSON.stringify(result, null, 2);
  state.diagnostics = result.diagnostics || [];
  state.suggestions = result.suggestions || [];
  state.steps = result.steps || [];
  if (result.summary) pushLog(result.ok === false ? 'error' : 'system', 'SUMMARY', result.summary);
}

async function runAction(method, label, extra = {}) {
  updateFromInputs();
  saveDraft();
  state.running = true;
  state.activeOperation = label;
  state.lastResult = '';
  state.diagnostics = [];
  state.suggestions = [];
  state.steps = [];
  render();

  const params = { ...currentPayload(), ...extra };
  const timeout = Math.max(Number(params.timeoutMs) || 15000, 5000) + 5000;
  try {
    const result = await request(method, params, timeout);
    storeResult(result);
  } catch (error) {
    state.diagnostics = [{ level: 'error', code: 'REQUEST_FAILED', message: error.message || String(error) }];
    state.suggestions = [];
    pushLog('error', 'REQUEST_FAILED', error.message || String(error));
    notifyHostError(error);
  } finally {
    state.running = false;
    state.activeOperation = '';
    render();
  }
}

async function copyResult() {
  if (!state.lastResult) return;
  try {
    await navigator.clipboard?.writeText(state.lastResult);
    pushLog('system', 'COPIED', '');
  } catch (error) {
    pushLog('error', 'COPY_FAILED', error.message || String(error));
  }
}

function optionSelected(value, current) {
  return String(value) === String(current) ? 'selected' : '';
}

function renderConfigPanel() {
  return `
    <section class="panel config-panel">
      <div class="panel-title">${text('TARGET_CONFIG', 'Target')}</div>
      <div class="field-grid">
        <label class="field"><span>${text('PROBE_RS_PATH', 'probe-rs')}</span><input type="text" data-field="probeRsPath" value="${escapeAttr(state.probeRsPath)}" placeholder="probe-rs"></label>
        <label class="field"><span>${text('CHIP', 'Chip')}</span><input type="text" data-field="chip" value="${escapeAttr(state.chip)}" placeholder="STM32F103C8"></label>
        <label class="field"><span>${text('PROBE_SELECTOR', 'Probe')}</span><input type="text" data-field="probe" value="${escapeAttr(state.probe)}" placeholder="VID:PID:serial"></label>
        <label class="field"><span>${text('SWD_SPEED', 'SWD speed')}</span><select data-field="speedKHz">
          ${['100', '400', '1000', '2000', '4000', '8000', '12000'].map(value => `<option value="${value}" ${optionSelected(value, state.speedKHz)}>${value} kHz</option>`).join('')}
        </select></label>
        <label class="field"><span>${text('TIMEOUT', 'Timeout')}</span><input type="number" min="1000" max="180000" step="1000" data-field="timeoutMs" value="${escapeAttr(state.timeoutMs)}"></label>
        <label class="field"><span>${text('FIRMWARE_PATH', 'Firmware')}</span><input type="text" data-field="firmwarePath" value="${escapeAttr(state.firmwarePath)}" placeholder="target/thumbv7m-none-eabi/debug/app"></label>
      </div>
      <div class="check-row">
        <label class="check-field"><input type="checkbox" data-field="connectUnderReset" ${state.connectUnderReset ? 'checked' : ''}><span>${text('CONNECT_UNDER_RESET', 'Connect under reset')}</span></label>
        <label class="check-field"><input type="checkbox" data-field="includeAttach" ${state.includeAttach ? 'checked' : ''}><span>${text('AUTO_ATTACH', 'Attach in auto')}</span></label>
        <label class="check-field"><input type="checkbox" data-field="includeFlash" ${state.includeFlash ? 'checked' : ''}><span>${text('AUTO_FLASH', 'Flash in auto')}</span></label>
      </div>
    </section>
  `;
}

function renderActionPanel() {
  return `
    <section class="panel action-panel">
      <div class="panel-title">
        <span>${text('ACTIONS', 'Actions')}</span>
        <span class="status ${state.running ? 'busy' : state.backendStatus === 'ready' ? 'ready' : 'error'}">${escapeHtml(t(`STATUS_${state.running ? 'BUSY' : state.backendStatus.toUpperCase()}`, state.running ? 'Busy' : state.backendStatus))}</span>
      </div>
      <div class="button-grid">
        <button type="button" data-action="version" ${state.running ? 'disabled' : ''}>${text('CHECK_VERSION', 'Version')}</button>
        <button type="button" data-action="list" ${state.running ? 'disabled' : ''}>${text('LIST_PROBES', 'List probes')}</button>
        <button type="button" data-action="info" ${state.running ? 'disabled' : ''}>${text('READ_INFO', 'Target info')}</button>
        <button type="button" data-action="attach" ${state.running ? 'disabled' : ''}>${text('ATTACH', 'Attach')}</button>
        <button type="button" data-action="run" ${state.running ? 'disabled' : ''}>${text('FLASH_RUN', 'Flash and run')}</button>
        <button type="button" class="primary" data-action="auto" ${state.running ? 'disabled' : ''}>${text('AUTO_DIAGNOSE', 'Auto diagnose')}</button>
      </div>
      <div class="command-preview mono">
        ${escapeHtml(state.activeOperation || `${state.probeRsPath || 'probe-rs'} info --chip ${state.chip || '<chip>'} --protocol swd`)}
      </div>
      <div class="actions">
        <button type="button" data-action="copy-result" ${state.lastResult ? '' : 'disabled'}>${text('COPY_RESULT', 'Copy result')}</button>
        <button type="button" data-action="clear">${text('CLEAR', 'Clear')}</button>
      </div>
    </section>
  `;
}

function renderDiagnostics() {
  const diagnostics = state.diagnostics.length
    ? state.diagnostics.map(item => `
      <div class="diagnostic ${escapeAttr(item.level || 'info')}">
        <span>${escapeHtml(item.code || item.level || 'INFO')}</span>
        <strong>${escapeHtml(item.message || '')}</strong>
      </div>
    `).join('')
    : `<div class="empty">${text('NO_DIAGNOSTICS', 'No diagnostics')}</div>`;

  const suggestions = state.suggestions.length
    ? state.suggestions.map(item => `<li>${escapeHtml(item)}</li>`).join('')
    : `<li>${text('NO_SUGGESTIONS', 'No next step')}</li>`;

  const steps = state.steps.length
    ? state.steps.map(step => `
      <div class="step-row">
        <span>${escapeHtml(step.operation || '')}</span>
        <code>${escapeHtml(String(step.exitCode ?? '-'))}</code>
        <strong>${escapeHtml((step.diagnostics || [])[0]?.code || '')}</strong>
      </div>
    `).join('')
    : '';

  return `
    <section class="panel diagnostic-panel">
      <div class="panel-title">${text('DIAGNOSTICS', 'Diagnostics')}</div>
      <div class="diagnostic-list">${diagnostics}</div>
      <div class="suggestion-title">${text('NEXT_STEPS', 'Next steps')}</div>
      <ul class="suggestion-list">${suggestions}</ul>
      ${steps ? `<div class="step-list">${steps}</div>` : ''}
    </section>
  `;
}

function renderResultPanel() {
  return `
    <section class="panel result-panel">
      <div class="panel-title">${text('JSON_RESULT', 'JSON result')}</div>
      <pre class="mono">${escapeHtml(state.lastResult || '')}</pre>
    </section>
  `;
}

function renderLogPanel() {
  return `
    <section class="panel log-panel">
      <div class="panel-title">${text('LOG', 'Log')}</div>
      <div class="log-list">
        ${state.logs.map(log => `
          <div class="log-row ${escapeAttr(log.type)}">
            <span class="time">${escapeHtml(log.time)}</span>
            <span class="label">${escapeHtml(localizedMessage(log.label))}</span>
            <span class="detail mono">${escapeHtml(log.detail)}</span>
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function render() {
  app.innerHTML = `
    <div class="toolbar">
      <div>
        <h1>${text('TITLE', 'SWD Debugger')}</h1>
        <p>${text('DESCRIPTION', 'probe-rs SWD automation debugger')}</p>
      </div>
      <span class="pid">pid ${escapeHtml(state.backendPid || '-')}</span>
    </div>
    <div class="workspace">
      ${renderConfigPanel()}
      ${renderActionPanel()}
      ${renderDiagnostics()}
      ${renderResultPanel()}
      ${renderLogPanel()}
    </div>
  `;
}

function updateFromInputs() {
  for (const element of app.querySelectorAll('[data-field]')) {
    const field = element.dataset.field;
    if (!field) continue;
    if (element.type === 'checkbox') {
      state[field] = element.checked;
    } else if (element.type === 'number') {
      state[field] = Number(element.value);
    } else {
      state[field] = element.value;
    }
  }
}

app.addEventListener('input', event => {
  if (event.target.matches('[data-field]')) {
    updateFromInputs();
    saveDraft();
  }
});

app.addEventListener('change', event => {
  if (event.target.matches('[data-field]')) {
    updateFromInputs();
    saveDraft();
    render();
  }
});

app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  if (action === 'version') void runAction('probe.version', 'version', { timeoutMs: 5000 });
  if (action === 'list') void runAction('probe.list', 'list');
  if (action === 'info') void runAction('probe.info', 'info');
  if (action === 'attach') void runAction('probe.attach', 'attach');
  if (action === 'run') void runAction('probe.run', 'run', { includeFlash: true });
  if (action === 'auto') void runAction('probe.auto', 'auto');
  if (action === 'copy-result') void copyResult();
  if (action === 'clear') {
    state.lastResult = '';
    state.diagnostics = [];
    state.suggestions = [];
    state.steps = [];
    state.logs = [];
    render();
  }
});

window.addEventListener('beforeunload', () => {
  saveDraft();
  if (backendWs) backendWs.close();
});

async function bootstrap() {
  document.documentElement.lang = host.context.lang;
  applyTheme(host.context.theme);
  render();
  void loadI18n(host.context.lang);
  await connectHost();
  connectBackend();
}

void bootstrap();
