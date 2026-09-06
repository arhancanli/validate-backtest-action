// action/test/lib.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CROSS_TRIAL_SHARPE_SD_ANNUALIZED,
  OPENAPI_RETURN_SERIES_EXAMPLE,
  buildFallbackBadge,
  buildValidateRequestBody,
  describeApiError,
  detectFormat,
  evaluateFailOn,
  formatErrorSummary,
  formatSuccessSummary,
  parseReturns,
} from "../src/lib.mjs";
import { LIMITS_TEXT, RECEIPT_ID, receiptEnvelope, validateSuccessEnvelope } from "./support/fixtures.mjs";

test("detectFormat: .json is json, everything else is csv", () => {
  assert.equal(detectFormat("returns.json"), "json");
  assert.equal(detectFormat("RETURNS.JSON"), "json");
  assert.equal(detectFormat("returns.csv"), "csv");
  assert.equal(detectFormat("returns.txt"), "csv");
  assert.equal(detectFormat("returns"), "csv");
});

test("parseReturns: JSON array of numbers", () => {
  const values = parseReturns("[0.01, -0.02, 0.03]", "json");
  assert.deepEqual(values, [0.01, -0.02, 0.03]);
});

test("parseReturns: JSON that is not an array throws", () => {
  assert.throws(() => parseReturns('{"a": 1}', "json"), /array of numbers/);
});

test("parseReturns: invalid JSON throws with a readable message", () => {
  assert.throws(() => parseReturns("not json", "json"), /not valid JSON/);
});

test("parseReturns: CSV, one number per line", () => {
  const values = parseReturns("0.01\n-0.02\n0.03\n", "csv");
  assert.deepEqual(values, [0.01, -0.02, 0.03]);
});

test("parseReturns: CSV single column with blank lines ignored", () => {
  const values = parseReturns("0.01\n\n-0.02\n\n0.03", "csv");
  assert.deepEqual(values, [0.01, -0.02, 0.03]);
});

test("parseReturns: CSV takes the first field of a multi-column row", () => {
  const values = parseReturns("0.01,note-a\n-0.02,note-b\n", "csv");
  assert.deepEqual(values, [0.01, -0.02]);
});

test("parseReturns: CSV row that is not a number throws, naming the row", () => {
  assert.throws(() => parseReturns("0.01\nnot-a-number\n0.03", "csv"), /row 2/);
});

test("parseReturns: fewer than 2 observations throws", () => {
  assert.throws(() => parseReturns("[0.01]", "json"), /at least 2 observations/);
  assert.throws(() => parseReturns("", "csv"), /at least 2 observations|no rows found/);
});

test("buildValidateRequestBody: round-trips the OpenAPI return-series example", () => {
  const body = buildValidateRequestBody({
    returns: OPENAPI_RETURN_SERIES_EXAMPLE.returns,
    periodsPerYear: OPENAPI_RETURN_SERIES_EXAMPLE.periods_per_year,
    effectiveIndependentTrials: OPENAPI_RETURN_SERIES_EXAMPLE.effective_independent_trials,
    crossTrialSharpeSdAnnualized: OPENAPI_RETURN_SERIES_EXAMPLE.cross_trial_sharpe_sd_annualized,
  });
  assert.deepEqual(body.returns, OPENAPI_RETURN_SERIES_EXAMPLE.returns);
  assert.equal(body.periods_per_year, OPENAPI_RETURN_SERIES_EXAMPLE.periods_per_year);
  assert.equal(body.effective_independent_trials, OPENAPI_RETURN_SERIES_EXAMPLE.effective_independent_trials);
  assert.equal(body.cross_trial_sharpe_sd_annualized, OPENAPI_RETURN_SERIES_EXAMPLE.cross_trial_sharpe_sd_annualized);
  assert.equal(DEFAULT_CROSS_TRIAL_SHARPE_SD_ANNUALIZED, OPENAPI_RETURN_SERIES_EXAMPLE.cross_trial_sharpe_sd_annualized);
});

test("buildValidateRequestBody: adds label only when given", () => {
  const withLabel = buildValidateRequestBody({ returns: [0.01, 0.02], periodsPerYear: 252, effectiveIndependentTrials: 5, crossTrialSharpeSdAnnualized: 0.5, label: "github-action" });
  assert.equal(withLabel.label, "github-action");
  const withoutLabel = buildValidateRequestBody({ returns: [0.01, 0.02], periodsPerYear: 252, effectiveIndependentTrials: 5, crossTrialSharpeSdAnnualized: 0.5 });
  assert.equal("label" in withoutLabel, false);
});

test("buildValidateRequestBody: rejects bad inputs the same way the server would", () => {
  const base = { returns: [0.01, 0.02], periodsPerYear: 252, effectiveIndependentTrials: 5, crossTrialSharpeSdAnnualized: 0.5 };
  assert.throws(() => buildValidateRequestBody({ ...base, returns: [0.01] }), /at least 2 observations/);
  assert.throws(() => buildValidateRequestBody({ ...base, periodsPerYear: 0 }), /periods-per-year/);
  assert.throws(() => buildValidateRequestBody({ ...base, effectiveIndependentTrials: 1 }), /effective-independent-trials/);
  assert.throws(() => buildValidateRequestBody({ ...base, effectiveIndependentTrials: 1.5 }), /effective-independent-trials/);
  assert.throws(() => buildValidateRequestBody({ ...base, crossTrialSharpeSdAnnualized: -0.1 }), /cross-trial-sharpe-sd-annualized/);
});

test("buildFallbackBadge: matches api/v1/receipts/[id].js's own formula", () => {
  const { badge_url, embed_markdown } = buildFallbackBadge({ apiBase: "https://canlicapital.com", id: RECEIPT_ID });
  assert.equal(badge_url, `https://canlicapital.com/api/v1/receipts/${RECEIPT_ID}/badge.svg`);
  assert.equal(embed_markdown, `[![Canli receipt](${badge_url})](https://canlicapital.com/api/v1/receipts/${RECEIPT_ID})`);
});

test("buildFallbackBadge: strips a trailing slash from apiBase", () => {
  const { badge_url } = buildFallbackBadge({ apiBase: "https://canlicapital.com/", id: RECEIPT_ID });
  assert.equal(badge_url, `https://canlicapital.com/api/v1/receipts/${RECEIPT_ID}/badge.svg`);
});

test("evaluateFailOn: unset means never fires, and returns null (no policy in force)", () => {
  assert.equal(evaluateFailOn({ failOn: "", failOnThreshold: undefined, dsr: 0.01 }), null);
  assert.equal(evaluateFailOn({ failOn: undefined, failOnThreshold: undefined, dsr: 0.01 }), null);
});

test("evaluateFailOn: dsr-below fires only under the threshold, and says it is a workflow policy", () => {
  const below = evaluateFailOn({ failOn: "dsr-below", failOnThreshold: 0.5, dsr: 0.2 });
  assert.equal(below.fired, true);
  assert.match(below.note, /workflow's own policy/);
  assert.match(below.note, /not a verdict/);

  const atOrAbove = evaluateFailOn({ failOn: "dsr-below", failOnThreshold: 0.5, dsr: 0.5 });
  assert.equal(atOrAbove.fired, false);
});

test("evaluateFailOn: rejects an unsupported fail-on value", () => {
  assert.throws(() => evaluateFailOn({ failOn: "psr-below", failOnThreshold: 0.5, dsr: 0.2 }), /Unsupported fail-on/);
});

test("evaluateFailOn: dsr-below without a numeric threshold throws", () => {
  assert.throws(() => evaluateFailOn({ failOn: "dsr-below", failOnThreshold: undefined, dsr: 0.2 }), /finite number/);
  assert.throws(() => evaluateFailOn({ failOn: "dsr-below", failOnThreshold: NaN, dsr: 0.2 }), /finite number/);
});

test("formatSuccessSummary: contains the verdict numbers, plain_reading, every limits sentence, receipt url and badge markdown", () => {
  const envelope = validateSuccessEnvelope();
  const badgeInfo = { badge_url: "https://canlicapital.com/api/v1/receipts/x/badge.svg", embed_markdown: "[![Canli receipt](url)](url)", source: "receipt" };
  const summary = formatSuccessSummary({ envelope, badgeInfo });

  assert.match(summary, /73\.4%/); // deflated sharpe
  assert.match(summary, /81\.2%/); // psr against zero
  assert.match(summary, new RegExp(envelope.data.plain_reading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  for (const sentence of LIMITS_TEXT) {
    assert.ok(summary.includes(sentence), `summary is missing limits sentence: ${sentence}`);
  }
  assert.match(summary, /https:\/\/canlicapital\.com\/api\/v1\/receipts\//);
  assert.match(summary, /\[!\[Canli receipt\]/);
  assert.ok(!summary.includes(String(envelope.data.result.deflated_sharpe_ratio)) || summary.length > 40, "summary must never be only a bare number");
});

test("formatSuccessSummary: never says verified, approved, passed or profitable", () => {
  const envelope = validateSuccessEnvelope();
  const summary = formatSuccessSummary({ envelope, badgeInfo: undefined });
  for (const word of ["verified", "approved", "passed", "profitable"]) {
    assert.ok(!summary.toLowerCase().includes(word), `summary must never say "${word}"`);
  }
});

test("formatSuccessSummary: badge source fallback is disclosed", () => {
  const envelope = validateSuccessEnvelope();
  const summary = formatSuccessSummary({ envelope, badgeInfo: { badge_url: "u", embed_markdown: "m", source: "fallback" } });
  assert.match(summary, /reconstructed locally/);
});

test("formatSuccessSummary: states the fail-on threshold is a workflow policy, not the API's verdict", () => {
  const envelope = validateSuccessEnvelope();
  const summary = formatSuccessSummary({ envelope, badgeInfo: undefined, failOn: "dsr-below", failOnThreshold: 0.9, failOnFired: true });
  assert.match(summary, /workflow's own policy/);
  assert.match(summary, /not a verdict/);
});

test("formatSuccessSummary: never emitted when there is only a receipt fixture, still carries the receipt route's own fields", () => {
  const receipt = receiptEnvelope();
  assert.ok(receipt.data.badge_url);
  assert.ok(receipt.data.embed_markdown);
});

test("formatErrorSummary: carries the HTTP status, the error, and every limits sentence when present", () => {
  const summary = formatErrorSummary({ action: "validating the backtest", status: 401, envelope: { error: { code: "unauthorized", message: "Unknown or revoked key" }, limits: LIMITS_TEXT } });
  assert.match(summary, /HTTP 401/);
  assert.match(summary, /unauthorized/);
  assert.match(summary, /Unknown or revoked key/);
  for (const sentence of LIMITS_TEXT) assert.ok(summary.includes(sentence));
});

test("describeApiError: surfaces the API's own message and code", () => {
  const message = describeApiError({ action: "validating the backtest", status: 429, envelope: { error: { code: "quota_exhausted", message: "Daily quota of 1000 validations reached" } } });
  assert.match(message, /quota_exhausted/);
  assert.match(message, /Daily quota of 1000 validations reached/);
});

test("describeApiError: falls back to the bare status when there is no error envelope", () => {
  const message = describeApiError({ action: "validating the backtest", status: 503, envelope: null });
  assert.match(message, /HTTP 503/);
});
