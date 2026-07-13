const MICROSECONDS_PER_SECOND = 1_000_000;

export interface Mp4DecodeSample {
  timescale?: number;
  cts?: number;
  dts?: number;
  duration?: number;
  is_sync?: boolean;
  data: BufferSource;
}

export interface Mp4DecodeChunkDescriptor {
  type: EncodedVideoChunkType;
  timestamp: number;
  duration: number;
  data: BufferSource;
}

export interface DecodeQueueLike<TChunk> {
  readonly state: string;
  readonly decodeQueueSize: number;
  decode(chunk: TChunk): void;
  flush(): Promise<void>;
}

export interface SubmitMp4DecodeOptions {
  queueLimit: number;
  waitForQueue: () => Promise<void>;
  onSubmit?: (descriptor: Mp4DecodeChunkDescriptor) => void;
  throwIfFailed?: () => void;
  shouldStop?: () => boolean;
}

/**
 * Keeps samples in MP4 extraction/DTS order and only limits the tail of the
 * decode window. Leading delta samples must never be skipped independently of
 * their preceding sync sample.
 */
export function createMp4DecodeChunks(
  samples: Mp4DecodeSample[],
  trackTimescale: number,
  intervalUs: number,
  maxFramesApplied: number,
): Mp4DecodeChunkDescriptor[] {
  const normalizedTrackTimescale = trackTimescale > 0
    ? trackTimescale
    : MICROSECONDS_PER_SECOND;
  const decodeWindowUs = intervalUs * maxFramesApplied;
  const decodeWindowPaddingUs = Math.max(intervalUs, MICROSECONDS_PER_SECOND);
  const chunks: Mp4DecodeChunkDescriptor[] = [];
  let decodeStartDts: number | null = null;

  for (const sample of samples) {
    const sampleTimescale = Number(sample.timescale) > 0
      ? Number(sample.timescale)
      : normalizedTrackTimescale;
    const timestamp = Math.round(
      Number(sample.cts ?? sample.dts ?? 0) * MICROSECONDS_PER_SECOND / sampleTimescale,
    );
    const decodeTimestamp = Math.round(
      Number(sample.dts ?? sample.cts ?? 0) * MICROSECONDS_PER_SECOND / sampleTimescale,
    );
    const duration = Math.max(
      1,
      Math.round(Number(sample.duration || 1) * MICROSECONDS_PER_SECOND / sampleTimescale),
    );
    if (decodeStartDts === null) decodeStartDts = decodeTimestamp;
    if (decodeTimestamp - decodeStartDts > decodeWindowUs + decodeWindowPaddingUs) break;

    chunks.push({
      type: sample.is_sync ? 'key' : 'delta',
      timestamp,
      duration,
      data: sample.data,
    });
  }

  return chunks;
}

/**
 * Applies queue backpressure without flushing mid-GOP. WebCodecs requires a
 * key frame after every flush, so the only flush belongs after all selected
 * encoded chunks have been submitted.
 */
export async function submitMp4DecodeChunks<TChunk>(
  decoder: DecodeQueueLike<TChunk>,
  descriptors: Mp4DecodeChunkDescriptor[],
  createChunk: (descriptor: Mp4DecodeChunkDescriptor) => TChunk,
  options: SubmitMp4DecodeOptions,
): Promise<number> {
  let submitted = 0;

  for (const descriptor of descriptors) {
    options.onSubmit?.(descriptor);
    decoder.decode(createChunk(descriptor));
    submitted++;

    if (Number(decoder.decodeQueueSize) >= options.queueLimit) {
      await options.waitForQueue();
      options.throwIfFailed?.();
      if (options.shouldStop?.()) break;
    }
  }

  if (decoder.state !== 'closed') await decoder.flush();
  options.throwIfFailed?.();
  return submitted;
}
