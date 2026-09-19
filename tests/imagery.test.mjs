/**
 * The image leg: what gets sent, and what counts as an answer.
 *
 * Runs without a network and without spending anything. That is the point of core/imagery.mjs
 * being pure - the two facts worth testing here are "is the request body the one the pricing
 * reconciliation is built on" and "does an image response get read as an answer or as a failure",
 * and neither can be discovered by paying for a call and looking at the bill.
 *
 * The fixture JSON is a trimmed copy of a real OpenRouter image response, with the numbers taken
 * from the paid run recorded in docs/units.md:35-52 so the expected values are the ones the real
 * response produces.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  imageRequestBody,
  imageSource,
  imageEntryShape,
  dataUriToBytes,
  imageExtension,
  imageFileName,
  imageRunRecord,
  summariseImageRuns,
} from "../core/imagery.mjs";

// A 1x1 PNG. Small enough to inline, real enough that the base64 decodes to actual PNG bytes.
const TINY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/**
 * A successful gemini image response, trimmed from the 2026-09-14 paid run.
 *
 * `content` is null because the model returned a picture and no words. This is the shape that a
 * text-shaped reader reports as an empty answer.
 */
function geminiResponse() {
  return {
    id: "gen-1757900000-abc",
    model: "google/gemini-2.5-flash-image",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: null,
          images: [{ type: "image_url", image_url: { url: TINY_PNG } }],
        },
      },
    ],
    usage: {
      prompt_tokens: 14,
      completion_tokens: 1290,
      total_tokens: 1304,
      cost: 0.0387042,
      completion_tokens_details: { image_tokens: 1290, reasoning_tokens: 0 },
    },
  };
}

// ---------------------------------------------------------------------------
// the request body
// ---------------------------------------------------------------------------

test("the image body carries modalities, without which the call returns prose", () => {
  const body = imageRequestBody({ model: "google/gemini-2.5-flash-image", prompt: "a red circle" });
  assert.deepEqual(body.modalities, ["image", "text"]);
  assert.equal(body.model, "google/gemini-2.5-flash-image");
  assert.deepEqual(body.messages, [{ role: "user", content: "a red circle" }]);
  assert.deepEqual(body.usage, { include: true });
});

test("the image body sends no system message, no temperature and no max_tokens", () => {
  // Not an oversight. The paid call that produced the reconciliation in docs/units.md sent exactly
  // this shape, and adding a knob here would make the new run incomparable with the one the whole
  // image argument rests on.
  const body = imageRequestBody({ model: "x", prompt: "y" });
  assert.deepEqual(Object.keys(body).sort(), ["messages", "modalities", "model", "usage"]);
});

test("the workload's own modalities are what get sent", () => {
  const body = imageRequestBody({ model: "x", prompt: "y", modalities: ["image"] });
  assert.deepEqual(body.modalities, ["image"]);
});

// ---------------------------------------------------------------------------
// the response, as an answer
// ---------------------------------------------------------------------------

test("an image response with no text at all is an answer, not an empty one", () => {
  // The load-bearing case. message.content is null and message.images[] holds the picture. The
  // text path's EMPTY ANSWER rule would fail this call, and it is a completely correct call.
  const r = imageRunRecord({ json: geminiResponse(), latency_ms: 4310, attempts: 1 });
  assert.equal(r.error, undefined);
  assert.equal(r.image_count, 1);
  assert.equal(r.answer, null);
});

test("the image tokens come from completion_tokens_details, not cost_details", () => {
  // The approved plan named usage.cost_details.image_tokens. The real path is
  // usage.completion_tokens_details.image_tokens, confirmed independently by docs/units.md:41 and
  // scripts/smoke_test.py:385. Reading the plan's path returns undefined and silently prices the
  // image at zero.
  const r = imageRunRecord({ json: geminiResponse(), latency_ms: 4310, attempts: 1 });
  assert.equal(r.image_tokens, 1290);
  assert.equal(r.usage.completion_tokens_details.image_tokens, 1290);
  assert.equal(r.usage.cost_details, undefined);
});

test("usage.cost is preferred over an estimate, because it is the authority", () => {
  const r = imageRunRecord({ json: geminiResponse(), latency_ms: 4310, attempts: 1 });
  assert.equal(r.cost, 0.0387042);
  assert.equal(r.cost_source, "usage.cost");
});

test("a response with no cost at all is null, not zero", () => {
  const json = geminiResponse();
  delete json.usage.cost;
  const r = imageRunRecord({ json, latency_ms: 100, attempts: 1 });
  assert.equal(r.cost, null);
  assert.equal(r.cost_source, "usage.estimated_cost");
});

test("a response with no image is a failure, and the error says what came back instead", () => {
  const json = geminiResponse();
  json.choices[0].message.images = [];
  json.choices[0].message.content = "I cannot generate images with this model.";

  const r = imageRunRecord({ json, latency_ms: 900, attempts: 1 });
  assert.match(r.error, /NO IMAGE RETURNED/);
  // The failing call's own numbers, so the failure can be diagnosed without re-running it.
  assert.match(r.error, /image_tokens=1290/);
  assert.match(r.error, /finish_reason=stop/);
  assert.match(r.error, /I cannot generate images/);
});

test("a missing images array is a failure, not a crash", () => {
  const json = geminiResponse();
  delete json.choices[0].message.images;
  const r = imageRunRecord({ json, latency_ms: 900, attempts: 1 });
  assert.equal(r.image_count, 0);
  assert.match(r.error, /NO IMAGE RETURNED/);
});

test("an output cut off at the token cap is flagged, not silently called a worse picture", () => {
  // A harness limit must not read as a model that draws badly.
  const json = geminiResponse();
  json.choices[0].finish_reason = "length";
  const r = imageRunRecord({ json, latency_ms: 900, attempts: 1 });
  assert.match(r.error, /TRUNCATED AT max_tokens/);
  // The picture still exists and is still counted, so the run is not lost.
  assert.equal(r.image_count, 1);
});

test("a response with no choices does not throw", () => {
  const r = imageRunRecord({ json: {}, latency_ms: 900, attempts: 1 });
  assert.equal(r.image_count, 0);
  assert.equal(r.cost, null);
  assert.match(r.error, /NO IMAGE RETURNED/);
});

test("the cost field survives a null json body", () => {
  const r = imageRunRecord({ json: null, latency_ms: 900, attempts: 1 });
  assert.equal(r.cost, null);
  assert.equal(r.image_tokens, null);
});

// ---------------------------------------------------------------------------
// data URIs
// ---------------------------------------------------------------------------

test("a base64 data URI decodes to real bytes", () => {
  const decoded = dataUriToBytes(TINY_PNG);
  assert.equal(decoded.mime, "image/png");
  // The PNG magic number. If this is not here the decoder produced plausible-looking garbage.
  assert.deepEqual([...decoded.bytes.subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
});

test("a URL is not a data URI, and is not guessed at", () => {
  // A provider handing back a link instead of an embedded payload is a different finding from one
  // that returned nothing, and the caller has to be able to tell them apart.
  assert.equal(dataUriToBytes("https://example.com/image.png"), null);
  assert.equal(dataUriToBytes(null), null);
  assert.equal(dataUriToBytes(undefined), null);
});

// ---------------------------------------------------------------------------
// the shape of a message.images[] entry
// ---------------------------------------------------------------------------

test("the documented OpenRouter entry shape is read", () => {
  // {type, image_url: {url}} is what OpenRouter documents. It is also the shape the repo has never
  // recorded, because scripts/smoke_test.py only ever checked the array length.
  assert.equal(imageSource({ type: "image_url", image_url: { url: TINY_PNG } }), TINY_PNG);
  assert.equal(imageEntryShape({ type: "image_url", image_url: { url: TINY_PNG } }), "object:image_url.url");
});

test("a bare string entry is read", () => {
  assert.equal(imageSource(TINY_PNG), TINY_PNG);
  assert.equal(imageEntryShape(TINY_PNG), "string");
});

test("the other plausible shapes are read rather than silently skipped", () => {
  // Accepting these costs nothing and the alternative is four paid calls that write no files.
  assert.equal(imageSource({ url: TINY_PNG }), TINY_PNG);
  assert.equal(imageSource({ b64_json: "AAAA" }), "data:image/png;base64,AAAA");
  assert.equal(imageSource({ data: TINY_PNG }), TINY_PNG);
});

test("an unrecognisable entry yields null rather than a garbage string", () => {
  assert.equal(imageSource({ type: "image_url" }), null);
  assert.equal(imageSource({}), null);
  assert.equal(imageSource(null), null);
  assert.equal(imageSource(42), null);
});

test("an entry that is not an embedded payload is a failure, not an empty folder", () => {
  // This is the bug the stubbed run caught: the entry arrived, the extractor did not read it, and
  // the run reported success while writing nothing. Naming the shape is what makes it a one-step fix.
  const json = geminiResponse();
  json.choices[0].message.images = [{ type: "image_url", url: null }];

  const r = imageRunRecord({ json, latency_ms: 900, attempts: 1 });
  assert.match(r.error, /IMAGE ENTRY NOT READABLE/);
  assert.match(r.error, /object:type/);
  assert.equal(r.image_entries, 1);
  assert.equal(r.image_count, 0);
  // The call was billed regardless, and the record has to say so.
  assert.match(r.error, /image_tokens=1290/);
});

test("the record names the entry shape it saw, so a paid run documents it", () => {
  const r = imageRunRecord({ json: geminiResponse(), latency_ms: 4310, attempts: 1 });
  assert.equal(r.image_entry_shape, "object:image_url.url");
  assert.equal(r.image_entries, 1);
  assert.equal(r.image_count, 1);
  assert.equal(r.images.length, 1);
});

test("a bare URL entry is a failure rather than a zero-byte file", () => {
  const json = geminiResponse();
  json.choices[0].message.images = ["https://cdn.example.com/out.png"];
  const r = imageRunRecord({ json, latency_ms: 900, attempts: 1 });
  assert.match(r.error, /IMAGE ENTRY NOT READABLE/);
  assert.match(r.error, /"string"/);
});

test("a non-base64 data URI decodes as text rather than being reported as binary", () => {
  const decoded = dataUriToBytes("data:image/svg+xml,%3Csvg%2F%3E");
  assert.equal(decoded.mime, "image/svg+xml");
  assert.equal(decoded.bytes.toString("utf8"), "<svg/>");
});

// ---------------------------------------------------------------------------
// file names
// ---------------------------------------------------------------------------

test("a model slug with a slash does not become a directory", () => {
  // google/gemini-2.5-flash-image written raw creates a directory called google.
  const name = imageFileName("google/gemini-2.5-flash-image");
  assert.equal(name, "google_gemini-2.5-flash-image.png");
  assert.ok(!name.includes("/"));
});

test("each run gets its own file, because the variation between runs is a finding", () => {
  assert.equal(imageFileName("openai/gpt-5-image-mini", 0), "openai_gpt-5-image-mini-run1.png");
  assert.equal(imageFileName("openai/gpt-5-image-mini", 1), "openai_gpt-5-image-mini-run2.png");
});

test("the extension follows the media type, and an unknown type is not called a png", () => {
  assert.equal(imageExtension("image/png"), "png");
  assert.equal(imageExtension("image/jpeg"), "jpg");
  assert.equal(imageExtension("image/webp"), "webp");
  assert.equal(imageExtension("application/octet-stream"), "bin");
  assert.equal(imageExtension(undefined), "bin");
});

// ---------------------------------------------------------------------------
// the summary
// ---------------------------------------------------------------------------

test("quality fields are absent, not zero, so nothing renders 0 of 0 correct", () => {
  const s = summariseImageRuns([{ latency_ms: 4310, cost: 0.0387042, image_count: 1, image_tokens: 1290 }]);
  assert.equal(s.quality_scored, false);
  assert.equal("correct_share" in s, false);
  assert.equal("correct" in s, false);
  assert.equal("hallucination_count" in s, false);
});

test("a failed run is excluded from latency but NOT from the cost sum", () => {
  // Opposite rules, both deliberate. The time a call that produced no picture took is not a
  // generation time. The tokens it burned getting there were still billed, and dropping them would
  // understate the monthly figure, which is the one number this whole page exists to produce.
  const s = summariseImageRuns([
    { latency_ms: 4000, cost: 0.04, image_count: 1, image_tokens: 1290 },
    { latency_ms: 1900, cost: 0.012, image_count: 0, error: "NO IMAGE RETURNED" },
  ]);
  assert.equal(s.runs, 2);
  assert.equal(s.succeeded, 1);
  assert.equal(s.failed, 1);
  assert.equal(s.latency_ms.median, 4000);
  // Summed in dollars, so compared with a tolerance rather than by exact equality: 0.04 + 0.012 is
  // 0.052000000000000005 in binary floating point, and asserting the exact literal would be testing
  // IEEE-754 rather than this rule.
  assert.ok(Math.abs(s.measured_cost_usd - 0.052) < 1e-12, `got ${s.measured_cost_usd}`);
  assert.equal(s.cost_coverage, "2/2");
});

test("a run that reported no cost is not counted as a free one", () => {
  const s = summariseImageRuns([
    { latency_ms: 4000, cost: 0.04, image_count: 1, image_tokens: 1290 },
    { latency_ms: 4100, cost: null, image_count: 1, image_tokens: 1290 },
  ]);
  assert.equal(s.measured_cost_usd, 0.04);
  assert.equal(s.cost_coverage, "1/2");
});

test("the two runs are reported as a min and a max, not dressed up as a p95", () => {
  // Two samples is not a distribution, and printing a p95 over them would imply one.
  const s = summariseImageRuns([
    { latency_ms: 40000, cost: 0.1, image_count: 1, image_tokens: 4175 },
    { latency_ms: 40800, cost: 0.1, image_count: 1, image_tokens: 4175 },
  ]);
  assert.equal(s.latency_ms.median, 40400);
  assert.equal(s.latency_ms.min, 40000);
  assert.equal(s.latency_ms.max, 40800);
  assert.equal("p95" in s.latency_ms, false);
});

test("no runs at all is null everywhere, not zero", () => {
  const s = summariseImageRuns([]);
  assert.equal(s.latency_ms.median, null);
  assert.equal(s.measured_cost_usd, null);
  assert.equal(s.images_returned, 0);
});
