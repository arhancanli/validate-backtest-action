// action/test/main.test.mjs
//
// Integration tests: a real local HTTP stub of the API, and src/main.mjs run as a real child
// process with INPUT_*/GITHUB_* environment variables, exactly as the Actions runner invokes a
// node20 action. Covers: parsing, the missing-key actionable error, a 401 and a 429 from the API,
// fail-on's default of never firing, and fail-on actually firing when opted into.
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  QUOTA_EXHAUSTED_ENVELOPE,
  RECEIPT_ID,
  UNAUTHORIZED_ENVELOPE,
  receiptEnvelope,
  validateSuccessEnvelope,
} from "./support/fixtures.mjs";
import { runAction } from "./support/run-action.mjs";
import { createStubServer } from "./support/stub-server.mjs";

async function writeReturnsFile(content, ext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "canli-returns-"));
  const file = path.join(dir, `returns.${ext}`);
  await writeFile(file, content);
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

const baseEnv = (returnsFile, apiBase, extra = {}) => ({
  "INPUT_RETURNS-FILE": returnsFile,
  "INPUT_PERIODS-PER-YEAR": "252",
  "INPUT_EFFECTIVE-INDEPENDENT-TRIALS": "30",
  "INPUT_CROSS-TRIAL-SHARPE-SD-ANNUALIZED": "",
  "INPUT_API-KEY": "ck_live_testkey00000000000000000000",
  "INPUT_ISSUE-KEY": "false",
  "INPUT_LABEL": "github-action",
  "INPUT_API-BASE": apiBase,
  "INPUT_FAIL-ON": "",
  "INPUT_FAIL-ON-THRESHOLD": "",
  GITHUB_REPOSITORY: "arhancanli/canlicapital",
  GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
  GITHUB_RUN_ID: "999",
  ...extra,
});

test("main: a full success run writes the verdict, every limits sentence, the receipt url and the badge markdown to the job summary", async () => {
  const server = await createStubServer({
    validate: () => ({ status: 200, json: validateSuccessEnvelope() }),
    receipt: () => ({ status: 200, json: receiptEnvelope() }),
  });
  const { file, cleanup } = await writeReturnsFile("[0.004, -0.002, 0.007, 0.001, -0.003, 0.005, 0.002, -0.001]", "json");
  try {
    const result = await runAction({ env: baseEnv(file, server.url) });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.summary, /73\.4%/);
    assert.match(result.summary, /Receipt:/);
    assert.match(result.summary, new RegExp(RECEIPT_ID));
    assert.match(result.summary, /\[!\[Canli receipt\]/);
    assert.equal(result.outputs["receipt-id"], RECEIPT_ID);
    assert.ok(result.outputs["badge-markdown"].includes("Canli receipt"));
    assert.equal(result.outputs.dsr, "0.734");
    assert.equal(result.outputs.psr, "0.812");

    const validateReq = server.requests.find((r) => r.pathname === "/api/v1/validate/deflated-sharpe");
    assert.equal(validateReq.headers.authorization, "Bearer ck_live_testkey00000000000000000000");
    assert.equal(validateReq.body.periods_per_year, 252);
    assert.equal(validateReq.body.effective_independent_trials, 30);
    assert.equal(validateReq.body.cross_trial_sharpe_sd_annualized, 0.5);
    assert.deepEqual(validateReq.body.returns, [0.004, -0.002, 0.007, 0.001, -0.003, 0.005, 0.002, -0.001]);
    assert.equal(validateReq.body.label, "github-action");

    // Proves the badge came from the stub's GET /api/v1/receipts/:id, not the local fallback
    // formula: the fixture's receipt.url points at production (https://canlicapital.com, exactly
    // like the real API always does, regardless of which host answered), so this would pass for
    // the wrong reason if the action fetched receipt.url instead of api-base.
    const receiptReq = server.requests.find((r) => r.pathname === `/api/v1/receipts/${RECEIPT_ID}`);
    assert.ok(receiptReq, "expected a GET to the stub's own /api/v1/receipts/:id, not to receipt.url");
    assert.equal(receiptReq.method, "GET");
    assert.ok(!result.summary.includes("reconstructed locally"), "the badge should come from the stub's receipt route, not the local fallback");
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: parses a CSV returns-file the same way as JSON", async () => {
  const server = await createStubServer({
    validate: () => ({ status: 200, json: validateSuccessEnvelope() }),
    receipt: () => ({ status: 200, json: receiptEnvelope() }),
  });
  const { file, cleanup } = await writeReturnsFile("0.004\n-0.002\n0.007\n0.001\n-0.003\n0.005\n0.002\n-0.001\n", "csv");
  try {
    const result = await runAction({ env: baseEnv(file, server.url) });
    assert.equal(result.code, 0, result.stderr);
    const validateReq = server.requests.find((r) => r.pathname === "/api/v1/validate/deflated-sharpe");
    assert.deepEqual(validateReq.body.returns, [0.004, -0.002, 0.007, 0.001, -0.003, 0.005, 0.002, -0.001]);
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: no api-key and issue-key false gives the actionable error, and never calls the API", async () => {
  const server = await createStubServer({
    validate: () => ({ status: 200, json: validateSuccessEnvelope() }),
  });
  const { file, cleanup } = await writeReturnsFile("[0.01, 0.02, 0.03]", "json");
  try {
    const result = await runAction({ env: baseEnv(file, server.url, { "INPUT_API-KEY": "" }) });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /CANLI_KEY/);
    assert.match(result.stdout, /issue-key/);
    assert.equal(server.requests.length, 0);
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: issue-key true issues a key via POST /api/v1/keys when api-key is unset", async () => {
  const server = await createStubServer({
    keys: () => ({ status: 201, json: { schema: "canli.api.v1", endpoint: "/api/v1/keys", generated_at: "2026-09-06T00:00:00Z", claim_class: "OBSERVED", capital_kind: "NOT_APPLICABLE_SERVICE_STATUS", canonical_human_page: "https://canlicapital.com/developers", limits: ["stub"], sources: [], data: { key: "ck_live_issued00000000000000000000", label: "github-action", keys_remaining_today: 4 } } }),
    validate: () => ({ status: 200, json: validateSuccessEnvelope() }),
    receipt: () => ({ status: 200, json: receiptEnvelope() }),
  });
  const { file, cleanup } = await writeReturnsFile("[0.01, 0.02, 0.03]", "json");
  try {
    const result = await runAction({ env: baseEnv(file, server.url, { "INPUT_API-KEY": "", "INPUT_ISSUE-KEY": "true" }) });
    assert.equal(result.code, 0, result.stderr);
    const keysReq = server.requests.find((r) => r.pathname === "/api/v1/keys");
    assert.ok(keysReq, "expected a POST to /api/v1/keys");
    assert.equal(keysReq.body.label, "github-action");
    const validateReq = server.requests.find((r) => r.pathname === "/api/v1/validate/deflated-sharpe");
    assert.equal(validateReq.headers.authorization, "Bearer ck_live_issued00000000000000000000");
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: a 401 from validate surfaces the API's message, writes it to the summary, and fails the job", async () => {
  const server = await createStubServer({
    validate: () => ({ status: 401, json: UNAUTHORIZED_ENVELOPE }),
  });
  const { file, cleanup } = await writeReturnsFile("[0.01, 0.02, 0.03]", "json");
  try {
    const result = await runAction({ env: baseEnv(file, server.url) });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /Unknown or revoked key/);
    assert.match(result.summary, /HTTP 401/);
    assert.match(result.summary, /Unknown or revoked key/);
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: a 429 from validate surfaces the API's quota message", async () => {
  const server = await createStubServer({
    validate: () => ({ status: 429, json: QUOTA_EXHAUSTED_ENVELOPE }),
  });
  const { file, cleanup } = await writeReturnsFile("[0.01, 0.02, 0.03]", "json");
  try {
    const result = await runAction({ env: baseEnv(file, server.url) });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /Daily quota of 1000 validations reached/);
    assert.match(result.summary, /Daily quota of 1000 validations reached/);
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: fail-on is never set by default, so a run succeeds regardless of the verdict", async () => {
  const server = await createStubServer({
    validate: () => ({ status: 200, json: validateSuccessEnvelope() }),
    receipt: () => ({ status: 200, json: receiptEnvelope() }),
  });
  const { file, cleanup } = await writeReturnsFile("[0.01, 0.02, 0.03]", "json");
  try {
    // deflated_sharpe_ratio in the fixture is 0.734; an extremely high implied threshold would
    // fail the run if fail-on were on by default. It is not set at all here.
    const result = await runAction({ env: baseEnv(file, server.url) });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: fail-on dsr-below fails the job when the threshold is not met, and says so is this workflow's policy", async () => {
  const server = await createStubServer({
    validate: () => ({ status: 200, json: validateSuccessEnvelope() }),
    receipt: () => ({ status: 200, json: receiptEnvelope() }),
  });
  const { file, cleanup } = await writeReturnsFile("[0.01, 0.02, 0.03]", "json");
  try {
    const result = await runAction({ env: baseEnv(file, server.url, { "INPUT_FAIL-ON": "dsr-below", "INPUT_FAIL-ON-THRESHOLD": "0.99" }) });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /workflow's own policy/);
    assert.match(result.summary, /workflow's own policy/);
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: fail-on dsr-below succeeds when the threshold is met", async () => {
  const server = await createStubServer({
    validate: () => ({ status: 200, json: validateSuccessEnvelope() }),
    receipt: () => ({ status: 200, json: receiptEnvelope() }),
  });
  const { file, cleanup } = await writeReturnsFile("[0.01, 0.02, 0.03]", "json");
  try {
    const result = await runAction({ env: baseEnv(file, server.url, { "INPUT_FAIL-ON": "dsr-below", "INPUT_FAIL-ON-THRESHOLD": "0.1" }) });
    assert.equal(result.code, 0, result.stderr);
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: falls back to a locally reconstructed badge when the receipt route does not answer", async () => {
  const server = await createStubServer({
    validate: () => ({ status: 200, json: validateSuccessEnvelope() }),
    receipt: () => ({ status: 503, json: { schema: "canli.api.v1", error: { code: "store_unavailable", message: "down" }, limits: ["stub"] } }),
  });
  const { file, cleanup } = await writeReturnsFile("[0.01, 0.02, 0.03]", "json");
  try {
    const result = await runAction({ env: baseEnv(file, server.url) });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.summary, /reconstructed locally/);
    assert.ok(result.outputs["badge-markdown"].includes(`${RECEIPT_ID}/badge.svg`));
  } finally {
    await server.close();
    await cleanup();
  }
});

test("main: a missing returns-file gives a clear, actionable error", async () => {
  const server = await createStubServer({ validate: () => ({ status: 200, json: validateSuccessEnvelope() }) });
  try {
    const result = await runAction({ env: baseEnv("/no/such/file.json", server.url) });
    assert.notEqual(result.code, 0);
    assert.match(result.stdout, /Could not read returns-file/);
  } finally {
    await server.close();
  }
});
