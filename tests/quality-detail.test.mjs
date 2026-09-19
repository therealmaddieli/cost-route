/**
 * Tests for the three things the candidates table used to throw away.
 *
 * The page held all of this in its own JSON payload and rendered none of it:
 *
 *   1. how many calls each candidate's route actually served, and what the failures were
 *   2. quality as correct-of-answered rather than correct-of-everything, and the reason a candidate
 *      failed printed on that candidate's row rather than only in the incumbent's callout
 *   3. the same measurement re-cut by question kind, which is the only view that shows what the
 *      candidates actually separate on
 *
 * The failure mode these guard against is specific and worth naming, because it is the reason the
 * project exists. Every number was present, no exception was thrown, and the page printed "6/14
 * correct" for a model that answered six of the nine questions it was served. Five calls that came
 * back as HTTP 429 were silently scored as wrong answers. A page that does that is doing the same
 * thing as the estimate it was built to correct: producing a confident figure whose stated basis is
 * not the basis it was computed from.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { byKind, errorKinds, summarise, evaluateCandidate } from "../core/scorer.mjs";
import { normaliseOpenRouterModel } from "../core/catalogue.mjs";
import { buildReportModel, renderReportHtml } from "../core/report.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const WORKLOAD = {
  workload_name: "Legal contract review",
  workload_kind: "text",
  monthly_requests: 20000,
  quality_bar: { min_correct_share: 0.75, max_hallucinations: 0 },
  question_kinds: {
    fact: "Stated in one clause",
    multi_hop: "Needs two clauses combined",
    absent: "Not answered by the contract",
  },
  buyer_estimate: {
    assumed_input_tokens_per_request: 1500,
    assumed_output_tokens_per_request: 50,
    assumed_cost_per_month_usd: 18.0,
  },
};

const model = (name, slug) =>
  normaliseOpenRouterModel({
    id: slug,
    canonical_slug: slug,
    name,
    context_length: 128000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.00000015", completion: "0.0000006", input_read_cache: "0.000000075" },
  });

/** A candidate record as the renderer receives it. `quality` is built by hand here. */
const entry = (name, slug, quality, over = {}) => ({
  key: `openrouter:${slug}`,
  model: model(name, slug),
  route: "A",
  provider: null,
  incumbent: false,
  measured: null,
  effective_input_per_m: null,
  quality,
  ...over,
});

/** One per-kind bucket, with the defaults a passing candidate would have. */
const bucket = (kind, over = {}) => ({
  kind,
  asked: 10,
  scored: 10,
  correct: 10,
  incorrect: 0,
  not_served: 0,
  fabricated: 0,
  ...over,
});

const QUALITY_PERFECT = {
  verdict: "PASS",
  fail_reasons: [],
  total: 14,
  scored: 14,
  not_served: 0,
  correct: 14,
  incorrect: 0,
  correct_share: 1,
  hallucination_count: 0,
  error_count: 0,
  latency_ms: { p50: 500, p95: 1200 },
  error_kinds: {},
  by_kind: [bucket("fact"), bucket("multi_hop", { asked: 3, scored: 3, correct: 3 }), bucket("absent", { asked: 1, scored: 1, correct: 1 })],
};

/** The Gemma shape: five calls lost to a rate limit, and wrong answers on the rest. */
const QUALITY_PARTIAL = {
  verdict: "FAIL",
  fail_reasons: ["quality 67% is below the 75% bar (6/9 correct)", "2 hallucination flags; the bar allows 0", "5 of 14 calls failed"],
  total: 14,
  scored: 9,
  not_served: 5,
  correct: 6,
  incorrect: 3,
  correct_share: 6 / 9,
  hallucination_count: 2,
  error_count: 5,
  latency_ms: { p50: 263, p95: 742 },
  error_kinds: { 429: 5 },
  by_kind: [
    bucket("fact", { asked: 10, scored: 5, correct: 5, not_served: 5 }),
    bucket("multi_hop", { asked: 3, scored: 3, correct: 1, incorrect: 2, fabricated: 1 }),
    bucket("absent", { asked: 1, scored: 1, correct: 0, incorrect: 1, fabricated: 1 }),
  ],
};

const page = (candidates, over = {}) =>
  renderReportHtml(
    buildReportModel({
      workload: { ...WORKLOAD, ...over.workload },
      candidates,
      catalogueMeta: { fetched_at: "2026-09-15T09:00:00.000Z" },
    })
  );

/** The candidates section, so a match in the routes table cannot satisfy an assertion about it. */
const candidateSection = (html) => {
  const start = html.indexOf("Every candidate, at your volume");
  assert.notEqual(start, -1, "the candidates section is missing from the page");
  return html.slice(start, html.indexOf("The three procurement routes", start));
};

// ---------------------------------------------------------------------------
// 1. byKind and errorKinds, the source for both disclosures
// ---------------------------------------------------------------------------

test("a failed call is charged to the kind of question it failed on, not to a bucket of its own", () => {
  // Without the map, five failed calls landed under "unscored" and the fact row read "5 of 5 correct"
  // while five of the ten fact questions had never been answered. A full-marks cell standing in for
  // work that was never done is the worst thing this table could do.
  const runs = [
    { id: "a", score: { kind: "fact", correct: true } },
    { id: "b", error: "HTTP 429: rate limited" },
    { id: "c", error: "HTTP 429: rate limited" },
  ];
  const withMap = byKind(runs, { a: "fact", b: "fact", c: "fact" });

  assert.equal(withMap.length, 1, JSON.stringify(withMap));
  assert.equal(withMap[0].kind, "fact");
  assert.equal(withMap[0].asked, 3);
  assert.equal(withMap[0].scored, 1);
  assert.equal(withMap[0].correct, 1);
  // Not served, and NOT incorrect. The distinction this whole module is built around.
  assert.equal(withMap[0].not_served, 2);
  assert.equal(withMap[0].incorrect, 0);
});

test("a run that carries its own kind does not need the map", () => {
  // New benchmarks write the kind onto the run, so the artifact is self-describing. The map is the
  // fallback for benchmarks saved before that, not the primary source.
  const runs = [
    { id: "a", kind: "multi_hop", score: { kind: "multi_hop", correct: false, hallucination: true } },
    { id: "b", kind: "multi_hop", error: "HTTP 402: buy credits" },
  ];
  const b = byKind(runs)[0];
  assert.equal(b.kind, "multi_hop");
  assert.equal(b.fabricated, 1);
  assert.equal(b.not_served, 1);
});

test("kinds come back in reading order, with anything unlabelled last", () => {
  const runs = [
    { id: "a", kind: "absent", score: { kind: "absent", correct: true } },
    { id: "b", kind: "fact", score: { kind: "fact", correct: true } },
    { id: "c", kind: "zebra", score: { kind: "zebra", correct: true } },
    { id: "d", kind: "multi_hop", score: { kind: "multi_hop", correct: true } },
  ];
  assert.deepEqual(
    byKind(runs).map((b) => b.kind),
    ["fact", "multi_hop", "absent", "zebra"]
  );
});

test("a candidate with nothing measured has no kinds rather than a zero row", () => {
  assert.deepEqual(byKind([]), []);
});

test("the status code decides what the buyer does, so it is extracted rather than flattened", () => {
  // A 429 is a rate limit you can sometimes buy your way out of; a 402 means the account is out of
  // credit. Both are "failed", and they are not the same problem.
  const kinds = errorKinds([
    { error: "HTTP 429: {\"error\":{\"code\":429}}" },
    { error: "HTTP 429: rate limited" },
    { error: "HTTP 402: buy credits" },
    { error: "the socket closed" },
  ]);
  assert.deepEqual(kinds, { 429: 2, 402: 1, unknown: 1 });
});

test("summarise reports failures on their own line and keeps them out of the quality share", () => {
  const runs = [
    { id: "a", latency_ms: 100, cost: 0.001, score: { kind: "fact", correct: true } },
    { id: "b", error: "HTTP 429: rate limited" },
    { id: "c", error: "HTTP 429: rate limited" },
  ];
  const s = summarise(runs, { a: "fact", b: "fact", c: "fact" });

  assert.equal(s.total, 3);
  assert.equal(s.scored, 1);
  assert.equal(s.failed, 2);
  assert.equal(s.correct_share, 1, "a failed call must not depress the quality share");
  assert.deepEqual(s.error_kinds, { 429: 2 });
  assert.equal(s.by_kind[0].asked, 3);
});

test("evaluateCandidate writes the kind onto the run, so a failing call still knows what it asked", () => {
  const golden = [
    { id: "a", kind: "fact", accept: ["\\b24\\b"], reject: [] },
    { id: "b", kind: "multi_hop", accept: ["\\b216\\b"], reject: [] },
  ];
  const result = evaluateCandidate(
    { name: "X", slug: "x", route: "A", source: "openrouter" },
    [
      { id: "a", latency_ms: 10, answer: "24 months" },
      { id: "b", error: "HTTP 500: upstream" },
    ],
    golden,
    WORKLOAD
  );

  assert.equal(result.summary.by_kind.length, 2, JSON.stringify(result.summary.by_kind));
  const hop = result.summary.by_kind.find((b) => b.kind === "multi_hop");
  assert.equal(hop.not_served, 1);
  assert.equal(hop.incorrect, 0);
});

// ---------------------------------------------------------------------------
// 2. the row: served, scored, and why it failed
// ---------------------------------------------------------------------------

test("quality is printed over the calls that answered, not over every call attempted", () => {
  const html = candidateSection(page([entry("Gemma", "g", QUALITY_PARTIAL)]));
  assert.ok(html.includes(">6/9</span> correct"), "the quality cell is not correct-of-answered");
  assert.equal(html.includes(">6/14</span>"), false, "the denominator is still the run count");
});

test("the row says how many calls went unanswered, so the smaller denominator is explained", () => {
  // "6/9 correct" beside 14 runs invites the reader to think the page made an arithmetic error. The
  // line under it names both numbers, so the smaller denominator is stated rather than inferred.
  const html = candidateSection(page([entry("Gemma", "g", QUALITY_PARTIAL)]));
  assert.ok(/9 of 14 calls answered/.test(html), html.slice(0, 900));
});

test("the served column carries the count and the status code", () => {
  const html = candidateSection(page([entry("Gemma", "g", QUALITY_PARTIAL)]));
  assert.ok(html.includes(">9/14</span>"), "the served cell is missing");
  assert.ok(html.includes("HTTP 429 x5"), "the status code behind the failures was dropped");
});

test("a candidate with no failures says so rather than leaving the cell blank", () => {
  const html = candidateSection(page([entry("Passer", "p", QUALITY_PERFECT)]));
  assert.ok(html.includes(">14/14</span>"), "the served cell is missing");
  assert.ok(html.includes("no failures"));
});

test("an error with no status code is admitted, not rendered as HTTP unknown", () => {
  const q = { ...QUALITY_PERFECT, total: 2, scored: 1, not_served: 1, error_kinds: { unknown: 1 } };
  const html = candidateSection(page([entry("Flaky", "f", q)]));
  assert.ok(html.includes("1 unclassified"), html.slice(0, 600));
  assert.equal(html.includes("HTTP unknown"), false);
});

test("every failing candidate carries its reasons on its own row, not only the incumbent", () => {
  // Two of the three measured candidates failed the bar and neither was the incumbent, so both
  // rendered as a bare FAIL pill with no explanation anywhere on the page.
  const html = candidateSection(
    page([
      entry("Passer", "p", QUALITY_PERFECT, { incumbent: true }),
      entry("Loser", "l", QUALITY_PARTIAL),
    ])
  );
  assert.ok(html.includes("Fails because:"), "no candidate row states why it failed");
  assert.ok(html.includes("quality 67% is below the 75% bar (6/9 correct)"), "the gate's own reason was dropped");
  assert.ok(html.includes("5 of 14 calls failed"));
});

test("a candidate that passes carries no failure line at all", () => {
  const html = candidateSection(page([entry("Passer", "p", QUALITY_PERFECT)]));
  assert.equal(html.includes("Fails because:"), false);
});

test("the incumbent callout and the reasons below it count from the same denominator", () => {
  // The callout said "6 of 14 correct" directly above a bullet reading "(6/9 correct)". One of the
  // two was wrong, and a reader had no way to tell which.
  const html = candidateSection(page([entry("Gemma", "g", QUALITY_PARTIAL, { incumbent: true })]));
  const callout = html.slice(html.indexOf("fails the buyer's own quality bar"));
  assert.ok(/6 of the 9 calls that answered/.test(callout), callout.slice(0, 500));
  assert.equal(/Measured: 6 of 14/.test(callout), false, "the callout still counts failures as wrong answers");
});

// ---------------------------------------------------------------------------
// 3. the same measurement, cut by kind
// ---------------------------------------------------------------------------

test("the kind table heads its columns with the workload's own labels", () => {
  const html = candidateSection(page([entry("P", "p", QUALITY_PERFECT)]));
  assert.ok(html.includes("Stated in one clause"), "the workload labels were not used");
  assert.ok(html.includes("Needs two clauses combined"));
  assert.ok(html.includes("Not answered by the contract"));
});

test("a workload that names no kinds still renders, headed with the raw kind", () => {
  // The labels are display only. A golden set that uses `fact` and `multi_hop` and never describes
  // them must not produce an empty column heading.
  const html = candidateSection(page([entry("P", "p", QUALITY_PERFECT)], { workload: { question_kinds: null } }));
  assert.ok(html.includes(">fact<") || html.includes(">fact\n"), "the raw kind should stand in as the heading");
  assert.ok(html.includes("multi_hop"), "the raw kind should stand in as the heading");
});

test("a kind where nobody was wrong is named as non-separating, and the deciding kinds are named", () => {
  const html = candidateSection(
    page([entry("Passer", "p", QUALITY_PERFECT), entry("Gemma", "g", QUALITY_PARTIAL)])
  );
  assert.ok(
    /No candidate answered a Stated in one clause question wrongly/.test(html),
    "the derived finding is missing"
  );
  assert.ok(/Every difference the quality bar actually found is in/.test(html), html.slice(0, 900));
});

test("the finding names who failed, from the verdicts rather than from a narrative", () => {
  const html = candidateSection(page([entry("Cheap", "c", QUALITY_PARTIAL), entry("Pricey", "p", QUALITY_PERFECT)]));
  assert.ok(/fails Cheap/.test(html), html.slice(0, 900));
  assert.equal(/fails Pricey/.test(html), false, "a passing candidate was named as failing");
});

test("an unanswered question is not counted as a wrong answer, in the finding or in the cell colour", () => {
  // Gemma's fact column is 5/5 with five never served. It is a partial reading, not a bad one, and
  // colouring it like a wrong answer would fold the transport failure into the quality failure one
  // last time. The coverage hole gets the page's own amber and its own sentence.
  const html = candidateSection(page([entry("Gemma", "g", QUALITY_PARTIAL)]));
  assert.ok(html.includes("5 of 10 unanswered"), "the coverage hole is not stated under the cell");
  assert.ok(html.includes("--assumed"), "the coverage hole is not in the assumed tone");
  assert.ok(/5 of 10 Stated in one clause questions were never served/.test(html), "the caveat is missing");
});

test("a wrong answer in a kind is coloured as a failure, which is the whole point of the cut", () => {
  const html = candidateSection(page([entry("Gemma", "g", QUALITY_PARTIAL)]));
  const multi = html.slice(html.indexOf("Needs two clauses combined"));
  assert.ok(multi.includes("--bad"), "a wrong answer was not marked");
  assert.ok(multi.includes("1/3"), "the multi-hop score is missing");
});

test("with every candidate perfect, the page says the cut does not decide the purchase", () => {
  const html = candidateSection(page([entry("A", "a", QUALITY_PERFECT), entry("B", "b", QUALITY_PERFECT)]));
  assert.ok(
    /No candidate got a question wrong at any kind/.test(html),
    "the page claims a separation that is not in the data"
  );
});

test("the kind table is absent, not empty, when nothing was measured", () => {
  const html = candidateSection(page([entry("Unmeasured", "u", null)]));
  assert.equal(html.includes("cut by question kind"), false);
});

// ---------------------------------------------------------------------------
// the page still parses and still stands alone
// ---------------------------------------------------------------------------

test("the page survives a candidate with no quality record at all", () => {
  const html = page([entry("Unmeasured", "u", null)]);
  assert.ok(html.includes("<!doctype html>"));
  assert.equal(html.includes("[object Object]"), false);
  assert.equal(html.includes(">undefined<"), false);
  assert.equal(html.includes(">null<"), false);
});
