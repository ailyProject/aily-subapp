import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { createFile } from 'mp4box';
import {
  createMp4DecodeChunks,
  submitMp4DecodeChunks,
  type Mp4DecodeSample,
} from './mp4-decode-scheduler';

interface ExtractedMp4 {
  track: { timescale: number };
  samples: Mp4DecodeSample[];
}

async function loadLongGopFixture(): Promise<ExtractedMp4> {
  const fixturePath = resolvePath(process.cwd(), '..', 'test', 'fixtures', 'long-gop-h264.mp4.b64');
  const base64 = readFileSync(fixturePath, 'utf8').replace(/\s+/g, '');
  const bytes = Buffer.from(base64, 'base64');
  const sourceBuffer = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer & { fileStart?: number };
  sourceBuffer.fileStart = 0;

  return new Promise((resolve, reject) => {
    const file = createFile() as any;
    let track: any = null;
    const samples: Mp4DecodeSample[] = [];
    let finishTimer: ReturnType<typeof setTimeout> | undefined;

    const scheduleFinish = () => {
      if (finishTimer !== undefined) clearTimeout(finishTimer);
      finishTimer = setTimeout(() => {
        if (!track || samples.length === 0) {
          reject(new Error('Long-GOP fixture did not expose a video track and samples'));
          return;
        }
        resolve({ track, samples });
      }, 0);
    };

    file.onError = (_module: string, message: string) => reject(new Error(message));
    file.onReady = (info: any) => {
      track = info.tracks?.find((candidate: any) => candidate.video);
      if (!track) {
        reject(new Error('Long-GOP fixture has no video track'));
        return;
      }
      file.setExtractionOptions(track.id, null, { nbSamples: track.nb_samples });
      file.start();
      scheduleFinish();
    };
    file.onSamples = (_id: number, _user: unknown, extracted: Mp4DecodeSample[]) => {
      samples.push(...extracted);
      scheduleFinish();
    };

    file.appendBuffer(sourceBuffer);
    file.flush();
    scheduleFinish();
  });
}

describe('long-GOP MP4 decode scheduling', () => {
  it('uses queue backpressure and flushes only after the final delta sample', async () => {
    const { track, samples } = await loadLongGopFixture();
    expect(samples.length).toBeGreaterThan(64);
    expect(samples[0]?.is_sync).toBe(true);
    expect(samples.slice(1).every(sample => sample.is_sync !== true)).toBe(true);

    const descriptors = createMp4DecodeChunks(
      samples,
      track.timescale,
      1_000_000 / 30,
      samples.length,
    );
    const operations: string[] = [];
    let queueSize = 0;
    const decoder = {
      state: 'configured',
      get decodeQueueSize() {
        return queueSize;
      },
      decode(chunk: { type: string }) {
        operations.push(`decode:${chunk.type}`);
        queueSize++;
      },
      async flush() {
        operations.push('flush');
      },
    };

    const submitted = await submitMp4DecodeChunks(
      decoder,
      descriptors,
      descriptor => descriptor,
      {
        queueLimit: 64,
        waitForQueue: async () => {
          operations.push('wait');
          queueSize = 0;
        },
      },
    );

    expect(submitted).toBe(samples.length);
    expect(operations[0]).toBe('decode:key');
    expect(operations.filter(operation => operation === 'wait')).toHaveLength(1);
    expect(operations.filter(operation => operation === 'flush')).toHaveLength(1);
    expect(operations.at(-1)).toBe('flush');
    const remainingDecodeOperations = operations
      .slice(1, -1)
      .filter(operation => operation.startsWith('decode:'));
    expect(remainingDecodeOperations.every(operation => operation === 'decode:delta')).toBe(true);
  });
});
