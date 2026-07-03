// TypeScript declarations for SCAMP-wasm.

export type SCAMPProfileType =
  | '1NN_INDEX'
  | '1NN'
  | 'SUM_THRESH'
  | 'KNN'
  | 'MATRIX_SUMMARY';

export type SCAMPPrecision = 'single' | 'mixed' | 'double' | 'ultra';

export interface SCAMPArgs {
  /** REQUIRED. Time series A. */
  a: Float64Array | number[];
  /** Time series B for AB-joins. Omit for self-join. */
  b?: Float64Array | number[];
  /** REQUIRED. Matrix profile window (subsequence length). */
  window: number;
  profileType?: SCAMPProfileType;
  precision?: SCAMPPrecision;
  /** Report Pearson correlation rather than Euclidean distance. Default false. */
  pearson?: boolean;
  /** For SUM_THRESH / KNN: distance threshold in [-1, 1]. */
  threshold?: number;
  /** For KNN: max neighbours per column. */
  maxMatchesPerColumn?: number;
  /** For MATRIX_SUMMARY. */
  matrixHeight?: number;
  matrixWidth?: number;
  maxTileSize?: number;
  computingRows?: boolean;
  computingColumns?: boolean;
  keepRowsSeparate?: boolean;
  /** AB-joins: forbid trivial self-matches on the diagonal band. */
  isAligned?: boolean;
  silent?: boolean;
}

export interface KNNMatch {
  row: number;
  col: number;
  corr: number;
}

export interface MatrixSummary {
  values: Float32Array;
  height: number;
  width: number;
}

export type SCAMPResult = {
  profileType: string;
  window: number;
  a:
    | { profile: Float32Array; index?: Int32Array }
    | { profile: Float64Array }
    | KNNMatch[]
    | MatrixSummary;
  b?: SCAMPResult['a'];
};

export interface RunOptions {
  onProgress?: (done: number, total: number) => void;
  signal?: AbortSignal;
}

export interface CreateOptions {
  /** 'auto' (default): MT if crossOriginIsolated, else ST. */
  threads?: 'auto' | number;
  /** Directory (with trailing slash allowed) containing scamp-*.js/wasm/worker.js. Default './'. */
  baseUrl?: string;
}

export interface SCAMPClient {
  readonly threads: number;
  run(args: SCAMPArgs, opts?: RunOptions): Promise<SCAMPResult>;
  terminate(): Promise<void>;
}

export function create(opts?: CreateOptions): Promise<SCAMPClient>;

declare const SCAMP: { create: typeof create };
export default SCAMP;
