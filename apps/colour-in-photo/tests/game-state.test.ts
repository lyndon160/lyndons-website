import { describe, expect, it } from "vitest";

import {
  attemptFill,
  calculateProgress,
  createFlatColourBuffer,
  createFlatColourExportBuffer,
  createGameState,
  hitTestRegion,
  remainingRegionsByPalette,
  resetGameState,
  selectNextPalette,
  selectPalette,
  undoLastFill,
  validateFill,
} from "../app/lib/game-state";
import type { PuzzleDataV1 } from "../app/lib/puzzle-types";

function makePuzzle(): PuzzleDataV1 {
  return {
    version: 1,
    width: 4,
    height: 2,
    preset: "balanced",
    palette: new Uint8Array([255, 0, 0, 0, 128, 64]),
    regionMap: new Uint16Array([
      0, 0, 1, 1,
      0, 2, 2, 1,
    ]),
    regionPalette: new Uint16Array([0, 1, 0]),
    regionAreas: new Uint32Array([3, 3, 2]),
    regionBounds: new Int32Array([
      0, 0, 1, 1,
      2, 0, 3, 1,
      1, 1, 2, 1,
    ]),
    labelAnchors: new Float32Array([0, 0, 3, 0, 1.5, 1]),
    regionCount: 3,
  };
}

describe("game state", () => {
  it("validates matching, wrong, repeated, and invalid fills", () => {
    const puzzle = makePuzzle();
    const filled = new Uint8Array(3);

    expect(validateFill(puzzle, filled, 0, 0)).toMatchObject({
      allowed: true,
      reason: null,
      expectedPalette: 0,
    });
    expect(validateFill(puzzle, filled, 0, 1)).toMatchObject({
      allowed: false,
      reason: "wrong-colour",
      expectedPalette: 1,
    });

    filled[0] = 1;
    expect(validateFill(puzzle, filled, 0, 0).reason).toBe("already-filled");
    expect(validateFill(puzzle, filled, 0, 99).reason).toBe("invalid-region");
    expect(validateFill(puzzle, filled, null, 2).reason).toBe(
      "invalid-palette",
    );
  });

  it("fills atomically, ignores drag duplicates, and advances the palette", () => {
    const puzzle = makePuzzle();
    const initial = createGameState(puzzle);
    const wrong = attemptFill(initial, puzzle, 1);
    expect(wrong.status).toBe("wrong-colour");
    expect(wrong.state).toBe(initial);

    const first = attemptFill(initial, puzzle, 0);
    expect(first.status).toBe("filled");
    expect(first.state.filled).not.toBe(initial.filled);
    expect(initial.filled[0]).toBe(0);
    expect(first.state.selectedPalette).toBe(0);

    const duplicate = attemptFill(first.state, puzzle, 0);
    expect(duplicate.status).toBe("already-filled");
    expect(duplicate.state).toBe(first.state);

    const second = attemptFill(first.state, puzzle, 2);
    expect(second.state.selectedPalette).toBe(1);
    expect(second.state.undoStack).toEqual([0, 2]);
  });

  it("selects only colours with unfinished regions", () => {
    const puzzle = makePuzzle();
    const filled = new Uint8Array([1, 0, 1]);

    expect([...remainingRegionsByPalette(puzzle, filled)]).toEqual([0, 1]);
    expect(selectNextPalette(puzzle, filled, 0)).toBe(1);
    expect(selectNextPalette(puzzle, new Uint8Array([1, 1, 1]), 1)).toBeNull();

    const state = createGameState(puzzle);
    expect(selectPalette(state, puzzle, 1).selectedPalette).toBe(1);
    expect(selectPalette(state, puzzle, 99)).toBe(state);
  });

  it("calculates progress by pixel area rather than region count", () => {
    const progress = calculateProgress(
      makePuzzle(),
      new Uint8Array([1, 0, 1]),
    );

    expect(progress).toEqual({
      filledArea: 5,
      totalArea: 8,
      percentage: 62.5,
      filledRegions: 2,
      totalRegions: 3,
      complete: false,
    });
  });

  it("undoes the last fill and resets without mutating the old state", () => {
    const puzzle = makePuzzle();
    const first = attemptFill(createGameState(puzzle), puzzle, 0).state;
    const second = attemptFill(first, puzzle, 2).state;
    const undone = undoLastFill(second, puzzle);

    expect(undone.filled).toEqual(new Uint8Array([1, 0, 0]));
    expect(second.filled).toEqual(new Uint8Array([1, 0, 1]));
    expect(undone.selectedPalette).toBe(0);
    expect(undone.undoStack).toEqual([0]);

    const reset = resetGameState(puzzle, 1);
    expect(reset.filled).toEqual(new Uint8Array(3));
    expect(reset.selectedPalette).toBe(1);
    expect(reset.undoStack).toEqual([]);
  });
});

describe("transformed hit testing", () => {
  it("inverts pan and zoom before its constant-time region lookup", () => {
    const puzzle = makePuzzle();
    const transform = { scale: 2, offsetX: 10, offsetY: 20 };

    expect(hitTestRegion(puzzle, 14.4, 22.4, transform)).toBe(2);
    expect(hitTestRegion(puzzle, 10.2, 20.2, transform)).toBe(0);
    expect(hitTestRegion(puzzle, 9.9, 20, transform)).toBeNull();
    expect(hitTestRegion(puzzle, 18, 20, transform)).toBeNull();
    expect(
      hitTestRegion(puzzle, 10, 20, { ...transform, scale: 0 }),
    ).toBeNull();
  });
});

describe("flat colour buffer", () => {
  it("renders every completed pixel as an exact opaque palette colour", () => {
    const puzzle = makePuzzle();
    const rgba = createFlatColourExportBuffer(puzzle);

    expect(rgba).toHaveLength(puzzle.width * puzzle.height * 4);
    for (let pixel = 0; pixel < puzzle.regionMap.length; pixel += 1) {
      const regionId = puzzle.regionMap[pixel];
      const paletteIndex = puzzle.regionPalette[regionId];
      const source = paletteIndex * 3;
      const output = pixel * 4;
      expect([...rgba.slice(output, output + 4)]).toEqual([
        puzzle.palette[source],
        puzzle.palette[source + 1],
        puzzle.palette[source + 2],
        255,
      ]);
    }
  });

  it("can render an interaction buffer while keeping fills atomic", () => {
    const rgba = createFlatColourBuffer(makePuzzle(), {
      filled: new Uint8Array([0, 1, 0]),
      unfilledColour: [250, 249, 245],
    });

    expect([...rgba.slice(0, 4)]).toEqual([250, 249, 245, 255]);
    expect([...rgba.slice(8, 12)]).toEqual([0, 128, 64, 255]);
  });

  it("rejects malformed maps instead of leaking partial export pixels", () => {
    const puzzle = makePuzzle();
    const malformed = {
      ...puzzle,
      regionMap: new Uint16Array([0]),
    } satisfies PuzzleDataV1;

    expect(() => createFlatColourExportBuffer(malformed)).toThrow(RangeError);
  });
});
