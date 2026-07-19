import { App } from './app';
import type { VideoConversionResult } from './video-converter.types';

function conversionResult(): VideoConversionResult {
  return {
    fileBuffer: new Uint8Array([0x41, 0x49, 0x4c, 0x59]).buffer,
    width: 1,
    height: 1,
    fpsNumerator: 1,
    fpsDenominator: 1,
    frameCount: 1,
    frameSize: 2,
    dataSize: 2,
    pixelFormat: 'rgb565',
    loop: false,
    isVideoSource: false,
    sourceName: 'frame.png',
    sourceType: 'image/png',
    maxFramesApplied: 1,
    frameLimitReduced: false,
  };
}

describe('video converter export', () => {
  it('uses one anchor download even when the native save picker is available', () => {
    const app = new App({ detectChanges: vi.fn() } as never);
    app.result = conversionResult();

    const picker = vi.fn();
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true,
      value: picker,
    });
    const download = vi.spyOn(app as any, 'downloadBlobWithAnchor').mockImplementation(() => undefined);
    vi.spyOn(app as any, 'showNotice').mockImplementation(() => undefined);

    app.exportFile();

    expect(picker).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledOnce();
    expect(download.mock.calls[0][1]).toBe('frame.rgb565');

    delete (window as Window & { showSaveFilePicker?: unknown }).showSaveFilePicker;
  });
});
