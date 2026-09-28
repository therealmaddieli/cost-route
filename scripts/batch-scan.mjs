#!/usr/bin/env node
/**
 * Cost-Route step 5: what the batch card actually charges.
 *
 *   node scripts/batch-scan.mjs            # scan the cached catalogue
 *   node scripts/batch-scan.mjs --fetch    # refresh both catalogues first
 *
 * OpenRouter's Batch API announcement says batch requests "generally charge 50% (and sometimes
 * less) of their normal per-token price". A buyer reads that as a rule. It is a typical case.
 *
 * The catalogue is the check, and it is free. Every `<slug>:batch` is a full entry in
 * GET /models with its own `pricing`, so the whole comparison can be made without submitting a
 * single batch and without spending anything. On 2026-09-28 that is 72 pairs, of which 65 are
 * exactly 0.5x — and two charge MORE for going async. A partner who integrates batch and then
 * finds the bill went up has been misled by the headline, not by their own arithmetic, which is
 * why this is worth measuring before it is worth arguing about.
 *
 * This script only reads. It costs nothing and it writes nothing but its own JSON.
 *
 * The discount is a PUBLISHED PRICE, not a bill. It says what the catalogue lists; it does not
 * say what a given batch was charged. `usage.cost` on a completed batch is the authority for
 * that, and the report keeps the two apart on purpose.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildCatalogue, catalogueSummary, batchDistribution } from "../core/catalogue.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const HF_ROUTER_MODELS = "https://router.huggingface.co/v1/models";
const catalogueCache = path.join(root, "out", "catalogue-latest.json");

const refresh = flag("--fetch");

// The claim under test, recorded with where it came from and when it was read, because a quote
// that outlives its source is how a finding turns into folklore.
const CLAIM = {
  ratio: 0.5,
  text: "Batch requests generally charge 50% (and sometimes less) of their normal per-token price.",
  source: "https://openrouter.ai/blog/announcements/batch-api/",
  read_on: "2026-09-28",
};

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

async function getJson(url, what) {
  const res = await fetch(url, { headers: { "user-agent": "cost-route/0.5" } });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function loadCatalogues() {
  if (!refresh && fs.existsSync(catalogueCache)) {
    return { payload: JSON.parse(fs.readFileSync(catalogueCache, "utf8")), source: "cache" };
  }
  const [openrouter, huggingface] = await Promise.all([
    getJson(OPENROUTER_MODELS, "OpenRouter /models"),
    getJson(HF_ROUTER_MODELS, "HF router /v1/models"),
  ]);
  const payload = { fetched_at: new Date().toISOString(), openrouter, huggingface };
  fs.mkdirSync(path.dirname(catalogueCache), { recursive: true });
  fs.writeFileSync(catalogueCache, JSON.stringify(payload));
  return { payload, source: "fetched" };
}

// ---------------------------------------------------------------------------
// scan
// ---------------------------------------------------------------------------

const { payload, source } = await loadCatalogues();
const catalogue = buildCatalogue(
  { openrouter: payload.openrouter, huggingface: payload.huggingface },
  payload.fetched_at
);

// The rows, the sort and the counts all come from one function in core/catalogue.mjs, which the
// report renders from too. Both surfaces have to be able to say "65 of 72" and agree.
const distribution = batchDistribution(catalogue, CLAIM.ratio);
const pairs = distribution.rows;

// A scan that finds nothing has not proved the discount is uniform, it has proved the catalogue
// changed shape under it. Both of these mean the pairing stopped working and the numbers below
// would be quietly meaningless, so they are fatal rather than warnings.
if (pairs.length === 0) {
  throw new Error(
    "No batch pairs found. Either the catalogue no longer carries `:batch` entries or the pairing broke."
  );
}
if (catalogue.batch.orphans.length > 0) {
  throw new Error(
    `Batch cards with no base model: ${catalogue.batch.orphans.join(", ")}. The comparison for these cannot be made.`
  );
}

const unpriced = distribution.unpriced;
const rated = pairs.filter((r) => r.prompt_ratio !== null);

const summary = {
  pairs: distribution.pairs,
  rated: distribution.rated,
  unpriced: distribution.unpriced.length,
  at_claim: distribution.at_typical,
  cheaper_than_claim: distribution.cheaper_than_typical,
  dearer_than_claim: distribution.dearer_than_typical,
  costs_more_than_sync: distribution.costs_more_than_sync,
};

const scannedAt = new Date().toISOString();
const outFile = path.join(root, "out", `batch-scan-${scannedAt.replace(/[:.]/g, "-")}.json`);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      scanned_at: scannedAt,
      catalogue_fetched_at: payload.fetched_at,
      catalogue_source: source,
      claim: CLAIM,
      summary,
      catalogue_summary: catalogueSummary(catalogue),
      unpriced,
      rows: pairs,
    },
    null,
    2
  ) + "\n"
);

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

const pct = (n, d) => `${((n / d) * 100).toFixed(1)}%`;
const x = (r) => `x${r.toFixed(4)}`;

console.log(`Cost-Route: batch scan`);
console.log(`  catalogue  ${path.relative(root, catalogueCache)} (${source}, fetched ${payload.fetched_at})`);
console.log(`  pairs      ${summary.pairs} batch rate cards against their standard rate card`);
if (unpriced.length) {
  console.log(`  unpriced   ${unpriced.length} pair(s) with no published rate on one side, excluded from the counts below`);
}
console.log();

console.log(`  The claim, read ${CLAIM.read_on} from ${CLAIM.source}`);
console.log(`    "${CLAIM.text}"`);
console.log();
console.log(`  What the catalogue charges`);
console.log(`    exactly 50%                      ${String(summary.at_claim).padStart(3)}  ${pct(summary.at_claim, summary.rated)}`);
console.log(`    cheaper than 50%                 ${String(summary.cheaper_than_claim).padStart(3)}  ${pct(summary.cheaper_than_claim, summary.rated)}`);
console.log(`    dearer than 50%, still a discount${String(summary.dearer_than_claim - summary.costs_more_than_sync).padStart(2)}  ${pct(summary.dearer_than_claim - summary.costs_more_than_sync, summary.rated)}`);
console.log(`    MORE than the standard card      ${String(summary.costs_more_than_sync).padStart(3)}  ${pct(summary.costs_more_than_sync, summary.rated)}`);
console.log();

const notAtClaim = rated.filter((r) => r.prompt_ratio !== CLAIM.ratio);
console.log(`  The ${notAtClaim.length} that are not 50%`);
for (const r of notAtClaim) {
  const mark = r.prompt_ratio > 1 ? "  <-- costs MORE async" : "";
  const tier = r.tiered ? "  [tiered]" : "";
  console.log(
    `    ${r.slug.padEnd(32)} prompt ${x(r.prompt_ratio).padEnd(9)} completion ${x(r.completion_ratio).padEnd(9)}${mark}${tier}`
  );
}
console.log();
console.log(`  wound up in  ${path.relative(root, outFile)}`);
