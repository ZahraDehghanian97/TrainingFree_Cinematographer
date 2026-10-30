import * as fs from "node:fs";
import * as path from "node:path";

const projectRoot = path.resolve(__dirname, "..");
const nodeBuildDirectory = path.join(projectRoot, "dist");

if (
  path.dirname(nodeBuildDirectory) !== projectRoot
  || path.basename(nodeBuildDirectory) !== "dist"
) {
  throw new Error(`Refusing to clean unexpected build directory: ${nodeBuildDirectory}`);
}

fs.rmSync(nodeBuildDirectory, { recursive: true, force: true });
