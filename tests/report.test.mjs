/**
 * Day 4 tests: the interactive report.
 *
 * The most important test in this file is the first one. The page has to recompute cost in the
 * browser, so the arithmetic exists twice: once in core/cost.mjs for the pipeline, and once as the
 * CLIENT_FN_SRC string that ships inside the HTML. Two copies of one formula is how a tool starts
 * lying quietly, so the suite compiles the exact string the page receives and runs it against the
 * engine over a grid of prompt sizes. If they ever disagree, this fails.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normaliseOpenRouterModel, normaliseHuggingFaceModel } from "../core/catalogue.mjs";
import { costPerCall } from "../core/cost.mjs";
import { CLIENT_FN_SRC, buildReportModel, renderReportHtml } from "../core/report.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const incumbentModel = () =>
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
    },
  });

const tieredModel = () =>
  normaliseOpenRouterModel({
    id: "openai/tiered-example",
    canonical_slug: "openai/tiered-example",
    name: "Tiered example",
    context_length: 200000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: {
      prompt: "0.00000015",
      completion: "0.0000006",
      input_cache_read: "0.000000075",
      overrides: [{ min_prompt_tokens: 2000, prompt: "0.00000030", completion: "0.0000006" }],
    },
  });

const noCacheModel = () =>
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
    providers: [{ provider: "deepinfra", status: "live", pricing: { input: 0.05, output: 0.1 } }],
  });

const MEASURED_PROFILE = {
  input_tokens_per_call: 3000,
  cached_input_tokens_per_call: 2944,
  output_tokens_per_call: 18,
  reasoning_tokens_per_call: 0,
  calls_per_month: 20000,
  per_call_counts: { image: 0, web_search: 0, request: 0 },
};

/**
 * `google/gemini-2.5-flash-image`, priced as the live catalogue publishes it.
 *
 * The two rates that matter sit one line apart on the model's own page: text output at $2.50/M and
 * image output at $30/M. A reader who takes the line labelled "completion" prices the picture at a
 * twelfth of what it costs, which is the error this fixture exists to keep out of the page.
 */
const imageModel = () =>
  normaliseOpenRouterModel({
    id: "google/gemini-2.5-flash-image",
    canonical_slug: "google/gemini-2.5-flash-image",
    name: "Gemini 2.5 Flash Image",
    context_length: 32768,
    architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] },
    pricing: {
      prompt: "0.0000003",
      completion: "0.0000025",
      image_output: "0.00003",
    },
  });

/** The same model with the image rate absent, which is the case the page has to flag rather than price. */
const imageModelWithoutRate = () => {
  const model = imageModel();
  model.pricing = { ...model.pricing, image_output_per_m: null };
  return model;
};

/**
 * The real gemini call, from the 2026-09-17 run: 9 prompt tokens in, and a completion of 1,290
 * tokens that IS the picture. `output_tokens_per_call` includes them, per core/cost.mjs:59-64.
 */
const IMAGE_PROFILE = {
  input_tokens_per_call: 9,
  cached_input_tokens_per_call: 0,
  output_tokens_per_call: 1290,
  reasoning_tokens_per_call: 0,
  image_tokens_per_call: 1290,
  calls_per_month: 2000,
  per_call_counts: { image: 0, web_search: 0, request: 0 },
};

const candidateEntry = (model, over = {}) => ({
  key: `${model.source}:${model.slug}`,
  model,
  route: model.source === "huggingface" ? "B" : "A",
  provider: null,
  incumbent: false,
  measured: MEASURED_PROFILE,
  ...over,
});

const WORKLOAD = {
  workload_name: "Legal contract review",
  workload_kind: "text",
  task_description: "Answer one question about a commercial contract, from the contract text alone.",
  monthly_requests: 20000,
  quality_bar: { min_correct_share: 0.75, max_hallucinations: 0 },
  latency_ceiling_ms: 15000,
  buyer_estimate: {
    assumed_input_tokens_per_request: 1500,
    assumed_output_tokens_per_request: 50,
    assumed_cost_per_month_usd: 18.0,
  },
};

const reportModel = (candidates, over = {}) =>
  buildReportModel({
    workload: WORKLOAD,
    candidates,
    catalogueMeta: { fetched_at: "2026-09-15T09:00:00.000Z" },
    benchmarkMeta: { run_at: "2026-09-15T08:14:42.871Z", items: 14, path: "out/benchmark.json" },
    generatedAt: "2026-09-15T18:00:00.000Z",
    ...over,
  });

/** Compile the exact source string the page receives. */
const clientFn = () => new Function(`${CLIENT_FN_SRC}\nreturn { reportCostPerCall: reportCostPerCall };`)();

// ---------------------------------------------------------------------------
// the drift guard
// ---------------------------------------------------------------------------

test("the page's cost function agrees with the engine at every prompt size", () => {
  const { reportCostPerCall } = clientFn();
  const grid = [0, 1, 100, 999, 1500, 1999, 2000, 2001, 3000, 8000, 50000, 199999];

  for (const model of [incumbentModel(), tieredModel(), noCacheModel(), hfModel()]) {
    const entry = candidateEntry(model);
    const built = reportModel([entry]).candidates[0];
    const cacheRate = built.measured.cache_hit_rate;

    for (const prompt of grid) {
      const fromPage = reportCostPerCall(built, prompt);

      // The engine is given the same configuration the page derived, so any disagreement is a
      // difference in the formulas rather than in the inputs.
      const cached = Math.min(prompt, Math.round(prompt * cacheRate));
      const fromEngine = costPerCall(model, {
        input_tokens_per_call: prompt,
        cached_input_tokens_per_call: cached,
        output_tokens_per_call: MEASURED_PROFILE.output_tokens_per_call,
        reasoning_tokens_per_call: MEASURED_PROFILE.reasoning_tokens_per_call,
        per_call_counts: MEASURED_PROFILE.per_call_counts,
      });

      assert.equal(
        Number(fromPage.per_call_usd.toFixed(12)),
        Number(fromEngine.total.toFixed(12)),
        `${model.slug} at ${prompt} tokens: page said ${fromPage.per_call_usd}, engine said ${fromEngine.total}`
      );
      assert.equal(fromPage.complete, fromEngine.complete, `${model.slug} at ${prompt}: completeness differed`);
    }
  }
});

test("the page prices an image at the image rate, and reproduces the real bill", () => {
  // The 12x unit trap's fourth appearance, after core/cost.mjs, the ledger and core/report.mjs's own
  // engine-side call. The page is the copy a reader actually touches, so it is the one where a wrong
  // formula does the most damage and gets caught the least.
  const { reportCostPerCall } = clientFn();
  const built = reportModel([candidateEntry(imageModel(), { measured: IMAGE_PROFILE })]).candidates[0];

  const fromPage = reportCostPerCall(built, 9);

  assert.equal(fromPage.complete, true);
  assert.ok(fromPage.reasons.includes("image_at_image_rate"));

  // 1,290 image tokens at $30/M. At the published text output rate of $2.50/M the same tokens come
  // to $0.0032, so this number is either right or it is wrong by 12x; there is no near miss.
  assert.equal(fromPage.breakdown.image_output, 0.0387);
  // Every output token is the picture, so nothing is left to charge at the text rate. Getting this
  // wrong double-charges the image rather than undercounting it, which is the quieter failure.
  assert.equal(fromPage.breakdown.output, 0);

  // 9 prompt tokens at $0.30/M plus the image is $0.0387027, which is usage.cost from the paid run to
  // the last digit (docs/units.md:35-52). Pinned as a literal because an agreement test between two
  // copies of one formula passes happily while both are wrong.
  assert.equal(Number(fromPage.per_call_usd.toFixed(7)), 0.0387027);
});

test("the page's cost function agrees with the engine on an image candidate", () => {
  const { reportCostPerCall } = clientFn();
  const grid = [0, 1, 9, 100, 999, 1500, 2000, 3000, 50000, 199999];

  for (const model of [imageModel(), imageModelWithoutRate()]) {
    const built = reportModel([candidateEntry(model, { measured: IMAGE_PROFILE })]).candidates[0];
    const cacheRate = built.measured.cache_hit_rate;

    for (const prompt of grid) {
      const fromPage = reportCostPerCall(built, prompt);
      const cached = Math.min(prompt, Math.round(prompt * cacheRate));
      const fromEngine = costPerCall(model, {
        input_tokens_per_call: prompt,
        cached_input_tokens_per_call: cached,
        output_tokens_per_call: IMAGE_PROFILE.output_tokens_per_call,
        reasoning_tokens_per_call: IMAGE_PROFILE.reasoning_tokens_per_call,
        image_tokens_per_call: IMAGE_PROFILE.image_tokens_per_call,
        per_call_counts: IMAGE_PROFILE.per_call_counts,
      });

      assert.equal(
        Number(fromPage.per_call_usd.toFixed(12)),
        Number(fromEngine.total.toFixed(12)),
        `${model.slug} at ${prompt} tokens: page said ${fromPage.per_call_usd}, engine said ${fromEngine.total}`
      );
      assert.equal(fromPage.complete, fromEngine.complete, `${model.slug} at ${prompt}: completeness differed`);
    }
  }
});

test("an image with no published rate is flagged, not priced at the text rate in silence", () => {
  // The subtraction of image tokens from the text charge is conditional on a published image rate,
  // and both sides of the port have to make the same call about which branch to take. Charging the
  // picture at the text rate is the conservative fallback; passing it off as measured is not.
  const { reportCostPerCall } = clientFn();
  const built = reportModel([
    candidateEntry(imageModelWithoutRate(), { measured: IMAGE_PROFILE }),
  ]).candidates[0];

  const fromPage = reportCostPerCall(built, 9);

  assert.equal(fromPage.complete, false);
  assert.ok(fromPage.reasons.includes("image_no_rate"));
  // Null, not zero. A zero here would render as a $0.00 image charge on a page whose whole argument
  // is that the image charge is the number nobody sees.
  assert.equal(fromPage.breakdown.image_output, null);

  const fromEngine = costPerCall(imageModelWithoutRate(), {
    input_tokens_per_call: 9,
    cached_input_tokens_per_call: 0,
    output_tokens_per_call: IMAGE_PROFILE.output_tokens_per_call,
    reasoning_tokens_per_call: IMAGE_PROFILE.reasoning_tokens_per_call,
    image_tokens_per_call: IMAGE_PROFILE.image_tokens_per_call,
    per_call_counts: IMAGE_PROFILE.per_call_counts,
  });
  assert.equal(fromEngine.complete, false);
});

test("the page's cost function applies the same pricing tier the engine does", () => {
  const { reportCostPerCall } = clientFn();
  const model = tieredModel();
  const built = reportModel([candidateEntry(model)]).candidates[0];

  // The tier starts at 2,000 tokens, so these two are a cent-sized difference that would be easy to
  // get wrong by an off-by-one on the comparison.
  const below = reportCostPerCall(built, 1999);
  const at = reportCostPerCall(built, 2000);

  assert.equal(below.rate_used.tier_applied, null);
  assert.equal(at.rate_used.tier_applied, 2000);
  assert.equal(at.rate_used.input_per_m, 0.3);

  // Only the UNCACHED tokens move to the higher rate, so the blend rises far less than the rate
  // does. Nearly all of a 2,000-token prompt is cached here, which is exactly why a tier crossing
  // is easy to miss by looking at the per-token price and hard to miss by looking at the bill.
  assert.ok(at.breakdown.uncached_input > below.breakdown.uncached_input * 1.9);
  assert.ok(at.per_call_usd > below.per_call_usd);
});

test("an override of the cache hit rate is what keeps the two gaps from collapsing", () => {
  const { reportCostPerCall } = clientFn();
  const built = reportModel([candidateEntry(incumbentModel())]).candidates[0];

  const measured = reportCostPerCall(built, 3000);
  const asAssumed = reportCostPerCall(built, 3000, { cacheHitRate: 0 });

  // Same prompt, same output, and the two differ only by whether the buyer assumed caching. If the
  // page reused the measured rate for both, the modelling gap would read $0.00 and the finding
  // would vanish.
  assert.equal(measured.cached_tokens, 2944);
  assert.equal(asAssumed.cached_tokens, 0);
  assert.ok(asAssumed.per_call_usd > measured.per_call_usd);

  // The override is an options object, not a positional number. A bare 0 here would be read as an
  // absent options bag, silently fall back to the measured rate, and reproduce the very collapse
  // this test exists to prevent, so it is worth pinning that the object form is what works.
  assert.equal(reportCostPerCall(built, 3000, { cacheHitRate: 0 }).cached_tokens, 0);
});

test("the answer length can be varied without touching the measured cache behaviour", () => {
  const { reportCostPerCall } = clientFn();
  const built = reportModel([candidateEntry(incumbentModel())]).candidates[0];

  const short = reportCostPerCall(built, 3000, { outputTokens: 10 });
  const long = reportCostPerCall(built, 3000, { outputTokens: 500 });

  assert.equal(short.cached_tokens, long.cached_tokens, "the cache rate should be unaffected");
  assert.ok(long.per_call_usd > short.per_call_usd);
  // 490 extra tokens at $0.60/M.
  assert.ok(Math.abs((long.per_call_usd - short.per_call_usd) - 490 * 0.6e-6) < 1e-12);
});

// ---------------------------------------------------------------------------
// what the page refuses to price
// ---------------------------------------------------------------------------

test("a prompt larger than the context window is flagged, not silently priced", () => {
  const { reportCostPerCall } = clientFn();
  const built = reportModel([candidateEntry(incumbentModel())]).candidates[0];

  assert.equal(reportCostPerCall(built, 128000).reasons.includes("over_context"), false);
  assert.equal(reportCostPerCall(built, 128001).reasons.includes("over_context"), true);
});

test("a route that publishes no input price is unprojectable rather than free", () => {
  const { reportCostPerCall } = clientFn();
  const unpriced = normaliseHuggingFaceModel({
    id: "some/model",
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    providers: [{ provider: "host", status: "live" }],
  });
  const built = reportModel([candidateEntry(unpriced)]).candidates[0];
  const r = reportCostPerCall(built, 3000);

  assert.equal(r.complete, false);
  assert.equal(r.reasons.includes("no_input_price"), true);
});

test("no cache price is reported as a reason, not as a discount", () => {
  const { reportCostPerCall } = clientFn();
  const built = reportModel([candidateEntry(noCacheModel())]).candidates[0];
  const r = reportCostPerCall(built, 3000);

  assert.equal(r.reasons.includes("cache_unavailable"), true);
  assert.equal(r.reasons.includes("cache_applied"), false);
});

// ---------------------------------------------------------------------------
// the model the page is built from
// ---------------------------------------------------------------------------

test("the cache hit rate is a rate, so moving the prompt size moves both halves together", () => {
  const built = reportModel([candidateEntry(incumbentModel())]).candidates[0];
  // 2,944 of 3,000 measured tokens were cached.
  assert.ok(Math.abs(built.measured.cache_hit_rate - 0.9813333333) < 1e-9);
  // The absolute token count is deliberately not carried, because a rate is the thing that was
  // actually observed and the thing that still means something at a prompt size nobody measured.
  assert.equal(built.measured.cached_input_tokens_per_call, 2944);
});

test("a candidate with no measured profile is marked as assumed rather than priced", () => {
  const built = reportModel([candidateEntry(incumbentModel(), { measured: null })]).candidates[0];
  // null, not an object of zeros: a candidate with no measurement has no cache hit rate rather
  // than a cache hit rate of zero, and the page has to be able to tell those apart.
  assert.equal(built.measured, null);
  assert.equal(built.profile_source, "assumed");
});

test("a zero-token measured profile does not produce a NaN cache rate", () => {
  const built = reportModel([
    candidateEntry(incumbentModel(), {
      measured: { ...MEASURED_PROFILE, input_tokens_per_call: 0, cached_input_tokens_per_call: 0 },
    }),
  ]).candidates[0];
  assert.equal(built.measured.cache_hit_rate, 0);
  assert.equal(Number.isNaN(built.measured.cache_hit_rate), false);
});

test("the report carries the timestamps of the things it claims were measured", () => {
  const m = reportModel([candidateEntry(incumbentModel())]);
  assert.equal(m.catalogue_fetched_at, "2026-09-15T09:00:00.000Z");
  assert.equal(m.benchmark.run_at, "2026-09-15T08:14:42.871Z");
  assert.equal(m.generated_at, "2026-09-15T18:00:00.000Z");
});

// ---------------------------------------------------------------------------
// the HTML
// ---------------------------------------------------------------------------

test("the page is self-contained: no external requests of any kind", () => {
  const html = renderReportHtml(reportModel([candidateEntry(incumbentModel())]));
  // The whole point of the file is that it opens from disk with the network unplugged, so an
  // accidental CDN link or web font would be a real regression rather than a style preference.
  assert.equal(/<script[^>]+src=/i.test(html), false, "the page loads an external script");
  assert.equal(/<link[^>]+stylesheet/i.test(html), false, "the page loads an external stylesheet");
  // Outbound navigation links are allowed, and are the point of the closing "where this comes from"
  // section: a reader has to be able to reach the repository. What must not exist is an external
  // SUBRESOURCE, which is what would make the file need a network to render. Anchors are stripped
  // before the blanket check, so "a link a reader can click" and "a request the browser makes on
  // load" cannot be confused for one another.
  const withoutAnchors = html.replace(/<a\b[^>]*>/gi, "");
  assert.equal(
    /https?:\/\/(?!www\.w3\.org)/i.test(withoutAnchors.replace(/href="#[^"]*"/g, "")),
    false,
    "the page loads an external subresource"
  );
  assert.ok(html.includes("<!doctype html>"));
});

test("the page embeds its data as JSON that cannot close the script early", () => {
  const html = renderReportHtml(
    reportModel([
      candidateEntry(incumbentModel(), { key: "a</script><script>alert(1)</script>" }),
    ])
  );
  // A model name or a key containing a closing script tag must not be able to end the block.
  assert.equal(html.includes("</script><script>alert(1)"), false);
  assert.ok(html.includes("\\u003c/script"));
});

test("a model name containing HTML is escaped rather than rendered", () => {
  const model = normaliseOpenRouterModel({
    id: "x/y",
    canonical_slug: "x/y",
    name: "<img src=x onerror=alert(1)>",
    context_length: 1000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.000001", completion: "0.000002" },
  });
  const html = renderReportHtml(reportModel([candidateEntry(model)]));
  assert.equal(html.includes("<img src=x"), false);
  assert.ok(html.includes("&lt;img src=x"));
});

test("every candidate gets a row, and the incumbent is marked as the current model", () => {
  const html = renderReportHtml(
    reportModel([
      candidateEntry(incumbentModel(), { incumbent: true }),
      candidateEntry(noCacheModel()),
    ])
  );
  assert.ok(html.includes('data-row="0"'));
  assert.ok(html.includes('data-row="1"'));
  assert.ok(html.includes(">current<"));
});

test("the page states what it cannot tell you rather than implying it can tell you", () => {
  const html = renderReportHtml(reportModel([candidateEntry(incumbentModel())]));
  assert.ok(html.includes("What this tab cannot tell you"));
  assert.ok(html.includes("Prices that drift"));
  assert.ok(html.includes("Synthetic test data"));
});

test("the page renders with no candidates without throwing", () => {
  const html = renderReportHtml(reportModel([]));
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("What this tab cannot tell you"));
});

test("the page renders with no catalogue timestamp without printing null", () => {
  const m = buildReportModel({ workload: WORKLOAD, candidates: [], catalogueMeta: {} });
  const html = renderReportHtml(m);
  assert.equal(html.includes(">null<"), false);
  assert.ok(html.includes("an unrecorded time"));
});

// ---------------------------------------------------------------------------
// the licence table, and what it says when a field is missing
// ---------------------------------------------------------------------------

/** The image workload, with a licence table on it the way scripts/report.mjs supplies one. */
const imageWorkloadWith = (distribution_rows) => ({
  ...WORKLOAD,
  workload_name: "Image generation",
  workload_kind: "image",
  monthly_requests: 2000,
  distribution_rows,
});

const licencePage = (distribution_rows) =>
  renderReportHtml(
    buildReportModel({
      workload: imageWorkloadWith(distribution_rows),
      candidates: [candidateEntry(imageModel(), { measured: IMAGE_PROFILE })],
      catalogueMeta: { fetched_at: "2026-09-15T09:00:00.000Z" },
    })
  );

test("a licence read off a model card reaches the row, quoted as the card states it", () => {
  const html = licencePage([
    {
      label: "FLUX.1 dev",
      slug: "black-forest-labs/FLUX.1-dev",
      route: "B",
      licence_expectation: "The Hub card reports the licence field as 'other'.",
      commercial_note: "The restricted half.",
    },
  ]);

  assert.ok(html.includes("The Hub card reports the licence field as &#39;other&#39;."));
  // The provenance is on the row itself. A licence figure read from a card and a price measured
  // from a run are different kinds of evidence and the table says which this is.
  assert.ok(html.includes("read from the Hub card, not measured"));
});

test("a licence field that is missing says so rather than rendering a blank cell", () => {
  // The table has one job. A blank cell in it is indistinguishable from a model that has no
  // licence, and those are opposite conclusions for a buyer deciding whether they may ship it.
  const html = licencePage([
    { label: "FLUX.1 dev", slug: "black-forest-labs/FLUX.1-dev", route: "B", commercial_note: "x" },
  ]);

  assert.ok(html.includes("No licence field could be read"), "a missing licence rendered as a blank");
  assert.equal(html.includes(">undefined<"), false, "a missing field was stringified into the page");
});

test("a licence table whose rows are missing their identity still renders", () => {
  // Every field on the row is optional as far as this renderer is concerned, because the row arrives
  // from a file a human edits. A throw here takes the whole image tab down with it.
  const html = licencePage([{}, null]);
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("unnamed row"), "a row with no label rendered anonymous");
  assert.ok(html.includes("No licence field could be read"));
});

test("a workload with no licence table renders no licence table", () => {
  const html = licencePage([]);
  assert.equal(html.includes("read from the Hub card, not measured"), false);
});

// ---------------------------------------------------------------------------
// the orientation layer: what the page says before it starts arguing
// ---------------------------------------------------------------------------

test("the page opens with a question about the reader's own shortlist, not a fetch timestamp", () => {
  const html = renderReportHtml(reportModel([candidateEntry(incumbentModel())]));
  assert.ok(html.includes("<h1>Which of your models should actually run the workload?</h1>"));
  // Earlier headings described the sample ("What two AI workloads actually cost") or the finding
  // ("Where your AI cost estimate goes wrong"). Both left a first-time reader unsure what the page
  // was for; the first line has to answer that for the person reading it.
  assert.equal(html.includes("What two AI workloads actually cost"), false);
  assert.equal(html.includes("Where your AI cost estimate goes wrong</h1>"), false);
});

test("the page says who it is for and offers a way in", () => {
  const html = renderReportHtml(reportModel([candidateEntry(incumbentModel())]));
  // The audience is an engineer or procurement lead, not a CFO, and that has to be stated rather
  // than inferred from the density of the tables.
  assert.ok(html.includes("What you get") && html.includes("Who it is for") && html.includes("What it is not"));
  // A reader who is convinced needs somewhere to go. Before this, the page ended on a repo link.
  assert.ok(html.includes("Run this on your shortlist"));
  assert.ok(html.includes("POST /webhook/cost-route"));
});

test("the how-to block names the three steps and the route key, once", () => {
  const html = renderReportHtml(reportModel([candidateEntry(incumbentModel())]));
  assert.equal((html.match(/How to read this page/g) || []).length, 1);
  assert.ok(html.includes("Pick a workload."));
  assert.ok(html.includes("Read the gap."));
  assert.ok(html.includes("Move your own numbers."));
  // A reader cannot evaluate route A/B/C without a key, and the key only existed several screens down.
  assert.ok(html.includes("closed API model, quoted per token"));
  assert.ok(html.includes("never a price"));
});

test("the interactive panel sits above the first tabpanel", () => {
  // It used to be the last section on the page, after every table and four full-size images. The
  // surrounding copy now says "the panel at the top of the page", so this assertion is what keeps
  // that sentence true rather than aspirational.
  const html = renderReportHtml(reportModel([candidateEntry(incumbentModel())]));
  const panel = html.indexOf('id="out-panel-name"');
  const firstPanel = html.indexOf('id="panel-0"');
  assert.ok(panel > 0, "the panel is missing");
  assert.ok(firstPanel > 0, "the first tabpanel is missing");
  assert.ok(panel < firstPanel, "the panel renders below the workload it prices");
  assert.equal(html.includes("respond to the panel above"), false, "a stale layout claim survived");
  // The sentence wraps in the source, so only the half before the line break can be matched literally.
  assert.ok(html.includes("respond to the panel at the top of"));
});

test("the assumptions box names what the numbers rest on", () => {
  const html = renderReportHtml(reportModel([candidateEntry(incumbentModel())]));
  assert.equal((html.match(/Assumptions this page rests on/g) || []).length, 1);
  assert.ok(html.includes("Synthetic documents."));
  assert.ok(html.includes("14-question golden set"));
  assert.ok(html.includes("75% correct and at most 0 fabricated answers"));
  // The self-host row must never be presented as priceable beside the two quoted routes.
  assert.ok(html.includes("Route C is an estimate."));
});

test("the closing section links to the repo without loading anything from it", () => {
  const html = renderReportHtml(reportModel([candidateEntry(incumbentModel())]));
  assert.ok(html.includes("https://github.com/therealmaddieli/cost-route"));
  assert.ok(html.includes("Claude Code"));
  // A link is navigation, not a subresource: the file still opens from disk offline. The
  // self-containment test above strips anchors before its blanket check for the same reason.
  assert.equal(/<script[^>]+src=/i.test(html), false);
  assert.equal(/<link[^>]+stylesheet/i.test(html), false);
});

test("the n8n canvas is embedded when supplied and absent when not", () => {
  const slate = "data:image/png;base64,AAAA";
  const withCanvas = renderReportHtml(
    reportModel([candidateEntry(incumbentModel())], { n8nCanvas: slate })
  );
  assert.ok(withCanvas.includes('class="canvas"'), "the canvas image did not render");
  assert.ok(withCanvas.includes(slate), "the canvas data URI did not reach the page");
  assert.ok(withCanvas.includes('alt="The Cost-Route n8n workflow canvas'));

  // A checkout without the screenshot must still render a whole page rather than a broken image.
  const without = renderReportHtml(reportModel([candidateEntry(incumbentModel())]));
  assert.equal(without.includes('class="canvas"'), false);
});
