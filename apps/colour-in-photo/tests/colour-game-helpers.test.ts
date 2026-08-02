import { describe, expect, it } from "vitest";

import {
  canAttemptPuzzleRegion,
  copySourcePixels,
  regionsAlongPuzzleSegment,
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
