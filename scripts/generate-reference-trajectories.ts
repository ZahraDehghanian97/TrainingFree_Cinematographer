import { execFileSync } from "node:child_process";
import * as path from "node:path";
// Rebuilds the two shared scenes and their authored, non-optimized camera references.
execFileSync(process.env.PYTHON ?? "python3", [path.resolve(__dirname, "generate-two-environments.py")], { stdio: "inherit" });
