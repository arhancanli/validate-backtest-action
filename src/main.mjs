// action/src/main.mjs
//
// Orchestration for the "Validate backtest with Canli receipts" action. Everything decidable
// without touching the filesystem, the network or the Actions toolkit lives in ./lib.mjs and is
// unit tested there directly; this file only reads inputs, makes the two HTTP calls, and writes
// the job summary and outputs.
//
// Never issues an API key by default: the API allows only 5 keys per client per UTC day
// (api/_lib/limits.js keys_per_client_per_day), so a key issued on every CI run would exhaust a
// repository's daily quota within a handful of pushes. `issue-key: true` opts in explicitly.
import { readFile } from "node:fs/promises";
import path from "node:path";
import * as core from "@actions/core";
import * as github from "@actions/github";
import {
  DEFAULT_CROSS_TRIAL_SHARPE_SD_ANNUALIZED,
  MISSING_KEY_MESSAGE,
  buildFallbackBadge,
  buildValidateRequestBody,
  describeApiError,
  detectFormat,
  evaluateFailOn,
  formatErrorSummary,
  formatSuccessSummary,
  parseReturns,
} from "./lib.mjs";

const DEFAULT_API_BASE = "https://canlicapital.com";
const DEFAULT_LABEL = "github-action";

// The only place this file talks to the network. Returns { status, json, text } always; a
// non-JSON body still resolves (json: null) so a caller can report the raw text instead of
// throwing on an unexpected response shape (a proxy error page, for instance).
async function apiRequest(fetchImpl, url, { method = "GET", body, headers = {} } = {}) {
  const res = await fetchImpl(url, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json", ...headers } : headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

function readInputs(coreLib) {
  return {
    apiBase: (coreLib.getInput("api-base") || DEFAULT_API_BASE).replace(/\/+$/, ""),
    label: coreLib.getInput("label") || DEFAULT_LABEL,
    returnsFile: coreLib.getInput("returns-file", { required: true }),
    periodsPerYear: coreLib.getInput("periods-per-year", { required: true }),
    effectiveIndependentTrials: coreLib.getInput("effective-independent-trials", { required: true }),
    crossTrialSharpeSdAnnualizedRaw: coreLib.getInput("cross-trial-sharpe-sd-annualized"),
    apiKey: coreLib.getInput("api-key"),
    issueKey: coreLib.getBooleanInput("issue-key"),
    failOn: coreLib.getInput("fail-on"),
    failOnThresholdRaw: coreLib.getInput("fail-on-threshold"),
  };
}

function safeRepoContext(githubLib) {
  try {
    const { context } = githubLib;
    return {
      repo: `${context.repo.owner}/${context.repo.repo}`,
      sha: context.sha,
      runId: context.runId,
    };
  } catch {
    return null;
  }
}

async function resolveApiKey({ inputs, fetchImpl, coreLib }) {
  if (inputs.apiKey) return inputs.apiKey;
  if (!inputs.issueKey) {
    coreLib.setFailed(MISSING_KEY_MESSAGE);
    return null;
  }
  const res = await apiRequest(fetchImpl, `${inputs.apiBase}/api/v1/keys`, { method: "POST", body: { label: inputs.label } });
  if (res.status !== 201) {
    const action = "issuing a Canli Capital API key";
    await writeSummary(coreLib, formatErrorSummary({ action, status: res.status, envelope: res.json }));
    coreLib.setFailed(describeApiError({ action, status: res.status, envelope: res.json }));
    return null;
  }
  const key = res.json?.data?.key;
  if (!key) {
    coreLib.setFailed("The key-issuance response did not include a key.");
    return null;
  }
  coreLib.info(`Issued a temporary Canli Capital API key for label "${inputs.label}". A stored CANLI_KEY secret is the supported path for repeated runs.`);
  return key;
}

async function loadReturns(returnsFileInput) {
  const resolvedPath = path.resolve(returnsFileInput);
  const raw = await readFile(resolvedPath, "utf8");
  return parseReturns(raw, detectFormat(resolvedPath));
}

async function fetchBadge({ fetchImpl, coreLib, apiBase, receiptId }) {
  // Always hit api-base for this call, never the envelope's own receipt.url: the API's envelope
  // builder hardcodes the production origin into every receipt.url it emits (api/_lib/handler.js),
  // regardless of which host actually answered the request, so a preview deployment's own receipt
  // is only reachable at api-base, not at the URL the envelope names for it. The same reasoning is
  // why scripts/smoke-validation-api.mjs rewrites receipt.url before fetching it.
  const url = `${apiBase}/api/v1/receipts/${receiptId}`;
  try {
    const res = await apiRequest(fetchImpl, url, { method: "GET" });
    if (res.status === 200 && res.json?.data?.badge_url && res.json?.data?.embed_markdown) {
      return { badge_url: res.json.data.badge_url, embed_markdown: res.json.data.embed_markdown, source: "receipt" };
    }
    coreLib.warning(`GET ${url} did not return a badge; reconstructing the badge locally from the receipt id.`);
  } catch (err) {
    coreLib.warning(`Could not reach ${url} (${err.message}); reconstructing the badge locally from the receipt id.`);
  }
  return { ...buildFallbackBadge({ apiBase, id: receiptId }), source: "fallback" };
}

async function writeSummary(coreLib, markdown) {
  await coreLib.summary.addRaw(markdown, true).write();
}

export async function run({ fetchImpl = fetch, coreLib = core, githubLib = github } = {}) {
  let inputs;
  try {
    inputs = readInputs(coreLib);
  } catch (err) {
    coreLib.setFailed(err.message);
    return;
  }

  const apiKey = await resolveApiKey({ inputs, fetchImpl, coreLib });
  if (!apiKey) return;

  let returns;
  try {
    returns = await loadReturns(inputs.returnsFile);
  } catch (err) {
    coreLib.setFailed(`Could not read returns-file "${inputs.returnsFile}": ${err.message}`);
    return;
  }

  const crossTrialSharpeSdAnnualized =
    inputs.crossTrialSharpeSdAnnualizedRaw === "" ? DEFAULT_CROSS_TRIAL_SHARPE_SD_ANNUALIZED : Number(inputs.crossTrialSharpeSdAnnualizedRaw);

  let requestBody;
  try {
    requestBody = buildValidateRequestBody({
      returns,
      periodsPerYear: Number(inputs.periodsPerYear),
      effectiveIndependentTrials: Number(inputs.effectiveIndependentTrials),
      crossTrialSharpeSdAnnualized,
      label: inputs.label,
    });
  } catch (err) {
    coreLib.setFailed(err.message);
    return;
  }

  const validateRes = await apiRequest(fetchImpl, `${inputs.apiBase}/api/v1/validate/deflated-sharpe`, {
    method: "POST",
    body: requestBody,
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (validateRes.status !== 200) {
    const action = "validating the backtest";
    await writeSummary(coreLib, formatErrorSummary({ action, status: validateRes.status, envelope: validateRes.json }));
    coreLib.setFailed(describeApiError({ action, status: validateRes.status, envelope: validateRes.json }));
    return;
  }

  const envelope = validateRes.json;
  const receiptId = envelope?.receipt?.id;
  const receiptUrl = envelope?.receipt?.url;

  const badgeInfo = receiptId
    ? await fetchBadge({ fetchImpl, coreLib, apiBase: inputs.apiBase, receiptId })
    : undefined;

  const result = envelope?.data?.result ?? {};
  const dsr = result.deflated_sharpe_ratio;
  const psr = result.psr_against_zero;

  let failOnResult;
  try {
    failOnResult = evaluateFailOn({
      failOn: inputs.failOn,
      failOnThreshold: inputs.failOnThresholdRaw === "" ? undefined : Number(inputs.failOnThresholdRaw),
      dsr,
    });
  } catch (err) {
    coreLib.setFailed(err.message);
    return;
  }

  const summary = formatSuccessSummary({
    envelope,
    badgeInfo,
    failOn: inputs.failOn,
    failOnThreshold: inputs.failOnThresholdRaw === "" ? undefined : Number(inputs.failOnThresholdRaw),
    failOnFired: failOnResult?.fired,
    repoContext: safeRepoContext(githubLib),
  });
  await writeSummary(coreLib, summary);

  coreLib.setOutput("dsr", dsr ?? "");
  coreLib.setOutput("psr", psr ?? "");
  coreLib.setOutput("receipt-id", receiptId ?? "");
  coreLib.setOutput("receipt-url", receiptUrl ?? "");
  coreLib.setOutput("badge-markdown", badgeInfo?.embed_markdown ?? "");

  if (failOnResult?.fired) {
    coreLib.setFailed(failOnResult.note);
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  run().catch((err) => {
    core.setFailed(`Unhandled error: ${err.stack || err.message || err}`);
  });
}
