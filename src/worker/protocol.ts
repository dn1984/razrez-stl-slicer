// Протокол обмена между главным потоком и воркером геометрии.

import type { CutPreview, CutSettings, CutStats, PartGeometry, Vec3 } from '../geometry/types.ts';

export interface LoadRequest {
  type: 'load';
  id: number;
  positions: Float32Array;
  name: string;
}

export interface ComputeRequest {
  type: 'compute';
  id: number;
  cuts: CutSettings[];
}

export interface PreviewRequest {
  type: 'preview';
  id: number;
  cut: CutSettings;
  /** Второй рез — рисуется другим цветом, если включён. */
  extra?: CutSettings | null;
}

export interface ResetRequest {
  type: 'reset';
  id: number;
}

export type WorkerRequest = LoadRequest | ComputeRequest | PreviewRequest | ResetRequest;

export interface LoadedResponse {
  type: 'loaded';
  id: number;
  ok: boolean;
  error?: string;
  status: string;
  triangles: number;
  weldedVertices: number;
  degenerate: number;
  duplicate: number;
  volume: number;
  bboxMin: Vec3;
  bboxMax: Vec3;
  /** Геометрия исходной модели для отображения. */
  positions: Float32Array;
  indices: Uint32Array;
  ms: number;
}

export interface ResultResponse {
  type: 'result';
  id: number;
  ok: boolean;
  error?: string;
  parts: PartGeometry[];
  stats: CutStats[];
  previews: CutPreview[];
  ms: number;
  sourceVolume: number;
}

export interface PreviewResponse {
  type: 'preview';
  id: number;
  ok: boolean;
  error?: string;
  preview: CutPreview | null;
  /** Предпросмотр второго реза (если он включён). */
  extraPreview?: CutPreview | null;
  ms: number;
}

export interface ErrorResponse {
  type: 'error';
  id: number;
  message: string;
}

export type WorkerResponse = LoadedResponse | ResultResponse | PreviewResponse | ErrorResponse;
