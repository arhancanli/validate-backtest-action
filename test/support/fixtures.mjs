// action/test/support/fixtures.mjs
//
// Canned envelopes shaped exactly like the real API (api/_lib/envelope.js, api/_lib/limits.js,
// api/v1/validate/deflated-sharpe.js, api/v1/receipts/[id].js), so a test asserting against these
// fixtures is asserting against the real contract, not an invented one.
export const LIMITS_TEXT = Object.freeze([
  "This verdict is about the series exactly as submitted. The service never saw the data source, its costs, survivorship, or any lookahead in how the series was built.",
  "A deflated Sharpe or overfitting probability above or below any threshold is not admission to anything and is not a forecast.",
  "The receipt is content-hashed and reproducible from the open-source core it names. It is not signed.",
  "Quotas: 1000 validations per key per UTC day, 5 keys per client per UTC day, 1048576 bytes per request, 20000 observations per series, 200 variants per matrix.",
]);

const ORIGIN = "https://canlicapital.com";

function envelope({ endpoint, data, receipt, error, claimClass = "USER_SUBMITTED_SCENARIO", capitalKind = "NOT_APPLICABLE_USER_SUBMITTED" }) {
  const body = {
    schema: "canli.api.v1",
    endpoint: `/api/v1/${endpoint}`,
    generated_at: "2026-09-06T00:00:00Z",
    claim_class: claimClass,
    capital_kind: capitalKind,
    canonical_human_page: `${ORIGIN}/developers`,
    limits: LIMITS_TEXT,
    sources: [{ path: "js/dsr-core.js", sha256: "sha256:stub", url: `${ORIGIN}/js/dsr-core.js` }],
    data: data ?? {},
  };
  if (receipt) body.receipt = receipt;
  if (error) body.error = error;
  return body;
}

export const RECEIPT_ID = "aaaaaaaaaaaaaaaaaaaaaaaa";

export function keyIssuedEnvelope({ label = "github-action", key = "ck_live_stubkey0000000000000000" } = {}) {
  return envelope({
    endpoint: "keys",
    claimClass: "OBSERVED",
    capitalKind: "NOT_APPLICABLE_SERVICE_STATUS",
    data: { key, label, keys_remaining_today: 4, note: "Store this key now. Only its hash is kept and it cannot be shown again." },
  });
}

// Mirrors js/dsr-core.js calculateDsr's output shape exactly (see api/v1/validate/deflated-sharpe.js).
export function validateSuccessEnvelope({ derivedInputs } = {}) {
  const result = {
    observed_sharpe_per_period: 0.0421,
    cross_trial_sharpe_variance_per_period: 0.0009,
    expected_max_sharpe_per_period: 0.021,
    expected_max_sharpe_annualized: 0.333,
    psr_against_zero: 0.812,
    deflated_sharpe_ratio: 0.734,
    non_normality_variance_term: 0.98,
    search_haircut_annualized: 0.05,
    psr_z_score: 0.88,
    dsr_z_score: 0.62,
  };
  const plain_reading =
    "Counting only sample uncertainty, the probability this Sharpe is above zero is 81.2 percent. " +
    "Deflated for the best-by-luck Sharpe the declared search would produce (0.333 annualised), it is 73.4 percent. Neither number is a forecast.";
  return envelope({
    endpoint: "validate/deflated-sharpe",
    data: { input_mode: "return_series", derived_inputs: derivedInputs ?? {}, result, plain_reading, receipt_stored: true },
    receipt: {
      id: RECEIPT_ID,
      url: `${ORIGIN}/api/v1/receipts/${RECEIPT_ID}`,
      input_sha256: "sha256:stub-input",
      output_sha256: "sha256:stub-output",
    },
  });
}

export function receiptEnvelope({ id = RECEIPT_ID } = {}) {
  const badge_url = `${ORIGIN}/api/v1/receipts/${id}/badge.svg`;
  const receipt_url = `${ORIGIN}/api/v1/receipts/${id}`;
  return envelope({
    endpoint: `receipts/${id}`,
    data: {
      id,
      endpoint: "/api/v1/validate/deflated-sharpe",
      input_sha256: "sha256:stub-input",
      output: {},
      bindings: {},
      created_at: "2026-09-06T00:00:00Z",
      badge_url,
      embed_markdown: `[![Canli receipt](${badge_url})](${receipt_url})`,
      how_to_reproduce: "stub",
    },
  });
}

export function errorEnvelope({ endpoint, code, message }) {
  return envelope({ endpoint, error: { code, message } });
}

export const UNAUTHORIZED_ENVELOPE = errorEnvelope({
  endpoint: "validate/deflated-sharpe",
  code: "unauthorized",
  message: "Unknown or revoked key",
});

export const QUOTA_EXHAUSTED_ENVELOPE = errorEnvelope({
  endpoint: "validate/deflated-sharpe",
  code: "quota_exhausted",
  message: "Daily quota of 1000 validations reached",
});
