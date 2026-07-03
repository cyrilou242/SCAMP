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
  /**
   * Called with a decoded snapshot of the current profile after each
   * tile completes. Only fires in the single-threaded wasm build; the
   * MT build documents this hook as unsupported (Emscripten's `val`
   * cannot cross worker-pthread ↔ main-pthread boundaries safely).
   */
  onSnapshot?: (snapshot: SCAMPResult['a'], done: number, total: number) => void;
  signal?: AbortSignal;
  /**
   * If true, transfer input TypedArray buffers to the worker rather
   * than copying. Faster but detaches the caller's arrays. Default false.
   */
  transfer?: boolean;
}

export interface CreateOptions {
  /** 'auto' (default): MT if crossOriginIsolated, else ST. */
  threads?: 'auto' | number;
  /** Directory (with trailing slash allowed) containing scamp-*.js/wasm/worker.js. Default './'. */
  baseUrl?: string;
}

export interface SumOpts extends RunOptions {
  threshold?: number;
}
export interface MatrixOpts extends RunOptions {
  matrixHeight?: number;
  matrixWidth?: number;
}

export interface SCAMPClient {
  readonly threads: number;
  run(args: SCAMPArgs, opts?: RunOptions): Promise<SCAMPResult>;
  terminate(): Promise<void>;

  /** Sugar helpers mirroring pyscamp's function surface. */
  selfJoin(a: Float64Array | number[], window: number, opts?: RunOptions): Promise<SCAMPResult>;
  selfJoin1NN(a: Float64Array | number[], window: number, opts?: RunOptions): Promise<SCAMPResult>;
  selfJoinSum(a: Float64Array | number[], window: number, opts?: SumOpts): Promise<SCAMPResult>;
  selfJoinMatrix(a: Float64Array | number[], window: number, opts?: MatrixOpts): Promise<SCAMPResult>;

  abJoin(a: Float64Array | number[], b: Float64Array | number[], window: number, opts?: RunOptions): Promise<SCAMPResult>;
  abJoin1NN(a: Float64Array | number[], b: Float64Array | number[], window: number, opts?: RunOptions): Promise<SCAMPResult>;
  abJoinSum(a: Float64Array | number[], b: Float64Array | number[], window: number, opts?: SumOpts): Promise<SCAMPResult>;
  abJoinMatrix(a: Float64Array | number[], b: Float64Array | number[], window: number, opts?: MatrixOpts): Promise<SCAMPResult>;
}

export function create(opts?: CreateOptions): Promise<SCAMPClient>;

declare const SCAMP: { create: typeof create };
export default SCAMP;
