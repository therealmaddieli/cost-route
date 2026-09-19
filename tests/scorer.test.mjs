/**
 * Tests for the requirements gate.
 *
 *   node --test tests/
 *
 * Two kinds of test live here. The first kind checks the scorer behaves as designed. The second
 * kind checks the GOLDEN SET is self-consistent: every item's own stated `expected` answer must
 * pass its own accept patterns. A typo in a regex would otherwise silently mark good models
 * wrong, which is the failure mode that would make this whole artifact untrustworthy.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalise,
  matchAny,
  scoreItem,
  percentile,
  summarise,
  gate,
  evaluateCandidate,
  measuredCostPerCall,
} from "../core/scorer.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const workload = JSON.parse(
  fs.readFileSync(path.join(here, "..", "samples", "workload.legal.json"), "utf8")
);
const goldenSet = workload.golden_set;

const item = (id) => goldenSet.find((g) => g.id === id);

// ---------------------------------------------------------------------------
// normalise
// ---------------------------------------------------------------------------

test("normalise folds case, whitespace and markdown", () => {
  assert.equal(normalise("  ANSWER:   90 Days.  "), "answer: 90 days.");
  assert.equal(normalise("**90 days**"), "90 days");
  assert.equal(normalise(null), "");
  assert.equal(normalise(undefined), "");
});

test("normalise converts unicode dashes to ascii", () => {
  // "12–month" with an en dash, as a PDF extraction would produce
  assert.equal(normalise("12–month cap"), "12-month cap");
  assert.equal(normalise("12—month cap"), "12-month cap");
  assert.equal(normalise("12−month cap"), "12-month cap");
});

test("normalise converts non-breaking spaces, which PDFs are full of", () => {
  // "EUR 18 000" with non-breaking spaces between the groups
  assert.equal(normalise("EUR 18 000"), "eur 18 000");
});

test("normalise unwraps a parenthetical numeral, the drafting style contracts use", () => {
  // This was a real false negative. The contract writes "twenty-four (24) months", every model
  // echoed that style back, and the ")" sitting between the numeral and its unit defeated every
  // number-then-unit pattern. Three models answered correctly and all three scored needs_review.
  assert.equal(normalise("twenty-four (24) months"), "twenty-four 24 months");
  assert.equal(normalise("Ninety (90) days"), "ninety 90 days");
  assert.equal(
    normalise("rate of one and a half per cent (1.5%) per month"),
    "rate of one and a half per cent 1.5% per month"
  );
  // It must NOT swallow parentheticals that are not pure numbers, e.g. a citation or a formula.
  assert.equal(normalise("(EU) 2016/679"), "(eu) 2016/679");
  assert.equal(normalise("twice (2x) the amount"), "twice (2x) the amount");
});

// ---------------------------------------------------------------------------
// matchAny
// ---------------------------------------------------------------------------

test("matchAny returns the matching pattern, or null", () => {
  assert.equal(matchAny("ninety days", ["\\b90\\b", "ninety"]), "ninety");
  assert.equal(matchAny("ninety days", ["\\b45\\b"]), null);
});

test("matchAny skips a malformed pattern instead of throwing", () => {
  // A typo in a user-supplied golden set must not destroy their whole run.
  assert.equal(matchAny("90 days", ["[unclosed", "90"]), "90");
  assert.equal(matchAny("90 days", ["[unclosed"]), null);
});

// ---------------------------------------------------------------------------
// scoreItem
// ---------------------------------------------------------------------------

test("an accept pattern makes an answer correct", () => {
  const s = scoreItem(item("renewal-notice"), "Not less than 90 days before the term ends.");
  assert.equal(s.correct, true);
  assert.equal(s.hallucination, false);
  assert.equal(s.via, "accept");
});

test("a reject pattern makes an answer wrong and flags it", () => {
  const s = scoreItem(item("data-protection-liability"), "Limited to EUR 216,000.");
  assert.equal(s.correct, false);
  assert.equal(s.hallucination, true);
  assert.equal(s.via, "reject");
});

test("reject wins over accept, so a wrong number cannot hide behind the right words", () => {
  // Contains the correct-sounding "excluded from" phrase AND a wrong figure. Must fail.
  const s = scoreItem(
    item("data-protection-liability"),
    "It is capped at 216,000, though some matters are excluded from the cap."
  );
  assert.equal(s.correct, false);
});

test("a correct answer that cites a real figure from elsewhere still passes", () => {
  // The false-positive risk: reject runs first, so this is the case worth pinning down.
  const s = scoreItem(
    item("data-protection-liability"),
    "Unlimited. The general 12-month cap in clause 8.2 does not apply to data protection."
  );
  assert.equal(s.correct, true);
  assert.equal(s.hallucination, false);
});

test("an absent item answered with a specific is a hallucination", () => {
  const s = scoreItem(item("fee-increase-notice"), "The Supplier must give 30 days' notice.");
  assert.equal(s.correct, false);
  assert.equal(s.hallucination, true);
});

test("an absent item answered correctly is correct", () => {
  const s = scoreItem(
    item("fee-increase-notice"),
    "Not specified in the document; the agreement provides no mechanism for a fee increase."
  );
  assert.equal(s.correct, true);
});

test("the contract's own drafting style scores as correct, not as needs_review", () => {
  // Verbatim answers taken from a live run. All three are right. The first version of the scorer
  // marked all three needs_review, which would have failed every model on the benchmark.
  assert.equal(
    scoreItem(item("term-length"), "The Initial Term is twenty-four (24) months, expiring on 28 February 2028.").correct,
    true
  );
  assert.equal(scoreItem(item("renewal-notice"), "Ninety (90) days").correct, true);
  assert.equal(
    scoreItem(item("renewal-notice"), "Not less than ninety (90) days' written notice (Clause 2.2).").correct,
    true
  );
  // ...and the same style must still be caught when it is FABRICATED, or the fix would have
  // opened the hallucination trap it sits next to.
  const fabricated = scoreItem(
    item("fee-increase-notice"),
    "The Supplier must give thirty (30) days' written notice before increasing the fees."
  );
  assert.equal(fabricated.correct, false);
  assert.equal(fabricated.hallucination, true);
});

test("a fabricated cap on the uncapped clause is caught, not merely flagged for review", () => {
  // Verbatim from a live run. Gemma answered the data-protection liability question with the
  // Service Credit percentage - a confident, specific, wrong number. It scored needs_review
  // before the reject list covered anything other than the 216,000 family.
  for (const answer of [
    "Ten per cent (10%) of the monthly fee for that month.",
    "The Customer could recover 18,000 euros.",
    "It is capped at EUR 50,000.",
  ]) {
    const s = scoreItem(item("data-protection-liability"), answer);
    assert.equal(s.correct, false, `not caught: ${answer}`);
    assert.equal(s.hallucination, true, `not flagged: ${answer}`);
  }
  // ...and a correct answer that mentions the real general cap as a contrast must still pass.
  const ok = scoreItem(
    item("data-protection-liability"),
    "Unlimited. The general 12-month cap in clause 8.2 does not apply to data protection."
  );
  assert.equal(ok.correct, true);
  assert.equal(ok.hallucination, false);
});

test("an unmatched answer on a normal item is needs_review, not silently wrong", () => {
  // We cannot tell here whether the model was wrong or our pattern list was too narrow.
  // Calling it plain 'wrong' would be a claim we cannot support.
  const s = scoreItem(item("late-interest"), "The applicable rate is generous.");
  assert.equal(s.correct, false);
  assert.equal(s.needs_review, true);
  assert.equal(s.hallucination, false);
});

test("an absent item answered correctly is NOT overturned by naming a real figure elsewhere", () => {
  // The absent item is the trap in this workload, so the scorer must not punish the model for
  // reading the rest of the contract. This answer names the real 90-day renewal notice and
  // still correctly reports that no fee increase provision exists. It counts as correct.
  const answer =
    "Not specified. Unlike the 90-day renewal notice, there is no fee increase provision.";
  const s = scoreItem(item("fee-increase-notice"), answer);
  assert.equal(s.correct, true);
  assert.equal(s.hallucination, false);
  // But it is recorded as hedged, because the model did put a notice period on the page next to
  // the question. Surfacing that is more honest than silently scoring it either way.
  assert.equal(s.hedged, true);
});

test("a correct absence answer is not flagged, however it is phrased", () => {
  // Verbatim from a live run, and the worst false positive the scorer produced: GPT-5 mini
  // answered the trap question correctly and was reported as having fabricated a figure. The
  // accept list had been an enumeration of ways to say "no" and did not contain this one.
  for (const answer of [
    "No notice period is specified in the Agreement.",
    "The agreement is silent on fee increases.",
    "There is no provision for increasing the fees.",
    "The document does not address fee increases.",
    "Not specified in the document.",
  ]) {
    const s = scoreItem(item("fee-increase-notice"), answer);
    assert.equal(s.correct, true, `missed a correct answer: ${answer}`);
    assert.equal(s.hallucination, false, `wrongly flagged: ${answer}`);
  }
});

test("an unclear non-answer is needs_review, not an accusation of fabrication", () => {
  // We only say "hallucination" when we can name the invented figure. Anything else is scored
  // incorrect, but labelled honestly.
  const s = scoreItem(item("fee-increase-notice"), "I am not sure about this one.");
  assert.equal(s.correct, false);
  assert.equal(s.hallucination, false);
  assert.equal(s.needs_review, true);
});

test("the absent item still catches a fabricated notice period", () => {
  // The hallucination trap must survive the softened rule above. This is the answer the trap
  // exists to catch: a real-looking number to a question the contract never answers.
  const s = scoreItem(
    item("fee-increase-notice"),
    "The Supplier must give 90 days' notice before increasing the fees."
  );
  assert.equal(s.correct, false);
  assert.equal(s.hallucination, true);
});

test("the absent trap tolerates a hyphen between the number and the unit", () => {
  // Regression guard. An earlier reject pattern used \s* only, so "90-day notice" slipped
  // through the trap entirely and a fabricated figure scored as needs_review.
  for (const answer of [
    "The Supplier must give a 30-day notice period before any fee increase.",
    "Fees may be increased on ninety (90) days' written notice.",
    "There is a 6-month notice requirement before fees can change.",
  ]) {
    const s = scoreItem(item("fee-increase-notice"), answer);
    assert.equal(s.correct, false, `not caught: ${answer}`);
    assert.equal(s.hallucination, true, `not flagged: ${answer}`);
  }
});

// ---------------------------------------------------------------------------
// percentile
// ---------------------------------------------------------------------------

test("percentile interpolates and handles the edges", () => {
  assert.equal(percentile([], 0.5), null);
  assert.equal(percentile([7], 0.5), 7);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2.5);
  assert.equal(percentile([1, 2, 3, 4, 5], 1), 5);
  assert.equal(percentile([1, 2, 3, 4, 5], 0), 1);
});

test("percentile ignores non-finite values rather than propagating NaN", () => {
  assert.equal(percentile([1, NaN, 3, Infinity], 0.5), 2);
});

// ---------------------------------------------------------------------------
// summarise
// ---------------------------------------------------------------------------

function runOf(id, correct, extra = {}) {
  const g = item(id);
  const answer = correct ? g.expected : "I am not sure.";
  return {
    id,
    latency_ms: 1000,
    cost: 0.001,
    answer,
    score: scoreItem(g, answer),
    ...extra,
  };
}

test("summarise counts correct answers and computes the share", () => {
  const runs = [
    runOf("renewal-notice", true),
    runOf("payment-terms", true),
    runOf("late-interest", false),
    runOf("cure-period", false),
  ];
  const s = summarise(runs);
  assert.equal(s.total, 4);
  assert.equal(s.correct, 2);
  assert.equal(s.correct_share, 0.5);
});

test("summarise reports cost coverage rather than presenting a partial sum as a total", () => {
  const runs = [
    runOf("renewal-notice", true),
    runOf("payment-terms", true),
    { id: "late-interest", latency_ms: 900, answer: "x", cost: null, score: scoreItem(item("late-interest"), "x") },
  ];
  const s = summarise(runs);
  assert.equal(s.cost_coverage, "2/3");
  assert.equal(s.measured_cost_usd, 0.002);
});

test("summarise excludes errored calls from the latency figures", () => {
  const runs = [
    runOf("renewal-notice", true, { latency_ms: 1000 }),
    { id: "payment-terms", latency_ms: 60000, answer: "", error: "HTTP 500", score: null },
  ];
  const s = summarise(runs);
  assert.equal(s.error_count, 1);
  assert.equal(s.latency_ms.p50, 1000); // the 60s failure must not drag the median
});

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

test("gate passes a candidate above every threshold", () => {
  const s = { scored: 14, correct_share: 0.9, hallucination_count: 0, error_count: 0,
              latency_ms: { p50: 2000 } };
  assert.equal(gate(s, { min_correct_share: 0.75, max_hallucinations: 0 }, 15000).verdict, "PASS");
});

test("gate fails on quality and names the shortfall", () => {
  const s = { scored: 14, correct: 9, correct_share: 0.64, hallucination_count: 0,
              error_count: 0, latency_ms: { p50: 2000 } };
  const { verdict, reasons } = gate(s, { min_correct_share: 0.75 }, 15000);
  assert.equal(verdict, "FAIL");
  assert.match(reasons[0], /64%.*75%.*9\/14/);
});

test("gate fails on latency even when quality is perfect", () => {
  const s = { scored: 14, correct_share: 1, hallucination_count: 0, error_count: 0,
              latency_ms: { p50: 20000 } };
  const { verdict, reasons } = gate(s, { min_correct_share: 0.75 }, 15000);
  assert.equal(verdict, "FAIL");
  assert.match(reasons.join(" "), /20000ms.*15000ms/);
});

test("gate fails on a single hallucination when the bar allows none", () => {
  const s = { scored: 14, correct_share: 0.9, hallucination_count: 1, error_count: 0,
              latency_ms: { p50: 2000 } };
  const { verdict, reasons } = gate(s, { min_correct_share: 0.75, max_hallucinations: 0 }, 15000);
  assert.equal(verdict, "FAIL");
  assert.match(reasons[0], /hallucination/);
});

test("gate fails a candidate that produced nothing", () => {
  const s = { scored: 0, correct_share: 0, hallucination_count: 0, error_count: 0,
              latency_ms: { p50: null } };
  assert.equal(gate(s, {}, 15000).verdict, "FAIL");
});

// ---------------------------------------------------------------------------
// evaluateCandidate, end to end
// ---------------------------------------------------------------------------

test("evaluateCandidate fails the cheapest candidate when it misses the bar", () => {
  const candidate = { name: "Cheap", slug: "cheap", route: "B", source: "huggingface" };
  // 9 of 14 correct: below the 0.75 bar.
  const runs = goldenSet.map((g, i) => runOf(g.id, i < 9));
  const result = evaluateCandidate(candidate, runs, goldenSet, workload);
  assert.equal(result.verdict, "FAIL");
  assert.match(result.fail_reasons.join(" "), /below the 75% bar/);
});

test("evaluateCandidate passes a candidate that clears the bar", () => {
  const candidate = { name: "Good", slug: "good", route: "A", source: "openrouter" };
  const runs = goldenSet.map((g) => runOf(g.id, true));
  const result = evaluateCandidate(candidate, runs, goldenSet, workload);
  assert.equal(result.verdict, "PASS");
  assert.equal(result.fail_reasons.length, 0);
  assert.equal(result.summary.correct_share, 1);
});

// ---------------------------------------------------------------------------
// a workload with no golden set: the image leg
// ---------------------------------------------------------------------------

const imageWorkload = JSON.parse(
  fs.readFileSync(path.join(here, "..", "samples", "workload.image.json"), "utf8")
);

/** An image run: a real picture and a real cost, and no score anywhere, because nothing scores it. */
const imageRun = (over = {}) => ({
  id: "image",
  answer: null,
  latency_ms: 4000,
  cost: 0.0387042,
  error: null,
  ...over,
});

test("an image candidate is not failed for having no golden set to score against", () => {
  // Every run lands in `scored === 0` on this workload, which on a scored workload means "produced
  // nothing at all". Reporting that over a folder of generated images would be the tool inventing a
  // failure out of its own missing golden set.
  const candidate = {
    name: "Gemini",
    slug: "google/gemini-2.5-flash-image",
    route: "A",
    source: "openrouter",
  };
  const result = evaluateCandidate(candidate, [imageRun(), imageRun()], [], imageWorkload);
  assert.equal(result.verdict, "PASS");
  assert.ok(!result.fail_reasons.some((r) => /no answers were produced/.test(r)));
  assert.equal(result.quality_scored, false);
});

test("the image gate is the latency ceiling, and it fails the slow model", () => {
  const candidate = { name: "Mini", slug: "openai/gpt-5-image-mini", route: "A", source: "openrouter" };
  const result = evaluateCandidate(candidate, [imageRun({ latency_ms: 40800 })], [], imageWorkload);
  assert.equal(result.verdict, "FAIL");
  assert.match(result.fail_reasons.join(" "), /40800ms.*15000ms/);
});

test("an ungated workload names the check that did not run instead of looking like a clean pass", () => {
  const candidate = { name: "Gemini", slug: "g", route: "A", source: "openrouter" };
  const result = evaluateCandidate(candidate, [imageRun()], [], imageWorkload);
  assert.equal(result.not_applied.length, 1);
  assert.match(result.not_applied[0], /not machine-scored/);
});

test("a scored workload still fails a candidate that produced nothing", () => {
  // The guard on the change above: `scored === 0` has to keep meaning what it meant on the text leg.
  const candidate = { name: "Broken", slug: "b", route: "A", source: "openrouter" };
  const runs = goldenSet.map((g) => ({
    id: g.id,
    answer: null,
    error: "HTTP 500",
    latency_ms: null,
    cost: null,
  }));
  const result = evaluateCandidate(candidate, runs, goldenSet, workload);
  assert.equal(result.verdict, "FAIL");
  assert.match(result.fail_reasons.join(" "), /no answers were produced/);
  assert.equal(result.quality_scored, true);
});

test("an absent quality bar is read as no bar, not as a bar of zero", () => {
  // `min_correct_share ?? 0` used to stand in for a missing bar, which turned "no bar was set" into
  // "the bar is zero" and passed every candidate through a check that never ran.
  const s = { scored: 0, correct: 0, correct_share: 0, hallucination_count: 0, error_count: 0,
              latency_ms: { p50: 2000 } };
  const ungated = gate(s, {}, 15000, { qualityScored: false });
  assert.equal(ungated.verdict, "PASS");
  assert.equal(ungated.not_applied.length, 1);
  // And the same summary under a scored workload is still a failure, so the flag is what decides.
  assert.equal(gate(s, {}, 15000).verdict, "FAIL");
});

test("an ungated workload still fails on a transport error", () => {
  // Skipping the quality check must not skip everything: a call that failed is still a failure.
  const s = { scored: 0, correct: 0, correct_share: 0, hallucination_count: 0, error_count: 2,
              total: 2, latency_ms: { p50: 2000 } };
  const { verdict, reasons } = gate(s, {}, 15000, { qualityScored: false });
  assert.equal(verdict, "FAIL");
  assert.match(reasons.join(" "), /2 of 2 calls failed/);
});

test("the image workload declares the settings its gate actually needs", () => {
  assert.equal(imageWorkload.workload_kind, "image");
  assert.equal(imageWorkload.golden_set, undefined);
  assert.equal(imageWorkload.quality_bar.min_correct_share, null);
  assert.equal(imageWorkload.quality_bar.max_hallucinations, null);
  assert.ok(imageWorkload.latency_ceiling_ms > 0);
  assert.ok(imageWorkload.prompt.length > 0);
  assert.ok(imageWorkload.monthly_requests > 0);
  assert.ok(imageWorkload.buyer_estimate.assumed_cost_per_month_usd > 0);
});

// ---------------------------------------------------------------------------
// The golden set must be self-consistent
// ---------------------------------------------------------------------------

test("the workload declares sane gate settings", () => {
  assert.ok(workload.quality_bar.min_correct_share > 0);
  assert.ok(workload.latency_ceiling_ms > 0);
  assert.ok(goldenSet.length >= 10, "scope calls for 10-15 golden items");
  assert.ok(goldenSet.length <= 15);
  assert.ok(
    goldenSet.filter((g) => g.kind === "absent").length >= 1,
    "at least one item must have no answer in the document"
  );
  assert.ok(
    goldenSet.filter((g) => g.kind === "multi_hop").length >= 2,
    "scope calls for deliberate hard cases"
  );
});

test("every golden item has a unique id", () => {
  const ids = goldenSet.map((g) => g.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("every regex in the golden set compiles", () => {
  for (const g of goldenSet) {
    for (const [field, list] of [["accept", g.accept], ["reject", g.reject]]) {
      for (const pattern of list ?? []) {
        assert.doesNotThrow(
          () => new RegExp(pattern, "i"),
          `item "${g.id}" has an invalid ${field} pattern: ${pattern}`
        );
      }
    }
  }
});

test("every item's stated expected answer passes its own accept patterns", () => {
  // This is the test that protects the benchmark from its own typos. If an item's canonical
  // answer cannot pass its own patterns, that item can never be scored correct, and every
  // candidate would be marked wrong on it.
  for (const g of goldenSet) {
    const s = scoreItem(g, g.expected);
    assert.equal(
      s.correct,
      true,
      `item "${g.id}" states expected "${g.expected}" but its own accept patterns did not match it`
    );
  }
});

test("every item's accept patterns describe something the contract actually says", () => {
  // Guards against an accept pattern that would match anything, which would make the item
  // free to pass.
  for (const g of goldenSet) {
    assert.ok((g.accept ?? []).length > 0, `item "${g.id}" has no accept patterns`);
    const s = scoreItem(g, "I do not know.");
    assert.equal(s.correct, false, `item "${g.id}" accepts a non-answer`);
  }
});

// ---------------------------------------------------------------------------
// what a measured cost is a cost OF
// ---------------------------------------------------------------------------

test("the measured cost is a run total, so the per-call figure is not the stored one", () => {
  // The real GPT-4o mini run, to the cent: 14 calls, $0.00335895 in total. Read as a per-call price
  // it puts the model at $67.18 a month at 20,000 calls while the ledger beside it says $4.80, and
  // both numbers look like prices, so nothing on the page reads as wrong.
  const real = { total: 14, measured_cost_usd: 0.00335895, cost_coverage: "14/14" };
  const perCall = measuredCostPerCall(real);

  assert.ok(Math.abs(perCall * 20000 - 4.7985) < 0.01, `monthly came out at ${perCall * 20000}`);
  // The other direction, stated so the test fails loudly if someone "simplifies" the helper back
  // to returning the stored field.
  assert.equal(perCall, real.measured_cost_usd / 14);
  assert.notEqual(perCall, real.measured_cost_usd);
});

test("a partial cost sum is divided by the runs that carried a cost, not by every item", () => {
  // 10 of 14 runs reported a cost. Dividing by 14 would understate the per-call price by 29% and
  // the page would print it as though every run had been counted.
  const summary = {
    total: 14,
    measured_cost_usd: 0.01,
    cost_coverage: "10/14",
  };
  assert.equal(measuredCostPerCall(summary), 0.001);
});

test("no cost at all is null rather than zero, which would read as free", () => {
  assert.equal(measuredCostPerCall({ total: 14, measured_cost_usd: null, cost_coverage: "0/14" }), null);
  assert.equal(measuredCostPerCall({ measured_cost_usd: 0.01, cost_coverage: "0/14" }), null);
  assert.equal(measuredCostPerCall(null), null);
  assert.equal(measuredCostPerCall({}), null);
});
