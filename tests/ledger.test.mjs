/**
 * Day 4 tests: the estimate-versus-measured ledger.
 *
 * The ledger is the headline of the project, so it gets the strictest tests in the suite. Most of
 * them exist to pin one property: that the tool never collapses two different errors into one
 * number, and never presents a step as a finding when the mechanic behind it did not run.
 *
 * Every expected value below is the one the real GPT-4o mini data produces, not a number chosen to
 * make an assertion pass. The buyer's own assumptions cost $5.10/month, the measurement says
 * $4.80/month, and the bridge between them is $0.30. If a change to the engine breaks any of those
 * three, this file fails rather than quietly reporting a new figure.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normaliseOpenRouterModel, normaliseHuggingFaceModel } from "../core/catalogue.mjs";
import {
  buildLedger,
  ledgerHeadline,
  renderLedger,
  configFromBuyerEstimate,
  configFromMeasured,
} from "../core/ledger.mjs";
import { buildReportModel, renderReportHtml } from "../core/report.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** GPT-4o mini, the buyer's incumbent: a cache rate, no tiers, no reasoning price. */
const incumbent = (over = {}) =>
  normaliseOpenRouterModel({
    id: "openai/gpt-4o-mini",
    canonical_slug: "openai/gpt-4o-mini",
    name: "GPT-4o mini",
    context_length: 128000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: {
      prompt: "0.00000015",
      completion: "0.0000006",
      input_cache_read: "0.000000075",
      ...over.pricing,
    },
    ...over.rest,
  });

/** The buyer's stated assumptions, exactly as samples/workload.legal.json records them. */
const buyerEstimate = (over = {}) => ({
  assumed_input_tokens_per_request: 1500,
  assumed_output_tokens_per_request: 50,
  assumed_cost_per_month_usd: 18.0,
  ...over,
});

/** What the Day 2 run actually measured for the incumbent. */
const measured = (over = {}) => ({
  input_tokens_per_call: 3000,
  cached_input_tokens_per_call: 2944,
  output_tokens_per_call: 18,
  reasoning_tokens_per_call: 0,
  calls_per_month: 20000,
  per_call_counts: { image: 0, web_search: 0, request: 0 },
  ...over,
});

const VOLUME = 20000;

const step = (ledger, key) => ledger.steps.find((s) => s.key === key);

// ---------------------------------------------------------------------------
// the two gaps, kept apart
// ---------------------------------------------------------------------------

test("the buyer's own assumptions are priced, and they do not produce the buyer's own estimate", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  // 1500 in at $0.15/M + 50 out at $0.60/M = $0.000255/call, times 20,000 = $5.10
  assert.equal(Number(l.own_assumptions_usd.toFixed(6)), 5.1);
  assert.equal(l.stated_estimate_usd, 18.0);
});

test("the arithmetic gap is reported separately from the modelling gap", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  // The buyer wrote down $18 for assumptions that cost $5.10. That is a $12.90 error that no
  // measurement could have caught, because it is not a measurement error.
  assert.equal(Number(l.arithmetic_gap_usd.toFixed(6)), 12.9);
  // The measurement then corrects $5.10 down to $4.80. This fixture pins the cache count to a
  // round 2,944, so the gap is exactly $0.30; the live profile carries a mean cache hit count and
  // lands on $0.3015. Both are the same correction, and the reconciliation test below is what
  // actually holds the arithmetic together.
  assert.equal(Number(l.modelling_gap_usd.toFixed(6)), 0.3);
  // The combined figure exists but is never the only one reported.
  assert.equal(Number(l.total_gap_usd.toFixed(6)), 13.2);
  assert.equal(Number(l.arithmetic_ratio.toFixed(4)), Number((18 / 5.1).toFixed(4)));
});

test("the two ratios are materially different, which is the whole reason for splitting them", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  // 3.53x is arithmetic; 1.06x is measurement. Reporting only the combined 3.75x would blame
  // measurement for a mistake the buyer made with a calculator.
  assert.ok(l.arithmetic_ratio > 3.5, `arithmetic ratio was ${l.arithmetic_ratio}`);
  assert.ok(l.modelling_ratio < 1.1, `modelling ratio was ${l.modelling_ratio}`);
  assert.ok(l.total_ratio > 3.7, `total ratio was ${l.total_ratio}`);
});

test("an estimate that matches the buyer's own arithmetic produces no arithmetic gap", () => {
  const l = buildLedger(incumbent(), buyerEstimate({ assumed_cost_per_month_usd: 5.1 }), measured(), VOLUME);
  // Math.abs because 5.1 minus the priced 5.1000000000000005 is -4.4e-16, which toFixed renders as
  // "-0.0000000000". The sign is float noise, not an undershoot, and the renderer already treats
  // anything under half a cent as zero.
  assert.equal(Math.abs(l.arithmetic_gap_usd) < 1e-9, true);
  assert.equal(ledgerHeadline(l).includes("wrong twice over"), false);
});

// ---------------------------------------------------------------------------
// the bridge
// ---------------------------------------------------------------------------

test("the bridge steps sum to the modelling gap, exactly", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  assert.equal(l.reconciles, true);
  assert.equal(l.step_sum_usd, l.modelling_gap_usd);
});

test("the bridge starts at the buyer's own cost and ends at the measured one", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  assert.equal(l.steps[0].before_usd, l.own_assumptions_usd);
  assert.equal(l.steps[l.steps.length - 1].after_usd, l.measured_usd);
});

test("the prompt growing is reported as more expensive, and caching as less", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  const prompt = step(l, "input_tokens_per_call");
  const cache = step(l, "cached_input_tokens_per_call");

  // The sign convention: saving_usd is positive when a step made the bill CHEAPER. A 1,500 to
  // 3,000 token prompt is not a saving, and an earlier version of the renderer printed it in the
  // same column as the cache discount, where the two read as pushing the same way.
  assert.ok(prompt.saving_usd < 0, `prompt step saving was ${prompt.saving_usd}`);
  assert.ok(cache.saving_usd > 0, `cache step saving was ${cache.saving_usd}`);

  const rendered = renderLedger(l);
  const promptLine = rendered.split("\n").find((line) => line.includes("Prompt size"));
  const cacheLine = rendered.split("\n").find((line) => line.includes("Prompt caching"));
  assert.ok(promptLine.includes("+$"), `prompt line had no positive sign: ${promptLine}`);
  assert.ok(cacheLine.includes("-$"), `cache line had no negative sign: ${cacheLine}`);
});

test("a step's figure is what it was worth given everything changed before it", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  // Chained, not independent: each step's before_usd is the previous step's after_usd.
  for (let i = 1; i < l.steps.length; i += 1) {
    assert.equal(l.steps[i].before_usd, l.steps[i - 1].after_usd);
  }
});

test("the order of the steps is printed rather than left implicit", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  assert.ok(l.order_note.includes("different per-step figures"));
  assert.deepEqual(
    l.steps.map((s) => s.key),
    [
      "input_tokens_per_call",
      "output_tokens_per_call",
      "cached_input_tokens_per_call",
      "reasoning_tokens_per_call",
    ]
  );
});

// ---------------------------------------------------------------------------
// refusal, which is the honest output when there is nothing to compare
// ---------------------------------------------------------------------------

test("no measured profile means no ledger, with a reason rather than a bridge from guesses", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), null, VOLUME);
  assert.equal(l.available, false);
  assert.ok(l.reason.includes("no measured token profile"));
  // The stated estimate survives, because that part is still a fact about the buyer.
  assert.equal(l.stated_estimate_usd, 18.0);
  // And nothing that looks like a computed bridge leaks out of a refusal.
  assert.equal(l.steps, undefined);
  assert.equal(l.model, undefined);
});

test("no volume means no ledger, because there is no monthly cost to compare", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured({ calls_per_month: null }), null);
  assert.equal(l.available, false);
  assert.ok(l.reason.includes("no monthly volume"));
});

test("the renderer states the refusal instead of printing an empty waterfall", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), null, VOLUME);
  const rendered = renderLedger(l);
  assert.ok(rendered.includes("no ledger"));
  assert.ok(rendered.includes("no measured token profile"));
});

test("a missing model is a programming error, not a silent null", () => {
  assert.throws(() => buildLedger(null, buyerEstimate(), measured(), VOLUME), /needs a catalogue model/);
});

// ---------------------------------------------------------------------------
// mechanics that did not run are explained, not zeroed
// ---------------------------------------------------------------------------

test("a route with no cache rate reports no saving and says why", () => {
  // Gemma on OpenRouter publishes no cache-read price at all, so there is no discount to apply.
  const noCache = normaliseOpenRouterModel({
    id: "google/gemma-3-4b-it",
    canonical_slug: "google/gemma-3-4b-it",
    name: "Gemma 3 4B",
    context_length: 131072,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.00000005", completion: "0.0000001" },
  });
  const l = buildLedger(noCache, buyerEstimate(), measured(), VOLUME);
  const cache = step(l, "cached_input_tokens_per_call");

  assert.equal(cache.saving_usd, 0);
  assert.ok(cache.note.includes("no cache-read rate"));
  // The distinction that matters: no discount exists here, rather than a discount nobody took.
  assert.equal(cache.note.includes("never taken"), false);
});

test("a cache rate that exists but went unused is described as an untaken discount", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured({ cached_input_tokens_per_call: 0 }), VOLUME);
  const cache = step(l, "cached_input_tokens_per_call");
  assert.equal(cache.saving_usd, 0);
  assert.ok(cache.note.includes("never taken"));
});

test("a workload with no reasoning is not given a paragraph about reasoning rates", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  const reasoning = step(l, "reasoning_tokens_per_call");
  assert.equal(reasoning.saving_usd, 0);
  assert.ok(reasoning.note.includes("billed for no reasoning tokens"));
  assert.ok(reasoning.note.includes("did not apply"));
});

test("a reasoning model that was billed for reasoning says so in dollars", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured({ reasoning_tokens_per_call: 160 }), VOLUME);
  const reasoning = step(l, "reasoning_tokens_per_call");
  // 160 tokens at the $0.60/M output rate, 20,000 calls = $1.92/month that appears nowhere in the
  // answer the user reads.
  assert.equal(Number(reasoning.saving_usd.toFixed(6)), -1.92);
  assert.ok(reasoning.note.includes("never appear in the answer"));
});

test("a reasoning volume the buyer already assumed is not attributed to the measurement", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured({ reasoning_tokens_per_call: 0 }), VOLUME);
  assert.equal(step(l, "reasoning_tokens_per_call").note.includes("already assumed"), false);
});

test("mechanics this route never exercised are listed as absent, not as zero", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  const named = l.unexercised.map((u) => u.mechanic);
  assert.ok(named.includes("tiered rates"));
  assert.ok(named.includes("per-call charges"));
  assert.ok(named.includes("provider choice"));
  for (const u of l.unexercised) {
    assert.ok(u.why.length > 10, `"${u.mechanic}" had no explanation`);
  }
});

test("a per-call charge outside token arithmetic is not listed as unexercised", () => {
  const withSearch = measured({
    per_call_counts: { image: 0, web_search: 2, request: 0 },
  });
  const l = buildLedger(incumbent(), buyerEstimate(), withSearch, VOLUME);
  assert.equal(l.unexercised.some((u) => u.mechanic === "per-call charges"), false);
});

test("crossing a tier is annotated on the step that caused it, not listed as a separate lever", () => {
  const tiered = normaliseOpenRouterModel({
    id: "openai/tiered-example",
    canonical_slug: "openai/tiered-example",
    name: "Tiered example",
    context_length: 200000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: {
      prompt: "0.00000015",
      completion: "0.0000006",
      overrides: [{ min_prompt_tokens: 2000, prompt: "0.00000030", completion: "0.0000006" }],
    },
  });
  const l = buildLedger(tiered, buyerEstimate(), measured(), VOLUME);
  const prompt = step(l, "input_tokens_per_call");
  assert.ok(prompt.note.includes("crossed a pricing tier at 2000"));
  assert.equal(l.steps.some((s) => s.key === "tiered_rates"), false);
});

test("a tier that is never crossed is not claimed to have been", () => {
  const tiered = normaliseOpenRouterModel({
    id: "openai/tiered-example",
    canonical_slug: "openai/tiered-example",
    name: "Tiered example",
    context_length: 200000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: {
      prompt: "0.00000015",
      completion: "0.0000006",
      overrides: [{ min_prompt_tokens: 8000, prompt: "0.00000030", completion: "0.0000006" }],
    },
  });
  const l = buildLedger(tiered, buyerEstimate(), measured(), VOLUME);
  assert.equal(step(l, "input_tokens_per_call").note, null);
  assert.ok(l.unexercised.some((u) => u.mechanic === "tiered rates"));
});

// ---------------------------------------------------------------------------
// configuration helpers
// ---------------------------------------------------------------------------

test("the buyer's config carries no cache and no reasoning, because the buyer assumed neither", () => {
  const c = configFromBuyerEstimate(buyerEstimate(), VOLUME);
  assert.equal(c.cached_input_tokens_per_call, 0);
  assert.equal(c.reasoning_tokens_per_call, 0);
  assert.equal(c.calls_per_month, VOLUME);
});

test("a buyer estimate with no stated token counts is zero, not NaN", () => {
  const c = configFromBuyerEstimate({}, VOLUME);
  assert.equal(c.input_tokens_per_call, 0);
  assert.equal(c.output_tokens_per_call, 0);
});

test("the measured config takes its volume from the caller when one is given", () => {
  const c = configFromMeasured(measured(), 500);
  assert.equal(c.calls_per_month, 500);
  assert.equal(c.cached_input_tokens_per_call, 2944);
});

// ---------------------------------------------------------------------------
// presentation
// ---------------------------------------------------------------------------

test("the headline names both errors and says only one of them is a measurement problem", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  const h = ledgerHeadline(l);
  assert.ok(h.includes("$18.00"));
  assert.ok(h.includes("$5.10"));
  assert.ok(h.includes("$4.80"));
  assert.ok(h.includes("only the second one"));
});

test("every dollar figure in the rendered bridge carries an explicit sign", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  const rendered = renderLedger(l);
  // No non-zero figure in the waterfall column is left without a direction. "4.50" next to "-4.42"
  // reads as though both went the same way.
  for (const line of rendered.split("\n")) {
    if (!line.includes("→") && !line.includes("assumed")) continue;
    const figures = line.match(/\s[+-]?\$\d+\.\d\d/g) ?? [];
    for (const f of figures) {
      // $0.00 is the one correct unsigned form: a step worth nothing has no direction, and
      // "+$0.00" would assert one.
      if (f.includes("0.00")) continue;
      assert.ok(/[+-]\$/.test(f), `unsigned figure "${f.trim()}" in: ${line.trim()}`);
    }
  }
});

test("the rendered bridge says out loud whether it reconciled", () => {
  const l = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  assert.ok(renderLedger(l).includes("The bridge reconciles"));
});

// ---------------------------------------------------------------------------
// the HF route, which is where the same workload can cost something else entirely
// ---------------------------------------------------------------------------

test("route B's ledger is built from the provider actually chosen, not the cheapest one", () => {
  const hf = normaliseHuggingFaceModel({
    id: "google/gemma-3-4b-it",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    providers: [
      { provider: "deepinfra", status: "live", pricing: { input: 0.05, output: 0.1 } },
      { provider: "cheap-host", status: "live", pricing: { input: 0.01, output: 0.02 } },
    ],
  });
  const l = buildLedger(hf, buyerEstimate(), measured(), VOLUME);
  // The normaliser selects the cheapest live provider for route B, and the ledger must price the
  // model it was handed rather than re-deciding the route.
  assert.equal(l.measured_config.input_tokens_per_call, 3000);
  assert.equal(Number(l.own_assumptions_usd.toFixed(6)), Number(((1500 / 1e6) * 0.01 * VOLUME + (50 / 1e6) * 0.02 * VOLUME).toFixed(6)));
});

test("route B's ledger says cache is unavailable rather than silently charging the cache rate", () => {
  const hf = normaliseHuggingFaceModel({
    id: "google/gemma-3-4b-it",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    providers: [{ provider: "deepinfra", status: "live", pricing: { input: 0.05, output: 0.1 } }],
  });
  const l = buildLedger(hf, buyerEstimate(), measured(), VOLUME);
  const cache = step(l, "cached_input_tokens_per_call");
  // Every prompt token is charged at the full rate, so the cache step is worth nothing here. It
  // must not be reported as a saving the buyer could have had.
  assert.equal(cache.saving_usd, 0);
  assert.ok(cache.note.includes("no cache-read rate"));
});

// ---------------------------------------------------------------------------
// the printed column, which the reader can add up
// ---------------------------------------------------------------------------

const WORKLOAD = {
  workload_name: "Legal contract review",
  workload_kind: "text",
  monthly_requests: VOLUME,
  quality_bar: { min_correct_share: 0.75, max_hallucinations: 0 },
  buyer_estimate: {
    assumed_input_tokens_per_request: 1500,
    assumed_output_tokens_per_request: 50,
    assumed_cost_per_month_usd: 18.0,
  },
};

const renderedPage = (ledger) =>
  renderReportHtml(
    buildReportModel({ workload: WORKLOAD, candidates: [], ledger, routes: [], catalogueMeta: {} })
  );

/** The column as a reader adds it: the stated estimate, then every row that is a change. */
function readerArithmetic(ledger) {
  const r = (n) => Math.round(n * 100) / 100;
  const changes = [
    ...(ledger.arithmetic_gap_usd !== null && Math.abs(ledger.arithmetic_gap_usd) > 0.005
      ? [-ledger.arithmetic_gap_usd]
      : []),
    ...ledger.steps.map((s) => -(s.saving_usd ?? 0)),
  ];
  return {
    sum: r(ledger.stated_estimate_usd + changes.reduce((a, n) => a + r(n), 0)),
    total: r(ledger.measured_usd),
  };
}

test("the printed column either adds up or the page says how far off it is", () => {
  // The engine checks the bridge against its own unrounded figures. This checks the thing a reader
  // actually does: add the numbers printed on the screen, each of which is money rounded to the
  // cent. On this data they land a cent apart - 18.00, -12.90, +4.50, -0.39, -4.42, +0.00 comes to
  // 4.79 while the total row prints 4.80 - and the prose beside the table used to assert flatly that
  // "the steps sum to the whole gap". True of the arithmetic, false of the page.
  const ledger = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  const html = renderedPage(ledger);
  const { sum, total } = readerArithmetic(ledger);

  assert.ok(ledger.reconciles, "this fixture is meant to close: the engine should agree");
  if (sum === total) {
    assert.equal(
      html.includes("plus every change below it comes to"),
      false,
      "the page explained a rounding difference that is not there"
    );
  } else {
    assert.ok(
      html.includes(`plus every change below it comes to $${sum.toFixed(2)} against the $${total.toFixed(2)}`),
      `the column prints ${sum} against a total of ${total} and the page does not say so`
    );
    // And it has to give the figure that does close, or the reader is left with two numbers and no
    // way to tell which one the project stands behind.
    assert.ok(
      html.includes(`closes to $${ledger.measured_usd.toFixed(4)}`),
      "the page did not give the unrounded figure the bridge actually closes to"
    );
  }
});

test("a bridge that does not close is reported as wrong, not as approximate", () => {
  // The other branch of the same note, and the one that matters more: if the decomposition itself is
  // broken then every per-step figure above it is suspect, and "rounded to the cent" would be a
  // shrug dressed as an explanation.
  const real = buildLedger(incumbent(), buyerEstimate(), measured(), VOLUME);
  const broken = { ...real, reconciles: false, step_sum_usd: 0.1, modelling_gap_usd: 0.3 };
  const html = renderedPage(broken);

  assert.ok(html.includes("These steps do not close"), "a bridge that does not close rendered silently");
  assert.ok(html.includes("$0.10"), "the step sum that disagrees is not shown");
  assert.ok(html.includes("$0.30"), "the gap it disagrees with is not shown");
  // The rounding note and the failure note are different claims and must not both appear.
  assert.equal(html.includes("plus every change below it comes to"), false);
});
