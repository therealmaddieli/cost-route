/**
 * Day 4 tests: the procurement-routes table.
 *
 * This table's whole job is to keep three kinds of number from being read as one, so the tests are
 * mostly about what it refuses: a route with no price, a candidate with no measurement, an argument
 * that does not belong to the route it is printed under.
 *
 * Two of these pin bugs that shipped and were caught by looking at the rendered page rather than by
 * any test. Both were invisible to the earlier suite because the module was only ever exercised
 * through functions that returned numbers, never through the table a reader sees.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normaliseOpenRouterModel, normaliseHuggingFaceModel } from "../core/catalogue.mjs";
import { buildRouteTable, prosAndCons, selfHostEstimate } from "../core/routes.mjs";
import { renderReportHtml, buildReportModel } from "../core/report.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const openRouterModel = () =>
  normaliseOpenRouterModel({
    id: "openai/gpt-4o-mini",
    canonical_slug: "openai/gpt-4o-mini",
    name: "GPT-4o mini",
    context_length: 128000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000075" },
  });

const openWeightOnOpenRouter = () =>
  normaliseOpenRouterModel({
    id: "google/gemma-3-4b-it",
    canonical_slug: "google/gemma-3-4b-it",
    name: "Gemma 3 4B",
    context_length: 131072,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.00000005", completion: "0.0000001" },
  });

const hfModel = () =>
  normaliseHuggingFaceModel({
    id: "google/gemma-3-4b-it",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    providers: [
      { provider: "deepinfra", status: "live", pricing: { input: 0.05, output: 0.1 } },
      { provider: "other-host", status: "live" },
    ],
  });

const WORKLOAD = {
  workload_name: "Legal contract review",
  workload_kind: "text",
  monthly_requests: 20000,
  quality_bar: { min_correct_share: 0.75, max_hallucinations: 0 },
  buyer_estimate: {
    assumed_input_tokens_per_request: 1500,
    assumed_output_tokens_per_request: 50,
    assumed_cost_per_month_usd: 18.0,
  },
};

/**
 * The page with its script block removed.
 *
 * The assertions below slice the HTML from a heading to the end of the document and look for a
 * string, which is a fine way to ask "did a route row render a zero price" until the shipped script
 * contains that same string in a comment - and then it fails for a reason that has nothing to do
 * with the table. What is being tested is the markup, so the markup is what gets looked at. This is
 * also what makes those assertions safe to extend: any future copy in the script is out of scope by
 * construction rather than by careful wording.
 */
const markup = (html) => html.replace(/<script>[\s\S]*?<\/script>/g, "");

const rowFor = (routes, model) => routes.find((r) => r.model === model.slug);
const textOf = (list) => (list ?? []).join(" ");

// ---------------------------------------------------------------------------
// the arguments belong to the route, not to the catalogue the price came from
// ---------------------------------------------------------------------------

test("an open-weight model served by an aggregator is not told it is vendor-locked", () => {
  // The bug this pins: the branch was `entry.source === "openrouter"`, so Gemma 3 4B, which
  // OpenRouter quotes but does not own, was rendered under "Route B / Open weights, served by a
  // third party" and then told its vendor could withdraw the model. Open weights are the one case
  // where that is not true, and the row was contradicting its own heading.
  const model = openWeightOnOpenRouter();
  const { cons } = prosAndCons(model, { route: "B" });
  assert.equal(textOf(cons).includes("Vendor lock"), false, textOf(cons));
});

test("a closed model on route A is still told it is vendor-locked", () => {
  const { cons } = prosAndCons(openRouterModel(), { route: "A" });
  assert.ok(textOf(cons).includes("Vendor lock"), "the lock warning disappeared from route A");
});

test("a route-B row still gets the reachability argument, because it is reached through one endpoint", () => {
  const { pros } = prosAndCons(openWeightOnOpenRouter(), { route: "B" });
  assert.ok(textOf(pros).includes("One endpoint and one key"), textOf(pros));
});

test("a route that publishes no cache rate says so, on either route", () => {
  // Also a shipped bug: this argument was inside the route-B branch, so the OpenRouter-priced
  // Gemma row, which publishes no cache-read rate either, never carried it.
  const viaAggregator = prosAndCons(openWeightOnOpenRouter(), { route: "B" });
  const viaHub = prosAndCons(hfModel(), { route: "B" });

  assert.ok(textOf(viaAggregator.cons).includes("no cache-read rate") || textOf(viaAggregator.cons).includes("No cache pricing"));
  assert.ok(textOf(viaHub.cons).includes("No cache pricing"));
});

test("a published cache rate is quoted as a rate and paired with what was measured", () => {
  const { pros } = prosAndCons(openRouterModel(), {
    route: "A",
    measured: { effective_input_per_m: 0.0764, cache_hit_rate: 0.9813 },
  });
  const text = textOf(pros);
  assert.ok(text.includes("Publishes a cache-read rate"), text);
  // The list price and the rate actually paid are different numbers and the row has to show both,
  // because it is the difference that decides the argument.
  assert.ok(text.includes("Measured effective input rate on this workload"), text);
});

// ---------------------------------------------------------------------------
// the monthly column, which was blank in every row that had a price
// ---------------------------------------------------------------------------

const reportWith = (routes, candidates = []) =>
  renderReportHtml(
    buildReportModel({
      workload: WORKLOAD,
      candidates,
      routes,
      catalogueMeta: { fetched_at: "2026-09-15T09:00:00.000Z" },
    })
  );

test("a quoted route prints the monthly figure it was given", () => {
  const rows = buildRouteTable([{ route: "A", model: openRouterModel(), monthly_cost: 4.8 }]).rows;
  assert.equal(rows[0].monthly_cost, 4.8);
  assert.ok(reportWith(rows).includes("$4.80"));
});

test("the whole monthly column is not blank, which is what shipped before this test existed", () => {
  // buildRouteTable reads e.monthly_cost and the generator never set it, so every priced row
  // rendered "n/a" while the candidates table two sections above priced the same models to the
  // cent. Nothing failed: the column was simply empty, and the page looked like the catalogue had
  // no prices in it.
  const rows = buildRouteTable([
    { route: "A", model: openRouterModel(), monthly_cost: 4.8 },
  ]).rows;
  const html = reportWith(rows);
  const routeSection = markup(html).slice(markup(html).indexOf("The three procurement routes"));
  assert.ok(routeSection.includes("$4.80"), "the routes table printed no monthly figure");
  assert.equal(routeSection.includes(">n/a<"), false, "a priced route still rendered n/a");
});

test("a candidate with no measurement is unprojectable, not free and not guessed", () => {
  const rows = buildRouteTable([{ route: "B", model: hfModel(), monthly_cost: null }]).rows;
  assert.equal(rows[0].monthly_cost, null);

  const routeSection = markup(reportWith(rows)).slice(
    markup(reportWith(rows)).indexOf("The three procurement routes")
  );
  // The reason has to be printed. A blank monthly cell on a row that has a per-call price is
  // otherwise indistinguishable from a broken table.
  assert.ok(routeSection.includes("no measured profile"), routeSection.slice(0, 400));
  assert.equal(routeSection.includes("$0.00"), false, "an unmeasured candidate was priced at zero");
});

test("route C is never given a monthly cost, however tempting the estimate is", () => {
  const estimate = selfHostEstimate(
    { calls_per_month: 20000, input_tokens_per_call: 3000, output_tokens_per_call: 18 },
    {}
  );
  const rows = buildRouteTable([{ route: "C", model: null, estimate }]).rows;

  // The structural guarantee, not a formatting one: the field is null and the number lives under a
  // different key, so nothing downstream can sort it into a price column.
  assert.equal(rows[0].monthly_cost, null);
  assert.ok(rows[0].estimate.estimate_low_usd > 0);
  assert.equal(rows[0].cost_kind, "estimate");
});

// ---------------------------------------------------------------------------
// telling two offers of the same model apart
// ---------------------------------------------------------------------------

test("the same model on the same route through two platforms renders as two distinguishable rows", () => {
  const rows = buildRouteTable([
    { route: "B", model: hfModel(), monthly_cost: null },
    { route: "B", model: openWeightOnOpenRouter(), monthly_cost: 1.6 },
  ]).rows;

  assert.equal(rows.length, 2);
  assert.equal(rows[0].model, rows[1].model, "the fixture should share a slug");
  // Same slug, same route, different purchase. Without the platform line these two rows are
  // identical except for their prices, which reads as the page contradicting itself.
  assert.notEqual(rows[0].platform, rows[1].platform);
  assert.equal(rows[0].provider, "deepinfra", "the provider whose price was used was not recorded");
});

test("the route table names the provider the figure actually came from", () => {
  const rows = buildRouteTable([{ route: "B", model: hfModel(), monthly_cost: 6.0 }]).rows;
  // The normaliser prices route B at the cheapest live provider that publishes a price, so that is
  // the provider the monthly figure describes. Naming the first listed provider instead would
  // attribute the number to an offer nobody quoted.
  assert.equal(rows[0].provider, hfModel().cheapest_provider);
});

// ---------------------------------------------------------------------------
// the caveat travels with the table
// ---------------------------------------------------------------------------

test("the route table states that its figures are fixed and are not the candidates table", () => {
  const rows = buildRouteTable([{ route: "A", model: openRouterModel(), monthly_cost: 4.8 }]).rows;
  const html = reportWith(rows);
  // Both tables print a monthly figure for the same model and the two differ, because one prices
  // the measured configuration and the other prices whatever is in the reader's input boxes. Left
  // unexplained that is the page appearing to disagree with itself.
  assert.ok(html.includes("measured"), "no explanation of what the route figures price");
  assert.ok(/they are fixed|are fixed/i.test(html), "the page never says these figures do not move");
});

test("the table renders with no rows at all rather than throwing", () => {
  assert.equal(reportWith([]).includes("<!doctype html>"), true);
});

// ---------------------------------------------------------------------------
// the facts on the row, which were silently missing
// ---------------------------------------------------------------------------

test("a licence lifted out of the model card reaches the row, not a claim that none could be read", () => {
  // The generator hands over `licence` and `gated` as flat keys; this function read `hub.cardData`
  // and `hub.gated`. Neither matched, so every row said "No licence could be read from the model
  // card" while the card in hand said `license: gemma`. A confident statement of ignorance, made
  // about a document that had been fetched successfully.
  const { pros, cons } = prosAndCons(openWeightOnOpenRouter(), {
    route: "B",
    licence: "gemma",
    gated: false,
  });

  assert.ok(textOf(pros).includes('"gemma"'), textOf(pros));
  assert.equal(textOf(cons).includes("No licence could be read"), false, textOf(cons));
});

test("the raw Hub card still works, because two callers pass two shapes", () => {
  const { cons } = prosAndCons(openWeightOnOpenRouter(), {
    route: "B",
    hub: { cardData: { license: "gemma" }, gated: "manual" },
  });
  assert.ok(textOf(cons).includes('gated: "manual"'), textOf(cons));
});

test("gating reported as false is not reported as gated", () => {
  const { cons } = prosAndCons(openWeightOnOpenRouter(), {
    route: "B",
    licence: "apache-2.0",
    gated: false,
  });
  assert.equal(textOf(cons).includes("Gated"), false, textOf(cons));
});

test("a model quoted by a closed aggregator is not described as having no provider at all", () => {
  // OpenRouter exposes no per-provider list, so `providers` is empty. Read as "nothing is live"
  // this printed "there is no route to serve this model at all" about a model the benchmark beside
  // it had just completed nine calls on.
  const { cons } = prosAndCons(openWeightOnOpenRouter(), {
    route: "B",
    licence: "gemma",
    gated: false,
  });
  assert.equal(textOf(cons).includes("No provider is currently live"), false, textOf(cons));
  assert.equal(textOf(cons).includes("Only one provider is live"), false, textOf(cons));
});

test("the Hugging Face route still reports a single live provider as lock-in", () => {
  // The fix above must not silence the real case it was written for.
  const solo = normaliseHuggingFaceModel({
    id: "some/model",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    providers: [{ provider: "only", status: "live", pricing: { input: 0.1, output: 0.2 } }],
  });
  const { cons } = prosAndCons(solo, { route: "B" });
  assert.ok(textOf(cons).includes("Only one provider is live"), textOf(cons));
});
