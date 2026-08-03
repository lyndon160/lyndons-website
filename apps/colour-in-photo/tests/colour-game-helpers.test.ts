import { describe, expect, it } from "vitest";

import {
  calculateWorkingDimensions,
  canAttemptPuzzleRegion,
  copySourcePixels,
  findHintTarget,
  regionsAlongPuzzleSegment,
  validatePhotoFile,
} from "../app/components/ColourGame";
import type { PuzzleDataV1 } from "../app/lib/puzzle-types";

function makePuzzle(regionMap = new Uint16Array([0, 0, 1, 2, 2])): PuzzleDataV1 {
  return {
    version: 1,
    width: regionMap.length,
    height: 1,
    preset: "balanced",
    palette: new Uint8Array([220, 70, 60, 70, 120, 220, 80, 170, 100]),
    regionMap,
    regionPalette: new Uint16Array([0, 1, 2]),
    regionAreas: new Uint32Array([2, 1, 2]),
    regionBounds: new Int32Array([
      0, 0, 1, 0,
      2, 0, 2, 0,
      3, 0, 4, 0,
    ]),
    labelAnchors: new Float32Array([0.5, 0.5, 2.5, 0.5, 3.5, 0.5]),
    regionCount: 3,
  };
}

describe("shipped ColourGame helpers", () => {
  it("accepts supported photos regardless of their compressed file size", () => {
    expect(
      validatePhotoFile({
        name: "large-photo.jpg",
        size: 85 * 1024 * 1024,
        type: "image/jpeg",
      }),
    ).toBeUndefined();
  });

  it("still rejects unsupported file formats", () => {
    expect(
      validatePhotoFile({
        name: "large-photo.tiff",
        size: 85 * 1024 * 1024,
        type: "image/tiff",
      }),
    ).toMatch(/JPEG, PNG, WebP, or HEIC/);
  });

  it.each([
    [6_000, 4_000],
    [4_000, 6_000],
    [4_032, 3_024],
    [3_024, 4_032],
    [8_000, 1_000],
    [1_002, 999],
  ])(
    "scales %i × %i photos within both working-resolution caps",
    (sourceWidth, sourceHeight) => {
      const result = calculateWorkingDimensions(sourceWidth, sourceHeight);

      expect(result.resized).toBe(true);
      expect(Math.max(result.width, result.height)).toBeLessThanOrEqual(1_400);
      expect(result.width * result.height).toBeLessThanOrEqual(1_000_000);
      expect(result.width / result.height).toBeCloseTo(
        sourceWidth / sourceHeight,
        2,
      );
    },
  );

  it("leaves photos already within the working resolution unchanged", () => {
    expect(calculateWorkingDimensions(1_200, 800)).toEqual({
      width: 1_200,
      height: 800,
      resized: false,
    });
  });

  it("targets the largest unfinished section of the selected colour on request", () => {
    const puzzle = {
      ...makePuzzle(),
      regionPalette: new Uint16Array([0, 0, 1]),
      regionAreas: new Uint32Array([2, 8, 4]),
    };
    const filled = new Uint8Array([0, 0, 0]);

    expect(findHintTarget(puzzle, filled, 0)).toEqual({
      regionId: 1,
      paletteIndex: 0,
    });

    filled[1] = 1;
    expect(findHintTarget(puzzle, filled, 0)).toEqual({
      regionId: 0,
      paletteIndex: 0,
    });
  });

  it("moves an explicit hint to the next unfinished colour", () => {
    const puzzle = {
      ...makePuzzle(),
      regionPalette: new Uint16Array([0, 0, 1]),
      regionAreas: new Uint32Array([2, 8, 4]),
    };
    const filled = new Uint8Array([1, 1, 0]);

    expect(findHintTarget(puzzle, filled, 0)).toEqual({
      regionId: 2,
      paletteIndex: 1,
    });

    filled[2] = 1;
    expect(findHintTarget(puzzle, filled, 0)).toBeNull();
  });

  it("copies retained source pixels before a worker transfer", () => {
    const source = new Uint8ClampedArray([4, 8, 15, 16, 23, 42]);
    const workerCopy = copySourcePixels(source);

    expect(workerCopy).not.toBe(source);
    expect(workerCopy.buffer).not.toBe(source.buffer);
    expect(workerCopy).toEqual(source);

    workerCopy[0] = 255;
    expect(source[0]).toBe(4);
  });

  it("blocks painting while comparing or complete", () => {
    const puzzle = makePuzzle();

    expect(canAttemptPuzzleRegion(puzzle, false, false, 1)).toBe(true);
    expect(canAttemptPuzzleRegion(puzzle, false, true, 1)).toBe(false);
    expect(canAttemptPuzzleRegion(puzzle, true, false, 1)).toBe(false);
    expect(canAttemptPuzzleRegion(puzzle, false, false, -1)).toBe(false);
    expect(canAttemptPuzzleRegion(puzzle, false, false, 3)).toBe(false);
    expect(canAttemptPuzzleRegion(puzzle, false, false, 0.5)).toBe(false);
    expect(canAttemptPuzzleRegion(null, false, false, 0)).toBe(false);
  });

  it("visits every crossed region, including a one-pixel section", () => {
    const puzzle = makePuzzle();

    expect(
      regionsAlongPuzzleSegment(
        puzzle,
        { x: -10, y: 0.5 },
        { x: 10, y: 0.5 },
      ),
    ).toEqual([0, 1, 2]);
  });

  it("clips strokes that miss the puzzle and preserves re-entry order", () => {
    const puzzle = makePuzzle(new Uint16Array([0, 1, 0]));

    expect(
      regionsAlongPuzzleSegment(
        { ...puzzle, width: 3, regionAreas: new Uint32Array([2, 1, 0]) },
        { x: 0.2, y: 0.5 },
        { x: 2.8, y: 0.5 },
      ),
    ).toEqual([0, 1, 0]);
    expect(
      regionsAlongPuzzleSegment(
        puzzle,
        { x: -5, y: -2 },
        { x: 8, y: -2 },
      ),
    ).toEqual([]);
  });
});
