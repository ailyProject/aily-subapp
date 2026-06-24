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
const TEXT_OPTIONS = [
  { id: '1000', key: 'TEXT_COMMON_1000', count: 1000 },
  { id: '2000', key: 'TEXT_COMMON_2000', count: 2000 },
  { id: '3000', key: 'TEXT_COMMON_3000', count: 3000 },
  { id: '5000', key: 'TEXT_COMMON_5000', count: 5000 },
  { id: '7000', key: 'TEXT_COMMON_7000', count: 7000 },
  { id: '9000', key: 'TEXT_COMMON_9000', count: 9000 },
  { id: 'custom', key: 'TEXT_CUSTOM', count: 0 }
];
const COMMON_TIERS = [1000, 2000, 3000, 5000, 7000, 9000];
const commonTextSegments = new Map();
const DRAFT_KEY = 'u8g2-font-generator.ui.draft.v1';
const DRAFT_FIELDS = ['fontId', 'fontSize', 'symbolName', 'textPreset', 'customText'];

const state = {
  backendStatus: 'connecting',
  backendPid: 0,
  fonts: [],
  fontId: '',
  fontSize: 16,
  symbolName: '',
  textPreset: '1000',
  customText: '你好，Aily Blockly',
  logs: [],
  generated: null,
  errorMessage: '',
  progress: {
    active: false,
    current: 0,
    total: 0,
    label: ''
  }
};

let backendWs = null;
let requestSeq = 0;
let logSeq = 0;
let commonTextAssetsPromise = null;
const pendingRequests = new Map();
const loadedFontFaces = new Map();

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
      i18n.bundle = data.U8G2_FONT_GENERATOR || {};
      document.title = t('TITLE', 'U8g2 Font Generator');
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
          connected: backendWs?.readyState === WebSocket.OPEN,
          draftSaved: true
        };
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
    if (state.backendStatus === 'ready') {
      notifyHostReady();
    }
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
    message: error?.message || String(error || 'U8g2 Font Generator error')
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
    state.fontSize = clampFontSize(state.fontSize);
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
    if (message.ok) {
      pending.resolve(message.result);
    } else {
      pending.reject(new Error(message.error || 'U8g2 font generator request failed'));
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
      await loadFonts();
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

async function loadFonts() {
  const result = await request('fonts.list', {}, 60000);
  state.fonts = Array.isArray(result.fonts) ? result.fonts : [];
  if (!state.fontId || !state.fonts.some(font => font.id === state.fontId)) {
    state.fontId = chooseDefaultFontId(state.fonts);
  }
  pushLog('system', 'FONTS_READY', String(state.fonts.length));
  saveDraft();
}

function chooseDefaultFontId(fonts) {
  const preferred = fonts.find(font => /microsoft yahei|simhei|simsun|noto sans cjk|source han|pingfang|hiragino|arial unicode|segoe ui/i.test(font.family));
  return (preferred || fonts[0])?.id || '';
}

function clampFontSize(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 16;
  return Math.min(96, Math.max(6, Math.round(parsed)));
}

function getSelectedFont() {
  return state.fonts.find(font => font.id === state.fontId) || null;
}

function fontOptions() {
  let fonts = state.fonts.slice(0, 700);
  const selected = getSelectedFont();
  if (selected && !fonts.some(font => font.id === selected.id)) {
    fonts = [selected, ...fonts];
  }
  return fonts;
}

function uniqueCharacters(textValue) {
  const seen = new Set();
  const chars = [];
  for (const char of Array.from(String(textValue || ''))) {
    const codePoint = char.codePointAt(0);
    if (!codePoint || codePoint < 32 && char !== ' ') continue;
    if (seen.has(char)) continue;
    seen.add(char);
    chars.push(char);
  }
  return chars;
}

function commonTierFilesForCount(count) {
  return COMMON_TIERS.filter(tier => tier <= count);
}

async function loadCommonTextAssets() {
  if (commonTextAssetsPromise) return commonTextAssetsPromise;

  commonTextAssetsPromise = Promise.all(COMMON_TIERS.map(async tier => {
    const response = await fetch(`/assets/${tier}.txt`, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Failed to load assets/${tier}.txt`);
    }
    commonTextSegments.set(tier, await response.text());
  }));

  return commonTextAssetsPromise;
}

function getCommonCharacters(count) {
  const textValue = commonTierFilesForCount(count)
    .map(tier => commonTextSegments.get(tier) || '')
    .join('');
  return uniqueCharacters(textValue).slice(0, count);
}

function selectedCharacters() {
  if (state.textPreset === 'custom') {
    return uniqueCharacters(state.customText);
  }
  const option = TEXT_OPTIONS.find(item => item.id === state.textPreset) || TEXT_OPTIONS[0];
  return getCommonCharacters(option.count);
}

async function selectedCharactersForGenerate() {
  if (state.textPreset === 'custom') {
    return selectedCharacters();
  }

  await loadCommonTextAssets();
  const option = TEXT_OPTIONS.find(item => item.id === state.textPreset) || TEXT_OPTIONS[0];
  const chars = selectedCharacters();
  if (chars.length < option.count) {
    throw new Error(`Common text assets only provide ${chars.length}/${option.count} unique characters`);
  }
  return chars;
}

function normalizeSymbolName(value, font, fontSize) {
  const base = String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (base && /^[a-zA-Z_]/.test(base)) return base;

  const fontPart = String(font?.family || 'local_font')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32) || 'local_font';
  return `u8g2_font_${fontPart}_${fontSize}`;
}

function cssString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function progressPercent() {
  if (!state.progress.active || !state.progress.total) return 0;
  const percent = Math.floor((state.progress.current / state.progress.total) * 100);
  return Math.max(0, Math.min(state.progress.current < state.progress.total ? 99 : 100, percent));
}

function updateFromInputs() {
  for (const element of app.querySelectorAll('[data-field]')) {
    const field = element.dataset.field;
    if (!field) continue;
    state[field] = element.value;
  }
  state.fontSize = clampFontSize(state.fontSize);
}

function renderFontOptions() {
  const fonts = fontOptions();
  if (!fonts.length) {
    return `<option value="">${escapeHtml(t('FONT', 'Font'))}</option>`;
  }
  return fonts.map(font => `
    <option value="${escapeAttr(font.id)}" ${font.id === state.fontId ? 'selected' : ''} style="font-family:${escapeAttr(cssString(font.family))}">
      ${escapeHtml(font.family)} (${escapeHtml(font.fileName)})
    </option>
  `).join('');
}

function renderTextOptions() {
  return TEXT_OPTIONS.map(option => `
    <option value="${escapeAttr(option.id)}" ${option.id === state.textPreset ? 'selected' : ''}>
      ${text(option.key, option.id)}
    </option>
  `).join('');
}

function renderMetrics() {
  const generated = state.generated;
  const metrics = generated?.metadata || null;
  const items = [
    ['CHAR_COUNT', metrics ? String(metrics.characterCount) : '-'],
    ['GLYPH_COUNT', metrics ? String(metrics.glyphCount) : '-'],
    ['FLASH_SIZE', metrics ? formatBytes(metrics.flashBytes) : '-'],
    ['RLE_BITS', metrics ? `${metrics.rleBits.zero}/${metrics.rleBits.one}` : '-'],
    ['SOURCE_SIZE', metrics ? formatBytes(metrics.sourceBytes) : '-'],
    ['PACKAGE_SIZE', metrics ? formatBytes(metrics.packageBytes) : '-'],
    ['FONT_SIZE', `${state.fontSize}px`]
  ];

  return items.map(([key, value]) => `
    <div class="metric">
      <span class="metric-label">${text(key, key)}</span>
      <span class="metric-value">${escapeHtml(value)}</span>
    </div>
  `).join('');
}

function render() {
  const font = getSelectedFont();
  const generated = state.generated;
  const progress = progressPercent();
  const resultText = generated
    ? generated.sourcePreview
    : (state.errorMessage || t('NO_RESULT', 'No generated font yet'));

  app.innerHTML = `
    <section class="topbar">
      <div class="title-stack">
        <h1>${text('TITLE', 'U8g2 Font Generator')}</h1>
        <p>${text('DESCRIPTION', 'Generate compact U8g2 font source from local fonts.')}</p>
      </div>
      <span class="status ${state.backendStatus === 'ready' ? 'ready' : ''}">
        ${escapeHtml(t(`STATUS_${state.backendStatus.toUpperCase()}`, state.backendStatus))}
      </span>
    </section>

    <section class="workspace">
      <div class="panel settings-panel">
        <div class="panel-title">${text('FONT', 'Font')}</div>
        <label class="field">
          <span>${text('FONT', 'Font')}</span>
          <select data-field="fontId" style="font-family:${escapeAttr(font ? cssString(font.family) : 'inherit')}">${renderFontOptions()}</select>
        </label>
        <div class="field-row">
          <label class="field">
            <span>${text('SYMBOL_NAME', 'Symbol name')}</span>
            <input type="text" data-field="symbolName" value="${escapeAttr(state.symbolName)}" placeholder="${escapeAttr(normalizeSymbolName('', font, state.fontSize))}">
          </label>
          <label class="field">
            <span>${text('FONT_SIZE', 'Font size')}</span>
            <input type="number" min="6" max="96" step="1" data-field="fontSize" value="${escapeAttr(state.fontSize)}">
          </label>
        </div>
        <label class="field">
          <span>${text('TEXT_SET', 'Characters')}</span>
          <select data-field="textPreset">${renderTextOptions()}</select>
        </label>
        <label class="field ${state.textPreset === 'custom' ? '' : 'hidden'}">
          <span>${text('CUSTOM_TEXT', 'Custom characters')}</span>
          <textarea data-field="customText">${escapeHtml(state.customText)}</textarea>
        </label>
      </div>

      <div class="panel output-panel">
        <div class="panel-title">${text('RESULT', 'Result')}</div>
        <div class="output-grid">
          <div class="metrics-grid">${renderMetrics()}</div>
          <pre class="source-preview mono ${state.errorMessage && !generated ? 'error' : ''}">${escapeHtml(resultText)}</pre>
        </div>
      </div>
    </section>

    <section class="footer-actions" style="--progress:${progress}%">
      <span class="progress-label">${escapeHtml(state.progress.label || (generated ? t('DONE', 'Done') : ''))}</span>
      <div class="progress-track ${state.progress.active ? '' : 'hidden'}"><div class="progress-fill"></div></div>
      <button type="button" data-action="clear">${text('CLEAR', 'Clear')}</button>
      <button type="button" class="primary" data-action="generate" ${state.progress.active || !state.fontId ? 'disabled' : ''}>${text('GENERATE', 'Generate')}</button>
      <button type="button" class="primary" data-action="download" ${generated ? '' : 'disabled'}>${text('DOWNLOAD', 'Download source')}</button>
    </section>
  `;
}

async function loadFontFace(font) {
  if (!font?.url || typeof FontFace !== 'function') {
    return font?.family ? cssString(font.family) : 'sans-serif';
  }

  if (loadedFontFaces.has(font.id)) {
    return cssString(loadedFontFaces.get(font.id));
  }

  const family = `u8g2_local_${font.id}`;
  const face = new FontFace(family, `url(${cssString(font.url)})`);
  try {
    await face.load();
    document.fonts.add(face);
    loadedFontFaces.set(font.id, family);
    return cssString(family);
  } catch {
    return cssString(font.family);
  }
}

function nextFrame() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

function renderGlyph(char, codePoint, fontCssFamily, fontSize) {
  const canvas = renderGlyph.canvas || document.createElement('canvas');
  renderGlyph.canvas = canvas;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  const fontSpec = `${fontSize}px ${fontCssFamily}`;
  context.font = fontSpec;
  const metrics = context.measureText(char);
  const ascent = Math.ceil(metrics.actualBoundingBoxAscent || fontSize * 0.82);
  const descent = Math.ceil(metrics.actualBoundingBoxDescent || fontSize * 0.22);
  const leftBearing = Math.ceil(metrics.actualBoundingBoxLeft || 0);
  const rightBearing = Math.ceil(metrics.actualBoundingBoxRight || metrics.width || fontSize);
  const advance = Math.max(1, Math.ceil(metrics.width || fontSize * 0.5));
  const pad = Math.max(8, Math.ceil(fontSize * 0.8));
  const originX = pad + Math.max(0, leftBearing);
  const baselineY = pad + ascent + 2;
  const canvasWidth = Math.min(255, Math.max(16, Math.ceil(originX + rightBearing + pad)));
  const canvasHeight = Math.min(255, Math.max(16, Math.ceil(pad + ascent + descent + pad + 4)));

  canvas.width = canvasWidth;
  canvas.height = canvasHeight;
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = fontSpec;
  context.textBaseline = 'alphabetic';
  context.fillStyle = '#000';
  context.fillText(char, originX, baselineY);

  const image = context.getImageData(0, 0, canvas.width, canvas.height).data;
  const threshold = 72;
  let left = canvas.width;
  let right = -1;
  let top = canvas.height;
  let bottom = -1;

  for (let y = 0; y < canvas.height; y += 1) {
    for (let x = 0; x < canvas.width; x += 1) {
      const alpha = image[(y * canvas.width + x) * 4 + 3];
      if (alpha <= threshold) continue;
      if (x < left) left = x;
      if (x > right) right = x;
      if (y < top) top = y;
      if (y > bottom) bottom = y;
    }
  }

  if (right < left || bottom < top) {
    return {
      char,
      codePoint,
      width: 0,
      height: 0,
      xOffset: 0,
      yOffset: 0,
      advance,
      rows: []
    };
  }

  const width = right - left + 1;
  const height = bottom - top + 1;
  const rows = [];
  for (let y = top; y <= bottom; y += 1) {
    const row = [];
    for (let x = left; x <= right; x += 1) {
      row.push(image[(y * canvas.width + x) * 4 + 3] > threshold ? 1 : 0);
    }
    rows.push(row);
  }

  return {
    char,
    codePoint,
    width,
    height,
    xOffset: left - originX,
    yOffset: baselineY - bottom - 1,
    advance,
    rows
  };
}

function unsignedBitWidth(values) {
  const max = maxOf(values, 0);
  for (let bits = 1; bits <= 8; bits += 1) {
    if (max <= (1 << bits) - 1) return bits;
  }
  throw new Error(`Glyph metric exceeds 255: ${max}`);
}

function signedBitWidth(values) {
  const minValue = minOf(values, 0);
  const maxValue = maxOf(values, 0);
  for (let bits = 2; bits <= 8; bits += 1) {
    const min = -(1 << (bits - 1));
    const max = (1 << (bits - 1)) - 1;
    if (minValue >= min && maxValue <= max) return bits;
  }
  throw new Error(`Glyph signed metric is outside int8 range: ${minValue}..${maxValue}`);
}

class BitWriter {
  constructor(bytes = []) {
    this.bytes = bytes;
    this.bitPos = 0;
  }

  writeBits(count, value) {
    for (let index = 0; index < count; index += 1) {
      if (this.bitPos === 0) this.bytes.push(0);
      if ((value >> index) & 1) {
        this.bytes[this.bytes.length - 1] |= 1 << this.bitPos;
      }
      this.bitPos = (this.bitPos + 1) & 7;
    }
  }

  flush() {
    this.bitPos = 0;
  }
}

function writeUnsigned(writer, bitCount, value) {
  if (value < 0 || value > (1 << bitCount) - 1) {
    throw new Error(`Unsigned value ${value} does not fit in ${bitCount} bits`);
  }
  writer.writeBits(bitCount, value);
}

function writeSigned(writer, bitCount, value) {
  const min = -(1 << (bitCount - 1));
  const max = (1 << (bitCount - 1)) - 1;
  if (value < min || value > max) {
    throw new Error(`Signed value ${value} does not fit in ${bitCount} bits`);
  }
  writer.writeBits(bitCount, value + (1 << (bitCount - 1)));
}

function buildRunPairs(glyph) {
  const pairs = [];
  let isOne = false;
  let length = 0;
  const runs = [];

  for (const row of glyph.rows) {
    for (const bit of row) {
      const one = bit === 1;
      if (one !== isOne) {
        runs.push(length);
        isOne = one;
        length = 0;
      }
      length += 1;
    }
  }

  runs.push(length);
  if (runs.length % 2 === 1) runs.push(0);
  for (let index = 0; index < runs.length; index += 2) {
    pairs.push([runs[index], runs[index + 1]]);
  }
  return pairs;
}

function writeRle(writer, glyph, rleBits0, rleBits1) {
  const max0 = (1 << rleBits0) - 1;
  const max1 = (1 << rleBits1) - 1;
  let first = true;
  let last0 = 0;
  let last1 = 1;

  function writePair(a, b) {
    if (!first && last0 === a && last1 === b) {
      writer.writeBits(1, 1);
      return;
    }
    if (!first) writer.writeBits(1, 0);
    writer.writeBits(rleBits0, a);
    writer.writeBits(rleBits1, b);
    first = false;
    last0 = a;
    last1 = b;
  }

  function prepare(a, b) {
    let zeros = a;
    let ones = b;
    while (zeros > max0) {
      writePair(max0, 0);
      zeros -= max0;
    }
    while (ones > max1) {
      writePair(zeros, max1);
      zeros = 0;
      ones -= max1;
    }
    if (zeros !== 0 || ones !== 0) {
      writePair(zeros, ones);
    }
  }

  for (const [zeros, ones] of buildRunPairs(glyph)) {
    prepare(zeros, ones);
  }
  writer.writeBits(1, 0);
}

function encodeGlyph(glyph, params, rleBits0, rleBits1) {
  const bytes = [];
  const codePoint = glyph.codePoint;
  let sizeIndex;

  if (codePoint <= 0xff) {
    bytes.push(codePoint & 0xff, 0);
    sizeIndex = 1;
  } else {
    bytes.push((codePoint >> 8) & 0xff, codePoint & 0xff, 0);
    sizeIndex = 2;
  }

  const writer = new BitWriter(bytes);
  writeUnsigned(writer, params.bitcntW, glyph.width);
  writeUnsigned(writer, params.bitcntH, glyph.height);
  writeSigned(writer, params.bitcntX, glyph.xOffset);
  writeSigned(writer, params.bitcntY, glyph.yOffset);
  writeSigned(writer, params.bitcntD, glyph.advance);
  if (glyph.width > 0 && glyph.height > 0) {
    writeRle(writer, glyph, rleBits0, rleBits1);
  }
  writer.flush();

  if (bytes.length > 255) {
    throw new Error(`Glyph U+${codePoint.toString(16).toUpperCase()} is ${bytes.length} bytes; reduce font size`);
  }

  bytes[sizeIndex] = bytes.length;
  return bytes;
}

function selectRleBits(glyphs, params) {
  let best = { zero: 3, one: 3, bytes: Number.POSITIVE_INFINITY };
  for (let zero = 2; zero <= 7; zero += 1) {
    for (let one = 2; one <= 7; one += 1) {
      let total = 0;
      try {
        for (const glyph of glyphs) {
          total += encodeGlyph(glyph, params, zero, one).length;
        }
      } catch {
        continue;
      }
      if (total < best.bytes) {
        best = { zero, one, bytes: total };
      }
    }
  }
  if (!Number.isFinite(best.bytes)) {
    throw new Error('No RLE parameter set can keep every glyph within 255 bytes');
  }
  return best;
}

function wordBytes(value) {
  return [(value >> 8) & 0xff, value & 0xff];
}

function appendBytes(target, source) {
  for (let index = 0; index < source.length; index += 1) {
    target.push(source[index]);
  }
}

function maxOf(values, fallback = 0, mapper = value => value) {
  let result = fallback;
  for (const value of values) {
    const next = mapper(value);
    if (next > result) result = next;
  }
  return result;
}

function minOf(values, fallback = 0, mapper = value => value) {
  let result = fallback;
  for (const value of values) {
    const next = mapper(value);
    if (next < result) result = next;
  }
  return result;
}

function signedByte(value) {
  return value < 0 ? 256 + value : value;
}

function createU8g2FontBytes(glyphs) {
  const sorted = [...glyphs].sort((a, b) => a.codePoint - b.codePoint);
  const params = {
    bitcntW: unsignedBitWidth(sorted.map(glyph => glyph.width)),
    bitcntH: unsignedBitWidth(sorted.map(glyph => glyph.height)),
    bitcntX: signedBitWidth(sorted.map(glyph => glyph.xOffset)),
    bitcntY: signedBitWidth(sorted.map(glyph => glyph.yOffset)),
    bitcntD: signedBitWidth(sorted.map(glyph => glyph.advance))
  };
  const rleBits = selectRleBits(sorted, params);
  const lowGlyphs = sorted.filter(glyph => glyph.codePoint <= 0xff);
  const highGlyphs = sorted.filter(glyph => glyph.codePoint > 0xff);
  const lowBytes = [];
  const offsets = new Map();

  for (const glyph of lowGlyphs) {
    offsets.set(glyph.codePoint, lowBytes.length);
    appendBytes(lowBytes, encodeGlyph(glyph, params, rleBits.zero, rleBits.one));
  }
  lowBytes.push(0, 0);

  const highBlocks = [];
  for (let index = 0; index < highGlyphs.length; index += 101) {
    const blockGlyphs = highGlyphs.slice(index, index + 101);
    const blockBytes = [];
    for (const glyph of blockGlyphs) {
      appendBytes(blockBytes, encodeGlyph(glyph, params, rleBits.zero, rleBits.one));
    }
    highBlocks.push({
      lastCodePoint: blockGlyphs[blockGlyphs.length - 1]?.codePoint || 0xffff,
      bytes: blockBytes
    });
  }

  const unicodeStart = lowBytes.length;
  const lookupTable = [];
  if (highBlocks.length) {
    const tableSize = (highBlocks.length + 1) * 4;
    lookupTable.push(...wordBytes(tableSize), ...wordBytes(highBlocks[0].lastCodePoint));
    for (let index = 1; index < highBlocks.length; index += 1) {
      lookupTable.push(...wordBytes(highBlocks[index - 1].bytes.length), ...wordBytes(highBlocks[index].lastCodePoint));
    }
    lookupTable.push(...wordBytes(highBlocks[highBlocks.length - 1].bytes.length), 0xff, 0xff);
  } else {
    lookupTable.push(0, 0, 0xff, 0xff);
  }

  const highBytes = [];
  appendBytes(highBytes, lookupTable);
  for (const block of highBlocks) appendBytes(highBytes, block.bytes);
  highBytes.push(0, 0);

  const maxWidth = maxOf(sorted, 0, glyph => glyph.width);
  const maxHeight = maxOf(sorted, 0, glyph => glyph.height);
  const minX = minOf(sorted, 0, glyph => glyph.xOffset);
  const minY = minOf(sorted, 0, glyph => glyph.yOffset);
  const ascentA = glyphAscent(sorted.find(glyph => glyph.codePoint === 65)) || maxOf(sorted, 0, glyphAscent);
  const descentG = glyphDescent(sorted.find(glyph => glyph.codePoint === 103)) || maxOf(sorted, 0, glyphDescent);
  const ascentPara = glyphAscent(sorted.find(glyph => glyph.codePoint === 40)) || ascentA;
  const descentPara = glyphDescent(sorted.find(glyph => glyph.codePoint === 41)) || descentG;
  const upperAOffset = offsets.get(65) || 0;
  const lowerAOffset = offsets.get(97) || 0;

  const header = [
    Math.min(sorted.length, 255),
    0,
    rleBits.zero,
    rleBits.one,
    params.bitcntW,
    params.bitcntH,
    params.bitcntX,
    params.bitcntY,
    params.bitcntD,
    maxWidth,
    maxHeight,
    signedByte(minX),
    signedByte(minY),
    Math.min(ascentA, 255),
    Math.min(descentG, 255),
    Math.min(ascentPara, 255),
    Math.min(descentPara, 255),
    ...wordBytes(upperAOffset),
    ...wordBytes(lowerAOffset),
    ...wordBytes(unicodeStart)
  ];

  const bytes = [];
  appendBytes(bytes, header);
  appendBytes(bytes, lowBytes);
  appendBytes(bytes, highBytes);

  return {
    bytes,
    rleBits,
    params,
    maxWidth,
    maxHeight,
    minX,
    minY
  };
}

function glyphAscent(glyph) {
  if (!glyph) return 0;
  return Math.max(0, glyph.yOffset + glyph.height);
}

function glyphDescent(glyph) {
  if (!glyph) return 0;
  return Math.max(0, -glyph.yOffset);
}

function createCSource(symbolName, metadata, bytes) {
  const lines = [];
  lines.push('/*');
  lines.push(`  Fontname: ${metadata.fontFamily}`);
  lines.push(`  Size: ${metadata.fontSize}px`);
  lines.push(`  Glyphs: ${metadata.glyphCount}/${metadata.characterCount}`);
  lines.push(`  Flash bytes: ${metadata.flashBytes}`);
  lines.push('  Generated by Aily U8g2 Font Generator');
  lines.push('*/');
  lines.push('#include <stdint.h>');
  lines.push('#ifndef U8G2_FONT_SECTION');
  lines.push('#define U8G2_FONT_SECTION(name)');
  lines.push('#endif');
  lines.push('');
  lines.push(`const uint8_t ${symbolName}[${bytes.length}] U8G2_FONT_SECTION("${symbolName}") = {`);
  for (let index = 0; index < bytes.length; index += 16) {
    const chunk = bytes.slice(index, index + 16).map(byte => `0x${byte.toString(16).padStart(2, '0')}`);
    lines.push(`  ${chunk.join(', ')}${index + 16 < bytes.length ? ',' : ''}`);
  }
  lines.push('};');
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function createHeader(symbolName) {
  return [
    '#pragma once',
    '#include <stdint.h>',
    '',
    `extern const uint8_t ${symbolName}[];`,
    ''
  ].join('\n');
}

function bitmapRowToHex(row) {
  if (!row.length) return '';
  const bytes = [];
  let value = 0;
  for (let index = 0; index < row.length; index += 1) {
    if (row[index]) value |= 1 << (7 - (index % 8));
    if (index % 8 === 7) {
      bytes.push(value);
      value = 0;
    }
  }
  if (row.length % 8 !== 0) bytes.push(value);
  return bytes.map(byte => byte.toString(16).padStart(2, '0').toUpperCase()).join('');
}

function createBdf(symbolName, metadata, glyphs) {
  const maxWidth = maxOf(glyphs, 0, glyph => glyph.width);
  const maxHeight = maxOf(glyphs, 0, glyph => glyph.height);
  const minX = minOf(glyphs, 0, glyph => glyph.xOffset);
  const minY = minOf(glyphs, 0, glyph => glyph.yOffset);
  const ascent = maxOf(glyphs, 0, glyphAscent);
  const descent = maxOf(glyphs, 0, glyphDescent);
  const lines = [
    'STARTFONT 2.1',
    `FONT ${symbolName}`,
    `SIZE ${metadata.fontSize} 75 75`,
    `FONTBOUNDINGBOX ${maxWidth} ${maxHeight} ${minX} ${minY}`,
    'STARTPROPERTIES 2',
    `FONT_ASCENT ${ascent}`,
    `FONT_DESCENT ${descent}`,
    'ENDPROPERTIES',
    `CHARS ${glyphs.length}`
  ];

  for (const glyph of glyphs) {
    lines.push(`STARTCHAR U+${glyph.codePoint.toString(16).toUpperCase().padStart(4, '0')}`);
    lines.push(`ENCODING ${glyph.codePoint}`);
    lines.push(`SWIDTH ${Math.round(glyph.advance * 1000 / Math.max(1, metadata.fontSize))} 0`);
    lines.push(`DWIDTH ${glyph.advance} 0`);
    lines.push(`BBX ${glyph.width} ${glyph.height} ${glyph.xOffset} ${glyph.yOffset}`);
    lines.push('BITMAP');
    for (const row of glyph.rows) lines.push(bitmapRowToHex(row));
    lines.push('ENDCHAR');
  }

  lines.push('ENDFONT');
  return `${lines.join('\n')}\n`;
}

function createReadme(symbolName, metadata) {
  return [
    `# ${symbolName}`,
    '',
    `Font: ${metadata.fontFamily}`,
    `Size: ${metadata.fontSize}px`,
    `Characters: ${metadata.characterCount}`,
    `Glyphs: ${metadata.glyphCount}`,
    `Flash bytes: ${metadata.flashBytes}`,
    '',
    'Arduino usage:',
    '',
    '```cpp',
    `#include "${symbolName}.h"`,
    '',
    'void drawText(U8G2 &u8g2) {',
    `  u8g2.setFont(${symbolName});`,
    '  u8g2.drawUTF8(0, 16, "你好");',
    '}',
    '```',
    ''
  ].join('\n');
}

function crc32(bytes) {
  const table = crc32.table || (crc32.table = createCrc32Table());
  let crc = -1;
  for (const byte of bytes) {
    crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

function dosDateTime(date = new Date()) {
  const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const day = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  return { time, day };
}

function pushUint16(bytes, value) {
  bytes.push(value & 0xff, (value >> 8) & 0xff);
}

function pushUint32(bytes, value) {
  bytes.push(value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff, (value >> 24) & 0xff);
}

function createZip(files) {
  const encoder = new TextEncoder();
  const local = [];
  const central = [];
  let offset = 0;
  const { time, day } = dosDateTime();

  for (const file of files) {
    const nameBytes = encoder.encode(file.name);
    const contentBytes = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    const checksum = crc32(contentBytes);
    const header = [];
    pushUint32(header, 0x04034b50);
    pushUint16(header, 20);
    pushUint16(header, 0x0800);
    pushUint16(header, 0);
    pushUint16(header, time);
    pushUint16(header, day);
    pushUint32(header, checksum);
    pushUint32(header, contentBytes.length);
    pushUint32(header, contentBytes.length);
    pushUint16(header, nameBytes.length);
    pushUint16(header, 0);
    appendBytes(local, header);
    appendBytes(local, nameBytes);
    appendBytes(local, contentBytes);

    const centralHeader = [];
    pushUint32(centralHeader, 0x02014b50);
    pushUint16(centralHeader, 20);
    pushUint16(centralHeader, 20);
    pushUint16(centralHeader, 0x0800);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, time);
    pushUint16(centralHeader, day);
    pushUint32(centralHeader, checksum);
    pushUint32(centralHeader, contentBytes.length);
    pushUint32(centralHeader, contentBytes.length);
    pushUint16(centralHeader, nameBytes.length);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint16(centralHeader, 0);
    pushUint32(centralHeader, 0);
    pushUint32(centralHeader, offset);
    appendBytes(central, centralHeader);
    appendBytes(central, nameBytes);

    offset += header.length + nameBytes.length + contentBytes.length;
  }

  const end = [];
  pushUint32(end, 0x06054b50);
  pushUint16(end, 0);
  pushUint16(end, 0);
  pushUint16(end, files.length);
  pushUint16(end, files.length);
  pushUint32(end, central.length);
  pushUint32(end, local.length);
  pushUint16(end, 0);

  return new Blob([
    new Uint8Array(local),
    new Uint8Array(central),
    new Uint8Array(end)
  ], { type: 'application/zip' });
}

async function runGenerate() {
  updateFromInputs();
  const font = getSelectedFont();
  if (!font) throw new Error('Select a font first');

  const rawChars = await selectedCharactersForGenerate();
  const chars = rawChars.filter(char => char.codePointAt(0) <= 0xffff);
  if (!chars.length) throw new Error('No supported characters selected');

  state.progress = { active: true, current: 0, total: chars.length + 3, label: t('GENERATING', 'Generating') };
  state.generated = null;
  state.errorMessage = '';
  pushLog('request', 'GENERATION_STARTED', `${chars.length}`);
  render();

  const fontCssFamily = await loadFontFace(font);
  const glyphs = [];
  for (let index = 0; index < chars.length; index += 1) {
    const char = chars[index];
    glyphs.push(renderGlyph(char, char.codePointAt(0), fontCssFamily, state.fontSize));
    if (index % 24 === 0 || index === chars.length - 1) {
      state.progress.current = index + 1;
      state.progress.label = `${t('GENERATING', 'Generating')} ${index + 1}/${chars.length}`;
      render();
      await nextFrame();
    }
  }

  const symbolName = normalizeSymbolName(state.symbolName, font, state.fontSize);
  state.progress.current = chars.length + 1;
  state.progress.label = t('ENCODING_FONT', 'Encoding font');
  render();
  await nextFrame();

  const encoded = createU8g2FontBytes(glyphs);
  const metadata = {
    symbolName,
    fontFamily: font.family,
    fontFile: font.fileName,
    fontSize: state.fontSize,
    characterCount: rawChars.length,
    glyphCount: glyphs.length,
    skippedCharacters: rawChars.length - glyphs.length,
    flashBytes: encoded.bytes.length,
    rleBits: encoded.rleBits,
    glyphFieldBits: encoded.params,
    generatedAt: new Date().toISOString()
  };
  const source = createCSource(symbolName, metadata, encoded.bytes);
  const header = createHeader(symbolName);
  const bdf = createBdf(symbolName, metadata, glyphs);
  const readme = createReadme(symbolName, metadata);
  const metadataText = `${JSON.stringify({ ...metadata, sourceBytes: source.length }, null, 2)}\n`;
  state.progress.current = chars.length + 2;
  state.progress.label = t('PACKAGING_SOURCE', 'Packaging source');
  render();
  await nextFrame();

  const zip = createZip([
    { name: `${symbolName}.c`, content: source },
    { name: `${symbolName}.h`, content: header },
    { name: `${symbolName}.bdf`, content: bdf },
    { name: 'metadata.json', content: metadataText },
    { name: 'README.md', content: readme }
  ]);

  metadata.sourceBytes = new TextEncoder().encode(source).length;
  metadata.packageBytes = zip.size;
  state.generated = {
    symbolName,
    source,
    header,
    bdf,
    zip,
    sourcePreview: source.slice(0, 6000),
    metadata
  };
  state.progress = { active: false, current: chars.length + 3, total: chars.length + 3, label: t('DONE', 'Done') };
  pushLog('response', 'GENERATION_DONE', `${glyphs.length} / ${formatBytes(encoded.bytes.length)}`);
  saveDraft();
  render();
}

async function saveBlobWithPicker(blob, fileName) {
  if (typeof window.showSaveFilePicker !== 'function') {
    return false;
  }

  const handle = await window.showSaveFilePicker({
    suggestedName: fileName,
    types: [
      {
        description: 'ZIP package',
        accept: {
          'application/zip': ['.zip']
        }
      }
    ]
  });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
  return true;
}

function downloadBlobWithAnchor(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.dispatchEvent(new MouseEvent('click', {
    bubbles: true,
    cancelable: true,
    view: window
  }));

  setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 60000);
}

async function downloadGenerated() {
  if (!state.generated) return;
  const fileName = `${state.generated.symbolName}.zip`;
  const blob = state.generated.zip;

  try {
    const saved = await saveBlobWithPicker(blob, fileName);
    if (!saved) {
      downloadBlobWithAnchor(blob, fileName);
    }
    pushLog('system', 'DOWNLOAD_READY', fileName);
  } catch (error) {
    if (error?.name === 'AbortError') return;
    downloadBlobWithAnchor(blob, fileName);
    pushLog('system', 'DOWNLOAD_READY', fileName);
  }
}

app.addEventListener('input', event => {
  if (event.target.matches('[data-field]')) {
    const field = event.target.dataset.field;
    updateFromInputs();
    saveDraft();
    if (field === 'fontSize' || field === 'customText') {
      render();
    }
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

  if (action === 'generate') {
    void runGenerate().catch(error => {
      const message = error.message || String(error);
      state.progress = { active: false, current: 0, total: 0, label: t('GENERATION_FAILED', 'Generation failed') };
      state.generated = null;
      state.errorMessage = message;
      pushLog('error', 'GENERATION_FAILED', message);
      notifyHostError(error);
      render();
    });
  }

  if (action === 'download') {
    void downloadGenerated().catch(error => {
      pushLog('error', 'GENERATION_FAILED', error.message || String(error));
      notifyHostError(error);
      render();
    });
  }

  if (action === 'clear') {
    state.generated = null;
    state.errorMessage = '';
    state.progress = { active: false, current: 0, total: 0, label: '' };
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
