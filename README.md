# Validate backtest with Canli receipts

A JavaScript GitHub Action that sends a backtest's return series to
[canlicapital.com](https://canlicapital.com)'s free deflated-Sharpe validator
(`POST /api/v1/validate/deflated-sharpe`, return-series mode), writes the verdict together with
every sentence that bounds what it means to the job summary, and outputs the receipt id, receipt
URL and a ready-to-paste badge.

This action is not published to the GitHub Marketplace. Reference it from this repository, or
copy `action/` into your own.

## What the API is (and is not)

The service runs the return series you submit through the same probabilistic and deflated Sharpe
arithmetic canlicapital.com's own paper record runs on itself, and hands back a verdict anyone can
recompute from the receipt. It does not accept market data, does not sign receipts, does not grade
a strategy, and never saw your data source, its costs, survivorship, or any lookahead in how the
series was built. A deflated Sharpe above or below any threshold is not admission to anything and
is not a forecast. This action never prints a bare number: the job summary always carries the
verdict together with every one of those sentences, the receipt URL, and the badge.

The job summary, the badge and this README never say a run was **verified**, **approved**,
**passed** or **profitable**. There is no pass/fail mark. A deflated Sharpe ratio is a
probability, not a verdict on the strategy.

## Quotas this action respects

canlicapital.com's free API allows **5 keys per client per UTC day** and **1000 validations per
key per UTC day** (see `api/_lib/limits.js` in the main repository; the job summary also prints
these verbatim from the API's own response on every run). Because of the 5-keys-per-day quota,
**this action never issues an API key by default.** Store a key once as a repository secret and
reuse it on every run; only set `issue-key: true` for a one-off or a very low-frequency workflow.

## Setup

1. Get a free key:

   ```bash
   curl -s -X POST https://canlicapital.com/api/v1/keys \
     -H "Content-Type: application/json" \
     -d '{"label": "github-action"}'
   ```

   The response's `data.key` (`ck_live_...`) is shown once; it cannot be recovered later.

2. Add it as a repository secret named `CANLI_KEY`: **Settings > Secrets and variables > Actions >
   New repository secret**.

3. Add a workflow step (see below).

## Usage

```yaml
name: Validate backtest

on:
  push:
    branches: [main]

jobs:
  validate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # ... your backtest step writes returns.json or returns.csv here ...

      - name: Validate backtest with Canli receipts
        id: canli
        uses: ./action
        with:
          returns-file: returns.json
          periods-per-year: "252"
          effective-independent-trials: "30"
          api-key: ${{ secrets.CANLI_KEY }}

      - name: Show the outputs
        run: |
          echo "Deflated Sharpe: ${{ steps.canli.outputs.dsr }}"
          echo "Receipt: ${{ steps.canli.outputs.receipt-url }}"
```

If this action lives in another repository, replace `uses: ./action` with
`uses: <owner>/<repo>/action@<ref>`.

### `returns-file` format

- **CSV**: one number per line, or a single leading numeric column (extra columns are ignored).
- **JSON**: an array of numbers.

The format is chosen by file extension: a path ending in `.json` is read as JSON, anything else
as CSV.

### Inputs

| Input | Required | Default | Meaning |
|---|---|---|---|
| `returns-file` | yes | | Path to the CSV or JSON returns file. |
| `periods-per-year` | yes | | e.g. `252` for daily returns, `12` for monthly. |
| `effective-independent-trials` | yes | | The declared search: how many independent trials produced this series. |
| `cross-trial-sharpe-sd-annualized` | no | `0.5` | Annualized SD of Sharpe across trials. Defaults to the same value `public/api/v1/openapi.json`'s own example uses, since a single equity curve has no per-strategy analogue for this input. |
| `api-key` | no | | A Canli Capital key. Prefer `${{ secrets.CANLI_KEY }}`. |
| `issue-key` | no | `false` | Issue a new key via `POST /api/v1/keys` when `api-key` is unset. Off by default; see Quotas above. |
| `label` | no | `github-action` | Attribution label sent with key issuance and validation requests, the same convention `integrations/canli_validate/__init__.py` and the stdio MCP server use. |
| `api-base` | no | `https://canlicapital.com` | Point this at a preview deployment for testing. |
| `fail-on` | no | (unset) | Left unset, this action never fails the job over the verdict. Set to `dsr-below` (with `fail-on-threshold`) to fail the job when the deflated Sharpe ratio is below your threshold. This is **your** policy, not the API's verdict, and the summary says so every time. |
| `fail-on-threshold` | no | | Threshold used when `fail-on` is `dsr-below`. |

### Outputs

| Output | Meaning |
|---|---|
| `dsr` | `data.result.deflated_sharpe_ratio`, a probability in `[0, 1]`. |
| `psr` | `data.result.psr_against_zero`, a probability in `[0, 1]`. |
| `receipt-id` | The 24-hex-character content-hash id of the stored receipt. |
| `receipt-url` | `GET /api/v1/receipts/{id}`. |
| `badge-markdown` | Markdown embed for the receipt badge (`embed_markdown` from the receipt route). |

### Failing the job on a threshold, honestly

By default this action never fails a job over the verdict, only over an API or input error (a bad
key, an exhausted quota, a malformed returns file). If you want CI to fail when a backtest doesn't
clear a bar you have chosen:

```yaml
      - uses: ./action
        with:
          returns-file: returns.json
          periods-per-year: "252"
          effective-independent-trials: "30"
          api-key: ${{ secrets.CANLI_KEY }}
          fail-on: dsr-below
          fail-on-threshold: "0.5"
```

The job summary states plainly that this threshold is this workflow's own policy, never a verdict
the API issued.

## The badge

Every successful run fetches `GET /api/v1/receipts/{id}` and prints the `embed_markdown` it
returns to the job summary, ready to paste into a README:

```markdown
[![Canli receipt](https://canlicapital.com/api/v1/receipts/<id>/badge.svg)](https://canlicapital.com/api/v1/receipts/<id>)
```

The badge itself shows only the formula version and the receipt id prefix; it never carries the
words verified, approved, passed, certified or profitable, and never a pass/fail mark. If the
receipts route does not answer, the action reconstructs the same URL locally from the receipt id
(the formula is public: `api/v1/receipts/[id].js`) and says in the summary that it did so, so a
run still ends with a working badge instead of none at all.

## Marketplace listing (not published)

This action is not published to the GitHub Marketplace. If it ever is, this is the listing text:

> **Name:** Validate backtest with Canli receipts
>
> **Description:** Send a backtest's return series to canlicapital.com's free deflated-Sharpe
> validator and publish the receipt, badge and every boundary sentence to your job summary. Never
> issues an API key by default; never fails your job over the verdict unless you opt in.
>
> **Category:** Continuous integration
>
> **Icon:** check-circle, blue.

## Development

```bash
cd action
npm ci
npm test
npm run build
```

`npm run build` regenerates `dist/index.mjs` with the pinned `@vercel/ncc`; `dist/` is committed
so a consumer's workflow can run this action with no install step, as the GitHub Actions runner
requires. `npm test` includes a test that rebuilds `dist/` and fails if the committed copy is
stale.

Tests use `node:test` against a local HTTP stub of the three API routes this action calls
(`POST /api/v1/keys`, `POST /api/v1/validate/deflated-sharpe`, `GET /api/v1/receipts/{id}`); no
test makes a real network call or uses a real API key.
