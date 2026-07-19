import { createFile, DataStream } from 'mp4box';
import {
  AILY_VIDEO_HEADER_SIZE,
  buildAilyVideoFile,
  getFrameSize,
  packRgbaFrame,
  type AilyPixelFormat,
  type MonoConversionOptions,
} from './aily-video-format';
import type {
  VideoConversionDoneMessage,
  VideoConversionErrorMessage,
  VideoConversionProgressMessage,
  VideoConversionRequest,
  VideoConversionResult,
  VideoConversionStage,
} from './video-converter.types';
import {
  createMp4DecodeChunks,
  submitMp4DecodeChunks,
} from './mp4-decode-scheduler';

const MICROSECONDS_PER_SECOND = 1_000_000;
const MAX_DIMENSION = 4096;
const MAX_FRAMES = 10_000;
const MAX_FPS = 240;
const FPS_PRECISION = 1000;
const MAX_OUTPUT_BYTES = 256 * 1024 * 1024;
const VIDEO_DECODE_MAX_QUEUE_SIZE = 64;
const VIDEO_DECODE_QUEUE_POLL_MS = 10;

interface ConversionOptions {
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  requestedMaxFrames: number;
  maxFramesApplied: number;
  frameLimitReduced: boolean;
  frameSize: number;
  pixelFormat: AilyPixelFormat;
  loop: boolean;
  monoOptions: MonoConversionOptions;
}

interface SourceDescriptor {
  kind: 'image' | 'mp4';
  decoderType: string;
  label: string;
  sourceType: string;
}

interface Mp4VideoData {
  track: any;
  samples: any[];
}

class VideoConversionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VideoConversionError';
  }
}

class PackedFrameRenderer {
  private readonly canvas: OffscreenCanvas;
  private readonly context: OffscreenCanvasRenderingContext2D;

  constructor(
    private readonly width: number,
    private readonly height: number,
    private readonly pixelFormat: AilyPixelFormat,
    private readonly monoOptions: MonoConversionOptions,
  ) {
    this.canvas = new OffscreenCanvas(width, height);
    const context = this.canvas.getContext('2d', { willReadFrequently: true });
    if (!context) {
      throw new VideoConversionError('CANVAS_UNAVAILABLE', '无法创建离屏画布');
    }
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    this.context = context;
  }

  render(frame: CanvasImageSource): Uint8Array {
    this.context.globalCompositeOperation = 'source-over';
    this.context.fillStyle = '#000000';
    this.context.fillRect(0, 0, this.width, this.height);
    this.context.drawImage(frame, 0, 0, this.width, this.height);

    const rgba = this.context.getImageData(0, 0, this.width, this.height).data;
    return packRgbaFrame(
      rgba,
      this.width,
      this.height,
      this.pixelFormat,
      this.monoOptions,
    );
  }
}

function postProgress(
  requestId: number,
  stage: VideoConversionStage,
  progress: number,
  current?: number,
  total?: number,
): void {
  const message: VideoConversionProgressMessage = {
    type: 'progress',
    requestId,
    stage,
    progress: Math.min(1, Math.max(0, progress)),
  };
  if (current !== undefined) message.current = current;
  if (total !== undefined) message.total = total;
  self.postMessage(message);
}

function postError(requestId: number, error: unknown): void {
  const conversionError = error instanceof VideoConversionError ? error : null;
  const message: VideoConversionErrorMessage = {
    type: 'error',
    requestId,
    code: conversionError?.code || 'CONVERSION_FAILED',
    message: error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unknown conversion error',
  };
  self.postMessage(message);
}

function postDone(requestId: number, result: VideoConversionResult): void {
  const message: VideoConversionDoneMessage = {
    type: 'done',
    requestId,
    result,
  };
  const workerScope = self as unknown as {
    postMessage(message: VideoConversionDoneMessage, transfer: Transferable[]): void;
  };
  workerScope.postMessage(message, [result.fileBuffer]);
}

function createDecodeProgressReporter(requestId: number, total: number): (current: number) => void {
  let lastReported = -1;
  const reportStep = Math.max(1, Math.floor(total / 100));

  return (current: number) => {
    if (current !== total && current - lastReported < reportStep) return;
    lastReported = current;
    postProgress(
      requestId,
      'decoding',
      0.1 + 0.8 * Math.min(1, current / total),
      current,
      total,
    );
  };
}

function validateInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new VideoConversionError(
      'INVALID_REQUEST',
      `${name} 必须是 ${min}～${max} 的整数`,
    );
  }
  return value;
}

function normalizeMonoOptions(options: MonoConversionOptions | null | undefined): MonoConversionOptions {
  const rawThreshold = Number(options?.threshold);
  return {
    threshold: Number.isFinite(rawThreshold)
      ? Math.min(255, Math.max(0, Math.round(rawThreshold)))
      : 128,
    dither: options?.dither === true,
    invert: options?.invert === true,
  };
}

function greatestCommonDivisor(a: number, b: number): number {
  while (b !== 0) {
    [a, b] = [b, a % b];
  }
  return a;
}

function fpsToFraction(value: number): { numerator: number; denominator: number } {
  if (!Number.isFinite(value) || value < 0.001 || value > MAX_FPS) {
    throw new VideoConversionError('INVALID_REQUEST', `FPS must be between 0.001 and ${MAX_FPS}`);
  }
  const scaled = Math.round(value * FPS_PRECISION);
  const divisor = greatestCommonDivisor(scaled, FPS_PRECISION);
  return {
    numerator: scaled / divisor,
    denominator: FPS_PRECISION / divisor,
  };
}

function normalizeConversionOptions(request: VideoConversionRequest): ConversionOptions {
  const width = validateInteger(request.width, 1, MAX_DIMENSION, '宽度');
  const height = validateInteger(request.height, 1, MAX_DIMENSION, '高度');
  const { numerator: fpsNumerator, denominator: fpsDenominator } = fpsToFraction(request.fps);
  const requestedMaxFrames = validateInteger(request.maxFrames, 1, MAX_FRAMES, '最大帧数');

  if (request.pixelFormat !== 'mono'
    && request.pixelFormat !== 'rgb565'
    && request.pixelFormat !== 'rgb332') {
    throw new VideoConversionError('INVALID_REQUEST', '不支持的目标像素格式');
  }

  const frameSize = getFrameSize(width, height, request.pixelFormat);
  const budgetFrameLimit = Math.floor((MAX_OUTPUT_BYTES - AILY_VIDEO_HEADER_SIZE) / frameSize);
  if (budgetFrameLimit < 1) {
    throw new VideoConversionError(
      'OUTPUT_BUDGET_EXCEEDED',
      '单帧数据超过 256 MiB 输出预算',
    );
  }

  const maxFramesApplied = Math.min(requestedMaxFrames, budgetFrameLimit);
  return {
    width,
    height,
    fpsNumerator,
    fpsDenominator,
    requestedMaxFrames,
    maxFramesApplied,
    frameLimitReduced: maxFramesApplied < requestedMaxFrames,
    frameSize,
    pixelFormat: request.pixelFormat,
    loop: request.loop !== false,
    monoOptions: normalizeMonoOptions(request.monoOptions),
  };
}

function identifySource(request: VideoConversionRequest): SourceDescriptor {
  const mimeType = (request.mimeType || '').trim().toLowerCase();
  const fileName = (request.fileName || '').trim().toLowerCase();
  const sourceType = request.mimeType || '';

  if (mimeType.includes('mp4')) {
    return { kind: 'mp4', decoderType: 'video/mp4', label: 'MP4', sourceType: sourceType || 'video/mp4' };
  }
  if (mimeType === 'image/jpeg' || mimeType === 'image/jpg') {
    return { kind: 'image', decoderType: 'image/jpeg', label: 'JPEG', sourceType: sourceType || 'image/jpeg' };
  }
  if (mimeType === 'image/png') {
    return { kind: 'image', decoderType: 'image/png', label: 'PNG', sourceType: sourceType || 'image/png' };
  }
  if (mimeType === 'image/webp') {
    return { kind: 'image', decoderType: 'image/webp', label: 'WebP', sourceType: sourceType || 'image/webp' };
  }
  if (mimeType === 'image/gif') {
    return { kind: 'image', decoderType: 'image/gif', label: 'GIF', sourceType: sourceType || 'image/gif' };
  }

  if (fileName.endsWith('.mp4')) {
    return { kind: 'mp4', decoderType: 'video/mp4', label: 'MP4', sourceType: sourceType || 'video/mp4' };
  }
  if (fileName.endsWith('.jpg') || fileName.endsWith('.jpeg')) {
    return { kind: 'image', decoderType: 'image/jpeg', label: 'JPEG', sourceType: sourceType || 'image/jpeg' };
  }
  if (fileName.endsWith('.png')) {
    return { kind: 'image', decoderType: 'image/png', label: 'PNG', sourceType: sourceType || 'image/png' };
  }
  if (fileName.endsWith('.webp')) {
    return { kind: 'image', decoderType: 'image/webp', label: 'WebP', sourceType: sourceType || 'image/webp' };
  }
  if (fileName.endsWith('.gif')) {
    return { kind: 'image', decoderType: 'image/gif', label: 'GIF', sourceType: sourceType || 'image/gif' };
  }

  throw new VideoConversionError(
    'UNSUPPORTED_FILE_TYPE',
    '仅支持 JPG、JPEG、PNG、WebP、GIF 和 MP4 文件',
  );
}

function getFrameIntervalUs(options: ConversionOptions): number {
  return MICROSECONDS_PER_SECOND * options.fpsDenominator / options.fpsNumerator;
}

function normalizeDurationUs(value: unknown, fallback: number): number {
  const duration = Number(value);
  return Number.isFinite(duration) && duration > 0 ? duration : fallback;
}

/**
 * VideoDecoder.flush() 会结束当前解码序列，之后必须重新从关键帧开始。
 * 这里只等待解码队列自然下降来做背压，不能在 GOP 中途调用 flush()。
 */
async function waitForDecodeQueueBelow(decoder: any, limit: number): Promise<void> {
  while (
    decoder.state !== 'closed'
    && Number.isFinite(Number(decoder.decodeQueueSize))
    && Number(decoder.decodeQueueSize) >= limit
  ) {
    await new Promise<void>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        decoder.removeEventListener?.('dequeue', onDequeue);
        resolve();
      };
      const onDequeue = () => {
        if (decoder.state === 'closed' || Number(decoder.decodeQueueSize) < limit) {
          finish();
        }
      };

      decoder.addEventListener?.('dequeue', onDequeue);
      timer = setTimeout(finish, VIDEO_DECODE_QUEUE_POLL_MS);
      onDequeue();
    });
  }
}

function getBoxDescription(box: any): Uint8Array | undefined {
  if (!box || typeof box.write !== 'function') return undefined;

  const stream = new DataStream(undefined, 0, 1 as any) as any;
  box.write(stream);
  const byteLength = Number(stream.byteLength || stream.getPosition?.() || 0);
  if (byteLength <= 8) return undefined;
  return new Uint8Array(stream.buffer.slice(8, byteLength));
}

function getDecoderDescription(sample: any): Uint8Array | undefined {
  const description = sample?.description;
  return getBoxDescription(description?.avcC)
    || getBoxDescription(description?.hvcC)
    || getBoxDescription(description?.av1C)
    || getBoxDescription(description?.vpcC);
}

async function getMp4VideoSamples(buffer: ArrayBuffer): Promise<Mp4VideoData> {
  return new Promise((resolve, reject) => {
    const mp4boxFile = createFile() as any;
    let videoTrack: any = null;
    let settled = false;
    let finishTimer: ReturnType<typeof setTimeout> | undefined;
    const samples: any[] = [];

    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      if (finishTimer !== undefined) clearTimeout(finishTimer);
      reject(error);
    };

    const scheduleFinish = (): void => {
      if (settled) return;
      if (finishTimer !== undefined) clearTimeout(finishTimer);
      finishTimer = setTimeout(() => {
        if (settled) return;
        if (!videoTrack) {
          fail(new VideoConversionError('MP4_METADATA_FAILED', '无法读取 MP4 视频轨道信息'));
          return;
        }
        if (samples.length === 0) {
          fail(new VideoConversionError('MP4_NO_SAMPLES', 'MP4 视频轨道中没有可解码帧'));
          return;
        }
        settled = true;
        resolve({ track: videoTrack, samples });
      }, 0);
    };

    mp4boxFile.onError = (module: string, message: string) => {
      const detail = message || module;
      fail(new VideoConversionError(
        'MP4_PARSE_FAILED',
        detail ? `MP4 解析失败：${detail}` : 'MP4 解析失败',
      ));
    };

    mp4boxFile.onReady = (info: any) => {
      videoTrack = info.tracks?.find((track: any) => track.video);
      if (!videoTrack) {
        fail(new VideoConversionError('MP4_NO_VIDEO_TRACK', 'MP4 文件中没有视频轨道'));
        return;
      }

      mp4boxFile.setExtractionOptions(videoTrack.id, null, {
        nbSamples: Math.max(1, Number(videoTrack.nb_samples || 1)),
      });
      mp4boxFile.start();
      scheduleFinish();
    };

    mp4boxFile.onSamples = (_id: number, _user: unknown, extractedSamples: any[]) => {
      samples.push(...extractedSamples);
      scheduleFinish();
    };

    try {
      const mp4Buffer = buffer.slice(0) as ArrayBuffer & { fileStart?: number };
      mp4Buffer.fileStart = 0;
      mp4boxFile.appendBuffer(mp4Buffer);
      mp4boxFile.flush();
      scheduleFinish();
    } catch (error) {
      fail(error);
    }
  });
}

async function decodeMp4(
  request: VideoConversionRequest,
  source: SourceDescriptor,
  options: ConversionOptions,
): Promise<Uint8Array[]> {
  const VideoDecoderCtor = (self as any).VideoDecoder;
  const EncodedVideoChunkCtor = (self as any).EncodedVideoChunk;
  if (!VideoDecoderCtor || !EncodedVideoChunkCtor) {
    throw new VideoConversionError(
      'WEB_CODECS_UNSUPPORTED',
      '当前环境不支持 WebCodecs VideoDecoder',
    );
  }

  postProgress(request.requestId, 'parsing', 0.04);
  const { track, samples } = await getMp4VideoSamples(request.buffer);
  const decoderDescription = getDecoderDescription(samples[0]);
  const config: VideoDecoderConfig = {
    codec: track.codec,
    codedWidth: track.video?.width || track.track_width || options.width,
    codedHeight: track.video?.height || track.track_height || options.height,
  };
  if (decoderDescription) config.description = decoderDescription;

  if (typeof VideoDecoderCtor.isConfigSupported === 'function') {
    const support = await VideoDecoderCtor.isConfigSupported(config);
    if (!support.supported) {
      throw new VideoConversionError(
        'CODEC_UNSUPPORTED',
        `当前环境不支持 MP4 编码 ${track.codec || ''}`.trim(),
      );
    }
  }

  const renderer = new PackedFrameRenderer(
    options.width,
    options.height,
    options.pixelFormat,
    options.monoOptions,
  );
  const frames: Uint8Array[] = [];
  const intervalUs = getFrameIntervalUs(options);
  const sampleDurations = new Map<number, number>();
  const reportDecodeProgress = createDecodeProgressReporter(
    request.requestId,
    options.maxFramesApplied,
  );
  let outputTimelineOrigin: number | null = null;
  let lastPackedFrame: Uint8Array | null = null;
  let outputError: unknown;
  let decoderError: unknown;

  postProgress(request.requestId, 'decoding', 0.1, 0, options.maxFramesApplied);
  const decoder = new VideoDecoderCtor({
    output: (frame: VideoFrame) => {
      try {
        if (outputError || frames.length >= options.maxFramesApplied) return;

        const timestamp = Number.isFinite(frame.timestamp) ? frame.timestamp : 0;
        const duration = normalizeDurationUs(
          frame.duration,
          normalizeDurationUs(sampleDurations.get(timestamp), intervalUs),
        );
        const frameEnd = timestamp + duration;
        if (outputTimelineOrigin === null) outputTimelineOrigin = timestamp;
        const nextCaptureTime = (): number => (
          outputTimelineOrigin! + frames.length * intervalUs
        );

        while (lastPackedFrame
          && nextCaptureTime() < timestamp
          && frames.length < options.maxFramesApplied) {
          frames.push(lastPackedFrame);
        }

        if (nextCaptureTime() < frameEnd && frames.length < options.maxFramesApplied) {
          const packedFrame = renderer.render(frame);
          lastPackedFrame = packedFrame;
          while (nextCaptureTime() < frameEnd && frames.length < options.maxFramesApplied) {
            frames.push(packedFrame);
          }
        }

        reportDecodeProgress(frames.length);
      } catch (error) {
        outputError = error;
      } finally {
        frame.close();
      }
    },
    error: (error: Error) => {
      decoderError = error;
    },
  });

  try {
    decoder.configure(config);
    const trackTimescale = Number(track.timescale) > 0
      ? Number(track.timescale)
      : MICROSECONDS_PER_SECOND;
    const descriptors = createMp4DecodeChunks(
      samples,
      trackTimescale,
      intervalUs,
      options.maxFramesApplied,
    );
    const throwIfDecodeFailed = () => {
      if (outputError) throw outputError;
      if (decoderError) throw decoderError;
    };
    await submitMp4DecodeChunks(
      decoder,
      descriptors,
      descriptor => new EncodedVideoChunkCtor(descriptor),
      {
        queueLimit: VIDEO_DECODE_MAX_QUEUE_SIZE,
        waitForQueue: () => waitForDecodeQueueBelow(decoder, VIDEO_DECODE_MAX_QUEUE_SIZE),
        onSubmit: descriptor => sampleDurations.set(descriptor.timestamp, descriptor.duration),
        throwIfFailed: throwIfDecodeFailed,
        shouldStop: () => frames.length >= options.maxFramesApplied,
      },
    );
  } finally {
    if (decoder.state !== 'closed') decoder.close();
  }

  if (frames.length === 0) {
    throw new VideoConversionError('MP4_NO_VALID_FRAMES', `${source.label} 中没有可转换的视频帧`);
  }
  reportDecodeProgress(frames.length);
  return frames;
}

async function decodeImage(
  request: VideoConversionRequest,
  source: SourceDescriptor,
  options: ConversionOptions,
): Promise<Uint8Array[]> {
  const ImageDecoderCtor = (self as any).ImageDecoder;
  if (!ImageDecoderCtor) {
    throw new VideoConversionError(
      'IMAGE_DECODER_UNSUPPORTED',
      '当前环境不支持 WebCodecs ImageDecoder',
    );
  }

  if (typeof ImageDecoderCtor.isTypeSupported === 'function') {
    const supported = await ImageDecoderCtor.isTypeSupported(source.decoderType);
    if (!supported) {
      throw new VideoConversionError(
        'IMAGE_TYPE_UNSUPPORTED',
        `当前环境不支持解码 ${source.label}`,
      );
    }
  }

  postProgress(request.requestId, 'parsing', 0.04);
  const decoder = new ImageDecoderCtor({
    data: new Uint8Array(request.buffer),
    type: source.decoderType,
  });
  const renderer = new PackedFrameRenderer(
    options.width,
    options.height,
    options.pixelFormat,
    options.monoOptions,
  );
  const frames: Uint8Array[] = [];

  try {
    await decoder.tracks.ready;
    const selectedTrack = decoder.tracks.selectedTrack;
    const trackFrameCount = Number(selectedTrack?.frameCount || 0);
    const isAnimated = selectedTrack?.animated === true || trackFrameCount > 1;

    if (!isAnimated) {
      postProgress(request.requestId, 'decoding', 0.1, 0, 1);
      const decoded = await decoder.decode({ frameIndex: 0, completeFramesOnly: true });
      const image = decoded.image as VideoFrame;
      try {
        frames.push(renderer.render(image));
      } finally {
        image.close();
      }
      postProgress(request.requestId, 'decoding', 0.9, 1, 1);
      return frames;
    }

    const sourceFrameCount = Number.isFinite(trackFrameCount) && trackFrameCount > 0
      ? trackFrameCount
      : Number.POSITIVE_INFINITY;
    const intervalUs = getFrameIntervalUs(options);
    const reportDecodeProgress = createDecodeProgressReporter(
      request.requestId,
      options.maxFramesApplied,
    );
    let currentTimestamp = 0;

    postProgress(request.requestId, 'decoding', 0.1, 0, options.maxFramesApplied);
    for (let frameIndex = 0;
      frameIndex < sourceFrameCount && frames.length < options.maxFramesApplied;
      frameIndex++) {
      let decoded: any;
      try {
        decoded = await decoder.decode({ frameIndex, completeFramesOnly: true });
      } catch (error) {
        if (frames.length > 0 && sourceFrameCount === Number.POSITIVE_INFINITY) break;
        throw error;
      }

      const image = decoded.image as VideoFrame;
      try {
        const duration = normalizeDurationUs(image.duration, intervalUs);
        const frameEnd = currentTimestamp + duration;
        const nextCaptureTime = (): number => frames.length * intervalUs;

        if (nextCaptureTime() < frameEnd && frames.length < options.maxFramesApplied) {
          const packedFrame = renderer.render(image);
          while (nextCaptureTime() < frameEnd && frames.length < options.maxFramesApplied) {
            frames.push(packedFrame);
          }
          reportDecodeProgress(frames.length);
        }
        currentTimestamp = frameEnd;
      } finally {
        image.close();
      }
    }
  } finally {
    decoder.close();
  }

  if (frames.length === 0) {
    throw new VideoConversionError(
      'IMAGE_NO_VALID_FRAMES',
      `${source.label} 中没有可转换的图像帧`,
    );
  }
  return frames;
}

function getExactArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0
    && bytes.byteLength === bytes.buffer.byteLength
    && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

async function convert(request: VideoConversionRequest): Promise<VideoConversionResult> {
  if (!(request.buffer instanceof ArrayBuffer) || request.buffer.byteLength === 0) {
    throw new VideoConversionError('INVALID_REQUEST', '源文件数据为空');
  }

  postProgress(request.requestId, 'preparing', 0);
  const source = identifySource(request);
  const options = normalizeConversionOptions(request);
  const frames = source.kind === 'mp4'
    ? await decodeMp4(request, source, options)
    : await decodeImage(request, source, options);

  postProgress(request.requestId, 'packing', 0.95, frames.length, frames.length);
  const file = buildAilyVideoFile(frames, {
    width: options.width,
    height: options.height,
    pixelFormat: options.pixelFormat,
    fpsNumerator: options.fpsNumerator,
    fpsDenominator: options.fpsDenominator,
    loop: options.loop,
  });
  if (file.byteLength > MAX_OUTPUT_BYTES) {
    throw new VideoConversionError('OUTPUT_BUDGET_EXCEEDED', '生成文件超过 256 MiB 输出预算');
  }

  const fileBuffer = getExactArrayBuffer(file);
  const frameCount = frames.length;
  const dataSize = options.frameSize * frameCount;
  return {
    fileBuffer,
    width: options.width,
    height: options.height,
    fpsNumerator: options.fpsNumerator,
    fpsDenominator: options.fpsDenominator,
    frameCount,
    frameSize: options.frameSize,
    dataSize,
    pixelFormat: options.pixelFormat,
    loop: options.loop,
    isVideoSource: source.kind === 'mp4',
    sourceName: request.fileName || '',
    sourceType: source.sourceType,
    maxFramesApplied: options.maxFramesApplied,
    frameLimitReduced: options.frameLimitReduced,
  };
}

self.addEventListener('message', async (event: MessageEvent<VideoConversionRequest>) => {
  const request = event.data;
  if (!request || request.type !== 'convert') return;

  try {
    const result = await convert(request);
    postDone(request.requestId, result);
  } catch (error) {
    postError(request.requestId, error);
  }
});
