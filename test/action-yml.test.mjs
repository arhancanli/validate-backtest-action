// action/test/action-yml.test.mjs
//
// Guards against action.yml drifting from the code: the default cross-trial-sharpe-sd-annualized
// must be the same number OPENAPI_RETURN_SERIES_EXAMPLE uses (never a second, hand-typed copy of
// that constant), and every input/output name main.mjs actually reads or sets must be declared.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { DEFAULT_CROSS_TRIAL_SHARPE_SD_ANNUALIZED } from "../src/lib.mjs";

const actionRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

// A tiny, purpose-built extractor for this one file's shape (two-space-indented `key:` blocks
// under `inputs:`/`outputs:`, each optionally followed by a `default: "..."` line), not a general
// YAML parser.
function extractInputDefault(yaml, inputName) {
  const inputBlock = new RegExp(`\\n  ${inputName}:\\n([\\s\\S]*?)(\\n  [a-zA-Z-]+:\\n|$)`);
  const match = yaml.match(inputBlock);
  if (!match) throw new Error(`input "${inputName}" not found in action.yml`);
  const defaultMatch = match[1].match(/default:\s*"([^"]*)"/);
  return defaultMatch ? defaultMatch[1] : undefined;
}

function extractNames(yaml, section) {
  const sectionBlock = new RegExp(`\\n${section}:\\n([\\s\\S]*?)(\\n(?:inputs|outputs|runs):\\n|$)`);
  const match = yaml.match(sectionBlock);
  if (!match) return [];
  // The capture starts right after "<section>:\n", so its very first line has no leading "\n" of
  // its own; prepend one so every entry, including the first, matches the same pattern.
  const content = `\n${match[1]}`;
  return [...content.matchAll(/\n  ([a-zA-Z0-9-]+):\n/g)].map((m) => m[1]);
}

let actionYaml;
test.before(async () => {
  actionYaml = await readFile(path.join(actionRoot, "action.yml"), "utf8");
});

test("action.yml's cross-trial-sharpe-sd-annualized default matches the OpenAPI example constant", () => {
  const declared = extractInputDefault(actionYaml, "cross-trial-sharpe-sd-annualized");
  assert.equal(Number(declared), DEFAULT_CROSS_TRIAL_SHARPE_SD_ANNUALIZED);
});

test("action.yml declares every input main.mjs reads", async () => {
  const mainSource = await readFile(path.join(actionRoot, "src", "main.mjs"), "utf8");
  const readNames = [...mainSource.matchAll(/coreLib\.(?:getInput|getBooleanInput)\("([a-z0-9-]+)"/g)].map((m) => m[1]);
  const declared = new Set(extractNames(actionYaml, "inputs"));
  for (const name of readNames) {
    assert.ok(declared.has(name), `action.yml is missing input "${name}" that main.mjs reads`);
  }
});

test("action.yml declares every output main.mjs sets", async () => {
  const mainSource = await readFile(path.join(actionRoot, "src", "main.mjs"), "utf8");
  const setNames = [...mainSource.matchAll(/coreLib\.setOutput\("([a-z0-9-]+)"/g)].map((m) => m[1]);
  const declared = new Set(extractNames(actionYaml, "outputs"));
  for (const name of setNames) {
    assert.ok(declared.has(name), `action.yml is missing output "${name}" that main.mjs sets`);
  }
});

test("runs.main points at the committed dist bundle", () => {
  assert.match(actionYaml, /main:\s*"dist\/index\.mjs"/);
});
