import {
  AILY_FLAG_LOOP,
  AILY_VIDEO_HEADER_SIZE,
  AILY_VIDEO_VERSION,
  AilyPixelFormat,
  AilyPixelFormatCode,
  buildAilyVideoFile,
  getFrameSize,
  getOutputExtension,
  packRgbaFrame,
  parseAilyVideoHeader,
  unpackFrameToRgba,
} from './aily-video-format';

function rgbaPixels(pixels: ReadonlyArray<readonly [number, number, number, number]>): Uint8Array {
  return Uint8Array.from(pixels.flatMap(pixel => [...pixel]));
}

function rgbaMask(width: number, height: number, enabled: ReadonlySet<string>): Uint8Array {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4;
      const value = enabled.has(`${x},${y}`) ? 255 : 0;
      rgba[offset] = value;
      rgba[offset + 1] = value;
      rgba[offset + 2] = value;
      rgba[offset + 3] = 255;
    }
  }
  return rgba;
}

function pixelAt(rgba: Uint8ClampedArray, index: number): number[] {
  return Array.from(rgba.subarray(index * 4, index * 4 + 4));
}

describe('aily-video-format', () => {
  describe('packRgbaFrame', () => {
    it('packs RGB565 golden vectors in little-endian byte order', () => {
      const rgba = rgbaPixels([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 255, 255],
        [0, 0, 0, 255],
      ]);

      expect(Array.from(packRgbaFrame(rgba, 5, 1, 'rgb565'))).toEqual([
        0x00, 0xf8,
        0xe0, 0x07,
        0x1f, 0x00,
        0xff, 0xff,
        0x00, 0x00,
      ]);
    });

    it('packs RGB332 golden vectors', () => {
      const rgba = rgbaPixels([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
        [0, 0, 255, 255],
        [255, 255, 255, 255],
        [0, 0, 0, 255],
      ]);

      expect(Array.from(packRgbaFrame(rgba, 5, 1, 'rgb332'))).toEqual([
        0xe0,
        0x1c,
        0x03,
        0xff,
        0x00,
      ]);
    });

    it('packs each 9-pixel MONO row LSB-first and clears row padding bits', () => {
      const rgba = rgbaMask(9, 2, new Set([
        '0,0', '2,0', '7,0', '8,0',
        '1,1', '8,1',
      ]));

      expect(Array.from(packRgbaFrame(rgba, 9, 2, 'mono'))).toEqual([
        0x85, 0x01,
        0x02, 0x01,
      ]);
    });
  });

  describe('AILY file layout', () => {
    it('writes the exact 40-byte header and concatenates two frames in order', () => {
      const file = buildAilyVideoFile(
        [Uint8Array.of(0x12, 0x34), Uint8Array.of(0x56, 0x78)],
        {
          width: 2,
          height: 1,
          pixelFormat: 'rgb332',
          fpsNumerator: 15,
          fpsDenominator: 1,
          loop: true,
        },
      );

      expect(Array.from(file.subarray(0, AILY_VIDEO_HEADER_SIZE))).toEqual([
        0x41, 0x49, 0x4c, 0x59,
        0x01, 0x28, 0x02, 0x01,
        0x02, 0x00, 0x01, 0x00,
        0x0f, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x00, 0x00,
        0x02, 0x00, 0x00, 0x00,
        0x02, 0x00, 0x00, 0x00,
        0x28, 0x00, 0x00, 0x00,
        0x04, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x00, 0x00,
      ]);
      expect(Array.from(file.subarray(AILY_VIDEO_HEADER_SIZE))).toEqual([
        0x12, 0x34, 0x56, 0x78,
      ]);
      expect(file.byteLength).toBe(AILY_VIDEO_HEADER_SIZE + 4);

      expect(parseAilyVideoHeader(file)).toEqual({
        magic: 'AILY',
        version: AILY_VIDEO_VERSION,
        headerSize: AILY_VIDEO_HEADER_SIZE,
        pixelFormat: AilyPixelFormatCode.Rgb332,
        flags: AILY_FLAG_LOOP,
        width: 2,
        height: 1,
        fpsNumerator: 15,
        fpsDenominator: 1,
        frameCount: 2,
        frameSize: 2,
        dataOffset: AILY_VIDEO_HEADER_SIZE,
        dataSize: 4,
        reserved: 0,
      });
    });

    it('matches the 240x240 RGB565, 15 FPS, 100-frame example', () => {
      const frameSize = getFrameSize(240, 240, 'rgb565');
      const frame = new Uint8Array(frameSize);
      const file = buildAilyVideoFile(new Array<Uint8Array>(100).fill(frame), {
        width: 240,
        height: 240,
        pixelFormat: 'rgb565',
        fpsNumerator: 15,
        fpsDenominator: 1,
      });
      const header = parseAilyVideoHeader(file);

      expect(header.pixelFormat).toBe(AilyPixelFormatCode.Rgb565Le);
      expect(header.width).toBe(240);
      expect(header.height).toBe(240);
      expect(header.fpsNumerator).toBe(15);
      expect(header.fpsDenominator).toBe(1);
      expect(header.frameCount).toBe(100);
      expect(header.frameSize).toBe(115200);
      expect(header.dataOffset).toBe(40);
      expect(header.dataSize).toBe(11520000);
      expect(file.byteLength).toBe(11520040);
    });

    it('matches the 128x64 MONO, 20 FPS, 200-frame example', () => {
      const frameSize = getFrameSize(128, 64, 'mono');
      const frame = new Uint8Array(frameSize);
      const file = buildAilyVideoFile(new Array<Uint8Array>(200).fill(frame), {
        width: 128,
        height: 64,
        pixelFormat: 'mono',
        fpsNumerator: 20,
        fpsDenominator: 1,
      });
      const header = parseAilyVideoHeader(file);

      expect(header.pixelFormat).toBe(AilyPixelFormatCode.Mono1Xbm);
      expect(header.width).toBe(128);
      expect(header.height).toBe(64);
      expect(header.fpsNumerator).toBe(20);
      expect(header.fpsDenominator).toBe(1);
      expect(header.frameCount).toBe(200);
      expect(header.frameSize).toBe(1024);
      expect(header.dataOffset).toBe(40);
      expect(header.dataSize).toBe(204800);
      expect(file.byteLength).toBe(204840);
    });

    it('round-trips a 30000/1001 frame rate without rounding', () => {
      const file = buildAilyVideoFile([Uint8Array.of(0xff)], {
        width: 1,
        height: 1,
        pixelFormat: 'rgb332',
        fpsNumerator: 30000,
        fpsDenominator: 1001,
      });
      const header = parseAilyVideoHeader(file);

      expect(header.fpsNumerator).toBe(30000);
      expect(header.fpsDenominator).toBe(1001);
    });
  });

  describe('unpackFrameToRgba', () => {
    it('unpacks RGB565, RGB332, and MONO frames for preview', () => {
      const rgb565 = unpackFrameToRgba(
        Uint8Array.of(0x00, 0xf8, 0xe0, 0x07, 0x1f, 0x00),
        3,
        1,
        'rgb565',
      );
      expect(pixelAt(rgb565, 0)).toEqual([255, 0, 0, 255]);
      expect(pixelAt(rgb565, 1)).toEqual([0, 255, 0, 255]);
      expect(pixelAt(rgb565, 2)).toEqual([0, 0, 255, 255]);

      const rgb332 = unpackFrameToRgba(Uint8Array.of(0xe0, 0x1c, 0x03), 3, 1, 'rgb332');
      expect(pixelAt(rgb332, 0)).toEqual([255, 0, 0, 255]);
      expect(pixelAt(rgb332, 1)).toEqual([0, 255, 0, 255]);
      expect(pixelAt(rgb332, 2)).toEqual([0, 0, 255, 255]);

      const mono = unpackFrameToRgba(Uint8Array.of(0x01, 0x01), 9, 1, 'mono');
      expect(pixelAt(mono, 0)).toEqual([255, 255, 255, 255]);
      expect(pixelAt(mono, 1)).toEqual([0, 0, 0, 255]);
      expect(pixelAt(mono, 8)).toEqual([255, 255, 255, 255]);
    });
  });

  describe('validation', () => {
    const options = {
      width: 2,
      height: 1,
      pixelFormat: 'rgb332' as const,
      fpsNumerator: 15,
      fpsDenominator: 1,
    };

    it('rejects a frame whose byte length does not match its format', () => {
      expect(() => buildAilyVideoFile([Uint8Array.of(0xff)], options)).toThrowError();
    });

    it('rejects zero FPS components when writing or parsing', () => {
      expect(() => buildAilyVideoFile(
        [Uint8Array.of(0x00, 0x00)],
        { ...options, fpsNumerator: 0 },
      )).toThrowError();
      expect(() => buildAilyVideoFile(
        [Uint8Array.of(0x00, 0x00)],
        { ...options, fpsDenominator: 0 },
      )).toThrowError();

      const corruptedFps = buildAilyVideoFile([Uint8Array.of(0x00, 0x00)], options);
      new DataView(corruptedFps.buffer).setUint32(12, 0, true);
      expect(() => parseAilyVideoHeader(corruptedFps)).toThrowError();
    });

    it('rejects corrupted headers and truncated files', () => {
      const valid = buildAilyVideoFile([Uint8Array.of(0x12, 0x34)], options);

      expect(() => parseAilyVideoHeader(valid.subarray(0, 39))).toThrowError();

      const badMagic = valid.slice();
      badMagic[0] = 0x00;
      expect(() => parseAilyVideoHeader(badMagic)).toThrowError();

      const badFrameSize = valid.slice();
      new DataView(badFrameSize.buffer).setUint32(24, 3, true);
      expect(() => parseAilyVideoHeader(badFrameSize)).toThrowError();

      expect(() => parseAilyVideoHeader(valid.subarray(0, valid.byteLength - 1))).toThrowError();
    });
  });

  it('adds the video suffix strictly from the source-is-MP4 boolean', () => {
    const formats: readonly AilyPixelFormat[] = ['mono', 'rgb565', 'rgb332'];
    const stillExtensions = ['.mono', '.rgb565', '.rgb332'];
    const mp4Extensions = ['.monov', '.rgb565v', '.rgb332v'];

    formats.forEach((format, index) => {
      expect(getOutputExtension(format, false)).toBe(stillExtensions[index]);
      expect(getOutputExtension(format, true)).toBe(mp4Extensions[index]);
    });
  });
});
