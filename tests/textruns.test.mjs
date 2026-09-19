/**
 * The text leg's run record, which had no tests until it had a module.
 *
 * This file exists because of a bug the tests could not have caught: `captureText` lived inside
 * scripts/benchmark.mjs, which runs a benchmark the moment it is imported, so nothing could reach
 * it. The image leg's equivalent lives in core/imagery.mjs and is covered in tests/imagery.test.mjs,
 * and the two drifted exactly where you would expect - the image leg learned to flag an output cut
 * off at the token cap, and the text leg never did. Every case below has a named counterpart in
 * tests/imagery.test.mjs, on purpose: two legs of one comparison should fail the same test twice.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { captureText } from "../core/textruns.mjs";

/** A plain text response, shaped like what OpenRouter returns for this workload. */
function textResponse(overrides = {}) {
  return {
    id: "gen-1",
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: "The notice period is thirty days." },
        ...overrides.choice,
      },
    ],
    usage: {
      prompt_tokens: 3120,
      completion_tokens: 42,
      total_tokens: 3162,
      cost: 0.001215,
      completion_tokens_details: { reasoning_tokens: 0 },
      ...overrides.usage,
    },
  };
}

test("a normal answer is captured with its cost and its stop reason", () => {
  const r = captureText(textResponse(), 1200, 1, false);

  assert.equal(r.answer, "The notice period is thirty days.");
  assert.equal(r.error, undefined);
  assert.equal(r.cost, 0.001215);
  assert.equal(r.cost_source, "usage.cost");
  assert.equal(r.stop_reason, "stop");
  assert.equal(r.latency_ms, 1200);
});

test("an answer cut off at the token cap is a harness limit, not a wrong answer", () => {
  // The bug this module was created to fix. A truncated answer still looks like an answer, so it
  // was scored, and every question the harness cut short was counted against the model's accuracy.
  const json = textResponse({ choice: { finish_reason: "length" } });
  const r = captureText(json, 3000, 1, false);

  assert.match(r.error, /TRUNCATED AT max_tokens/);
  assert.match(r.error, /finish_reason=length/);
  assert.match(r.error, /completion_tokens=42/);
  // How far it got before the cap, which is the difference between "the cap is slightly low" and
  // "the model spent the whole budget on hidden reasoning".
  assert.match(r.error, /33 characters written/);
  // No answer is attached, so the scorer cannot quietly score it anyway.
  assert.equal(r.answer, undefined);
});

test("the truncation message is the same words as the image leg's", () => {
  // One search should find both legs. If these diverge, a reader grepping for the cap gets half the
  // story and concludes only one workload ever hits it.
  const r = captureText(textResponse({ choice: { finish_reason: "length" } }), 3000, 1, false);
  assert.ok(r.error.startsWith("TRUNCATED AT max_tokens (finish_reason=length,"), r.error);
});

test("an empty answer is reported as a failure that names the reasoning tokens", () => {
  const json = textResponse({
    choice: { finish_reason: "stop", message: { role: "assistant", content: "   " } },
    usage: { completion_tokens: 3000, completion_tokens_details: { reasoning_tokens: 3000 } },
  });
  const r = captureText(json, 4000, 1, false);

  assert.match(r.error, /EMPTY ANSWER/);
  assert.match(r.error, /reasoning_tokens=3000/);
  assert.equal(r.answer, undefined);
});

test("an answer that is empty and truncated keeps the more diagnostic of the two messages", () => {
  // Both rules apply. The empty-answer message wins because it names where the cap went, which the
  // truncation message cannot. Whichever wins, the run is a failure rather than a wrong answer.
  const json = textResponse({
    choice: { finish_reason: "length", message: { role: "assistant", content: "" } },
    usage: { completion_tokens: 3000, completion_tokens_details: { reasoning_tokens: 2990 } },
  });
  const r = captureText(json, 4000, 1, false);

  assert.match(r.error, /EMPTY ANSWER/);
  assert.match(r.error, /reasoning_tokens=2990/);
});

test("a response with no cost reports null, not zero", () => {
  // "we were not told" and "it was free" are different claims, and a zero here would be summed
  // into a monthly total as though the calls had been free.
  const json = textResponse();
  delete json.usage.cost;
  const r = captureText(json, 100, 1, false);

  assert.equal(r.cost, null);
  assert.equal(r.cost_source, "usage.estimated_cost");
});

test("a malformed body does not throw, it fails the call", () => {
  // A 200 carrying an error page, or an empty object: the runner needs a failed run, not an
  // exception that stops the benchmark partway through the shortlist.
  for (const json of [null, {}, { choices: [] }]) {
    const r = captureText(json, 500, 1, false);
    assert.match(r.error, /EMPTY ANSWER/, `${JSON.stringify(json)} did not degrade to a failure`);
    assert.equal(r.answer, undefined);
    assert.equal(r.cost, null);
  }
});

test("a dropped temperature is recorded, and its absence is not", () => {
  // The retry is only honest if the run says it happened. A record that always carried the flag
  // would make every temperature-free call look like a retried one.
  assert.equal(captureText(textResponse(), 100, 2, true).dropped_temperature, true);
  assert.equal(captureText(textResponse(), 100, 1, false).dropped_temperature, undefined);
});
