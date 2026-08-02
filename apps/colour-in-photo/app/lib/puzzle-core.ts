import {
  getPreset,
  type PuzzleDataV1,
  type PuzzleGenerationPhase,
  type PuzzlePresetKey,
  type PuzzleProgress,
  type PuzzleWorkerErrorCode,
} from "./puzzle-types";

const MAX_PIXELS = 1_000_000;
const MAX_LONG_EDGE = 1_400;
const LAB_BUCKETS = 32;
const LAB_BUCKET_SHIFT = 3;
const DISTANCE_INFINITY = 0xffff;
const SCORE_EPSILON = 1e-9;

export interface GeneratePuzzleOptions {
  readonly width: number;
  readonly height: number;
  readonly rgba: Uint8ClampedArray;
  readonly preset?: PuzzlePresetKey;
  readonly onProgress?: (update: PuzzleProgress) => void;
}

export class PuzzleGenerationError extends Error {
  readonly code: PuzzleWorkerErrorCode;
  readonly recoverable: boolean;

  constructor(
    code: PuzzleWorkerErrorCode,
    message: string,
    recoverable = true,
  ) {
    super(message);
    this.name = "PuzzleGenerationError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

interface LabPlanes {
  readonly l: Float32Array;
  readonly a: Float32Array;
  readonly b: Float32Array;
}

interface RegionStatistics {
  readonly count: number;
  readonly area: Float64Array;
  readonly sumL: Float64Array;
  readonly sumA: Float64Array;
  readonly sumB: Float64Array;
  readonly sumR: Float64Array;
  readonly sumG: Float64Array;
  readonly sumBlue: Float64Array;
}

interface ConnectedRegions extends RegionStatistics {
  readonly map: Int32Array;
}

interface CompactRegions extends RegionStatistics {
  readonly map: Uint16Array;
  readonly palette: Uint16Array;
}

interface Boundary {
  count: number;
  sumDeltaSquared: number;
}

interface MergeCandidate {
  readonly a: number;
  readonly b: number;
  readonly score: number;
  readonly versionA: number;
  readonly versionB: number;
}

interface PaletteResult {
  readonly colours: Uint8Array;
  readonly regionPalette: Uint16Array;
}

type ProgressReporter = (
  phase: PuzzleGenerationPhase,
  progress: number,
  message?: string,
) => void;

/**
 * The minimum practical region size used by cleanup. Exported so renderers and
 * invariant tests can make the same decision without duplicating constants.
 */
export function minimumRegionArea(
  width: number,
  height: number,
  preset: PuzzlePresetKey,
): number {
  const pixels = Math.max(1, width * height);
  return Math.max(
    4,
    Math.min(256, Math.floor(pixels / (getPreset(preset).targetRegions * 36))),
  );
}

/** Generate a deterministic, flat-colour puzzle from a packed RGBA image. */
export function generatePuzzle({
  width,
  height,
  rgba,
  preset: presetKey = "balanced",
  onProgress,
}: GeneratePuzzleOptions): PuzzleDataV1 {
  validateInput(width, height, rgba);
  const preset = getPreset(presetKey);
  let lastProgress = 0;
  const report: ProgressReporter = (phase, progress, message) => {
    const safeProgress = Math.max(lastProgress, Math.min(1, progress));
    lastProgress = safeProgress;
    onProgress?.({ phase, progress: safeProgress, message });
  };

  report("preparing", 0.01, "Preparing pixels");
  const smoothed = gaussianSmoothAndFlatten(rgba, width, height);
  report("smoothing", 0.12, "Smoothing fine detail");

  const lab = convertToLab(smoothed);
  report("colour-space", 0.23, "Reading colour and contrast");

  const seedLabels = createSlicSuperpixels(
    width,
    height,
    lab,
    Math.min(
      width * height,
      Math.max(1, Math.round(preset.targetRegions * preset.superpixelMultiplier)),
    ),
    preset.compactness,
    report,
  );
  report("superpixels", 0.52, "Tracing organic shapes");

  const connected = splitIntoConnectedRegions(
    seedLabels,
    width,
    height,
    smoothed,
    lab,
  );
  const merged = edgeAwareMerge(
    connected,
    width,
    height,
    lab,
    Math.max(
      1,
      Math.round(
        Math.min(connected.count, preset.targetRegions * 1.18),
      ),
    ),
  );
  report("merging", 0.68, "Simplifying neighbouring shapes");

  const palette = clusterPalette(merged, preset.colours);
  report("palette", 0.79, "Mixing the numbered palette");

  let cleaned = mergeAdjacentEqualPalette(
    merged.map,
    merged.count,
    palette.regionPalette,
    width,
    height,
    smoothed,
    lab,
  );
  cleaned = mergeTinyRegions(
    cleaned,
    width,
    height,
    presetKey,
    smoothed,
    lab,
  );
  cleaned = mergeAdjacentEqualPalette(
    cleaned.map,
    cleaned.count,
    cleaned.palette,
    width,
    height,
    smoothed,
    lab,
  );
  const finalPalette = compactUnusedPalette(palette.colours, cleaned.palette);
  report("cleanup", 0.9, "Tidying small sections");

  const metadata = buildRegionMetadata(
    cleaned.map,
    cleaned.count,
    width,
    height,
  );
  report("labels", 0.98, "Placing the numbers");

  const puzzle: PuzzleDataV1 = {
    version: 1,
    width,
    height,
    preset: presetKey,
    palette: finalPalette.colours,
    regionMap: cleaned.map,
    regionPalette: finalPalette.regionPalette,
    regionAreas: metadata.areas,
    regionBounds: metadata.bounds,
    labelAnchors: metadata.anchors,
    regionCount: cleaned.count,
  };

  report("complete", 1, "Ready to colour");
  return puzzle;
}

/** Backwards-friendly explicit name for call sites that prefer it. */
export const generatePuzzleData = generatePuzzle;

function validateInput(
  width: number,
  height: number,
  rgba: Uint8ClampedArray,
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new PuzzleGenerationError(
      "INVALID_INPUT",
      "The decoded image has invalid dimensions.",
    );
  }
  const pixels = width * height;
  if (!Number.isSafeInteger(pixels) || rgba.length !== pixels * 4) {
    throw new PuzzleGenerationError(
      "INVALID_INPUT",
      "The decoded pixel buffer does not match the image dimensions.",
    );
  }
  if (pixels > MAX_PIXELS || Math.max(width, height) > MAX_LONG_EDGE) {
    throw new PuzzleGenerationError(
      "UNSUPPORTED_DIMENSIONS",
      "Please resize the image to at most one megapixel and 1,400 pixels on its longest edge.",
    );
  }
}

function gaussianSmoothAndFlatten(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): Uint8ClampedArray {
  const pixels = width * height;
  const horizontal = new Uint8ClampedArray(pixels * 3);
  const result = new Uint8ClampedArray(pixels * 3);

  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      const left = row + Math.max(0, x - 1);
      const centre = row + x;
      const right = row + Math.min(width - 1, x + 1);
      const out = centre * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        horizontal[out + channel] = Math.round(
          (flattenedChannel(rgba, left, channel) +
            flattenedChannel(rgba, centre, channel) * 2 +
            flattenedChannel(rgba, right, channel)) /
            4,
        );
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    const aboveRow = Math.max(0, y - 1) * width;
    const row = y * width;
    const belowRow = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x += 1) {
      const above = (aboveRow + x) * 3;
      const centre = (row + x) * 3;
      const below = (belowRow + x) * 3;
      for (let channel = 0; channel < 3; channel += 1) {
        result[centre + channel] = Math.round(
          (horizontal[above + channel] +
            horizontal[centre + channel] * 2 +
            horizontal[below + channel]) /
            4,
        );
      }
    }
  }

  return result;
}

function flattenedChannel(
  rgba: Uint8ClampedArray,
  pixel: number,
  channel: number,
): number {
  const offset = pixel * 4;
  const alpha = rgba[offset + 3];
  if (alpha === 255) return rgba[offset + channel];
  if (alpha === 0) return 255;
  return Math.round(
    (rgba[offset + channel] * alpha + 255 * (255 - alpha)) / 255,
  );
}

let cachedLabLut: LabPlanes | undefined;

function getLabLut(): LabPlanes {
  if (cachedLabLut) return cachedLabLut;
  const size = LAB_BUCKETS ** 3;
  const l = new Float32Array(size);
  const a = new Float32Array(size);
  const b = new Float32Array(size);
  const linear = new Float64Array(256);
  for (let value = 0; value < 256; value += 1) {
    const normalised = value / 255;
    linear[value] =
      normalised <= 0.04045
        ? normalised / 12.92
        : ((normalised + 0.055) / 1.055) ** 2.4;
  }

  for (let redBucket = 0; redBucket < LAB_BUCKETS; redBucket += 1) {
    const red = linear[Math.min(255, redBucket * 8 + 4)];
    for (let greenBucket = 0; greenBucket < LAB_BUCKETS; greenBucket += 1) {
      const green = linear[Math.min(255, greenBucket * 8 + 4)];
      for (let blueBucket = 0; blueBucket < LAB_BUCKETS; blueBucket += 1) {
        const blue = linear[Math.min(255, blueBucket * 8 + 4)];
        const x =
          (red * 0.4124564 + green * 0.3575761 + blue * 0.1804375) /
          0.95047;
        const y = red * 0.2126729 + green * 0.7151522 + blue * 0.072175;
        const z =
          (red * 0.0193339 + green * 0.119192 + blue * 0.9503041) /
          1.08883;
        const fx = labPivot(x);
        const fy = labPivot(y);
        const fz = labPivot(z);
        const index =
          (redBucket * LAB_BUCKETS + greenBucket) * LAB_BUCKETS + blueBucket;
        l[index] = 116 * fy - 16;
        a[index] = 500 * (fx - fy);
        b[index] = 200 * (fy - fz);
      }
    }
  }
  cachedLabLut = { l, a, b };
  return cachedLabLut;
}

function labPivot(value: number): number {
  return value > 216 / 24389
    ? Math.cbrt(value)
    : (24389 / 27 / 116) * value + 16 / 116;
}

function convertToLab(rgb: Uint8ClampedArray): LabPlanes {
  const lut = getLabLut();
  const pixels = rgb.length / 3;
  const l = new Float32Array(pixels);
  const a = new Float32Array(pixels);
  const b = new Float32Array(pixels);
  for (let pixel = 0; pixel < pixels; pixel += 1) {
    const offset = pixel * 3;
    const index =
      ((rgb[offset] >> LAB_BUCKET_SHIFT) * LAB_BUCKETS +
        (rgb[offset + 1] >> LAB_BUCKET_SHIFT)) *
        LAB_BUCKETS +
      (rgb[offset + 2] >> LAB_BUCKET_SHIFT);
    l[pixel] = lut.l[index];
    a[pixel] = lut.a[index];
    b[pixel] = lut.b[index];
  }
  return { l, a, b };
}

function createSlicSuperpixels(
  width: number,
  height: number,
  lab: LabPlanes,
  requestedSeeds: number,
  compactness: number,
  report: ProgressReporter,
): Int32Array {
  const pixels = width * height;
  const aspect = width / height;
  const columns = Math.min(
    width,
    Math.max(1, Math.round(Math.sqrt(requestedSeeds * aspect))),
  );
  const rows = Math.min(
    height,
    Math.max(1, Math.round(requestedSeeds / columns)),
  );
  const seedCount = columns * rows;
  const cellWidth = width / columns;
  const cellHeight = height / rows;
  const seedX = new Float64Array(seedCount);
  const seedY = new Float64Array(seedCount);
  const seedL = new Float64Array(seedCount);
  const seedA = new Float64Array(seedCount);
  const seedB = new Float64Array(seedCount);

  let seed = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      const approximateX = Math.min(
        width - 1,
        Math.floor((column + 0.5) * cellWidth),
      );
      const approximateY = Math.min(
        height - 1,
        Math.floor((row + 0.5) * cellHeight),
      );
      const position = lowestGradientPixel(
        approximateX,
        approximateY,
        width,
        height,
        lab,
      );
      seedX[seed] = position % width;
      seedY[seed] = Math.floor(position / width);
      seedL[seed] = lab.l[position];
      seedA[seed] = lab.a[position];
      seedB[seed] = lab.b[position];
      seed += 1;
    }
  }

  const labels = new Int32Array(pixels);
  labels.fill(-1);
  const distances = new Float32Array(pixels);
  const sumX = new Float64Array(seedCount);
  const sumY = new Float64Array(seedCount);
  const sumL = new Float64Array(seedCount);
  const sumA = new Float64Array(seedCount);
  const sumB = new Float64Array(seedCount);
  const counts = new Uint32Array(seedCount);
  const compactnessSquared = compactness * compactness;
  const iterations = pixels < 64 ? 2 : 3;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    distances.fill(Number.POSITIVE_INFINITY);
    labels.fill(-1);
    for (let index = 0; index < seedCount; index += 1) {
      const minX = Math.max(0, Math.floor(seedX[index] - cellWidth));
      const maxX = Math.min(width - 1, Math.ceil(seedX[index] + cellWidth));
      const minY = Math.max(0, Math.floor(seedY[index] - cellHeight));
      const maxY = Math.min(height - 1, Math.ceil(seedY[index] + cellHeight));
      for (let y = minY; y <= maxY; y += 1) {
        const rowOffset = y * width;
        for (let x = minX; x <= maxX; x += 1) {
          const pixel = rowOffset + x;
          const deltaL = lab.l[pixel] - seedL[index];
          const deltaA = lab.a[pixel] - seedA[index];
          const deltaB = lab.b[pixel] - seedB[index];
          const spatialX = (x - seedX[index]) / cellWidth;
          const spatialY = (y - seedY[index]) / cellHeight;
          const distance =
            deltaL * deltaL +
            deltaA * deltaA +
            deltaB * deltaB +
            compactnessSquared *
              (spatialX * spatialX + spatialY * spatialY);
          if (
            distance < distances[pixel] - SCORE_EPSILON ||
            (Math.abs(distance - distances[pixel]) <= SCORE_EPSILON &&
              (labels[pixel] < 0 || index < labels[pixel]))
          ) {
            distances[pixel] = distance;
            labels[pixel] = index;
          }
        }
      }
    }

    sumX.fill(0);
    sumY.fill(0);
    sumL.fill(0);
    sumA.fill(0);
    sumB.fill(0);
    counts.fill(0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const pixel = y * width + x;
        let label = labels[pixel];
        if (label < 0) {
          const column = Math.min(columns - 1, Math.floor(x / cellWidth));
          const row = Math.min(rows - 1, Math.floor(y / cellHeight));
          label = row * columns + column;
          labels[pixel] = label;
        }
        sumX[label] += x;
        sumY[label] += y;
        sumL[label] += lab.l[pixel];
        sumA[label] += lab.a[pixel];
        sumB[label] += lab.b[pixel];
        counts[label] += 1;
      }
    }
    for (let index = 0; index < seedCount; index += 1) {
      if (counts[index] === 0) continue;
      const inverse = 1 / counts[index];
      seedX[index] = sumX[index] * inverse;
      seedY[index] = sumY[index] * inverse;
      seedL[index] = sumL[index] * inverse;
      seedA[index] = sumA[index] * inverse;
      seedB[index] = sumB[index] * inverse;
    }
    report(
      "superpixels",
      0.29 + ((iteration + 1) / iterations) * 0.21,
      `Tracing shapes ${iteration + 1} of ${iterations}`,
    );
  }
  return labels;
}

function lowestGradientPixel(
  x: number,
  y: number,
  width: number,
  height: number,
  lab: LabPlanes,
): number {
  let best = y * width + x;
  let bestGradient = Number.POSITIVE_INFINITY;
  for (let candidateY = Math.max(0, y - 1); candidateY <= Math.min(height - 1, y + 1); candidateY += 1) {
    for (let candidateX = Math.max(0, x - 1); candidateX <= Math.min(width - 1, x + 1); candidateX += 1) {
      const left = candidateY * width + Math.max(0, candidateX - 1);
      const right = candidateY * width + Math.min(width - 1, candidateX + 1);
      const up = Math.max(0, candidateY - 1) * width + candidateX;
      const down = Math.min(height - 1, candidateY + 1) * width + candidateX;
      const gradient =
        colourDistanceSquared(lab, left, right) +
        colourDistanceSquared(lab, up, down);
      const position = candidateY * width + candidateX;
      if (
        gradient < bestGradient - SCORE_EPSILON ||
        (Math.abs(gradient - bestGradient) <= SCORE_EPSILON && position < best)
      ) {
        bestGradient = gradient;
        best = position;
      }
    }
  }
  return best;
}

function colourDistanceSquared(
  lab: LabPlanes,
  first: number,
  second: number,
): number {
  const deltaL = lab.l[first] - lab.l[second];
  const deltaA = lab.a[first] - lab.a[second];
  const deltaB = lab.b[first] - lab.b[second];
  return deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
}

function splitIntoConnectedRegions(
  seedLabels: Int32Array,
  width: number,
  height: number,
  rgb: Uint8ClampedArray,
  lab: LabPlanes,
): ConnectedRegions {
  const pixels = width * height;
  const map = new Int32Array(pixels);
  map.fill(-1);
  const queue = new Int32Array(pixels);
  const seedCount = maxValue(seedLabels) + 1;
  const minimumComponent = Math.max(
    2,
    Math.floor(pixels / Math.max(1, seedCount * 12)),
  );
  const area: number[] = [];
  const sumL: number[] = [];
  const sumA: number[] = [];
  const sumB: number[] = [];
  const sumR: number[] = [];
  const sumG: number[] = [];
  const sumBlue: number[] = [];

  for (let start = 0; start < pixels; start += 1) {
    if (map[start] >= 0) continue;
    const label = seedLabels[start];
    let head = 0;
    let tail = 1;
    queue[0] = start;
    map[start] = -2;
    let componentL = 0;
    let componentA = 0;
    let componentB = 0;
    let componentR = 0;
    let componentG = 0;
    let componentBlue = 0;
    const neighbouring = new Set<number>();

    while (head < tail) {
      const pixel = queue[head];
      head += 1;
      componentL += lab.l[pixel];
      componentA += lab.a[pixel];
      componentB += lab.b[pixel];
      const rgbOffset = pixel * 3;
      componentR += rgb[rgbOffset];
      componentG += rgb[rgbOffset + 1];
      componentBlue += rgb[rgbOffset + 2];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      if (x > 0) visitComponentNeighbour(pixel - 1);
      if (x + 1 < width) visitComponentNeighbour(pixel + 1);
      if (y > 0) visitComponentNeighbour(pixel - width);
      if (y + 1 < height) visitComponentNeighbour(pixel + width);
    }

    let component = area.length;
    if (tail < minimumComponent && neighbouring.size > 0) {
      component = closestExistingRegion(
        neighbouring,
        componentL / tail,
        componentA / tail,
        componentB / tail,
        area,
        sumL,
        sumA,
        sumB,
      );
      area[component] += tail;
      sumL[component] += componentL;
      sumA[component] += componentA;
      sumB[component] += componentB;
      sumR[component] += componentR;
      sumG[component] += componentG;
      sumBlue[component] += componentBlue;
    } else {
      area.push(tail);
      sumL.push(componentL);
      sumA.push(componentA);
      sumB.push(componentB);
      sumR.push(componentR);
      sumG.push(componentG);
      sumBlue.push(componentBlue);
    }
    for (let index = 0; index < tail; index += 1) {
      map[queue[index]] = component;
    }

    function visitComponentNeighbour(neighbour: number): void {
      if (map[neighbour] === -1 && seedLabels[neighbour] === label) {
        map[neighbour] = -2;
        queue[tail] = neighbour;
        tail += 1;
      } else if (map[neighbour] >= 0) {
        neighbouring.add(map[neighbour]);
      }
    }
  }

  return {
    map,
    count: area.length,
    area: Float64Array.from(area),
    sumL: Float64Array.from(sumL),
    sumA: Float64Array.from(sumA),
    sumB: Float64Array.from(sumB),
    sumR: Float64Array.from(sumR),
    sumG: Float64Array.from(sumG),
    sumBlue: Float64Array.from(sumBlue),
  };
}

function maxValue(values: Int32Array): number {
  let maximum = -1;
  for (let index = 0; index < values.length; index += 1) {
    maximum = Math.max(maximum, values[index]);
  }
  return maximum;
}

function closestExistingRegion(
  candidates: Set<number>,
  l: number,
  a: number,
  b: number,
  area: number[],
  sumL: number[],
  sumA: number[],
  sumB: number[],
): number {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const inverse = 1 / area[candidate];
    const deltaL = l - sumL[candidate] * inverse;
    const deltaA = a - sumA[candidate] * inverse;
    const deltaB = b - sumB[candidate] * inverse;
    const distance = deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
    if (
      distance < bestDistance - SCORE_EPSILON ||
      (Math.abs(distance - bestDistance) <= SCORE_EPSILON && candidate < best)
    ) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best;
}

function edgeAwareMerge(
  regions: ConnectedRegions,
  width: number,
  height: number,
  lab: LabPlanes,
  targetCount: number,
): CompactRegions {
  const count = regions.count;
  const parent = new Int32Array(count);
  const active = new Uint8Array(count);
  const version = new Uint32Array(count);
  const area = regions.area.slice();
  const sumL = regions.sumL.slice();
  const sumA = regions.sumA.slice();
  const sumB = regions.sumB.slice();
  const sumR = regions.sumR.slice();
  const sumG = regions.sumG.slice();
  const sumBlue = regions.sumBlue.slice();
  const neighbours: Array<Map<number, Boundary>> = Array.from(
    { length: count },
    () => new Map<number, Boundary>(),
  );
  for (let index = 0; index < count; index += 1) {
    parent[index] = index;
    active[index] = 1;
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (x + 1 < width) {
        addBoundary(
          regions.map[pixel],
          regions.map[pixel + 1],
          colourDistanceSquared(lab, pixel, pixel + 1),
          neighbours,
        );
      }
      if (y + 1 < height) {
        addBoundary(
          regions.map[pixel],
          regions.map[pixel + width],
          colourDistanceSquared(lab, pixel, pixel + width),
          neighbours,
        );
      }
    }
  }

  const heap = new CandidateHeap();
  const idealArea = (width * height) / Math.max(1, targetCount);
  for (let first = 0; first < count; first += 1) {
    for (const [second, boundary] of neighbours[first]) {
      if (first < second) pushCandidate(first, second, boundary);
    }
  }

  let activeCount = count;
  while (activeCount > targetCount && heap.size > 0) {
    const candidate = heap.pop();
    if (!candidate) break;
    if (
      !active[candidate.a] ||
      !active[candidate.b] ||
      version[candidate.a] !== candidate.versionA ||
      version[candidate.b] !== candidate.versionB
    ) {
      continue;
    }
    const boundary = neighbours[candidate.a].get(candidate.b);
    if (!boundary) continue;

    const keep = Math.min(candidate.a, candidate.b);
    const drop = Math.max(candidate.a, candidate.b);
    parent[drop] = keep;
    active[drop] = 0;
    area[keep] += area[drop];
    sumL[keep] += sumL[drop];
    sumA[keep] += sumA[drop];
    sumB[keep] += sumB[drop];
    sumR[keep] += sumR[drop];
    sumG[keep] += sumG[drop];
    sumBlue[keep] += sumBlue[drop];
    version[keep] += 1;
    version[drop] += 1;
    neighbours[keep].delete(drop);
    neighbours[drop].delete(keep);

    const droppedNeighbours = [...neighbours[drop].entries()];
    neighbours[drop].clear();
    for (const [rawNeighbour, droppedBoundary] of droppedNeighbours) {
      const neighbour = findRoot(parent, rawNeighbour);
      neighbours[rawNeighbour].delete(drop);
      if (neighbour === keep || !active[neighbour]) continue;
      const existing = neighbours[keep].get(neighbour);
      if (existing) {
        existing.count += droppedBoundary.count;
        existing.sumDeltaSquared += droppedBoundary.sumDeltaSquared;
      } else {
        const combined = { ...droppedBoundary };
        neighbours[keep].set(neighbour, combined);
        neighbours[neighbour].set(keep, combined);
      }
      const current = neighbours[keep].get(neighbour);
      if (current) pushCandidate(keep, neighbour, current);
    }
    for (const [neighbour, current] of neighbours[keep]) {
      if (active[neighbour]) pushCandidate(keep, neighbour, current);
    }
    activeCount -= 1;
  }

  const blankPalette = new Uint16Array(count);
  return remapRegions(
    regions.map,
    parent,
    blankPalette,
    width,
    height,
    new Uint8ClampedArray(0),
    lab,
    { area, sumL, sumA, sumB, sumR, sumG, sumBlue },
  );

  function pushCandidate(first: number, second: number, boundary: Boundary): void {
    const a = Math.min(first, second);
    const b = Math.max(first, second);
    heap.push({
      a,
      b,
      score: mergeScore(a, b, boundary, idealArea, area, sumL, sumA, sumB),
      versionA: version[a],
      versionB: version[b],
    });
  }
}

function addBoundary(
  first: number,
  second: number,
  deltaSquared: number,
  neighbours: Array<Map<number, Boundary>>,
): void {
  if (first === second) return;
  const existing = neighbours[first].get(second);
  if (existing) {
    existing.count += 1;
    existing.sumDeltaSquared += deltaSquared;
    return;
  }
  const boundary = { count: 1, sumDeltaSquared: deltaSquared };
  neighbours[first].set(second, boundary);
  neighbours[second].set(first, boundary);
}

function mergeScore(
  first: number,
  second: number,
  boundary: Boundary,
  idealArea: number,
  area: Float64Array,
  sumL: Float64Array,
  sumA: Float64Array,
  sumB: Float64Array,
): number {
  const inverseFirst = 1 / area[first];
  const inverseSecond = 1 / area[second];
  const deltaL = sumL[first] * inverseFirst - sumL[second] * inverseSecond;
  const deltaA = sumA[first] * inverseFirst - sumA[second] * inverseSecond;
  const deltaB = sumB[first] * inverseFirst - sumB[second] * inverseSecond;
  const colourDistance = Math.sqrt(
    deltaL * deltaL + deltaA * deltaA + deltaB * deltaB,
  );
  const edgeStrength = Math.sqrt(
    boundary.sumDeltaSquared / Math.max(1, boundary.count),
  );
  const smaller = Math.min(area[first], area[second]);
  const combined = area[first] + area[second];
  const smallRegionBonus =
    7 * (1 - Math.min(1, smaller / Math.max(1, idealArea * 0.55)));
  const oversizePenalty =
    3 * Math.max(0, combined / Math.max(1, idealArea * 1.8) - 1);
  return colourDistance + edgeStrength * 0.38 - smallRegionBonus + oversizePenalty;
}

class CandidateHeap {
  private readonly items: MergeCandidate[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: MergeCandidate): void {
    let index = this.items.length;
    this.items.push(item);
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareCandidate(this.items[parent], item) <= 0) break;
      this.items[index] = this.items[parent];
      index = parent;
    }
    this.items[index] = item;
  }

  pop(): MergeCandidate | undefined {
    if (this.items.length === 0) return undefined;
    const first = this.items[0];
    const last = this.items.pop();
    if (!last || this.items.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      if (left >= this.items.length) break;
      const right = left + 1;
      let child = left;
      if (
        right < this.items.length &&
        compareCandidate(this.items[right], this.items[left]) < 0
      ) {
        child = right;
      }
      if (compareCandidate(last, this.items[child]) <= 0) break;
      this.items[index] = this.items[child];
      index = child;
    }
    this.items[index] = last;
    return first;
  }
}

function compareCandidate(first: MergeCandidate, second: MergeCandidate): number {
  if (Math.abs(first.score - second.score) > SCORE_EPSILON) {
    return first.score - second.score;
  }
  if (first.a !== second.a) return first.a - second.a;
  return first.b - second.b;
}

function findRoot(parent: Int32Array, region: number): number {
  let root = region;
  while (parent[root] !== root) root = parent[root];
  let current = region;
  while (parent[current] !== current) {
    const next = parent[current];
    parent[current] = root;
    current = next;
  }
  return root;
}

function clusterPalette(
  regions: CompactRegions,
  requestedColours: number,
): PaletteResult {
  const count = regions.count;
  if (count === 0) {
    throw new PuzzleGenerationError(
      "PROCESSING_FAILED",
      "No paintable regions could be created.",
    );
  }
  const meansL = new Float64Array(count);
  const meansA = new Float64Array(count);
  const meansB = new Float64Array(count);
  for (let region = 0; region < count; region += 1) {
    const inverse = 1 / regions.area[region];
    meansL[region] = regions.sumL[region] * inverse;
    meansA[region] = regions.sumA[region] * inverse;
    meansB[region] = regions.sumB[region] * inverse;
  }

  const seeds: number[] = [];
  let firstSeed = 0;
  for (let region = 1; region < count; region += 1) {
    if (
      regions.area[region] > regions.area[firstSeed] ||
      (regions.area[region] === regions.area[firstSeed] && region < firstSeed)
    ) {
      firstSeed = region;
    }
  }
  seeds.push(firstSeed);
  const maximumColours = Math.min(requestedColours, count);
  while (seeds.length < maximumColours) {
    let best = -1;
    let bestDistance = -1;
    for (let region = 0; region < count; region += 1) {
      let closest = Number.POSITIVE_INFINITY;
      for (const seed of seeds) {
        const distance = meanColourDistanceSquared(
          region,
          seed,
          meansL,
          meansA,
          meansB,
        );
        closest = Math.min(closest, distance);
      }
      const weightedDistance = closest * Math.sqrt(regions.area[region]);
      if (
        weightedDistance > bestDistance + SCORE_EPSILON ||
        (Math.abs(weightedDistance - bestDistance) <= SCORE_EPSILON &&
          (best < 0 || region < best))
      ) {
        best = region;
        bestDistance = weightedDistance;
      }
    }
    // A delta-E below roughly 3.5 is visually redundant for this abstraction.
    if (best < 0 || bestDistance < 12.25) break;
    seeds.push(best);
  }

  let clusterCount = seeds.length;
  const centreL = new Float64Array(clusterCount);
  const centreA = new Float64Array(clusterCount);
  const centreB = new Float64Array(clusterCount);
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    centreL[cluster] = meansL[seeds[cluster]];
    centreA[cluster] = meansA[seeds[cluster]];
    centreB[cluster] = meansB[seeds[cluster]];
  }
  let assignments = new Uint16Array(count);

  for (let iteration = 0; iteration < 12; iteration += 1) {
    const weight = new Float64Array(clusterCount);
    const nextL = new Float64Array(clusterCount);
    const nextA = new Float64Array(clusterCount);
    const nextB = new Float64Array(clusterCount);
    let changed = false;
    for (let region = 0; region < count; region += 1) {
      let bestCluster = 0;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (let cluster = 0; cluster < clusterCount; cluster += 1) {
        const deltaL = meansL[region] - centreL[cluster];
        const deltaA = meansA[region] - centreA[cluster];
        const deltaB = meansB[region] - centreB[cluster];
        const distance = deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
        if (
          distance < bestDistance - SCORE_EPSILON ||
          (Math.abs(distance - bestDistance) <= SCORE_EPSILON &&
            cluster < bestCluster)
        ) {
          bestDistance = distance;
          bestCluster = cluster;
        }
      }
      if (iteration > 0 && assignments[region] !== bestCluster) changed = true;
      assignments[region] = bestCluster;
      const regionWeight = regions.area[region];
      weight[bestCluster] += regionWeight;
      nextL[bestCluster] += meansL[region] * regionWeight;
      nextA[bestCluster] += meansA[region] * regionWeight;
      nextB[bestCluster] += meansB[region] * regionWeight;
    }
    for (let cluster = 0; cluster < clusterCount; cluster += 1) {
      if (weight[cluster] === 0) continue;
      centreL[cluster] = nextL[cluster] / weight[cluster];
      centreA[cluster] = nextA[cluster] / weight[cluster];
      centreB[cluster] = nextB[cluster] / weight[cluster];
    }
    if (iteration > 0 && !changed) break;
  }

  const used = new Uint8Array(clusterCount);
  for (let region = 0; region < count; region += 1) used[assignments[region]] = 1;
  const order = Array.from({ length: clusterCount }, (_, index) => index)
    .filter((cluster) => used[cluster] === 1)
    .sort((first, second) => {
      if (Math.abs(centreL[first] - centreL[second]) > SCORE_EPSILON) {
        return centreL[first] - centreL[second];
      }
      if (Math.abs(centreA[first] - centreA[second]) > SCORE_EPSILON) {
        return centreA[first] - centreA[second];
      }
      if (Math.abs(centreB[first] - centreB[second]) > SCORE_EPSILON) {
        return centreB[first] - centreB[second];
      }
      return first - second;
    });
  clusterCount = order.length;
  const remap = new Int32Array(used.length);
  remap.fill(-1);
  for (let index = 0; index < order.length; index += 1) remap[order[index]] = index;
  const sortedAssignments = new Uint16Array(count);
  for (let region = 0; region < count; region += 1) {
    sortedAssignments[region] = remap[assignments[region]];
  }
  assignments = sortedAssignments;

  const paletteWeight = new Float64Array(clusterCount);
  const red = new Float64Array(clusterCount);
  const green = new Float64Array(clusterCount);
  const blue = new Float64Array(clusterCount);
  for (let region = 0; region < count; region += 1) {
    const cluster = assignments[region];
    paletteWeight[cluster] += regions.area[region];
    red[cluster] += regions.sumR[region];
    green[cluster] += regions.sumG[region];
    blue[cluster] += regions.sumBlue[region];
  }
  const colours = new Uint8Array(clusterCount * 3);
  for (let cluster = 0; cluster < clusterCount; cluster += 1) {
    const inverse = 1 / Math.max(1, paletteWeight[cluster]);
    colours[cluster * 3] = Math.round(red[cluster] * inverse);
    colours[cluster * 3 + 1] = Math.round(green[cluster] * inverse);
    colours[cluster * 3 + 2] = Math.round(blue[cluster] * inverse);
  }
  return deduplicatePaletteColours(colours, assignments);
}

function meanColourDistanceSquared(
  first: number,
  second: number,
  l: Float64Array,
  a: Float64Array,
  b: Float64Array,
): number {
  const deltaL = l[first] - l[second];
  const deltaA = a[first] - a[second];
  const deltaB = b[first] - b[second];
  return deltaL * deltaL + deltaA * deltaA + deltaB * deltaB;
}

function compactUnusedPalette(
  colours: Uint8Array,
  regionPalette: Uint16Array,
): PaletteResult {
  const colourCount = Math.floor(colours.length / 3);
  const used = new Uint8Array(colourCount);
  for (let region = 0; region < regionPalette.length; region += 1) {
    used[regionPalette[region]] = 1;
  }
  const remap = new Int32Array(colourCount);
  remap.fill(-1);
  let compactCount = 0;
  for (let colour = 0; colour < colourCount; colour += 1) {
    if (used[colour]) {
      remap[colour] = compactCount;
      compactCount += 1;
    }
  }
  if (compactCount === colourCount) {
    return { colours, regionPalette };
  }
  const compactColours = new Uint8Array(compactCount * 3);
  for (let colour = 0; colour < colourCount; colour += 1) {
    const destination = remap[colour];
    if (destination < 0) continue;
    compactColours[destination * 3] = colours[colour * 3];
    compactColours[destination * 3 + 1] = colours[colour * 3 + 1];
    compactColours[destination * 3 + 2] = colours[colour * 3 + 2];
  }
  const compactAssignments = new Uint16Array(regionPalette.length);
  for (let region = 0; region < regionPalette.length; region += 1) {
    compactAssignments[region] = remap[regionPalette[region]];
  }
  return {
    colours: compactColours,
    regionPalette: compactAssignments,
  };
}

function deduplicatePaletteColours(
  colours: Uint8Array,
  regionPalette: Uint16Array,
): PaletteResult {
  const colourCount = colours.length / 3;
  const remap = new Uint16Array(colourCount);
  const unique: number[] = [];
  for (let colour = 0; colour < colourCount; colour += 1) {
    let match = -1;
    for (let candidate = 0; candidate < unique.length; candidate += 1) {
      const sourceOffset = colour * 3;
      const candidateOffset = unique[candidate] * 3;
      if (
        colours[sourceOffset] === colours[candidateOffset] &&
        colours[sourceOffset + 1] === colours[candidateOffset + 1] &&
        colours[sourceOffset + 2] === colours[candidateOffset + 2]
      ) {
        match = candidate;
        break;
      }
    }
    if (match < 0) {
      match = unique.length;
      unique.push(colour);
    }
    remap[colour] = match;
  }
  if (unique.length === colourCount) {
    return { colours, regionPalette };
  }
  const uniqueColours = new Uint8Array(unique.length * 3);
  for (let colour = 0; colour < unique.length; colour += 1) {
    const sourceOffset = unique[colour] * 3;
    uniqueColours[colour * 3] = colours[sourceOffset];
    uniqueColours[colour * 3 + 1] = colours[sourceOffset + 1];
    uniqueColours[colour * 3 + 2] = colours[sourceOffset + 2];
  }
  const assignments = new Uint16Array(regionPalette.length);
  for (let region = 0; region < regionPalette.length; region += 1) {
    assignments[region] = remap[regionPalette[region]];
  }
  return { colours: uniqueColours, regionPalette: assignments };
}

function mergeAdjacentEqualPalette(
  map: Uint16Array,
  count: number,
  palette: Uint16Array,
  width: number,
  height: number,
  rgb: Uint8ClampedArray,
  lab: LabPlanes,
): CompactRegions {
  const parent = new Int32Array(count);
  for (let region = 0; region < count; region += 1) parent[region] = region;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const region = map[pixel];
      if (x + 1 < width) unionIfPaletteMatches(region, map[pixel + 1]);
      if (y + 1 < height) unionIfPaletteMatches(region, map[pixel + width]);
    }
  }
  return remapRegions(map, parent, palette, width, height, rgb, lab);

  function unionIfPaletteMatches(first: number, second: number): void {
    if (first === second || palette[first] !== palette[second]) return;
    unionRoots(parent, first, second);
  }
}

function unionRoots(parent: Int32Array, first: number, second: number): number {
  const rootFirst = findRoot(parent, first);
  const rootSecond = findRoot(parent, second);
  if (rootFirst === rootSecond) return rootFirst;
  const keep = Math.min(rootFirst, rootSecond);
  const drop = Math.max(rootFirst, rootSecond);
  parent[drop] = keep;
  return keep;
}

function mergeTinyRegions(
  regions: CompactRegions,
  width: number,
  height: number,
  preset: PuzzlePresetKey,
  rgb: Uint8ClampedArray,
  lab: LabPlanes,
): CompactRegions {
  if (regions.count <= 1) return regions;
  const threshold = minimumRegionArea(width, height, preset);
  const count = regions.count;
  const parent = new Int32Array(count);
  const active = new Uint8Array(count);
  const area = regions.area.slice();
  const sumL = regions.sumL.slice();
  const sumA = regions.sumA.slice();
  const sumB = regions.sumB.slice();
  const palette = regions.palette.slice();
  const neighbours: Array<Map<number, number>> = Array.from(
    { length: count },
    () => new Map<number, number>(),
  );
  for (let region = 0; region < count; region += 1) {
    parent[region] = region;
    active[region] = 1;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (x + 1 < width) addLength(regions.map[pixel], regions.map[pixel + 1]);
      if (y + 1 < height) addLength(regions.map[pixel], regions.map[pixel + width]);
    }
  }

  while (true) {
    let small = -1;
    for (let region = 0; region < count; region += 1) {
      if (
        active[region] &&
        area[region] < threshold &&
        (small < 0 ||
          area[region] < area[small] ||
          (area[region] === area[small] && region < small))
      ) {
        small = region;
      }
    }
    if (small < 0) break;
    let target = -1;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [rawNeighbour, boundaryLength] of neighbours[small]) {
      const neighbour = findRoot(parent, rawNeighbour);
      if (!active[neighbour] || neighbour === small) continue;
      const distance = regionMeanDistance(
        small,
        neighbour,
        area,
        sumL,
        sumA,
        sumB,
      );
      const score =
        distance -
        Math.min(12, (boundaryLength / Math.sqrt(Math.max(1, area[small]))) * 1.5);
      if (
        score < bestScore - SCORE_EPSILON ||
        (Math.abs(score - bestScore) <= SCORE_EPSILON &&
          (target < 0 || neighbour < target))
      ) {
        target = neighbour;
        bestScore = score;
      }
    }
    if (target < 0) break;

    parent[small] = target;
    active[small] = 0;
    area[target] += area[small];
    sumL[target] += sumL[small];
    sumA[target] += sumA[small];
    sumB[target] += sumB[small];
    const entries = [...neighbours[small].entries()];
    neighbours[small].clear();
    neighbours[target].delete(small);
    for (const [rawNeighbour, length] of entries) {
      const neighbour = findRoot(parent, rawNeighbour);
      neighbours[rawNeighbour].delete(small);
      if (!active[neighbour] || neighbour === target) continue;
      const combined = (neighbours[target].get(neighbour) ?? 0) + length;
      neighbours[target].set(neighbour, combined);
      neighbours[neighbour].set(target, combined);
    }
  }

  return remapRegions(regions.map, parent, palette, width, height, rgb, lab);

  function addLength(first: number, second: number): void {
    if (first === second) return;
    const next = (neighbours[first].get(second) ?? 0) + 1;
    neighbours[first].set(second, next);
    neighbours[second].set(first, next);
  }
}

function regionMeanDistance(
  first: number,
  second: number,
  area: Float64Array,
  sumL: Float64Array,
  sumA: Float64Array,
  sumB: Float64Array,
): number {
  const firstInverse = 1 / area[first];
  const secondInverse = 1 / area[second];
  const deltaL = sumL[first] * firstInverse - sumL[second] * secondInverse;
  const deltaA = sumA[first] * firstInverse - sumA[second] * secondInverse;
  const deltaB = sumB[first] * firstInverse - sumB[second] * secondInverse;
  return Math.sqrt(deltaL * deltaL + deltaA * deltaA + deltaB * deltaB);
}

function remapRegions(
  sourceMap: Int32Array | Uint16Array,
  parent: Int32Array,
  sourcePalette: Uint16Array,
  width: number,
  height: number,
  rgb: Uint8ClampedArray,
  lab: LabPlanes,
  existingStatistics?: Omit<RegionStatistics, "count">,
): CompactRegions {
  const rootToRegion = new Int32Array(parent.length);
  rootToRegion.fill(-1);
  let count = 0;
  for (let region = 0; region < parent.length; region += 1) {
    const root = findRoot(parent, region);
    if (rootToRegion[root] < 0) {
      if (count >= 0xffff) {
        throw new PuzzleGenerationError(
          "PROCESSING_FAILED",
          "This photo produced too many paintable sections.",
        );
      }
      rootToRegion[root] = count;
      count += 1;
    }
  }
  const map = new Uint16Array(width * height);
  const palette = new Uint16Array(count);
  for (let region = 0; region < parent.length; region += 1) {
    const root = findRoot(parent, region);
    palette[rootToRegion[root]] = sourcePalette[root];
  }
  for (let pixel = 0; pixel < sourceMap.length; pixel += 1) {
    map[pixel] = rootToRegion[findRoot(parent, sourceMap[pixel])];
  }

  if (existingStatistics) {
    const area = new Float64Array(count);
    const sumL = new Float64Array(count);
    const sumA = new Float64Array(count);
    const sumB = new Float64Array(count);
    const sumR = new Float64Array(count);
    const sumG = new Float64Array(count);
    const sumBlue = new Float64Array(count);
    for (let root = 0; root < parent.length; root += 1) {
      if (findRoot(parent, root) !== root) continue;
      const region = rootToRegion[root];
      area[region] = existingStatistics.area[root];
      sumL[region] = existingStatistics.sumL[root];
      sumA[region] = existingStatistics.sumA[root];
      sumB[region] = existingStatistics.sumB[root];
      sumR[region] = existingStatistics.sumR[root];
      sumG[region] = existingStatistics.sumG[root];
      sumBlue[region] = existingStatistics.sumBlue[root];
    }
    return { map, palette, count, area, sumL, sumA, sumB, sumR, sumG, sumBlue };
  }

  return summariseRegions(map, palette, count, rgb, lab);
}

function summariseRegions(
  map: Uint16Array,
  palette: Uint16Array,
  count: number,
  rgb: Uint8ClampedArray,
  lab: LabPlanes,
): CompactRegions {
  const area = new Float64Array(count);
  const sumL = new Float64Array(count);
  const sumA = new Float64Array(count);
  const sumB = new Float64Array(count);
  const sumR = new Float64Array(count);
  const sumG = new Float64Array(count);
  const sumBlue = new Float64Array(count);
  for (let pixel = 0; pixel < map.length; pixel += 1) {
    const region = map[pixel];
    area[region] += 1;
    sumL[region] += lab.l[pixel];
    sumA[region] += lab.a[pixel];
    sumB[region] += lab.b[pixel];
    const offset = pixel * 3;
    sumR[region] += rgb[offset];
    sumG[region] += rgb[offset + 1];
    sumBlue[region] += rgb[offset + 2];
  }
  return { map, palette, count, area, sumL, sumA, sumB, sumR, sumG, sumBlue };
}

function buildRegionMetadata(
  map: Uint16Array,
  count: number,
  width: number,
  height: number,
): {
  readonly areas: Uint32Array;
  readonly bounds: Int32Array;
  readonly anchors: Float32Array;
} {
  const areas = new Uint32Array(count);
  const bounds = new Int32Array(count * 4);
  const centreX = new Float64Array(count);
  const centreY = new Float64Array(count);
  for (let region = 0; region < count; region += 1) {
    bounds[region * 4] = width;
    bounds[region * 4 + 1] = height;
    bounds[region * 4 + 2] = -1;
    bounds[region * 4 + 3] = -1;
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const region = map[y * width + x];
      const offset = region * 4;
      areas[region] += 1;
      centreX[region] += x + 0.5;
      centreY[region] += y + 0.5;
      bounds[offset] = Math.min(bounds[offset], x);
      bounds[offset + 1] = Math.min(bounds[offset + 1], y);
      bounds[offset + 2] = Math.max(bounds[offset + 2], x);
      bounds[offset + 3] = Math.max(bounds[offset + 3], y);
    }
  }
  for (let region = 0; region < count; region += 1) {
    centreX[region] /= Math.max(1, areas[region]);
    centreY[region] /= Math.max(1, areas[region]);
  }

  const distance = new Uint16Array(map.length);
  distance.fill(DISTANCE_INFINITY);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const region = map[pixel];
      if (
        x === 0 ||
        x + 1 === width ||
        y === 0 ||
        y + 1 === height ||
        map[pixel - 1] !== region ||
        map[pixel + 1] !== region ||
        map[pixel - width] !== region ||
        map[pixel + width] !== region
      ) {
        distance[pixel] = 0;
      }
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      if (distance[pixel] === 0) continue;
      const region = map[pixel];
      let value = distance[pixel];
      if (x > 0 && map[pixel - 1] === region) value = Math.min(value, distance[pixel - 1] + 3);
      if (y > 0 && map[pixel - width] === region) value = Math.min(value, distance[pixel - width] + 3);
      if (x > 0 && y > 0 && map[pixel - width - 1] === region) value = Math.min(value, distance[pixel - width - 1] + 4);
      if (x + 1 < width && y > 0 && map[pixel - width + 1] === region) value = Math.min(value, distance[pixel - width + 1] + 4);
      distance[pixel] = value;
    }
  }
  for (let y = height - 1; y >= 0; y -= 1) {
    for (let x = width - 1; x >= 0; x -= 1) {
      const pixel = y * width + x;
      if (distance[pixel] === 0) continue;
      const region = map[pixel];
      let value = distance[pixel];
      if (x + 1 < width && map[pixel + 1] === region) value = Math.min(value, distance[pixel + 1] + 3);
      if (y + 1 < height && map[pixel + width] === region) value = Math.min(value, distance[pixel + width] + 3);
      if (x + 1 < width && y + 1 < height && map[pixel + width + 1] === region) value = Math.min(value, distance[pixel + width + 1] + 4);
      if (x > 0 && y + 1 < height && map[pixel + width - 1] === region) value = Math.min(value, distance[pixel + width - 1] + 4);
      distance[pixel] = value;
    }
  }

  const anchors = new Float32Array(count * 2);
  const bestDistance = new Int32Array(count);
  bestDistance.fill(-1);
  const bestCentroidDistance = new Float64Array(count);
  bestCentroidDistance.fill(Number.POSITIVE_INFINITY);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixel = y * width + x;
      const region = map[pixel];
      const fromCentre =
        (x + 0.5 - centreX[region]) ** 2 +
        (y + 0.5 - centreY[region]) ** 2;
      if (
        distance[pixel] > bestDistance[region] ||
        (distance[pixel] === bestDistance[region] &&
          fromCentre < bestCentroidDistance[region] - SCORE_EPSILON)
      ) {
        bestDistance[region] = distance[pixel];
        bestCentroidDistance[region] = fromCentre;
        anchors[region * 2] = x + 0.5;
        anchors[region * 2 + 1] = y + 0.5;
      }
    }
  }
  return { areas, bounds, anchors };
}
