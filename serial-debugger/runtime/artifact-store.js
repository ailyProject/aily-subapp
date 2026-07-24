'use strict';

const fs = require('fs');
const path = require('path');
const {
  DEFAULT_PREVIEW_BYTES,
  DEFAULT_RESULT_MAX_BYTES,
  jsonByteLength,
  positiveInteger,
  utf8Preview
} = require('./result-budget');

const DEFAULT_READ_BYTES = 64 * 1024;
const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_SCAN_BYTES = 1024 * 1024;
const MAX_SCAN_BYTES = 16 * 1024 * 1024;

class SerialArtifactStore {
  constructor(options = {}) {
    if (!options.rootDir) throw new Error('Artifact store rootDir is required');
    this.rootDir = path.resolve(String(options.rootDir));
    this.artifacts = new Map();
    fs.mkdirSync(this.rootDir, { recursive: true });
  }

  register(descriptor = {}) {
    const artifactId = String(descriptor.artifactId || descriptor.id || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(artifactId)) {
      throw new Error(`Invalid artifact id: ${artifactId || '(empty)'}`);
    }
    const filePath = this.resolveManagedPath(descriptor.path || descriptor.fileName);
    const existing = this.artifacts.get(artifactId);
    const artifact = {
      artifactId,
      type: String(descriptor.type || existing?.type || 'serial-artifact'),
      contentType: String(descriptor.contentType || existing?.contentType || 'application/octet-stream'),
      path: filePath,
      createdAt: Number(descriptor.createdAt || existing?.createdAt || Date.now()),
      firstSeq: Number(descriptor.firstSeq ?? existing?.firstSeq ?? 0),
      lastSeq: Number(descriptor.lastSeq ?? existing?.lastSeq ?? 0)
    };
    this.artifacts.set(artifactId, artifact);
    return this.info(artifactId);
  }

  update(artifactId, patch = {}) {
    const current = this.requireArtifact(artifactId);
    return this.register({
      ...current,
      ...patch,
      artifactId: current.artifactId,
      path: current.path
    });
  }

  list() {
    return Array.from(this.artifacts.keys()).map(artifactId => this.info(artifactId));
  }

  info(artifactId) {
    const artifact = this.requireArtifact(artifactId);
    let size = 0;
    let modifiedAt = 0;
    try {
      const stat = fs.statSync(artifact.path);
      size = stat.size;
      modifiedAt = stat.mtimeMs;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    return {
      ...artifact,
      size,
      modifiedAt
    };
  }

  async read(options = {}) {
    const artifact = this.requireArtifact(options.artifactId);
    const offset = Math.max(0, Number(options.offset) || 0);
    const maxBytes = positiveInteger(options.maxBytes, DEFAULT_READ_BYTES, MAX_READ_BYTES);
    const handle = await fs.promises.open(artifact.path, 'r');
    try {
      const stat = await handle.stat();
      const length = Math.max(0, Math.min(maxBytes, stat.size - offset));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = length
        ? await handle.read(buffer, 0, length, offset)
        : { bytesRead: 0 };
      const content = buffer.subarray(0, bytesRead);
      const nextOffset = offset + bytesRead;
      return {
        artifactId: artifact.artifactId,
        contentType: artifact.contentType,
        offset,
        nextOffset,
        returnedBytes: bytesRead,
        size: stat.size,
        hasMore: nextOffset < stat.size,
        encoding: 'utf8',
        text: content.toString('utf8')
      };
    } finally {
      await handle.close();
    }
  }

  async search(options = {}) {
    const artifact = this.requireArtifact(options.artifactId);
    const query = String(options.query ?? options.contains ?? '');
    if (!query) throw createArtifactError('INVALID_ARTIFACT_QUERY', 'Artifact search query cannot be empty');
    if (query.length > 500) {
      throw createArtifactError('INVALID_ARTIFACT_QUERY', 'Artifact search query exceeds 500 characters');
    }
    const maxScanBytes = positiveInteger(options.maxScanBytes, DEFAULT_SCAN_BYTES, MAX_SCAN_BYTES);
    const limit = positiveInteger(options.limit, 20, 200);
    const regexMode = options.regex === true;
    let matcher;
    if (regexMode) {
      try {
        const expression = new RegExp(query, String(options.flags || '').replace(/[^imsu]/g, ''));
        matcher = line => expression.test(line);
      } catch (error) {
        throw createArtifactError('INVALID_ARTIFACT_QUERY', `Invalid regular expression: ${error.message}`);
      }
    } else {
      const needle = options.caseSensitive === true ? query : query.toLowerCase();
      matcher = line => (options.caseSensitive === true ? line : line.toLowerCase()).includes(needle);
    }

    const handle = await fs.promises.open(artifact.path, 'r');
    try {
      const stat = await handle.stat();
      const scanBytes = Math.min(stat.size, maxScanBytes);
      const buffer = Buffer.alloc(scanBytes);
      const { bytesRead } = scanBytes
        ? await handle.read(buffer, 0, scanBytes, 0)
        : { bytesRead: 0 };
      const lines = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/);
      const matches = [];
      let byteOffset = 0;
      for (let index = 0; index < lines.length && matches.length < limit; index += 1) {
        const line = lines[index];
        if (matcher(line)) {
          const preview = utf8Preview(line, DEFAULT_PREVIEW_BYTES);
          matches.push({
            line: index + 1,
            offset: byteOffset,
            text: preview.value,
            truncated: preview.truncated
          });
        }
        byteOffset += Buffer.byteLength(line, 'utf8') + 1;
      }
      const result = {
        artifactId: artifact.artifactId,
        query,
        regex: regexMode,
        scannedBytes: bytesRead,
        size: stat.size,
        scanTruncated: bytesRead < stat.size,
        count: matches.length,
        limit,
        matches
      };
      result.returnedBytes = jsonByteLength(result);
      while (result.returnedBytes > DEFAULT_RESULT_MAX_BYTES && result.matches.length) {
        result.matches.pop();
        result.count = result.matches.length;
        result.truncated = true;
        result.returnedBytes = jsonByteLength(result);
      }
      return result;
    } finally {
      await handle.close();
    }
  }

  requireArtifact(artifactId) {
    const id = String(artifactId || '');
    const artifact = this.artifacts.get(id);
    if (!artifact) {
      throw createArtifactError('ARTIFACT_NOT_FOUND', `Unknown serial artifact: ${id || '(empty)'}`, {
        artifactId: id
      });
    }
    return artifact;
  }

  resolveManagedPath(filePath) {
    if (!filePath) throw new Error('Artifact path is required');
    const resolved = path.resolve(this.rootDir, String(filePath));
    const relative = path.relative(this.rootDir, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('Artifact path must stay inside the runtime session directory');
    }
    return resolved;
  }
}

function createArtifactError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

module.exports = {
  DEFAULT_READ_BYTES,
  MAX_READ_BYTES,
  SerialArtifactStore
};
