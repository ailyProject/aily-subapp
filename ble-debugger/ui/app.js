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
const LOG_LABEL_KEYS = {
  'Host connection failed': 'HOST_CONNECTION_FAILED',
  'Invalid UUID': 'INVALID_UUID',
  Notification: 'NOTIFICATION',
  'Backend error': 'BACKEND_ERROR',
  'Backend log': 'BACKEND_LOG',
  'Backend ready': 'BACKEND_READY',
  'Status failed': 'STATUS_FAILED',
  'Message parse failed': 'MESSAGE_PARSE_FAILED',
  'WebSocket closed': 'WEBSOCKET_CLOSED',
  'Scan started': 'SCAN_STARTED',
  'Scan stopped': 'SCAN_STOPPED',
  'Scan failed': 'SCAN_FAILED',
  'Device connected': 'DEVICE_CONNECTED',
  'Connect failed': 'CONNECT_FAILED',
  'Device disconnected': 'DEVICE_DISCONNECTED',
  'Disconnect failed': 'DISCONNECT_FAILED',
  'GATT refreshed': 'GATT_REFRESHED',
  'GATT failed': 'GATT_FAILED',
  'Read OK': 'READ_OK',
  'Read failed': 'READ_FAILED',
  'Write OK': 'WRITE_OK',
  'Write failed': 'WRITE_FAILED',
  'Notify enabled': 'NOTIFY_ENABLED',
  'Notify disabled': 'NOTIFY_DISABLED',
  'Notify failed': 'NOTIFY_FAILED'
};
const state = {
  backendStatus: 'connecting',
  adapterState: 'unknown',
  backendPid: 0,
  activeTab: 'scan',
  scanning: false,
  allowDuplicates: true,
  serviceFilter: '',
  devices: [],
  selectedDeviceId: '',
  connectedDevices: [],
  connectingDeviceId: '',
  payloadMode: 'hex',
  payload: '01 02 03 04',
  writeWithoutResponse: false,
  logs: []
};

let ws = null;
let requestSeq = 0;
const pendingRequests = new Map();
let logSeq = 0;

document.documentElement.lang = host.context.lang;
applyTheme(host.context.theme);

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
      i18n.bundle = data.BLE_DEBUGGER || {};
      document.title = t('TITLE', 'BLE Debugger');
      render();
      return;
    } catch {
      // Try the next fallback language.
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
        return {
          canClose: true,
          connected: state.connectedDevices.length > 0,
          scanning: state.scanning
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
      pushLog('error', 'Host connection failed', error.message || String(error));
    });
}

function notifyHostReady() {
  if (!host.remote || typeof host.remote.childReady !== 'function') {
    return;
  }

  void host.remote.childReady({
    wsConnected: !!ws && ws.readyState === WebSocket.OPEN,
    adapterState: state.adapterState,
    backendStatus: state.backendStatus,
    connectedCount: state.connectedDevices.length,
    pid: state.backendPid
  });
}

function notifyHostError(error) {
  if (!host.remote || typeof host.remote.childError !== 'function') {
    return;
  }

  void host.remote.childError({
    message: error?.message || String(error || 'Unknown BLE debugger error')
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

function attrText(key, fallback = key) {
  return escapeAttr(t(key, fallback));
}

function logLabel(label) {
  const key = LOG_LABEL_KEYS[label];
  return key ? t(key, label) : label;
}

function rssiClass(device) {
  if (device.rssi === null || device.rssi === undefined) return 'weak';
  if (device.rssi >= -60) return 'strong';
  if (device.rssi >= -78) return 'medium';
  return 'weak';
}

function hasProperty(characteristic, property) {
  return !!characteristic?.properties?.includes(property);
}

function canRead(characteristic) {
  return hasProperty(characteristic, 'read');
}

function canWrite(characteristic) {
  return hasProperty(characteristic, 'write') || hasProperty(characteristic, 'writeWithoutResponse');
}

function canNotify(characteristic) {
  return hasProperty(characteristic, 'notify') || hasProperty(characteristic, 'indicate');
}

function deviceTabId(deviceId) {
  return `device:${deviceId}`;
}

function activeDeviceId() {
  return state.activeTab.startsWith('device:') ? state.activeTab.slice('device:'.length) : '';
}

function connectionById(deviceId) {
  return state.connectedDevices.find(connection => connection.id === deviceId) || null;
}

function activeConnection() {
  return connectionById(activeDeviceId());
}

function isConnected(deviceId) {
  return !!connectionById(deviceId);
}

function deviceLabel(device) {
  return device?.name || t('UNKNOWN', 'Unknown');
}

function deviceLogDetail(device) {
  if (!device) return '';
  return `${deviceLabel(device)} (${device.address || device.id})`;
}

function selectedCharacteristic(connection = activeConnection()) {
  if (!connection) return null;
  for (const service of connection.services) {
    const match = service.characteristics.find(characteristic =>
      characteristic.uuid === connection.selectedCharacteristicUuid &&
      service.uuid === connection.selectedServiceUuid
    );
    if (match) return match;
  }
  return null;
}

function pushLog(type, label, detail = '', value = '') {
  state.logs.unshift({
    id: ++logSeq,
    time: new Date().toLocaleTimeString(),
    type,
    label,
    detail,
    value
  });
  state.logs = state.logs.slice(0, 160);
  render();
}

function renderDevices() {
  if (!state.devices.length) {
    return `<div class="empty-state">${text('DEVICE_LIST_EMPTY', 'No BLE devices found yet')}</div>`;
  }

  return state.devices.map(device => {
    const active = state.selectedDeviceId === device.id ? ' active' : '';
    const connected = isConnected(device.id) ? ' connected' : '';
    const connecting = state.connectingDeviceId === device.id;
    return `
      <div class="device-row${active}${connected}" data-action="select-device" data-id="${escapeAttr(device.id)}">
        <span class="signal ${rssiClass(device)}">${escapeHtml(device.rssi ?? '-')}</span>
        <span class="device-main">
          <strong>${escapeHtml(device.name || t('UNKNOWN', 'Unknown'))}</strong>
          <span class="mono">${escapeHtml(device.address || device.id)}</span>
        </span>
        <button type="button" class="device-action" data-action="connect-device" data-id="${escapeAttr(device.id)}" ${connecting || isConnected(device.id) ? 'disabled' : ''} title="${attrText('CONNECT', 'Connect')}">
          ${connecting ? '...' : '>'}
        </button>
      </div>
    `;
  }).join('');
}

function renderGatt(connection) {
  if (!connection?.services?.length) {
    return `<div class="empty-state">${text('GATT_EMPTY', 'No GATT database loaded')}</div>`;
  }

  return connection.services.map(service => `
    <div class="service-block">
      <div class="service-title">
        <span>${text('SERVICE', 'Service')}</span>
        <span class="mono">${escapeHtml(service.uuid)}</span>
      </div>
      ${service.characteristics.map(characteristic => {
        const active = connection.selectedServiceUuid === service.uuid && connection.selectedCharacteristicUuid === characteristic.uuid ? ' active' : '';
        return `
          <button type="button" class="characteristic-row${active}" data-action="select-characteristic" data-service="${escapeAttr(service.uuid)}" data-characteristic="${escapeAttr(characteristic.uuid)}">
            <span class="mono">${escapeHtml(characteristic.uuid)}</span>
            <span class="property-list">
              ${(characteristic.properties || []).map(property => `<code>${escapeHtml(property)}</code>`).join('')}
            </span>
          </button>
        `;
      }).join('')}
    </div>
  `).join('');
}

function renderOperation(connection) {
  const characteristic = selectedCharacteristic(connection);
  if (!characteristic) {
    return `<div class="empty-state">${text('NO_CHARACTERISTIC', 'Select a characteristic')}</div>`;
  }

  return `
    <div class="selected-characteristic">
      <span class="mono">${escapeHtml(characteristic.serviceUuid)}</span>
      <strong class="mono">${escapeHtml(characteristic.uuid)}</strong>
    </div>

    <div class="operation-buttons">
      <button type="button" data-action="read-selected" ${canRead(characteristic) ? '' : 'disabled'}>${text('READ', 'Read')}</button>
      <button type="button" data-action="toggle-notify" class="${characteristic.notifying ? 'active' : ''}" ${canNotify(characteristic) ? '' : 'disabled'}>
        ${characteristic.notifying ? text('UNSUBSCRIBE', 'Unsubscribe') : text('SUBSCRIBE', 'Subscribe')}
      </button>
    </div>

    <div class="field-grid">
      <label class="field">
        <span>${text('WRITE_MODE', 'Write mode')}</span>
        <select data-field="payloadMode">
          <option value="hex" ${state.payloadMode === 'hex' ? 'selected' : ''}>${text('HEX', 'Hex')}</option>
          <option value="ascii" ${state.payloadMode === 'ascii' ? 'selected' : ''}>${text('ASCII', 'ASCII')}</option>
        </select>
      </label>
      <label class="check-field">
        <input type="checkbox" data-field="writeWithoutResponse" ${state.writeWithoutResponse ? 'checked' : ''}>
        <span>${text('WITHOUT_RESPONSE', 'Without response')}</span>
      </label>
    </div>

    <label class="field payload">
      <span>${text('PAYLOAD', 'Payload')}</span>
      <textarea class="mono" data-field="payload">${escapeHtml(state.payload)}</textarea>
    </label>

    <div class="actions">
      <button type="button" class="primary" data-action="write-selected" ${canWrite(characteristic) ? '' : 'disabled'}>${text('WRITE', 'Write')}</button>
    </div>

    <div class="value-preview">
      <div class="result-title">${text('LAST_VALUE', 'Last value')}</div>
      <pre class="mono">${escapeHtml(characteristic.lastValueHex || '-')}</pre>
      ${characteristic.lastValueAscii ? `<code>${escapeHtml(characteristic.lastValueAscii)}</code>` : ''}
    </div>
  `;
}

function renderLogs() {
  if (!state.logs.length) {
    return `<div class="empty-state">${text('LOG_EMPTY', 'No log entries')}</div>`;
  }

  return state.logs.map(log => `
    <div class="log-row ${escapeAttr(log.type)}">
      <span class="time">${escapeHtml(log.time)}</span>
      <span class="label">${escapeHtml(logLabel(log.label))}</span>
      ${log.detail ? `<span class="detail mono">${escapeHtml(log.detail)}</span>` : '<span></span>'}
      ${log.value ? `<span class="value mono">${escapeHtml(log.value)}</span>` : ''}
    </div>
  `).join('');
}

function renderTabs() {
  const activeScan = state.activeTab === 'scan' ? ' active' : '';

  return `
    <div class="tabbar" role="tablist">
      <button type="button" class="tab-button${activeScan}" data-action="switch-tab" data-tab="scan" role="tab" aria-selected="${state.activeTab === 'scan'}">
        <span class="tab-label">${text('SCAN', 'Scan')}</span>
      </button>
      ${state.connectedDevices.map(connection => {
        const tabId = deviceTabId(connection.id);
        const activeDevice = state.activeTab === tabId ? ' active' : '';
        const connectedLabel = deviceLabel(connection.device);
        return `
        <div class="tab-item${activeDevice}" role="presentation">
          <button type="button" class="tab-button device-tab-button" data-action="switch-tab" data-tab="device" data-id="${escapeAttr(connection.id)}" role="tab" aria-selected="${state.activeTab === tabId}" title="${escapeAttr(connectedLabel)}">
            <span class="tab-label">${escapeHtml(connectedLabel)}</span>
          </button>
          <button type="button" class="tab-close" data-action="disconnect" data-id="${escapeAttr(connection.id)}" title="${attrText('DISCONNECT', 'Disconnect')}">x</button>
        </div>
      `;
      }).join('')}
    </div>
  `;
}

function renderLogPanel() {
  return `
    <section class="panel log-panel">
      <div class="panel-title">
        <span>${text('LOG', 'Log')}</span>
        <button type="button" class="icon-action" data-action="clear-logs" title="${attrText('CLEAR_LOGS', 'Clear logs')}">x</button>
      </div>
      <div class="log-list">${renderLogs()}</div>
    </section>
  `;
}

function renderScanTab() {
  return `
    <div class="tab-page scan-page" role="tabpanel">
      <section class="panel scan-panel">
        <div class="panel-title">
          <span>${text('SCAN', 'Scan')}</span>
          <button type="button" class="icon-action" data-action="clear-devices" title="${attrText('CLEAR_DEVICES', 'Clear devices')}">x</button>
        </div>
        <div class="field-row">
          <label class="field">
            <span>${text('SERVICE_FILTER', 'Service filter')}</span>
            <input type="text" data-field="serviceFilter" value="${escapeAttr(state.serviceFilter)}" placeholder="180D, FFE0">
          </label>
          <label class="check-field">
            <input type="checkbox" data-field="allowDuplicates" ${state.allowDuplicates ? 'checked' : ''}>
            <span>${text('DUPLICATES', 'Duplicates')}</span>
          </label>
        </div>
        <div class="actions">
          <button type="button" class="primary" data-action="toggle-scan" ${!state.scanning && state.backendStatus !== 'ready' ? 'disabled' : ''}>${state.scanning ? text('STOP_SCAN', 'Stop scan') : text('START_SCAN', 'Start scan')}</button>
        </div>
        <div class="device-list">${renderDevices()}</div>
      </section>
      ${renderLogPanel()}
    </div>
  `;
}

function renderDeviceTab(connection) {
  const connected = connection?.device;
  return `
    <div class="tab-page device-page" role="tabpanel">
      <section class="panel gatt-panel">
        <div class="panel-title">
          <span>${text('GATT', 'GATT')}</span>
          <div class="title-actions">
            <button type="button" class="icon-action" data-action="refresh-gatt" data-id="${escapeAttr(connection?.id || '')}" ${connection ? '' : 'disabled'} title="${attrText('REFRESH', 'Refresh')}">r</button>
            <button type="button" class="icon-action" data-action="disconnect" data-id="${escapeAttr(connection?.id || '')}" ${connection ? '' : 'disabled'} title="${attrText('DISCONNECT', 'Disconnect')}">-</button>
          </div>
        </div>
        <div class="connected-device">
          ${connected ? `
            <strong>${escapeHtml(deviceLabel(connected))}</strong>
            <span class="mono">${escapeHtml(connected.address || connected.id)}</span>
          ` : `<span>${text('NO_DEVICE', 'No device connected')}</span>`}
        </div>
        <div class="gatt-list">${renderGatt(connection)}</div>
      </section>

      <section class="panel operation-panel">
        <div class="panel-title">${text('OPERATION', 'Operation')}</div>
        ${renderOperation(connection)}
      </section>
      ${renderLogPanel()}
    </div>
  `;
}

function render() {
  const connection = activeConnection();
  if (state.activeTab !== 'scan' && !connection) {
    state.activeTab = 'scan';
  }

  app.className = `ble-debugger ${state.backendStatus === 'connecting' ? 'loading' : ''} ${state.backendStatus === 'error' ? 'failed' : ''}`;
  app.innerHTML = `
    ${renderTabs()}
    ${state.activeTab !== 'scan' ? renderDeviceTab(activeConnection()) : renderScanTab()}

    <div class="overlay">${state.backendStatus === 'error' ? text('UI_FAILED', 'BLE debugger backend connection failed') : text('UI_CONNECTING', 'Connecting BLE debugger...')}</div>
  `;
}

function updateFromInputs() {
  const serviceFilter = app.querySelector('[data-field="serviceFilter"]');
  const allowDuplicates = app.querySelector('[data-field="allowDuplicates"]');
  const payloadMode = app.querySelector('[data-field="payloadMode"]');
  const payload = app.querySelector('[data-field="payload"]');
  const withoutResponse = app.querySelector('[data-field="writeWithoutResponse"]');

  if (serviceFilter) state.serviceFilter = serviceFilter.value;
  if (allowDuplicates) state.allowDuplicates = allowDuplicates.checked;
  if (payloadMode) state.payloadMode = payloadMode.value;
  if (payload) state.payload = payload.value;
  if (withoutResponse) state.writeWithoutResponse = withoutResponse.checked;
}

function parseServiceFilter() {
  const tokens = state.serviceFilter
    .split(/[\s,;]+/)
    .map(token => token.trim())
    .filter(Boolean);

  for (const token of tokens) {
    const normalized = token.replace(/^0x/i, '').replace(/-/g, '');
    if (!/^[a-fA-F0-9]{4}$|^[a-fA-F0-9]{32}$/.test(normalized)) {
      pushLog('error', 'Invalid UUID', token);
      return null;
    }
  }

  return tokens;
}

function selectFirstCharacteristic(connection) {
  if (!connection) return;
  const firstService = connection.services[0];
  const firstCharacteristic = firstService?.characteristics?.[0];
  if (!firstService || !firstCharacteristic) {
    connection.selectedServiceUuid = '';
    connection.selectedCharacteristicUuid = '';
    return;
  }

  const stillExists = connection.services.some(service =>
    service.uuid === connection.selectedServiceUuid &&
    service.characteristics.some(characteristic => characteristic.uuid === connection.selectedCharacteristicUuid)
  );

  if (!stillExists) {
    connection.selectedServiceUuid = firstService.uuid;
    connection.selectedCharacteristicUuid = firstCharacteristic.uuid;
  }
}

function upsertConnection(device, services = []) {
  if (!device?.id) return null;
  let connection = connectionById(device.id);
  if (!connection) {
    connection = {
      id: device.id,
      device,
      services: [],
      selectedServiceUuid: '',
      selectedCharacteristicUuid: ''
    };
    state.connectedDevices.push(connection);
  } else {
    connection.device = { ...connection.device, ...device };
  }

  if (Array.isArray(services)) {
    connection.services = services;
    selectFirstCharacteristic(connection);
  }

  return connection;
}

function removeConnection(deviceId) {
  if (!deviceId) return;
  state.connectedDevices = state.connectedDevices.filter(connection => connection.id !== deviceId);
  if (state.activeTab === deviceTabId(deviceId)) {
    state.activeTab = 'scan';
  }
  if (state.selectedDeviceId === deviceId) {
    state.selectedDeviceId = '';
  }
}

function hydrateConnections(items = []) {
  state.connectedDevices = [];
  for (const item of items) {
    upsertConnection(item.device, item.services || []);
  }
  if (state.activeTab !== 'scan' && !activeConnection()) {
    state.activeTab = state.connectedDevices[0] ? deviceTabId(state.connectedDevices[0].id) : 'scan';
  }
}

function upsertDevice(device) {
  if (!device?.id) return;
  const index = state.devices.findIndex(item => item.id === device.id);
  if (index >= 0) {
    state.devices[index] = { ...state.devices[index], ...device };
  } else {
    state.devices.unshift(device);
  }

  state.devices = [...state.devices]
    .sort((a, b) => (b.rssi ?? -999) - (a.rssi ?? -999))
    .slice(0, 120);

  const connection = connectionById(device.id);
  if (connection) {
    connection.device = { ...connection.device, ...device };
  }
  render();
}

function updateCharacteristic(deviceId, serviceUuid, characteristicUuid, patch) {
  const connection = connectionById(deviceId);
  if (!connection) return;

  connection.services = connection.services.map(service => {
    if (service.uuid !== serviceUuid) return service;
    return {
      ...service,
      characteristics: service.characteristics.map(characteristic =>
        characteristic.uuid === characteristicUuid ? { ...characteristic, ...patch } : characteristic
      )
    };
  });
}

function request(method, params = {}, timeoutMs = 15000) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
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

  ws.send(payload);
  return response;
}

function handleEvent(event, data = {}) {
  switch (event) {
    case 'ready':
      state.backendStatus = 'ready';
      state.backendPid = Number(data.pid) || 0;
      state.adapterState = data.state || state.adapterState;
      state.scanning = !!data.scanning;
      if (Array.isArray(data.connectedDevices)) {
        hydrateConnections(data.connectedDevices);
      }
      break;
    case 'state':
      state.adapterState = data.state || 'unknown';
      state.scanning = !!data.scanning;
      break;
    case 'scanStart':
      state.scanning = true;
      break;
    case 'scanStop':
      state.scanning = false;
      break;
    case 'device':
      upsertDevice(data);
      return;
    case 'connected':
      {
        const connection = upsertConnection(data.device, data.services || []);
        if (connection) {
          state.selectedDeviceId = connection.id;
          state.activeTab = deviceTabId(connection.id);
        }
      }
      break;
    case 'disconnected':
      {
        const deviceId = data.deviceId || data.id;
        const connection = connectionById(deviceId);
        const device = data.device || connection?.device || state.devices.find(item => item.id === deviceId);
        removeConnection(deviceId);
        if (connection) {
          pushLog('connect', 'Device disconnected', deviceLogDetail(device));
        }
        return;
      }
      break;
    case 'notification':
      updateCharacteristic(data.deviceId || activeDeviceId(), data.serviceUuid, data.characteristicUuid, {
        lastValueHex: data.valueHex,
        lastValueAscii: data.valueAscii,
        notifying: true
      });
      pushLog('notify', 'Notification', `${data.characteristicUuid}, ${data.byteLength} B`, data.valueHex);
      return;
    case 'fatal':
    case 'error':
      state.backendStatus = 'error';
      pushLog('error', 'Backend error', data.message || '');
      return;
    case 'log':
      pushLog('system', 'Backend log', data.message || '');
      return;
    default:
      break;
  }
  render();
}

function handleMessage(raw) {
  const message = JSON.parse(raw);
  if (typeof message.id === 'number') {
    const pending = pendingRequests.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || 'BLE request failed'));
    }
    return;
  }

  if (message.event) {
    handleEvent(message.event, message.data || {});
  }
}

function connectWs() {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(new Error('WebSocket reconnecting'));
  }
  pendingRequests.clear();

  if (ws) {
    ws.close();
    ws = null;
  }

  state.backendStatus = 'connecting';
  render();

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.addEventListener('open', async () => {
    try {
      const status = await request('status');
      state.adapterState = status.state || state.adapterState;
      state.scanning = !!status.scanning;
      hydrateConnections(status.connectedDevices || []);
      state.backendStatus = 'ready';
      pushLog('system', 'Backend ready');
      notifyHostReady();
    } catch (error) {
      state.backendStatus = 'error';
      pushLog('error', 'Status failed', error.message);
      notifyHostError(error);
    }
    render();
  });

  ws.addEventListener('message', event => {
    try {
      handleMessage(event.data);
    } catch (error) {
      pushLog('error', 'Message parse failed', error.message);
    }
  });

  ws.addEventListener('close', () => {
    if (state.backendStatus !== 'error') {
      state.backendStatus = 'closed';
      pushLog('system', 'WebSocket closed');
    }
    render();
  });

  ws.addEventListener('error', () => {
    state.backendStatus = 'error';
    notifyHostError(new Error('WebSocket connection failed'));
    render();
  });
}

async function startScan() {
  const serviceUuids = parseServiceFilter();
  if (serviceUuids === null) return;

  try {
    await request('startScan', {
      serviceUuids,
      allowDuplicates: state.allowDuplicates
    });
    state.scanning = true;
    pushLog('scan', 'Scan started');
  } catch (error) {
    pushLog('error', 'Scan failed', error.message);
  }
}

async function stopScan() {
  try {
    await request('stopScan');
    state.scanning = false;
    pushLog('scan', 'Scan stopped');
  } catch (error) {
    pushLog('error', 'Scan failed', error.message);
  }
}

async function connectDevice(id) {
  const device = state.devices.find(item => item.id === id);
  if (!device) return;

  state.selectedDeviceId = id;
  state.connectingDeviceId = id;
  render();

  try {
    const result = await request('connect', { id }, 30000);
    const resultDevice = result.device || device;
    const connection = upsertConnection({ ...device, ...resultDevice }, result.services || []);
    if (connection) {
      state.activeTab = deviceTabId(connection.id);
    }
    pushLog('connect', 'Device connected', deviceLogDetail(resultDevice));
  } catch (error) {
    pushLog('error', 'Connect failed', error.message);
  } finally {
    state.connectingDeviceId = '';
    render();
  }
}

async function disconnectDevice(deviceId = activeDeviceId()) {
  if (!deviceId) return;
  const connection = connectionById(deviceId);

  try {
    await request('disconnect', { deviceId });
    if (connectionById(deviceId)) {
      removeConnection(deviceId);
      pushLog('connect', 'Device disconnected', deviceLogDetail(connection?.device || state.devices.find(item => item.id === deviceId)));
    }
  } catch (error) {
    pushLog('error', 'Disconnect failed', error.message);
  }
}

async function refreshGatt(deviceId = activeDeviceId()) {
  const connection = connectionById(deviceId);
  if (!connection) return;

  try {
    const result = await request('discoverGatt', { deviceId }, 30000);
    connection.services = result.services || [];
    selectFirstCharacteristic(connection);
    pushLog('system', 'GATT refreshed');
  } catch (error) {
    pushLog('error', 'GATT failed', error.message);
  }
}

async function readSelected() {
  const deviceId = activeDeviceId();
  const characteristic = selectedCharacteristic();
  if (!characteristic || !canRead(characteristic)) return;

  try {
    const result = await request('read', {
      deviceId,
      serviceUuid: characteristic.rawServiceUuid,
      characteristicUuid: characteristic.rawUuid
    });
    updateCharacteristic(result.deviceId || deviceId, result.serviceUuid, result.characteristicUuid, {
      lastValueHex: result.valueHex,
      lastValueAscii: result.valueAscii
    });
    pushLog('rx', 'Read OK', `${result.characteristicUuid}, ${result.byteLength} B`, result.valueHex);
  } catch (error) {
    pushLog('error', 'Read failed', error.message);
  }
}

async function writeSelected() {
  const deviceId = activeDeviceId();
  const characteristic = selectedCharacteristic();
  if (!characteristic || !canWrite(characteristic)) return;

  try {
    const result = await request('write', {
      deviceId,
      serviceUuid: characteristic.rawServiceUuid,
      characteristicUuid: characteristic.rawUuid,
      mode: state.payloadMode,
      payload: state.payload,
      withoutResponse: state.writeWithoutResponse
    });
    pushLog('tx', 'Write OK', `${result.characteristicUuid}, ${result.byteLength} B`, result.valueHex);
  } catch (error) {
    pushLog('error', 'Write failed', error.message);
  }
}

async function toggleNotify() {
  const deviceId = activeDeviceId();
  const characteristic = selectedCharacteristic();
  if (!characteristic || !canNotify(characteristic)) return;

  const method = characteristic.notifying ? 'unsubscribe' : 'subscribe';
  try {
    const result = await request(method, {
      deviceId,
      serviceUuid: characteristic.rawServiceUuid,
      characteristicUuid: characteristic.rawUuid
    });
    updateCharacteristic(result.deviceId || deviceId, result.serviceUuid, result.characteristicUuid, {
      notifying: method === 'subscribe'
    });
    pushLog('notify', method === 'subscribe' ? 'Notify enabled' : 'Notify disabled', result.characteristicUuid);
  } catch (error) {
    pushLog('error', 'Notify failed', error.message);
  }
}

app.addEventListener('input', event => {
  if (event.target.matches('[data-field]')) {
    updateFromInputs();
  }
});

app.addEventListener('change', event => {
  if (event.target.matches('[data-field]')) {
    updateFromInputs();
    render();
  }
});

app.addEventListener('click', event => {
  const target = event.target.closest('[data-action]');
  if (!target) return;

  updateFromInputs();
  const action = target.dataset.action;
  const id = target.dataset.id;

  if (action === 'switch-tab') {
    const tab = target.dataset.tab;
    if (tab === 'device') {
      if (!connectionById(id)) return;
      state.activeTab = deviceTabId(id);
    } else {
      state.activeTab = 'scan';
    }
    render();
  }
  if (action === 'clear-devices') {
    state.devices = [];
    render();
  }
  if (action === 'clear-logs') {
    state.logs = [];
    render();
  }
  if (action === 'toggle-scan') {
    void (state.scanning ? stopScan() : startScan());
  }
  if (action === 'select-device') {
    state.selectedDeviceId = id;
    render();
  }
  if (action === 'connect-device') void connectDevice(id);
  if (action === 'disconnect') void disconnectDevice(id || activeDeviceId());
  if (action === 'refresh-gatt') void refreshGatt(id || activeDeviceId());
  if (action === 'select-characteristic') {
    const connection = activeConnection();
    if (!connection) return;
    connection.selectedServiceUuid = target.dataset.service;
    connection.selectedCharacteristicUuid = target.dataset.characteristic;
    render();
  }
  if (action === 'read-selected') void readSelected();
  if (action === 'write-selected') void writeSelected();
  if (action === 'toggle-notify') void toggleNotify();
});

window.addEventListener('beforeunload', () => {
  if (ws) ws.close();
});

render();
void loadI18n(host.context.lang);
connectHost();
connectWs();
