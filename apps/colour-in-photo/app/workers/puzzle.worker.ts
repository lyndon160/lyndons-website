/// <reference lib="webworker" />

import {
  generatePuzzle,
  PuzzleGenerationError,
} from "../lib/puzzle-core";
import {
  isPuzzlePresetKey,
  type PuzzleDataV1,
  type PuzzlePresetKey,
  type PuzzleWorkerError,
  type PuzzleWorkerErrorResponse,
  type PuzzleWorkerRequest,
  type PuzzleWorkerResponse,
} from "../lib/puzzle-types";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
const cancelledJobs = new Set<string>();

workerScope.onmessage = (event: MessageEvent<PuzzleWorkerRequest>) => {
  const request = event.data;
  if (request.type === "cancel") {
    cancelledJobs.add(request.jobId);
    return;
  }

  const preset: PuzzlePresetKey = isPuzzlePresetKey(request.preset)
    ? request.preset
    : "balanced";

  if (!isPuzzlePresetKey(request.preset)) {
    postError(request.jobId, preset, {
      code: "INVALID_INPUT",
      message: "The selected detail preset is not recognised.",
      recoverable: true,
    });
    return;
  }

  if (cancelledJobs.delete(request.jobId)) {
    postError(request.jobId, preset, {
      code: "CANCELLED",
      message: "Puzzle generation was cancelled.",
      recoverable: true,
    });
    return;
  }

  try {
    const rgba = new Uint8ClampedArray(request.rgba);
    const puzzle = generatePuzzle({
      width: request.width,
      height: request.height,
      rgba,
      preset,
      onProgress(update) {
        if (cancelledJobs.has(request.jobId)) {
          throw new PuzzleGenerationError(
            "CANCELLED",
            "Puzzle generation was cancelled.",
          );
        }
        const response: PuzzleWorkerResponse = {
          type: "progress",
          jobId: request.jobId,
          preset,
          ...update,
        };
        workerScope.postMessage(response);
      },
    });

    if (cancelledJobs.delete(request.jobId)) {
      postError(request.jobId, preset, {
        code: "CANCELLED",
        message: "Puzzle generation was cancelled.",
        recoverable: true,
      });
      return;
    }

    const response: PuzzleWorkerResponse = {
      type: "complete",
      jobId: request.jobId,
      preset,
      puzzle,
    };
    workerScope.postMessage(response, transferPuzzleBuffers(puzzle));
  } catch (error) {
    cancelledJobs.delete(request.jobId);
    if (error instanceof PuzzleGenerationError) {
      postError(request.jobId, preset, {
        code: error.code,
        message: error.message,
        recoverable: error.recoverable,
      });
      return;
    }
    postError(request.jobId, preset, {
      code: "PROCESSING_FAILED",
      message:
        error instanceof Error
          ? error.message
          : "The photo could not be turned into a puzzle.",
      recoverable: true,
    });
  }
};

function transferPuzzleBuffers(puzzle: PuzzleDataV1): Transferable[] {
  return [
    puzzle.palette.buffer,
    puzzle.regionMap.buffer,
    puzzle.regionPalette.buffer,
    puzzle.regionAreas.buffer,
    puzzle.regionBounds.buffer,
    puzzle.labelAnchors.buffer,
  ] as ArrayBuffer[];
}

function postError(
  jobId: string,
  preset: PuzzlePresetKey,
  error: PuzzleWorkerError,
): void {
  const response: PuzzleWorkerErrorResponse = {
    type: "error",
    jobId,
    preset,
    error,
  };
  workerScope.postMessage(response);
}

export {};
