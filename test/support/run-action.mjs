// action/test/support/run-action.mjs
//
// Spawns src/main.mjs as a real child process with INPUT_* / GITHUB_* environment variables, the
// same way the Actions runner invokes a node20 action. A subprocess per run means each test gets
// a fresh @actions/core module (its job-summary file path and process.exitCode are cached at
// module scope, so sharing a process across scenarios with different GITHUB_STEP_SUMMARY paths or
// expected failures would corrupt one test with another's state).
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const actionRoot = path.resolve(fileURLToPath(import.meta.url), "../../..");
const MAIN_PATH = path.join(actionRoot, "src", "main.mjs");

// Parses the `key<<delimiter\nvalue\ndelimiter\n` blocks @actions/core's file-command writer
// produces for GITHUB_OUTPUT, in the order they were written.
export function parseGithubOutputFile(text) {
  const out = {};
  const re = /^([^\n<]+)<<(ghadelimiter_[0-9a-f-]+)\r?\n([\s\S]*?)\r?\n\2\r?\n?/gm;
  let match;
  while ((match = re.exec(text))) {
    out[match[1]] = match[3];
  }
  return out;
}

export async function runAction({ env = {}, cwd } = {}) {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), "canli-action-"));
  const summaryPath = path.join(tmpDir, "summary.md");
  const outputPath = path.join(tmpDir, "output.txt");
  await writeFile(summaryPath, "");
  await writeFile(outputPath, "");

  const child = spawn(process.execPath, [MAIN_PATH], {
    cwd: cwd ?? tmpDir,
    env: {
      PATH: process.env.PATH,
      ...env,
      GITHUB_STEP_SUMMARY: summaryPath,
      GITHUB_OUTPUT: outputPath,
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString()));
  child.stderr.on("data", (d) => (stderr += d.toString()));

  const code = await new Promise((resolve) => child.on("close", resolve));
  const summary = await readFile(summaryPath, "utf8");
  const outputs = parseGithubOutputFile(await readFile(outputPath, "utf8"));

  await rm(tmpDir, { recursive: true, force: true });
  return { code, stdout, stderr, summary, outputs };
}
