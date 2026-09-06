// action/test/no-em-dash.test.mjs
//
// No em dashes in anything this action authored: action.yml, README, source and tests. Scoped to
// authored files only, not dist/ (a bundle of third-party dependency source) or node_modules/.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const actionRoot = path.resolve(fileURLToPath(import.meta.url), "../..");
// Built from a code point, not a literal character, so this file does not trip its own check.
const EM_DASH = String.fromCharCode(0x2014);
const SCAN_DIRS = ["src", "test"];
const SCAN_FILES = ["action.yml", "README.md", "package.json"];
const SKIP_DIRS = new Set(["node_modules"]);

function listFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

test("no authored file under action/ contains an em dash", () => {
  const files = [
    ...SCAN_DIRS.flatMap((d) => listFiles(path.join(actionRoot, d))),
    ...SCAN_FILES.map((f) => path.join(actionRoot, f)),
  ];
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    if (text.includes(EM_DASH)) offenders.push(path.relative(actionRoot, file));
  }
  assert.deepEqual(offenders, []);
});
