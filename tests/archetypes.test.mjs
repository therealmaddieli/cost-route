/**
 * Workload archetypes: named token-ratio defaults, and the scaffold built from them.
 *
 * Two things matter here. First, that every shipped archetype is well-formed enough to seed a
 * real workload file (positive token counts, the text a report would actually render). Second,
 * that scaffoldWorkload() only ever acts at creation time: it has to produce a workload object
 * that is correct right now, but it must never become a mechanism that could silently re-apply
 * archetype defaults over a buyer's real numbers later - this file is the place that would catch
 * that if it ever grew in that direction, so it tests the whole returned shape, not just that the
 * function runs.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { ARCHETYPES, archetypeFor, scaffoldWorkload } from "../core/archetypes.mjs";

test("every shipped archetype is well-formed", () => {
  for (const [slug, a] of Object.entries(ARCHETYPES)) {
    assert.equal(a.slug, slug, `archetype keyed "${slug}" reports its own slug as "${a.slug}"`);
    assert.ok(a.label && a.label.length > 0, `${slug}: missing a label`);
    assert.ok(a.description && a.description.length > 0, `${slug}: missing a description`);
    assert.ok(
      Number.isFinite(a.typical_io_ratio?.assumed_input_tokens_per_request) &&
        a.typical_io_ratio.assumed_input_tokens_per_request > 0,
      `${slug}: assumed_input_tokens_per_request must be a positive number`
    );
    assert.ok(
      Number.isFinite(a.typical_io_ratio?.assumed_output_tokens_per_request) &&
        a.typical_io_ratio.assumed_output_tokens_per_request > 0,
      `${slug}: assumed_output_tokens_per_request must be a positive number`
    );
    assert.ok(a.cache_expectation_note, `${slug}: missing a cache expectation note`);
    assert.ok(a.reasoning_note, `${slug}: missing a reasoning note`);
  }
});

test("archetypeFor resolves a known slug and returns null for an unknown one", () => {
  assert.equal(archetypeFor("coding-assistant")?.label, "Coding assistant");
  assert.equal(archetypeFor("not-a-real-archetype"), null);
  assert.equal(archetypeFor(undefined), null);
  assert.equal(archetypeFor(null), null);
});

test("scaffoldWorkload throws, naming the bad slug, on an unknown archetype", () => {
  assert.throws(() => scaffoldWorkload("not-a-real-archetype"), /unknown archetype "not-a-real-archetype"/);
});

test("scaffoldWorkload seeds buyer_estimate from the archetype's own ratio, not an invented one", () => {
  const w = scaffoldWorkload("agentic-tool-use");
  const a = ARCHETYPES["agentic-tool-use"];
  assert.equal(w.archetype, "agentic-tool-use");
  assert.equal(w.buyer_estimate.assumed_input_tokens_per_request, a.typical_io_ratio.assumed_input_tokens_per_request);
  assert.equal(w.buyer_estimate.assumed_output_tokens_per_request, a.typical_io_ratio.assumed_output_tokens_per_request);
  // Deliberately null, not a guessed dollar figure: nothing has priced this yet.
  assert.equal(w.buyer_estimate.assumed_cost_per_month_usd, null);
  assert.match(w.buyer_estimate.note, /archetype defaults, not the buyer's numbers/);
});

test("scaffoldWorkload's golden_set carries the requested count and the usual kind split", () => {
  const w = scaffoldWorkload("document-analysis", { questionCount: 10 });
  assert.equal(w.golden_set.length, 10);

  const counts = w.golden_set.reduce((acc, item) => {
    acc[item.kind] = (acc[item.kind] ?? 0) + 1;
    return acc;
  }, {});
  assert.equal(counts.absent, 1, "a 10-question scaffold should carry exactly one absent/trap item");
  assert.ok(counts.multi_hop >= 1, "a 10-question scaffold should carry at least one multi_hop item");
  assert.equal(
    (counts.fact ?? 0) + (counts.multi_hop ?? 0) + (counts.absent ?? 0),
    10,
    "every item must be one of the three known kinds"
  );

  // The one absent item names its trap, same convention as samples/workload.legal.json.
  const absentItem = w.golden_set.find((item) => item.kind === "absent");
  assert.ok(absentItem.trap, "an absent-kind scaffold item must carry a trap field");

  // Every item is a placeholder, and says so, rather than looking like a finished question.
  for (const item of w.golden_set) {
    assert.ok(item.id, "every scaffold item needs an id");
    assert.match(item.question, /^TODO/);
  }
});

test("a very small golden_set has no room for an absent/trap item, and says so by omitting it", () => {
  const w = scaffoldWorkload("chat-support", { questionCount: 3 });
  assert.equal(w.golden_set.length, 3);
  assert.equal(w.golden_set.some((item) => item.kind === "absent"), false);
});

test("scaffoldWorkload defaults the name to the archetype's label, and respects an override", () => {
  assert.equal(scaffoldWorkload("chat-support").workload_name, "Chat / customer support");
  assert.equal(scaffoldWorkload("chat-support", { name: "Prospect X support bot" }).workload_name, "Prospect X support bot");
});

test("scaffoldWorkload always produces a text workload with an empty shortlist to fill in", () => {
  const w = scaffoldWorkload("coding-assistant");
  assert.equal(w.workload_kind, "text");
  assert.deepEqual(w.candidates, []);
});
