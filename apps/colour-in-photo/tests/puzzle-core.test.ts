import { describe, expect, it } from "vitest";
import {
  generatePuzzle,
  minimumRegionArea,
  PuzzleGenerationError,
} from "../app/lib/puzzle-core";
import type { PuzzleDataV1 } from "../app/lib/puzzle-types";

function syntheticPhoto(width = 72, height = 54): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (y * width + x) * 4;
      const dx = x - width * 0.54;
      const dy = y - height * 0.48;
      const inCircle = dx * dx + dy * dy < Math.min(width, height) ** 2 * 0.12;
      rgba[offset] = inCircle ? 225 : Math.round(35 + (190 * x) / width);
      rgba[offset + 1] = inCircle
        ? Math.round(70 + (90 * y) / height)
        : Math.round(45 + (165 * y) / height);
      rgba[offset + 2] =
        (Math.floor(x / 12) + Math.floor(y / 10)) % 2 === 0 ? 78 : 174;
      rgba[offset + 3] = x < 3 && y < 3 ? 160 : 255;
    }
  }
  // A deliberately impractical island exercises small-region cleanup.
  const island = (Math.floor(height * 0.8) * width + Math.floor(width * 0.15)) * 4;
  rgba[island] = 255;
  rgba[island + 1] = 0;
  rgba[island + 2] = 255;
  rgba[island + 3] = 255;
  return rgba;
}

function expectSameTypedArray(
  first: ArrayLike<number>,
  second: ArrayLike<number>,
): void {
  expect(first.length).toBe(second.length);
  for (let index = 0; index < first.length; index += 1) {
    expect(first[index]).toBe(second[index]);
  }
}

function assertPuzzleInvariants(puzzle: PuzzleDataV1): void {
  const { width, height, regionCount } = puzzle;
  expect(regionCount).toBeGreaterThan(0);
  expect(puzzle.regionMap).toHaveLength(width * height);
  expect(puzzle.regionPalette).toHaveLength(regionCount);
  expect(puzzle.regionAreas).toHaveLength(regionCount);
  expect(puzzle.regionBounds).toHaveLength(regionCount * 4);
  expect(puzzle.labelAnchors).toHaveLength(regionCount * 2);
  expect(puzzle.palette.length % 3).toBe(0);

  const paletteCount = puzzle.palette.length / 3;
  const countedAreas = new Uint32Array(regionCount);
  for (let pixel = 0; pixel < puzzle.regionMap.length; pixel += 1) {
    const region = puzzle.regionMap[pixel];
    expect(region).toBeLessThan(regionCount);
    countedAreas[region] += 1;
  }
  expectSameTypedArray(countedAreas, puzzle.regionAreas);
  expect(puzzle.regionAreas.reduce((sum, area) => sum + area, 0)).toBe(width * height);

  for (let region = 0; region < regionCount; region += 1) {
    expect(puzzle.regionPalette[region]).toBeLessThan(paletteCount);
    const x = Math.floor(puzzle.labelAnchors[region * 2]);
    const y = Math.floor(puzzle.labelAnchors[region * 2 + 1]);
    expect(x).toBeGreaterThanOrEqual(puzzle.regionBounds[region * 4]);
    expect(y).toBeGreaterThanOrEqual(puzzle.regionBounds[region * 4 + 1]);
    expect(x).toBeLessThanOrEqual(puzzle.regionBounds[region * 4 + 2]);
    expect(y).toBeLessThanOrEqual(puzzle.regionBounds[region * 4 + 3]);
    expect(puzzle.regionMap[y * width + x]).toBe(region);
  }

  const visited = new Uint8Array(width * height);
  const regionHasComponent = new Uint8Array(regionCount);
  const queue = new Int32Array(width * height);
  for (let start = 0; start < puzzle.regionMap.length; start += 1) {
    if (visited[start]) continue;
    const region = puzzle.regionMap[start];
    expect(regionHasComponent[region]).toBe(0);
    regionHasComponent[region] = 1;
    let head = 0;
    let tail = 1;
    let componentArea = 0;
    queue[0] = start;
    visited[start] = 1;
    while (head < tail) {
      const pixel = queue[head];
      head += 1;
      componentArea += 1;
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (x > 0) visit(pixel - 1);
      if (x + 1 < width) visit(pixel + 1);
      if (y > 0) visit(pixel - width);
      if (y + 1 < height) visit(pixel + width);
    }
    expect(componentArea).toBe(puzzle.regionAreas[region]);

    function visit(neighbour: number): void {
      if (!visited[neighbour] && puzzle.regionMap[neighbour] === region) {
        visited[neighbour] = 1;
        queue[tail] = neighbour;
        tail += 1;
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const region = puzzle.regionMap[pixel];
      if (x + 1 < width) assertDifferentNumberAcrossBoundary(region, puzzle.regionMap[pixel + 1]);
      if (y + 1 < height) assertDifferentNumberAcrossBoundary(region, puzzle.regionMap[pixel + width]);
    }
  }

  function assertDifferentNumberAcrossBoundary(first: number, second: number): void {
    if (first !== second) {
      expect(puzzle.regionPalette[first]).not.toBe(puzzle.regionPalette[second]);
    }
  }
}

describe("generatePuzzle", () => {
  it("is deterministic and returns connected, indexed regions", () => {
    const width = 72;
    const height = 54;
    const rgba = syntheticPhoto(width, height);
    const progress: number[] = [];
    const first = generatePuzzle({
      width,
      height,
      rgba,
      preset: "balanced",
      onProgress: (update) => progress.push(update.progress),
    });
    const second = generatePuzzle({
      width,
      height,
      rgba: rgba.slice(),
      preset: "balanced",
    });

    assertPuzzleInvariants(first);
    expect(first.version).toBe(1);
    expect(first.preset).toBe("balanced");
    expect(progress.at(0)).toBeGreaterThan(0);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((value, index) => index === 0 || value >= progress[index - 1])).toBe(true);
    expectSameTypedArray(first.palette, second.palette);
    expectSameTypedArray(first.regionMap, second.regionMap);
    expectSameTypedArray(first.regionPalette, second.regionPalette);
    expectSameTypedArray(first.regionAreas, second.regionAreas);
    expectSameTypedArray(first.regionBounds, second.regionBounds);
    expectSameTypedArray(first.labelAnchors, second.labelAnchors);
  });

  it("removes tiny islands and merges adjacent regions with the same number", () => {
    const width = 96;
    const height = 72;
    const puzzle = generatePuzzle({
      width,
      height,
      rgba: syntheticPhoto(width, height),
      preset: "balanced",
    });
    const threshold = minimumRegionArea(width, height, "balanced");
    expect(Math.min(...puzzle.regionAreas)).toBeGreaterThanOrEqual(threshold);
    assertPuzzleInvariants(puzzle);
  });

  it("reduces low-information images to a smaller honest palette", () => {
    const width = 40;
    const height = 32;
    const rgba = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < width * height; pixel += 1) {
      rgba[pixel * 4] = 118;
      rgba[pixel * 4 + 1] = 126;
      rgba[pixel * 4 + 2] = 132;
      rgba[pixel * 4 + 3] = 255;
    }
    const puzzle = generatePuzzle({ width, height, rgba, preset: "detailed" });
    expect(puzzle.palette).toHaveLength(3);
    expect(puzzle.regionCount).toBe(1);
    assertPuzzleInvariants(puzzle);
  });

  it("constructs a completed image from exact, flat palette RGB values", () => {
    const width = 64;
    const height = 48;
    const puzzle = generatePuzzle({
      width,
      height,
      rgba: syntheticPhoto(width, height),
      preset: "simple",
    });
    const completed = new Uint8ClampedArray(width * height * 4);
    for (let pixel = 0; pixel < puzzle.regionMap.length; pixel += 1) {
      const region = puzzle.regionMap[pixel];
      const paletteOffset = puzzle.regionPalette[region] * 3;
      completed[pixel * 4] = puzzle.palette[paletteOffset];
      completed[pixel * 4 + 1] = puzzle.palette[paletteOffset + 1];
      completed[pixel * 4 + 2] = puzzle.palette[paletteOffset + 2];
      completed[pixel * 4 + 3] = 255;
    }
    for (let pixel = 0; pixel < puzzle.regionMap.length; pixel += 1) {
      const paletteOffset = puzzle.regionPalette[puzzle.regionMap[pixel]] * 3;
      expect(completed[pixel * 4]).toBe(puzzle.palette[paletteOffset]);
      expect(completed[pixel * 4 + 1]).toBe(puzzle.palette[paletteOffset + 1]);
      expect(completed[pixel * 4 + 2]).toBe(puzzle.palette[paletteOffset + 2]);
      expect(completed[pixel * 4 + 3]).toBe(255);
    }
  });

  it("returns a typed, recoverable error for mismatched pixel buffers", () => {
    expect(() =>
      generatePuzzle({
        width: 20,
        height: 20,
        rgba: new Uint8ClampedArray(12),
      }),
    ).toThrowError(PuzzleGenerationError);
    try {
      generatePuzzle({
        width: 20,
        height: 20,
        rgba: new Uint8ClampedArray(12),
      });
    } catch (error) {
      expect(error).toMatchObject({
        code: "INVALID_INPUT",
        recoverable: true,
      });
    }
  });
});
