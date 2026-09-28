/**
 * The batch rate card: pairing, arithmetic, and the two ways this goes quietly wrong.
 *
 * Fixtures only, no network. The numbers are round on purpose - a 0.5 ratio is checkable by eye,
 * and the outliers below are shaped like the two real ones (a card that charges more async, and a
 * card that is cheaper only on the output side) rather than invented.
 *
 * The claim under test is architectural, not numeric: **batch is a variant rate card, not a sixth
 * price mechanic.** If these tests ever need `core/cost.mjs` to change to pass, the concept has
 * been modelled wrong and the reviewer should stop rather than adjust the engine.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  buildCatalogue,
  batchDiscount,
  catalogueSummary,
  findModel,
  BATCH_SUFFIX,
} from "../core/catalogue.mjs";
import { costPerCall } from "../core/cost.mjs";
import {
  captureText,
  textRequestBody,
  batchRequestBody,
  batchRuns,
  parseServerTime,
  BATCH_TERMINAL,
  BATCH_COMPLETION_WINDOW,
} from "../core/textruns.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A standard card at $2.00/M in, $8.00/M out. OpenRouter prices per token, as strings. */
const STANDARD = { prompt: "0.000002", completion: "0.000008" };

/** Half of it, to the digit. The case the announcement describes. */
const HALF = { prompt: "0.000001", completion: "0.000004" };

const orModel = (id, pricing = STANDARD, over = {}) => ({
  id,
  canonical_slug: id,
  name: id,
  context_length: 128000,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  pricing,
  ...over,
});

/** A Hugging Face entry needs a live priced provider or it normalises to unpriced. */
const hfModel = (id) => ({
  id,
  architecture: { input_modalities: ["text"], output_modalities: ["text"] },
  providers: [
    { provider: "somewhere", status: "live", context_length: 32768, pricing: { input: 0.1, output: 0.2 } },
  ],
});

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

// ---------------------------------------------------------------------------
// pairing
// ---------------------------------------------------------------------------

test("a `:batch` entry pairs onto its base, from both directions", () => {
  const c = buildCatalogue({
    openrouter: { data: [orModel("acme/model-a"), orModel("acme/model-a:batch", HALF)] },
  });

  const base = findModel(c, "acme/model-a", "openrouter");
  const variant = findModel(c, "acme/model-a:batch", "openrouter");

  // Both ends carry the link, so a reader can walk either way without re-parsing a slug.
  assert.equal(base.batch_variant, variant);
  assert.equal(variant.batch_of, "acme/model-a");
  assert.equal(c.batch.paired, 1);
  assert.deepEqual(c.batch.orphans, []);
});

test("the BATCH_SUFFIX is exact, and a `:free` variant is not a batch card", () => {
  // 17 `:free` entries sit in the same catalogue on 2026-09-28. Pairing on "contains a colon"
  // would absorb all of them and report a rate card that does not exist.
  const c = buildCatalogue({
    openrouter: { data: [orModel("acme/model-a"), orModel("acme/model-a:free", { prompt: "0", completion: "0" })] },
  });

  const base = findModel(c, "acme/model-a", "openrouter");
  const free = findModel(c, "acme/model-a:free", "openrouter");

  assert.equal(BATCH_SUFFIX, ":batch");
  assert.equal(base.batch_variant, undefined);
  assert.equal(free.batch_of, undefined);
  assert.equal(c.batch.paired, 0);
  assert.deepEqual(c.batch.orphans, []);
});

test("a batch card with no base is flagged and skipped, never thrown", () => {
  // Degrading matters because the catalogue drifts: a `:batch` entry can appear before its base
  // does. Throwing here would take the whole build down over one model.
  const c = buildCatalogue({
    openrouter: { data: [orModel("acme/model-a"), orModel("acme/vanished:batch", HALF)] },
  });

  const orphan = findModel(c, "acme/vanished:batch", "openrouter");

  // The base in this fixture carries no batch card of its own, so nothing pairs and the orphan
  // stands alone. The count and the orphan list are answered independently of each other.
  assert.equal(c.batch.paired, 0);
  assert.deepEqual(c.batch.orphans, ["acme/vanished:batch"]);
  assert.ok(
    orphan.flags.some((f) => f.startsWith("batch_variant_without_base")),
    "an orphan must say so on its own entry, not only in the build summary"
  );
  // No base means no comparison, so the ratio is absent rather than 1.0 or 0.
  assert.equal(batchDiscount({ slug: "acme/vanished", batch_variant: null }), null);
});

test("REGRESSION: a dual-listed model pairs onto its OWN catalogue's base, not the other's", () => {
  // The bug this pins. `openai/gpt-oss-120b` is open weights, so it is served by the HF router as
  // well, and HF entries are appended after OpenRouter ones and overwrite the bare `bySlug` key.
  // Pairing off the bare key attached the batch card to the Hugging Face model instead, and the
  // scan's `source === "openrouter"` filter then dropped both gpt-oss rows without a word -
  // 70 pairs reported where 72 exist.
  const c = buildCatalogue({
    openrouter: { data: [orModel("acme/shared-model"), orModel("acme/shared-model:batch", HALF)] },
    huggingface: { data: [hfModel("acme/shared-model")] },
  });

  const orBase = findModel(c, "acme/shared-model", "openrouter");
  const hfBase = findModel(c, "acme/shared-model", "huggingface");

  assert.equal(orBase.batch_variant.slug, "acme/shared-model:batch");
  assert.equal(
    hfBase.batch_variant,
    undefined,
    "a Hugging Face entry was handed an OpenRouter batch card"
  );
  assert.equal(c.batch.paired, 1);
});

// ---------------------------------------------------------------------------
// the ratio
// ---------------------------------------------------------------------------

test("a card at half price reports 0.5 and is cheaper", () => {
  const c = buildCatalogue({
    openrouter: { data: [orModel("acme/model-a"), orModel("acme/model-a:batch", HALF)] },
  });
  const d = batchDiscount(findModel(c, "acme/model-a", "openrouter"));

  assert.equal(d.slug, "acme/model-a");
  assert.equal(d.batch_slug, "acme/model-a:batch");
  assert.equal(d.prompt_ratio, 0.5);
  assert.equal(d.completion_ratio, 0.5);
  assert.equal(d.cheaper, true);
});

test("a card that charges MORE async is not a discount", () => {
  // Shaped like `openai/gpt-oss-20b` (prompt x1.333, completion x1.244 on 2026-09-28) and like
  // `deepseek/deepseek-v4.1-flash` (x4.48 prompt). Going async is supposed to be the cheap
  // option; on two published cards it is not, and the flag has to say so.
  const c = buildCatalogue({
    openrouter: {
      data: [
        orModel("acme/model-a"),
        orModel("acme/model-a:batch", { prompt: "0.0000026666666", completion: "0.0000099552" }),
      ],
    },
  });
  const d = batchDiscount(findModel(c, "acme/model-a", "openrouter"));

  assert.ok(d.prompt_ratio > 1);
  assert.equal(d.cheaper, false);
});

test("`cheaper` follows the PROMPT side, so a mixed card reads as dearer", () => {
  // `deepseek/deepseek-v4.1-flash` is x4.48 in and x0.56 out. A single flag has to pick one, and
  // input is both the larger term for most workloads and the one a batch buyer is optimising.
  // Reading it off the completion side would call that card a 44% saving.
  const c = buildCatalogue({
    openrouter: {
      data: [orModel("acme/model-a"), orModel("acme/model-a:batch", { prompt: "0.00000896", completion: "0.00000448" })],
    },
  });
  const d = batchDiscount(findModel(c, "acme/model-a", "openrouter"));

  assert.ok(d.prompt_ratio > 1);
  assert.ok(d.completion_ratio < 1);
  assert.equal(d.cheaper, false, "the input side went up; this is not a saving");
});

test("an unpriced side yields a null ratio and a null verdict, never a discount", () => {
  // The self-caught bug this pins: `ratio(...) < 1` evaluates `null < 1` to true, so a card with
  // no published price would have been reported as cheaper. Missing and zero are different facts.
  const c = buildCatalogue({
    openrouter: {
      data: [orModel("acme/model-a"), orModel("acme/model-a:batch", { completion: "0.000004" })],
    },
  });
  const d = batchDiscount(findModel(c, "acme/model-a", "openrouter"));

  assert.equal(d.prompt_ratio, null);
  assert.equal(d.completion_ratio, 0.5);
  assert.equal(d.cheaper, null, "an unknown ratio is not a saving and not a surcharge");
});

// ---------------------------------------------------------------------------
// the architectural claim
// ---------------------------------------------------------------------------

test("the EXISTING engine prices a batch card, with no change to core/cost.mjs", () => {
  // The whole reason batch was modelled as a variant rate card. costPerCall reads everything from
  // model.pricing, so handing it the variant runs the five-mechanic pipeline as-is - and the drift
  // guard over CLIENT_FN_SRC keeps covering exactly one function.
  const c = buildCatalogue({
    openrouter: { data: [orModel("acme/model-a"), orModel("acme/model-a:batch", HALF)] },
  });

  const base = findModel(c, "acme/model-a", "openrouter");
  const variant = findModel(c, "acme/model-a:batch", "openrouter");

  const sync = costPerCall(base, profile());
  const batch = costPerCall(variant, profile());

  assert.ok(sync.total > 0);
  assert.equal(Number((batch.total / sync.total).toFixed(10)), 0.5);
  // Both routes price completely: a half-priced card is still a priced card, not a partial one.
  assert.equal(batch.complete, true);
  assert.equal(batch.complete, sync.complete);
});

test("the tier mechanic survives the variant swap", () => {
  // `x-ai/grok-4.3` is one of the 7 outliers and carries an `overrides` tier above 200k tokens.
  // Tiering is a mechanic WITHIN a card, so it must still fire when that card is the batch one.
  const tiered = (rate) => ({
    prompt: rate,
    completion: rate,
    overrides: [{ min_prompt_tokens: 200000, prompt: "0.000009", completion: "0.000009" }],
  });
  const c = buildCatalogue({
    openrouter: { data: [orModel("acme/tiered", tiered("0.000002")), orModel("acme/tiered:batch", tiered("0.000001"))] },
  });

  const variant = findModel(c, "acme/tiered:batch", "openrouter");
  const small = costPerCall(variant, profile({ input_tokens_per_call: 1000 }));
  const large = costPerCall(variant, profile({ input_tokens_per_call: 300000 }));

  assert.ok(large.total > small.total * 100, "the batch card lost its tier above 200k");
  assert.equal(variant.pricing.tiers.length, 1);
});

// ---------------------------------------------------------------------------
// the recorder, and the count
// ---------------------------------------------------------------------------

test("a batch result body goes through the same text recorder as a sync response", () => {
  // A batch result item is `{custom_id, body}` where body is an ordinary chat-completions payload,
  // which is what lets the collect step reuse captureText unchanged.
  const body = {
    id: "gen-batch-1",
    choices: [{ message: { role: "assistant", content: "  Article 6(1) applies.  " }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1200, completion_tokens: 18, total_tokens: 1218, cost: 0.0009165 },
  };

  const r = captureText(body, null, 1, false);

  assert.equal(r.answer, "Article 6(1) applies.");
  assert.equal(r.cost, 0.0009165);
  assert.equal(r.cost_source, "usage.cost");

  // The batch leg has no per-call latency, and it must stay null. Day 4 set this rule for image
  // quality and Day 5 re-learned it for the latency clock: an absent measurement recorded as 0
  // passes a `<= 15000 ms` gate it never sat, which reads as the fastest leg in the table.
  assert.equal(r.latency_ms, null);
  assert.notEqual(r.latency_ms, 0);
});

test("catalogueSummary counts the batch cards and the orphans beside the other mechanisms", () => {
  const c = buildCatalogue({
    openrouter: {
      data: [orModel("acme/model-a"), orModel("acme/model-a:batch", HALF), orModel("acme/vanished:batch", HALF)],
    },
  });
  const s = catalogueSummary(c);

  assert.equal(s.mechanisms.openrouter_models_with_batch_card, 1);
  assert.equal(s.mechanisms.openrouter_batch_cards_without_base, 1);
  // Reported beside the five real mechanisms without being counted as one of them.
  assert.equal(typeof s.mechanisms.openrouter_tier_entries, "number");
});

// ---------------------------------------------------------------------------
// the batch wire format
// ---------------------------------------------------------------------------

const ITEMS = [
  { id: "term-length", question: "How long is the Initial Term?" },
  { id: "cure-period", question: "How long is the cure period?" },
];

const batchBody = (over = {}) =>
  batchRequestBody({
    model: "openai/gpt-4o-mini",
    items: ITEMS,
    answerInstruction: "Answer in one sentence.",
    contract: "CLAUSE 1. The term is 24 months.",
    ...over,
  });

test("`requests` is serialised LAST, because the API returns 400 if it comes first", () => {
  // OpenRouter's quickstart: "Serialize `endpoint`, `model`, and any `provider` or
  // `completion_window` before `requests`". JSON.stringify preserves insertion order, so this test
  // is the guard on that order - a refactor that sorted these keys would break every submission
  // with a 400 and nothing else in the suite would notice.
  const keys = Object.keys(batchBody());
  assert.equal(keys[keys.length - 1], "requests");
  assert.deepEqual(keys, ["endpoint", "model", "completion_window", "requests"]);

  // Asserted on the serialised form too, not only the object: the constraint is about what goes
  // over the wire, which is the string.
  const json = JSON.stringify(batchBody());
  assert.ok(
    json.lastIndexOf('"requests"') > json.lastIndexOf('"completion_window"'),
    "requests must not appear before the routing fields in the serialised payload"
  );
});

test("the optional routing fields are omitted, not sent as null", () => {
  // An explicit null is not the same as an absent key to a strict parser.
  const keys = Object.keys(batchBody({ provider: null, completionWindow: null }));
  assert.deepEqual(keys, ["endpoint", "model", "requests"]);

  const withProvider = batchBody({ provider: { only: ["deepinfra"] } });
  assert.deepEqual(Object.keys(withProvider), ["endpoint", "model", "provider", "completion_window", "requests"]);
  assert.deepEqual(withProvider.provider, { only: ["deepinfra"] });
});

test("every batch request carries a complete chat body identical to the synchronous one", () => {
  // The two legs must send the same bytes for the same question, or the comparison between them is
  // between two different questions. This is the drift the shared textRequestBody exists to prevent,
  // so it is pinned rather than commented.
  const payload = batchBody();
  const sync = textRequestBody({
    model: "openai/gpt-4o-mini",
    answerInstruction: "Answer in one sentence.",
    contract: "CLAUSE 1. The term is 24 months.",
    question: "How long is the Initial Term?",
  });

  assert.equal(payload.requests.length, 2);
  assert.deepEqual(payload.requests[0].body, sync);
  // custom_id is the golden-set id, which is what maps results back onto the same runs a sync run
  // produces. Anything else and the results cannot be scored.
  assert.deepEqual(payload.requests.map((r) => r.custom_id), ["term-length", "cure-period"]);
  assert.equal(payload.endpoint, "/v1/chat/completions");
  assert.equal(BATCH_COMPLETION_WINDOW, "24h");
});

test("a batch result body is read from response.body, NOT from the result itself", () => {
  // The trap. Each result is `{ id, custom_id, response: { status_code, request_id, body }, error }`,
  // and reading `result.body` finds nothing on every entry - turning a completed batch into a run
  // that produced no answers at all, which then reads as the model failing every question.
  const json = {
    status: "completed",
    usage: { prompt_tokens: 2400, completion_tokens: 36, total_tokens: 2436, cost: 0.0001833 },
    results: [
      {
        id: "r1",
        custom_id: "term-length",
        response: {
          status_code: 200,
          request_id: "req-1",
          body: {
            choices: [{ message: { role: "assistant", content: "24 months." }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1200, completion_tokens: 18, cost: 0.0000916 },
          },
        },
        error: null,
      },
    ],
  };

  const { runs, failed } = batchRuns(json);

  assert.equal(failed.length, 0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].id, "term-length");
  assert.equal(runs[0].answer, "24 months.");
  assert.equal(runs[0].cost, 0.0000916);
  assert.equal(runs[0].latency_ms, null, "the batch leg has no per-call latency; null, never 0");
});

test("a per-request failure is a failed call, not a wrong answer", () => {
  // "Exactly one of `response` or `error` is populated for each result." Both halves must land as
  // errors: scoring a request the provider rejected would blame the model for the transport.
  const json = {
    status: "completed",
    results: [
      { id: "r1", custom_id: "term-length", response: null, error: { code: 402, message: "insufficient credits" } },
      {
        id: "r2",
        custom_id: "cure-period",
        response: { status_code: 400, body: { error: { message: "bad request" } } },
        error: null,
      },
    ],
  };

  const { runs, failed } = batchRuns(json);

  assert.equal(failed.length, 2);
  assert.equal(runs.length, 2);
  for (const run of runs) {
    assert.ok(run.error, `${run.id} was scored despite failing`);
    assert.equal(run.answer, undefined, "a failed call must not carry an answer for the scorer to read");
    assert.equal(run.latency_ms, null);
  }
});

test("a terminal set covers every state where polling must stop", () => {
  // Polling a `finalizing` batch forever would hang the run, and `finalizing` is explicitly
  // transient and not usable as a list filter.
  for (const s of ["completed", "failed", "expired", "cancelled"]) {
    assert.ok(BATCH_TERMINAL.has(s), `${s} should be terminal`);
  }
  for (const s of ["validating", "in_progress", "finalizing", "cancelling"]) {
    assert.ok(!BATCH_TERMINAL.has(s), `${s} is transient and must not end the poll`);
  }
});

test("REGRESSION: a batch timestamp is read in both the shapes the API uses", () => {
  // The bug: `Date.parse` on the epoch-second `finalized_at` answers NaN, NaN selects the caller's
  // fallback, and the fallback was the poll clock - so a queue wait was reported as the length of
  // the poll that observed it, under a caption claiming the server had supplied it.
  const submitted = Date.parse("2026-09-28T08:40:25.423Z");
  const finalizedSeconds = 1790585240; // the API's own `finalized_at`, epoch seconds
  const finalizedMs = finalizedSeconds * 1000;

  assert.equal(parseServerTime(finalizedSeconds), finalizedMs, "epoch seconds were not scaled");
  assert.equal(parseServerTime(finalizedMs), finalizedMs, "epoch milliseconds were scaled twice");
  assert.equal(
    parseServerTime("2026-09-28T08:47:20.000Z"),
    finalizedMs,
    "an ISO string was not parsed"
  );

  // The number the whole exercise is about: ~7 minutes, not the ~18 the poll clock reported.
  assert.equal(
    Number(((parseServerTime(finalizedSeconds) - submitted) / 60000).toFixed(3)),
    6.91,
    "wrong queue wait"
  );

  // Unreadable is NaN, never zero. A zero here would render as a batch that finished instantly.
  for (const bad of [null, undefined, "", "not a date"]) {
    assert.ok(Number.isNaN(parseServerTime(bad)), `${JSON.stringify(bad)} should not read as a time`);
  }
  assert.ok(!Number.isNaN(parseServerTime(0)), "the epoch itself is a real time, not a parse failure");
});

// ---------------------------------------------------------------------------
// the finding canary
// ---------------------------------------------------------------------------

const catalogueCache = path.join(root, "out", "catalogue-latest.json");

test("FINDING: some published batch cards are not 50%", { skip: !fs.existsSync(catalogueCache) }, () => {
  // Not a correctness test - a canary. The headline claim is "50% is typical, not universal", and
  // this is the test that fails if the catalogue ever makes it universal, i.e. if the finding has
  // stopped being true and the report is still saying it. Skips when no catalogue has been
  // fetched, because then there is nothing to be a canary about.
  const payload = JSON.parse(fs.readFileSync(catalogueCache, "utf8"));
  const c = buildCatalogue(
    { openrouter: payload.openrouter, huggingface: payload.huggingface },
    payload.fetched_at
  );

  const pairs = c.models.filter((m) => m.source === "openrouter" && m.batch_variant).map(batchDiscount);
  const ratios = pairs.map((d) => d.prompt_ratio).filter((r) => r !== null);

  assert.ok(pairs.length > 0, "the catalogue carries no batch pairs at all");
  assert.deepEqual(c.batch.orphans, [], "a batch card lost its base");
  assert.ok(
    ratios.some((r) => r !== 0.5),
    `every one of the ${ratios.length} published batch cards is exactly 50%; the finding no longer holds`
  );
  assert.ok(
    ratios.filter((r) => r === 0.5).length > ratios.length / 2,
    "50% is no longer even the typical case, which the report's framing assumes"
  );
});
