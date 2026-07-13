export type AilyPixelFormat = 'rgb565' | 'rgb332' | 'mono';

export enum AilyPixelFormatCode {
  Rgb565Le = 1,
  Rgb332 = 2,
  Mono1Xbm = 3,
}

export interface MonoConversionOptions {
  threshold?: number;
  dither?: boolean;
  invert?: boolean;
}

export interface AilyVideoFileOptions {
  width: number;
  height: number;
  pixelFormat: AilyPixelFormat;
  fpsNumerator: number;
  fpsDenominator: number;
  loop?: boolean;
}

export interface AilyVideoHeaderInfo {
  magic: 'AILY';
  version: number;
  headerSize: number;
  pixelFormat: AilyPixelFormatCode;
  flags: number;
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  frameCount: number;
  frameSize: number;
  dataOffset: number;
  dataSize: number;
  reserved: number;
}

export const AILY_VIDEO_HEADER_SIZE = 40;
export const AILY_VIDEO_VERSION = 1;
export const AILY_FLAG_LOOP = 0x01;
export const AILY_MAX_DATA_SIZE = 0xffff_ffff;

const PIXEL_FORMAT_CODES: Record<AilyPixelFormat, AilyPixelFormatCode> = {
  rgb565: AilyPixelFormatCode.Rgb565Le,
  rgb332: AilyPixelFormatCode.Rgb332,
  mono: AilyPixelFormatCode.Mono1Xbm,
};

const FORMAT_BY_CODE: Partial<Record<AilyPixelFormatCode, AilyPixelFormat>> = {
  [AilyPixelFormatCode.Rgb565Le]: 'rgb565',
  [AilyPixelFormatCode.Rgb332]: 'rgb332',
  [AilyPixelFormatCode.Mono1Xbm]: 'mono',
};

export function getPixelFormatCode(format: AilyPixelFormat): AilyPixelFormatCode {
  assertPixelFormat(format);
  return PIXEL_FORMAT_CODES[format];
}

export function getPixelFormatFromCode(code: number): AilyPixelFormat | null {
  return FORMAT_BY_CODE[code as AilyPixelFormatCode] || null;
}

export function getFrameSize(width: number, height: number, format: AilyPixelFormat): number {
  assertIntegerInRange(width, 1, 0xffff, 'width');
  assertIntegerInRange(height, 1, 0xffff, 'height');
  assertPixelFormat(format);

  const rowSize = format === 'mono' ? Math.ceil(width / 8) : width * (format === 'rgb565' ? 2 : 1);
  const frameSize = rowSize * height;
  if (!Number.isSafeInteger(frameSize) || frameSize > AILY_MAX_DATA_SIZE) {
    throw new Error('单帧数据大小超出 AILY 文件格式限制');
  }
  return frameSize;
}

/**
 * 将 RGBA 像素按从上到下、每行从左到右的顺序转换为一帧 AILY 像素数据。
 * MONO 使用 XBM 位序：每行水平排列，最左侧像素写入字节 bit 0。
 */
export function packRgbaFrame(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  format: AilyPixelFormat,
  monoOptions: MonoConversionOptions = {},
): Uint8Array {
  const pixelCount = width * height;
  if (!Number.isSafeInteger(pixelCount) || rgba.byteLength < pixelCount * 4) {
    throw new Error('RGBA 帧数据长度与目标尺寸不匹配');
  }

  if (format === 'mono') {
    return packMonoFrame(rgba, width, height, monoOptions);
  }

  const packed = new Uint8Array(getFrameSize(width, height, format));
  for (let pixelIndex = 0, sourceIndex = 0; pixelIndex < pixelCount; pixelIndex++, sourceIndex += 4) {
    const alpha = rgba[sourceIndex + 3];
    const red = compositeOnBlack(rgba[sourceIndex], alpha);
    const green = compositeOnBlack(rgba[sourceIndex + 1], alpha);
    const blue = compositeOnBlack(rgba[sourceIndex + 2], alpha);

    if (format === 'rgb332') {
      packed[pixelIndex] = (red & 0xe0) | ((green & 0xe0) >> 3) | (blue >> 6);
      continue;
    }

    const pixel = ((red & 0xf8) << 8) | ((green & 0xfc) << 3) | (blue >> 3);
    const targetIndex = pixelIndex * 2;
    packed[targetIndex] = pixel & 0xff;
    packed[targetIndex + 1] = pixel >> 8;
  }
  return packed;
}

export function buildAilyVideoFile(
  frames: readonly Uint8Array[],
  options: AilyVideoFileOptions,
): Uint8Array {
  if (frames.length === 0) {
    throw new Error('至少需要一帧数据');
  }

  assertIntegerInRange(options.fpsNumerator, 1, AILY_MAX_DATA_SIZE, 'fpsNumerator');
  assertIntegerInRange(options.fpsDenominator, 1, AILY_MAX_DATA_SIZE, 'fpsDenominator');
  assertIntegerInRange(frames.length, 1, AILY_MAX_DATA_SIZE, 'frameCount');

  const frameSize = getFrameSize(options.width, options.height, options.pixelFormat);
  for (let index = 0; index < frames.length; index++) {
    if (frames[index].byteLength !== frameSize) {
      throw new Error(`第 ${index + 1} 帧大小错误：应为 ${frameSize} 字节`);
    }
  }

  const dataSize = frameSize * frames.length;
  if (!Number.isSafeInteger(dataSize) || dataSize > AILY_MAX_DATA_SIZE) {
    throw new Error('所有帧数据总大小超出 AILY 文件格式限制');
  }

  const file = new Uint8Array(AILY_VIDEO_HEADER_SIZE + dataSize);
  file.set([0x41, 0x49, 0x4c, 0x59], 0);
  const view = new DataView(file.buffer);
  view.setUint8(4, AILY_VIDEO_VERSION);
  view.setUint8(5, AILY_VIDEO_HEADER_SIZE);
  view.setUint8(6, getPixelFormatCode(options.pixelFormat));
  view.setUint8(7, options.loop === false ? 0 : AILY_FLAG_LOOP);
  view.setUint16(8, options.width, true);
  view.setUint16(10, options.height, true);
  view.setUint32(12, options.fpsNumerator, true);
  view.setUint32(16, options.fpsDenominator, true);
  view.setUint32(20, frames.length, true);
  view.setUint32(24, frameSize, true);
  view.setUint32(28, AILY_VIDEO_HEADER_SIZE, true);
  view.setUint32(32, dataSize, true);
  view.setUint32(36, 0, true);

  let offset = AILY_VIDEO_HEADER_SIZE;
  for (const frame of frames) {
    file.set(frame, offset);
    offset += frameSize;
  }
  return file;
}

export function parseAilyVideoHeader(file: ArrayBuffer | Uint8Array): AilyVideoHeaderInfo {
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(file);
  if (bytes.byteLength < AILY_VIDEO_HEADER_SIZE) {
    throw new Error('文件长度不足 40 字节');
  }
  if (bytes[0] !== 0x41 || bytes[1] !== 0x49 || bytes[2] !== 0x4c || bytes[3] !== 0x59) {
    throw new Error('文件 magic 不是 AILY');
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header: AilyVideoHeaderInfo = {
    magic: 'AILY',
    version: view.getUint8(4),
    headerSize: view.getUint8(5),
    pixelFormat: view.getUint8(6) as AilyPixelFormatCode,
    flags: view.getUint8(7),
    width: view.getUint16(8, true),
    height: view.getUint16(10, true),
    fpsNumerator: view.getUint32(12, true),
    fpsDenominator: view.getUint32(16, true),
    frameCount: view.getUint32(20, true),
    frameSize: view.getUint32(24, true),
    dataOffset: view.getUint32(28, true),
    dataSize: view.getUint32(32, true),
    reserved: view.getUint32(36, true),
  };

  if (header.version !== AILY_VIDEO_VERSION) throw new Error(`不支持的 AILY 版本：${header.version}`);
  if (header.headerSize < AILY_VIDEO_HEADER_SIZE) throw new Error('AILY 文件头长度错误');
  if (header.dataOffset < header.headerSize) throw new Error('AILY 帧数据偏移错误');
  if (header.fpsNumerator === 0 || header.fpsDenominator === 0) throw new Error('AILY FPS 分数无效');
  if (header.frameCount === 0) throw new Error('AILY 文件不包含帧数据');
  if ((header.flags & ~AILY_FLAG_LOOP) !== 0) throw new Error('AILY 文件包含未知播放标志');

  const format = getPixelFormatFromCode(header.pixelFormat);
  if (!format) throw new Error(`不支持的像素格式：${header.pixelFormat}`);
  const expectedFrameSize = getFrameSize(header.width, header.height, format);
  if (header.frameSize !== expectedFrameSize) throw new Error('AILY 单帧大小与像素格式不匹配');
  const expectedDataSize = header.frameSize * header.frameCount;
  if (!Number.isSafeInteger(expectedDataSize) || expectedDataSize > AILY_MAX_DATA_SIZE) {
    throw new Error('AILY 帧数据总大小溢出');
  }
  if (header.dataSize !== expectedDataSize) throw new Error('AILY 帧数据总大小不匹配');
  if (bytes.byteLength < header.dataOffset + header.dataSize) throw new Error('AILY 文件帧数据不完整');

  return header;
}

export function unpackFrameToRgba(
  frame: Uint8Array,
  width: number,
  height: number,
  format: AilyPixelFormat,
): Uint8ClampedArray {
  const expectedSize = getFrameSize(width, height, format);
  if (frame.byteLength < expectedSize) {
    throw new Error('预览帧数据不完整');
  }

  const rgba = new Uint8ClampedArray(width * height * 4);
  const rowSize = Math.ceil(width / 8);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pixelIndex = y * width + x;
      const target = pixelIndex * 4;
      let red: number;
      let green: number;
      let blue: number;

      if (format === 'mono') {
        const value = (frame[y * rowSize + (x >> 3)] >> (x & 7)) & 0x01 ? 255 : 0;
        red = green = blue = value;
      } else if (format === 'rgb332') {
        const value = frame[pixelIndex];
        red = Math.round(((value >> 5) & 0x07) * 255 / 7);
        green = Math.round(((value >> 2) & 0x07) * 255 / 7);
        blue = Math.round((value & 0x03) * 255 / 3);
      } else {
        const source = pixelIndex * 2;
        const value = frame[source] | (frame[source + 1] << 8);
        const red5 = (value >> 11) & 0x1f;
        const green6 = (value >> 5) & 0x3f;
        const blue5 = value & 0x1f;
        red = (red5 << 3) | (red5 >> 2);
        green = (green6 << 2) | (green6 >> 4);
        blue = (blue5 << 3) | (blue5 >> 2);
      }

      rgba[target] = red;
      rgba[target + 1] = green;
      rgba[target + 2] = blue;
      rgba[target + 3] = 255;
    }
  }
  return rgba;
}

export function getOutputExtension(format: AilyPixelFormat, isVideoSource: boolean): string {
  return `.${format}${isVideoSource ? 'v' : ''}`;
}

function packMonoFrame(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  options: MonoConversionOptions,
): Uint8Array {
  const rawThreshold = Number(options.threshold);
  const threshold = Number.isFinite(rawThreshold)
    ? Math.min(255, Math.max(0, Math.round(rawThreshold)))
    : 128;
  const invert = options.invert === true;
  const packed = new Uint8Array(getFrameSize(width, height, 'mono'));
  const rowSize = Math.ceil(width / 8);

  if (!options.dither) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const source = (y * width + x) * 4;
        const gray = getGray(rgba, source);
        const bit = (gray >= threshold) !== invert ? 1 : 0;
        if (bit) packed[y * rowSize + (x >> 3)] |= 1 << (x & 7);
      }
    }
    return packed;
  }

  const currentError = new Float32Array(width + 2);
  const nextError = new Float32Array(width + 2);
  for (let y = 0; y < height; y++) {
    nextError.fill(0);
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      const oldValue = Math.min(255, Math.max(0, getGray(rgba, source) + currentError[x + 1]));
      const newValue = oldValue >= threshold ? 255 : 0;
      const bit = (newValue === 255) !== invert ? 1 : 0;
      if (bit) packed[y * rowSize + (x >> 3)] |= 1 << (x & 7);

      const error = oldValue - newValue;
      currentError[x + 2] += error * 7 / 16;
      nextError[x] += error * 3 / 16;
      nextError[x + 1] += error * 5 / 16;
      nextError[x + 2] += error / 16;
    }
    currentError.set(nextError);
  }
  return packed;
}

function getGray(rgba: Uint8Array | Uint8ClampedArray, sourceIndex: number): number {
  const alpha = rgba[sourceIndex + 3];
  const red = compositeOnBlack(rgba[sourceIndex], alpha);
  const green = compositeOnBlack(rgba[sourceIndex + 1], alpha);
  const blue = compositeOnBlack(rgba[sourceIndex + 2], alpha);
  return (red * 299 + green * 587 + blue * 114) / 1000;
}

function compositeOnBlack(channel: number, alpha: number): number {
  return alpha === 255 ? channel : Math.round(channel * alpha / 255);
}

function assertIntegerInRange(value: number, min: number, max: number, name: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min} 到 ${max} 的整数`);
  }
}

function assertPixelFormat(format: unknown): asserts format is AilyPixelFormat {
  if (format !== 'rgb565' && format !== 'rgb332' && format !== 'mono') {
    throw new Error(`不支持的像素格式：${String(format)}`);
  }
}
