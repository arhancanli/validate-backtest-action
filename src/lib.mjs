// action/src/lib.mjs
//
// Pure functions only: no fs, no network, no @actions/core. Parsing a returns file, building the
// request body, reading the verdict out of an envelope and formatting the job summary all live
// here so they can be tested directly, without a process to spawn or a server to stub. src/main.mjs
// is the only file that touches the filesystem, the network or the Actions toolkit.
//
// The two-mode shape (contract inputs vs. a return series) and every field name below come from
// public/api/v1/openapi.json's oneOf schema for POST /api/v1/validate/deflated-sharpe. This action
// always uses mode 2, "return_series": returns, periods_per_year, effective_independent_trials,
// cross_trial_sharpe_sd_annualized.

// The OpenAPI document's own example for mode 2. cross_trial_sharpe_sd_annualized has no
// per-strategy analogue when only a single equity curve is available, so this is also the
// action's default for that input: the same number the API's own documentation uses, never a
// number invented for this action.
export const OPENAPI_RETURN_SERIES_EXAMPLE = Object.freeze({
  returns: Object.freeze([0.004, -0.002, 0.007, 0.001, -0.003, 0.005, 0.002, -0.001]),
  periods_per_year: 252,
  effective_independent_trials: 30,
  cross_trial_sharpe_sd_annualized: 0.5,
});

export const DEFAULT_CROSS_TRIAL_SHARPE_SD_ANNUALIZED = OPENAPI_RETURN_SERIES_EXAMPLE.cross_trial_sharpe_sd_annualized;

// --- returns-file parsing ---------------------------------------------------------------------

// Extension decides the format; anything that is not .json is read as CSV. There is no sniffing
// of file content, so a mislabelled file fails loudly instead of being silently misread.
export function detectFormat(filePath) {
  return String(filePath).toLowerCase().endsWith(".json") ? "json" : "csv";
}

export function parseReturns(text, format) {
  const values = format === "json" ? parseJsonReturns(text) : parseCsvReturns(text);
  if (values.length < 2) {
    throw new RangeError("returns-file must contain at least 2 observations");
  }
  return values;
}

function parseJsonReturns(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new RangeError(`returns-file: not valid JSON (${err.message})`);
  }
  if (!Array.isArray(value)) {
    throw new RangeError("returns-file: JSON content must be an array of numbers");
  }
  return value.map((entry, index) => toFiniteNumber(entry, index));
}

function parseCsvReturns(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) {
    throw new RangeError("returns-file: no rows found");
  }
  return lines.map((line, index) => {
    const firstField = line.split(",")[0].trim().replace(/^"(.*)"$/, "$1");
    return toFiniteNumber(firstField, index);
  });
}

function toFiniteNumber(raw, index) {
  if (raw === "" || raw === null || raw === undefined) {
    throw new RangeError(`returns-file: row ${index + 1} is empty`);
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new RangeError(`returns-file: row ${index + 1} ("${raw}") is not a finite number`);
  }
  return n;
}

// --- request body ------------------------------------------------------------------------------

// Builds the return-series-mode request body for POST /api/v1/validate/deflated-sharpe. Mirrors
// the server's own guards (js/dsr-core.js calculateDsr, js/moments-core.js dsrFromReturns) so a
// bad input fails locally, in the action's own words, instead of round-tripping to the API for a
// 422. `label` is optional and, when present, is also the label the API's source breakdown by
// label groups this request under, the same convention integrations/canli_validate/__init__.py
// uses for its own requests.
export function buildValidateRequestBody({ returns, periodsPerYear, effectiveIndependentTrials, crossTrialSharpeSdAnnualized, label }) {
  if (!Array.isArray(returns) || returns.length < 2) {
    throw new RangeError("returns must be an array of at least 2 observations");
  }
  if (!(Number(periodsPerYear) > 0)) {
    throw new RangeError("periods-per-year must be a number greater than zero");
  }
  const trials = Number(effectiveIndependentTrials);
  if (!Number.isInteger(trials) || trials < 2) {
    throw new RangeError("effective-independent-trials must be an integer of at least 2");
  }
  const crossSd = Number(crossTrialSharpeSdAnnualized);
  if (!(crossSd >= 0)) {
    throw new RangeError("cross-trial-sharpe-sd-annualized must be zero or greater");
  }
  const body = {
    returns: returns.map(Number),
    periods_per_year: Number(periodsPerYear),
    effective_independent_trials: trials,
    cross_trial_sharpe_sd_annualized: crossSd,
  };
  if (label) body.label = String(label);
  return body;
}

// --- receipt badge -----------------------------------------------------------------------------

// The exact formula api/v1/receipts/[id].js uses to derive badge_url and embed_markdown from a
// receipt id, kept here as a fallback only: the action always tries GET /api/v1/receipts/{id}
// first and uses what it returns. This is what it reconstructs when that call fails, so a run
// still ends with a working (if unconfirmed) badge instead of none at all.
export function buildFallbackBadge({ apiBase, id }) {
  const base = String(apiBase).replace(/\/+$/, "");
  const badge_url = `${base}/api/v1/receipts/${id}/badge.svg`;
  const receipt_url = `${base}/api/v1/receipts/${id}`;
  const embed_markdown = `[![Canli receipt](${badge_url})](${receipt_url})`;
  return { badge_url, embed_markdown };
}

// --- fail-on: a workflow policy, never the API's verdict ----------------------------------------

const SUPPORTED_FAIL_ON = new Set(["", "dsr-below"]);

// Returns null when fail-on is unset (the default: this action never fails the job over the
// verdict). When fail-on is "dsr-below", returns { fired, note }; `note` always states plainly
// that the threshold is this workflow's own policy, not a verdict the API issued, per the
// instruction that a threshold must never be presented as if the API itself failed the backtest.
export function evaluateFailOn({ failOn, failOnThreshold, dsr }) {
  const value = failOn || "";
  if (!SUPPORTED_FAIL_ON.has(value)) {
    throw new RangeError(`Unsupported fail-on value "${failOn}". The only supported value is "dsr-below".`);
  }
  if (value === "") return null;
  const threshold = Number(failOnThreshold);
  if (!Number.isFinite(threshold)) {
    throw new RangeError('fail-on is "dsr-below" but fail-on-threshold was not a finite number');
  }
  const fired = typeof dsr === "number" && Number.isFinite(dsr) && dsr < threshold;
  const note =
    `fail-on: dsr-below with threshold ${threshold} is this workflow's own policy, not a verdict issued by the Canli Capital API. ` +
    `Deflated Sharpe ratio ${dsr} is ${fired ? "below" : "at or above"} that threshold.`;
  return { fired, note };
}

// --- formatting ---------------------------------------------------------------------------------

function formatPercent(x) {
  return typeof x === "number" && Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

function formatDecimal(x) {
  return typeof x === "number" && Number.isFinite(x) ? x.toFixed(4) : "n/a";
}

// The job summary for a successful validation. Always includes the verdict numbers,
// `plain_reading` when present, every sentence in `envelope.limits` verbatim (never a subset,
// never paraphrased), the receipt URL, and the badge markdown when there is one: never only a
// number, per the boundary this API exists to hold.
export function formatSuccessSummary({ envelope, badgeInfo, failOn, failOnThreshold, failOnFired, repoContext }) {
  const data = envelope?.data ?? {};
  const result = data.result ?? {};
  const receipt = envelope?.receipt ?? {};
  const lines = [];

  lines.push("## Canli Capital backtest validation");
  lines.push("");
  lines.push("| Metric | Value |");
  lines.push("| --- | --- |");
  lines.push(`| Deflated Sharpe ratio | ${formatPercent(result.deflated_sharpe_ratio)} |`);
  lines.push(`| Probabilistic Sharpe ratio (against zero) | ${formatPercent(result.psr_against_zero)} |`);
  lines.push(`| Expected max Sharpe, annualized (search haircut) | ${formatDecimal(result.expected_max_sharpe_annualized)} |`);
  lines.push(`| Input mode | ${data.input_mode ?? "return_series"} |`);
  lines.push("");

  if (data.plain_reading) {
    lines.push(`**Plain reading:** ${data.plain_reading}`);
    lines.push("");
  }

  lines.push("### What this verdict does not establish");
  for (const sentence of envelope?.limits ?? []) lines.push(`- ${sentence}`);
  lines.push("");

  if (receipt.url) lines.push(`Receipt: ${receipt.url}`);
  if (receipt.id) lines.push(`Receipt id: \`${receipt.id}\``);
  if (receipt.url || receipt.id) lines.push("");

  if (badgeInfo?.embed_markdown) {
    lines.push("### Badge");
    lines.push("Paste this into your README:");
    lines.push("");
    lines.push("```markdown");
    lines.push(badgeInfo.embed_markdown);
    lines.push("```");
    lines.push("");
    lines.push(badgeInfo.embed_markdown);
    lines.push("");
    if (badgeInfo.source === "fallback") {
      lines.push("_(reconstructed locally; GET /api/v1/receipts/{id} did not respond in time)_");
      lines.push("");
    }
  }

  if (failOn === "dsr-below") {
    lines.push(
      `Note: \`fail-on: dsr-below\` with threshold ${failOnThreshold} is this workflow's own policy, not a verdict from the Canli Capital API. ` +
        `${failOnFired ? "This run did not meet that threshold; the job is failing because of this workflow's own setting." : "This run met that threshold."}`,
    );
    lines.push("");
  }

  if (repoContext?.repo) {
    const shortSha = repoContext.sha ? String(repoContext.sha).slice(0, 12) : "unknown";
    lines.push(`_Run: ${repoContext.repo}@${shortSha}${repoContext.runId ? `, run ${repoContext.runId}` : ""}_`);
  }

  return `${lines.join("\n")}\n`;
}

// The job summary for a failed API call (bad key, quota exhausted, malformed input, unreachable
// service): never a bare status code, always the error and, when the envelope carried one, every
// limits sentence too.
export function formatErrorSummary({ action, status, envelope }) {
  const lines = [];
  lines.push("## Canli Capital backtest validation: failed");
  lines.push("");
  lines.push(`${action} returned HTTP ${status}.`);
  const error = envelope?.error;
  if (error?.code) lines.push(`- Code: ${error.code}`);
  if (error?.message) lines.push(`- Message: ${error.message}`);
  lines.push("");
  const limits = envelope?.limits ?? [];
  if (limits.length > 0) {
    lines.push("### What this service's verdicts do not establish");
    for (const sentence of limits) lines.push(`- ${sentence}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// A one-line message for core.setFailed(): the error code and message when the API sent an error
// envelope, otherwise just the HTTP status.
export function describeApiError({ action, status, envelope }) {
  const error = envelope?.error;
  if (error?.message) {
    return `Error ${action}: ${error.code ? `${error.code}: ` : ""}${error.message}`;
  }
  return `Error ${action}: HTTP ${status}`;
}

export const MISSING_KEY_MESSAGE =
  "No Canli Capital API key was provided. Add your key as a repository secret " +
  "(Settings > Secrets and variables > Actions > New repository secret, name it CANLI_KEY) and pass it to this " +
  "action as `api-key: ${{ secrets.CANLI_KEY }}`. Alternatively set `issue-key: true` to have this action request " +
  "a new key on each run, but note the API allows only 5 keys per client per UTC day, so issuing one per CI run " +
  "will exhaust that quota fast; a stored secret is the supported path.";
