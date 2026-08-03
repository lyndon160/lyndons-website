"use client";

import {
  type ChangeEvent,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  PuzzleDataV1,
  PuzzlePresetKey,
} from "@/app/lib/puzzle-types";
import {
  createFlatColourExportBuffer,
  selectNextPalette,
  validateFill,
} from "@/app/lib/game-state";
import styles from "./ColourGame.module.css";

const MAX_PIXELS = 1_000_000;
const MAX_EDGE = 1_400;
const MIN_EDGE = 80;
const UNFILLED_COLOUR = "#fffdf8";

const PRESET_OPTIONS: Array<{
  key: PuzzlePresetKey;
  label: string;
  colours: number;
  regions: number;
}> = [
  { key: "simple", label: "Simple", colours: 8, regions: 90 },
  { key: "balanced", label: "Balanced", colours: 12, regions: 180 },
  { key: "detailed", label: "Detailed", colours: 16, regions: 300 },
];

const ACCEPTED_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
]);

interface DecodedPhoto {
  url: string;
  width: number;
  height: number;
  name: string;
  /** Immutable, downsampled source pixels. Worker jobs receive a transferred copy. */
  sourceRgba: Uint8ClampedArray;
  warning?: string;
}

interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
}

interface CanvasSize {
  width: number;
  height: number;
}

interface CanvasLayers {
  construction: HTMLCanvasElement;
  colours: HTMLCanvasElement;
  /** Packed [linear pixel start, run length] pairs for each region. */
  regionRuns: readonly Uint32Array[];
}

export interface Point {
  x: number;
  y: number;
}

interface WorkerProgressMessage {
  type: "progress";
  jobId: string;
  preset: PuzzlePresetKey;
  phase: string;
  progress: number;
  message?: string;
}

interface WorkerCompleteMessage {
  type: "complete" | "result";
  jobId: string;
  preset: PuzzlePresetKey;
  puzzle: PuzzleDataV1;
}

interface WorkerErrorMessage {
  type: "error";
  jobId: string;
  preset: PuzzlePresetKey;
  error: {
    code: string;
    message: string;
    recoverable: boolean;
  };
}

type WorkerResponse =
  | WorkerProgressMessage
  | WorkerCompleteMessage
  | WorkerErrorMessage;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

/** Creates the worker-owned copy while preserving the retained source pixels. */
export function copySourcePixels(source: Uint8ClampedArray): Uint8ClampedArray {
  return source.slice();
}

/** Shared paint gate used by pointer and keyboard interaction paths. */
export function canAttemptPuzzleRegion(
  puzzle: PuzzleDataV1 | null,
  complete: boolean,
  comparing: boolean,
  regionId: number,
): puzzle is PuzzleDataV1 {
  return Boolean(
    puzzle &&
      !complete &&
      !comparing &&
      Number.isInteger(regionId) &&
      regionId >= 0 &&
      regionId < puzzle.regionCount,
  );
}

export function findHintTarget(
  puzzle: PuzzleDataV1,
  filled: ArrayLike<number>,
  selectedPalette: number,
): { regionId: number; paletteIndex: number } | null {
  const largestUnfilledRegion = (paletteIndex: number) => {
    let regionId = -1;
    let largestArea = -1;
    for (let region = 0; region < puzzle.regionCount; region += 1) {
      if (
        !filled[region] &&
        puzzle.regionPalette[region] === paletteIndex &&
        (puzzle.regionAreas[region] ?? 0) > largestArea
      ) {
        regionId = region;
        largestArea = puzzle.regionAreas[region] ?? 0;
      }
    }
    return regionId;
  };

  const selectedRegion = largestUnfilledRegion(selectedPalette);
  if (selectedRegion >= 0) {
    return { regionId: selectedRegion, paletteIndex: selectedPalette };
  }

  const nextPalette = selectNextPalette(puzzle, filled, selectedPalette);
  if (nextPalette === null) return null;
  const nextRegion = largestUnfilledRegion(nextPalette);
  return nextRegion >= 0
    ? { regionId: nextRegion, paletteIndex: nextPalette }
    : null;
}

export function resolveVisibleHintTarget(
  puzzle: PuzzleDataV1,
  filled: ArrayLike<number>,
  selectedPalette: number,
  manualHintRegion: number | null,
  autoHintEnabled: boolean,
): { regionId: number; paletteIndex: number } | null {
  if (
    manualHintRegion !== null &&
    Number.isInteger(manualHintRegion) &&
    manualHintRegion >= 0 &&
    manualHintRegion < puzzle.regionCount &&
    !filled[manualHintRegion]
  ) {
    return {
      regionId: manualHintRegion,
      paletteIndex: puzzle.regionPalette[manualHintRegion] ?? selectedPalette,
    };
  }

  return autoHintEnabled
    ? findHintTarget(puzzle, filled, selectedPalette)
    : null;
}

function createCanvas(width: number, height: number) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not prepare this image."));
      },
      type,
      quality,
    );
  });
}

function fileExtension(name: string) {
  return name.toLowerCase().split(".").pop() ?? "";
}

function isSupportedFile(file: Pick<File, "name" | "type">) {
  if (ACCEPTED_TYPES.has(file.type.toLowerCase())) return true;
  return ["jpg", "jpeg", "png", "webp", "heic", "heif"].includes(
    fileExtension(file.name),
  );
}

export function validatePhotoFile(
  file: Pick<File, "name" | "size" | "type">,
): string | undefined {
  if (!isSupportedFile(file)) {
    return "Choose a JPEG, PNG, WebP, or HEIC photo.";
  }
  return undefined;
}

export function calculateWorkingDimensions(
  sourceWidth: number,
  sourceHeight: number,
) {
  const edgeScale = Math.min(1, MAX_EDGE / Math.max(sourceWidth, sourceHeight));
  const pixelScale = Math.min(
    1,
    Math.sqrt(MAX_PIXELS / (sourceWidth * sourceHeight)),
  );
  const scale = Math.min(edgeScale, pixelScale);

  return {
    width: Math.max(1, Math.floor(sourceWidth * scale)),
    height: Math.max(1, Math.floor(sourceHeight * scale)),
    resized: scale < 1,
  };
}

function friendlyDecodeError(file: File) {
  const extension = fileExtension(file.name);
  if (extension === "heic" || extension === "heif") {
    return "This browser can’t open that HEIC photo. Try it in Safari 17 or later, or export the photo as JPEG, PNG, or WebP.";
  }
  return "That photo couldn’t be opened. Try a JPEG, PNG, or WebP version instead.";
}

async function loadImageElement(file: Blob) {
  const url = URL.createObjectURL(file);
  const image = new Image();
  image.decoding = "async";
  image.src = url;
  try {
    if (typeof image.decode === "function") {
      await image.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        image.onload = () => resolve();
        image.onerror = () => reject(new Error("Image decode failed"));
      });
    }
    return { image, url };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function inspectPhoto(imageData: ImageData, width: number, height: number) {
  const data = imageData.data;
  const sampleStride = Math.max(1, Math.floor((width * height) / 8_000));
  let samples = 0;
  let luminanceTotal = 0;
  let luminanceSquared = 0;
  let chromaTotal = 0;

  for (let pixel = 0; pixel < width * height; pixel += sampleStride) {
    const offset = pixel * 4;
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    luminanceTotal += luminance;
    luminanceSquared += luminance * luminance;
    chromaTotal += Math.max(red, green, blue) - Math.min(red, green, blue);
    samples += 1;
  }

  const mean = luminanceTotal / Math.max(samples, 1);
  const deviation = Math.sqrt(
    Math.max(0, luminanceSquared / Math.max(samples, 1) - mean * mean),
  );
  const chroma = chromaTotal / Math.max(samples, 1);
  const aspect = Math.max(width / height, height / width);

  if (aspect > 5) {
    return "Very wide photos make slimmer sections. A closer crop may be easier to colour.";
  }
  if (deviation < 10 && chroma < 8) {
    return "This photo has very gentle colour and contrast, so the finished puzzle may use fewer sections.";
  }
  if (deviation < 15) {
    return "This photo has soft contrast, so some neighbouring areas may be combined.";
  }
  if (chroma < 7) {
    return "This nearly monochrome photo may produce a smaller, quieter palette.";
  }
  return undefined;
}

async function decodePhoto(file: File) {
  const validationError = validatePhotoFile(file);
  if (validationError) throw new Error(validationError);

  let source: CanvasImageSource;
  let sourceWidth = 0;
  let sourceHeight = 0;
  let bitmap: ImageBitmap | null = null;
  let imageUrl: string | null = null;

  try {
    if (typeof createImageBitmap === "function") {
      try {
        bitmap = await createImageBitmap(file, {
          imageOrientation: "from-image",
        });
      } catch {
        bitmap = await createImageBitmap(file);
      }
      source = bitmap;
      sourceWidth = bitmap.width;
      sourceHeight = bitmap.height;
    } else {
      const loaded = await loadImageElement(file);
      source = loaded.image;
      imageUrl = loaded.url;
      sourceWidth = loaded.image.naturalWidth;
      sourceHeight = loaded.image.naturalHeight;
    }
  } catch {
    throw new Error(friendlyDecodeError(file));
  }

  if (!sourceWidth || !sourceHeight) {
    bitmap?.close();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    throw new Error(friendlyDecodeError(file));
  }

  if (Math.min(sourceWidth, sourceHeight) < MIN_EDGE) {
    bitmap?.close();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    throw new Error(
      "That photo is too small to make clear sections. Choose one at least 80 pixels on each side.",
    );
  }

  const { width, height, resized } = calculateWorkingDimensions(
    sourceWidth,
    sourceHeight,
  );
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d", { willReadFrequently: true });

  if (!context) {
    bitmap?.close();
    if (imageUrl) URL.revokeObjectURL(imageUrl);
    throw new Error("Your browser couldn’t prepare a canvas for this photo.");
  }

  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = "high";
  context.drawImage(source, 0, 0, width, height);
  bitmap?.close();
  if (imageUrl) URL.revokeObjectURL(imageUrl);

  const imageData = context.getImageData(0, 0, width, height);
  const resizeNotice = resized
    ? `Large photo resized to ${width.toLocaleString()} × ${height.toLocaleString()} for smooth colouring.`
    : undefined;
  const photoNotice = inspectPhoto(imageData, width, height);
  const warning =
    [resizeNotice, photoNotice].filter(Boolean).join(" ") || undefined;
  const previewBlob = await canvasToBlob(canvas, "image/jpeg", 0.92);

  return {
    photo: {
      url: URL.createObjectURL(previewBlob),
      width,
      height,
      name: file.name,
      sourceRgba: imageData.data,
      warning,
    } satisfies DecodedPhoto,
    rgba: imageData.data,
  };
}

function paletteColour(puzzle: PuzzleDataV1, paletteIndex: number) {
  const offset = paletteIndex * 3;
  return {
    red: puzzle.palette[offset] ?? 0,
    green: puzzle.palette[offset + 1] ?? 0,
    blue: puzzle.palette[offset + 2] ?? 0,
  };
}

function paletteCss(puzzle: PuzzleDataV1, paletteIndex: number) {
  const { red, green, blue } = paletteColour(puzzle, paletteIndex);
  return `rgb(${red}, ${green}, ${blue})`;
}

function textColourFor(red: number, green: number, blue: number) {
  const linearChannel = (channel: number) => {
    const value = clamp(channel, 0, 255) / 255;
    return value <= 0.04045
      ? value / 12.92
      : Math.pow((value + 0.055) / 1.055, 2.4);
  };
  const relativeLuminance = (redValue: number, greenValue: number, blueValue: number) =>
    linearChannel(redValue) * 0.2126 +
    linearChannel(greenValue) * 0.7152 +
    linearChannel(blueValue) * 0.0722;
  const contrastRatio = (first: number, second: number) =>
    (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);

  const background = relativeLuminance(red, green, blue);
  const dark = relativeLuminance(0, 0, 0);
  const light = relativeLuminance(255, 255, 255);
  return contrastRatio(background, dark) >= contrastRatio(background, light)
    ? "#000000"
    : "#ffffff";
}

function buildCanvasLayers(puzzle: PuzzleDataV1): CanvasLayers {
  const construction = createCanvas(puzzle.width, puzzle.height);
  const colours = createCanvas(puzzle.width, puzzle.height);
  const pendingRuns: number[][] = Array.from(
    { length: puzzle.regionCount },
    () => [],
  );

  for (let y = 0; y < puzzle.height; y += 1) {
    const row = y * puzzle.width;
    let runStart = 0;
    for (let x = 0; x < puzzle.width; x += 1) {
      const index = row + x;
      const region = puzzle.regionMap[index];
      if (
        x + 1 === puzzle.width ||
        puzzle.regionMap[index + 1] !== region
      ) {
        pendingRuns[region]?.push(row + runStart, x - runStart + 1);
        runStart = x + 1;
      }
    }
  }
  const regionRuns = pendingRuns.map((runs) => Uint32Array.from(runs));
  const context = construction.getContext("2d");
  if (!context) return { construction, colours, regionRuns };

  const boundaries = context.createImageData(puzzle.width, puzzle.height);
  const output = boundaries.data;
  const map = puzzle.regionMap;

  for (let y = 0; y < puzzle.height; y += 1) {
    const row = y * puzzle.width;
    for (let x = 0; x < puzzle.width; x += 1) {
      const index = row + x;
      const region = map[index];
      const boundary =
        (x + 1 < puzzle.width && map[index + 1] !== region) ||
        (y + 1 < puzzle.height && map[index + puzzle.width] !== region);
      if (!boundary) continue;
      const offset = index * 4;
      output[offset] = 54;
      output[offset + 1] = 49;
      output[offset + 2] = 42;
      output[offset + 3] = 74;
    }
  }

  context.putImageData(boundaries, 0, 0);
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineJoin = "round";

  for (let region = 0; region < puzzle.regionCount; region += 1) {
    const anchorOffset = region * 2;
    const x = puzzle.labelAnchors[anchorOffset];
    const y = puzzle.labelAnchors[anchorOffset + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const area = puzzle.regionAreas[region] ?? 1;
    const fontSize = clamp(Math.sqrt(area) * 0.22, 8, 19);
    const label = String((puzzle.regionPalette[region] ?? 0) + 1);
    context.font = `600 ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    context.lineWidth = Math.max(2.5, fontSize * 0.3);
    context.strokeStyle = "rgba(255, 253, 248, 0.92)";
    context.strokeText(label, x, y);
    context.fillStyle = "rgba(53, 49, 42, 0.74)";
    context.fillText(label, x, y);
  }

  return { construction, colours, regionRuns };
}

function paintRegion(
  puzzle: PuzzleDataV1,
  layers: CanvasLayers,
  regionId: number,
  filled: boolean,
) {
  const context = layers.colours.getContext("2d");
  if (!context) return;
  const runs = layers.regionRuns[regionId];
  if (!runs) return;
  const colour = paletteColour(puzzle, puzzle.regionPalette[regionId] ?? 0);
  if (filled) {
    context.fillStyle = `rgb(${colour.red}, ${colour.green}, ${colour.blue})`;
  }

  for (let index = 0; index < runs.length; index += 2) {
    const start = runs[index];
    const length = runs[index + 1];
    const y = Math.floor(start / puzzle.width);
    const x = start - y * puzzle.width;
    if (filled) context.fillRect(x, y, length, 1);
    else context.clearRect(x, y, length, 1);
  }
}

function displayTransform(
  puzzle: PuzzleDataV1,
  width: number,
  height: number,
  view: ViewState,
) {
  const padding = width < 560 ? 20 : 38;
  const fit = Math.min(
    Math.max(0.01, (width - padding * 2) / puzzle.width),
    Math.max(0.01, (height - padding * 2) / puzzle.height),
  );
  const scale = fit * view.zoom;
  return {
    scale,
    x: (width - puzzle.width * scale) / 2 + view.panX,
    y: (height - puzzle.height * scale) / 2 + view.panY,
  };
}

function clipPuzzleSegment(
  start: Point,
  end: Point,
  width: number,
  height: number,
): readonly [Point, Point] | null {
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  const maxX = Math.max(0, width - 1e-6);
  const maxY = Math.max(0, height - 1e-6);
  let minimum = 0;
  let maximum = 1;

  const edges: readonly (readonly [number, number])[] = [
    [-deltaX, start.x],
    [deltaX, maxX - start.x],
    [-deltaY, start.y],
    [deltaY, maxY - start.y],
  ];
  for (const [direction, distance] of edges) {
    if (direction === 0) {
      if (distance < 0) return null;
      continue;
    }
    const ratio = distance / direction;
    if (direction < 0) minimum = Math.max(minimum, ratio);
    else maximum = Math.min(maximum, ratio);
    if (minimum > maximum) return null;
  }

  return [
    {
      x: start.x + deltaX * minimum,
      y: start.y + deltaY * minimum,
    },
    {
      x: start.x + deltaX * maximum,
      y: start.y + deltaY * maximum,
    },
  ];
}

/** Region IDs crossed by a puzzle-space stroke, including narrow sections. */
export function regionsAlongPuzzleSegment(
  puzzle: PuzzleDataV1,
  start: Point,
  end: Point,
): number[] {
  const clipped = clipPuzzleSegment(
    start,
    end,
    puzzle.width,
    puzzle.height,
  );
  if (!clipped) return [];

  const [from, to] = clipped;
  const deltaX = to.x - from.x;
  const deltaY = to.y - from.y;
  const steps = Math.max(
    1,
    Math.ceil(Math.max(Math.abs(deltaX), Math.abs(deltaY)) * 2),
  );
  const regions: number[] = [];
  let previousRegion = -1;
  for (let step = 0; step <= steps; step += 1) {
    const ratio = step / steps;
    const x = Math.floor(from.x + deltaX * ratio);
    const y = Math.floor(from.y + deltaY * ratio);
    const region = puzzle.regionMap[y * puzzle.width + x] ?? -1;
    if (region >= 0 && region !== previousRegion) {
      regions.push(region);
      previousRegion = region;
    }
  }
  return regions;
}

function phaseLabel(phase: string, message?: string) {
  if (message) return message;
  const labels: Record<string, string> = {
    smoothing: "Softening tiny details",
    lab: "Reading the colours",
    superpixels: "Sketching organic sections",
    merging: "Joining neighbouring shapes",
    palette: "Mixing your numbered palette",
    labels: "Placing the numbers",
    finalising: "Adding the finishing touches",
  };
  return labels[phase.toLowerCase()] ?? "Building your puzzle";
}

function safeDownloadName(name: string) {
  const stem = name.replace(/\.[^.]+$/, "").replace(/[^a-z0-9-_]+/gi, "-");
  return `${stem || "my-photo"}-colour-in.png`;
}

export function ColourGame() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const workerRef = useRef<Worker | null>(null);
  const jobNumberRef = useRef(0);
  const photoUrlRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const layersRef = useRef<CanvasLayers | null>(null);
  const fillFrameRef = useRef<number | null>(null);
  const filledRef = useRef(new Uint8Array(0));
  const undoRef = useRef<number[]>([]);
  const pulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activePointersRef = useRef(new Map<number, Point & { type: string }>());
  const strokeRegionsRef = useRef(new Set<number>());
  const pinchRef = useRef<{
    distance: number;
    anchor: Point;
    view: ViewState;
  } | null>(null);
  const paintStrokeRef = useRef<{
    pointerId: number;
    last: Point;
  } | null>(null);
  const mousePanRef = useRef<{
    start: Point;
    pan: Point;
  } | null>(null);
  const touchStrokeRef = useRef<{
    pointerId: number;
    start: Point;
    painting: boolean;
  } | null>(null);

  const [photo, setPhoto] = useState<DecodedPhoto | null>(null);
  const [puzzle, setPuzzle] = useState<PuzzleDataV1 | null>(null);
  const [preset, setPreset] = useState<PuzzlePresetKey>("balanced");
  const [isPreparing, setIsPreparing] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationProgress, setGenerationProgress] = useState(0);
  const [generationPhase, setGenerationPhase] = useState("Reading your photo");
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [selectedPalette, setSelectedPalette] = useState(0);
  const [filledArea, setFilledArea] = useState(0);
  const [filledCount, setFilledCount] = useState(0);
  const [filledRegions, setFilledRegions] = useState<Uint8Array>(
    new Uint8Array(0),
  );
  const [wrongRegion, setWrongRegion] = useState<number | null>(null);
  const [hintRegion, setHintRegion] = useState<number | null>(null);
  const [autoHintEnabled, setAutoHintEnabled] = useState(false);
  const [pulseVersion, setPulseVersion] = useState(0);
  const [announcement, setAnnouncement] = useState("");
  const [comparing, setComparing] = useState(false);
  const [view, setView] = useState<ViewState>({ zoom: 1, panX: 0, panY: 0 });
  const [canvasSize, setCanvasSize] = useState<CanvasSize>({ width: 0, height: 0 });
  const [keyboardRegion, setKeyboardRegion] = useState<number | null>(null);

  const totalArea = useMemo(() => {
    if (!puzzle) return 0;
    let total = 0;
    for (let region = 0; region < puzzle.regionCount; region += 1) {
      total += puzzle.regionAreas[region] ?? 0;
    }
    return total;
  }, [puzzle]);

  const progressPercent = totalArea
    ? Math.min(100, Math.round((filledArea / totalArea) * 100))
    : 0;
  const complete = Boolean(puzzle && filledCount >= puzzle.regionCount);
  const paletteSize = puzzle ? Math.floor(puzzle.palette.length / 3) : 0;

  const remainingByPalette = useMemo(() => {
    if (!puzzle) return [];
    const remaining = new Array(Math.floor(puzzle.palette.length / 3)).fill(0);
    for (let region = 0; region < puzzle.regionCount; region += 1) {
      if (!filledRegions[region]) {
        const colour = puzzle.regionPalette[region];
        if (colour < remaining.length) remaining[colour] += 1;
      }
    }
    return remaining;
  }, [filledRegions, puzzle]);

  const visibleHintTarget = useMemo(() => {
    if (!puzzle || complete) return null;
    return resolveVisibleHintTarget(
      puzzle,
      filledRegions,
      selectedPalette,
      hintRegion,
      autoHintEnabled,
    );
  }, [autoHintEnabled, complete, filledRegions, hintRegion, puzzle, selectedPalette]);

  const clearHint = useCallback(() => {
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    hintTimerRef.current = null;
    setHintRegion(null);
  }, []);

  const beginGeneration = useCallback(
    async (
      nextPhoto: DecodedPhoto,
      nextPreset: PuzzlePresetKey,
      suppliedPixels?: Uint8ClampedArray,
    ) => {
      const jobNumber = jobNumberRef.current + 1;
      jobNumberRef.current = jobNumber;
      const jobId = `puzzle-${jobNumber}`;
      workerRef.current?.terminate();
      workerRef.current = null;
      setError(null);
      setPuzzle(null);
      layersRef.current = null;
      filledRef.current = new Uint8Array(0);
      activePointersRef.current.clear();
      strokeRegionsRef.current.clear();
      pinchRef.current = null;
      mousePanRef.current = null;
      touchStrokeRef.current = null;
      paintStrokeRef.current = null;
      setFilledRegions(new Uint8Array(0));
      undoRef.current = [];
      setFilledArea(0);
      setFilledCount(0);
      setSelectedPalette(0);
      setKeyboardRegion(null);
      clearHint();
      setComparing(false);
      setView({ zoom: 1, panX: 0, panY: 0 });
      setGenerationProgress(3);
      setGenerationPhase("Reading your photo");
      setIsGenerating(true);

      try {
        // Never transfer the retained source itself: every preset starts from the
        // same lossless pixels and owns only this short-lived worker copy.
        const pixels = copySourcePixels(suppliedPixels ?? nextPhoto.sourceRgba);
        if (jobNumber !== jobNumberRef.current) return;

        const worker = new Worker(
          new URL("../workers/puzzle.worker.ts", import.meta.url),
          { type: "module" },
        );
        workerRef.current = worker;

        worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
          const message = event.data;
          if (message.jobId !== jobId || jobNumber !== jobNumberRef.current) return;

          if (message.type === "progress") {
            const normalised = message.progress <= 1 ? message.progress * 100 : message.progress;
            setGenerationProgress(clamp(Math.round(normalised), 4, 98));
            setGenerationPhase(phaseLabel(message.phase, message.message));
            return;
          }

          if (message.type === "error") {
            setError(message.error.message || "This photo couldn’t be turned into a puzzle.");
            setIsGenerating(false);
            worker.terminate();
            if (workerRef.current === worker) workerRef.current = null;
            return;
          }

          const nextPuzzle = message.puzzle;
          filledRef.current = new Uint8Array(nextPuzzle.regionCount);
          setFilledRegions(new Uint8Array(nextPuzzle.regionCount));
          undoRef.current = [];
          layersRef.current = buildCanvasLayers(nextPuzzle);
          setPuzzle(nextPuzzle);
          setSelectedPalette(0);
          setFilledArea(0);
          setFilledCount(0);
          setGenerationProgress(100);
          setGenerationPhase("Ready to colour");
          setIsGenerating(false);
          setAnnouncement(
            `Your ${PRESET_OPTIONS.find((option) => option.key === nextPreset)?.label.toLowerCase()} puzzle is ready with ${nextPuzzle.regionCount} sections.`,
          );
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        };

        worker.onerror = () => {
          if (jobNumber !== jobNumberRef.current) return;
          setError("The puzzle maker stopped unexpectedly. Please try this photo again.");
          setIsGenerating(false);
          worker.terminate();
          if (workerRef.current === worker) workerRef.current = null;
        };

        worker.postMessage(
          {
            type: "generate",
            jobId,
            width: nextPhoto.width,
            height: nextPhoto.height,
            rgba: pixels.buffer,
            preset: nextPreset,
          },
          [pixels.buffer],
        );
      } catch (generationError) {
        if (jobNumber !== jobNumberRef.current) return;
        setError(
          generationError instanceof Error
            ? generationError.message
            : "This photo couldn’t be turned into a puzzle.",
        );
        setIsGenerating(false);
      }
    },
    [clearHint],
  );

  const processFile = useCallback(
    async (file: File) => {
      if (puzzle && filledCount > 0) {
        const replace = window.confirm(
          "Choose a new photo? Your colouring progress on this one will be lost.",
        );
        if (!replace) return;
      }

      setIsPreparing(true);
      setError(null);
      workerRef.current?.terminate();
      const decodeRequest = jobNumberRef.current + 1;
      jobNumberRef.current = decodeRequest;

      try {
        const decoded = await decodePhoto(file);
        if (decodeRequest !== jobNumberRef.current) {
          URL.revokeObjectURL(decoded.photo.url);
          return;
        }
        if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
        photoUrlRef.current = decoded.photo.url;
        setPhoto(decoded.photo);
        setPreset("balanced");
        setIsPreparing(false);
        await beginGeneration(decoded.photo, "balanced", decoded.rgba);
      } catch (decodeError) {
        if (decodeRequest !== jobNumberRef.current) return;
        setError(
          decodeError instanceof Error
            ? decodeError.message
            : "That photo couldn’t be opened.",
        );
        setIsPreparing(false);
      }
    },
    [beginGeneration, filledCount, puzzle],
  );

  useEffect(() => {
    return () => {
      workerRef.current?.terminate();
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
      if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
      if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
      if (fillFrameRef.current !== null) cancelAnimationFrame(fillFrameRef.current);
    };
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const bounds = stage.getBoundingClientRect();
      setCanvasSize({ width: bounds.width, height: bounds.height });
    };
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [puzzle]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const layers = layersRef.current;
    if (!canvas || !puzzle || !layers || !canvasSize.width || !canvasSize.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.round(canvasSize.width * dpr));
    const pixelHeight = Math.max(1, Math.round(canvasSize.height * dpr));
    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
    }

    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, canvasSize.width, canvasSize.height);
    const transform = displayTransform(puzzle, canvasSize.width, canvasSize.height, view);

    context.save();
    context.translate(transform.x, transform.y);
    context.scale(transform.scale, transform.scale);
    context.fillStyle = UNFILLED_COLOUR;
    context.fillRect(0, 0, puzzle.width, puzzle.height);
    if (!complete) context.drawImage(layers.construction, 0, 0);
    context.drawImage(layers.colours, 0, 0);

    if (!complete && wrongRegion !== null && wrongRegion < puzzle.regionCount) {
      const anchorOffset = wrongRegion * 2;
      const x = puzzle.labelAnchors[anchorOffset];
      const y = puzzle.labelAnchors[anchorOffset + 1];
      const paletteIndex = puzzle.regionPalette[wrongRegion] ?? 0;
      const colour = paletteColour(puzzle, paletteIndex);
      const radius = 17 / Math.max(transform.scale, 0.01);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fillStyle = `rgba(${colour.red}, ${colour.green}, ${colour.blue}, 0.24)`;
      context.fill();
      context.lineWidth = 2.5 / Math.max(transform.scale, 0.01);
      context.strokeStyle = `rgb(${colour.red}, ${colour.green}, ${colour.blue})`;
      context.stroke();
      context.fillStyle = textColourFor(colour.red, colour.green, colour.blue);
      context.font = `700 ${14 / Math.max(transform.scale, 0.01)}px ui-sans-serif, system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(paletteIndex + 1), x, y);
    }

    if (!complete && visibleHintTarget) {
      const visibleHintRegion = visibleHintTarget.regionId;
      const anchorOffset = visibleHintRegion * 2;
      const x = puzzle.labelAnchors[anchorOffset];
      const y = puzzle.labelAnchors[anchorOffset + 1];
      const paletteIndex = visibleHintTarget.paletteIndex;
      const colour = paletteColour(puzzle, paletteIndex);
      const radius = 22 / Math.max(transform.scale, 0.01);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fillStyle = `rgba(${colour.red}, ${colour.green}, ${colour.blue}, 0.22)`;
      context.fill();
      context.lineWidth = 3 / Math.max(transform.scale, 0.01);
      context.strokeStyle = `rgb(${colour.red}, ${colour.green}, ${colour.blue})`;
      context.stroke();
      context.fillStyle = textColourFor(colour.red, colour.green, colour.blue);
      context.font = `700 ${14 / Math.max(transform.scale, 0.01)}px ui-sans-serif, system-ui, sans-serif`;
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(String(paletteIndex + 1), x, y);
    }

    if (!complete && keyboardRegion !== null && keyboardRegion < puzzle.regionCount) {
      const anchorOffset = keyboardRegion * 2;
      const x = puzzle.labelAnchors[anchorOffset];
      const y = puzzle.labelAnchors[anchorOffset + 1];
      const radius = 22 / Math.max(transform.scale, 0.01);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.lineWidth = 2 / Math.max(transform.scale, 0.01);
      context.strokeStyle = "#27241f";
      context.setLineDash([
        4 / Math.max(transform.scale, 0.01),
        4 / Math.max(transform.scale, 0.01),
      ]);
      context.stroke();
      context.setLineDash([]);
    }

    context.lineWidth = 1 / Math.max(transform.scale, 0.01);
    context.strokeStyle = "rgba(54, 49, 42, 0.2)";
    context.strokeRect(0, 0, puzzle.width, puzzle.height);
    context.restore();
  }, [
    canvasSize,
    complete,
    filledRegions,
    keyboardRegion,
    puzzle,
    pulseVersion,
    view,
    visibleHintTarget,
    wrongRegion,
  ]);

  const announcePulse = useCallback((regionId: number, message: string, duration = 700) => {
    if (pulseTimerRef.current) clearTimeout(pulseTimerRef.current);
    setWrongRegion(regionId);
    setPulseVersion((version) => version + 1);
    setAnnouncement(message);
    pulseTimerRef.current = setTimeout(() => {
      setWrongRegion(null);
      pulseTimerRef.current = null;
    }, duration);
  }, []);

  const findNextPalette = useCallback(
    (current: number) => {
      if (!puzzle) return current;
      return selectNextPalette(puzzle, filledRef.current, current) ?? current;
    },
    [puzzle],
  );

  const publishFilledRegions = useCallback(() => {
    if (fillFrameRef.current !== null) return;
    fillFrameRef.current = requestAnimationFrame(() => {
      fillFrameRef.current = null;
      setFilledRegions(filledRef.current.slice());
    });
  }, []);

  const attemptRegion = useCallback(
    (regionId: number, deduplicate = false) => {
      if (!canAttemptPuzzleRegion(puzzle, complete, comparing, regionId)) return;
      clearHint();
      if (deduplicate) setKeyboardRegion(null);
      if (deduplicate) {
        if (strokeRegionsRef.current.has(regionId)) return;
        strokeRegionsRef.current.add(regionId);
      }
      const validation = validateFill(
        puzzle,
        filledRef.current,
        selectedPalette,
        regionId,
      );
      if (!validation.allowed) {
        if (
          validation.reason !== "wrong-colour" ||
          validation.expectedPalette === null
        ) {
          return;
        }
        const correctPalette = validation.expectedPalette;
        announcePulse(
          regionId,
          `That section is number ${correctPalette + 1}. Choose colour ${correctPalette + 1} to fill it.`,
        );
        return;
      }

      filledRef.current[regionId] = 1;
      publishFilledRegions();
      undoRef.current.push(regionId);
      if (layersRef.current) {
        paintRegion(puzzle, layersRef.current, regionId, true);
      }
      const nextFilledCount = undoRef.current.length;
      setFilledArea((area) => area + (puzzle.regionAreas[regionId] ?? 0));
      setFilledCount(nextFilledCount);

      let selectedRemaining = false;
      for (let region = 0; region < puzzle.regionCount; region += 1) {
        if (
          !filledRef.current[region] &&
          puzzle.regionPalette[region] === selectedPalette
        ) {
          selectedRemaining = true;
          break;
        }
      }

      let nextPalette = selectedPalette;
      if (!selectedRemaining && nextFilledCount < puzzle.regionCount) {
        nextPalette = findNextPalette(selectedPalette);
        setSelectedPalette(nextPalette);
        setAnnouncement(
          `Colour ${selectedPalette + 1} is complete. Colour ${nextPalette + 1} is selected.`,
        );
      } else if (nextFilledCount >= puzzle.regionCount) {
        setAnnouncement("Puzzle complete. Every section is beautifully filled.");
      } else {
        setAnnouncement(`Section ${regionId + 1} filled.`);
      }

      if (nextFilledCount >= puzzle.regionCount) {
        setKeyboardRegion(null);
      } else if (!deduplicate && keyboardRegion !== null) {
        let nextKeyboardRegion = -1;
        for (let step = 1; step <= puzzle.regionCount; step += 1) {
          const candidate = (regionId + step) % puzzle.regionCount;
          if (
            !filledRef.current[candidate] &&
            puzzle.regionPalette[candidate] === nextPalette
          ) {
            nextKeyboardRegion = candidate;
            break;
          }
        }
        setKeyboardRegion(nextKeyboardRegion >= 0 ? nextKeyboardRegion : null);
      } else {
        setKeyboardRegion(null);
      }
    },
    [
      announcePulse,
      clearHint,
      complete,
      comparing,
      findNextPalette,
      publishFilledRegions,
      puzzle,
      keyboardRegion,
      selectedPalette,
    ],
  );

  const clientToPuzzlePoint = useCallback(
    (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas || !puzzle) return null;
      const bounds = canvas.getBoundingClientRect();
      const transform = displayTransform(puzzle, bounds.width, bounds.height, view);
      return {
        x: (clientX - bounds.left - transform.x) / transform.scale,
        y: (clientY - bounds.top - transform.y) / transform.scale,
      };
    },
    [puzzle, view],
  );

  const attemptAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      if (!puzzle) return;
      const point = clientToPuzzlePoint(clientX, clientY);
      if (!point) return;
      const x = Math.floor(point.x);
      const y = Math.floor(point.y);
      if (x < 0 || y < 0 || x >= puzzle.width || y >= puzzle.height) return;
      const region = puzzle.regionMap[y * puzzle.width + x] ?? -1;
      if (region >= 0) attemptRegion(region, true);
    },
    [attemptRegion, clientToPuzzlePoint, puzzle],
  );

  const attemptAlongSegment = useCallback(
    (start: Point, end: Point) => {
      if (!puzzle) return;
      const puzzleStart = clientToPuzzlePoint(start.x, start.y);
      const puzzleEnd = clientToPuzzlePoint(end.x, end.y);
      if (!puzzleStart || !puzzleEnd) return;
      for (const region of regionsAlongPuzzleSegment(
        puzzle,
        puzzleStart,
        puzzleEnd,
      )) {
        attemptRegion(region, true);
      }
    },
    [attemptRegion, clientToPuzzlePoint, puzzle],
  );

  const paintCoalescedPointerEvent = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      const stroke = paintStrokeRef.current;
      if (!stroke || stroke.pointerId !== event.pointerId) return;
      let coalesced: PointerEvent[] = [];
      try {
        coalesced = event.nativeEvent.getCoalescedEvents?.() ?? [];
      } catch {
        // Older Pointer Events implementations expose but do not support it.
      }
      const points = coalesced.map((sample) => ({
        x: sample.clientX,
        y: sample.clientY,
      }));
      const last = points.at(-1);
      if (!last || last.x !== event.clientX || last.y !== event.clientY) {
        points.push({ x: event.clientX, y: event.clientY });
      }
      for (const point of points) {
        attemptAlongSegment(stroke.last, point);
        stroke.last = point;
      }
    },
    [attemptAlongSegment],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const mousePan =
      event.pointerType === "mouse" &&
      (event.button === 1 || (event.button === 0 && event.shiftKey));
    if (event.pointerType === "mouse" && !mousePan && event.button !== 0) return;

    setKeyboardRegion(null);
    event.currentTarget.setPointerCapture(event.pointerId);
    activePointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
    });

    const touches = [...activePointersRef.current.values()].filter(
      (pointer) => pointer.type === "touch",
    );
    if (touches.length >= 2) {
      touchStrokeRef.current = null;
      paintStrokeRef.current = null;
      const first = touches[0];
      const second = touches[1];
      const centre = {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2,
      };
      const anchor = clientToPuzzlePoint(centre.x, centre.y);
      if (!anchor) return;
      pinchRef.current = {
        distance: Math.hypot(second.x - first.x, second.y - first.y),
        anchor,
        view,
      };
      return;
    }

    if (event.pointerType === "touch") {
      strokeRegionsRef.current.clear();
      touchStrokeRef.current = {
        pointerId: event.pointerId,
        start: { x: event.clientX, y: event.clientY },
        painting: false,
      };
      return;
    }

    if (mousePan) {
      mousePanRef.current = {
        start: { x: event.clientX, y: event.clientY },
        pan: { x: view.panX, y: view.panY },
      };
      return;
    }

    strokeRegionsRef.current.clear();
    paintStrokeRef.current = {
      pointerId: event.pointerId,
      last: { x: event.clientX, y: event.clientY },
    };
    attemptAtPoint(event.clientX, event.clientY);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!activePointersRef.current.has(event.pointerId)) return;
    activePointersRef.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      type: event.pointerType,
    });

    const touches = [...activePointersRef.current.values()].filter(
      (pointer) => pointer.type === "touch",
    );
    if (touches.length >= 2 && pinchRef.current) {
      const first = touches[0];
      const second = touches[1];
      const distance = Math.max(1, Math.hypot(second.x - first.x, second.y - first.y));
      const centre = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
      const nextZoom = clamp(
        pinchRef.current.view.zoom * (distance / Math.max(1, pinchRef.current.distance)),
        0.75,
        5,
      );
      const canvas = canvasRef.current;
      if (canvas && puzzle) {
        const bounds = canvas.getBoundingClientRect();
        const base = displayTransform(puzzle, bounds.width, bounds.height, {
          zoom: nextZoom,
          panX: 0,
          panY: 0,
        });
        setView({
          zoom: nextZoom,
          panX:
            centre.x - bounds.left - base.x - pinchRef.current.anchor.x * base.scale,
          panY:
            centre.y - bounds.top - base.y - pinchRef.current.anchor.y * base.scale,
        });
      }
      return;
    }

    if (
      event.pointerType === "touch" &&
      touchStrokeRef.current?.pointerId === event.pointerId
    ) {
      const touchStroke = touchStrokeRef.current;
      const movement = Math.hypot(
        event.clientX - touchStroke.start.x,
        event.clientY - touchStroke.start.y,
      );
      if (touchStroke.painting || movement > 5) {
        if (!touchStroke.painting) {
          touchStroke.painting = true;
          paintStrokeRef.current = {
            pointerId: event.pointerId,
            last: touchStroke.start,
          };
          attemptAtPoint(touchStroke.start.x, touchStroke.start.y);
        }
        paintCoalescedPointerEvent(event);
      }
      return;
    }

    // A finger left behind after a pinch stays a navigation gesture; lifting
    // both fingers before painting avoids an accidental fill.
    if (event.pointerType === "touch") return;

    if (mousePanRef.current) {
      setView((current) => ({
        ...current,
        panX:
          mousePanRef.current!.pan.x +
          (event.clientX - mousePanRef.current!.start.x),
        panY:
          mousePanRef.current!.pan.y +
          (event.clientY - mousePanRef.current!.start.y),
      }));
      return;
    }

    if (event.pointerType === "mouse" && (event.buttons & 1) === 0) return;
    paintCoalescedPointerEvent(event);
  };

  const releasePointer = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (
      event.type === "pointerup" &&
      paintStrokeRef.current?.pointerId === event.pointerId
    ) {
      paintCoalescedPointerEvent(event);
    }
    if (
      event.type === "pointerup" &&
      event.pointerType === "touch" &&
      touchStrokeRef.current?.pointerId === event.pointerId &&
      !touchStrokeRef.current.painting
    ) {
      attemptAtPoint(event.clientX, event.clientY);
    }
    if (touchStrokeRef.current?.pointerId === event.pointerId) {
      touchStrokeRef.current = null;
    }
    if (paintStrokeRef.current?.pointerId === event.pointerId) {
      paintStrokeRef.current = null;
    }
    activePointersRef.current.delete(event.pointerId);
    if (activePointersRef.current.size < 2) pinchRef.current = null;
    mousePanRef.current = null;
    strokeRegionsRef.current.clear();
  };

  const handleWheel = (event: WheelEvent<HTMLCanvasElement>) => {
    event.preventDefault();
    const direction = event.deltaY > 0 ? -0.14 : 0.14;
    setView((current) => ({
      ...current,
      zoom: clamp(current.zoom + direction, 0.75, 5),
    }));
  };

  const choosePalette = (paletteIndex: number) => {
    clearHint();
    setKeyboardRegion(null);
    setSelectedPalette(paletteIndex);
    setAnnouncement(
      `Colour ${paletteIndex + 1} selected. ${remainingByPalette[paletteIndex]} sections remaining.`,
    );
  };

  const toggleAutoHint = () => {
    const nextEnabled = !autoHintEnabled;
    setAutoHintEnabled(nextEnabled);
    if (!nextEnabled) clearHint();
    setAnnouncement(
      nextEnabled
        ? "Automatic hints on. The next matching section will stay highlighted."
        : "Automatic hints off. Press Hint when you want help.",
    );
  };

  const showHint = useCallback(() => {
    if (!puzzle || complete) return;
    const target = findHintTarget(puzzle, filledRef.current, selectedPalette);
    if (!target) return;
    setKeyboardRegion(null);
    if (target.paletteIndex !== selectedPalette) {
      setSelectedPalette(target.paletteIndex);
    }
    if (hintTimerRef.current) clearTimeout(hintTimerRef.current);
    setHintRegion(target.regionId);
    setAnnouncement(
      `Hint: look for the highlighted number ${target.paletteIndex + 1}.`,
    );
    hintTimerRef.current = setTimeout(() => {
      setHintRegion(null);
      hintTimerRef.current = null;
    }, 1_400);
  }, [complete, puzzle, selectedPalette]);

  const undo = useCallback(() => {
    if (!puzzle) return;
    clearHint();
    const regionId = undoRef.current.pop();
    if (regionId === undefined) {
      setAnnouncement("There is nothing to undo yet.");
      return;
    }
    filledRef.current[regionId] = 0;
    setFilledRegions(filledRef.current.slice());
    if (layersRef.current) paintRegion(puzzle, layersRef.current, regionId, false);
    setFilledArea((area) => Math.max(0, area - (puzzle.regionAreas[regionId] ?? 0)));
    setFilledCount((count) => Math.max(0, count - 1));
    setSelectedPalette(puzzle.regionPalette[regionId] ?? 0);
    setKeyboardRegion(null);
    setAnnouncement(`Last fill undone. Colour ${puzzle.regionPalette[regionId] + 1} selected.`);
  }, [clearHint, puzzle]);

  const reset = () => {
    if (!puzzle || !filledCount) return;
    if (!window.confirm("Reset every filled section and start this puzzle again?")) return;
    filledRef.current.fill(0);
    setFilledRegions(new Uint8Array(puzzle.regionCount));
    undoRef.current = [];
    layersRef.current?.colours.getContext("2d")?.clearRect(0, 0, puzzle.width, puzzle.height);
    setFilledArea(0);
    setFilledCount(0);
    setSelectedPalette(0);
    setKeyboardRegion(null);
    clearHint();
    setComparing(false);
    setAnnouncement("Puzzle reset.");
  };

  const changePreset = async (nextPreset: PuzzlePresetKey) => {
    if (!photo || nextPreset === preset || isGenerating) return;
    if (
      filledCount > 0 &&
      !window.confirm("Change the detail level? Your colouring progress will be lost.")
    ) {
      return;
    }
    setPreset(nextPreset);
    await beginGeneration(photo, nextPreset);
  };

  const startNewPhoto = () => {
    fileInputRef.current?.click();
  };

  const download = () => {
    if (!puzzle || !complete || !photo) return;
    const announceFailure = () => {
      const message = "The finished artwork couldn’t be downloaded. Please try again.";
      setError(message);
      setAnnouncement(message);
    };
    const canvas = createCanvas(puzzle.width, puzzle.height);
    const context = canvas.getContext("2d");
    if (!context) {
      announceFailure();
      return;
    }
    try {
      const image = context.createImageData(puzzle.width, puzzle.height);
      image.data.set(createFlatColourExportBuffer(puzzle));
      context.putImageData(image, 0, 0);
      canvas.toBlob((blob) => {
        if (!blob) {
          announceFailure();
          return;
        }
        const url = URL.createObjectURL(blob);
        try {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = safeDownloadName(photo.name);
          anchor.click();
          setError(null);
          setAnnouncement("Finished artwork downloaded as a PNG.");
        } catch {
          announceFailure();
        } finally {
          setTimeout(() => URL.revokeObjectURL(url), 0);
        }
      }, "image/png");
    } catch {
      announceFailure();
    }
  };

  const handleCanvasKeyDown = (event: KeyboardEvent<HTMLCanvasElement>) => {
    if (!puzzle) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      undo();
      return;
    }
    if (event.key.toLowerCase() === "h") {
      event.preventDefault();
      showHint();
      return;
    }
    if (event.key.toLowerCase() === "f" || event.key === "0") {
      event.preventDefault();
      setView({ zoom: 1, panX: 0, panY: 0 });
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      setView((current) => ({ ...current, zoom: clamp(current.zoom + 0.2, 0.75, 5) }));
      return;
    }
    if (event.key === "-") {
      event.preventDefault();
      setView((current) => ({ ...current, zoom: clamp(current.zoom - 0.2, 0.75, 5) }));
      return;
    }
    if (/^[1-9]$/.test(event.key)) {
      const paletteIndex = Number(event.key) - 1;
      if (paletteIndex < paletteSize && remainingByPalette[paletteIndex] > 0) {
        event.preventDefault();
        choosePalette(paletteIndex);
      }
      return;
    }

    const unfinished = Array.from({ length: puzzle.regionCount }, (_, region) => region).filter(
      (region) => !filledRef.current[region],
    );
    if (!unfinished.length) return;

    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
      const currentIndex = unfinished.indexOf(keyboardRegion ?? -1);
      const nextIndex =
        currentIndex < 0
          ? direction > 0
            ? 0
            : unfinished.length - 1
          : (currentIndex + direction + unfinished.length) % unfinished.length;
      const regionId = unfinished[nextIndex];
      setKeyboardRegion(regionId);
      setAnnouncement(
        `Section ${regionId + 1}, number ${puzzle.regionPalette[regionId] + 1}. Press Enter to colour it.`,
      );
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const regionId = keyboardRegion ?? hintRegion ?? unfinished[0];
      setKeyboardRegion(regionId);
      attemptRegion(regionId);
    }
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) void processFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void processFile(file);
  };

  const comparisonStyle = useMemo<CSSProperties | undefined>(() => {
    if (!puzzle || !canvasSize.width || !canvasSize.height) return undefined;
    const transform = displayTransform(puzzle, canvasSize.width, canvasSize.height, view);
    return {
      width: puzzle.width * transform.scale,
      height: puzzle.height * transform.scale,
      left: transform.x,
      top: transform.y,
    };
  }, [canvasSize, puzzle, view]);

  const activePreset = PRESET_OPTIONS.find((option) => option.key === preset)!;
  const hasExperience = Boolean(photo || isPreparing || isGenerating);

  return (
    <main className={styles.appShell}>
      <input
        ref={fileInputRef}
        className={styles.visuallyHidden}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/heic,image/heif,.heic,.heif"
        onChange={handleFileChange}
        aria-label="Choose a photo"
      />
      <p className={styles.visuallyHidden} aria-live="polite" aria-atomic="true">
        {announcement}
      </p>

      {!hasExperience ? (
        <section className={styles.welcome} aria-labelledby="welcome-title">
          <header className={styles.welcomeHeader}>
            <a className={styles.brand} href="#" aria-label="Colour in Photo home">
              <span className={styles.brandMark} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>Colour in Photo</span>
            </a>
            <span className={styles.privatePill}>Private by design</span>
          </header>

          <div className={styles.welcomeGrid}>
            <div className={styles.welcomeCopy}>
              <p className={styles.eyebrow}>Your photograph, reimagined</p>
              <h1 id="welcome-title">
                Turn a favourite photo into a canvas you can colour.
              </h1>
              <p className={styles.intro}>
                We’ll simplify your photo into organic numbered shapes and a
                beautifully limited palette. Every finished section stays a pure,
                flat colour.
              </p>
              <div className={styles.steps} aria-label="How it works">
                <span><b>1</b> Choose</span>
                <span><b>2</b> Create</span>
                <span><b>3</b> Colour</span>
              </div>
            </div>

            <div
              className={`${styles.dropZone} ${isDragging ? styles.dropZoneActive : ""}`}
              onDragEnter={(event) => {
                event.preventDefault();
                setIsDragging(true);
              }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                  setIsDragging(false);
                }
              }}
              onDrop={handleDrop}
            >
              <div className={styles.photoGlyph} aria-hidden="true">
                <span />
                <i />
              </div>
              <h2>Choose a photo</h2>
              <p>Pick from Photos or Files, or drop one here.</p>
              <button className={styles.primaryButton} type="button" onClick={startNewPhoto}>
                Select photo
              </button>
              <small>
                JPEG, PNG, WebP or HEIC · large photos resized automatically
              </small>
              {error && (
                <div className={styles.inlineError} role="alert">
                  {error}
                </div>
              )}
            </div>
          </div>

          <footer className={styles.privacyNote}>
            <span className={styles.lockGlyph} aria-hidden="true" />
            <span>
              <strong>Processed on this device.</strong> Your photo isn’t uploaded.
            </span>
          </footer>
        </section>
      ) : !puzzle ? (
        <section className={styles.preparing} aria-labelledby="preparing-title">
          <header className={styles.simpleHeader}>
            <button className={styles.brandButton} type="button" onClick={startNewPhoto}>
              <span className={styles.brandMark} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>Colour in Photo</span>
            </button>
          </header>

          <div className={styles.preparingCard}>
            {photo ? (
              <div className={styles.preparingPreview}>
                {/* The source shown here is the local, downsampled object URL. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={photo.url} alt="Your selected photo" />
                <div className={styles.previewVeil} aria-hidden="true" />
              </div>
            ) : (
              <div className={styles.preparingPlaceholder} aria-hidden="true" />
            )}
            <div className={styles.preparingCopy}>
              <p className={styles.eyebrow}>{isPreparing ? "Preparing photo" : activePreset.label}</p>
              <h1 id="preparing-title">
                {error ? "Let’s try that again." : generationPhase}
              </h1>
              {error ? (
                <>
                  <p className={styles.errorCopy} role="alert">{error}</p>
                  <div className={styles.recoveryActions}>
                    {photo && (
                      <button
                        className={styles.primaryButton}
                        type="button"
                        onClick={() => void beginGeneration(photo, preset)}
                      >
                        Try again
                      </button>
                    )}
                    <button className={styles.secondaryButton} type="button" onClick={startNewPhoto}>
                      Choose another photo
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <p>
                    {isPreparing
                      ? "Checking the size and colour of your image…"
                      : "Finding shapes, mixing colours, and placing each number."}
                  </p>
                  <div
                    className={styles.progressTrack}
                    role="progressbar"
                    aria-label="Puzzle generation progress"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={isPreparing ? 1 : generationProgress}
                  >
                    <span style={{ width: `${isPreparing ? 6 : generationProgress}%` }} />
                  </div>
                  <span className={styles.progressValue}>
                    {isPreparing ? "Just a moment" : `${generationProgress}%`}
                  </span>
                </>
              )}
            </div>
          </div>
          <p className={styles.localNote}>Everything is happening locally in your browser.</p>
        </section>
      ) : (
        <section className={styles.game} aria-labelledby="game-title">
          <h1 id="game-title" className={styles.visuallyHidden}>
            Colour in Photo puzzle
          </h1>
          <header className={styles.gameHeader}>
            <button className={styles.brandButton} type="button" onClick={startNewPhoto}>
              <span className={styles.brandMark} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>Colour in Photo</span>
            </button>

            <div className={styles.headerProgress}>
              <span>{complete ? "Complete" : "Your progress"}</span>
              <div className={styles.compactProgress} aria-hidden="true">
                <span style={{ width: `${progressPercent}%` }} />
              </div>
              <strong>{progressPercent}%</strong>
            </div>

            <button className={styles.newPhotoButton} type="button" onClick={startNewPhoto}>
              New photo
            </button>
          </header>

          <div className={styles.gameBody}>
            <div className={styles.workspace}>
              <div className={styles.topControls}>
                <div
                  className={styles.presetControl}
                  role="group"
                  aria-label="Puzzle detail level"
                >
                  {PRESET_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      aria-pressed={preset === option.key}
                      className={preset === option.key ? styles.presetActive : ""}
                      onClick={() => void changePreset(option.key)}
                    >
                      <span>{option.label}</span>
                      <small>{option.colours} colours</small>
                    </button>
                  ))}
                </div>

                <div className={styles.toolRow} role="group" aria-label="Puzzle tools">
                  <button type="button" onClick={undo} disabled={!filledCount}>
                    <span aria-hidden="true">↶</span> Undo
                  </button>
                  <button type="button" onClick={showHint} disabled={complete}>
                    <span aria-hidden="true">✦</span> Hint
                  </button>
                  <button
                    type="button"
                    className={autoHintEnabled ? styles.toolActive : ""}
                    onClick={toggleAutoHint}
                    aria-pressed={autoHintEnabled}
                    aria-label={`Automatic hints ${autoHintEnabled ? "on" : "off"}`}
                    disabled={complete}
                  >
                    <span aria-hidden="true">◎</span> Auto-hint
                  </button>
                  <button
                    type="button"
                    onClick={() => setComparing((current) => !current)}
                    aria-pressed={comparing}
                    aria-label="Compare original photo"
                  >
                    <span aria-hidden="true">◐</span> {comparing ? "Puzzle" : "Original"}
                  </button>
                  <button type="button" onClick={reset} disabled={!filledCount}>
                    Reset
                  </button>
                </div>
              </div>

              {photo?.warning && (
                <div className={styles.photoWarning} role="status">
                  {photo.warning}
                </div>
              )}
              {isPreparing && (
                <div className={styles.photoWarning} role="status">
                  Preparing your new photo…
                </div>
              )}
              {error && (
                <div className={styles.gameError} role="alert">
                  <span>{error}</span>
                  <button type="button" onClick={() => setError(null)}>
                    Dismiss
                  </button>
                </div>
              )}

              <div className={styles.canvasStage} ref={stageRef}>
                <canvas
                  ref={canvasRef}
                  className={styles.canvas}
                  role="application"
                  tabIndex={0}
                  aria-label={
                    complete
                      ? "Completed colour-by-numbers artwork. Use the zoom controls to inspect it."
                      : "Colouring canvas. Select a colour, then tap matching numbered sections. Use arrow keys to move between sections and Enter to fill."
                  }
                  onBlur={() => setKeyboardRegion(null)}
                  onKeyDown={handleCanvasKeyDown}
                  onPointerDown={handlePointerDown}
                  onPointerMove={handlePointerMove}
                  onPointerUp={releasePointer}
                  onPointerCancel={releasePointer}
                  onWheel={handleWheel}
                />

                {photo && comparing && comparisonStyle && (
                  // The source is a short-lived local object URL, not a network image.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className={styles.originalOverlay}
                    src={photo.url}
                    alt="Original photo comparison"
                    style={comparisonStyle}
                  />
                )}

                <div
                  className={styles.zoomControls}
                  role="group"
                  aria-label="Canvas zoom controls"
                >
                  <button
                    type="button"
                    aria-label="Zoom out"
                    onClick={() =>
                      setView((current) => ({
                        ...current,
                        zoom: clamp(current.zoom - 0.2, 0.75, 5),
                      }))
                    }
                  >
                    −
                  </button>
                  <button
                    type="button"
                    className={styles.zoomValue}
                    aria-label="Fit puzzle to screen"
                    onClick={() => setView({ zoom: 1, panX: 0, panY: 0 })}
                  >
                    {Math.round(view.zoom * 100)}%
                  </button>
                  <button
                    type="button"
                    aria-label="Zoom in"
                    onClick={() =>
                      setView((current) => ({
                        ...current,
                        zoom: clamp(current.zoom + 0.2, 0.75, 5),
                      }))
                    }
                  >
                    +
                  </button>
                </div>

                {!complete && (
                  <p className={styles.gestureHint}>
                    Tap or sweep to fill · two fingers to move and zoom
                  </p>
                )}
              </div>
            </div>

            <aside
              className={`${styles.palettePanel} ${complete ? styles.completionPanel : ""}`}
              aria-labelledby={complete ? "completion-title" : "palette-title"}
              aria-describedby={complete ? "completion-description" : undefined}
            >
              {complete ? (
                <div className={styles.completeCard}>
                  <div className={styles.confetti} aria-hidden="true">
                    <i /><i /><i /><i /><i />
                  </div>
                  <div className={styles.completionCopy}>
                    <span className={styles.completeKicker}>Beautifully done</span>
                    <h2 id="completion-title">Your picture is complete.</h2>
                    <p id="completion-description">
                      Every section is now one pure, flat colour.
                    </p>
                  </div>
                  <div className={styles.completionActions}>
                    <button
                      className={styles.secondaryButton}
                      type="button"
                      onClick={() => setComparing((current) => !current)}
                      aria-pressed={comparing}
                      aria-label="Compare original photo"
                    >
                      {comparing ? "View artwork" : "Compare original"}
                    </button>
                    <button
                      className={styles.primaryButton}
                      type="button"
                      onClick={download}
                    >
                      Download PNG
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div className={styles.paletteHeading}>
                    <div>
                      <p className={styles.eyebrow}>Your colours</p>
                      <h2 id="palette-title">Pick a number</h2>
                    </div>
                    <span>{puzzle.regionCount - filledCount} left</span>
                  </div>
                  <div className={styles.paletteList}>
                    {Array.from({ length: paletteSize }, (_, paletteIndex) => {
                      const colour = paletteColour(puzzle, paletteIndex);
                      const remaining = remainingByPalette[paletteIndex] ?? 0;
                      const selected = selectedPalette === paletteIndex;
                      return (
                        <button
                          type="button"
                          key={paletteIndex}
                          className={`${styles.paletteItem} ${selected ? styles.paletteSelected : ""} ${remaining === 0 ? styles.paletteDone : ""}`}
                          onClick={() => choosePalette(paletteIndex)}
                          disabled={remaining === 0}
                          aria-pressed={selected}
                          aria-label={`Colour ${paletteIndex + 1}, ${remaining} sections remaining`}
                        >
                          <span
                            className={styles.swatch}
                            style={{
                              backgroundColor: paletteCss(puzzle, paletteIndex),
                              color: textColourFor(colour.red, colour.green, colour.blue),
                            }}
                          >
                            {remaining === 0 ? "✓" : paletteIndex + 1}
                          </span>
                          <span className={styles.paletteMeta}>
                            <strong>Colour {paletteIndex + 1}</strong>
                            <small>{remaining === 0 ? "Complete" : `${remaining} ${remaining === 1 ? "section" : "sections"}`}</small>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                  <div className={styles.paletteTip}>
                    <span aria-hidden="true">⌁</span>
                    <p><strong>Pencil ready</strong> Sweep across matching areas to fill them quickly.</p>
                  </div>
                </>
              )}
            </aside>
          </div>
        </section>
      )}
    </main>
  );
}
