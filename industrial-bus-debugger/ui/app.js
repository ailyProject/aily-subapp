'use strict';

const app = document.getElementById('app');
const query = new URLSearchParams(window.location.search);
const token = query.get('token') || '';
const host = {
  remote: null,
  context: {
    lang: normalizeLang(query.get('lang') || navigator.language || 'en'),
    theme: 'dark',
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
  mode: 'can',
  canBitrate: '500000',
  canFrameFormat: 'standard',
  canFrameType: 'data',
  canFrameId: '123',
  canPayload: '01 02 03 04',
  canDlc: 0,
  canFdEnabled: false,
  canFilterId: '',
  canFilterMask: '7FF',
  canTraceInput: '123#DEADBEEF',
  rs485Port: 'COM3',
  rs485BaudRate: '9600',
  rs485DataBits: '8',
  rs485StopBits: '1',
  rs485Parity: 'none',
  rs485PayloadMode: 'hex',
  rs485Payload: '01 03 00 00 00 02',
  rs485AppendCrc: true,
  rs485ReceiveInput: '01 03 04 00 2A 00 64 DA 3F',
  modbusProtocol: 'rtu',
  modbusTransactionId: 1,
  modbusUnitId: 1,
  modbusFunction: '03',
  modbusAddress: 0,
  modbusQuantity: 2,
  modbusWriteValue: '00 01',
  modbusRequestHex: '',
  modbusResponseHex: '01 03 04 00 2A 00 64 DA 3F',
  logs: []
};
const DRAFT_KEY = 'industrial-bus-debugger.ui.draft.v1';

const canBitrates = ['125000', '250000', '500000', '1000000'];
const baudRates = ['9600', '19200', '38400', '57600', '115200', '230400'];
const dataBitOptions = ['7', '8'];
const stopBitOptions = ['1', '1.5', '2'];
const parityOptions = [
  { value: 'none', label: 'NONE' },
  { value: 'even', label: 'EVEN' },
  { value: 'odd', label: 'ODD' }
];
const modbusFunctions = [
  { code: '01', label: 'READ_COILS' },
  { code: '02', label: 'READ_DISCRETE_INPUTS' },
  { code: '03', label: 'READ_HOLDING_REGISTERS' },
  { code: '04', label: 'READ_INPUT_REGISTERS' },
  { code: '05', label: 'WRITE_SINGLE_COIL' },
  { code: '06', label: 'WRITE_SINGLE_REGISTER' },
  { code: '0F', label: 'WRITE_MULTIPLE_COILS' },
  { code: '10', label: 'WRITE_MULTIPLE_REGISTERS' }
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

async function loadI18n(lang) {
  const normalized = normalizeLang(lang);
  const candidates = normalized === 'en' ? ['en'] : [normalized, 'en'];

  for (const candidate of candidates) {
    try {
      const response = await fetch(`/i18n/${candidate}.json`, { cache: 'no-store' });
      if (!response.ok) continue;
      const data = await response.json();
      i18n.lang = candidate;
      i18n.bundle = data.INDUSTRIAL_BUS_DEBUGGER || {};
      document.title = t('TITLE', 'Industrial Bus Debugger');
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
        return { canClose: true };
      }
    }
  });

  try {
    const remote = await connection.promise;
    host.remote = remote;
    if (typeof remote.getHostContext === 'function') {
      const context = await remote.getHostContext();
      if (context) {
        await applyHostContext(context);
      }
    }
    if (state.backendStatus === 'ready') notifyHostReady();
  } catch (error) {
    addLogs([{ direction: 'error', protocol: 'Host', summary: 'HOST_CONNECTION_FAILED', detail: localizedErrorMessage(error.message || String(error)) }]);
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
    message: error?.message || String(error || 'Unknown industrial bus debugger error')
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

function labelText(label) {
  return escapeHtml(t(label, label));
}

function formatI18n(template, params = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => params[key] ?? '');
}

function translateLogKey(key, fallback, params = {}) {
  return formatI18n(t(key, fallback), params);
}

function logSummaryText(summary) {
  const value = String(summary || '');
  let match = value.match(/^CAN TX ([0-9A-F]+) DLC=(\d+)$/);
  if (match) return escapeHtml(translateLogKey('LOG_CAN_TX', 'CAN TX {id} DLC={dlc}', { id: match[1], dlc: match[2] }));

  match = value.match(/^CAN RX ([0-9A-F]+) DLC=(\d+)$/);
  if (match) return escapeHtml(translateLogKey('LOG_CAN_RX', 'CAN RX {id} DLC={dlc}', { id: match[1], dlc: match[2] }));

  match = value.match(/^CAN ([0-9A-F]+) filtered$/);
  if (match) return escapeHtml(translateLogKey('LOG_CAN_FILTERED', 'CAN {id} filtered', { id: match[1] }));

  match = value.match(/^RS485 TX (\d+)B$/);
  if (match) return escapeHtml(translateLogKey('LOG_RS485_TX', 'RS485 TX {bytes}B', { bytes: match[1] }));

  match = value.match(/^RS485 RX (\d+)B$/);
  if (match) return escapeHtml(translateLogKey('LOG_RS485_RX', 'RS485 RX {bytes}B', { bytes: match[1] }));

  match = value.match(/^Modbus (RTU|TCP) TX FC([0-9A-F]+)$/);
  if (match) return escapeHtml(translateLogKey('LOG_MODBUS_TX', 'Modbus {protocol} TX FC{functionCode}', { protocol: match[1], functionCode: match[2] }));

  match = value.match(/^Modbus (RTU|TCP) RX FC([0-9A-F]+)$/);
  if (match) return escapeHtml(translateLogKey('LOG_MODBUS_RX', 'Modbus {protocol} RX FC{functionCode}', { protocol: match[1], functionCode: match[2] }));

  return labelText(value);
}

function logDetailText(detail) {
  const value = String(detail || '');
  if (!value) return '';

  let match = value.match(/^(\d+) bytes required$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_BYTES_REQUIRED', '{bytes} bytes required', { bytes: match[1] }));

  match = value.match(/^empty PDU$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_EMPTY_PDU', 'empty PDU'));

  match = value.match(/^RTU frame too short$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_RTU_TOO_SHORT', 'RTU frame too short'));

  match = value.match(/^TCP frame too short$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_TCP_TOO_SHORT', 'TCP frame too short'));

  match = value.match(/^crc=ok$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_CRC_OK', 'crc=ok'));

  match = value.match(/^crc=bad expected (.+)$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_CRC_BAD', 'crc=bad expected {expected}', { expected: match[1] }));

  match = value.match(/^length=ok$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_LENGTH_OK', 'length=ok'));

  match = value.match(/^length=bad header=(\d+) actual=(\d+)$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_LENGTH_BAD', 'length=bad header={header} actual={actual}', { header: match[1], actual: match[2] }));

  match = value.match(/^protocol=(\d+)$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_PROTOCOL', 'protocol={protocol}', { protocol: match[1] }));

  match = value.match(/^filter=pass$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_FILTER_PASS', 'filter=pass'));

  match = value.match(/^filter=skip$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_FILTER_SKIP', 'filter=skip'));

  match = value.match(/^remote frame, raw=(.+)$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_REMOTE_FRAME', 'remote frame, raw={raw}', { raw: match[1] }));

  match = value.match(/^Request timed out: (.+)$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_REQUEST_TIMEOUT', 'Request timed out: {method}', { method: match[1] }));

  match = value.match(/^(\d+) bit\/s, (CAN FD|Classic CAN), (filter=(?:pass|skip))$/);
  if (match) {
    return escapeHtml(translateLogKey('DETAIL_CAN_TX_SETTINGS', '{bitrate} bit/s, {mode}, {filter}', {
      bitrate: match[1],
      mode: t(match[2] === 'CAN FD' ? 'CAN_FD' : 'CLASSIC_CAN', match[2]),
      filter: logDetailPlainText(match[3])
    }));
  }

  match = value.match(/^data=(.+), raw=(.+)$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_DATA_RAW', 'data={data}, raw={raw}', { data: match[1], raw: match[2] }));

  match = value.match(/^ascii="(.*)"$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_ASCII', 'ASCII="{ascii}"', { ascii: match[1] }));

  match = value.match(/^(.+) (\d+), ([^,]+), ascii="(.*)"$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_RS485_TX_SETTINGS', '{port} {baud}, {serial}, ASCII="{ascii}"', { port: match[1], baud: match[2], serial: match[3], ascii: match[4] }));

  match = value.match(/^unit=(\d+), address=(\d+), quantity=(\d+)$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_MODBUS_REQUEST', 'unit={unit}, address={address}, quantity={quantity}', { unit: match[1], address: match[2], quantity: match[3] }));

  match = value.match(/^unit=(\d+), fc=(0x[0-9A-F]+), exception=(0x[0-9A-F]+), (.+)$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_MODBUS_EXCEPTION', 'unit={unit}, fc={functionCode}, exception={exception}, {check}', { unit: match[1], functionCode: match[2], exception: match[3], check: logDetailPlainText(match[4]) }));

  match = value.match(/^unit=(\d+), (.+), byteCount=(\d+), data=([^,]+)(?:, registers=(.+))?$/);
  if (match) {
    return escapeHtml(translateLogKey(match[5] ? 'DETAIL_MODBUS_DATA_REGISTERS' : 'DETAIL_MODBUS_DATA', match[5] ? 'unit={unit}, {check}, byte count={byteCount}, data={data}, registers={registers}' : 'unit={unit}, {check}, byte count={byteCount}, data={data}', {
      unit: match[1],
      check: logDetailPlainText(match[2]),
      byteCount: match[3],
      data: match[4],
      registers: match[5] || ''
    }));
  }

  match = value.match(/^unit=(\d+), (.+), address=(\d+), value=(\d+)$/);
  if (match) return escapeHtml(translateLogKey('DETAIL_MODBUS_ADDRESS_VALUE', 'unit={unit}, {check}, address={address}, value={value}', { unit: match[1], check: logDetailPlainText(match[2]), address: match[3], value: match[4] }));

  return escapeHtml(t(value, value));
}

function logDetailPlainText(detail) {
  const html = logDetailText(detail);
  const element = document.createElement('textarea');
  element.innerHTML = html;
  return element.value;
}

function localizedErrorMessage(message) {
  const value = String(message || '');
  const map = {
    'WebSocket is not connected': 'ERROR_WS_NOT_CONNECTED',
    'Backend reconnecting': 'ERROR_BACKEND_RECONNECTING',
    'Industrial bus request failed': 'ERROR_REQUEST_FAILED',
    'Backend WebSocket connection failed': 'ERROR_BACKEND_WS_FAILED',
    'Clipboard failed': 'ERROR_CLIPBOARD_FAILED'
  };
  return map[value] || value;
}

function now() {
  return new Date().toLocaleTimeString();
}

function addLogs(logs = []) {
  const next = logs.map(log => ({
    id: ++logSeq,
    time: now(),
    direction: log.direction || 'sys',
    protocol: log.protocol || '',
    summary: log.summary || '',
    detail: log.detail || '',
    hex: log.hex || ''
  }));
  state.logs = [...next, ...state.logs].slice(0, 160);
  render();
}

function loadDraft() {
  try {
    const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
    if (!draft || typeof draft !== 'object') return;
    Object.assign(state, {
      ...draft,
      logs: state.logs,
      backendStatus: state.backendStatus,
      backendPid: state.backendPid
    });
  } catch {
    // Ignore invalid persisted draft data.
  }
}

function saveDraft() {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify({
      mode: state.mode,
      ...currentPayload(),
      modbusRequestHex: state.modbusRequestHex
    }));
  } catch {
    // Storage may be unavailable in some browser modes.
  }
}

function optionList(values, selected) {
  return values.map(value => `<option value="${escapeAttr(value)}" ${String(selected) === String(value) ? 'selected' : ''}>${escapeHtml(value)}</option>`).join('');
}

function renderTabs() {
  return `
    <div class="mode-tabs">
      <div class="mode-tab-list" role="tablist" aria-label="${text('PROTOCOL', 'Protocol')}">
        <button type="button" role="tab" aria-selected="${state.mode === 'can'}" data-action="set-mode" data-mode="can" class="${state.mode === 'can' ? 'active' : ''}"><span>${text('CAN', 'CAN')}</span></button>
        <button type="button" role="tab" aria-selected="${state.mode === 'rs485'}" data-action="set-mode" data-mode="rs485" class="${state.mode === 'rs485' ? 'active' : ''}"><span>${text('RS485', 'RS485')}</span></button>
        <button type="button" role="tab" aria-selected="${state.mode === 'modbus'}" data-action="set-mode" data-mode="modbus" class="${state.mode === 'modbus' ? 'active' : ''}"><span>${text('MODBUS', 'Modbus')}</span></button>
      </div>
    </div>
  `;
}

function renderCan() {
  return `
    <div class="workspace-grid debugger-grid">
      <section class="panel form-panel primary-panel">
        <div class="panel-title">${text('CAN_SETTINGS', 'CAN Settings')}</div>
        <div class="field-grid">
          <label class="field"><span>${text('BITRATE', 'Bitrate')}</span><select data-field="canBitrate">${optionList(canBitrates, state.canBitrate)}</select></label>
          <label class="field"><span>${text('FRAME_FORMAT', 'Frame format')}</span><select data-field="canFrameFormat">
            <option value="standard" ${state.canFrameFormat === 'standard' ? 'selected' : ''}>${text('STANDARD_ID', 'Standard ID')}</option>
            <option value="extended" ${state.canFrameFormat === 'extended' ? 'selected' : ''}>${text('EXTENDED_ID', 'Extended ID')}</option>
          </select></label>
          <label class="field"><span>${text('FRAME_TYPE', 'Frame type')}</span><select data-field="canFrameType">
            <option value="data" ${state.canFrameType === 'data' ? 'selected' : ''}>${text('DATA_FRAME', 'Data frame')}</option>
            <option value="remote" ${state.canFrameType === 'remote' ? 'selected' : ''}>${text('REMOTE_FRAME', 'Remote frame')}</option>
          </select></label>
          <label class="check-field"><input type="checkbox" data-field="canFdEnabled" ${state.canFdEnabled ? 'checked' : ''}><span>${text('CAN_FD', 'CAN FD')}</span></label>
        </div>
        <label class="field"><span>${text('FRAME_ID', 'Frame ID')}</span><input type="text" data-field="canFrameId" value="${escapeAttr(state.canFrameId)}" placeholder="123"></label>
        ${state.canFrameType === 'data' ? `
          <label class="field grow"><span>${text('DATA_HEX', 'Data (HEX)')}</span><textarea class="mono body-input" data-field="canPayload" rows="5" placeholder="01 02 03 04">${escapeHtml(state.canPayload)}</textarea></label>
        ` : `
          <label class="field"><span>${text('DLC', 'DLC')}</span><input type="number" min="0" max="${state.canFdEnabled ? 64 : 8}" data-field="canDlc" value="${escapeAttr(state.canDlc)}"></label>
        `}
        <div class="field-grid">
          <label class="field"><span>${text('FILTER_ID', 'Filter ID')}</span><input type="text" data-field="canFilterId" value="${escapeAttr(state.canFilterId)}" placeholder="123"></label>
          <label class="field"><span>${text('FILTER_MASK', 'Filter mask')}</span><input type="text" data-field="canFilterMask" value="${escapeAttr(state.canFilterMask)}" placeholder="7FF"></label>
        </div>
        <div class="actions"><button type="button" class="primary" data-action="can-send">${text('SEND_FRAME', 'Send frame')}</button></div>
      </section>
      <section class="panel form-panel secondary-panel">
        <div class="panel-title">${text('PARSE_TRACE', 'Parse trace')}</div>
        <label class="field grow"><span>${text('TRACE_INPUT', 'Trace input')}</span><textarea class="mono body-input" data-field="canTraceInput" rows="12" placeholder="123#DEADBEEF">${escapeHtml(state.canTraceInput)}</textarea></label>
        <div class="actions"><button type="button" class="primary" data-action="can-parse">${text('PARSE_TRACE', 'Parse trace')}</button></div>
      </section>
      ${renderLogPanel()}
    </div>
  `;
}

function renderRs485() {
  return `
    <div class="workspace-grid debugger-grid">
      <section class="panel form-panel primary-panel">
        <div class="panel-title">${text('RS485_SETTINGS', 'RS485 Settings')}</div>
        <div class="field-grid">
          <label class="field"><span>${text('PORT_LABEL', 'Port')}</span><input type="text" data-field="rs485Port" value="${escapeAttr(state.rs485Port)}" placeholder="COM3"></label>
          <label class="field"><span>${text('BAUD_RATE', 'Baud rate')}</span><select data-field="rs485BaudRate">${optionList(baudRates, state.rs485BaudRate)}</select></label>
          <label class="field"><span>${text('DATA_BITS', 'Data bits')}</span><select data-field="rs485DataBits">${optionList(dataBitOptions, state.rs485DataBits)}</select></label>
          <label class="field"><span>${text('STOP_BITS', 'Stop bits')}</span><select data-field="rs485StopBits">${optionList(stopBitOptions, state.rs485StopBits)}</select></label>
          <label class="field"><span>${text('PARITY', 'Parity')}</span><select data-field="rs485Parity">
            ${parityOptions.map(item => `<option value="${item.value}" ${state.rs485Parity === item.value ? 'selected' : ''}>${text(item.label, item.value)}</option>`).join('')}
          </select></label>
          <label class="field"><span>${text('TX_MODE', 'TX mode')}</span><select data-field="rs485PayloadMode">
            <option value="hex" ${state.rs485PayloadMode === 'hex' ? 'selected' : ''}>${text('HEX', 'HEX')}</option>
            <option value="ascii" ${state.rs485PayloadMode === 'ascii' ? 'selected' : ''}>${text('ASCII', 'ASCII')}</option>
          </select></label>
        </div>
        <label class="check-field"><input type="checkbox" data-field="rs485AppendCrc" ${state.rs485AppendCrc ? 'checked' : ''}><span>${text('APPEND_CRC', 'Append Modbus CRC')}</span></label>
        <label class="field grow"><span>${text('PAYLOAD', 'Payload')}</span><textarea class="mono body-input" data-field="rs485Payload" rows="7">${escapeHtml(state.rs485Payload)}</textarea></label>
        <div class="actions"><button type="button" class="primary" data-action="rs485-send">${text('SEND_RS485', 'Send RS485')}</button></div>
      </section>
      <section class="panel form-panel secondary-panel">
        <div class="panel-title">${text('RECEIVE_INPUT', 'Receive input')}</div>
        <label class="field grow"><span>${text('PAYLOAD', 'Payload')}</span><textarea class="mono body-input" data-field="rs485ReceiveInput" rows="14">${escapeHtml(state.rs485ReceiveInput)}</textarea></label>
        <div class="actions"><button type="button" class="primary" data-action="rs485-rx">${text('RECORD_RX', 'Record RX')}</button></div>
      </section>
      ${renderLogPanel()}
    </div>
  `;
}

function renderModbus() {
  return `
    <div class="workspace-grid debugger-grid">
      <section class="panel form-panel primary-panel">
        <div class="panel-title">${text('MODBUS_SETTINGS', 'Modbus Settings')}</div>
        <div class="field-grid">
          <label class="field"><span>${text('PROTOCOL', 'Protocol')}</span><select data-field="modbusProtocol">
            <option value="rtu" ${state.modbusProtocol === 'rtu' ? 'selected' : ''}>${text('RTU', 'RTU')}</option>
            <option value="tcp" ${state.modbusProtocol === 'tcp' ? 'selected' : ''}>${text('TCP', 'TCP')}</option>
          </select></label>
          ${state.modbusProtocol === 'tcp' ? `<label class="field"><span>${text('TRANSACTION_ID', 'Transaction ID')}</span><input type="number" min="0" max="65535" data-field="modbusTransactionId" value="${escapeAttr(state.modbusTransactionId)}"></label>` : ''}
          <label class="field"><span>${text('UNIT_ID', 'Unit ID')}</span><input type="number" min="0" max="255" data-field="modbusUnitId" value="${escapeAttr(state.modbusUnitId)}"></label>
          <label class="field"><span>${text('FUNCTION', 'Function')}</span><select data-field="modbusFunction">
            ${modbusFunctions.map(fn => `<option value="${fn.code}" ${state.modbusFunction === fn.code ? 'selected' : ''}>FC${fn.code} ${text(fn.label, fn.label)}</option>`).join('')}
          </select></label>
          <label class="field"><span>${text('ADDRESS', 'Address')}</span><input type="number" min="0" max="65535" data-field="modbusAddress" value="${escapeAttr(state.modbusAddress)}"></label>
          <label class="field"><span>${text('QUANTITY', 'Quantity')}</span><input type="number" min="1" max="2000" data-field="modbusQuantity" value="${escapeAttr(state.modbusQuantity)}"></label>
        </div>
        <label class="field grow"><span>${text('WRITE_VALUE', 'Write value bytes')}</span><textarea class="mono body-input compact-body" data-field="modbusWriteValue" rows="4" placeholder="00 01">${escapeHtml(state.modbusWriteValue)}</textarea></label>
        <div class="actions">
          <button type="button" class="primary" data-action="modbus-build">${text('BUILD_REQUEST', 'Build request')}</button>
          <button type="button" data-action="modbus-copy" ${state.modbusRequestHex ? '' : 'disabled'}>${text('COPY_HEX', 'Copy HEX')}</button>
        </div>
        <div class="result-block">
          <div class="result-title">${text('REQUEST_HEX', 'Request HEX')}</div>
          <pre class="mono">${escapeHtml(state.modbusRequestHex || '-')}</pre>
        </div>
      </section>
      <section class="panel form-panel secondary-panel">
        <div class="panel-title">${text('PARSE_RESPONSE', 'Parse response')}</div>
        <label class="field grow"><span>${text('RESPONSE_HEX', 'Response HEX')}</span><textarea class="mono body-input" data-field="modbusResponseHex" rows="14">${escapeHtml(state.modbusResponseHex)}</textarea></label>
        <div class="actions"><button type="button" class="primary" data-action="modbus-parse">${text('PARSE_RESPONSE', 'Parse response')}</button></div>
      </section>
      ${renderLogPanel()}
    </div>
  `;
}

function renderLogPanel() {
  return `
    <section class="panel log-panel">
      <div class="panel-title">
        <span>${text('LOG', 'Log')}</span>
        <button type="button" class="icon-action" title="${text('CLEAR', 'Clear')}" aria-label="${text('CLEAR', 'Clear')}" data-action="clear-logs">×</button>
      </div>
      <div class="log-list">
        ${state.logs.map(log => `
          <div class="log-row ${escapeAttr(log.direction)}">
            <span class="time">${escapeHtml(log.time)}</span>
            <span class="protocol">${escapeHtml(log.protocol)}</span>
            <span class="summary">${logSummaryText(log.summary)}</span>
            ${log.detail ? `<span class="detail">${logDetailText(log.detail)}</span>` : '<span></span>'}
            ${log.hex ? `<code class="hex">${escapeHtml(log.hex)}</code>` : '<span></span>'}
          </div>
        `).join('')}
      </div>
    </section>
  `;
}

function captureScrollState() {
  return {
    workspace: app.querySelector('.debugger-grid')?.scrollTop || 0,
    log: app.querySelector('.log-list')?.scrollTop || 0
  };
}

function restoreScrollState(scrollState) {
  if (!scrollState) return;
  const workspace = app.querySelector('.debugger-grid');
  const logList = app.querySelector('.log-list');
  if (workspace) workspace.scrollTop = scrollState.workspace;
  if (logList) logList.scrollTop = scrollState.log;
}

function render(options = {}) {
  const preserveScroll = options.preserveScroll !== false;
  const scrollState = preserveScroll ? captureScrollState() : null;
  app.innerHTML = `
    ${renderTabs()}
    ${state.mode === 'can' ? renderCan() : state.mode === 'rs485' ? renderRs485() : renderModbus()}
  `;
  restoreScrollState(scrollState);
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

function currentPayload() {
  return {
    canBitrate: state.canBitrate,
    canFrameFormat: state.canFrameFormat,
    canFrameType: state.canFrameType,
    canFrameId: state.canFrameId,
    canPayload: state.canPayload,
    canDlc: state.canDlc,
    canFdEnabled: state.canFdEnabled,
    canFilterId: state.canFilterId,
    canFilterMask: state.canFilterMask,
    canTraceInput: state.canTraceInput,
    rs485Port: state.rs485Port,
    rs485BaudRate: state.rs485BaudRate,
    rs485DataBits: state.rs485DataBits,
    rs485StopBits: state.rs485StopBits,
    rs485Parity: state.rs485Parity,
    rs485PayloadMode: state.rs485PayloadMode,
    rs485Payload: state.rs485Payload,
    rs485AppendCrc: state.rs485AppendCrc,
    rs485ReceiveInput: state.rs485ReceiveInput,
    modbusProtocol: state.modbusProtocol,
    modbusTransactionId: state.modbusTransactionId,
    modbusUnitId: state.modbusUnitId,
    modbusFunction: state.modbusFunction,
    modbusAddress: state.modbusAddress,
    modbusQuantity: state.modbusQuantity,
    modbusWriteValue: state.modbusWriteValue,
    modbusResponseHex: state.modbusResponseHex
  };
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
      pending.reject(new Error(message.error || 'Industrial bus request failed'));
    }
    return;
  }

  if (message.event === 'ready') {
    state.backendStatus = 'ready';
    state.backendPid = Number(message.data?.pid) || 0;
    render();
    notifyHostReady();
  }
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
    render();
  });

  backendWs.addEventListener('error', () => {
    state.backendStatus = 'error';
    render();
    notifyHostError(new Error('Backend WebSocket connection failed'));
  });
}

async function runAction(method) {
  try {
    const result = await request(method, currentPayload());
    if (result.requestHex !== undefined) {
      state.modbusRequestHex = result.requestHex || '';
    }
    saveDraft();
    addLogs(result.logs || []);
  } catch (error) {
    addLogs([{ direction: 'error', protocol: 'Backend', summary: 'BACKEND_ERROR', detail: localizedErrorMessage(error.message || 'Backend error') }]);
  }
}

async function copyModbusRequest() {
  if (!state.modbusRequestHex) {
    addLogs([{ direction: 'error', protocol: 'Modbus', summary: 'NO_REQUEST' }]);
    return;
  }

  try {
    await navigator.clipboard?.writeText(state.modbusRequestHex);
    addLogs([{ direction: 'sys', protocol: 'Modbus', summary: 'COPIED', hex: state.modbusRequestHex }]);
  } catch (error) {
    addLogs([{ direction: 'error', protocol: 'Modbus', summary: 'CLIPBOARD_FAILED', detail: localizedErrorMessage(error.message || 'Clipboard failed'), hex: state.modbusRequestHex }]);
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

  updateFromInputs();
  const action = target.dataset.action;

  if (action === 'set-mode') {
    state.mode = target.dataset.mode || 'can';
    saveDraft();
    render({ preserveScroll: false });
  }
  if (action === 'can-send') void runAction('can.send');
  if (action === 'can-parse') void runAction('can.parseTrace');
  if (action === 'rs485-send') void runAction('rs485.send');
  if (action === 'rs485-rx') void runAction('rs485.recordRx');
  if (action === 'modbus-build') void runAction('modbus.buildRequest');
  if (action === 'modbus-parse') void runAction('modbus.parseResponse');
  if (action === 'modbus-copy') void copyModbusRequest();
  if (action === 'clear-logs') {
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
  await connectHost();
  applyTheme(host.context.theme);
  render();
  void loadI18n(host.context.lang);
  connectBackend();
}

void bootstrap();
