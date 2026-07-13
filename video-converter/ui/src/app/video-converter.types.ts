import type { AilyPixelFormat, MonoConversionOptions } from './aily-video-format';

export interface VideoConversionRequest {
  type: 'convert';
  requestId: number;
  fileName: string;
  mimeType: string;
  buffer: ArrayBuffer;
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  maxFrames: number;
  pixelFormat: AilyPixelFormat;
  loop: boolean;
  monoOptions: MonoConversionOptions;
}

export type VideoConversionStage = 'preparing' | 'parsing' | 'decoding' | 'packing';

export interface VideoConversionProgressMessage {
  type: 'progress';
  requestId: number;
  stage: VideoConversionStage;
  progress: number;
  current?: number;
  total?: number;
}

export interface VideoConversionResult {
  fileBuffer: ArrayBuffer;
  width: number;
  height: number;
  fpsNumerator: number;
  fpsDenominator: number;
  frameCount: number;
  frameSize: number;
  dataSize: number;
  pixelFormat: AilyPixelFormat;
  loop: boolean;
  isVideoSource: boolean;
  sourceName: string;
  sourceType: string;
  maxFramesApplied: number;
  frameLimitReduced: boolean;
}

export interface VideoConversionDoneMessage {
  type: 'done';
  requestId: number;
  result: VideoConversionResult;
}

export interface VideoConversionErrorMessage {
  type: 'error';
  requestId: number;
  message: string;
  code?: string;
}

export type VideoConverterWorkerMessage =
  | VideoConversionProgressMessage
  | VideoConversionDoneMessage
  | VideoConversionErrorMessage;
