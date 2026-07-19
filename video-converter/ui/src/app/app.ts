import { CommonModule } from '@angular/common';
import {
  ChangeDetectorRef,
  Component,
  ElementRef,
  OnDestroy,
  OnInit,
  ViewChild,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  AILY_VIDEO_HEADER_SIZE,
  type AilyPixelFormat,
  getFrameSize,
  getOutputExtension,
  unpackFrameToRgba,
} from './aily-video-format';
import type {
  VideoConversionRequest,
  VideoConversionResult,
  VideoConverterWorkerMessage,
  VideoConversionStage,
} from './video-converter.types';

type ThemeName = 'dark' | 'light';
type NoticeType = 'success' | 'info' | 'warning' | 'error';

interface HostContext {
  lang: string;
  theme: ThemeName;
  platform: string;
}

interface HostRemote {
  getHostContext?: () => Promise<Partial<HostContext> | null> | Partial<HostContext> | null;
  childReady?: (data: Record<string, unknown>) => void;
  childError?: (data: Record<string, unknown>) => void;
  reportHostMessage?: (data: Record<string, unknown>) => unknown;
}

interface PenpalApi {
  WindowMessenger: new (options: Record<string, unknown>) => unknown;
  connect: (options: Record<string, unknown>) => { promise: Promise<HostRemote> };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timeout: number;
}

interface RpcResponseMessage {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

interface RpcEventMessage {
  event: string;
  data?: Record<string, unknown>;
}

declare global {
  interface Window {
    Penpal?: PenpalApi;
  }
}

const TOOL_NAMESPACE = 'VIDEO_CONVERTER';
const TOOL_NAME = 'Aily Video Converter';
const DRAFT_KEY = 'video-converter.angular.ui.draft.v1';
const SUPPORTED_FILE_PATTERN = /\.(?:jpe?g|png|webp|gif|mp4)$/i;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;
const MAX_DIMENSION = 4096;
const MAX_FRAMES = 10_000;
const MAX_FPS = 240;

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App implements OnInit, OnDestroy {
  @ViewChild('fileInput') private fileInput?: ElementRef<HTMLInputElement>;
  @ViewChild('previewCanvas') private previewCanvas?: ElementRef<HTMLCanvasElement>;

  readonly accept = '.jpg,.jpeg,.png,.webp,.gif,.mp4,image/jpeg,image/png,image/webp,image/gif,video/mp4';

  hostContext: HostContext = { lang: 'en', theme: 'dark', platform: 'browser' };
  i18n: Record<string, string> = {};
  token = '';
  backendStatus = 'connecting';
  backendPid = 0;

  sourceFile: File | null = null;
  sourceUrl = '';
  sourceWidth = 0;
  sourceHeight = 0;
  sourceDuration = 0;

  width = 240;
  height = 240;
  fps = 15;
  maxFrames = 300;
  pixelFormat: AilyPixelFormat = 'rgb565';
  loop = true;
  monoThreshold = 128;
  monoDither = false;
  monoInvert = false;

  converting = false;
  dragging = false;
  progress = 0;
  statusKey = 'STATUS_SELECT_SOURCE';
  statusFallback = 'Select an image or MP4 video';
  statusParams: Record<string, string | number> = {};
  result: VideoConversionResult | null = null;
  currentFrame = 0;
  playing = false;
  noticeText = '';
  noticeType: NoticeType = 'info';

  private worker: Worker | null = null;
  private requestId = 0;
  private playTimer: number | null = null;
  private noticeTimer: number | null = null;
  private backendWs: WebSocket | null = null;
  private hostRemote: HostRemote | null = null;
  private requestSeq = 0;
  private pendingRequests = new Map<number, PendingRequest>();

  private readonly beforeUnloadHandler = (): void => this.saveDraft();

  constructor(private readonly cdr: ChangeDetectorRef) {}

  get formatOptions(): Array<{ value: AilyPixelFormat; title: string; detail: string }> {
    return [
      { value: 'mono', title: 'MONO', detail: this.t('FORMAT_MONO_DETAIL', '1-bit XBM for U8g2') },
      { value: 'rgb565', title: 'RGB565', detail: this.t('FORMAT_RGB565_DETAIL', '16-bit little-endian') },
      { value: 'rgb332', title: 'RGB332', detail: this.t('FORMAT_RGB332_DETAIL', '8-bit RRRGGGBB') },
    ];
  }

  get sourceIsVideo(): boolean {
    return !!this.sourceFile && this.isMp4(this.sourceFile);
  }

  get frameSize(): number {
    try {
      return getFrameSize(Math.round(this.width), Math.round(this.height), this.pixelFormat);
    } catch {
      return 0;
    }
  }

  get estimatedDataSize(): number {
    return this.frameSize * Math.max(1, Math.round(this.maxFrames));
  }

  get outputExtension(): string {
    const format = this.result?.pixelFormat || this.pixelFormat;
    const isVideo = this.result?.isVideoSource ?? this.sourceIsVideo;
    return getOutputExtension(format, isVideo);
  }

  get suggestedFileName(): string {
    const rawName = this.result?.sourceName || this.sourceFile?.name || 'aily-media';
    const baseName = rawName.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'aily-media';
    return `${baseName}${this.outputExtension}`;
  }

  get resultFileSize(): number {
    return this.result ? AILY_VIDEO_HEADER_SIZE + this.result.dataSize : 0;
  }

  get sourceDescription(): string {
    if (!this.sourceFile) return '';
    const resolution = this.sourceWidth && this.sourceHeight ? ` · ${this.sourceWidth}×${this.sourceHeight}` : '';
    const duration = this.sourceDuration > 0
      ? ` · ${this.sourceDuration.toFixed(2)} ${this.t('SECONDS_SHORT', 's')}`
      : '';
    return `${this.formatBytes(this.sourceFile.size)}${resolution}${duration}`;
  }

  get progressLabel(): string {
    return `${Math.round(this.progress * 100)}%`;
  }

  get statusText(): string {
    return this.t(this.statusKey, this.statusFallback, this.statusParams);
  }

  ngOnInit(): void {
    const query = new URLSearchParams(window.location.search);
    this.token = query.get('token') || '';
    this.hostContext = {
      lang: this.normalizeLang(query.get('lang') || navigator.language || 'en'),
      theme: 'dark',
      platform: 'browser',
    };
    window.addEventListener('beforeunload', this.beforeUnloadHandler);
    void this.bootstrap();
  }

  ngOnDestroy(): void {
    window.removeEventListener('beforeunload', this.beforeUnloadHandler);
    this.saveDraft();
    this.requestId++;
    this.stopPreview();
    this.destroyWorker();
    this.revokeSourceUrl();
    this.rejectPending(new Error('Backend WebSocket closed'));
    this.backendWs?.close();
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
  }

  t(key: string, fallback = key, params: Record<string, string | number> = {}): string {
    let value = this.i18n[key] || fallback;
    for (const [name, replacement] of Object.entries(params)) {
      value = value.replaceAll(`{${name}}`, String(replacement));
    }
    return value;
  }

  chooseFile(): void {
    this.fileInput?.nativeElement.click();
  }

  onFileInputChange(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (file) void this.loadSource(file);
  }

  onDragOver(event: DragEvent): void {
    event.preventDefault();
    if (!this.converting) this.dragging = true;
  }

  onDragLeave(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
  }

  onDrop(event: DragEvent): void {
    event.preventDefault();
    this.dragging = false;
    const file = event.dataTransfer?.files?.[0];
    if (file && !this.converting) void this.loadSource(file);
  }

  selectFormat(format: AilyPixelFormat): void {
    if (this.pixelFormat === format) return;
    this.pixelFormat = format;
    this.onSettingsChange();
  }

  setFps(fps: number): void {
    this.fps = fps;
    this.onSettingsChange();
  }

  onSettingsChange(): void {
    this.saveDraft();
    this.invalidateResult();
  }

  async convert(): Promise<void> {
    if (!this.sourceFile || this.converting) return;
    const validationError = this.validateSettings();
    if (validationError) {
      this.showNotice('warning', validationError);
      return;
    }

    this.stopPreview();
    this.result = null;
    this.currentFrame = 0;
    this.converting = true;
    this.progress = 0;
    this.setStatus('STATUS_READING_SOURCE', 'Reading source file…');
    const requestId = ++this.requestId;
    this.refresh();

    try {
      const buffer = await this.sourceFile.arrayBuffer();
      if (requestId !== this.requestId) return;
      const worker = this.ensureWorker();
      const request: VideoConversionRequest = {
        type: 'convert',
        requestId,
        fileName: this.sourceFile.name,
        mimeType: this.sourceFile.type,
        buffer,
        width: Math.round(this.width),
        height: Math.round(this.height),
        fps: this.fps,
        maxFrames: Math.round(this.maxFrames),
        pixelFormat: this.pixelFormat,
        loop: this.loop,
        monoOptions: {
          threshold: Math.round(this.monoThreshold),
          dither: this.monoDither,
          invert: this.monoInvert,
        },
      };
      worker.postMessage(request, [buffer]);
    } catch (error) {
      this.finishWithError(this.errorMessage(error));
    }
  }

  cancelConversion(): void {
    if (!this.converting) return;
    this.requestId++;
    this.destroyWorker();
    this.converting = false;
    this.progress = 0;
    this.setStatus('STATUS_CANCELED', 'Conversion canceled');
    this.refresh();
  }

  togglePreview(): void {
    if (!this.result || this.result.frameCount <= 1) return;
    if (this.playing) {
      this.stopPreview();
      return;
    }
    this.playing = true;
    this.scheduleNextFrame();
    this.refresh();
  }

  onFrameChange(value: number | string): void {
    if (!this.result) return;
    this.stopPreview();
    const frame = Math.min(this.result.frameCount - 1, Math.max(0, Number(value) || 0));
    this.currentFrame = Math.round(frame);
    this.renderCurrentFrame();
  }

  exportFile(): void {
    if (!this.result) return;
    const blob = new Blob([this.result.fileBuffer], { type: 'application/octet-stream' });
    this.downloadBlobWithAnchor(blob, this.suggestedFileName);
    this.showNotice(
      'success',
      this.t('EXPORT_SUCCESS', 'Exported {name}', { name: this.suggestedFileName }),
    );
  }

  formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KiB', 'MiB', 'GiB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
      value /= 1024;
      unit++;
    }
    return `${value >= 100 || unit === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unit]}`;
  }

  formatName(format: AilyPixelFormat): string {
    return format === 'mono' ? 'MONO1_XBM' : format.toUpperCase();
  }

  private async bootstrap(): Promise<void> {
    document.documentElement.lang = this.hostContext.lang;
    await this.connectHost();
    this.loadDraft();
    await this.loadI18n(this.hostContext.lang);
    this.applyTheme(this.hostContext.theme);
    this.connectBackend();
    this.refresh();
  }

  private async loadSource(file: File): Promise<void> {
    if (!SUPPORTED_FILE_PATTERN.test(file.name)) {
      this.showNotice('warning', this.t('ERROR_UNSUPPORTED_FILE', 'Only JPG, PNG, WebP, GIF and MP4 files are supported'));
      return;
    }
    if (file.size <= 0) {
      this.showNotice('warning', this.t('ERROR_EMPTY_SOURCE', 'The source file is empty'));
      return;
    }
    if (file.size > MAX_SOURCE_BYTES) {
      this.showNotice(
        'warning',
        this.t('ERROR_SOURCE_TOO_LARGE', 'The source file cannot exceed {size}', {
          size: this.formatBytes(MAX_SOURCE_BYTES),
        }),
      );
      return;
    }

    if (this.converting) this.cancelConversion();
    this.stopPreview();
    this.result = null;
    this.progress = 0;
    this.revokeSourceUrl();
    this.sourceFile = file;
    this.sourceWidth = 0;
    this.sourceHeight = 0;
    this.sourceDuration = 0;
    this.sourceUrl = URL.createObjectURL(file);
    this.setStatus('STATUS_READING_METADATA', 'Reading media metadata…');
    this.refresh();

    try {
      const metadata = this.isMp4(file)
        ? await this.loadVideoMetadata(this.sourceUrl)
        : await this.loadImageMetadata(this.sourceUrl);
      if (this.sourceFile !== file) return;
      this.sourceWidth = metadata.width;
      this.sourceHeight = metadata.height;
      this.sourceDuration = metadata.duration || 0;
      const scale = Math.min(1, MAX_DIMENSION / metadata.width, MAX_DIMENSION / metadata.height);
      this.width = Math.max(1, Math.round(metadata.width * scale));
      this.height = Math.max(1, Math.round(metadata.height * scale));
      this.saveDraft();
      this.setStatus('STATUS_READY_TO_CONVERT', 'Settings ready. Select Start conversion.');
      this.refresh();
    } catch (error) {
      this.setStatus('STATUS_METADATA_FAILED', 'Failed to read media metadata');
      this.showNotice(
        'error',
        this.t('ERROR_READ_MEDIA', 'Unable to read media: {detail}', { detail: this.errorMessage(error) }),
      );
      this.refresh();
    }
  }

  private loadImageMetadata(url: string): Promise<{ width: number; height: number; duration: number }> {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight, duration: 0 });
      image.onerror = () => reject(new Error(this.t('ERROR_IMAGE_METADATA', 'Unsupported or damaged image')));
      image.src = url;
    });
  }

  private loadVideoMetadata(url: string): Promise<{ width: number; height: number; duration: number }> {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.onloadedmetadata = () => {
        resolve({
          width: video.videoWidth,
          height: video.videoHeight,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
        });
        video.removeAttribute('src');
        video.load();
      };
      video.onerror = () => reject(new Error(this.t('ERROR_MP4_METADATA', 'Failed to read MP4 metadata')));
      video.src = url;
    });
  }

  private validateSettings(): string | null {
    if (!Number.isInteger(this.width) || this.width < 1 || this.width > MAX_DIMENSION) {
      return this.t('ERROR_WIDTH_RANGE', 'Width must be an integer from 1 to {max}', { max: MAX_DIMENSION });
    }
    if (!Number.isInteger(this.height) || this.height < 1 || this.height > MAX_DIMENSION) {
      return this.t('ERROR_HEIGHT_RANGE', 'Height must be an integer from 1 to {max}', { max: MAX_DIMENSION });
    }
    if (!Number.isFinite(this.fps) || this.fps < 0.001 || this.fps > MAX_FPS) {
      return this.t('ERROR_FPS_RANGE', 'FPS must be between 0.001 and {max}', { max: MAX_FPS });
    }
    if (!Number.isInteger(this.maxFrames) || this.maxFrames < 1 || this.maxFrames > MAX_FRAMES) {
      return this.t('ERROR_FRAME_LIMIT', 'Maximum frames must be an integer from 1 to {max}', { max: MAX_FRAMES });
    }
    if (!Number.isInteger(this.monoThreshold) || this.monoThreshold < 0 || this.monoThreshold > 255) {
      return this.t('ERROR_MONO_THRESHOLD', 'MONO threshold must be an integer from 0 to 255');
    }
    return null;
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./video-converter.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<VideoConverterWorkerMessage>) => {
      this.handleWorkerMessage(event.data);
      this.refresh();
    };
    worker.onerror = (event: ErrorEvent) => {
      this.finishWithError(event.message || this.t('ERROR_WORKER', 'Conversion worker failed'));
    };
    this.worker = worker;
    return worker;
  }

  private handleWorkerMessage(message: VideoConverterWorkerMessage): void {
    if (!message || message.requestId !== this.requestId) return;
    if (message.type === 'progress') {
      this.progress = Math.min(1, Math.max(0, message.progress));
      this.setProgressStatus(message.stage, message.current, message.total);
      return;
    }
    if (message.type === 'error') {
      const key = message.code ? `ERROR_${message.code}` : 'ERROR_CONVERSION_FAILED';
      const localized = this.i18n[key];
      const summary = localized || this.t('ERROR_CONVERSION_FAILED', 'Conversion failed');
      const detail = !localized || message.code === 'CONVERSION_FAILED' ? message.message : '';
      this.finishWithError(detail ? `${summary}: ${detail}` : summary);
      return;
    }

    this.result = message.result;
    this.converting = false;
    this.progress = 1;
    this.currentFrame = 0;
    if (message.result.frameLimitReduced && message.result.frameCount >= message.result.maxFramesApplied) {
      this.setStatus(
        'STATUS_COMPLETE_LIMIT',
        'Conversion complete. Output budget reduced the frame limit to {count}.',
        { count: message.result.maxFramesApplied },
      );
    } else {
      this.setStatus('STATUS_COMPLETE', 'Conversion complete: {count} frames', {
        count: message.result.frameCount,
      });
    }
    this.refresh();
    window.setTimeout(() => this.renderCurrentFrame());
  }

  private setProgressStatus(stage: VideoConversionStage, current?: number, total?: number): void {
    const params: Record<string, string | number> = {};
    if (current !== undefined && total !== undefined) {
      params['current'] = current;
      params['total'] = total;
    }
    if (stage === 'preparing') {
      this.setStatus('STATUS_PREPARING', 'Preparing conversion…');
    } else if (stage === 'parsing') {
      this.setStatus('STATUS_PARSING', 'Parsing media…');
    } else if (stage === 'packing') {
      this.setStatus('STATUS_PACKING', 'Building AILY file…');
    } else {
      this.setStatus('STATUS_CONVERTING_FRAMES', 'Converting frames… {current}/{total}', params);
    }
  }

  private finishWithError(message: string): void {
    this.converting = false;
    this.progress = 0;
    this.setStatus('STATUS_FAILED', 'Conversion failed');
    this.showNotice(
      'error',
      this.t('ERROR_CONVERSION_DETAIL', 'Conversion failed: {detail}', { detail: message }),
    );
    this.refresh();
  }

  private invalidateResult(): void {
    if (this.converting) this.cancelConversion();
    this.stopPreview();
    this.result = null;
    this.currentFrame = 0;
    if (this.sourceFile) this.setStatus('STATUS_SETTINGS_CHANGED', 'Settings changed. Convert again.');
  }

  private renderCurrentFrame(): void {
    const result = this.result;
    const canvas = this.previewCanvas?.nativeElement;
    if (!result || !canvas) return;
    const frameIndex = Math.min(result.frameCount - 1, Math.max(0, this.currentFrame));
    const sourceOffset = AILY_VIDEO_HEADER_SIZE + frameIndex * result.frameSize;
    const frame = new Uint8Array(result.fileBuffer, sourceOffset, result.frameSize);
    const rgba = unpackFrameToRgba(frame, result.width, result.height, result.pixelFormat);
    canvas.width = result.width;
    canvas.height = result.height;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.putImageData(
      new ImageData(new Uint8ClampedArray(rgba), result.width, result.height),
      0,
      0,
    );
  }

  private scheduleNextFrame(): void {
    const result = this.result;
    if (!result || !this.playing) return;
    const intervalMs = Math.max(1, 1000 * result.fpsDenominator / result.fpsNumerator);
    this.playTimer = window.setTimeout(() => {
      if (!this.result || !this.playing) return;
      if (this.currentFrame + 1 >= this.result.frameCount) {
        if (!this.result.loop) {
          this.stopPreview();
          this.refresh();
          return;
        }
        this.currentFrame = 0;
      } else {
        this.currentFrame++;
      }
      this.renderCurrentFrame();
      this.scheduleNextFrame();
      this.refresh();
    }, intervalMs);
  }

  private stopPreview(): void {
    this.playing = false;
    if (this.playTimer !== null) {
      window.clearTimeout(this.playTimer);
      this.playTimer = null;
    }
  }

  private destroyWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private revokeSourceUrl(): void {
    if (!this.sourceUrl) return;
    URL.revokeObjectURL(this.sourceUrl);
    this.sourceUrl = '';
  }

  private downloadBlobWithAnchor(blob: Blob, fileName: string): void {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    document.body.appendChild(anchor);
    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    window.setTimeout(() => {
      anchor.remove();
      URL.revokeObjectURL(url);
    }, 60_000);
  }

  private isMp4(file: File): boolean {
    return file.type.toLowerCase().includes('mp4') || /\.mp4$/i.test(file.name);
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error || this.t('ERROR_UNKNOWN', 'Unknown error'));
  }

  private setStatus(
    key: string,
    fallback: string,
    params: Record<string, string | number> = {},
  ): void {
    this.statusKey = key;
    this.statusFallback = fallback;
    this.statusParams = params;
  }

  private showNotice(type: NoticeType, text: string): void {
    this.noticeType = type;
    this.noticeText = text;
    if (this.noticeTimer !== null) window.clearTimeout(this.noticeTimer);
    this.noticeTimer = window.setTimeout(() => {
      this.noticeText = '';
      this.noticeTimer = null;
      this.refresh();
    }, type === 'error' ? 7000 : 4000);

    if (typeof this.hostRemote?.reportHostMessage === 'function') {
      void Promise.resolve(this.hostRemote.reportHostMessage({
        state: type,
        title: this.t('TITLE', TOOL_NAME),
        message: text,
        showMessage: true,
        sendToLog: type === 'error',
      }));
    }
    if (type === 'error') this.notifyHostError(new Error(text));
    this.refresh();
  }

  private saveDraft(): void {
    try {
      localStorage.setItem(DRAFT_KEY, JSON.stringify({
        width: this.width,
        height: this.height,
        fps: this.fps,
        maxFrames: this.maxFrames,
        pixelFormat: this.pixelFormat,
        loop: this.loop,
        monoThreshold: this.monoThreshold,
        monoDither: this.monoDither,
        monoInvert: this.monoInvert,
      }));
    } catch {
      // Storage may be unavailable in some browser modes.
    }
  }

  private loadDraft(): void {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null') as Record<string, unknown> | null;
      if (!draft || typeof draft !== 'object') return;
      if (typeof draft['width'] === 'number') this.width = draft['width'];
      if (typeof draft['height'] === 'number') this.height = draft['height'];
      if (typeof draft['fps'] === 'number') {
        this.fps = draft['fps'];
      } else if (typeof draft['fpsNumerator'] === 'number'
        && typeof draft['fpsDenominator'] === 'number'
        && draft['fpsDenominator'] > 0) {
        this.fps = draft['fpsNumerator'] / draft['fpsDenominator'];
      }
      if (typeof draft['maxFrames'] === 'number') this.maxFrames = draft['maxFrames'];
      if (draft['pixelFormat'] === 'mono' || draft['pixelFormat'] === 'rgb565' || draft['pixelFormat'] === 'rgb332') {
        this.pixelFormat = draft['pixelFormat'];
      }
      if (typeof draft['loop'] === 'boolean') this.loop = draft['loop'];
      if (typeof draft['monoThreshold'] === 'number') this.monoThreshold = draft['monoThreshold'];
      if (typeof draft['monoDither'] === 'boolean') this.monoDither = draft['monoDither'];
      if (typeof draft['monoInvert'] === 'boolean') this.monoInvert = draft['monoInvert'];
    } catch {
      // Ignore invalid persisted draft data.
    }
  }

  private normalizeLang(lang: string | null): string {
    const normalized = String(lang || 'en').toLowerCase().replace(/-/g, '_');
    if (normalized === 'zh' || normalized.startsWith('zh_cn')) return 'zh_cn';
    if (normalized.startsWith('zh_hk') || normalized.startsWith('zh_tw')) return 'zh_hk';
    return normalized || 'en';
  }

  private normalizeTheme(theme: string | null | undefined): ThemeName {
    return String(theme || '').toLowerCase() === 'light' ? 'light' : 'dark';
  }

  private applyTheme(theme: ThemeName): void {
    document.documentElement.style.colorScheme = theme;
    let themeLink = document.getElementById('theme-style') as HTMLLinkElement | null;
    if (!themeLink) {
      themeLink = document.createElement('link');
      themeLink.id = 'theme-style';
      themeLink.rel = 'stylesheet';
      document.head.appendChild(themeLink);
    }
    const href = `./${theme}.css`;
    const activateTheme = () => {
      document.documentElement.dataset['theme'] = theme;
      themeLink.onload = null;
      themeLink.onerror = null;
    };
    if (themeLink.getAttribute('href') === href && themeLink.sheet) {
      activateTheme();
      return;
    }
    themeLink.onload = activateTheme;
    themeLink.onerror = activateTheme;
    themeLink.setAttribute('href', href);
  }

  private mergeHostContext(context: Partial<HostContext> = {}): void {
    const lang = this.normalizeLang(context.lang || this.hostContext.lang);
    const theme = this.normalizeTheme(context.theme || this.hostContext.theme);
    this.hostContext = { ...this.hostContext, ...context, lang, theme };
  }

  private async applyHostContext(context: Partial<HostContext> = {}): Promise<void> {
    this.mergeHostContext(context);
    document.documentElement.lang = this.hostContext.lang;
    this.applyTheme(this.hostContext.theme);
    await this.loadI18n(this.hostContext.lang);
    this.refresh();
  }

  private async loadI18n(lang: string): Promise<void> {
    const normalized = this.normalizeLang(lang);
    const candidates = normalized === 'en' ? ['en'] : [normalized, 'en'];
    for (const candidate of candidates) {
      try {
        const response = await fetch(`/i18n/${candidate}.json`, { cache: 'no-store' });
        if (!response.ok) continue;
        const data = await response.json() as Record<string, Record<string, string>>;
        this.i18n = data[TOOL_NAMESPACE] || {};
        document.title = this.t('TITLE', TOOL_NAME);
        this.refresh();
        return;
      } catch {
        // Try the fallback language.
      }
    }
  }

  private async connectHost(): Promise<void> {
    if (!window.Penpal || !window.parent || window.parent === window) return;
    const messenger = new window.Penpal.WindowMessenger({
      remoteWindow: window.parent,
      allowedOrigins: ['*'],
    });
    const connection = window.Penpal.connect({
      messenger,
      methods: {
        setHostContext: (context: Partial<HostContext> = {}) => {
          void this.applyHostContext(context);
          return { ok: true };
        },
        focusTool: () => {
          window.focus();
          return { ok: true };
        },
        beforeClose: () => {
          this.saveDraft();
          return {
            canClose: true,
            connected: this.backendWs?.readyState === WebSocket.OPEN,
            converting: this.converting,
            draftSaved: true,
          };
        },
      },
    });

    try {
      this.hostRemote = await connection.promise;
      if (typeof this.hostRemote.getHostContext === 'function') {
        const context = await this.hostRemote.getHostContext();
        if (context) this.mergeHostContext(context);
      }
      if (this.backendStatus === 'ready') this.notifyHostReady();
    } catch (error) {
      console.warn('Video converter host connection failed:', error);
    }
  }

  private notifyHostReady(): void {
    if (typeof this.hostRemote?.childReady !== 'function') return;
    this.hostRemote.childReady({
      wsConnected: this.backendWs?.readyState === WebSocket.OPEN,
      backendStatus: this.backendStatus,
      pid: this.backendPid,
    });
  }

  private notifyHostError(error: unknown): void {
    if (typeof this.hostRemote?.childError !== 'function') return;
    this.hostRemote.childError({ message: this.errorMessage(error) });
  }

  private connectBackend(): void {
    this.backendWs?.close();
    this.rejectPending(new Error('Backend reconnecting'));
    this.backendStatus = 'connecting';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.backendWs = new WebSocket(`${protocol}//${window.location.host}/ws?token=${encodeURIComponent(this.token)}`);
    this.backendWs.addEventListener('open', () => void this.handleBackendOpen());
    this.backendWs.addEventListener('message', event => this.handleBackendMessage(String(event.data)));
    this.backendWs.addEventListener('close', () => {
      this.backendStatus = this.backendStatus === 'error' ? 'error' : 'closed';
      this.rejectPending(new Error('Backend WebSocket closed'));
      this.refresh();
    });
    this.backendWs.addEventListener('error', () => {
      this.backendStatus = 'error';
      this.notifyHostError(new Error('Backend WebSocket connection failed'));
      this.refresh();
    });
  }

  private async handleBackendOpen(): Promise<void> {
    try {
      const status = await this.request<Record<string, unknown>>('status');
      this.backendStatus = 'ready';
      this.backendPid = Number(status['pid'] || this.backendPid || 0);
      this.notifyHostReady();
    } catch (error) {
      this.backendStatus = 'error';
      this.notifyHostError(error);
    }
    this.refresh();
  }

  private request<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = 15_000): Promise<T> {
    if (!this.backendWs || this.backendWs.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('WebSocket is not connected'));
    }
    const id = ++this.requestSeq;
    const response = new Promise<T>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Request timed out: ${method}`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: value => resolve(value as T),
        reject,
        timeout,
      });
    });
    this.backendWs.send(JSON.stringify({ id, method, params }));
    return response;
  }

  private handleBackendMessage(raw: string): void {
    let message: Partial<RpcResponseMessage & RpcEventMessage>;
    try {
      message = JSON.parse(raw) as Partial<RpcResponseMessage & RpcEventMessage>;
    } catch (error) {
      this.notifyHostError(error);
      return;
    }
    if (typeof message.id === 'number') {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) return;
      window.clearTimeout(pending.timeout);
      this.pendingRequests.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(new Error(message.error || 'Video converter request failed'));
      return;
    }
    if (message.event === 'ready') {
      this.backendStatus = 'ready';
      this.backendPid = Number(message.data?.['pid'] || this.backendPid || 0);
      this.notifyHostReady();
      this.refresh();
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      window.clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private refresh(): void {
    try {
      this.cdr.detectChanges();
    } catch {
      // The component may already be destroyed.
    }
  }
}
