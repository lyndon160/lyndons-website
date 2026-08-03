import { describe, expect, it, vi } from "vitest";

import {
  calculateWorkingDimensions,
  canAttemptPuzzleRegion,
  copySourcePixels,
  decodePhotoSource,
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

function makeBitmap(width = 320, height = 240) {
  return {
    width,
    height,
    close: vi.fn(),
  } as unknown as ImageBitmap;
}

function makeImage(width = 320, height = 240) {
  return {
    naturalWidth: width,
    naturalHeight: height,
  } as HTMLImageElement;
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

  it("retries bitmap decoding without orientation options", async () => {
    const file = new Blob(["photo"], { type: "image/jpeg" });
    const bitmap = makeBitmap();
    const createBitmap = vi.fn(
      async (_file: Blob, options?: ImageBitmapOptions) => {
        if (options) throw new TypeError("Unsupported imageOrientation option");
        return bitmap;
      },
    );
    const loadImage = vi.fn();

    const decoded = await decodePhotoSource(file, {
      createBitmap,
      loadImage,
      revokeObjectUrl: vi.fn(),
    });

    expect(createBitmap).toHaveBeenCalledTimes(2);
    expect(createBitmap).toHaveBeenNthCalledWith(1, file, {
      imageOrientation: "from-image",
    });
    expect(createBitmap).toHaveBeenNthCalledWith(2, file, undefined);
    expect(loadImage).not.toHaveBeenCalled();
    expect(decoded).toMatchObject({ width: 320, height: 240 });
    decoded.release();
    decoded.release();
    expect(bitmap.close).toHaveBeenCalledTimes(1);
  });

  it.each(["image/jpeg", "image/png", "image/webp", ""])(
    "falls back to an image element when bitmap decoding rejects %s",
    async (type) => {
      const file = new Blob(["photo"], { type });
      const createBitmap = vi.fn(async () => {
        throw new DOMException("The image could not be decoded", "EncodingError");
      });
      const loadImage = vi.fn(async () => ({
        image: makeImage(640, 480),
        url: "blob:fallback-photo",
      }));
      const revokeObjectUrl = vi.fn();

      const decoded = await decodePhotoSource(file, {
        createBitmap,
        loadImage,
        revokeObjectUrl,
      });

      expect(createBitmap).toHaveBeenCalledOnce();
      expect(loadImage).toHaveBeenCalledOnce();
      expect(decoded).toMatchObject({ width: 640, height: 480 });
      decoded.release();
      decoded.release();
      expect(revokeObjectUrl).toHaveBeenCalledOnce();
      expect(revokeObjectUrl).toHaveBeenCalledWith("blob:fallback-photo");
    },
  );

  it("uses the image element directly when bitmap decoding is unavailable", async () => {
    const revokeObjectUrl = vi.fn();
    const loadImage = vi.fn(async () => ({
      image: makeImage(800, 600),
      url: "blob:image-only",
    }));
    const decoded = await decodePhotoSource(new Blob(["photo"]), {
      loadImage,
      revokeObjectUrl,
    });

    expect(loadImage).toHaveBeenCalledOnce();
    expect(decoded).toMatchObject({ width: 800, height: 600 });
    decoded.release();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:image-only");
  });

  it("closes zero-sized bitmaps before using the image fallback", async () => {
    const emptyBitmap = makeBitmap(0, 0);
    const createBitmap = vi
      .fn<(file: Blob, options?: ImageBitmapOptions) => Promise<ImageBitmap>>()
      .mockResolvedValueOnce(emptyBitmap);
    const revokeObjectUrl = vi.fn();

    const decoded = await decodePhotoSource(new Blob(["photo"]), {
      createBitmap,
      loadImage: vi.fn(async () => ({
        image: makeImage(400, 300),
        url: "blob:zero-bitmap-fallback",
      })),
      revokeObjectUrl,
    });

    expect(createBitmap).toHaveBeenCalledOnce();
    expect(emptyBitmap.close).toHaveBeenCalledOnce();
    expect(decoded).toMatchObject({ width: 400, height: 300 });
    decoded.release();
    expect(revokeObjectUrl).toHaveBeenCalledWith("blob:zero-bitmap-fallback");
  });

  it("rejects only after every available decoder fails", async () => {
    const createBitmap = vi.fn(async () => {
      throw new DOMException("Bitmap decode failed", "EncodingError");
    });
    const loadImage = vi.fn(async () => {
      throw new Error("Image element decode failed");
    });

    await expect(
      decodePhotoSource(new Blob(["broken"]), {
        createBitmap,
        loadImage,
        revokeObjectUrl: vi.fn(),
      }),
    ).rejects.toThrow("Image element decode failed");
    expect(createBitmap).toHaveBeenCalledOnce();
    expect(loadImage).toHaveBeenCalledOnce();
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
