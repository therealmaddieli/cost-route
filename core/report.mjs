/**
 * The interactive report: one self-contained HTML file, no backend, no key, no hosting.
 *
 * ## What is interactive, and what is locked
 *
 * The reader may move their own assumptions: monthly request volume, the prompt size they expect,
 * and their own monthly estimate in dollars. Everything measured is fixed: the quality score, the
 * latency percentiles, the token counts per call, the cache hit rate, and the fetch date on every
 * price.
 *
 * That split is not a limitation, it is the argument. A page that lets a reader drag the measured
 * numbers becomes the estimate generator this project exists to criticise: confident figures
 * manufactured from invented inputs. The interaction that carries the point is the reader typing
 * their own estimate and watching a measured number replace it beside the named reasons the two
 * disagree.
 *
 * ## Why the cost arithmetic appears twice, and why that is not a bug
 *
 * The engine in cost.mjs runs in Node. The page has to respond to a slider without a server, so the
 * same arithmetic runs again in the browser as CLIENT_FN_SRC. Two copies of one formula is exactly
 * how a tool starts lying: someone fixes a rounding case in the engine and the page keeps
 * reporting the old answer, for months, with no test anywhere near it.
 *
 * So the client copy is not a hand-written second draft. It is one string, embedded verbatim, and
 * `tests/report.test.mjs` compiles that same string and runs it against `costPerCall` over a grid
 * of prompt sizes and every candidate in the report. If the two ever disagree, the suite fails.
 */

import { archetypeFor } from "./archetypes.mjs";

// ---------------------------------------------------------------------------
// the client-side cost function, embedded verbatim
// ---------------------------------------------------------------------------

/**
 * Kept as a source string because it has to ship inside the HTML. The test suite evaluates this
 * exact string and compares it against the engine, so the duplication cannot drift unnoticed.
 *
 * It is a faithful port of resolveRate + costPerCall, minus the assumption prose, which the page
 * renders from the `reasons` flags instead so that the wording lives in one place.
 */
export const CLIENT_FN_SRC = `
function reportResolveRate(pricing, inputTokens) {
  var tiers = (pricing.tiers || []).filter(function (t) {
    return t.min_prompt_tokens != null && inputTokens >= t.min_prompt_tokens;
  });
  tiers.sort(function (a, b) { return b.min_prompt_tokens - a.min_prompt_tokens; });
  var tier = tiers[0] || null;
  return {
    input_per_m: tier && tier.input_per_m != null ? tier.input_per_m : pricing.input_per_m,
    output_per_m: tier && tier.output_per_m != null ? tier.output_per_m : pricing.output_per_m,
    cache_read_per_m: tier && tier.cache_read_per_m != null ? tier.cache_read_per_m : pricing.cache_read_per_m,
    tier_applied: tier ? tier.min_prompt_tokens : null
  };
}

// The cost of ONE call at a reader-chosen prompt size. Everything else about the workload is
// measured and comes from candidate.measured.
//
// The opts argument overrides two things, and each override answers a specific question:
//
//   cacheHitRate: 0    prices the reader's OWN assumption, which is that nothing is cached. This
//                      is what makes the page's two gaps two numbers instead of one.
//   outputTokens       the reader's expected answer length.
//
// Everything else stays measured, which is what lets the panel price a configuration nobody has run
// while still saying exactly which parts of it were observed.
function reportCostPerCall(candidate, promptTokens, opts) {
  opts = opts || {};
  var pricing = candidate.pricing || {};
  var measured = candidate.measured || {};
  var prompt = Math.max(0, Math.floor(promptTokens || 0));
  var rate = reportResolveRate(pricing, prompt);

  var cacheRate = opts.cacheHitRate != null ? opts.cacheHitRate : (measured.cache_hit_rate || 0);
  var cachedTokens = Math.min(prompt, Math.round(prompt * cacheRate));
  var uncachedTokens = prompt - cachedTokens;
  var outputTokens = opts.outputTokens != null ? opts.outputTokens : (measured.output_tokens_per_call || 0);
  var reasoningTokens = measured.reasoning_tokens_per_call || 0;
  var counts = measured.per_call_counts || {};

  // How much of the output count is the picture. An image model bills its image as completion
  // tokens with no separate line, so measured.output_tokens_per_call still contains them, and this
  // is the only record of which ones. Ported from core/cost.mjs, where getting it wrong undercounted
  // a gemini call by 12x.
  var imageTokens = measured.image_tokens_per_call || 0;
  var imageRate = pricing.image_output_per_m != null ? pricing.image_output_per_m : null;

  var reasons = [];
  var breakdown = { uncached_input: 0, cached_input: 0, output: 0, image_output: 0, reasoning: 0, per_call: 0 };
  var perCall = 0;
  var complete = true;

  if (rate.tier_applied != null) reasons.push("tier");

  if (rate.input_per_m == null) {
    complete = false;
    reasons.push("no_input_price");
  } else {
    breakdown.uncached_input = (uncachedTokens / 1e6) * rate.input_per_m;
    perCall += breakdown.uncached_input;

    if (cachedTokens > 0) {
      if (rate.cache_read_per_m != null) {
        breakdown.cached_input = (cachedTokens / 1e6) * rate.cache_read_per_m;
        reasons.push("cache_applied");
      } else {
        // No published cache rate, so the discount cannot be claimed. Charging the full rate is
        // the conservative direction and the page says so rather than quietly awarding it.
        breakdown.cached_input = (cachedTokens / 1e6) * rate.input_per_m;
        reasons.push("cache_unavailable");
      }
      perCall += breakdown.cached_input;
    }
  }

  if (rate.output_per_m == null) {
    complete = false;
    reasons.push("no_output_price");
  } else {
    // The image half is taken out first and charged below at its own rate, so the text rate applies
    // only to the words. When no image rate is published the subtraction does not happen: charging
    // text prices on every output token is the honest fallback, and the reason flag says the figure
    // is unverified rather than letting it pass as measured.
    var textOutputTokens = imageRate === null ? outputTokens : Math.max(0, outputTokens - imageTokens);
    breakdown.output = (textOutputTokens / 1e6) * rate.output_per_m;
    perCall += breakdown.output;
  }

  if (imageTokens > 0) {
    if (imageRate !== null) {
      breakdown.image_output = (imageTokens / 1e6) * imageRate;
      perCall += breakdown.image_output;
      reasons.push("image_at_image_rate");
    } else {
      complete = false;
      breakdown.image_output = null;
      reasons.push("image_no_rate");
    }
  }

  if (reasoningTokens > 0) {
    var reasoningRate = pricing.reasoning_per_m != null ? pricing.reasoning_per_m : rate.output_per_m;
    if (reasoningRate == null) {
      complete = false;
      reasons.push("no_reasoning_price");
    } else {
      breakdown.reasoning = (reasoningTokens / 1e6) * reasoningRate;
      perCall += breakdown.reasoning;
      if (pricing.reasoning_per_m == null) reasons.push("reasoning_at_output_rate");
    }
  }

  Object.keys(counts).forEach(function (kind) {
    var count = counts[kind];
    if (!count) return;
    var price = pricing.per_call ? pricing.per_call[kind] : null;
    if (price == null) {
      complete = false;
      reasons.push("no_per_call_price:" + kind);
      return;
    }
    breakdown.per_call += count * price;
  });
  perCall += breakdown.per_call;

  // The context window is a hard limit rather than a cost question, and a page that silently prices
  // a prompt the model cannot accept is producing a number for a call that would fail.
  if (candidate.context_length && prompt > candidate.context_length) reasons.push("over_context");

  return {
    per_call_usd: perCall,
    breakdown: breakdown,
    rate_used: rate,
    cached_tokens: cachedTokens,
    complete: complete,
    reasons: reasons
  };
}
`;

// ---------------------------------------------------------------------------
// the report model: everything that is measured, locked, and timestamped
// ---------------------------------------------------------------------------

/** The candidate fields the page needs. Everything here is a measurement or a quoted price. */
function candidateForReport(entry, measuredProfile, extras = {}) {
  const m = entry.model;
  const profile = measuredProfile ?? null;

  // The cache hit RATE is the measured quantity, not the token count. Holding the rate fixed while
  // the reader moves the prompt size is what makes the interaction honest: it says "what you send
  // gets cached at this rate", which is what was actually observed, rather than asserting an
  // absolute token count for a prompt nobody measured.
  const inputTokens = profile?.input_tokens_per_call ?? 0;
  const cacheHitRate =
    profile && inputTokens > 0
      ? Math.min(1, (profile.cached_input_tokens_per_call ?? 0) / inputTokens)
      : 0;

  return {
    key: entry.key,
    name: m.name,
    slug: m.slug,
    source: m.source,
    provider: entry.provider ?? m.providers_ranked?.[0]?.provider ?? null,
    route: entry.route,
    incumbent: entry.incumbent === true,
    why_in_shortlist: entry.why_in_shortlist ?? null,
    context_length: m.context_length ?? null,
    licence: entry.licence ?? null,
    // The blended input rate after caching, computed from the measured profile. It is printed
    // beside the list rate because the two rank candidates differently, and the list rate is the
    // one nobody pays.
    effective_input_per_m: entry.effective_input_per_m ?? null,
    pricing: {
      input_per_m: m.pricing?.input_per_m ?? null,
      output_per_m: m.pricing?.output_per_m ?? null,
      cache_read_per_m: m.pricing?.cache_read_per_m ?? null,
      reasoning_per_m: m.pricing?.reasoning_per_m ?? null,
      image_output_per_m: m.pricing?.image_output_per_m ?? null,
      per_call: m.pricing?.per_call ?? null,
      tiers: m.pricing?.tiers ?? [],
    },
    measured: profile
      ? {
          input_tokens_per_call: profile.input_tokens_per_call,
          output_tokens_per_call: profile.output_tokens_per_call,
          cached_input_tokens_per_call: profile.cached_input_tokens_per_call,
          reasoning_tokens_per_call: profile.reasoning_tokens_per_call,
          // How many of `output_tokens_per_call` are the picture. Without this the client-side
          // pricer charges 1,290 image tokens at the $2.50/M text rate instead of $30/M, which is
          // the 12x error core/cost.mjs was fixed for. It has to travel to the page or the page
          // repeats it.
          image_tokens_per_call: profile.image_tokens_per_call ?? 0,
          per_call_counts: profile.per_call_counts,
          cache_hit_rate: cacheHitRate,
        }
      : null,
    profile_source: profile ? "measured" : "assumed",
    ...extras,
  };
}

/**
 * Assemble everything the page renders. Pure: no network, no clock beyond the timestamps passed in.
 *
 * @param {object} input
 *   workload       parsed workload file
 *   candidates     candidate records, each { key, model, route, provider, licence, measured, extras }
 *   ledger         the estimate-versus-measured ledger for the incumbent
 *   catalogueMeta  { fetched_at, openrouter_models, huggingface_models, hf_provider_entries, hf_unpriced }
 *   generatedAt    ISO timestamp for the page itself
 *   benchmarkMeta  { run_at, path }
 */
export function buildReportModel(input) {
  const {
    workload,
    workloads,
    candidates = [],
    ledger = null,
    routes = [],
    catalogueMeta = {},
    benchmarkMeta = {},
    generatedAt = new Date().toISOString(),
    n8nCanvas = null,
  } = input;

  // Two call shapes. The old flat one still works and is still what most callers use, so it is
  // wrapped rather than removed: a signature change that silently reinterprets its arguments is
  // how a page starts rendering the wrong workload without anything throwing.
  const list = Array.isArray(workloads) && workloads.length
    ? workloads
    : [{ workload, candidates, ledger, routes, benchmarkMeta }];

  const built = list.map((entry) => buildOneWorkload(entry, catalogueMeta));

  return {
    generated_at: generatedAt,
    catalogue_fetched_at: catalogueMeta.fetched_at ?? null,
    // The n8n canvas screenshot as a data URI, or null. The page embeds it rather than linking it so
    // the file stays openable from disk, and null renders no image rather than a broken one.
    n8n_canvas: n8nCanvas,
    // The first workload, at the top level, because nineteen tests and the whole shipped page read
    // it there. `workloads` is the new truth and `workload` is its first element, not a copy.
    workload: built[0].workload,
    candidates: built[0].candidates,
    ledger: built[0].ledger,
    routes: built[0].routes,
    benchmark: built[0].benchmark,
    catalogue: built[0].catalogue,
    workloads: built,
  };
}

/** One workload's slice of the page: its own candidates, ledger, routes and benchmark run. */
function buildOneWorkload(entry, catalogueMeta) {
  const {
    workload,
    candidates = [],
    ledger = null,
    routes = [],
    benchmarkMeta = {},
    batchMeta = {},
  } = entry;

  const volume = workload.monthly_requests ?? null;

  const priced = candidates.map((c) => {
    const measured = c.measured ?? null;
    return candidateForReport(c, measured, {
      quality: c.quality ?? null,
      validation: c.validation ?? null,
      measured_cost_per_call: c.measured_cost_per_call ?? null,
      // The pictures themselves, as data URIs, and the aggregate under them. Null on every text
      // candidate, which is what keeps the image branch from being reachable on the text tab.
      images: c.images ?? null,
      image_summary: c.image_summary ?? null,
      gate: c.gate ?? null,
      // The async rate card and, where one ran, the async bill. Null on a model the catalogue does
      // not sell asynchronously, which this page renders as an absent route rather than as a zero.
      batch: c.batch ?? null,
      // No `measured_runs` here. It counted calls that returned usage, while the Served column counts
      // calls that returned an answer, and two definitions of "served" one field apart is how the
      // scored/total conflation started. The page renders `quality.scored` over `quality.total`, and
      // the generator's own log line reads the same two numbers.
    });
  });

  // What the page is allowed to render for this workload. An image workload has no golden set, so
  // there is no correct-share, no per-kind cut and no incumbent gate; rendering empties for them
  // would put a row of zeros where a measurement should be, which reads as "measured, and zero".
  // Computed here, once, so every renderer asks the same question and gets the same answer.
  const qualityScored = (workload.golden_set?.length ?? 0) > 0;

  return {
    workload: {
      name: workload.workload_name,
      kind: workload.workload_kind ?? "text",
      task: workload.task_description,
      // The archetype this workload was scaffolded from, if any (core/archetypes.mjs). Pure
      // provenance: nothing here re-applies archetype defaults, it only says where buyer_estimate's
      // numbers came from. Null on every hand-authored workload that predates archetypes.
      archetype: workload.archetype ?? null,
      monthly_requests: volume,
      quality_bar: workload.quality_bar ?? null,
      latency_ceiling_ms: workload.latency_ceiling_ms ?? null,
      buyer_estimate: workload.buyer_estimate ?? null,
      // Human labels for the question kinds, from the workload file. The benchmark measures against
      // `fact`, `multi_hop` and `absent`; a buyer reads "stated in the contract". The fallback to the
      // raw kind is deliberate: a workload that labels nothing still renders, in the vocabulary the
      // golden set actually used, rather than showing an empty column heading.
      question_kinds: workload.question_kinds ?? null,
      // The prompt sent, for the workloads where the prompt IS the input. Null on a text workload,
      // where the input is a contract document rather than a string anyone typed.
      prompt: workload.prompt ?? null,
      // Measured facts the reader is not allowed to edit on an image workload, because the gap
      // between what they would type and what was measured is the finding. Carried here so the
      // panel can show them as locked rather than hiding the field.
      measured_input_tokens_per_call: measuredInputTokens(priced),
      measured_output_tokens_per_call: measuredOutputTokens(priced),
      measured_image_tokens_per_call: measuredImageTokens(priced),
    },
    quality_scored: qualityScored,
    // The distribution-only rows. A model that is readable for its licence but has no benchmark
    // route at all is a real row in the comparison and is labelled as read rather than measured.
    distribution_rows: workload.distribution_rows ?? [],
    candidates: priced,
    ledger,
    routes,
    benchmark: {
      run_at: benchmarkMeta.run_at ?? null,
      path: benchmarkMeta.path ?? null,
      items: benchmarkMeta.items ?? null,
    },
    // This workload's asynchronous leg: what the workload file declared, what the collected run
    // actually measured, and which candidates the leg refused. The catalogue-wide discount
    // distribution is not here - it is a property of the catalogue, not of this tab, so it travels
    // once on `catalogue.batch` and every tab reads the same numbers.
    batch: {
      declared: batchMeta.declared === true,
      completion_window: batchMeta.completion_window ?? null,
      run_at: batchMeta.run_at ?? null,
      path: batchMeta.path ?? null,
      skipped: batchMeta.skipped ?? [],
      measured_candidates: batchMeta.measured_candidates ?? 0,
    },
    catalogue: {
      openrouter_models: catalogueMeta.openrouter_models ?? null,
      huggingface_models: catalogueMeta.huggingface_models ?? null,
      hf_provider_entries: catalogueMeta.hf_provider_entries ?? null,
      hf_unpriced: catalogueMeta.hf_unpriced ?? null,
      batch: catalogueMeta.batch ?? null,
    },
  };
}

/** The incumbent's measured input size, or the first measured candidate's. Null when nothing ran. */
function measuredInputTokens(priced) {
  const c = priced.find((x) => x.incumbent && x.measured) ?? priced.find((x) => x.measured);
  return c?.measured?.input_tokens_per_call ?? null;
}

function measuredOutputTokens(priced) {
  const c = priced.find((x) => x.incumbent && x.measured) ?? priced.find((x) => x.measured);
  return c?.measured?.output_tokens_per_call ?? null;
}

function measuredImageTokens(priced) {
  const c = priced.find((x) => x.incumbent && x.measured) ?? priced.find((x) => x.measured);
  return c?.measured?.image_tokens_per_call ?? null;
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

/** Escape for text nodes and attribute values. The page embeds its own data, so this is a guard. */
function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * JSON for a <script> block.
 *
 * Two escapes, neither optional. `<` can close the script element early. U+2028 and U+2029 are
 * valid inside a JSON string but are line terminators to a JavaScript parser, so a document
 * containing one would break the page's own script with a syntax error. The input here is a
 * contract file, so that is not hypothetical.
 */
function jsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

const usd = (n, places = 2) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `$${n.toFixed(places)}`;

/** A rate that can be a fraction of a cent needs more places than a monthly total. */
const rateUsd = (n) =>
  n === null || n === undefined || !Number.isFinite(n) ? "n/a" : `$${n.toFixed(4)}`;

const STYLE = `
:root {
  --ink: #14161a;
  --ink-2: #3d434d;
  --ink-3: #6b7280;
  --line: #e3e6ea;
  --line-2: #f0f2f5;
  --bg: #fbfbfc;
  --card: #ffffff;
  --measured: #1f6f43;
  --measured-bg: #eef7f1;
  --assumed: #8a5a00;
  --assumed-bg: #fdf6e7;
  --bad: #a4262c;
  --bad-bg: #fdf0f0;
  --accent: #1c4f8f;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--ink);
  font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
}
.wrap { max-width: 1000px; margin: 0 auto; padding: 40px 24px 96px; }
h1 { font-size: 26px; line-height: 1.25; margin: 0 0 6px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 0 0 4px; letter-spacing: -0.005em; }
h3 { font-size: 14px; margin: 0 0 8px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--ink-3); }
p { margin: 0 0 12px; }
.sub { color: var(--ink-3); font-size: 13px; }
.num { font-family: var(--mono); font-variant-numeric: tabular-nums; }
.hint { color: var(--ink-3); font-size: 12.5px; }

section { margin-top: 40px; }
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 20px 22px;
}
.headline {
  font-size: 19px;
  line-height: 1.45;
  border-left: 3px solid var(--accent);
  padding-left: 16px;
  margin: 24px 0;
}
.headline strong { font-family: var(--mono); font-variant-numeric: tabular-nums; }

/* the lock marker, used consistently so "who owns this number" is never ambiguous */
.lock {
  display: inline-block;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 2px 7px;
  border-radius: 999px;
  vertical-align: 2px;
  white-space: nowrap;
}
.lock.measured { background: var(--measured-bg); color: var(--measured); }
.lock.assumed { background: var(--assumed-bg); color: var(--assumed); }

table { width: 100%; border-collapse: collapse; font-size: 14px; }
/* Every table is a table, not a layout. A seven-column cost table on a 400px phone squashes its
   columns to nothing rather than overflowing, so each one scrolls inside its own box and the page
   body never runs sideways. */
.tablewrap { overflow-x: auto; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line-2); }
th { font-size: 11.5px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); font-weight: 600; }
td.r, th.r { text-align: right; }
tbody tr:last-child td { border-bottom: none; }
tr.total td { border-top: 2px solid var(--line); font-weight: 600; }

.pill { display: inline-block; font-size: 12px; font-weight: 600; padding: 2px 8px; border-radius: 999px; }
.pill.pass { background: var(--measured-bg); color: var(--measured); }
.pill.fail { background: var(--bad-bg); color: var(--bad); }
.pill.warn { background: var(--assumed-bg); color: var(--assumed); }
.pill.unknown { background: var(--line-2); color: var(--ink-3); }

/* interactive panel */
.panel { display: grid; grid-template-columns: 300px 1fr; gap: 28px; }
@media (max-width: 760px) { .panel { grid-template-columns: 1fr; } }
.field { margin-bottom: 18px; }
.field label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 5px; }
.field input[type=number] {
  width: 100%;
  font: inherit;
  font-family: var(--mono);
  font-variant-numeric: tabular-nums;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 7px;
  background: #fff;
  color: var(--ink);
}
.field input[type=number]:focus { outline: 2px solid var(--accent); outline-offset: -1px; border-color: var(--accent); }
.field .hint { margin-top: 4px; }

.verdict { border-radius: 10px; padding: 16px 18px; background: var(--line-2); }
.verdict .big { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 30px; line-height: 1.1; }
.verdict .big small { font-size: 14px; color: var(--ink-3); }
.gap-split { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 14px; }
@media (max-width: 560px) { .gap-split { grid-template-columns: 1fr; } }
.gapbox { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; }
.gapbox .n { font-family: var(--mono); font-variant-numeric: tabular-nums; font-size: 20px; }

/* waterfall */
.wf td { padding: 7px 10px; }
.wf .bar { position: relative; height: 12px; border-radius: 3px; background: var(--line-2); }
.wf .bar span { position: absolute; top: 0; bottom: 0; border-radius: 3px; }
.wf .bar span.down { background: var(--measured); }
.wf .bar span.up { background: var(--bad); }
.wf .note { color: var(--ink-3); font-size: 12.5px; }

/* candidate scatter and live waterfall charts */
svg.chart { width: 100%; height: auto; display: block; overflow: visible; margin-top: 14px; }
svg.chart text { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
.ax-line { stroke: var(--line); stroke-width: 1; }
.ax-grid { stroke: var(--line-2); stroke-width: 1; }
.ax-label { fill: var(--ink-3); font-size: 11px; }
.thresh-line { stroke: var(--ink-3); stroke-width: 1; }
.thresh-label { fill: var(--ink-3); font-size: 11px; }
.mk-pass { fill: var(--measured); stroke: var(--card); stroke-width: 2; }
.mk-fail { fill: var(--bad); stroke: var(--card); stroke-width: 2; }
.mk-ref { fill: var(--line); stroke: var(--ink-3); stroke-width: 1.5; }
.pt-label { fill: var(--ink-2); font-size: 12px; font-weight: 600; }
.callout-box { fill: var(--bg); stroke: var(--line); stroke-width: 1; }
.callout-text { fill: var(--ink-2); font-size: 11.5px; }
.callout-lead { stroke: var(--ink-3); stroke-width: 1; fill: none; }
.chart-legend { display: flex; flex-wrap: wrap; gap: 16px 24px; margin: 12px 0 4px; font-size: 12.5px; color: var(--ink-2); align-items: center; }
.chart-legend .item { display: flex; align-items: center; gap: 7px; }
.chart-legend svg { flex: none; }
.wf-row-label { fill: var(--ink-2); font-size: 12.5px; }
.wf-total { fill: var(--ink-2); }
.wf-total-ring { fill: none; stroke: var(--accent); stroke-width: 2; }
.wf-up { fill: var(--bad); }
.wf-down { fill: var(--measured); }
.wf-connector { stroke: var(--line); stroke-width: 1; }
.wf-value { fill: var(--ink); font-size: 12.5px; font-weight: 600; }
.wf-value-strong { fill: var(--ink); font-size: 13px; font-weight: 700; }
.wf-note-text { fill: var(--ink-3); font-size: 11px; }
.wf-dot { fill: var(--ink-3); }

ul.tight { margin: 6px 0 0; padding-left: 18px; }
ul.tight li { margin-bottom: 5px; }
.flag { border-left: 3px solid var(--assumed); background: var(--assumed-bg); padding: 10px 14px; border-radius: 0 6px 6px 0; margin: 12px 0; font-size: 13.5px; }
.flag.bad { border-color: var(--bad); background: var(--bad-bg); }

/* the image tab: the pictures are the measurement, so they get the space */
.shotgroup { margin-top: 22px; }
.shothead { margin-bottom: 10px; }
.shots { display: flex; flex-wrap: wrap; gap: 14px; }
.shotgroup .shot {
  margin: 0;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 10px;
  padding: 10px;
  flex: 1 1 220px;
  max-width: 300px;
}
.shot img { display: block; width: 100%; height: auto; border-radius: 6px; background: var(--line-2); }
.shot .metrics { display: flex; flex-wrap: wrap; gap: 4px 12px; margin-top: 6px; font-size: 12.5px; color: var(--ink-3); }
.shot .metrics b { font-weight: 600; color: var(--ink); }
.shot.missing { display: flex; flex-direction: column; justify-content: center; }
.shot .shot-empty {
  aspect-ratio: 1; display: flex; align-items: center; justify-content: center;
  border: 1px dashed var(--line); border-radius: 6px;
  color: var(--ink-3); font-size: 12.5px; text-align: center; padding: 10px;
}
@media (max-width: 560px) { .shotgroup .shot { max-width: none; flex-basis: 100%; } }

/* tabs */
.tabs { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 0; border-bottom: 1px solid var(--line); }
.tabs button {
  font: inherit; font-weight: 600; font-size: 14px;
  background: none; border: none; border-bottom: 2px solid transparent;
  margin-bottom: -1px; padding: 8px 4px; cursor: pointer; color: var(--ink-3);
}
.tabs button:hover { color: var(--ink); }
.tabs button[aria-selected="true"] { color: var(--accent); border-bottom-color: var(--accent); }
.tabs button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.tabs .tabsub { color: var(--ink-3); font-weight: 400; font-size: 12.5px; margin-left: 6px; }
.tabpanel[hidden] { display: none; }

.flag.info { border-color: var(--accent); background: #f0f5fc; }
footer { margin-top: 56px; padding-top: 18px; border-top: 1px solid var(--line); color: var(--ink-3); font-size: 12.5px; }
code { font-family: var(--mono); font-size: 0.92em; background: var(--line-2); padding: 1px 5px; border-radius: 4px; }

/* the orientation layer: read this before the argument */
.hero { margin-bottom: 4px; }
.lede { font-size: 16px; line-height: 1.5; max-width: 780px; margin: 0 0 10px; color: var(--ink-2); }
.howto { margin-top: 22px; }
.howto h3 { margin-bottom: 10px; }
ol.steps { margin: 0 0 16px; padding-left: 20px; }
ol.steps li { margin-bottom: 7px; }
.legend { display: flex; flex-wrap: wrap; gap: 8px 20px; font-size: 12.5px; color: var(--ink-2); margin-bottom: 12px; }
.legend > span { flex: 1 1 250px; }
.route-key { border-top: 1px solid var(--line-2); padding-top: 10px; margin-bottom: 0; }
.route-key b { font-family: var(--mono); color: var(--ink); }
.builtwith { margin-top: 40px; }
/* the brief: what this is, who it is for, what it is not */
.brief { margin-top: 18px; display: grid; gap: 10px; }
.brief-row { font-size: 14px; line-height: 1.5; color: var(--ink-2); }
.brief-k {
  display: inline-block; min-width: 108px; font-weight: 600; color: var(--ink);
}
.cta { font-size: 15px; }
.hint.why { margin-top: 3px; max-width: 46em; }
.builtwith .card { margin-top: 12px; }
.builtwith .canvas {
  display: block; width: 100%; height: auto; margin: 16px 0 4px;
  border: 1px solid var(--line); border-radius: 8px; background: #fff;
}
a { color: var(--accent); }
`;

// ---------------------------------------------------------------------------
// section renderers
// ---------------------------------------------------------------------------

function renderHeadline(model) {
  const ledger = model.ledger;
  if (!ledger || !ledger.available) {
    return `<div class="headline">No measured profile for the incumbent, so there is nothing to compare the buyer's estimate against.</div>`;
  }
  const { stated_estimate_usd: stated, own_assumptions_usd: own, measured_usd: got } = ledger;
  return (
    `<div class="headline">` +
    `The estimate of <strong>${usd(stated)}</strong>/month is wrong twice over. ` +
    `<strong>${usd(stated)}</strong> does not follow from the buyer's own stated assumptions, which cost ` +
    `<strong>${usd(own)}</strong> on their own model at their own volume. The measurement then says ` +
    `<strong>${usd(got)}</strong>.` +
    `<br><span class="sub">Two different errors. Only the second one is a measurement problem, and only the ` +
    `second one would have been caught by measuring anything.</span></div>`
  );
}

/**
 * The licence column, which has to say it could not be read rather than rendering blank.
 *
 * A blank cell in a table whose only job is to report one field is indistinguishable from a licence
 * that does not exist, and those are opposite conclusions for a buyer deciding whether they may ship
 * the model. `esc` already stops a missing field from crashing the render, which is not the same
 * thing as handling it: "render nothing" and "say nothing" look identical on a page. The routes
 * table settled this the same way, with "No licence could be read from the model card" standing in
 * for an empty string.
 */
function licenceCell(row) {
  const text = row?.licence_expectation;
  if (text === null || text === undefined || String(text).trim() === "") {
    return `<span class="hint">No licence field could be read for this model, so the page claims nothing about its terms.</span>`;
  }
  return esc(text);
}

/** The waterfall. Locked: every figure here comes from the engine, not from the page's inputs. */
function renderWaterfall(ledger, workloadIndex, chartEnabled) {
  if (!ledger?.available) {
    return `<p class="hint">No bridge: ${esc(ledger?.reason ?? "no ledger was produced")}.</p>`;
  }

  // The chart re-walks the same four dimensions client-side, in the same order, as the panel above
  // moves - see renderWaterfallChart in the client script. An image workload's bridge inserts a
  // fifth dimension (image output tokens) between answer length and caching that walk does not
  // model, so the chart is only offered where chartEnabled says the bridge is the plain four-step
  // kind; the table below is unaffected either way and always shows the frozen, build-time numbers.
  const chart = chartEnabled
    ? `<svg class="chart" id="wf-svg-${workloadIndex}" viewBox="0 0 900 390" role="img"
        aria-label="Waterfall chart from the buyer's stated estimate to the measured cost">
        <g id="wf-grid-x-${workloadIndex}"></g>
        <line class="ax-line" x1="200" y1="340" x2="830" y2="340"/>
        <g id="wf-grid-labels-${workloadIndex}"></g>
        <g id="wf-connectors-${workloadIndex}"></g>
        <text class="wf-row-label" x="190" y="45" text-anchor="end">Buyer's estimate</text>
        <text class="wf-row-label" x="190" y="85" text-anchor="end">Arithmetic correction</text>
        <text class="wf-row-label" x="190" y="125" text-anchor="end">Buyer's own assumptions</text>
        <text class="wf-row-label" x="190" y="165" text-anchor="end">Prompt size</text>
        <text class="wf-row-label" x="190" y="205" text-anchor="end">Answer length</text>
        <text class="wf-row-label" x="190" y="245" text-anchor="end">Prompt caching</text>
        <text class="wf-row-label" x="190" y="285" text-anchor="end">Reasoning tokens</text>
        <text class="wf-row-label" x="190" y="325" text-anchor="end">Measured</text>
        <g id="wf-bars-${workloadIndex}"></g>
        <g id="wf-labels-${workloadIndex}"></g>
      </svg>
      <div class="chart-legend">
        <div class="item"><svg width="18" height="14"><rect x="1" y="4" width="16" height="8" rx="2" class="wf-total"/></svg> Total (a real running figure)</div>
        <div class="item"><svg width="18" height="14"><rect x="1" y="4" width="16" height="8" rx="2" class="wf-up"/></svg> Raises the bill</div>
        <div class="item"><svg width="18" height="14"><rect x="1" y="4" width="16" height="8" rx="2" class="wf-down"/></svg> Lowers the bill</div>
        <div class="item"><svg width="18" height="14"><rect x="2" y="2" width="14" height="10" rx="4" style="fill:none;stroke:var(--accent);stroke-width:2"/></svg> Measured (the answer)</div>
      </div>
      <p class="hint" style="margin:10px 0 0" id="wf-note-line-${workloadIndex}"></p>
      <p class="hint" style="margin:4px 0 0">The table below is the same walk, frozen at the numbers current when this page was generated.</p>`
    : "";

  // Scale the bars to the largest absolute step so the waterfall is readable at any magnitude.
  const maxAbs = Math.max(...ledger.steps.map((s) => Math.abs(s.saving_usd ?? 0)), 0.0001);

  const rows = ledger.steps
    .map((s) => {
      const deltaCost = s.saving_usd === null ? null : -s.saving_usd;
      const mag = Math.abs(deltaCost ?? 0);
      // A minimum width would give a step worth nothing the same visual weight as a real one, and a
      // sliver of red beside "$0.00" reads as a small cost rather than as no cost.
      const width = mag === 0 ? 0 : Math.max(1.5, (mag / maxAbs) * 100);
      const dir = (deltaCost ?? 0) >= 0 ? "up" : "down";
      const sign = deltaCost === null ? "" : deltaCost > 0 ? "+" : deltaCost < 0 ? "−" : "";
      const tokenMove = s.changed
        ? `<span class="num">${Math.round(s.from).toLocaleString()} → ${Math.round(s.to).toLocaleString()}</span>`
        : `<span class="num">${Math.round(s.from).toLocaleString()}</span> <span class="hint">unchanged, measured ${Math.round(s.to).toLocaleString()}</span>`;

      return (
        `<tr>` +
        `<td><strong>${esc(s.label)}</strong><div class="hint">${esc(s.question)}</div></td>` +
        `<td>${tokenMove}</td>` +
        `<td class="r num">${sign}${usd(mag)}</td>` +
        `<td style="width:120px"><div class="bar"><span class="${dir}" style="width:${width}%;${dir === "up" ? "left:0" : "right:0"}"></span></div></td>` +
        `</tr>` +
        (s.note ? `<tr><td colspan="4" class="note" style="padding-top:0">${esc(s.note)}</td></tr>` : "")
      );
    })
    .join("");

  // --- does the column add up, as printed ---
  //
  // The engine already checks that the bridge closes, but it checks the unrounded figures. What a
  // reader does is add the numbers on the screen, and each of those is money rounded to the cent.
  // On the legal workload the column reads 18.00, −12.90, 5.10, +4.50, −0.39, −4.42, +0.00 and the
  // total reads 4.80, while the rows visibly sum to 4.79. The prose beside the table said "the steps
  // sum to the whole gap", which is true of the arithmetic and false of the page. A reader who adds
  // a column and gets a different answer than the total has caught the report lying about the one
  // thing it exists to get right, and the fix is to say the difference out loud rather than to round
  // the total into agreement.
  // Only the rows that are *changes* are addends. The bold "own assumptions cost" row is the running
  // subtotal of the two rows above it, and the first attempt at this counted it as a third one,
  // which made the printed column appear to sum to 9.89 - a number that is the sum of nothing.
  const showArith =
    ledger.arithmetic_gap_usd !== null && Math.abs(ledger.arithmetic_gap_usd) > 0.005;
  const changes = [
    ...(showArith ? [-ledger.arithmetic_gap_usd] : []),
    ...ledger.steps.map((s) => -(s.saving_usd ?? 0)),
  ];
  const rounded = (n) => Math.round(n * 100) / 100;
  // Stated plus every change, each rounded the way the row prints it, against the printed total.
  const asPrinted = rounded(ledger.stated_estimate_usd + changes.reduce((a, n) => a + rounded(n), 0));
  const offByCents = Math.round((asPrinted - rounded(ledger.measured_usd)) * 100);

  const reconciliation = !ledger.reconciles
    ? `<div class="flag bad">These steps do not close. They sum to ${usd(ledger.step_sum_usd)} against ` +
      `a modelling gap of ${usd(ledger.modelling_gap_usd)}, so the decomposition is wrong rather than ` +
      `merely imprecise, and every per-step figure above is suspect.</div>`
    : offByCents !== 0
      ? `<p class="hint" style="margin-top:10px">The buyer's stated estimate plus every change below ` +
        `it comes to ${usd(asPrinted)} against the ${usd(ledger.measured_usd)} on the total row, ` +
        `because each row is rounded to the cent on its own. The bridge closes to ` +
        `${usd(ledger.measured_usd, 4)} before that rounding. The bold line is a running subtotal, ` +
        `not another amount to add.</p>`
      : "";

  const unexercised = ledger.unexercised?.length
    ? `<h3 style="margin-top:22px">Mechanics this route never exercised</h3>` +
      `<p class="hint">Absent rather than zero. A row reading $0.00 beside a mechanic that never ran ` +
      `looks like a saving nobody took; these are mechanics that were never available here.</p>` +
      `<ul class="tight">` +
      ledger.unexercised.map((u) => `<li><strong>${esc(u.mechanic)}</strong>: ${esc(u.why)}</li>`).join("") +
      `</ul>`
    : "";

  return `
    <p class="sub">Each row changes one thing about the buyer's own assumptions and reprices the whole bill.
    The dollar figure is what that mechanic was worth <em>given everything changed above it</em>, so the steps
    sum to the gap between the buyer's own assumptions and the measurement, not to the column total.
    Negative means the correction made the bill cheaper.</p>
    ${chart}
    <div class="tablewrap">
    <table class="wf">
      <thead><tr><th>Step</th><th>Tokens per call</th><th class="r">Effect on the bill</th><th></th></tr></thead>
      <tbody>
        <tr><td>Buyer's stated estimate</td><td></td><td class="r num">${usd(ledger.stated_estimate_usd)}</td><td></td></tr>
        ${
          showArith
            ? `<tr><td colspan="2" class="note">does not follow from their own assumptions, before anything was measured</td>` +
              `<td class="r num">${usd(-ledger.arithmetic_gap_usd)}</td><td></td></tr>`
            : ""
        }
        <tr><td><strong>Buyer's own assumptions cost</strong></td><td></td><td class="r num"><strong>${usd(ledger.own_assumptions_usd)}</strong></td><td></td></tr>
        ${rows}
        <tr class="total"><td>Measured</td><td></td><td class="r num">${usd(ledger.measured_usd)}</td><td></td></tr>
      </tbody>
    </table>
    </div>
    ${reconciliation}
    <p class="hint" style="margin-top:14px">${esc(ledger.order_note)}</p>
    ${unexercised}
  `;
}

/**
 * The buyer's current model, held against the buyer's own quality bar.
 *
 * This is worth a callout rather than a cell because it inverts the question the rest of the page
 * is asking. Every other section explains what the workload costs; this one says the model already
 * in production does not clear the bar its owner set for it, which makes the cost of switching a
 * different conversation. It is derived from the gate output rather than asserted, and it stays
 * silent when the incumbent passes, so it cannot become decoration.
 */
function renderIncumbentGate(model) {
  const incumbent = model.candidates.find((c) => c.incumbent);
  const q = incumbent?.quality;
  if (!q || !q.verdict || String(q.verdict).toUpperCase() === "PASS") return "";

  const bar = model.workload.quality_bar ?? {};
  const reasons = q.fail_reasons?.length
    ? `<ul class="tight">${q.fail_reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>`
    : "";

  const maxFab = bar.max_hallucinations ?? 0;
  // Correct out of what was answered. This sentence and the fail_reasons list printed directly
  // below it were counting from different denominators, so the callout contradicted itself in its
  // own two lines: "12 of 14 correct" over a bullet reading "quality 86% (12/14 correct)" is
  // consistent, but the same pair on a candidate with failed calls is not, and one of them is wrong.
  const answered = q.not_served
    ? `${q.correct} of the ${q.scored} calls that answered (${q.not_served} of ${q.total} calls failed ` +
      `and were never scored, which is not the same as answering wrongly)`
    : `${q.correct} of ${q.scored} correct`;

  return `
    <div class="flag bad">
      <strong>${esc(incumbent.name)}, the model this workload runs on today, fails the buyer's own quality bar.</strong>
      <div class="sub" style="margin:4px 0 0">
        The bar asks for ${Math.round((bar.min_correct_share ?? 0) * 100)}% correct and at most
        ${esc(maxFab)} fabricated ${maxFab === 1 ? "answer" : "answers"}. Measured: ${esc(answered)},
        ${q.hallucination_count} fabricated.
      </div>
      ${reasons}
      <div class="sub" style="margin-top:6px">Cost is not the only thing this workload is getting wrong, and
      it is not the first thing. A cheaper route that also fails the bar saves money on answers nobody can use.</div>
    </div>
  `;
}

function renderCandidates(model, workloadIndex) {
  const rows = model.candidates
    .map((c, i) => {
      const q = c.quality;
      const verdict = q?.verdict
        ? `<span class="pill ${esc(String(q.verdict).toLowerCase())}">${esc(q.verdict)}</span>`
        : `<span class="pill unknown">not measured</span>`;

      // Correct out of what was ANSWERED, not out of what was asked. A call that came back as
      // HTTP 429 was never a wrong answer, and dividing by the run count printed "6/14 correct" for
      // a candidate that answered six of the nine questions it was served. The two numbers are both
      // on the row now, in separate columns, so neither has to stand for the other.
      const qualityCell = q
        ? `<span class="num">${q.correct ?? "?"}/${q.scored ?? "?"}</span> correct` +
          (q.not_served
            ? `<div class="hint">${q.scored} of ${q.total} calls answered</div>`
            : "") +
          (q.hallucination_count
            ? `<div class="hint" style="color:var(--bad)">${q.hallucination_count} fabricated</div>`
            : `<div class="hint">0 fabricated</div>`)
        : `<span class="hint">no measured run</span>`;

      const served = renderServed(q);

      const latency = q?.latency_ms
        ? `<span class="num">${Math.round(q.latency_ms.p50).toLocaleString()}</span> / <span class="num">${Math.round(
            q.latency_ms.p95
          ).toLocaleString()}</span> ms`
        : `<span class="hint">n/a</span>`;

      const listInput = c.pricing.input_per_m === null ? "n/a" : rateUsd(c.pricing.input_per_m);
      const effRate = c.effective_input_per_m != null ? rateUsd(c.effective_input_per_m) : "n/a";

      // The reason a candidate fails, on that candidate's own row. It was rendered only inside the
      // incumbent's callout, so the two candidates that fail hardest carried a FAIL pill and no
      // explanation anywhere on the page, and a reader had to open the JSON to find out why.
      const why = q?.fail_reasons?.length
        ? `<tr data-why="${i}"><td colspan="7" class="note" style="padding-top:0">` +
          `<span class="hint">Fails because: </span>` +
          q.fail_reasons.map(esc).join(`<span class="hint"> · </span>`) +
          `</td></tr>`
        : "";

      return (
        `<tr data-row="${i}">` +
        `<td><strong>${esc(c.name)}</strong>${
          c.incumbent ? ` <span class="lock measured">current</span>` : ""
        }<div class="hint">${esc(c.source)}${c.provider ? ` · ${esc(c.provider)}` : ""} · route ${esc(
          c.route
        )}</div>${
          c.why_in_shortlist ? `<div class="hint why">${esc(c.why_in_shortlist)}</div>` : ""
        }</td>` +
        `<td>${verdict}<div>${qualityCell}</div></td>` +
        `<td>${served}</td>` +
        `<td class="r">${latency}</td>` +
        `<td class="r num">${listInput}<div class="hint">effective ${effRate}</div></td>` +
        `<td class="r num" data-cell="per_call">–</td>` +
        `<td class="r num" data-cell="monthly">–</td>` +
        `</tr>` +
        why
      );
    })
    .join("");

  // The spread is derived from the shortlist rather than asserted, and it is the honest answer to
  // "why these models": the shortlist spans the price range on purpose, so the reader can see
  // whether the cheapest candidate clears the same bar as the dearest one.
  const rates = model.candidates.map((c) => c.pricing?.input_per_m).filter((n) => typeof n === "number");
  const lo = rates.length ? Math.min(...rates) : null;
  const hi = rates.length ? Math.max(...rates) : null;
  const spread = lo && hi && lo > 0 && hi > lo ? Math.round(hi / lo) : null;

  // The threshold line on the scatter chart below. Fixed at build time because the bar is measured,
  // not a reader input: it never moves when the panel above does. The y-axis itself runs a fixed
  // 70-100%, which comfortably holds every score this benchmark has produced so far; a workload
  // whose bar or whose candidates' scores fall outside that band would need this range widened.
  const bar = model.workload?.quality_bar ?? {};
  const barShare = bar.min_correct_share;
  const barY = barShare != null ? 30 + ((1 - barShare) / 0.3) * 300 : null;
  const barLabel =
    barShare != null
      ? `${Math.round(barShare * 100)}% floor` +
        (bar.max_hallucinations != null ? ` (and ${bar.max_hallucinations} fabricated answers allowed)` : "")
      : null;

  return `
    <p class="sub"><strong>The shortlist is an input, not a finding.</strong> These are the models the
    buyer named, spanning ${rateUsd(lo)} to ${rateUsd(hi)} per 1M input tokens${
      spread ? ` — about a ${spread}x spread` : ""
    } across both procurement routes, out of ${esc(String(model.catalogue?.openrouter_models ?? "the"))}
    text models in the catalogue. The job is to test whether the cheap one clears the bar, not to rank
    the market, and the reason each candidate is here is printed on its own row.</p>
    <p class="sub">Quality and latency are locked: they were measured against a golden set at a timestamp and
    cannot be recomputed in a browser. Cost per call and per month respond to the panel at the top of
    the page.</p>
    ${renderIncumbentGate(model)}
    <svg class="chart" id="sc-svg-${workloadIndex}" viewBox="0 0 860 380" role="img"
      aria-label="Scatter chart of monthly cost against measured accuracy for each candidate; marker size shows p95 latency">
      <line class="ax-grid" x1="70" y1="30" x2="830" y2="30"/>
      <line class="ax-grid" x1="70" y1="130" x2="830" y2="130"/>
      <line class="ax-grid" x1="70" y1="230" x2="830" y2="230"/>
      <line class="ax-line" x1="70" y1="330" x2="830" y2="330"/>
      <text class="ax-label" x="60" y="34" text-anchor="end">100%</text>
      <text class="ax-label" x="60" y="134" text-anchor="end">90%</text>
      <text class="ax-label" x="60" y="234" text-anchor="end">80%</text>
      <text class="ax-label" x="60" y="334" text-anchor="end">70%</text>
      <text class="ax-label" x="26" y="180" text-anchor="middle" transform="rotate(-90 26 180)">Accuracy</text>
      <g id="sc-grid-x-${workloadIndex}"></g>
      <line class="ax-line" x1="70" y1="330" x2="830" y2="330"/>
      <text class="ax-label" x="450" y="368" text-anchor="middle" id="sc-axis-title-${workloadIndex}">Monthly cost (log scale)</text>
      ${
        barY != null
          ? `<line class="thresh-line" x1="70" y1="${barY}" x2="830" y2="${barY}"/>
      <text class="thresh-label" x="826" y="${barY - 7}" text-anchor="end">${esc(barLabel)}</text>`
          : ""
      }
      <g id="sc-points-${workloadIndex}"></g>
      <g id="sc-labels-${workloadIndex}"></g>
      <g id="sc-callout-${workloadIndex}"></g>
    </svg>
    <div class="chart-legend">
      <div class="item"><svg width="14" height="14"><circle class="mk-pass" cx="7" cy="7" r="6"/></svg> Clears the quality gate</div>
      <div class="item"><svg width="14" height="14"><rect class="mk-fail" x="3" y="3" width="8" height="8" transform="rotate(45 7 7)"/></svg> Fails the quality gate</div>
      <span class="sub" style="margin:0">Marker size: p95 latency</span>
    </div>
    <div class="tablewrap">
    <table>
      <thead><tr>
        <th>Candidate</th><th>Quality gate</th><th>Served</th><th class="r">p50 / p95</th>
        <th class="r">$ per 1M in</th><th class="r">Per call</th><th class="r">Monthly</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
    <p class="hint" style="margin-top:12px">"Effective" is the blended input rate after caching, computed from
    the measured profile. It is printed beside the list price because the two columns rank candidates
    differently, and the list price is the one nobody pays.</p>
    ${renderByKind(model)}
  `;
}

/**
 * How many calls the route actually served, and what the rest were.
 *
 * A rate limit and a billing wall are different problems for the buyer and the report names which
 * one it was. This is the column that turns "fails the bar" into a decision: a candidate that fails
 * on quality is not a candidate, and a candidate that fails on transport might be a candidate with
 * a retry policy.
 */
function renderServed(q) {
  if (!q?.total) return `<span class="hint">n/a</span>`;
  const served = q.scored ?? 0;
  const failed = q.total - served;
  if (failed <= 0) return `<span class="num">${q.total}/${q.total}</span><div class="hint">no failures</div>`;

  // "unknown" means the error text carried no status code at all, and saying "HTTP unknown" would
  // be a worse lie than admitting the shape of the failure was not recorded.
  const codes = Object.entries(q.error_kinds ?? {})
    .map(([code, n]) => (code === "unknown" ? `${n} unclassified` : `HTTP ${code} x${n}`))
    .join(", ");

  return (
    `<span class="num" style="color:var(--bad)">${served}/${q.total}</span>` +
    `<div class="hint" style="color:var(--bad)">${failed} failed${codes ? `: ${esc(codes)}` : ""}</div>`
  );
}

/**
 * The same measurement, re-cut by question kind.
 *
 * One accuracy figure per candidate is what every comparison site prints, and it hides the only
 * thing that decides the purchase: which questions the candidates separate on. On this workload
 * every candidate answers every stated-fact question correctly, so the entire gap between the model
 * that fails the bar and the model that passes sits in four multi-hop questions. A reader whose
 * workload is simple extraction and a reader whose workload needs two clauses combined are being
 * asked to make opposite decisions from the same single number.
 *
 * The claim in the intro sentence is derived from the table below it, never asserted. If a fact
 * question ever starts separating the candidates, the sentence changes or disappears with it.
 */
function renderByKind(model) {
  const measured = model.candidates.filter((c) => c.quality?.by_kind?.length);
  if (!measured.length) return "";

  // Kinds in the order the data already carries (fact, multi_hop, absent, then anything else). The
  // union across candidates, so a kind measured for one candidate is still a column for all of them.
  const order = [];
  for (const c of measured) {
    for (const b of c.quality.by_kind) if (!order.includes(b.kind)) order.push(b.kind);
  }

  const labels = model.workload.question_kinds ?? {};
  const label = (kind) => labels[kind] ?? kind;

  // The catalogue names models "OpenAI: GPT-4o mini". Inside a sentence, "it is what fails OpenAI:
  // GPT-4o mini" reads like the company failed the bar. The table keeps the full catalogue name;
  // prose uses the model.
  const shortName = (name) => String(name).includes(": ") ? String(name).split(": ").slice(1).join(": ") : String(name);

  const head = order.map((k) => `<th class="r">${esc(label(k))}</th>`).join("");
  const body = measured
    .map((c) => {
      const cells = order
        .map((k) => {
          const b = c.quality.by_kind.find((x) => x.kind === k);
          if (!b) return `<td class="r hint">not asked</td>`;
          // Two different problems, in the two colours the page already uses for them. Red is a wrong
          // answer and it is a quality failure. Amber is a question that was never served, which is a
          // transport failure, and colouring it red would fold "the route broke" into "the model was
          // wrong" one last time, in the last place a reader looks.
          const wrong = b.incorrect > 0 || b.fabricated > 0;
          const gap = !wrong && b.not_served > 0;
          const tone = wrong ? "var(--bad)" : gap ? "var(--assumed)" : "";
          return (
            `<td class="r"><span class="num"${tone ? ` style="color:${tone}"` : ""}>${b.correct}/${b.scored}</span>` +
            (b.not_served
              ? `<div class="hint"${gap ? ` style="color:var(--assumed)"` : ""}>${b.not_served} of ${b.asked} unanswered</div>`
              : "") +
            (b.fabricated
              ? `<div class="hint" style="color:var(--bad)">${b.fabricated} fabricated</div>`
              : "") +
            `</td>`
          );
        })
        .join("");
      return `<tr><td>${esc(c.name)}${c.incumbent ? ` <span class="lock measured">current</span>` : ""}</td>${cells}</tr>`;
    })
    .join("");

  // Which kinds actually separate the candidates, derived rather than claimed.
  //
  // Separating means somebody got one WRONG. Not "somebody scored below 100%": a kind where half the
  // calls were never served is a coverage hole, not a wrong answer, and treating the two alike made
  // this sentence read "the candidates differ on all three kinds" — true of the cells, useless to a
  // buyer, and it buried the finding, which is that nobody got a stated-fact question wrong at all.
  const wrongFor = (c, k) => {
    const b = c.quality.by_kind.find((x) => x.kind === k);
    return b ? b.incorrect > 0 || b.fabricated > 0 : false;
  };
  const separating = order.filter((k) => measured.some((c) => wrongFor(c, k)));
  const clean = order.filter((k) => !separating.includes(k));
  const quote = (list) => list.map((k) => `&ldquo;${esc(label(k))}&rdquo;`).join(", ");
  const list = (list) => list.map((k) => esc(label(k))).join(", ");

  // The half-answered columns, named separately. A clean record that rests on five served calls out
  // of ten is a weaker claim than the same record over the whole set, and the page should say which
  // one it is holding rather than let the two render identically.
  const partial = [];
  for (const c of measured) {
    for (const b of c.quality.by_kind) {
      if (b.not_served > 0)
        partial.push(
          `${esc(shortName(c.name))}: ${b.not_served} of ${b.asked} ${esc(label(b.kind))} questions were never served`
        );
    }
  }

  // Who the bar actually rejected. Named from the verdicts, not narrated, so the sentence cannot
  // start claiming a candidate failed on a kind it passed.
  const rejected = measured
    .filter((c) => String(c.quality.verdict ?? "").toUpperCase() === "FAIL")
    .filter((c) => separating.some((k) => wrongFor(c, k)))
    .map((c) => esc(shortName(c.name)));

  const finding =
    `<p class="sub" style="margin-top:12px">` +
    (separating.length
      ? (clean.length
          ? `No candidate answered a ${list(clean)} question wrongly. Every difference the quality bar ` +
            `actually found is in ${quote(separating)}` +
            (rejected.length ? `, and it is what fails ${rejected.join(" and ")}` : "") +
            `. A workload made only of the first kind has no measured reason to prefer the more expensive ` +
            `candidate.`
          : `Every question kind separates these candidates: on each one, some candidate got a question ` +
            `wrong, in ${quote(separating)}.`) +
        ` A low score on a kind is a failure to weigh against that candidate's price; a perfect score on a ` +
        `kind everyone passes is not a reason to buy it.`
      : `No candidate got a question wrong at any kind, so the quality measurement does not separate these ` +
        `candidates and the price columns are the whole decision.`) +
    (partial.length
      ? ` One caveat on the table above: ${partial.join("; ")}. A column built on those calls is partial, ` +
        `not clean, and it is the price of the failures in the Served column.`
      : "") +
    `</p>`;

  return `
    <h3 style="margin-top:28px">The same measurement, cut by question kind</h3>
    <p class="sub">One accuracy figure per candidate hides which questions the candidates separate on. This is
    the same run, re-cut: how many of each kind of question each candidate answered correctly, over the calls
    that were served. A question that was never answered is named under the cell rather than counted as a
    wrong answer.</p>
    <div class="tablewrap">
    <table>
      <thead><tr><th>Candidate</th>${head}</tr></thead>
      <tbody>${body}</tbody>
    </table>
    </div>
    ${finding}
  `;
}

/**
 * The image workload's candidate section: the pictures themselves, and three numbers under each.
 *
 * Two deliberate differences from the text table. There is no quality column, because image quality
 * has no correct-share to compute and printing "0/0" would be a claim about a check that never ran.
 * And every number is per run, not aggregated across them, because on this workload the variation
 * between two runs of the same prompt IS the finding: the same model returned the same picture in
 * 585ms and 2,813ms, a 4.8x spread, and a median would hide that rather than report it.
 */
function renderImageCandidates(model) {
  const ceiling = model.workload.latency_ceiling_ms;

  const galleries = model.candidates
    .map((c) => {
      const summary = c.image_summary;
      const shots = (c.images ?? [])
        .map((img) => {
          if (img.error) {
            // A run that produced no picture is shown as a missing one rather than as an empty
            // frame. The alternative is a captionless card that reads as a picture that failed to
            // load, which is the browser's problem rather than the model's.
            return (
              `<figure class="shot missing">` +
              `<div class="shot-empty">no image returned</div>` +
              `<figcaption><div class="hint">${esc(img.run)}: ${esc(img.error)}</div></figcaption>` +
              `</figure>`
            );
          }
          return (
            `<figure class="shot">` +
            // The data URI is escaped like every other attribute even though base64 cannot contain a
            // quote, because the mime type in front of it is not base64 and this is the one place a
            // reader could otherwise inject markup through a file name.
            `<img src="${esc(img.data_uri)}" alt="The image ${esc(c.name)} returned on ${esc(img.run)}">` +
            `<figcaption>` +
            `<div class="hint">${esc(img.run)}</div>` +
            `<div class="metrics">` +
            `<span><b class="num">${img.latency_ms == null ? "n/a" : Math.round(img.latency_ms).toLocaleString()}</b> ms</span>` +
            `<span><b class="num">${img.image_tokens == null ? "n/a" : Math.round(img.image_tokens).toLocaleString()}</b> image tokens</span>` +
            `<span><b class="num">${img.cost_usd == null ? "n/a" : usd(img.cost_usd, 6)}</b> billed</span>` +
            `</div>` +
            `</figcaption></figure>`
          );
        })
        .join("");

      const gate = c.gate;
      const verdict = gate?.verdict
        ? `<span class="pill ${esc(String(gate.verdict).toLowerCase())}">${esc(gate.verdict)}</span>`
        : `<span class="pill unknown">not measured</span>`;

      return (
        `<div class="shotgroup">` +
        `<div class="shothead"><strong>${esc(c.name)}</strong>${c.incumbent ? ` <span class="lock measured">current</span>` : ""} ${verdict}` +
        `<div class="hint">${esc(c.source)} · route ${esc(c.route)}${c.provider ? ` · ${esc(c.provider)}` : ""}</div></div>` +
        (shots ? `<div class="shots">${shots}</div>` : `<p class="hint">No runs recorded for this candidate.</p>`) +
        `</div>`
      );
    })
    .join("");

  const rows = model.candidates
    .map((c) => {
      const s = c.image_summary;
      const spread =
        s?.latency_ms?.min != null && s?.latency_ms?.max != null && s.latency_ms.min > 0
          ? `${(s.latency_ms.max / s.latency_ms.min).toFixed(1)}x`
          : "—";
      const over =
        s?.latency_ms?.max != null && ceiling != null && s.latency_ms.max > ceiling
          ? ` <span class="hint" style="color:var(--bad)">over the ceiling</span>`
          : "";

      return (
        `<tr>` +
        `<td><strong>${esc(c.name)}</strong><div class="hint">route ${esc(c.route)}</div></td>` +
        `<td><span class="num">${s ? `${s.succeeded}/${s.runs}` : "n/a"}</span>${
          s?.failed ? `<div class="hint" style="color:var(--bad)">${s.failed} returned no image</div>` : `<div class="hint">every run returned an image</div>`
        }</td>` +
        `<td class="r"><span class="num">${s?.latency_ms?.median == null ? "n/a" : Math.round(s.latency_ms.median).toLocaleString()}</span> ms</td>` +
        `<td class="r"><span class="num">${s?.latency_ms?.min == null ? "n/a" : Math.round(s.latency_ms.min).toLocaleString()}</span> – <span class="num">${
          s?.latency_ms?.max == null ? "n/a" : Math.round(s.latency_ms.max).toLocaleString()
        }</span> ms${over}</td>` +
        `<td class="r"><span class="num">${spread}</span></td>` +
        `<td class="r num">${s?.image_tokens?.length ? s.image_tokens.map((t) => Math.round(t).toLocaleString()).join(" / ") : "n/a"}</td>` +
        `<td class="r num">${s?.measured_cost_usd == null ? "n/a" : usd(s.measured_cost_usd)}</td>` +
        `<td class="r"><span class="num">${esc(s?.cost_coverage ?? "n/a")}</span></td>` +
        `</tr>`
      );
    })
    .join("");

  // FLUX: a licence row, not a generation row. The route has no benchmark because there is nothing
  // to benchmark against, and the table says which column was read and which was measured.
  const distribution = model.distribution_rows?.length
    ? `
    <h3 style="margin-top:28px">The open-weight route on this workload, read rather than measured</h3>
    <p class="sub">Neither of these was called. The Hugging Face router catalogue carries 140 models and
    none of them declare an image output, and the BFL routes that would serve FLUX directly are behind an
    account with no credit balance - so there is no route to run and no published rate to quote. What is
    readable is the model card's licence field, and that is what this table reports.</p>
    <div class="tablewrap">
    <table>
      <thead><tr><th>Model</th><th>Route</th><th>Licence field</th><th>What it means commercially</th></tr></thead>
      <tbody>${model.distribution_rows
        .map((d) => {
          // Every field here is optional, and so is the row itself. This table is assembled from a
          // file a human edits, so a stray `null` in the array is a typo rather than a state anyone
          // intended - and reading `.label` off it threw, taking the whole image tab down with it
          // over one bad element. A row that says nothing is the correct rendering of a row that
          // carries nothing.
          const r = d ?? {};
          return (
            `<tr><td><strong>${esc(r.label ?? r.slug ?? "unnamed row")}</strong>` +
            `<div class="hint">${esc(r.slug ?? "")}</div></td>` +
            `<td>${r.route ? `Route ${esc(r.route)}` : '<span class="hint">no route recorded</span>'}</td>` +
            `<td>${licenceCell(r)}<div class="hint">read from the Hub card, not measured</div></td>` +
            `<td>${esc(r.commercial_note) || '<span class="hint">No commercial reading was recorded for this row.</span>'}</td></tr>`
          );
        })
        .join("")}</tbody>
    </table>
    </div>
    <p class="hint" style="margin-top:12px">A licence is the one thing on this page that costs nothing to
    read and cannot be measured. It is still a purchase decision: the permissive row and the restricted row
    are the same weights with different terms, and the terms decide whether the cheaper one is usable at all.</p>
  `
    : "";

  return `
    <p class="sub">There is no quality gate on this workload, and that is a statement about the measurement
    rather than about the models. Image output has no correct-share to compute, so the only machine gate is
    the buyer's own ${ceiling == null ? "latency" : `${esc(ceiling.toLocaleString())}ms latency`} ceiling.
    The pictures are shown so the judgement that the machine cannot make is one a reader can.</p>
    ${galleries}
    <h3 style="margin-top:28px">The same runs, as numbers</h3>
    <div class="tablewrap">
    <table>
      <thead><tr>
        <th>Candidate</th><th>Runs with an image</th><th class="r">Median</th><th class="r">Fastest – slowest</th>
        <th class="r">Spread</th><th class="r">Image tokens per run</th><th class="r">Billed, both runs</th><th class="r">Cost coverage</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
    <p class="hint" style="margin-top:12px">Latency and cost are summed over different sets of runs on
    purpose. A call that returned no picture took some amount of time that was not a generation time, so it
    is left out of the latency figures; it was billed for the tokens it burned getting there, so it is left
    in the cost. Two rules pointing opposite ways, and dropping the failed runs from the cost would
    understate the monthly figure this workload exists to produce.</p>
    ${distribution}
  `;
}

/**
 * The asynchronous route: what the batch card PUBLISHES, and what a batch actually BILLED.
 *
 * This section exists because the two are not the same number and the difference is the product
 * decision. A reader who takes the catalogue's 50% as a rule will price their async workload wrong
 * on the models where the card is not 50%, and wrong in the other direction on the two where going
 * async costs more than staying synchronous.
 *
 * Nothing here is interactive, and that is deliberate: the ratio is a property of two published
 * prices, and the bill is a property of a batch that ran. Neither is the reader's to move, so
 * neither gets an input. The reader's own levers are on the pricing panel above.
 */
function renderBatch(w, model) {
  const batch = w.batch ?? null;
  const rows = w.candidates.filter((c) => c.batch);

  // No batch card on any candidate means there is nothing to compare on this tab. Returning "" is
  // right here and is not the same as hiding a finding: the catalogue-wide distribution is rendered
  // from the same section, so an empty candidate table would still have something under it.
  if (!rows.length && !model.catalogue?.batch) return "";

  const max_tokens = (v) => (v == null ? "n/a" : rateUsd(v));

  const candidateRows = rows
    .map((c) => {
      const b = c.batch;
      const measuredRatio = b.measured_ratio ?? null;

      const ratioCell =
        b.prompt_ratio == null
          ? `<span class="hint">no published rate</span>`
          : `<span class="num">x${b.prompt_ratio.toFixed(4)}</span>` +
            (b.cheaper === false
              ? ` <span class="pill fail">costs more</span>`
              : `<div class="hint">published</div>`);

      return (
        `<tr>` +
        `<td><strong>${esc(c.name)}</strong>` +
        `<div class="hint">${esc(b.batch_slug)}</div></td>` +
        `<td class="r num">${max_tokens(c.pricing.input_per_m)} – ${max_tokens(c.pricing.output_per_m)}</td>` +
        `<td class="r num">${max_tokens(b.batch_input_per_m)} – ${max_tokens(b.batch_output_per_m)}</td>` +
        `<td class="r">${ratioCell}</td>` +
        `<td class="r num">${b.sync_bill_usd == null ? "n/a" : usd(b.sync_bill_usd, 6)}</td>` +
        `<td class="r num">${
          b.measured_bill_usd == null
            ? "n/a"
            : `${usd(b.measured_bill_usd, 6)}<div class="hint">${b.measured_calls ?? "?"} of ${
                w.benchmark?.items ?? "?"
              } calls billed</div>`
        }</td>` +
        `<td class="r">${
          measuredRatio == null
            ? `<span class="hint">not measured</span>`
            : `<span class="num">x${measuredRatio.toFixed(4)}</span><div class="hint">measured</div>`
        }</td>` +
        `<td class="r num">${b.submit_to_terminal_ms == null ? "—" : `${(b.submit_to_terminal_ms / 3600000).toFixed(2)} h`}</td>` +
        `</tr>`
      );
    })
    .join("");

  // The allocated per-call figures, in their own table, because they are the one number here that
  // nobody measured. A batch result carries `usage` with no `cost` field, so there is no per-call
  // price to report and dividing the batch total is arithmetic rather than observation. It is
  // useful for pricing a monthly volume and it must not sit in the same column as a measured bill.
  const allocationRows = rows
    .filter((c) => c.batch.allocated_cost_per_call != null)
    .map((c) => {
      const b = c.batch;
      return (
        `<tr>` +
        `<td><strong>${esc(c.name)}</strong></td>` +
        `<td class="r num">${usd(b.measured_bill_usd, 6)}</td>` +
        `<td class="r num">${b.measured_calls ?? "?"}</td>` +
        `<td class="r num">${usd(b.allocated_cost_per_call, 6)}</td>` +
        `<td class="r num">${b.measured_monthly_usd == null ? "n/a" : usd(b.measured_monthly_usd)}</td>` +
        `<td class="hint">${esc(b.cost_source ?? "")}</td>` +
        `</tr>`
      );
    })
    .join("");

  // The catalogue-wide distribution. Counted against the claim OpenRouter's own announcement makes,
  // by the same function the batch scan uses, so the page and the console cannot disagree.
  const dist = model.catalogue?.batch ?? null;
  const outliers = (dist?.rows ?? []).filter((r) => r.prompt_ratio !== dist.typical);

  const distributionTable = dist
    ? `
    <h3 style="margin-top:28px">Across the whole catalogue, the discount is a typical case</h3>
    <p class="sub">OpenRouter's announcement says batch requests "generally charge 50% (and sometimes
    less) of their normal per-token price", and that is accurate as a description of the usual case.
    It is not a rule, and a buyer pricing an async workload against it will be wrong on
    ${outliers.length} of the ${dist.rated} cards that carry a rate on both sides.</p>
    <div class="tablewrap">
    <table>
      <thead><tr><th>Batch card against its standard card</th><th class="r">Cards</th><th class="r">Share</th></tr></thead>
      <tbody>
        <tr><td>Exactly ${dist.typical}x — the announced case</td><td class="r num">${dist.at_typical}</td><td class="r num">${pct(dist.at_typical, dist.rated)}</td></tr>
        <tr><td>Cheaper than ${dist.typical}x</td><td class="r num">${dist.cheaper_than_typical}</td><td class="r num">${pct(dist.cheaper_than_typical, dist.rated)}</td></tr>
        <tr><td>Dearer than ${dist.typical}x, still a discount</td><td class="r num">${dist.dearer_than_typical - dist.costs_more_than_sync}</td><td class="r num">${pct(dist.dearer_than_typical - dist.costs_more_than_sync, dist.rated)}</td></tr>
        <tr><td><strong>More than the standard card</strong> — going async costs more</td><td class="r num"><strong>${dist.costs_more_than_sync}</strong></td><td class="r num">${pct(dist.costs_more_than_sync, dist.rated)}</td></tr>
      </tbody>
    </table>
    </div>
    <div class="tablewrap" style="margin-top:16px">
    <table>
      <thead><tr><th>The ${outliers.length} that are not ${dist.typical}x</th><th class="r">Prompt</th><th class="r">Completion</th><th>What it means</th></tr></thead>
      <tbody>${outliers
        .map(
          (r) =>
            `<tr><td><strong>${esc(r.slug)}</strong>${
              r.tiered ? `<div class="hint">tiered rates above a prompt threshold</div>` : ""
            }</td>` +
            `<td class="r num">x${r.prompt_ratio.toFixed(4)}</td>` +
            `<td class="r num">${r.completion_ratio == null ? "n/a" : `x${r.completion_ratio.toFixed(4)}`}</td>` +
            `<td>${
              r.prompt_ratio > 1
                ? `<span style="color:var(--bad)">Batch costs more than the standard card on this model.</span>`
                : r.prompt_ratio < dist.typical
                  ? `A deeper discount than the announcement describes.`
                  : `A shallower discount than the announcement describes.`
            }</td></tr>`
        )
        .join("")}</tbody>
    </table>
    </div>
    <p class="hint" style="margin-top:12px">Read from the catalogue at
    ${esc(model.catalogue_fetched_at ?? "an unrecorded time")}, at no cost: every
    <code>:batch</code> entry is a full model entry with its own pricing, so the comparison needs no
    submission. It is a price list, not a bill — the two columns above are labelled accordingly.</p>
    `
    : "";

  const skipped = (batch?.skipped ?? []).length
    ? `<h3 style="margin-top:28px">Candidates the asynchronous leg could not run</h3>
    <div class="tablewrap">
    <table>
      <thead><tr><th>Candidate</th><th>Why</th></tr></thead>
      <tbody>${(batch.skipped ?? [])
        .map((s) => {
          // The runner writes `{candidate, reason}`; the slug is the identity. Read defensively
          // because this array is assembled from a run file that may be older than the field.
          const slug = s?.candidate ?? s?.slug ?? null;
          return `<tr><td><strong>${esc(slug ?? "unnamed candidate")}</strong></td><td>${esc(s?.reason ?? "no reason recorded")}</td></tr>`;
        })
        .join("")}</tbody>
    </table>
    </div>
    <p class="hint" style="margin-top:12px">A model with no <code>:batch</code> entry in the catalogue
    cannot be run asynchronously at all. The leg names them rather than leaving a silent gap in the
    table above, because a missing row reads as an oversight and this is a fact about the catalogue.</p>`
    : "";

  const measuredCount = rows.filter((c) => c.batch.measured_bill_usd != null).length;

  return `
    <p class="sub">The Batch API is asynchronous and text-only, one provider per batch chosen at
    submission with no fallback, and it returns no per-request latency. What it does return is
    <code>usage.cost</code> for the whole batch — so this route can be priced in two independent
    ways, and this section keeps them apart. The <em>published</em> columns are what the catalogue
    lists for the <code>:batch</code> card. The <em>measured</em> columns are what the calls were
    really charged: the synchronous bill from the sum of that run's per-call costs, the batch bill
    from the batch's own <code>usage.cost</code>. ${
      measuredCount
        ? `${measuredCount} of these candidates were bought as a batch on this workload.`
        : `No batch was bought on this workload, so the measured columns are empty rather than estimated.`
    }</p>
    ${
      rows.length
        ? `<div class="tablewrap">
    <table>
      <thead><tr>
        <th>Candidate</th><th class="r">Standard card, per M in – out</th><th class="r">Batch card, per M in – out</th>
        <th class="r">Published ratio</th><th class="r">Sync bill, measured</th><th class="r">Batch bill, measured</th>
        <th class="r">Measured ratio</th><th class="r">Submit → done</th>
      </tr></thead>
      <tbody>${candidateRows}</tbody>
    </table>
    </div>
    <p class="hint" style="margin-top:12px">The two ratios answer different questions and neither
    substitutes for the other. The published ratio compares two rate cards and is true of every
    workload. The measured ratio compares two <em>bills</em> for these ${esc(w.benchmark?.items ?? "?")}
    questions and is true of this one — a model can publish 50% and settle somewhere else entirely,
    because caching, tiers and reasoning tokens are not uniformly discounted. OpenRouter's own docs
    say so about non-token components; this table is what it looks like when it happens.</p>
    ${
      allocationRows
        ? `<h3 style="margin-top:28px">Pricing a monthly volume off the batch bill</h3>
    <p class="sub">The batch API reports one cost for the batch and none per request, so there is no
    per-call price to measure. The figures below are the batch bill <em>divided</em> by the calls it
    completed — arithmetic, not observation — and they are in their own table for that reason. They
    are what a monthly commitment would be priced from; they are not a per-call measurement, and
    nothing here should be quoted as one.</p>
    <div class="tablewrap">
    <table>
      <thead><tr>
        <th>Candidate</th><th class="r">Batch bill, measured</th><th class="r">Calls billed</th>
        <th class="r">Allocated, per call</th><th class="r">Allocated, at your volume</th><th>Source</th>
      </tr></thead>
      <tbody>${allocationRows}</tbody>
    </table>
    </div>`
        : ""
    }`
        : `<p class="hint">None of this workload's candidates has a <code>:batch</code> entry in the
    catalogue, so there is no asynchronous rate to compare.</p>`
    }
    ${
      batch?.declared && !batch?.run_at
        ? `<p class="hint" style="margin-top:12px">This workload declares a batch leg and no collected
    batch run was found, so the measured columns are empty. The declaration is not evidence that
    anything ran.</p>`
        : ""
    }
    ${skipped}
    ${distributionTable}
  `;
}

/** Share, as a percentage string. Null-safe in the way the tables need: no denominator, no claim. */
function pct(n, d) {
  if (!d) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

function renderRoutes(routes) {
  if (!routes?.length) return "";
  const rows = routes
    .map((r) => {
      // A quoted price and an estimate must never render the same way. Route C's figure carries the
      // word "estimate" inside the cell, not in a footnote, because the cell is what gets copied
      // out of the page.
      const est = r.estimate ?? r;
      // A candidate with no measured profile has no monthly figure. The blank is filled with the
      // reason rather than with the buyer's assumed token counts, because that assumption priced as
      // though it were an observation is the exact failure this project reports on.
      // Route D's monthly_cost is real, same as A and B, but the number that actually makes the
      // row worth reading is the ratio against the cheapest token-based route - without this hint
      // that ratio sits in est.comparison_ratio and is never shown anywhere on the page.
      const seatHint =
        r.route === "D" && est?.comparison_ratio != null
          ? `<div class="hint" style="color:var(--assumed)">${
              est.comparison_ratio >= 1
                ? `${est.comparison_ratio.toFixed(1)}x the cost of`
                : `${(1 / est.comparison_ratio).toFixed(1)}x cheaper than`
            } the cheapest measured token-based route on this workload</div>`
          : "";
      const cost =
        r.monthly_cost != null
          ? `<span class="num">${usd(r.monthly_cost)}</span>${seatHint}`
          : est?.estimate_low_usd != null
            ? `<span class="num">${usd(est.estimate_low_usd)}</span>` +
              `<div class="hint">to ${usd(est.estimate_dedicated_usd)} if the instance is held up all month</div>` +
              `<div class="hint" style="color:var(--assumed)">estimate, not a price</div>`
            : `<span class="hint">not priced</span><div class="hint">no measured profile on this route</div>`;

      const lists = (items, cls) =>
        items?.length
          ? `<ul class="tight">${items.map((i) => `<li class="${cls}">${esc(i)}</li>`).join("")}</ul>`
          : "";

      // The platform line is what tells two rows sharing a model and a route apart. Two offers of
      // the same weights through two aggregators are two different purchases, and only this line
      // says so.
      const platform = [r.platform, r.provider].filter(Boolean).map(esc).join(" · ");

      return (
        `<tr><td><strong>Route ${esc(r.route)}</strong><div class="hint">${esc(r.route_label)}</div>` +
        `<div class="hint">${esc(r.cost_kind ?? "")}</div></td>` +
        `<td>${esc(r.model ?? "—")}${platform ? `<div class="hint">${platform}</div>` : ""}</td>` +
        `<td class="r">${cost}</td>` +
        `<td>${lists(r.pros, "")}${lists(r.cons, "hint")}</td></tr>`
      );
    })
    .join("");

  return `
    <div class="tablewrap">
    <table>
      <thead><tr><th>Route</th><th>Candidate</th><th class="r">Monthly</th><th>What price does not say</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    </div>
    <p class="hint" style="margin-top:12px">The monthly figures for routes A and B price each candidate's own
    <em>measured</em> token profile at this workload's stated volume, and they are fixed. They are not the
    candidates table above, which moves with your inputs; where the two differ, they are pricing different
    configurations and both are right.</p>
  `;
}

// ---------------------------------------------------------------------------
// the page's own orientation layer
// ---------------------------------------------------------------------------
//
// The report is dense on purpose: every figure is either a measurement or a labelled assumption.
// What it did not have was a way in. These renderers are the first screen - what the page is, how
// to use it, what vocabulary it assumes, and what it is resting on. A reader who is not the
// analyst who built it decides in that first screen whether the artifact is for them, and a page
// that opens on a catalogue fetch timestamp answers a question nobody asked first.

/** The three steps and the legend, once, above the tabs. */
function renderHowTo(workloads, multi) {
  const names = workloads.map((w) => esc(w.workload.name));
  const pick = multi
    ? `Use the tabs: ${names.slice(0, -1).join(", ")} or ${names[names.length - 1]}.`
    : `There is one workload on this page: ${names[0]}.`;

  // Only present when a tab actually has a seat comparison, so a page with none of them renders
  // the same legend it always has.
  const hasRouteD = workloads.some((w) => w.routes?.some((r) => r.route === "D"));

  return `
  <div class="card howto">
    <h3>How to read this page</h3>
    <ol class="steps">
      <li><strong>Pick a workload.</strong> ${pick}</li>
      <li><strong>Read the gap.</strong> Each tab opens with three numbers: what the buyer said the month
        would cost, what their own stated assumptions cost when priced out, and what the calls actually
        cost. The first gap is arithmetic; the second is the measurement.</li>
      <li><strong>Move your own numbers.</strong> Volume, prompt size, answer length and your own estimate
        are yours to change in the panel just below. Every measured figure stays locked and timestamped.</li>
    </ol>
    <div class="legend">
      <span><span class="lock measured">measured</span> produced by a real, billed call at a timestamp. It does not move.</span>
      <span><span class="lock assumed">assumed</span> the buyer's input, or yours. Move it and the answer travels.</span>
      <span><span class="pill pass">PASS</span> <span class="pill fail">FAIL</span> whether a candidate cleared
        the quality bar; <span class="pill unknown">not measured</span> means no usable run.</span>
    </div>
    <p class="hint route-key"><strong>The ${hasRouteD ? "four" : "three"} procurement routes.</strong>
      <b>A</b> closed API model, quoted per token &middot;
      <b>B</b> open weights served by a third party &middot;
      <b>C</b> open weights self-hosted, an estimate from named assumptions and never a price${
        hasRouteD
          ? ` &middot; <b>D</b> a seat-licensed tool, a flat price per seat per month quoted by the vendor`
          : ""
      }.</p>
  </div>`;
}

/** The workload picker. Rendered once; the client script moves the selection. */
function renderTabs(workloads) {
  return `<nav class="tabs" role="tablist" aria-label="Workloads">
${workloads
  .map(
    (w, i) =>
      `    <button type="button" role="tab" id="tab-${i}" data-tab="${i}" aria-controls="panel-${i}" aria-selected="${
        i === 0 ? "true" : "false"
      }" tabindex="${i === 0 ? "0" : "-1"}">${esc(w.workload.name)}<span class="tabsub">${
        w.workload.kind === "image"
          ? `image · ${w.candidates.length} candidates · not machine-scored`
          : `text · ${w.candidates.length} candidates · ${w.benchmark?.items ?? "?"} questions`
      }${w.workload.archetype ? ` · ${esc(w.workload.archetype)} archetype` : ""}</span></button>`
  )
  .join("\n")}
  </nav>`;
}

/**
 * Everything this one workload's numbers rest on, in one place.
 *
 * The assumptions were always on the page, one line each, spread across the caveats, the footprint
 * and the workload file. A reader had to assemble the list themselves. Naming them once, in one
 * box, is what turns "this number is suspicious" into "this number is bounded".
 */
function renderAssumptions(w, model) {
  const wl = w.workload;
  const bar = wl.quality_bar ?? {};
  const buyer = wl.buyer_estimate ?? {};
  const isImage = wl.kind === "image";
  const items = w.benchmark?.items ?? null;
  const bullets = [];

  if (isImage) {
    bullets.push(
      `<strong>One fixed prompt.</strong> <code>${esc(
        wl.prompt ?? "(not recorded)"
      )}</code> is the exact string that was sent and billed. It is the workload, not an example of one. There is no golden set and no machine quality gate here, because whether a picture is any good is a human judgement.`
    );
  } else {
    bullets.push(
      `<strong>Synthetic documents.</strong> The contract and every question are invented for this benchmark, with known correct answers. No client documents, no scraped contracts, no real counterparty names.`
    );
    if (items != null) {
      const share =
        bar.min_correct_share != null ? `${Math.round(bar.min_correct_share * 100)}% correct` : null;
      const fab =
        bar.max_hallucinations != null
          ? `at most ${bar.max_hallucinations} fabricated answer${bar.max_hallucinations === 1 ? "" : "s"}`
          : null;
      const gate = [share, fab].filter(Boolean).join(" and ");
      bullets.push(
        `<strong>A ${items}-question golden set.</strong> Chosen to include deliberate hard cases rather than sampled at random.${gate ? ` The quality bar is ${gate}.` : ""}`
      );
    }
  }

  if (wl.latency_ceiling_ms != null) {
    bullets.push(
      `<strong>A ${Math.round(wl.latency_ceiling_ms).toLocaleString()} ms latency ceiling,</strong> the buyer's own number${
        isImage ? " and the only machine gate on this workload" : ""
      }. Latency is reported against that ceiling, not against a generic target.`
    );
  }

  const volume = wl.monthly_requests != null ? wl.monthly_requests.toLocaleString() : null;
  const inTok =
    buyer.assumed_input_tokens_per_request != null
      ? Number(buyer.assumed_input_tokens_per_request).toLocaleString()
      : null;
  const outTok =
    buyer.assumed_output_tokens_per_request != null
      ? Number(buyer.assumed_output_tokens_per_request).toLocaleString()
      : null;
  const inputs = [
    volume ? `${volume} requests a month` : null,
    inTok && outTok ? `${inTok} prompt tokens and ${outTok} answer tokens per request` : null,
    buyer.assumed_cost_per_month_usd != null ? `${usd(buyer.assumed_cost_per_month_usd)}/month` : null,
  ].filter(Boolean);
  bullets.push(
    `<strong>The buyer's estimate is an input, not a finding.</strong>${
      inputs.length ? ` ${inputs.join(", ")} were stated by the buyer, not measured.` : ""
    } The page's argument is the distance between those inputs and the measurement.`
  );

  if (wl.archetype) {
    const archetype = archetypeFor(wl.archetype);
    bullets.push(
      archetype
        ? `<strong>Scaffolded from the "${esc(archetype.label)}" archetype.</strong> ${esc(
            archetype.description
          )} Its buyer_estimate defaults came from this archetype, not from this buyer - they are a ` +
          `starting guess and should be replaced with the buyer's real numbers before the gap above is trusted.`
        : `<strong>Scaffolded from an archetype named "${esc(
            wl.archetype
          )}".</strong> That archetype is not one core/archetypes.mjs currently defines, so its description ` +
          `cannot be shown here - treat buyer_estimate as an unverified starting guess regardless.`
    );
  }

  bullets.push(
    `<strong>Prices were read at a timestamp.</strong> Catalogue rates were read ${esc(
      model.catalogue_fetched_at ?? "at an unrecorded time"
    )}${
      w.benchmark?.run_at ? `, and the calls behind this tab were made ${esc(w.benchmark.run_at)}` : ""
    }. Re-running the pipeline reproduces the method, not these figures.`
  );

  bullets.push(
    `<strong>Route C is an estimate.</strong> Self-hosting has no published price, so its row is built from named assumptions and is never compared numerically with the two quoted routes.`
  );

  return `
  <section>
    <h2>Assumptions this page rests on</h2>
    <div class="card"><ul class="tight">${bullets.map((b) => `<li>${b}</li>`).join("")}</ul></div>
  </section>`;
}

/**
 * The interactive panel, hoisted above the argument it feeds.
 *
 * This was the last section on the page, after every table and four full-size images. It is the
 * one part a reader can act on and the strongest hook the artifact has: type your own volume and
 * estimate, watch the measured number replace it. Burying it below thirteen thousand pixels of
 * phone scroll was the single biggest reason the page read as a report rather than a tool.
 */
function renderOwnNumbers(workloads, multi, first) {
  return `
  <section>
    <h2>Your own numbers, on <span id="out-panel-name">${esc(first.name)}</span></h2>
    <p class="sub" id="out-panel-sub">Everything measured is fixed and timestamped. Everything here is a guess,
    by definition, so you may as well move it and see how far the answer travels.${
      multi
        ? " This panel follows the tab you picked above; switching tabs re-points it at the other " +
          "workload's own measurements."
        : " There is one workload, so this panel has one configuration."
    }</p>

    <div class="card">
      <div class="panel">
        <div>
          <h3 id="out-panel-left-h">You change this <span class="lock assumed">assumed</span></h3>

          <div class="field">
            <label for="in-volume">Requests per month</label>
            <input id="in-volume" type="number" min="0" step="1000" value="${esc(
              workloads[0].workload.monthly_requests ?? 0
            )}">
            <div class="hint" id="hint-volume"></div>
          </div>

          <div class="field">
            <label for="in-prompt">Prompt tokens per request</label>
            <input id="in-prompt" type="number" min="0" step="100" value="${esc(
              workloads[0].workload.buyer_estimate?.assumed_input_tokens_per_request ?? 1500
            )}">
            <div class="hint" id="hint-prompt"></div>
          </div>

          <div class="field">
            <label for="in-output">Answer tokens per request</label>
            <input id="in-output" type="number" min="0" step="10" value="${esc(
              workloads[0].workload.buyer_estimate?.assumed_output_tokens_per_request ?? 50
            )}">
            <div class="hint" id="hint-output"></div>
          </div>

          <div class="field">
            <label for="in-estimate">Your own monthly estimate</label>
            <input id="in-estimate" type="number" min="0" step="1" value="${esc(
              workloads[0].workload.buyer_estimate?.assumed_cost_per_month_usd ?? ""
            )}">
            <div class="hint">In dollars. This is the number the rest of the page is arguing with.</div>
          </div>
        </div>

        <div>
          <h3>Your numbers, priced at measured rates <span class="lock measured">rates locked</span></h3>
          <div class="verdict">
            <div class="big" id="out-measured">–</div>
            <div class="hint" id="out-measured-sub">per month</div>
            <div class="gap-split" id="out-gap-split">
              <div class="gapbox" id="gapbox-arith">
                <div class="hint">Your estimate, against your own assumptions</div>
                <div class="n" id="out-arith">–</div>
                <div class="hint" id="out-arith-note">a calculator error if this is large</div>
              </div>
              <div class="gapbox" id="gapbox-model">
                <div class="hint">Your assumptions, against the measured cache behaviour</div>
                <div class="n" id="out-model">–</div>
                <div class="hint" id="out-model-note">the only part measuring changes about your numbers</div>
              </div>
            </div>
            <p class="hint" style="margin:12px 0 0" id="out-scope"></p>
          </div>
          <div id="out-notes" style="margin-top:14px"></div>
        </div>
      </div>
    </div>
    <p class="hint" style="margin-top:16px" id="out-waterfall-ref"></p>
  </section>`;
}

/** One tabpanel per workload, with the shared argument sections inside it. */
function renderWorkloadPanels(workloads, model) {
  return workloads
    .map(
      (w, i) =>
        `<div class="tabpanel" id="panel-${i}" role="tabpanel" data-workload="${i}" aria-labelledby="tab-${i}"${
          i === 0 ? "" : " hidden"
        }>
  ${renderHeadline(w)}

  <section>
    <h2>Where the estimate went wrong</h2>
    <p class="sub">The buyer said ${usd(w.workload.buyer_estimate?.assumed_cost_per_month_usd)}/month. Here is
    every named reason that number is not what this workload costs, and what each one is worth.</p>
    ${renderWaterfall(w.ledger, i, w.workload.kind !== "image")}
  </section>

  <section>
    <h2>${w.workload.kind === "image" ? "The candidates, and what they drew" : "Every candidate, at your volume"}</h2>
    ${w.workload.kind === "image" ? renderImageCandidates(w) : renderCandidates(w, i)}
  </section>
${w.workload.kind === "image" ? "" : `
  <section id="batch">
    <h2>The same workload, bought asynchronously</h2>
    ${renderBatch(w, model)}
  </section>`}

  <section>
    <h2>The ${w.routes?.some((r) => r.route === "D") ? "four" : "three"} procurement routes</h2>
    <p class="sub">Route C is an estimate built from named assumptions, not a quoted price, and it is the only
    row in the repository with no monthly cost field. Sorting it beside A and B as though it were one more
    price is the mistake this table exists to prevent.</p>
    ${renderRoutes(w.routes)}
  </section>
${renderAssumptions(w, model)}
  <section>
    <h2>What this tab cannot tell you</h2>
    <div class="card">
      <ul class="tight">
        ${
          w.workload.kind === "image"
            ? `<li><strong>Latency that came back unverified.</strong> Two runs is two runs. The pair above moved
          70x between one day and the next on identical input, and nothing in the response says whether a
          provider cache was involved. Read the cost column as measured and the latency column as observed
          twice.</li>
        <li><strong>An image token count that is deterministic, and a bill that is not.</strong> The picture
          costs the same number of tokens every time; the prompt and reasoning tokens around it move run to
          run, so the total is a narrow band rather than a figure.</li>
        <li><strong>Quality that nobody measured.</strong> The pictures are shown so a reader can judge them.
          That is a different kind of evidence from the text tab's correct-share and it does not transfer to
          a different prompt, style or aspect ratio.</li>
        <li><strong>The open-weight route.</strong> FLUX is reported from its licence field, not called. No
          price on that row was measured, and the table says which column was read.</li>`
            : `<li><strong>One workload.</strong> These numbers describe answering one question from one contract.
          A different task has different token counts, a different cache hit rate, and probably a different winner.</li>
        <li><strong>A cache hit rate that was measured once.</strong> Moving the prompt size scales the cached and
          uncached halves together, holding the measured hit rate fixed. A prompt with a different shape caches differently.</li>
        <li><strong>Quality that does not travel.</strong> The gate result is for this model on these
          ${esc(w.benchmark?.items ?? "?")} questions. It is evidence, not a guarantee about your questions.</li>
        <li><strong>No latency on the asynchronous route.</strong> The Batch API returns no
          per-request timing, so the ${esc(String(w.workload.latency_ceiling_ms ?? "latency"))}ms ceiling
          was not applied to any batch here — not passed, not failed, not run. The only timing fact a
          batch carries is submit-to-terminal, which is a property of the queue.</li>`
        }
        <li><strong>Prices that drift.</strong> Every rate here was read at
          ${esc(model.catalogue_fetched_at ?? "an unrecorded time")}. Re-run the pipeline for today's.</li>
      </ul>
    </div>
  </section>
</div>`
    )
    .join("\n");
}

/** Where the numbers come from and how a reader runs this on their own workload. */
function renderBuiltWith(model) {
  return `
  <section class="builtwith">
    <h2>Run this on your shortlist</h2>
    <div class="card">
      <p class="cta">Take the document or prompt, ten to fifteen questions you already know the answers
      to, and the models you are considering. You get this page back with your numbers in it. Three
      ways in, in increasing order of control:</p>
      <ul class="tight">
        <li><strong>Form</strong> &mdash; fill in the workload and submit it; the run hands back the
        summary. Best for a one-off question.</li>
        <li><strong>API</strong> &mdash; <code>POST /webhook/cost-route</code> with the workload as
        JSON, for anything you want to run repeatedly or wire into a pipeline.</li>
        <li><strong>Locally</strong> &mdash; clone the repository, add one workload file, and run the
        pipeline. Full control, and the whole interactive page is yours.</li>
      </ul>
      <p class="hint">A text run of five or six models on fourteen questions costs roughly
      <strong>$0.01&ndash;1.00</strong> depending on the shortlist &mdash; the frontier model dominates the bill,
      which is the finding, not a caveat. Nothing runs on a visitor's behalf, and no key is needed to read
      this page.</p>
      <p>This page is the artifact. The pipeline that produces it &mdash; the benchmark runner, the
      estimate-versus-measured ledger, the renderer, the saved run files and the test suite &mdash; is in
      the repository, together with the n8n workflow that orchestrates the calls. Point it at your own
      contract or prompt and your own shortlist by adding one workload file, and the same report comes
      back with your numbers in it.</p>
      ${
        model?.n8n_canvas
          ? `<img class="canvas" src="${esc(model.n8n_canvas)}" alt="The Cost-Route n8n workflow canvas: a manual trigger, two catalogue HTTP Request nodes, and Code nodes that plan the calls, time them, apply the quality gate, price the survivors, compare the three procurement routes and render the decision summary.">`
          : ""
      }
      <ul class="tight">
        <li><strong>Repository:</strong>
          <a href="https://github.com/therealmaddieli/cost-route">github.com/therealmaddieli/cost-route</a>
          &mdash; code, workload files, the n8n workflow, and a README with setup.</li>
        <li><strong>This page, linkable:</strong>
          <a href="https://therealmaddieli.github.io/cost-route/">therealmaddieli.github.io/cost-route</a></li>
        <li><strong>Built with:</strong> n8n for orchestration and raw HTTP requests, and Claude Code as the
          agentic coding tool. Every measured claim on this page is backed by a test or a saved run file.</li>
      </ul>
      <p class="hint" style="margin-bottom:0">Written by Madeline Li &middot;
        <a href="https://www.linkedin.com/in/madeline-shuhui-li/">LinkedIn</a></p>
    </div>
  </section>`;
}

/**
 * The whole page, as one string. No external requests: no fonts, no scripts, no stylesheets. It
 * opens from disk with the network unplugged, which is the only way to be sure it keeps working.
 */
export function renderReportHtml(model) {
  // `workloads` is the shape buildReportModel returns, and the flat fields are its first element.
  // Read through `workloads` and fall back to a one-element list, so an older caller that built the
  // model by hand still renders one tab rather than an empty page.
  const workloads = model.workloads?.length
    ? model.workloads
    : [
        {
          workload: model.workload,
          candidates: model.candidates ?? [],
          ledger: model.ledger ?? null,
          routes: model.routes ?? [],
          benchmark: model.benchmark ?? {},
          quality_scored: true,
          distribution_rows: [],
        },
      ];

  const first = workloads[0].workload;
  const multi = workloads.length > 1;

  // One payload holding every workload, rather than one page per workload. The panel below is a
  // single set of inputs re-pointed on tab switch, so it needs all of the workloads' defaults at
  // once; a second copy of them in a second script block is the duplication this avoids.
  const data = {
    // The catalogue-wide batch distribution, once, not per workload: it is a property of the
    // catalogue rather than of any tab, and shipping it inside each workload would let two tabs
    // report different counts for the same catalogue.
    catalogue: { batch: model.catalogue?.batch ?? null, fetched_at: model.catalogue_fetched_at ?? null },
    workloads: workloads.map((w) => {
      const buyer = w.workload.buyer_estimate ?? {};
      const kind = w.workload.kind;

      // A field can only be locked to a measurement that exists. An image workload with no run
      // behind it - every new workload on the day it is added, and any checkout whose paid run
      // failed - was locked to null, which put a disabled, empty box on the page captioned "this is
      // what the prompt actually measured" and then asked the reader to enter a prompt size. That is
      // an instruction to fill in a field that cannot be typed into, about a run that never
      // happened, and it is the failure this project exists to name.
      const measuredPrompt = w.workload.measured_input_tokens_per_call ?? null;
      const measuredOutput = w.workload.measured_output_tokens_per_call ?? null;
      const unmeasured = !w.candidates.some((c) => c.measured);

      return {
        name: w.workload.name,
        kind,
        // The pictures are stripped out of this payload, and that is not tidiness. Each one is a
        // base64 data URI that is already in the markup as the img src; carrying it here as well
        // ships every picture twice, which took the page from about 5 MB to 9.8 MB. The client
        // script reads the image workload's numbers from `image_summary`, which is a few hundred
        // bytes, so nothing needs the bytes a second time.
        candidates: w.candidates.map((c) => ({ ...c, images: undefined })),
        volume: w.workload.monthly_requests ?? 0,
        promptDefault: buyer.assumed_input_tokens_per_request ?? 1500,
        outputDefault: buyer.assumed_output_tokens_per_request ?? 50,
        estimateDefault: buyer.assumed_cost_per_month_usd ?? null,
        // The prompt and answer length are the reader's to move on a text workload and NOT on an
        // image one. The 263x gap between the two candidates' prompt token counts for the same
        // one-sentence prompt is the finding of that tab; a panel that let a reader type a prompt
        // size would be generating the estimate this whole page exists to correct.
        // Locked only when there is something to lock to. `unmeasured` is carried separately rather
        // than left to be inferred from a null, because the caption has to say which of the two
        // states this is and a null reads the same whether a run is missing or an odd run reported
        // nothing for the prompt.
        locked: kind === "image" && measuredPrompt != null,
        unmeasured,
        measuredPrompt,
        measuredOutput,
        measuredImage: w.workload.measured_image_tokens_per_call ?? null,
        // Named so the shared panel can point at the right waterfall. Null when no ledger was built.
        waterfallUsd: w.ledger?.available ? w.ledger.measured_usd : null,
        items: w.benchmark?.items ?? null,
      };
    }),
  };

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Cost-Route — which model should actually run your workload?</title>
<style>${STYLE}</style>
</head>
<body>
<div class="wrap">

  <header class="hero">
    <h1>Which of your models should actually run the workload?</h1>
    <p class="lede">You know your token profile and you have opinions about your stack. Cost-Route
    measures the shortlist you are already considering against your own questions, prices every
    candidate across three procurement routes, and shows which price mechanics actually decide the
    bill. Then it names the gap between what you estimated and what the calls really cost.</p>
    <p class="sub">
      Prices read from OpenRouter and the Hugging Face router at ${esc(model.catalogue_fetched_at ?? "an unrecorded time")}.
      Page generated ${esc(model.generated_at)}.
    </p>
  </header>

  <div class="card brief">
    <div class="brief-row"><span class="brief-k">What you get</span>
      A measured quality gate per candidate against your own known answers, measured latency, cost per
      call and per month at your volume, and the things a price list hides: the cached-input rate, tier
      thresholds, provider choice, the licence, and how much lock-in each route carries.</div>
    <div class="brief-row"><span class="brief-k">Who it is for</span>
      The engineer or procurement lead who knows their token consumption and their stack preferences.
      This is not a CFO's summary and it does not round the fine print off.</div>
    <div class="brief-row"><span class="brief-k">What it is not</span>
      Not a market scan — the shortlist is yours, and the page tests the models you name rather than
      ranking 446 of them. Not a per-token calculator, and not an estimate generator: every measured
      figure came from a call that was really made and billed.</div>
  </div>

${renderHowTo(workloads, multi)}

${multi ? renderTabs(workloads) : ""}

${renderOwnNumbers(workloads, multi, first)}

${renderWorkloadPanels(workloads, model)}

${renderBuiltWith(model)}
  <footer>
    Cost-Route. Synthetic test data: every party, figure and clause in the source documents is invented.
    No real client documents were used.${
      workloads.some((w) => w.benchmark?.run_at)
        ? ` Measured runs from ${workloads
            .filter((w) => w.benchmark?.run_at)
            .map(
              (w) =>
                `${esc(w.workload.name)} at ${esc(w.benchmark.run_at)}${
                  w.benchmark.path ? ` (${esc(w.benchmark.path)})` : ""
                }`
            )
            .join("; ")}.`
        : ""
    }
  </footer>
</div>

<script>
(function () {
  "use strict";
  var DATA = ${jsonForScript(data)};
${CLIENT_FN_SRC}
  var $ = function (id) { return document.getElementById(id); };
  var fmt = function (n, places) {
    if (n == null || !isFinite(n)) return "n/a";
    return "$" + n.toFixed(places == null ? 2 : places);
  };
  var num = function (n) { return Math.round(n).toLocaleString(); };

  // -------------------------------------------------------------------------
  // charts: a cost/quality/latency scatter and a live waterfall
  // -------------------------------------------------------------------------
  //
  // Both reuse reportCostPerCall, the same tested function the table and the panel above already
  // call, so the chart and the numbers beside it can never disagree. Quality and latency never move
  // - they are measured - only a point's position on the cost axis, and the waterfall's bars,
  // respond to the panel.

  function niceLogTicks(lo, hi) {
    var steps = [1, 2, 3, 5], ticks = [];
    var d0 = Math.floor(Math.log10(lo)), d1 = Math.ceil(Math.log10(hi));
    for (var d = d0; d <= d1; d++) {
      for (var s = 0; s < steps.length; s++) {
        var v = steps[s] * Math.pow(10, d);
        if (v >= lo * 0.999 && v <= hi * 1.001) ticks.push(v);
      }
    }
    if (ticks.length > 6) ticks = ticks.filter(function (v, i) { return i % 2 === 0 || v === ticks[ticks.length - 1]; });
    return ticks;
  }
  function fmtAxisMoney(v) { return Math.abs(v - Math.round(v)) < 0.001 ? "$" + Math.round(v) : "$" + v.toFixed(v < 1 ? 2 : 1); }
  function niceLinearTicks(max, count) {
    if (max <= 0) max = 1;
    var rawStep = max / count;
    var mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    var norm = rawStep / mag;
    var niceNorm = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
    var step = niceNorm * mag;
    var ticks = [];
    for (var v = 0; v <= max + step * 0.001; v += step) ticks.push(Math.round(v * 100) / 100);
    return ticks;
  }

  /**
   * Cost vs. quality, sized by p95 latency. Reuses "results", the same array the candidate table
   * just rendered its Monthly column from, so the chart and the table can never show two different
   * numbers for the same input.
   */
  function renderScatterChart(workloadIndex, candidates, results, volume) {
    if (!$("sc-svg-" + workloadIndex)) return;

    var meta = candidates.map(function (c) {
      var q = c.quality;
      if (!q || !q.latency_ms || q.correct_share == null) return null;
      return { correctShare: q.correct_share, p95: q.latency_ms.p95, pass: String(q.verdict).toUpperCase() === "PASS", hallucinations: q.hallucination_count || 0 };
    });
    var latVals = [];
    meta.forEach(function (m) { if (m) latVals.push(m.p95); });
    if (!latVals.length) return;
    var latMin = Math.min.apply(null, latVals), latMax = Math.max.apply(null, latVals);
    function rForLatency(ms) {
      if (latMax === latMin) return 14;
      var s = Math.sqrt(ms), s0 = Math.sqrt(latMin), s1 = Math.sqrt(latMax);
      return 8 + (s - s0) / (s1 - s0) * 18;
    }
    function yForAccuracy(share) { return 30 + ((1 - share) / 0.3) * 300; }

    var L = 70, R = 830, T = 20, B = 330;
    var monthly = candidates.map(function (c, i) {
      var r = results[i];
      return r && r.complete && volume != null ? r.per_call_usd * volume : null;
    });
    var positive = [];
    monthly.forEach(function (v) { if (v != null && v > 0) positive.push(v); });
    var lo = positive.length ? Math.min.apply(null, positive) / 1.8 : 1;
    var hi = positive.length ? Math.max.apply(null, positive) * 1.8 : 1000;
    if (lo <= 0) lo = 0.01;
    function xw(v) {
      var vv = Math.max(v == null ? lo : v, lo);
      return L + (Math.log10(vv) - Math.log10(lo)) / (Math.log10(hi) - Math.log10(lo)) * (R - L);
    }

    var ticks = niceLogTicks(lo, hi);
    var gridHtml = ticks.map(function (t) {
      var x = xw(t);
      return '<line class="ax-grid" x1="' + x + '" y1="' + T + '" x2="' + x + '" y2="' + B + '"/>' +
        '<text class="ax-label" x="' + x + '" y="348" text-anchor="middle">' + fmtAxisMoney(t) + "</text>";
    }).join("");
    if ($("sc-grid-x-" + workloadIndex)) $("sc-grid-x-" + workloadIndex).innerHTML = gridHtml;
    if ($("sc-axis-title-" + workloadIndex)) $("sc-axis-title-" + workloadIndex).textContent = "Monthly cost at " + num(volume || 0) + " requests (log scale)";

    var incumbentIndex = -1;
    candidates.forEach(function (c, i) { if (c.incumbent) incumbentIndex = i; });

    var pts = candidates.map(function (c, i) {
      var m = meta[i];
      if (!m) return null;
      return { i: i, x: xw(monthly[i]), y: yForAccuracy(m.correctShare), r: rForLatency(m.p95), pass: m.pass };
    });

    // labels sharing a quality tier can end up close enough on the cost axis to collide; stagger
    // onto a second row rather than let the text overlap.
    var byTier = {};
    pts.forEach(function (p) { if (p && p.i !== incumbentIndex) { var k = Math.round(p.y); (byTier[k] = byTier[k] || []).push(p); } });
    var labelLevel = {};
    Object.keys(byTier).forEach(function (k) {
      var group = byTier[k].slice().sort(function (a, b) { return a.x - b.x; });
      var rightEdgeAtLevel = {};
      group.forEach(function (p) {
        var nm = candidates[p.i].name.length > 20 ? candidates[p.i].name.slice(0, 20) : candidates[p.i].name;
        var halfWidth = nm.length * 3.6 + 6;
        var level = 0;
        while (rightEdgeAtLevel[level] != null && p.x - halfWidth < rightEdgeAtLevel[level] + 6) level++;
        rightEdgeAtLevel[level] = p.x + halfWidth;
        labelLevel[p.i] = level;
      });
    });

    var pointsHtml = "", labelsHtml = "", calloutHtml = "";
    pts.forEach(function (p) {
      if (!p) return;
      var c = candidates[p.i], m = meta[p.i];
      var title = c.name + ", " + (m.correctShare * 100).toFixed(1) + "% correct" +
        (m.hallucinations ? " but " + m.hallucinations + " fabricated answer" : "") +
        (monthly[p.i] != null ? ", " + fmt(monthly[p.i]) + "/mo" : "") + ", p95 " + num(m.p95) + " ms" + (p.pass ? "" : ". Fails the gate.");
      if (p.pass) {
        pointsHtml += '<circle class="mk-pass" cx="' + p.x + '" cy="' + p.y + '" r="' + p.r + '"><title>' + title + "</title></circle>";
      } else {
        var half = p.r * 0.8;
        pointsHtml += '<rect class="mk-fail" x="' + (p.x - half) + '" y="' + (p.y - half) + '" width="' + (half * 2) + '" height="' + (half * 2) + '" transform="rotate(45 ' + p.x + " " + p.y + ')"><title>' + title + "</title></rect>";
      }
      if (p.i === incumbentIndex && !p.pass) {
        var leadX = p.x + p.r * 0.7, leadY = p.y + p.r * 0.7;
        calloutHtml = '<path class="callout-lead" d="M' + leadX + "," + leadY + ' L330,282"/>' +
          '<rect class="callout-box" x="330" y="282" width="240" height="44" rx="7"/>' +
          '<text class="callout-text" x="342" y="298">' + c.name + ", today's default:</text>" +
          '<text class="callout-text" x="342" y="310">' + (m.correctShare * 100).toFixed(1) + "% correct, " + m.hallucinations + " fabricated answer.</text>" +
          '<text class="callout-text" x="342" y="322">The bar allows zero.</text>';
      } else {
        var level = labelLevel[p.i] || 0;
        var below = p.y < 180;
        var short = c.name.length > 24 ? c.name.split(":").pop().replace(/^\s+/, "") : c.name;
        if (below) {
          labelsHtml += '<text class="pt-label" x="' + p.x + '" y="' + (p.y + p.r + 14 + level * 14) + '" text-anchor="middle">' + short + "</text>";
        } else {
          labelsHtml += '<text class="pt-label" x="' + p.x + '" y="' + (p.y - p.r - 8 - level * 14) + '" text-anchor="middle">' + short + "</text>";
        }
      }
    });
    if ($("sc-points-" + workloadIndex)) $("sc-points-" + workloadIndex).innerHTML = pointsHtml;
    if ($("sc-labels-" + workloadIndex)) $("sc-labels-" + workloadIndex).innerHTML = labelsHtml;
    if ($("sc-callout-" + workloadIndex)) $("sc-callout-" + workloadIndex).innerHTML = calloutHtml;
  }

  /**
   * A live version of the static bridge in the section above: the same four dimensions, in the same
   * order, using the same reportCostPerCall, but recomputed as the panel moves instead of frozen at
   * build time. Only called for a workload whose bridge is this plain four-step kind - see the
   * chartEnabled flag renderWaterfall was given.
   */
  function renderWaterfallChart(workloadIndex, w, subject, promptTokens, outputTokens, estimate, volume) {
    var svg = $("wf-svg-" + workloadIndex);
    if (!svg) return;
    if (!subject || !subject.measured || promptTokens == null || outputTokens == null || volume == null) {
      ["wf-bars-", "wf-labels-", "wf-connectors-", "wf-grid-x-", "wf-grid-labels-"].forEach(function (prefix) {
        if ($(prefix + workloadIndex)) $(prefix + workloadIndex).innerHTML = "";
      });
      return;
    }

    var measuredPrompt = w.measuredPrompt, measuredOutput = w.measuredOutput;
    var v0 = estimate == null ? 0 : estimate;
    var v1 = reportCostPerCall(subject, promptTokens, { cacheHitRate: 0, outputTokens: outputTokens }).per_call_usd * volume;
    var v2 = reportCostPerCall(subject, measuredPrompt, { cacheHitRate: 0, outputTokens: outputTokens }).per_call_usd * volume;
    var v3 = reportCostPerCall(subject, measuredPrompt, { cacheHitRate: 0, outputTokens: measuredOutput }).per_call_usd * volume;
    var v4 = reportCostPerCall(subject, measuredPrompt, { outputTokens: measuredOutput }).per_call_usd * volume;
    var v5 = v4; // this subject's reasoning_tokens_per_call is fixed at its measured value by reportCostPerCall

    var rows = [
      { type: "total", value: v0 },
      { type: "delta", from: v0, to: v1 },
      { type: "total", value: v1 },
      { type: "delta", from: v1, to: v2 },
      { type: "delta", from: v2, to: v3 },
      { type: "delta", from: v3, to: v4 },
      { type: "delta", from: v4, to: v5, note: "not billed on this run" },
      { type: "total", value: v5, emphasize: true }
    ];

    var domainMax = Math.max(v0, v1, v2, v3, v4, v5, 1) * 1.08;
    var xL = 200, xR = 830;
    function xw(v) { return xL + (Math.max(v, 0) / domainMax) * (xR - xL); }

    var ticks = niceLinearTicks(domainMax, 4);
    var gridXml = "", gridLabelXml = "";
    ticks.forEach(function (t) {
      var x = xw(t);
      gridXml += '<line class="ax-grid" x1="' + x + '" y1="20" x2="' + x + '" y2="331"/>';
      gridLabelXml += '<text class="ax-label" x="' + x + '" y="358" text-anchor="middle">' + fmt(t) + "</text>";
    });
    if ($("wf-grid-x-" + workloadIndex)) $("wf-grid-x-" + workloadIndex).innerHTML = gridXml;
    if ($("wf-grid-labels-" + workloadIndex)) $("wf-grid-labels-" + workloadIndex).innerHTML = gridLabelXml;

    var barsXml = "", labelsXml = "", connXml = "";
    var rowY = [40, 80, 120, 160, 200, 240, 280, 320];
    var boundaries = [v0, v1, v1, v2, v3, v4, v5];

    rows.forEach(function (row, i) {
      var y = rowY[i], half = 11;
      if (row.type === "total") {
        var x1 = xw(0), x2 = xw(row.value);
        barsXml += '<rect class="wf-total" x="' + x1 + '" y="' + (y - half) + '" width="' + Math.max(0, x2 - x1) + '" height="' + (half * 2) + '" rx="3"/>';
        if (row.emphasize) barsXml += '<rect class="wf-total-ring" x="' + (x1 - 2) + '" y="' + (y - half - 2) + '" width="' + (x2 - x1 + 4) + '" height="' + (half * 2 + 4) + '" rx="5"/>';
        var cls = row.emphasize ? "wf-value-strong" : "wf-value";
        labelsXml += '<text class="' + cls + '" x="' + (x2 + 8) + '" y="' + (y + 4) + '">' + fmt(row.value) + "</text>";
      } else {
        var lo2 = Math.min(row.from, row.to), hi2 = Math.max(row.from, row.to);
        var xa = xw(lo2), xb = xw(hi2);
        var tiny = (xb - xa) < 4;
        var increase = row.to >= row.from;
        var cls2 = increase ? "wf-up" : "wf-down";
        if (tiny) {
          barsXml += '<circle class="wf-dot" cx="' + xw(row.to) + '" cy="' + y + '" r="4"/>';
          labelsXml += '<text class="wf-note-text" x="' + (xw(row.to) + 12) + '" y="' + (y + 4) + '">±$0.00' + (row.note ? " · " + row.note : "") + "</text>";
        } else {
          barsXml += '<rect class="' + cls2 + '" x="' + xa + '" y="' + (y - half) + '" width="' + (xb - xa) + '" height="' + (half * 2) + '" rx="3"/>';
          var delta = row.to - row.from;
          labelsXml += '<text class="wf-value" x="' + (xb + 8) + '" y="' + (y + 4) + '">' + (delta >= 0 ? "+" : "−") + fmt(Math.abs(delta)) + "</text>";
        }
      }
      if (i < boundaries.length) {
        var bx = xw(boundaries[i]);
        connXml += '<line class="wf-connector" x1="' + bx + '" y1="' + (rowY[i] + half) + '" x2="' + bx + '" y2="' + (rowY[i + 1] - half) + '"/>';
      }
    });
    if ($("wf-bars-" + workloadIndex)) $("wf-bars-" + workloadIndex).innerHTML = barsXml;
    if ($("wf-labels-" + workloadIndex)) $("wf-labels-" + workloadIndex).innerHTML = labelsXml;
    if ($("wf-connectors-" + workloadIndex)) $("wf-connectors-" + workloadIndex).innerHTML = connXml;

    if ($("wf-note-line-" + workloadIndex)) {
      $("wf-note-line-" + workloadIndex).textContent =
        "The panel above reprices your own " + num(promptTokens) + "/" + num(outputTokens) +
        " tokens. The steps below walk from your assumptions to the actual measured run, which used " +
        num(measuredPrompt) + "/" + num(measuredOutput) + " tokens per call, so the final bar only moves when you change the request volume.";
    }
  }

  // -------------------------------------------------------------------------
  // tabs
  // -------------------------------------------------------------------------
  //
  // One panel of inputs, re-pointed at whichever workload is showing, rather than one panel per
  // tab. Two panels would mean two sets of ids, two sets of listeners and two places for the cost
  // arithmetic to be wired up wrong; the panel is the part of the page a reader types into, so it
  // is the part most worth having exactly one of.
  var active = 0;
  var W = function () { return DATA.workloads[active]; };

  // The incumbent is the model the buyer is running today: the one the ledger explains. Resolved
  // per render rather than once, because the incumbent of the other tab is a different model.
  function subjectOf() {
    var list = W().candidates || [];
    var inc = list.filter(function (c) { return c.incumbent; });
    return inc[0] || list[0] || null;
  }

  function activate(index, opts) {
    opts = opts || {};
    if (!DATA.workloads[index]) return;
    active = index;
    var w = DATA.workloads[index];

    // The DOM is read defensively throughout: this runs against a page that may have lost an
    // element, and a tab switch that throws would take the panel down with it.
    var panels = document.querySelectorAll ? document.querySelectorAll("[data-workload]") : [];
    for (var p = 0; p < panels.length; p += 1) {
      var isActive = Number(panels[p].getAttribute("data-workload")) === index;
      // The hidden attribute rather than a display style, so the page keeps working when a reader's
      // browser applies its own stylesheet over ours.
      if (isActive) panels[p].removeAttribute("hidden");
      else panels[p].setAttribute("hidden", "");
    }

    var tabs = document.querySelectorAll ? document.querySelectorAll("[data-tab]") : [];
    for (var t = 0; t < tabs.length; t += 1) {
      var on = Number(tabs[t].getAttribute("data-tab")) === index;
      tabs[t].setAttribute("aria-selected", on ? "true" : "false");
      tabs[t].setAttribute("tabindex", on ? "0" : "-1");
    }

    var name = $("out-panel-name");
    if (name) name.textContent = w.name;

    if (opts.keepInputs) return;

    // The fields, their lock state and their captions all come from the workload now showing. The
    // markup ships the fields' opening values so the page still says something with scripting off;
    // the captions are written here rather than there, because they name the measured numbers and a
    // second copy of them in the template is a second place for the copy to go stale. A
    // locked field is disabled rather than absent: the measured number stays on screen, because on
    // this tab the gap between what a reader would type and what was measured IS the finding.
    setField("in-volume", "hint-volume", w.volume, false,
      w.items != null
        ? "The measured run asked " + num(w.items) + " questions of each candidate. This is the month you expect."
        : "The measured run made two calls per candidate. This is the month you expect.");

    // The spread across candidates, derived from the payload rather than written into the copy: the
    // ratio is 263x on one day's pair and 177x on the previous one, so a hard-coded multiple would
    // be a number the page asserts and cannot show.
    var spread = promptSpread(w);

    setField("in-prompt", "hint-prompt", w.locked ? w.measuredPrompt : w.promptDefault, w.locked,
      w.locked
        ? "Locked. This is what the prompt actually measured" +
          (spread ? ": the same one-sentence prompt cost " + num(spread.min) + " tokens on one candidate and " +
            num(spread.max) + " on the other, a " + Math.round(spread.max / Math.max(1, spread.min)) +
            "x difference. Typing your own prompt size here would generate exactly the estimate this page exists to correct." : ".")
        : w.unmeasured
          ? "No measured run is behind this workload on this page, so there is no measured prompt to lock to and nothing below can be priced. This is the buyer's own assumption, and it is yours to change."
          : "The buyer assumed " + num(w.promptDefault) + ". The measurement found a larger prompt.");

    setField("in-output", "hint-output", w.locked ? w.measuredOutput : w.outputDefault, w.locked,
      w.locked
        ? "Locked: the returned image is billed as " + num(w.measuredImage) + " of these " +
          num(w.measuredOutput) + " output tokens, and it is charged at the image rate, not the text rate."
        : w.unmeasured
          ? "No measured run is behind this workload on this page. The buyer's assumption stands, and it is yours to change."
          : "The buyer assumed " + num(w.outputDefault) + ". Shorter answers than you expect are a real correction, and they go both ways.");

    var est = $("in-estimate");
    if (est) est.value = w.estimateDefault == null ? "" : String(w.estimateDefault);

    // The two headings above the fields are about the fields, so they follow the tab like the fields
    // do. On a locked workload two of the four boxes are measurements rather than the reader's own
    // guesses, and leaving the text as it stands would have the page say "you change this" over a
    // box nobody can change and call a measured prompt size a guess - the two claims this page
    // spends its whole length arguing against.
    var leftHeading = $("out-panel-left-h");
    if (leftHeading) {
      leftHeading.innerHTML = w.locked
        ? 'Two of these are yours <span class="lock assumed">assumed</span>'
        : 'You change this <span class="lock assumed">assumed</span>';
    }
    var panelSub = $("out-panel-sub");
    if (panelSub) {
      // The tail depends on how many tabs the page has, the rest on which tab is showing, and the two
      // are independent. Four combinations, and the server-side template only knew the first: a
      // single-workload page was about to promise a tab switch that does not exist.
      var tail =
        DATA.workloads.length > 1
          ? " This panel follows the tab you picked above; switching tabs re-points it at the other " +
            "workload's own measurements."
          : " There is one workload, so this panel has one configuration.";
      panelSub.textContent =
        (w.locked
          ? "Everything measured is fixed and timestamped, and the prompt and answer length below are " +
            "part of what was measured: the gap between what you would type there and what the call " +
            "actually spent is the finding on this tab, so those two boxes are shown rather than " +
            "offered. Your volume and your own estimate are yours, and you may as well move them and " +
            "see how far the answer travels."
          : "Everything measured is fixed and timestamped. Everything here is a guess, by definition, " +
            "so you may as well move it and see how far the answer travels.") + tail;
    }

    // Caching is the one mechanic the reader's own inputs can express, so on a text workload the two
    // gap boxes are two different numbers. On this workload the measured run served no prompt token
    // from cache, so pricing with the measured hit rate and pricing with none give the same figure:
    // the second box would read $0.00 beside a mechanic, which reads as a saving nobody took. It is
    // removed rather than shown at zero.
    //
    // Not because "image models do not sell caching". They do - the image model on this page
    // publishes a cache-read rate, and the routes table below says so. The reason is the measured
    // hit rate, which the note under the panel states, so the panel and the routes table cannot
    // contradict each other about a fact both of them can see.
    attr($("gapbox-model"), "hidden", w.kind === "image");

    var ref = $("out-waterfall-ref");
    if (ref) {
      ref.textContent = w.waterfallUsd == null
        ? ""
        : "The figures above are your inputs priced with rates that were measured. They are not the " +
          "measurement itself: the fully measured configuration, on the buyer's own numbers, is the " +
          fmt(w.waterfallUsd, 2) + " in the waterfall above. The two differ because your volume" +
          (w.locked ? "" : ", prompt and answer length") + " are yours.";
    }

    render();
  }

  /** The smallest and largest measured prompt size on this workload, for the locked-field caption. */
  function promptSpread(w) {
    var sizes = (w.candidates || [])
      .map(function (c) { return c.measured ? c.measured.input_tokens_per_call : null; })
      .filter(function (n) { return typeof n === "number"; });
    if (sizes.length < 2) return null;
    return { min: Math.min.apply(null, sizes), max: Math.max.apply(null, sizes) };
  }

  /**
   * Set or clear a boolean attribute, tolerating an element or a DOM that does not support it.
   *
   * The page is one file that has to keep working wherever it is opened, so every DOM write in the
   * tab machinery is guarded. A throw here would leave the reader on a tab with no panel at all.
   */
  function attr(el, name, on) {
    if (!el) return;
    if (on) {
      if (el.setAttribute) el.setAttribute(name, "");
    } else if (el.removeAttribute) {
      el.removeAttribute(name);
    }
  }

  /** Write a field's value, lock state and caption together, so the three cannot disagree. */
  function setField(inputId, hintId, value, locked, hint) {
    var el = $(inputId);
    if (el) {
      el.value = value == null ? "" : String(value);
      attr(el, "disabled", locked);
    }
    var h = $(hintId);
    if (h) h.textContent = hint || "";
  }

  function readNumber(el, fallback) {
    var raw = el.value.trim();
    if (raw === "") return { value: null, empty: true };
    var n = Number(raw);
    if (!isFinite(n)) return { value: null, empty: false, bad: true };
    return { value: n, empty: false };
  }

  function render() {
    // Read the active workload once per render. Every list below is this workload's, so a tab switch
    // followed by a render cannot price one workload's inputs against another's candidates.
    var CANDIDATES = W().candidates || [];
    var kind = W().kind;
    var subject = subjectOf();
    var vol = readNumber($("in-volume"));
    var prompt = readNumber($("in-prompt"));
    var out = readNumber($("in-output"));
    var est = readNumber($("in-estimate"));
    var notes = [];

    // A locked field is locked in the arithmetic, not only in the markup. The disabled attribute
    // keeps a reader out of the box, but it is not what makes the number true. This render used to
    // read whatever the field held, so setting it by script or through devtools priced the image tab
    // at a prompt size the reader had typed - the estimate that tab exists to correct, arriving
    // through the one door the lock was meant to close. The measurement is the value now; the box is
    // only how it is shown.
    if (W().locked) {
      if (W().measuredPrompt != null) prompt = { value: W().measuredPrompt, empty: false };
      if (W().measuredOutput != null) out = { value: W().measuredOutput, empty: false };
    }

    // --- degrade to a stated reason, never to an exception or a silent zero ---
    var volume = vol.value;
    if (vol.empty || vol.bad || volume === null) {
      notes.push(["info", "Enter a monthly request volume to price a month. Nothing below is a monthly figure until you do."]);
      volume = null;
    } else if (volume < 0) {
      notes.push(["bad", "A negative request volume cannot be priced. It is not a small volume, it is not a quantity."]);
      volume = null;
    } else if (volume === 0) {
      notes.push(["info", "Zero requests is a real answer: a workload nobody runs costs nothing on every route here."]);
    } else if (W().volume && volume > W().volume * 10) {
      notes.push(["info", "That is more than ten times the volume these rates were observed at. Volume pricing, committed-use discounts and rate limits all start to matter, and none of them are in this model."]);
    }

    var promptTokens = prompt.value;
    if (prompt.empty || prompt.bad || promptTokens === null) {
      notes.push(["info", "Enter a prompt size. The cost of a call is roughly the prompt multiplied by nothing else, so there is no sensible default to fall back to."]);
      promptTokens = null;
    } else if (promptTokens < 0) {
      notes.push(["bad", "A negative prompt size cannot be priced."]);
      promptTokens = null;
    }

    var outputTokens = out.value;
    if (out.empty || out.bad || outputTokens === null) {
      notes.push(["info", "Enter an answer length. It defaults to nothing rather than to the measured figure, because a default here would be the page quietly supplying an input the reader did not give."]);
      outputTokens = null;
    } else if (outputTokens < 0) {
      notes.push(["bad", "A negative answer length cannot be priced."]);
      outputTokens = null;
    }

    // --- costs, one per candidate, at the reader's inputs ---
    var results = CANDIDATES.map(function (c) {
      if (promptTokens == null || outputTokens == null || c.measured == null) return null;
      return reportCostPerCall(c, promptTokens, { outputTokens: outputTokens });
    });

    // candidate table. Rows are addressed by index because the page built them in this same order,
    // which avoids escaping a slug into a CSS selector. The lookup is scoped to the panel that is
    // showing: both tabs ship a row 0, and an unscoped selector would write the image workload's
    // figures into the text table the moment both are in the document.
    CANDIDATES.forEach(function (c, i) {
      var row = document.querySelector('[data-workload="' + active + '"] tr[data-row="' + i + '"]');
      if (!row) return;
      var r = results[i];
      var perCallCell = row.querySelector('[data-cell="per_call"]');
      var monthlyCell = row.querySelector('[data-cell="monthly"]');
      if (!r) {
        perCallCell.innerHTML = '<span class="hint">no measured profile</span>';
        monthlyCell.innerHTML = '<span class="hint">not priced</span>';
        return;
      }
      if (!r.complete) {
        perCallCell.innerHTML = '<span class="hint">unprojectable</span>';
        monthlyCell.innerHTML = '<span class="hint">unprojectable</span>';
        return;
      }
      perCallCell.textContent = fmt(r.per_call_usd, 6);
      monthlyCell.textContent = volume == null ? "n/a" : fmt(r.per_call_usd * volume);
    });

    renderScatterChart(active, CANDIDATES, results, volume);

    // --- the headline figure, and the two gaps, kept apart ---
    var subjectResult = subject ? results[CANDIDATES.indexOf(subject)] : null;
    var ownMonthly = null;
    var measuredMonthly = null;

    if (subjectResult && subjectResult.complete && volume != null) {
      // The reader's inputs priced with the cache behaviour this workload actually showed.
      measuredMonthly = subjectResult.per_call_usd * volume;
      // The same inputs priced with no caching, because that is what someone estimating without
      // measuring assumes. The difference between these two is the only correction measurement
      // makes to the reader's own numbers, and the panel says so rather than implying it is the
      // whole gap.
      var asAssumed = reportCostPerCall(subject, promptTokens, { cacheHitRate: 0, outputTokens: outputTokens });
      ownMonthly = asAssumed.complete ? asAssumed.per_call_usd * volume : null;
    }

    $("out-measured").innerHTML =
      measuredMonthly == null ? "–" : fmt(measuredMonthly) + ' <small>per month</small>';

    $("out-measured-sub").textContent =
      measuredMonthly == null
        ? "per month"
        : (subject ? subject.name : "the incumbent") +
          " at " + num(promptTokens) + " in / " + num(outputTokens) + " out" +
          // Each workload is made expensive by a different mechanic, and this line has to name the
          // one that applies. Caching is the text tab's. On the image tab there is no cache to hit,
          // so the same sentence reported "the measured 0% cache hit rate" - a measurement asserted
          // about a mechanic the workload does not have, which is the failure this project exists to
          // name. The image count is the image tab's equivalent fact and it comes from the run.
          (kind === "image"
            ? ", of which " +
              num(subject && subject.measured ? subject.measured.image_tokens_per_call : 0) +
              " are the picture itself"
            : ", with the measured " +
              Math.round((subject && subject.measured ? subject.measured.cache_hit_rate : 0) * 100) +
              "% cache hit rate");

    var estValue = est.empty || est.bad ? null : est.value;
    var arith = estValue != null && ownMonthly != null ? estValue - ownMonthly : null;
    var modelGap = ownMonthly != null && measuredMonthly != null ? ownMonthly - measuredMonthly : null;

    if (kind !== "image") {
      renderWaterfallChart(active, W(), subject, promptTokens, outputTokens, estValue, volume);
    }

    $("out-arith").textContent = arith == null ? "–" : (arith >= 0 ? "" : "−") + fmt(Math.abs(arith));
    $("out-model").textContent = modelGap == null ? "–" : (modelGap >= 0 ? "" : "−") + fmt(Math.abs(modelGap));

    if (estValue == null) {
      $("out-arith-note").textContent = "enter your own estimate to compare";
      $("out-model-note").textContent = "the only part measuring changes about your numbers";
    } else if (arith != null) {
      var ratio = ownMonthly > 0 ? estValue / ownMonthly : null;
      $("out-arith-note").textContent =
        ratio == null
          ? "not comparable at a zero baseline"
          : ratio > 1.05 || ratio < 0.95
            ? ratio.toFixed(2) + "x your own assumptions. No measurement was needed to find this one."
            : "close to your own assumptions, so your arithmetic is fine";
      $("out-model-note").textContent =
        modelGap == null
          ? ""
          : Math.abs(modelGap) < 0.01
            ? "the measurement agreed with your assumptions"
            : fmt(Math.abs(modelGap)) + " of it is caching, and nothing else";
    }

    // --- candidate-specific reasons, attached to the number they explain ---
    if (subjectResult) {
      subjectResult.reasons.forEach(function (reason) {
        if (reason === "cache_unavailable") {
          notes.push(["info", "Your prompt has " + num(subjectResult.cached_tokens) + " tokens that would be served from cache on a route that sells caching, but " + subject.name + " publishes no cache-read rate, so they are charged at the full input rate. The saving is real and cannot be claimed here."]);
        } else if (reason === "cache_applied") {
          // Two different kinds of fact in one sentence, and they are easy to blur: the hit rate is
          // what was measured, the per-million figure is what the route publishes. Calling the
          // published price measured would put this page in the same business as the estimates it
          // exists to correct.
          notes.push(["info", num(subjectResult.cached_tokens) + " of your prompt tokens are priced at the cached rate this route publishes, " + (subjectResult.rate_used.cache_read_per_m != null ? fmt(subjectResult.rate_used.cache_read_per_m, 4) : "?") + " per million. The hit rate is what was measured; the price is what the route publishes."]);
        } else if (reason === "tier") {
          notes.push(["info", "At this prompt size the model crosses the " + num(subjectResult.rate_used.tier_applied) + "-token pricing tier, so the per-token rate itself changed. This is why cost per call is not strictly proportional to prompt size."]);
        } else if (reason === "over_context") {
          notes.push(["bad", "A " + num(promptTokens) + "-token prompt exceeds this model's context window of " + num(subject.context_length) + " tokens, so the call would be rejected. The figure shown is the arithmetic of a call that cannot be made, and it is shown rather than hidden so the limit is visible."]);
        } else if (reason === "reasoning_at_output_rate") {
          notes.push(["info", "This model bills reasoning tokens at its output rate. Whether the provider does exactly that is unverified, and it is the largest single uncertainty in this figure."]);
        } else if (reason === "image_at_image_rate") {
          // The headline mechanic of the image tab, stated where the number it explains is. The
          // factor is computed from the two published rates rather than written into the copy: the
          // 12x on one model is 4x on the other, and hard-coding either would be wrong on the other
          // candidate's row.
          var imageTok = subject.measured ? subject.measured.image_tokens_per_call : null;
          var imgRate = subject.pricing ? subject.pricing.image_output_per_m : null;
          var textRate = subjectResult.rate_used ? subjectResult.rate_used.output_per_m : null;
          var factor = imgRate != null && textRate ? (imgRate / textRate).toFixed(1) : null;
          notes.push(["info",
            num(imageTok) + " of the output tokens are the picture itself, and they are charged at the image rate this route publishes, " +
            (imgRate != null ? fmt(imgRate, 2) : "?") + " per million, not at the text output rate of " +
            (textRate != null ? fmt(textRate, 2) : "?") + " per million. Both rates sit a line apart on the pricing page" +
            (factor ? ", and they differ by a factor of " + factor : "") +
            ", so reading the line labelled 'completion' prices the image at a fraction of what it costs."]);
        } else if (reason === "image_no_rate") {
          notes.push(["bad", "This model returns an image but publishes no image output rate, so its image tokens are charged at the text output rate. That figure is a floor, not a price, and it is unverified."]);
        } else if (reason.indexOf("no_") === 0) {
          notes.push(["bad", "This route does not publish a price for part of this workload, so no honest monthly figure exists for it. It is reported as unprojectable rather than as zero."]);
        }
      });
    }

    // Candidates that could not be priced at all are named, because a blank cell is otherwise
    // indistinguishable from a bug in the page.
    CANDIDATES.forEach(function (c, i) {
      var r = results[i];
      if (promptTokens == null) return;
      // Named by route as well as by model. The same open-weight model is on the shortlist twice,
      // through two different aggregators, and one of them never completed a run. Saying "Gemma has
      // no measured profile" would be false about the other row.
      var label = c.name + " via route " + c.route + (c.provider ? " (" + c.provider + ")" : "");
      if (r && !r.complete) {
        notes.push(["info", label + " cannot be projected at all: this route publishes no price for part of the workload, so it is unprojectable rather than free."]);
      }
      if (!r) {
        notes.push(["info", label + " has no measured token profile, so it is not priced here. Its cost would have to come from the buyer's guess, and a guess compared against a measurement is the comparison this report exists to refuse."]);
      }
    });

    if (volume != null && volume > 0 && measuredMonthly != null) {
      var perThousand = (measuredMonthly / volume) * 1000;
      notes.push(["info", "At your volume that is " + fmt(perThousand, 4) + " per thousand requests."]);
    }

    // State plainly what this panel is not. Its figure and the waterfall's figure are both correct
    // and they are different numbers, because they price different configurations. Left unsaid, that
    // reads as the page contradicting itself, which for this project would be the worst failure
    // available.
    $("out-scope").textContent = measuredMonthly == null
      ? ""
      // The image tab renders no second gap box. The unguarded sentence sent a reader looking for a
      // box that was hidden. The first attempt at a replacement said image models sell no caching,
      // which is false about the model on this very tab - the routes table below prints the
      // cache-read rate it publishes. What is true, and is the actual reason, is that the measured
      // run served no prompt token from cache, so the box would hold nothing.
      : kind === "image"
        ? "This is your configuration priced at measured rates, not the measurement. There is no " +
          "second gap box here: the measured run served no prompt token from cache, so the one " +
          "mechanic your inputs cannot express is worth nothing on this workload, and a box reading " +
          "$0.00 beside a mechanic reads as a saving nobody took. The waterfall above prices the " +
          "buyer's configuration end to end and attributes the full gap across every mechanic."
        : "This is your configuration priced at measured rates, not the measurement. Its " +
          "gap box counts caching only, because caching is the one mechanic your inputs cannot " +
          "express. The waterfall above prices the buyer's configuration end to end and attributes " +
          "the full gap across every mechanic.";

    $("out-notes").innerHTML = notes
      .map(function (n) { return '<div class="flag ' + (n[0] === "info" ? "info" : n[0] === "bad" ? "bad" : "") + '">' + n[1] + "</div>"; })
      .join("");
  }

  ["in-volume", "in-prompt", "in-output", "in-estimate"].forEach(function (id) {
    var el = $(id);
    if (el && el.addEventListener) el.addEventListener("input", render);
  });

  // The tabs. Click and the two arrow keys a tablist is expected to answer to, so the control is
  // reachable without a mouse. Selecting a tab re-points the one panel of inputs at that workload's
  // own measurements, which is the whole reason it is one panel rather than two.
  var tabButtons = $("panel-0") ? document.querySelectorAll("[data-tab]") : [];
  for (var b = 0; b < tabButtons.length; b += 1) {
    (function (btn) {
      var index = Number(btn.getAttribute("data-tab"));
      btn.addEventListener("click", function () { activate(index); });
      btn.addEventListener("keydown", function (e) {
        var step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        var next = (index + step + DATA.workloads.length) % DATA.workloads.length;
        activate(next);
        var sibling = document.querySelector('[data-tab="' + next + '"]');
        if (sibling && sibling.focus) sibling.focus();
      });
    })(tabButtons[b]);
  }

  activate(0);
})();
</script>
</body>
</html>
`;
}
