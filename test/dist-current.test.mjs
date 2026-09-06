// action/test/dist-current.test.mjs
//
// The Marketplace requires dist/ to be a committed, install-free build of src/. Rather than
// trust that whoever last ran `npm run build` remembered to commit the result, rebuild it here
// with the same pinned @vercel/ncc and diff byte-for-byte against what is committed. A stale
// dist/ fails this test, not silently ships an old action.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import ncc from "@vercel/ncc";

const actionRoot = path.resolve(fileURLToPath(import.meta.url), "../..");

test("dist/index.mjs is exactly what `npm run build` produces from src/main.mjs", async () => {
  const { code, assets } = await ncc(path.join(actionRoot, "src", "main.mjs"), {
    minify: false,
    sourceMap: false,
    cache: false,
  });
  const committed = await readFile(path.join(actionRoot, "dist", "index.mjs"), "utf8");
  assert.equal(code, committed, "dist/index.mjs is stale; run `npm run build` in action/ and commit the result");
  assert.deepEqual(Object.keys(assets), [], "the build should not emit extra assets alongside dist/index.mjs");
});
