import { createRequire } from "node:module";
import * as path from "node:path";
import type { Plugin } from "vite";
import { createPipelineApiMiddleware } from "../src/pipeline/api-middleware";
import { EnvironmentRepository } from "../src/pipeline/environment-repository";
import { createNodeWorkerTrajectoryOptimizer } from "../src/pipeline/node-worker-optimizer";
import { PipelineRunManager } from "../src/pipeline/run-manager";

export interface CameraPipelineApiPluginOptions {
  environmentsDirectory: string;
  optimizerIterations?: number;
}

/** Same-origin local API for Camera Lab development and preview demos. */
export function cameraPipelineApiPlugin(
  options: CameraPipelineApiPluginOptions,
): Plugin {
  const moduleRequire = createRequire(import.meta.url);
  const trajectoryOptimizer = createNodeWorkerTrajectoryOptimizer({
    optimizerModulePath: path.resolve(import.meta.dirname, "../src/optimizer/index.ts"),
    registerModulePath: moduleRequire.resolve("ts-node/register/transpile-only"),
  });
  const manager = new PipelineRunManager({
    repository: new EnvironmentRepository(options.environmentsDirectory),
    pipelineOptions: { trajectoryOptimizer },
    ...(options.optimizerIterations === undefined
      ? {}
      : { optimizerIterations: options.optimizerIterations }),
  });
  const middleware = createPipelineApiMiddleware(manager);

  return {
    name: "camera-pipeline-api",
    configureServer(server) {
      server.middlewares.use(middleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware);
    },
  };
}
