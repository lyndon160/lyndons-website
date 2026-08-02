/** Shared, serialisable contracts for puzzle generation and rendering. */

export type PuzzlePresetKey = "simple" | "balanced" | "detailed";

export interface PuzzlePreset {
  readonly key: PuzzlePresetKey;
  readonly label: string;
  readonly colours: number;
  readonly targetRegions: number;
  /** Internal SLIC controls are public so generation stays reproducible. */
  readonly superpixelMultiplier: number;
  readonly compactness: number;
}

export const PRESETS = {
  simple: {
    key: "simple",
    label: "Simple",
    colours: 8,
    targetRegions: 90,
    superpixelMultiplier: 2.25,
    compactness: 13,
  },
  balanced: {
    key: "balanced",
    label: "Balanced",
    colours: 12,
    targetRegions: 180,
    superpixelMultiplier: 2.4,
    compactness: 12,
  },
  detailed: {
    key: "detailed",
    label: "Detailed",
    colours: 16,
    targetRegions: 300,
    superpixelMultiplier: 2.6,
    compactness: 11,
  },
} as const satisfies Record<PuzzlePresetKey, PuzzlePreset>;

/** A more descriptive alias for consumers that prefer it. */
export const PUZZLE_PRESETS = PRESETS;

export const PUZZLE_PRESET_KEYS = Object.freeze([
  "simple",
  "balanced",
  "detailed",
] as const);

export function isPuzzlePresetKey(value: unknown): value is PuzzlePresetKey {
  return (
    typeof value === "string" &&
    Object.prototype.hasOwnProperty.call(PRESETS, value)
  );
}

export function getPreset(key: PuzzlePresetKey): PuzzlePreset {
  return PRESETS[key];
}

/**
 * Immutable generated puzzle data. Region IDs are contiguous and zero-based.
 * Every value in `regionMap` directly indexes the per-region arrays.
 */
export interface PuzzleDataV1 {
  readonly version: 1;
  readonly width: number;
  readonly height: number;
  readonly preset: PuzzlePresetKey;
  /** Packed RGB triplets; palette colour n starts at n * 3. */
  readonly palette: Uint8Array;
  /** A region ID for every source pixel. */
  readonly regionMap: Uint16Array;
  /** Palette index for every region. */
  readonly regionPalette: Uint16Array;
  readonly regionAreas: Uint32Array;
  /** Inclusive [minX, minY, maxX, maxY] for every region. */
  readonly regionBounds: Int32Array;
  /** Pixel-centre [x, y] number positions for every region. */
  readonly labelAnchors: Float32Array;
  readonly regionCount: number;
}

export type PuzzleGenerationPhase =
  | "preparing"
  | "smoothing"
  | "colour-space"
  | "superpixels"
  | "merging"
  | "palette"
  | "cleanup"
  | "labels"
  | "complete";

export interface PuzzleProgress {
  readonly phase: PuzzleGenerationPhase;
  /** Overall progress in the inclusive range 0..1. */
  readonly progress: number;
  readonly message?: string;
}

export type PuzzleWorkerErrorCode =
  | "INVALID_INPUT"
  | "UNSUPPORTED_DIMENSIONS"
  | "PROCESSING_FAILED"
  | "CANCELLED";

export interface PuzzleWorkerError {
  readonly code: PuzzleWorkerErrorCode;
  readonly message: string;
  readonly recoverable: boolean;
}

export interface PuzzleWorkerGenerateRequest {
  readonly type: "generate";
  readonly jobId: string;
  readonly width: number;
  readonly height: number;
  /** Packed RGBA pixels. Ownership is transferred to the worker. */
  readonly rgba: ArrayBuffer;
  readonly preset: PuzzlePresetKey;
}

export interface PuzzleWorkerCancelRequest {
  readonly type: "cancel";
  readonly jobId: string;
}

export type PuzzleWorkerRequest =
  | PuzzleWorkerGenerateRequest
  | PuzzleWorkerCancelRequest;

export interface PuzzleWorkerProgressResponse extends PuzzleProgress {
  readonly type: "progress";
  readonly jobId: string;
  readonly preset: PuzzlePresetKey;
}

export interface PuzzleWorkerCompleteResponse {
  readonly type: "complete";
  readonly jobId: string;
  readonly preset: PuzzlePresetKey;
  readonly puzzle: PuzzleDataV1;
}

export interface PuzzleWorkerErrorResponse {
  readonly type: "error";
  readonly jobId: string;
  readonly preset: PuzzlePresetKey;
  readonly error: PuzzleWorkerError;
}

export type PuzzleWorkerResponse =
  | PuzzleWorkerProgressResponse
  | PuzzleWorkerCompleteResponse
  | PuzzleWorkerErrorResponse;
