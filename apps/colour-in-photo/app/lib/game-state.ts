import type { PuzzleDataV1 } from "./puzzle-types";

/** The interaction-only state kept separately from immutable puzzle data. */
export interface GameState {
  readonly selectedPalette: number | null;
  /** One byte per region. Any non-zero value means the region is complete. */
  readonly filled: Uint8Array;
  /** Region IDs in the order they were filled. */
  readonly undoStack: readonly number[];
}

export type FillFailureReason =
  | "invalid-region"
  | "invalid-palette"
  | "already-filled"
  | "wrong-colour";

export interface FillValidation {
  readonly allowed: boolean;
  readonly reason: FillFailureReason | null;
  readonly regionId: number | null;
  readonly selectedPalette: number | null;
  readonly expectedPalette: number | null;
}

export interface FillAttempt {
  readonly state: GameState;
  readonly status: "filled" | FillFailureReason;
  readonly regionId: number | null;
  readonly expectedPalette: number | null;
}

export interface GameProgress {
  readonly filledArea: number;
  readonly totalArea: number;
  readonly percentage: number;
  readonly filledRegions: number;
  readonly totalRegions: number;
  readonly complete: boolean;
}

/** Maps puzzle coordinates to local viewport/canvas coordinates. */
export interface ViewTransform {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

export interface PuzzlePoint {
  readonly x: number;
  readonly y: number;
}

export type Rgb = readonly [red: number, green: number, blue: number];

export interface FlatColourBufferOptions {
  /** Omit to render the completed puzzle. */
  readonly filled?: ArrayLike<number>;
  /** Used only for regions not marked as filled. */
  readonly unfilledColour?: Rgb;
}

function paletteCount(puzzle: PuzzleDataV1): number {
  return Math.floor(puzzle.palette.length / 3);
}

function isValidRegion(puzzle: PuzzleDataV1, regionId: number): boolean {
  return (
    Number.isInteger(regionId) && regionId >= 0 && regionId < puzzle.regionCount
  );
}

function isFilled(filled: ArrayLike<number>, regionId: number): boolean {
  return regionId < filled.length && filled[regionId] !== 0;
}

/** Number of unfinished regions for each palette colour. */
export function remainingRegionsByPalette(
  puzzle: PuzzleDataV1,
  filled: ArrayLike<number>,
): Uint32Array {
  const remaining = new Uint32Array(paletteCount(puzzle));

  for (let regionId = 0; regionId < puzzle.regionCount; regionId += 1) {
    if (isFilled(filled, regionId)) continue;

    const paletteIndex = puzzle.regionPalette[regionId];
    if (paletteIndex < remaining.length) remaining[paletteIndex] += 1;
  }

  return remaining;
}

/**
 * Finds the next unfinished palette after `currentPalette`, wrapping once.
 * Passing null starts at colour zero. Returns null when the puzzle is complete.
 */
export function selectNextPalette(
  puzzle: PuzzleDataV1,
  filled: ArrayLike<number>,
  currentPalette: number | null = null,
): number | null {
  const remaining = remainingRegionsByPalette(puzzle, filled);
  if (remaining.length === 0) return null;

  const start =
    currentPalette === null ||
    !Number.isInteger(currentPalette) ||
    currentPalette < 0 ||
    currentPalette >= remaining.length
      ? 0
      : (currentPalette + 1) % remaining.length;

  for (let offset = 0; offset < remaining.length; offset += 1) {
    const paletteIndex = (start + offset) % remaining.length;
    if (remaining[paletteIndex] > 0) return paletteIndex;
  }

  return null;
}

export function resetGameState(
  puzzle: PuzzleDataV1,
  preferredPalette: number | null = 0,
): GameState {
  const filled = new Uint8Array(puzzle.regionCount);
  const remaining = remainingRegionsByPalette(puzzle, filled);
  const hasPreferred =
    preferredPalette !== null &&
    Number.isInteger(preferredPalette) &&
    preferredPalette >= 0 &&
    preferredPalette < remaining.length &&
    remaining[preferredPalette] > 0;

  return {
    selectedPalette: hasPreferred
      ? preferredPalette
      : selectNextPalette(puzzle, filled),
    filled,
    undoStack: [],
  };
}

export function createGameState(
  puzzle: PuzzleDataV1,
  preferredPalette: number | null = 0,
): GameState {
  return resetGameState(puzzle, preferredPalette);
}

/** Returns a new state when the requested palette can still be used. */
export function selectPalette(
  state: GameState,
  puzzle: PuzzleDataV1,
  paletteIndex: number,
): GameState {
  const remaining = remainingRegionsByPalette(puzzle, state.filled);
  if (
    !Number.isInteger(paletteIndex) ||
    paletteIndex < 0 ||
    paletteIndex >= remaining.length ||
    remaining[paletteIndex] === 0 ||
    state.selectedPalette === paletteIndex
  ) {
    return state;
  }

  return { ...state, selectedPalette: paletteIndex };
}

export function validateFill(
  puzzle: PuzzleDataV1,
  filled: ArrayLike<number>,
  selectedPalette: number | null,
  regionId: number,
): FillValidation {
  if (!isValidRegion(puzzle, regionId)) {
    return {
      allowed: false,
      reason: "invalid-region",
      regionId: null,
      selectedPalette,
      expectedPalette: null,
    };
  }

  const expectedPalette = puzzle.regionPalette[regionId];
  if (
    selectedPalette === null ||
    !Number.isInteger(selectedPalette) ||
    selectedPalette < 0 ||
    selectedPalette >= paletteCount(puzzle)
  ) {
    return {
      allowed: false,
      reason: "invalid-palette",
      regionId,
      selectedPalette,
      expectedPalette,
    };
  }

  if (isFilled(filled, regionId)) {
    return {
      allowed: false,
      reason: "already-filled",
      regionId,
      selectedPalette,
      expectedPalette,
    };
  }

  if (expectedPalette !== selectedPalette) {
    return {
      allowed: false,
      reason: "wrong-colour",
      regionId,
      selectedPalette,
      expectedPalette,
    };
  }

  return {
    allowed: true,
    reason: null,
    regionId,
    selectedPalette,
    expectedPalette,
  };
}

/**
 * Atomically fills a matching region. Invalid attempts preserve the exact state
 * object so pointer drags can cheaply ignore duplicate or wrong-colour hits.
 */
export function attemptFill(
  state: GameState,
  puzzle: PuzzleDataV1,
  regionId: number,
): FillAttempt {
  const validation = validateFill(
    puzzle,
    state.filled,
    state.selectedPalette,
    regionId,
  );

  if (!validation.allowed) {
    return {
      state,
      status: validation.reason ?? "invalid-region",
      regionId: validation.regionId,
      expectedPalette: validation.expectedPalette,
    };
  }

  const filled = state.filled.slice();
  filled[regionId] = 1;

  const selectedPalette =
    state.selectedPalette !== null &&
    remainingRegionsByPalette(puzzle, filled)[state.selectedPalette] > 0
      ? state.selectedPalette
      : selectNextPalette(puzzle, filled, state.selectedPalette);

  return {
    state: {
      selectedPalette,
      filled,
      undoStack: [...state.undoStack, regionId],
    },
    status: "filled",
    regionId,
    expectedPalette: validation.expectedPalette,
  };
}

/** A semantic alias useful in reducer-style UI code. */
export const fillRegion = attemptFill;

/** Undoes the most recent valid fill and reselects that region's colour. */
export function undoLastFill(
  state: GameState,
  puzzle: PuzzleDataV1,
): GameState {
  for (let index = state.undoStack.length - 1; index >= 0; index -= 1) {
    const regionId = state.undoStack[index];
    if (!isValidRegion(puzzle, regionId) || !isFilled(state.filled, regionId)) {
      continue;
    }

    const filled = state.filled.slice();
    filled[regionId] = 0;
    return {
      selectedPalette: puzzle.regionPalette[regionId],
      filled,
      undoStack: state.undoStack.slice(0, index),
    };
  }

  return state;
}

/** Area-weighted progress; region count is supplied as secondary UI context. */
export function calculateProgress(
  puzzle: PuzzleDataV1,
  filled: ArrayLike<number>,
): GameProgress {
  let totalArea = 0;
  let filledArea = 0;
  let filledRegions = 0;

  for (let regionId = 0; regionId < puzzle.regionCount; regionId += 1) {
    const area = puzzle.regionAreas[regionId] ?? 0;
    totalArea += area;
    if (!isFilled(filled, regionId)) continue;
    filledArea += area;
    filledRegions += 1;
  }

  const complete = filledRegions === puzzle.regionCount;
  const ratio =
    totalArea > 0
      ? filledArea / totalArea
      : puzzle.regionCount === 0
        ? 1
        : filledRegions / puzzle.regionCount;

  return {
    filledArea,
    totalArea,
    percentage: Math.min(100, Math.max(0, ratio * 100)),
    filledRegions,
    totalRegions: puzzle.regionCount,
    complete,
  };
}

/** Inverts a scale/translation without coupling hit testing to the DOM. */
export function screenToPuzzlePoint(
  screenX: number,
  screenY: number,
  transform: ViewTransform,
): PuzzlePoint | null {
  if (
    !Number.isFinite(screenX) ||
    !Number.isFinite(screenY) ||
    !Number.isFinite(transform.scale) ||
    transform.scale <= 0 ||
    !Number.isFinite(transform.offsetX) ||
    !Number.isFinite(transform.offsetY)
  ) {
    return null;
  }

  return {
    x: (screenX - transform.offsetX) / transform.scale,
    y: (screenY - transform.offsetY) / transform.scale,
  };
}

/** Constant-time region lookup after inverting the current view transform. */
export function hitTestRegion(
  puzzle: PuzzleDataV1,
  screenX: number,
  screenY: number,
  transform: ViewTransform,
): number | null {
  const point = screenToPuzzlePoint(screenX, screenY, transform);
  if (point === null) return null;

  const x = Math.floor(point.x);
  const y = Math.floor(point.y);
  if (x < 0 || y < 0 || x >= puzzle.width || y >= puzzle.height) {
    return null;
  }

  const regionId = puzzle.regionMap[y * puzzle.width + x];
  return isValidRegion(puzzle, regionId) ? regionId : null;
}

function normaliseRgb(colour: Rgb): Rgb {
  return [
    Math.min(255, Math.max(0, Math.round(colour[0]))),
    Math.min(255, Math.max(0, Math.round(colour[1]))),
    Math.min(255, Math.max(0, Math.round(colour[2]))),
  ];
}

/**
 * Creates packed RGBA pixels made only from exact palette RGB values. The
 * default renders every region, so exported PNGs contain no outlines, numbers,
 * source texture, or partially coloured pixels.
 */
export function createFlatColourBuffer(
  puzzle: PuzzleDataV1,
  options: FlatColourBufferOptions = {},
): Uint8ClampedArray {
  if (
    !Number.isInteger(puzzle.width) ||
    !Number.isInteger(puzzle.height) ||
    puzzle.width < 0 ||
    puzzle.height < 0 ||
    puzzle.regionMap.length !== puzzle.width * puzzle.height
  ) {
    throw new RangeError("Puzzle dimensions and region map do not match.");
  }

  if (puzzle.palette.length % 3 !== 0) {
    throw new RangeError("Puzzle palette must contain packed RGB triplets.");
  }

  const rgba = new Uint8ClampedArray(puzzle.regionMap.length * 4);
  const unfilled = normaliseRgb(options.unfilledColour ?? [248, 246, 239]);

  for (let pixelIndex = 0; pixelIndex < puzzle.regionMap.length; pixelIndex += 1) {
    const regionId = puzzle.regionMap[pixelIndex];
    if (!isValidRegion(puzzle, regionId)) {
      throw new RangeError(`Pixel ${pixelIndex} references an invalid region.`);
    }

    const shouldRender =
      options.filled === undefined || isFilled(options.filled, regionId);
    const paletteIndex = puzzle.regionPalette[regionId];
    if (shouldRender && paletteIndex >= paletteCount(puzzle)) {
      throw new RangeError(`Region ${regionId} references an invalid palette colour.`);
    }

    const outputIndex = pixelIndex * 4;
    const colourOffset = paletteIndex * 3;
    rgba[outputIndex] = shouldRender
      ? puzzle.palette[colourOffset]
      : unfilled[0];
    rgba[outputIndex + 1] = shouldRender
      ? puzzle.palette[colourOffset + 1]
      : unfilled[1];
    rgba[outputIndex + 2] = shouldRender
      ? puzzle.palette[colourOffset + 2]
      : unfilled[2];
    rgba[outputIndex + 3] = 255;
  }

  return rgba;
}

/** Explicit completion-only name for download/export call sites. */
export function createFlatColourExportBuffer(
  puzzle: PuzzleDataV1,
): Uint8ClampedArray {
  return createFlatColourBuffer(puzzle);
}
