/**
 * Day 3 tests: unit conversion, catalogue normalisation, the cost engine, and the route table.
 *
 * These run without a network. Every fixture below is a trimmed copy of a real API response, with
 * the numbers taken from the live catalogues on 2026-09-14/15 so the expected values are the ones
 * the real data produces rather than values invented to make the assertions pass.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  toNumber,
  perTokenToPerMillion,
  perMillionToPerMillion,
  conversionIsConsistent,
  formatPerMillion,
} from "../core/units.mjs";
import {
  normaliseOpenRouterModel,
  normaliseHuggingFaceModel,
  buildCatalogue,
  findModel,
} from "../core/catalogue.mjs";
import {
  costPerCall,
  projectMonthly,
  projectShortlist,
  resolveRate,
  profileFromRuns,
} from "../core/cost.mjs";
import { validateCandidate, validateShortlist, requiredInputTokens } from "../core/validate.mjs";
import { selfHostEstimate, prosAndCons, buildRouteTable, routeFor } from "../core/routes.mjs";

// ---------------------------------------------------------------------------
// fixtures, shaped like the real responses
// ---------------------------------------------------------------------------

const openRouterModel = (over = {}) => ({
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

const hfModel = (over = {}) => ({
  id: "google/gemma-3-4b-it",
  architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
  providers: [
    {
      provider: "deepinfra",
      status: "live",
      context_length: 131072,
      pricing: { input: 0.05, output: 0.1 },
      first_token_latency_ms: 200,
      throughput: 50,
      supports_tools: true,
    },
    ...(over.extraProviders ?? []),
  ],
});

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

test("per-token and per-million describe the same price and convert to the same number", () => {
  assert.equal(perTokenToPerMillion("0.00000003"), 0.03);
  assert.equal(perMillionToPerMillion(0.03), 0.03);
  assert.ok(conversionIsConsistent());
});

test("conversion does not leave floating point noise behind", () => {
  // $0.00000005/token is $0.05/M. Multiplying by 1e6 in binary floating point gives
  // 0.049999999999999996, which then leaks into JSON and into any string comparison.
  assert.equal(perTokenToPerMillion("0.00000005"), 0.05);
  assert.equal(perTokenToPerMillion("0.0000000001"), 0.0001);
});

test("an unparseable price is null, never zero", () => {
  // The distinction the whole cost engine rests on: unknown is not free.
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber(""), null);
  assert.equal(toNumber("not a price"), null);
  assert.notEqual(toNumber("0"), null);
  assert.equal(toNumber("0"), 0);
});

test("a missing price formats as n/a rather than $0.00", () => {
  assert.equal(formatPerMillion(null), "n/a");
  assert.equal(formatPerMillion(0), "$0.0000/M");
});

// ---------------------------------------------------------------------------
// catalogue normalisation
// ---------------------------------------------------------------------------

test("OpenRouter prices arrive as per-token strings and leave as per-million numbers", () => {
  const m = normaliseOpenRouterModel(openRouterModel());
  assert.equal(m.pricing.input_per_m, 0.15);
  assert.equal(m.pricing.output_per_m, 0.6);
  assert.equal(m.pricing.cache_read_per_m, 0.075);
  assert.equal(m.source, "openrouter");
});

test("per-call charges are NOT run through the per-token converter", () => {
  // The bug this test exists to prevent: pricing.web_search is "0.01" meaning one cent per search.
  // Converting it as though it were per-token reports $10,000 per search, and the resulting cost
  // table is wrong by six orders of magnitude while looking entirely plausible.
  const m = normaliseOpenRouterModel(
    openRouterModel({ pricing: { image: "0.001", web_search: "0.01", request: "0.0001" } })
  );
  assert.equal(m.pricing.per_call.web_search, 0.01);
  assert.equal(m.pricing.per_call.image, 0.001);
  assert.equal(m.pricing.per_call.request, 0.0001);
});

test("image OUTPUT is priced per token and does go through the converter", () => {
  // The trap sits one line from the previous test: `image` is per call, `image_output` is per
  // image token. Two similar names, two different units.
  const m = normaliseOpenRouterModel(openRouterModel({ pricing: { image_output: "0.00001" } }));
  assert.equal(m.pricing.image_output_per_m, 10);
  assert.equal(m.pricing.per_call.image, null);
});

test("tiered pricing is lifted into a tier list", () => {
  const m = normaliseOpenRouterModel(
    openRouterModel({
      pricing: { overrides: [{ min_prompt_tokens: 200000, prompt: "0.0000003", completion: "0.0000012" }] },
    })
  );
  assert.equal(m.pricing.tiers.length, 1);
  assert.equal(m.pricing.tiers[0].min_prompt_tokens, 200000);
  assert.equal(m.pricing.tiers[0].input_per_m, 0.3);
  assert.ok(m.flags.some((f) => f.startsWith("tiered_pricing")));
});

test("a floating alias id is flagged as a moving target", () => {
  const m = normaliseOpenRouterModel(openRouterModel({ rest: { id: "~openai/gpt-latest" } }));
  assert.ok(m.flags.some((f) => f.startsWith("floating_alias")));
});

test("expiration_date is reported when present but never treated as a deprecation signal", () => {
  // Day 1: only 4 of 446 models carry it, so absence says nothing. Presence is worth showing.
  const withDate = normaliseOpenRouterModel(openRouterModel({ rest: { expiration_date: "2026-01-01" } }));
  assert.equal(withDate.expiration_date, "2026-01-01");
  assert.ok(withDate.flags.some((f) => f.startsWith("carries_expiration_date")));

  const without = normaliseOpenRouterModel(openRouterModel());
  assert.equal(without.expiration_date, null);
  assert.ok(!without.flags.some((f) => f.includes("expiration")));
});

test("HF picks the cheapest live provider and keeps the runner-up", () => {
  const m = normaliseHuggingFaceModel(
    hfModel({
      extraProviders: [
        { provider: "together", status: "live", context_length: 131072, pricing: { input: 0.2, output: 0.4 } },
      ],
    })
  );
  assert.equal(m.cheapest_provider, "deepinfra");
  assert.equal(m.runner_up_provider, "together");
  assert.equal(m.pricing.input_per_m, 0.05);
});

test("a provider that is not live is never chosen as the cheapest", () => {
  const m = normaliseHuggingFaceModel(
    hfModel({
      extraProviders: [
        { provider: "cheap-but-down", status: "stopped", context_length: 999, pricing: { input: 0.001, output: 0.001 } },
      ],
    })
  );
  assert.equal(m.cheapest_provider, "deepinfra");
  assert.equal(m.pricing.input_per_m, 0.05);
});

test("a provider carrying no pricing key is flagged, not priced at zero", () => {
  // Day 1 found 111 such entries. Guarding this read is the difference between "unknown" and
  // "free", and this is the common path, not the edge case.
  const m = normaliseHuggingFaceModel(
    hfModel({ extraProviders: [{ provider: "mystery", status: "live", context_length: 8000 }] })
  );
  assert.ok(m.flags.some((f) => f.includes("no pricing key")));
  const mystery = m.providers.find((p) => p.name === "mystery");
  assert.equal(mystery.input_per_m, null);
  assert.equal(mystery.has_pricing, false);
});

test("a model priced at 0.00 is free by price, whatever the is_free flag says", () => {
  // No model reports is_free, yet ovhcloud prices one at 0.00 in the live catalogue. Detecting
  // free by the flag finds nothing; detecting it by price finds the real case.
  const m = normaliseHuggingFaceModel(
    hfModel({
      extraProviders: [{ provider: "free-one", status: "live", context_length: 4096, pricing: { input: 0, output: 0 } }],
    })
  );
  assert.ok(m.flags.includes("free_by_price"));
});

test("the catalogue resolves a model by slug, by canonical slug, and by source-qualified key", () => {
  // Both catalogues really do carry google/gemma-3-4b-it, which is why the source-qualified
  // lookup exists: the bare key resolves to whichever was indexed first, and for this model that
  // is a coin flip that would silently price the wrong route.
  const c = buildCatalogue({
    openrouter: {
      data: [openRouterModel(), { ...openRouterModel(), id: "google/gemma-3-4b-it", canonical_slug: "google/gemma-3-4b-it" }],
    },
    huggingface: { data: [hfModel()] },
  });
  assert.ok(findModel(c, "openai/gpt-4o-mini"));
  assert.ok(findModel(c, "openai/gpt-4o-mini", "openrouter"));
  assert.equal(findModel(c, "google/gemma-3-4b-it", "huggingface").source, "huggingface");
  assert.equal(findModel(c, "google/gemma-3-4b-it", "openrouter").source, "openrouter");
});

// ---------------------------------------------------------------------------
// the cost engine
// ---------------------------------------------------------------------------

const profile = (over = {}) => ({
  input_tokens_per_call: 3000,
  cached_input_tokens_per_call: 0,
  output_tokens_per_call: 50,
  reasoning_tokens_per_call: 0,
  image_tokens_per_call: 0,
  calls_per_month: 20000,
  per_call_counts: { image: 0, web_search: 0, request: 0 },
  ...over,
});

test("the base case is input plus output at the list rate", () => {
  const m = normaliseOpenRouterModel(openRouterModel());
  const r = costPerCall(m, profile());
  // 3000 tokens at $0.15/M = $0.00045; 50 at $0.60/M = $0.00003
  assert.equal(Number(r.total.toFixed(10)), Number((0.00045 + 0.00003).toFixed(10)));
  assert.equal(r.complete, true);
});

test("cached tokens are charged at the cache rate and the assumption is stated", () => {
  const m = normaliseOpenRouterModel(openRouterModel());
  const r = costPerCall(m, profile({ cached_input_tokens_per_call: 2900 }));
  // 100 uncached at $0.15/M = $0.000015; 2900 cached at $0.075/M = $0.0002175
  const expected = 100 * 0.15e-6 + 2900 * 0.075e-6 + 50 * 0.6e-6;
  assert.equal(Number(r.total.toFixed(10)), Number(expected.toFixed(10)));
  assert.ok(r.assumptions.some((a) => a.startsWith("cache assumed:")));
});

test("a model with no published cache rate does NOT get a cache discount", () => {
  // Gemma's situation. Claiming the discount would understate the cost of the one route whose
  // caching Day 2 measured at 0% anyway.
  const noCache = normaliseOpenRouterModel(openRouterModel({ pricing: { input_cache_read: null } }));
  const r = costPerCall(noCache, profile({ cached_input_tokens_per_call: 2900 }));
  const expected = 3000 * 0.15e-6 + 50 * 0.6e-6; // every token at the full rate
  assert.equal(Number(r.total.toFixed(10)), Number(expected.toFixed(10)));
  assert.ok(r.assumptions.some((a) => a.startsWith("cache assumed NOT to apply")));
});

test("a prompt crossing a tier threshold is charged at the higher tier", () => {
  const m = normaliseOpenRouterModel(
    openRouterModel({
      pricing: { overrides: [{ min_prompt_tokens: 2000, prompt: "0.0000006", completion: "0.0000024" }] },
    })
  );
  const { rate, tier } = resolveRate(m, 3000);
  assert.equal(tier.min_prompt_tokens, 2000);
  assert.equal(rate.input_per_m, 0.6);

  // The same model on a small prompt keeps the base rate.
  const small = resolveRate(m, 1000);
  assert.equal(small.tier, null);
  assert.equal(small.rate.input_per_m, 0.15);
});

test("the highest crossed tier wins when several are passed", () => {
  const m = normaliseOpenRouterModel(
    openRouterModel({
      pricing: {
        overrides: [
          { min_prompt_tokens: 1000, prompt: "0.0000003", completion: "0.0000012" },
          { min_prompt_tokens: 10000, prompt: "0.0000006", completion: "0.0000024" },
        ],
      },
    })
  );
  assert.equal(resolveRate(m, 20000).rate.input_per_m, 0.6);
  assert.equal(resolveRate(m, 5000).rate.input_per_m, 0.3);
});

test("reasoning tokens are billed and the engine says which rate it used", () => {
  const m = normaliseOpenRouterModel(openRouterModel());
  const r = costPerCall(m, profile({ reasoning_tokens_per_call: 160 }));
  const base = 3000 * 0.15e-6 + 50 * 0.6e-6;
  const withReasoning = base + 160 * 0.6e-6;
  assert.equal(Number(r.total.toFixed(10)), Number(withReasoning.toFixed(10)));
  assert.ok(r.assumptions.some((a) => a.includes("no separate reasoning rate")));
});

test("per-call charges multiply a count by a price, and only once", () => {
  const m = normaliseOpenRouterModel(
    openRouterModel({ pricing: { web_search: "0.01", image: "0.001" } })
  );
  const r = costPerCall(
    m,
    profile({ per_call_counts: { image: 2, web_search: 1, request: 0 } })
  );
  const base = 3000 * 0.15e-6 + 50 * 0.6e-6;
  assert.equal(Number(r.total.toFixed(10)), Number((base + 0.002 + 0.01).toFixed(10)));
  assert.equal(r.breakdown.per_call, 0.012);
});

test("using a per-call feature with no published price makes the projection incomplete, not free", () => {
  const m = normaliseOpenRouterModel(openRouterModel());
  const r = costPerCall(m, profile({ per_call_counts: { image: 1, web_search: 0, request: 0 } }));
  assert.equal(r.complete, false);
  assert.ok(r.assumptions.some((a) => a.includes("no image price is published")));
});

test("an unpriced model produces an incomplete projection rather than a zero", () => {
  const m = normaliseOpenRouterModel(openRouterModel({ pricing: { prompt: null, completion: null } }));
  const p = projectMonthly(m, profile());
  assert.equal(p.complete, false);
  assert.equal(p.monthly_cost, null);
});

test("monthly cost is per-call cost times volume", () => {
  const m = normaliseOpenRouterModel(openRouterModel());
  const p = projectMonthly(m, profile(), 20000);
  assert.equal(Number(p.monthly_cost.toFixed(6)), Number((p.cost_per_call * 20000).toFixed(6)));
});

test("no volume means no monthly figure, and it says why", () => {
  const m = normaliseOpenRouterModel(openRouterModel());
  const p = projectMonthly(m, profile({ calls_per_month: null }), null);
  assert.equal(p.monthly_cost, null);
  assert.ok(p.assumptions.some((a) => a.includes("needs a call volume")));
});

test("an incomplete projection is never ranked among the complete ones", () => {
  // The cheapest-looking lie in the table: a partial number sorted next to whole ones.
  const good = normaliseOpenRouterModel(openRouterModel());
  const broken = normaliseOpenRouterModel(
    openRouterModel({ rest: { id: "broken/model" }, pricing: { prompt: null } })
  );
  const { ranked, incomplete } = projectShortlist([good, broken], profile(), 20000);
  assert.equal(ranked.length, 1);
  assert.equal(incomplete.length, 1);
  assert.equal(incomplete[0].slug, "broken/model");
});

test("a measured profile is built from real usage records", () => {
  const runs = [
    { usage: { prompt_tokens: 3004, completion_tokens: 122, prompt_tokens_details: { cached_tokens: 2944 }, completion_tokens_details: { reasoning_tokens: 100 } } },
    { usage: { prompt_tokens: 3000, completion_tokens: 22, prompt_tokens_details: { cached_tokens: 2944 }, completion_tokens_details: { reasoning_tokens: 0 } } },
  ];
  const p = profileFromRuns(runs, 20000);
  assert.equal(p.input_tokens_per_call, 3002);
  assert.equal(p.cached_input_tokens_per_call, 2944);
  assert.equal(p.reasoning_tokens_per_call, 50);
  // Visible output excludes reasoning, because reasoning is billed separately and counting it
  // twice would overstate the output cost.
  assert.equal(p.output_tokens_per_call, (122 - 100 + 22) / 2);
});

test("errored runs are excluded from a measured profile, not averaged in as zero", () => {
  const runs = [
    { error: "HTTP 429", usage: null },
    { usage: { prompt_tokens: 3000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } } },
  ];
  const p = profileFromRuns(runs, 1000);
  assert.equal(p.input_tokens_per_call, 3000);
  assert.ok(p.source.includes("1 call"));
});

test("a profile with no successful runs is null, not a profile of zeros", () => {
  assert.equal(profileFromRuns([{ error: "HTTP 402" }], 1000), null);
});

// ---------------------------------------------------------------------------
// image output tokens
// ---------------------------------------------------------------------------

/**
 * google/gemini-2.5-flash-image, trimmed from the live catalogue on 2026-09-15.
 *
 * The two rates one line apart are the whole point: `completion` is the text output rate and
 * `image_output` is the image token rate, and on this model they differ by 12x.
 */
const imageModel = (over = {}) =>
  normaliseOpenRouterModel({
    id: "google/gemini-2.5-flash-image",
    canonical_slug: "google/gemini-2.5-flash-image",
    name: "Google: Nano Banana (Gemini 2.5 Flash Image)",
    context_length: 32768,
    architecture: { input_modalities: ["image", "text"], output_modalities: ["image", "text"] },
    pricing: { prompt: "0.0000003", completion: "0.0000025", image_output: "0.00003", ...over.pricing },
    ...over.rest,
  });

test("image output tokens are charged at the image rate, not the text output rate", () => {
  // The bug this test exists to prevent, measured on a paid call on 2026-09-14: an image model
  // bills its image AS completion tokens (units.md:48). Pricing those at the text output rate
  // charges 1,290 tokens at $2.50/M = $0.0032 instead of $30/M = $0.0387. That undercounts by the
  // entire image spend, and the resulting table looks entirely plausible.
  const m = imageModel();
  const r = costPerCall(
    m,
    profile({ output_tokens_per_call: 1290, image_tokens_per_call: 1290 })
  );
  assert.equal(Number(r.breakdown.image_output.toFixed(10)), 0.0387);
  // The image tokens must leave the text bucket, or they are billed twice.
  assert.equal(r.breakdown.output, 0);
  assert.equal(r.complete, true);
  assert.ok(r.assumptions.some((a) => a.includes("bills its image as completion tokens")));
});

test("the image projection reconciles with what the provider actually charged", () => {
  // The project's central claim is that the arithmetic explains the bill rather than replacing it.
  // This is that claim checked against the usage.cost recorded in docs/units.md:43-47.
  const r = costPerCall(imageModel(), {
    input_tokens_per_call: 14,
    cached_input_tokens_per_call: 0,
    output_tokens_per_call: 1290,
    reasoning_tokens_per_call: 0,
    image_tokens_per_call: 1290,
    calls_per_month: 1,
    per_call_counts: { image: 0, web_search: 0, request: 0 },
  });
  assert.equal(Number(r.total.toFixed(7)), 0.0387042);
});

test("a text model's output is untouched by the image split", () => {
  const m = normaliseOpenRouterModel(openRouterModel());
  const r = costPerCall(m, profile());
  assert.equal(Number(r.total.toFixed(10)), Number((3000 * 0.15e-6 + 50 * 0.6e-6).toFixed(10)));
  assert.equal(r.breakdown.image_output, 0);
  assert.ok(!r.assumptions.some((a) => a.includes("image")));
});

test("image tokens on a model with no published image rate are incomplete, not silently merged", () => {
  // No image rate to charge them at, so they sit in the output bucket at the text rate, which is a
  // guess. The component is reported null and the projection marked incomplete rather than let one
  // merged number stand in for the image charge.
  const m = normaliseOpenRouterModel(openRouterModel());
  const r = costPerCall(
    m,
    profile({ output_tokens_per_call: 1290, image_tokens_per_call: 1290 })
  );
  assert.equal(r.breakdown.image_output, null);
  assert.equal(r.complete, false);
  assert.ok(r.assumptions.some((a) => a.includes("unverified")));
  // Still charged inside the output figure, so this is a flagged figure and not a zero.
  assert.ok(r.total > 0);
});

test("a measured image profile keeps the image tokens inside the output count", () => {
  // The invariant the split depends on: profileFromRuns reports what was billed and costPerCall
  // decides how to divide it, because only costPerCall can see whether a separate image rate exists.
  const p = profileFromRuns(
    [
      {
        usage: {
          prompt_tokens: 14,
          completion_tokens: 1290,
          completion_tokens_details: { reasoning_tokens: 0, image_tokens: 1290 },
        },
      },
    ],
    1
  );
  assert.equal(p.image_tokens_per_call, 1290);
  assert.equal(p.output_tokens_per_call, 1290);
});

test("a text profile reports zero image tokens rather than undefined", () => {
  const p = profileFromRuns([{ usage: { prompt_tokens: 3000, completion_tokens: 50 } }], 1);
  assert.equal(p.image_tokens_per_call, 0);
});

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test("a missing model is a failure that names the consequence", () => {
  const c = buildCatalogue({ openrouter: { data: [openRouterModel()] } });
  const r = validateCandidate({ slug: "gone/model", source: "openrouter" }, c, {});
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((k) => k.status === "fail" && k.detail.includes("withdrawn")));
});

test("a model present in the other catalogue is reported as a wrong source, not a missing model", () => {
  // These call for different fixes: one is a typo in the shortlist, the other is a re-plan. The
  // message has to say which, or the reader cannot tell a broken candidate from a withdrawn model.
  const c = buildCatalogue({
    openrouter: { data: [openRouterModel()] },
    huggingface: { data: [hfModel()] },
  });
  const wrongSource = validateCandidate({ slug: "google/gemma-3-4b-it", source: "openrouter" }, c, {});
  assert.equal(wrongSource.ok, false);
  assert.ok(
    wrongSource.checks[0].detail.includes("source field is probably wrong"),
    `expected a wrong-source message, got: ${wrongSource.checks[0].detail}`
  );

  // Same slug, but genuinely absent from both catalogues: that is a withdrawal, not a typo.
  const withdrawn = validateCandidate({ slug: "openai/gpt-4-turbo", source: "openrouter" }, c, {});
  assert.equal(withdrawn.ok, false);
  assert.ok(withdrawn.checks[0].detail.includes("withdrawn"));
});

test("a canonical slug that has drifted from the id is flagged", () => {
  const c = buildCatalogue({
    openrouter: { data: [openRouterModel({ rest: { canonical_slug: "openai/gpt-4o-mini-2024-07-18" } })] },
  });
  const r = validateCandidate({ slug: "openai/gpt-4o-mini", source: "openrouter" }, c, {});
  assert.ok(r.checks.some((k) => k.name === "renamed" && k.status === "warn"));
  assert.equal(r.ok, true, "drift is a warning: the id still resolves");
});

test("a model that cannot produce the workload's modality fails", () => {
  const c = buildCatalogue({ openrouter: { data: [openRouterModel()] } });
  const r = validateCandidate(
    { slug: "openai/gpt-4o-mini", source: "openrouter" },
    c,
    { workload_kind: "image" }
  );
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((k) => k.name === "output_modalities" && k.status === "fail"));
});

test("a context window smaller than the workload fails rather than being priced anyway", () => {
  const c = buildCatalogue({ openrouter: { data: [openRouterModel({ rest: { context_length: 1000 } })] } });
  const r = validateCandidate(
    { slug: "openai/gpt-4o-mini", source: "openrouter" },
    c,
    { buyer_estimate: { assumed_input_tokens_per_request: 5000 } }
  );
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((k) => k.name === "context_length" && k.status === "fail"));
});

test("the measured token count is preferred over the buyer's assumption for the context check", () => {
  const c = buildCatalogue({ openrouter: { data: [openRouterModel({ rest: { context_length: 1000 } })] } });
  const workload = { buyer_estimate: { assumed_input_tokens_per_request: 500 } };
  // The buyer's guess of 500 would pass; the measurement of 5000 does not. The measurement wins.
  const r = validateCandidate(
    { slug: "openai/gpt-4o-mini", source: "openrouter" },
    c,
    workload,
    { measured: { input_tokens_per_call: 5000 } }
  );
  assert.equal(r.ok, false);
  assert.equal(requiredInputTokens(workload, { input_tokens_per_call: 5000 }).basis, "measured");
});

test("a HF candidate whose only provider is not live cannot be served at all", () => {
  const c = buildCatalogue({
    huggingface: { data: [hfModel({ extraProviders: [] }).id ? { ...hfModel(), providers: [{ provider: "down", status: "stopped", context_length: 1000 }] } : null] },
  });
  const r = validateCandidate({ slug: "google/gemma-3-4b-it", source: "huggingface" }, c, {});
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((k) => k.name === "providers" && k.status === "fail"));
});

test("a named provider that is live but unpriced warns, because its cost cannot be projected", () => {
  // The named provider has no price, but another provider on the same model does, so the route is
  // still priceable. That makes it a warning. When NO provider is priced it becomes a failure,
  // which the next test covers.
  const c = buildCatalogue({
    huggingface: {
      data: [
        {
          ...hfModel(),
          providers: [
            { provider: "deepinfra", status: "live", context_length: 131072 },
            { provider: "together", status: "live", context_length: 131072, pricing: { input: 0.2, output: 0.4 } },
          ],
        },
      ],
    },
  });
  const r = validateCandidate(
    { slug: "google/gemma-3-4b-it", source: "huggingface", provider: "deepinfra" },
    c,
    {}
  );
  assert.equal(r.ok, true, "unpriced is a warning, not a rejection, when a priced route exists");
  assert.ok(r.checks.some((k) => k.name === "requested_provider" && k.status === "warn"));
});

test("a model whose every live provider is unpriced fails, because it cannot be compared", () => {
  const c = buildCatalogue({
    huggingface: {
      data: [{ ...hfModel(), providers: [{ provider: "deepinfra", status: "live", context_length: 131072 }] }],
    },
  });
  const r = validateCandidate({ slug: "google/gemma-3-4b-it", source: "huggingface" }, c, {});
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((k) => k.name === "priced" && k.status === "fail"));
});

test("the provider list keeps entries the price ranking discarded", () => {
  // Regression: the normaliser used to store only priced-and-live providers, so a model with four
  // listed providers looked like a one-provider model and the fallback question was answered from
  // incomplete evidence.
  const m = normaliseHuggingFaceModel(
    hfModel({
      extraProviders: [
        { provider: "unpriced", status: "live", context_length: 8000 },
        { provider: "stopped", status: "stopped", context_length: 8000, pricing: { input: 0.1, output: 0.1 } },
      ],
    })
  );
  assert.equal(m.providers.length, 3, "all three listed providers are kept");
  assert.equal(m.providers_ranked.length, 1, "only the priced and live one is rankable");
  assert.equal(m.providers.filter((p) => p.live).length, 2, "two of the three are live");
});

// ---------------------------------------------------------------------------
// an entry that is not a shortlist entry at all
// ---------------------------------------------------------------------------

test("a shortlist entry that is not an object is rejected with a reason, not a throw", () => {
  // The shortlist is a file a human edits, so one malformed entry among good ones is a normal
  // event: a trailing comma in the wrong place leaves a null in the array. It used to throw out of
  // `.slug` and take the whole run with it, which is the worst available answer - the file is still
  // readable, every other entry was fine, and the run that died was the one that could have named
  // the line to fix.
  const c = buildCatalogue({ openrouter: { data: [openRouterModel()] } });
  const shortlist = validateShortlist(
    [null, { slug: "openai/gpt-4o-mini", source: "openrouter" }],
    c,
    {}
  );

  assert.equal(shortlist.results.length, 2, "the bad entry was dropped instead of reported");
  assert.equal(shortlist.valid.length, 1, "the good entry stopped being priceable");
  assert.equal(shortlist.invalid[0].checks[0].name, "shape");
  assert.ok(shortlist.invalid[0].checks[0].detail.includes("null"));
  // A rejected row still has to carry a name, or it prints against a blank line and the reader
  // cannot tell which entry the complaint is about.
  assert.ok(shortlist.invalid[0].name);
});

test("a slug written as a bare string is told how to spell itself", () => {
  const c = buildCatalogue({ openrouter: { data: [openRouterModel()] } });
  const [r] = validateShortlist(["openai/gpt-4o-mini"], c, {}).results;

  assert.equal(r.ok, false);
  // The fix is one edit, so the message carries it verbatim rather than describing it.
  assert.ok(r.checks[0].detail.includes('{"slug": "openai/gpt-4o-mini"}'), r.checks[0].detail);
  assert.equal(r.slug, "openai/gpt-4o-mini", "the intended id is lost, so the row reads as anonymous");
});

test("an entry with no slug does not pass its display name off as an id", () => {
  const c = buildCatalogue({ openrouter: { data: [openRouterModel()] } });
  const [r] = validateShortlist([{ name: "GPT-4o mini" }], c, {}).results;

  assert.equal(r.ok, false);
  assert.ok(r.checks[0].detail.includes('no "slug"'), r.checks[0].detail);
  // An entry with a name and no id is exactly the case where a reader would take the name for the
  // thing to look up and go hunting in the catalogue for it.
  assert.ok(r.checks[0].detail.includes("display name, not an id"), r.checks[0].detail);
});

test("a shortlist entry that is a list or a number is named, not merely refused", () => {
  const c = buildCatalogue({ openrouter: { data: [openRouterModel()] } });
  const kinds = [
    [[["openai/gpt-4o-mini"]], "an array"],
    [42, "a number"],
  ];
  for (const [bad, expected] of kinds) {
    const [r] = validateShortlist([bad], c, {}).results;
    assert.equal(r.ok, false);
    assert.ok(r.checks[0].detail.includes(expected), `${expected}: got ${r.checks[0].detail}`);
  }
});

test("a shortlist that is not a list validates as nothing rather than throwing", () => {
  // An absent `candidates` key is what a workload file looks like before anyone fills the shortlist
  // in. `.map` on it threw, so the run reported a stack trace where the true reading - no candidates
  // - was available and useful.
  const c = buildCatalogue({ openrouter: { data: [openRouterModel()] } });
  for (const bad of [undefined, null, { slug: "openrouter:openai/gpt-4o-mini" }, "openai/gpt-4o-mini"]) {
    const s = validateShortlist(bad, c, {});
    assert.equal(s.results.length, 0, `${JSON.stringify(bad)} produced rows out of nothing`);
    assert.equal(s.valid.length, 0);
    assert.equal(s.invalid.length, 0);
  }
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

test("routeFor reads the explicit route, then falls back to the source", () => {
  assert.equal(routeFor({ route: "C" }).id, "C");
  assert.equal(routeFor({ source: "huggingface" }).id, "B");
  assert.equal(routeFor({ source: "openrouter" }).id, "A");
});

test("self-hosting never returns a monthly_cost field", () => {
  // Nothing downstream may treat the estimate as a price sitting beside routes A and B.
  const e = selfHostEstimate(profile());
  assert.equal(e.monthly_cost, undefined);
  assert.ok(e.estimate_low_usd > 0);
  assert.ok(e.estimate_dedicated_usd > e.estimate_low_usd);
});

test("self-hosting states its assumptions and its workings", () => {
  const e = selfHostEstimate(profile());
  assert.ok(e.assumptions.provenance.includes("NOT VERIFIED"));
  assert.ok(e.workings.length >= 4);
  assert.ok(e.workings.some((w) => w.includes("GPU-hours")));
});

test("the required error factor is computed against the most favourable self-host figure", () => {
  const e = selfHostEstimate(profile(), { cheapestApiMonthly: 5 });
  assert.equal(Number(e.error_factor_to_compete.toFixed(4)), Number((e.estimate_low_usd / 5).toFixed(4)));
});

test("a busy GPU is not described as idle", () => {
  const heavy = profile({ input_tokens_per_call: 500000, calls_per_month: 200000 });
  const e = selfHostEstimate(heavy, { assumptions: { tokens_per_second: 2000 } });
  assert.ok(e.utilization > 0.5);
  assert.ok(e.workings.some((w) => w.includes("idle")));
});

test("a capped context with no room for the workload fails validation on the provider", () => {
  const c = buildCatalogue({
    huggingface: {
      data: [
        {
          ...hfModel(),
          providers: [
            { provider: "tiny", status: "live", context_length: 4096, pricing: { input: 0.01, output: 0.01 } },
            { provider: "big", status: "live", context_length: 131072, pricing: { input: 0.9, output: 0.9 } },
          ],
        },
      ],
    },
  });
  const r = validateCandidate(
    { slug: "google/gemma-3-4b-it", source: "huggingface", provider: "tiny" },
    c,
    { buyer_estimate: { assumed_input_tokens_per_request: 10000 } }
  );
  assert.equal(r.ok, false);
  assert.ok(r.checks.some((k) => k.name === "provider_context" && k.status === "fail"));
});

test("route B's licence is read from the model card, and a restricted licence is a con", () => {
  const m = normaliseHuggingFaceModel(hfModel());
  const hub = { gated: "manual", cardData: { license: "gemma" } };
  const { pros, cons } = prosAndCons(m, { hub });
  assert.ok(pros.some((p) => p.includes('"gemma"')));
  assert.ok(cons.some((c) => c.includes("bespoke or restricted")));
  assert.ok(cons.some((c) => c.includes("Gated")));
});

test("a permissive licence is a pro with no matching con", () => {
  const m = normaliseHuggingFaceModel(hfModel());
  const { pros, cons } = prosAndCons(m, { hub: { gated: false, cardData: { license: "apache-2.0" } } });
  assert.ok(pros.some((p) => p.includes("permissive")));
  assert.ok(!cons.some((c) => c.includes("restricted")));
});

test("a missing model card leaves the licence unknown rather than assumed permissive", () => {
  const m = normaliseHuggingFaceModel(hfModel());
  const { cons } = prosAndCons(m, { hub: null });
  assert.ok(cons.some((c) => c.includes("terms of use are unknown")));
});

test("a single live provider is named as lock-in on an otherwise open model", () => {
  const m = normaliseHuggingFaceModel(hfModel());
  const { cons } = prosAndCons(m, {});
  assert.ok(cons.some((c) => c.includes("lock-in")));
});

test("a live provider with no price is not counted as a usable fallback", () => {
  // Gemma's real situation: featherless-ai serves it and publishes no price. Counting it as a
  // fallback overstates the choice the buyer has, because the fallback cannot be budgeted for.
  const m = normaliseHuggingFaceModel(
    hfModel({
      extraProviders: [{ provider: "featherless-ai", status: "live", context_length: null }],
    })
  );
  const { pros } = prosAndCons(m, { hub: { gated: "manual", cardData: { license: "gemma" } } });
  assert.ok(
    pros.some((p) => p.includes("only 1 of the 2 live providers publishes a price")),
    `expected the fallback caveat, got: ${pros.join(" | ")}`
  );
});

test("the route table keeps estimates out of the price column", () => {
  const m = normaliseHuggingFaceModel(hfModel());
  const table = buildRouteTable([
    { route: "A", model: normaliseOpenRouterModel(openRouterModel()), monthly_cost: 4.8 },
    { route: "C", model: { slug: "x (weights)" }, estimate: selfHostEstimate(profile()) },
  ]);
  const c = table.rows.find((r) => r.route === "C");
  assert.equal(c.monthly_cost, null, "route C must never carry a monthly_cost");
  assert.equal(c.cost_kind, "estimate");
  assert.ok(table.caveat.includes("not a price"));
});
