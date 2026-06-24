'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const FONT_EXTENSIONS = new Set(['.ttf', '.otf', '.ttc', '.otc', '.woff', '.woff2']);
const WINDOWS_FONT_KEYS = [
  'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts',
  'HKCU\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts'
];

function asError(error) {
  if (!error) return '';
  if (error instanceof Error) return error.message || String(error);
  return String(error);
}

function stableId(parts) {
  return crypto.createHash('sha1').update(parts.filter(Boolean).join('\0')).digest('hex').slice(0, 16);
}

function isFontFile(filePath) {
  return FONT_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function normalizeFontName(name) {
  return String(name || '')
    .replace(/^@+/, '')
    .replace(/\s*\((?:TrueType|OpenType|Type 1|PostScript|Font Collection)\)\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitDisplayNames(rawName) {
  const normalized = normalizeFontName(rawName);
  if (!normalized) return [];
  return normalized
    .split(/\s*&\s*/g)
    .map(part => normalizeFontName(part))
    .filter(Boolean);
}

function windowsFontsDir() {
  return path.join(process.env.WINDIR || process.env.SystemRoot || 'C:\\Windows', 'Fonts');
}

function resolveWindowsFontPath(value) {
  const raw = String(value || '').trim().replace(/^"|"$/g, '');
  if (!raw) return '';
  if (path.isAbsolute(raw)) return raw;
  return path.join(windowsFontsDir(), raw);
}

function createFontRecord(displayName, filePath, source) {
  const resolvedPath = path.resolve(filePath);
  const fileName = path.basename(resolvedPath);
  const family = normalizeFontName(displayName || path.basename(fileName, path.extname(fileName)));
  if (!family || !isFontFile(resolvedPath)) return null;

  return {
    id: stableId([family, resolvedPath]),
    family,
    fullName: family,
    fileName,
    extension: path.extname(fileName).toLowerCase(),
    source,
    path: resolvedPath
  };
}

function parseWindowsRegistryFonts(text) {
  const records = [];

  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*(.+?)\s+REG_\w+\s+(.+?)\s*$/);
    if (!match) continue;

    const names = splitDisplayNames(match[1]);
    const filePath = resolveWindowsFontPath(match[2]);
    if (!filePath || !fs.existsSync(filePath)) continue;

    for (const name of names) {
      const record = createFontRecord(name, filePath, 'windows-registry');
      if (record) records.push(record);
    }
  }

  return records;
}

function queryWindowsRegistryFonts() {
  const records = [];

  for (const key of WINDOWS_FONT_KEYS) {
    const result = spawnSync('reg', ['query', key], {
      encoding: 'buffer',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024
    });
    if (result.error || result.status !== 0) continue;
    records.push(...parseWindowsRegistryFonts(decodeWindowsCommandOutput(result.stdout)));
  }

  return records;
}

function decodeWindowsCommandOutput(buffer) {
  if (!Buffer.isBuffer(buffer)) return String(buffer || '');

  const candidates = [];
  for (const encoding of ['gbk', 'utf-8']) {
    try {
      candidates.push(new TextDecoder(encoding).decode(buffer));
    } catch {
      // Ignore unsupported encodings.
    }
  }
  if (!candidates.length) return buffer.toString('utf8');

  return candidates.sort((a, b) => replacementScore(a) - replacementScore(b))[0];
}

function replacementScore(text) {
  return (String(text).match(/\uFFFD/g) || []).length;
}

function parseFcListFonts(text) {
  const records = [];

  for (const line of String(text || '').split(/\r?\n/)) {
    const [filePath, families = ''] = line.split('\t');
    if (!filePath || !fs.existsSync(filePath) || !isFontFile(filePath)) continue;
    const names = families.split(',').map(name => normalizeFontName(name)).filter(Boolean);
    for (const name of names.length ? names : [path.basename(filePath, path.extname(filePath))]) {
      const record = createFontRecord(name, filePath, 'fontconfig');
      if (record) records.push(record);
    }
  }

  return records;
}

function queryFontConfigFonts() {
  const result = spawnSync('fc-list', ['--format=%{file}\\t%{family}\\n'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.error || result.status !== 0) return [];
  return parseFcListFonts(result.stdout);
}

function collectFontFiles(root, records, source, depth = 0) {
  if (!root || depth > 6) return;

  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const filePath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      collectFontFiles(filePath, records, source, depth + 1);
      continue;
    }
    if (!entry.isFile() || !isFontFile(filePath)) continue;
    const record = createFontRecord(path.basename(entry.name, path.extname(entry.name)), filePath, source);
    if (record) records.push(record);
  }
}

function fallbackFontRoots() {
  if (process.platform === 'win32') {
    return [windowsFontsDir()];
  }

  if (process.platform === 'darwin') {
    return [
      '/System/Library/Fonts',
      '/Library/Fonts',
      path.join(os.homedir(), 'Library', 'Fonts')
    ];
  }

  return [
    '/usr/share/fonts',
    '/usr/local/share/fonts',
    path.join(os.homedir(), '.fonts'),
    path.join(os.homedir(), '.local', 'share', 'fonts')
  ];
}

function scanFallbackFontDirs() {
  const records = [];
  for (const root of fallbackFontRoots()) {
    collectFontFiles(root, records, 'font-directory');
  }
  return records;
}

function publicFontRecord(record) {
  return {
    id: record.id,
    family: record.family,
    fullName: record.fullName,
    fileName: record.fileName,
    extension: record.extension,
    source: record.source
  };
}

function dedupeAndSortFonts(records) {
  const byKey = new Map();
  const preferredPaths = new Set(
    records
      .filter(record => record?.source !== 'font-directory')
      .map(record => path.resolve(record.path).toLowerCase())
  );

  for (const record of records) {
    if (!record || !fs.existsSync(record.path)) continue;
    if (record.source === 'font-directory' && preferredPaths.has(path.resolve(record.path).toLowerCase())) {
      continue;
    }
    const key = `${record.family.toLowerCase()}\0${record.path.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, record);
  }

  return Array.from(byKey.values()).sort((a, b) => (
    a.family.localeCompare(b.family, undefined, { sensitivity: 'base' }) ||
    a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' })
  ));
}

function discoverInstalledFonts() {
  const records = [];
  if (process.platform === 'win32') {
    records.push(...queryWindowsRegistryFonts());
  }

  records.push(...queryFontConfigFonts());
  records.push(...scanFallbackFontDirs());

  return dedupeAndSortFonts(records);
}

function createU8g2FontGeneratorCore(options = {}) {
  const startedAt = Date.now();
  const sendEvent = typeof options.sendEvent === 'function' ? options.sendEvent : () => undefined;
  let fontsCache = null;
  let fontsById = new Map();

  function refreshFonts() {
    fontsCache = discoverInstalledFonts();
    fontsById = new Map(fontsCache.map(font => [font.id, font]));
    sendEvent('fonts.refreshed', { count: fontsCache.length });
    return fontsCache;
  }

  function listFonts(params = {}) {
    if (!fontsCache || params.refresh) refreshFonts();
    return {
      fonts: fontsCache.map(publicFontRecord),
      count: fontsCache.length
    };
  }

  function getFontById(id) {
    if (!fontsCache) refreshFonts();
    return fontsById.get(String(id || '')) || null;
  }

  function status() {
    if (!fontsCache) refreshFonts();
    return {
      state: 'ready',
      pid: process.pid,
      uptimeMs: Date.now() - startedAt,
      fontCount: fontsCache.length,
      platform: process.platform
    };
  }

  async function executeAction(message = {}) {
    const action = message.action || message.method;
    const params = message.params || message.data || message;

    switch (action) {
      case 'status':
        return status();
      case 'fonts.list':
      case 'fonts':
        return listFonts(params);
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
    listFonts,
    getFontById,
    executeAction,
    shutdown,
    cleanup
  };
}

module.exports = {
  asError,
  createU8g2FontGeneratorCore,
  publicFontRecord
};
