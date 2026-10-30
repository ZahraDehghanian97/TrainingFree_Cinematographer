import { Worker } from "node:worker_threads";
import { PipelineAbortError, type TrajectoryOptimizer } from "./orchestrator";

const WORKER_BOOTSTRAP = String.raw`
"use strict";
const { parentPort, workerData } = require("node:worker_threads");

function serializeError(error) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return {
    name: "Error",
    message: typeof error === "string" ? error : "Optimizer worker failed.",
  };
}

try {
  if (workerData.registerModulePath) {
    require(workerData.registerModulePath);
  }
  const optimizerModule = require(workerData.optimizerModulePath);
  if (typeof optimizerModule.optimizeCameraTrajectory !== "function") {
    throw new TypeError(
      "Optimizer worker module must export optimizeCameraTrajectory().",
    );
  }
  const result = optimizerModule.optimizeCameraTrajectory(workerData.input);
  parentPort.postMessage({ type: "result", result });
} catch (error) {
  parentPort.postMessage({ type: "error", error: serializeError(error) });
}
`;

interface SerializedWorkerError {
  name?: string;
  message?: string;
  stack?: string;
}

export interface NodeWorkerTrajectoryOptimizerOptions {
  /** Absolute path to a CommonJS-loadable optimizer module. */
  optimizerModulePath: string;
  /** Optional require hook, e.g. ts-node/register/transpile-only for source mode. */
  registerModulePath?: string;
}

function reviveWorkerError(serialized: SerializedWorkerError): Error {
  const error = new Error(serialized.message || "Optimizer worker failed.");
  error.name = serialized.name || "Error";
  if (serialized.stack) error.stack = serialized.stack;
  return error;
}

/**
 * Creates a one-worker-per-run optimizer. Terminating the worker makes aborts
 * immediate even while the numerical solver is inside a synchronous hot loop.
 */
export function createNodeWorkerTrajectoryOptimizer(
  options: NodeWorkerTrajectoryOptimizerOptions,
): TrajectoryOptimizer {
  return (input, context) => new Promise((resolve, reject) => {
    const signal = context.abortSignal;
    if (signal?.aborted) {
      reject(new PipelineAbortError());
      return;
    }

    const worker = new Worker(WORKER_BOOTSTRAP, {
      eval: true,
      workerData: {
        input,
        optimizerModulePath: options.optimizerModulePath,
        ...(options.registerModulePath === undefined
          ? {}
          : { registerModulePath: options.registerModulePath }),
      },
    });
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
      worker.removeAllListeners();
    };
    const finish = (
      settle: () => void,
      terminate = false,
    ): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) void worker.terminate();
      settle();
    };
    const abort = (): void => {
      finish(() => reject(new PipelineAbortError()), true);
    };

    signal?.addEventListener("abort", abort, { once: true });
    // Cover the narrow race where the signal aborts after the first check but
    // before the listener is attached.
    if (signal?.aborted) {
      abort();
      return;
    }
    worker.once("message", (message: unknown) => {
      const payload = message as {
        type?: string;
        result?: Parameters<typeof resolve>[0];
        error?: SerializedWorkerError;
      };
      if (payload.type === "result") {
        finish(() => resolve(payload.result!));
        return;
      }
      finish(() => reject(reviveWorkerError(payload.error ?? {})), true);
    });
    worker.once("error", (error) => {
      finish(() => reject(error), true);
    });
    worker.once("exit", (code) => {
      if (settled) return;
      finish(
        () => reject(new Error(
          `Optimizer worker exited before returning a result (exit code ${code}).`,
        )),
      );
    });
  });
}
