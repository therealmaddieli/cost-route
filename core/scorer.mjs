/**
 * Cost-Route step 1: the requirements gate.
 *
 * Pure functions, no I/O, no dependencies. This runs three places and must behave identically
 * in all of them:
 *   1. under `node --test` locally, where it is verified
 *   2. inside an n8n Code node, pasted in as-is (n8n Code nodes are JavaScript)
 *   3. as part of the benchmark CLI
 *
 * Everything here answers one question: did this candidate clear the bar the buyer set?
 * Nothing here knows or cares about price. That is deliberate. Requirements gate price, never
 * the other way round.
 */

// ---------------------------------------------------------------------------
// Text normalisation
// ---------------------------------------------------------------------------

/**
 * Fold an answer down to something comparable.
 *
 * Models are wildly inconsistent about punctuation, markdown and dashes. Normalising here,
 * once, means the pattern lists in the golden set can stay simple.
 */
export function normalise(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[\u2010-\u2015\u2212]/g, "-") // unicode dashes to ascii
    .replace(/[\u00a0\u2007\u202f]/g, " ")  // non-breaking, figure and narrow spaces
    .replace(/[*_`>#]|\*\*|__/g, " ")        // markdown emphasis and quote markers
    // Unwrap a parenthetical numeral: "twenty-four (24) months" -> "twenty-four 24 months".
    // Contracts are drafted this way and models copy the style straight back, which puts a ")"
    // between the number and its unit and defeats every number-then-unit pattern. Found by the
    // smoke run, where three models answered correctly and all three scored needs_review.
    .replace(/\(\s*(\d[\d,.]*\s*%?)\s*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Return the first pattern that matches, or null.
 *
 * A malformed pattern in a user-supplied golden set must not kill the whole run, so a bad
 * regex is skipped rather than thrown. The open-source goal means other people will edit
 * these files, and one typo should not cost them their results.
 */
export function matchAny(haystack, patterns) {
  for (const pattern of patterns ?? []) {
    let re;
    try {
      re = new RegExp(pattern, "i");
    } catch {
      continue; // invalid regex: skip, do not crash
    }
    if (re.test(haystack)) return pattern;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scoring one answer
// ---------------------------------------------------------------------------

/**
 * Score a single answer against a single golden-set item.
 *
 * Returns one of four outcomes per item:
 *   correct          an accept pattern matched
 *   incorrect        a reject pattern matched, or nothing matched
 *   hallucination    a reject pattern matched, or an "absent" item was answered with a specific
 *   needs_review     nothing matched on a normal item, so we cannot tell whether the model was
 *                    wrong or the pattern list was too narrow
 *
 * `needs_review` exists because silently scoring an unmatched answer as wrong would make the
 * tool unfair to good models and quietly wrong in the direction that flatters the demo. It is
 * surfaced in the report instead of hidden.
 */
export function scoreItem(item, answer) {
  const text = normalise(answer);
  const kind = item.kind ?? "fact";

  // ABSENT items are scored the other way round from the rest.
  //
  // A fact item has a right answer, so a wrong specific is decisive and reject is checked first:
  // a wrong number must not hide behind correct-sounding words.
  //
  // An absent item has NO answer in the document. The only thing worth measuring is whether the
  // model says so. So accept is checked first, and a correct "not specified" is not overturned by
  // the model mentioning a real figure from elsewhere in the document. When it does both, that is
  // recorded as `hedged` rather than quietly resolved either way.
  if (kind === "absent") {
    const accepted = matchAny(text, item.accept);
    const rejected = matchAny(text, item.reject);

    if (accepted) {
      return {
        id: item.id, kind, correct: true, hallucination: false, needs_review: false,
        hedged: Boolean(rejected), matched: accepted, via: "accept",
        reason: rejected ? "admitted absence but also named a figure from elsewhere" : undefined,
      };
    }

    // We only call it a hallucination when we can point at the specific thing invented. An
    // answer that matches neither list is scored incorrect either way, but labelling it a
    // hallucination would be an accusation the evidence does not support - and a live run showed
    // exactly that risk: "No notice period is specified in the Agreement" is a correct answer
    // that an earlier, enumerative accept list missed, and it was reported as a fabrication.
    if (rejected) {
      return {
        id: item.id, kind, correct: false, hallucination: true, needs_review: false, hedged: false,
        matched: rejected, via: "reject",
        reason: "invented a specific figure for a question the document does not answer",
      };
    }

    return {
      id: item.id, kind, correct: false, hallucination: false, needs_review: true, hedged: false,
      matched: null, via: "unmatched",
      reason: "did not clearly admit absence, but named no figure we can point at",
    };
  }

  const rejected = matchAny(text, item.reject);
  if (rejected) {
    return {
      id: item.id, kind, correct: false, hallucination: true, needs_review: false, hedged: false,
      matched: rejected, via: "reject",
      reason: "asserted a specific that the document does not support",
    };
  }

  const accepted = matchAny(text, item.accept);
  if (accepted) {
    return {
      id: item.id, kind, correct: true, hallucination: false, needs_review: false, hedged: false,
      matched: accepted, via: "accept",
    };
  }

  // Nothing matched, on an item that does have an answer. We cannot tell whether the model was
  // wrong or this pattern list was too narrow, so we say exactly that instead of asserting.
  return {
    id: item.id, kind, correct: false, hallucination: false, needs_review: true, hedged: false,
    matched: null, via: "unmatched",
    reason: "no accept or reject pattern matched; scored as incorrect pending review",
  };
}

// ---------------------------------------------------------------------------
// Latency
// ---------------------------------------------------------------------------

/** Linear-interpolated percentile. p is 0..1. Returns null for an empty set. */
export function percentile(values, p) {
  const v = values
    .filter((n) => typeof n === "number" && Number.isFinite(n))
    .sort((a, b) => a - b);
  if (v.length === 0) return null;
  if (v.length === 1) return v[0];
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return v[lo];
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}

// ---------------------------------------------------------------------------
// Summarising a candidate's whole run
// ---------------------------------------------------------------------------

/**
 * Turn a candidate's per-item runs into the numbers the gate needs.
 *
 * @param {Array} runs - [{ id, kind, latency_ms, cost, usage, error, answer }]
 * @param {object} kindById - optional { item id: kind } map, for runs that failed before they were
 *   scored and therefore carry no kind of their own
 */
export function summarise(runs, kindById = {}) {
  const total = runs.length;
  const scored = runs.map((r) => r.score).filter(Boolean);
  const correct = scored.filter((s) => s.correct).length;
  const hallucinations = scored.filter((s) => s.hallucination);
  const needsReview = scored.filter((s) => s.needs_review);
  const hedged = scored.filter((s) => s.hedged);
  const errors = runs.filter((r) => r.error);

  const latencies = runs.filter((r) => !r.error).map((r) => r.latency_ms);
  const costs = runs.map((r) => r.cost).filter((c) => typeof c === "number");

  return {
    total,
    // `scored` counts only the runs we actually got an answer for. A call that failed in
    // transport was never answered, so scoring it as wrong would fold "the route broke" into
    // "the model was wrong" and quietly depress the quality share. Failures are reported on
    // their own line, and the gate fails the candidate for them separately.
    scored: scored.length,
    answered: scored.length,
    failed: errors.length,
    correct,
    incorrect: scored.length - correct,
    correct_share: scored.length ? correct / scored.length : 0,
    hallucination_count: hallucinations.length,
    hallucinations,
    needs_review: needsReview,
    // Counted separately from hallucinations: the model said the document is silent AND named a
    // figure. Scoring that either way would be a judgement call, so it is surfaced instead.
    hedged_count: hedged.length,
    hedged,
    error_count: errors.length,
    errors,
    latency_ms: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      min: latencies.length ? Math.min(...latencies) : null,
      max: latencies.length ? Math.max(...latencies) : null,
    },
    measured_cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    // Only count cost over the runs that actually reported one; a partial sum presented as a
    // total would be a quiet lie.
    cost_coverage: `${costs.length}/${total}`,
    by_kind: byKind(runs, kindById),
    // The status code, because it decides what the buyer does about the failure. A 429 is a rate
    // limit you can sometimes buy your way out of; a 402 on the same provider means come back in a
    // minute, which is the whole reason this project refuses to collapse provider errors into one
    // generic "failed".
    error_kinds: errorKinds(errors),
  };
}

/** Question kinds, in the order a reader should meet them. Unknown kinds follow, alphabetically. */
const KIND_ORDER = ["fact", "multi_hop", "absent"];

/**
 * Per question kind, from the kind carried on each score.
 *
 * One accuracy figure per model is what every comparison site prints, and it hides the only thing
 * that decides the purchase: which questions the candidates actually separate on. In this benchmark
 * all three models answer every plainly-stated question correctly, so the entire difference between
 * a $4.80 model that fails the gate and a $10.58 one that passes lives in four questions out of
 * fourteen. A reader with an extraction workload and a reader with a multi-hop workload are being
 * asked to make opposite decisions from the same single number.
 *
 * `not_served` is the transport failures, kept apart from `incorrect` for the same reason the
 * top-level summary keeps them apart: a call that never came back is not a wrong answer.
 *
 * A failed call has no score, so its kind has to come from somewhere else or the failure lands in a
 * bucket of its own and the kind it belongs to silently reports a perfect record. Gemma 3 4B failed
 * five calls, all five on stated-fact questions; without the map below its `fact` row read "5 of 5
 * correct" while five of the ten fact questions had never been answered. That is the exact shape of
 * a quiet lie: a full-marks cell standing in for work that was never done.
 *
 * @param {Array} runs
 * @param {object} kindById - { item id: kind }, for runs that carry no kind of their own
 */
export function byKind(runs, kindById = {}) {
  const kinds = new Map();
  for (const run of runs) {
    const kind = run.score?.kind ?? run.kind ?? kindById?.[run.id] ?? "unscored";
    const b = kinds.get(kind) ?? { kind, asked: 0, scored: 0, correct: 0, incorrect: 0, not_served: 0, fabricated: 0 };
    b.asked += 1;
    if (!run.score) {
      b.not_served += 1;
    } else {
      b.scored += 1;
      if (run.score.correct) b.correct += 1;
      else b.incorrect += 1;
      if (run.score.hallucination) b.fabricated += 1;
    }
    kinds.set(kind, b);
  }

  return [...kinds.values()].sort((a, b) => {
    const ia = KIND_ORDER.indexOf(a.kind);
    const ib = KIND_ORDER.indexOf(b.kind);
    if (ia !== -1 || ib !== -1) return (ia === -1 ? KIND_ORDER.length : ia) - (ib === -1 ? KIND_ORDER.length : ib);
    return a.kind.localeCompare(b.kind);
  });
}

/** How many of each HTTP status, from the raw error strings. */
export function errorKinds(errors) {
  const counts = {};
  for (const e of errors) {
    const code = String(e?.error ?? "").match(/\b([45]\d\d)\b/)?.[1] ?? "unknown";
    counts[code] = (counts[code] ?? 0) + 1;
  }
  return counts;
}

/**
 * The per-call cost, derived from the run total.
 *
 * measured_cost_usd is a SUM over the runs that reported a cost, and nothing in the field name says
 * so. Read as a per-call figure it produces a monthly bill multiplied by the number of benchmark
 * runs, which on a 14-item set is wrong by 14x and still looks like a plausible price for a model.
 * It was read that way once, and the procurement-routes table printed $67.18 a month for a model
 * the ledger beside it costed at $4.80.
 *
 * The denominator is the numerator of cost_coverage, not the item count, because a run that
 * reported no cost contributed nothing to the sum and must not contribute to the divisor either.
 */
export function measuredCostPerCall(summary) {
  if (!summary || summary.measured_cost_usd == null) return null;
  const costed = Number(String(summary.cost_coverage ?? "").split("/")[0]);
  if (!Number.isFinite(costed) || costed <= 0) return null;
  return summary.measured_cost_usd / costed;
}

/**
 * Apply the buyer's bar. Returns PASS or FAIL with every reason named.
 *
 * A candidate that fails is FAIL. It is never ranked as a winner afterwards, however cheap it
 * was, because a cheap wrong answer is not a cheap answer.
 *
 * @param {object} summary
 * @param {object} qualityBar
 * @param {number} latencyCeilingMs
 * @param {object} options - `{ qualityScored }`, whether this workload has a machine quality bar
 *   at all. Passed in rather than inferred from an empty bar object, because an empty bar is
 *   already how a caller says "that check is not what this test is about", and reading it as "no
 *   bar exists" would change the answer for those callers without a word.
 */
export function gate(
  summary,
  qualityBar = {},
  latencyCeilingMs = null,
  { qualityScored = true } = {}
) {
  const reasons = [];
  const notApplied = [];

  if (qualityScored) {
    if (summary.scored === 0) {
      return {
        verdict: "FAIL",
        reasons: ["no answers were produced at all"],
        not_applied: notApplied,
      };
    }

    const minShare = qualityBar.min_correct_share ?? 0;
    if (summary.correct_share < minShare) {
      reasons.push(
        `quality ${pct(summary.correct_share)} is below the ${pct(minShare)} bar ` +
          `(${summary.correct ?? "?"}/${summary.scored} correct)`
      );
    }

    const maxHallucinations = qualityBar.max_hallucinations ?? 0;
    if (summary.hallucination_count > maxHallucinations) {
      // Pluralised, because this string is printed verbatim on the failing candidate's own row now
      // rather than buried in a JSON field, and "1 hallucination flag(s)" reads as a template that
      // nobody looked at.
      const n = summary.hallucination_count;
      reasons.push(
        `${n} hallucination flag${n === 1 ? "" : "s"}; the bar allows ${maxHallucinations}`
      );
    }
  } else {
    // An image workload: quality is judged by eye, there is no golden set, and so every run lands
    // in `scored === 0`. Returning "no answers were produced at all" over a folder of generated
    // images would be the tool inventing a failure out of its own missing golden set. The latency
    // ceiling is the only machine gate here, and the page says so where the quality columns would
    // have been rather than leaving the reader to notice the absence.
    notApplied.push(
      "quality is not machine-scored on this workload: there is no golden set, so there is no correct-share to hold against a bar and no quality check was applied. The latency ceiling is the only machine gate."
    );
  }

  const p50 = summary.latency_ms?.p50;
  if (latencyCeilingMs != null && p50 != null && p50 > latencyCeilingMs) {
    reasons.push(`p50 latency ${Math.round(p50)}ms is above the ${latencyCeilingMs}ms ceiling`);
  }

  if (summary.error_count > 0) {
    reasons.push(`${summary.error_count} of ${summary.total} calls failed`);
  }

  return { verdict: reasons.length ? "FAIL" : "PASS", reasons, not_applied: notApplied };
}

function pct(x) {
  return `${Math.round(x * 100)}%`;
}

// ---------------------------------------------------------------------------
// The gate, end to end
// ---------------------------------------------------------------------------

/**
 * Score and gate one candidate.
 *
 * @param {object} candidate - a shortlist entry { name, slug, route, ... }
 * @param {Array} runs - per-item runs, already carrying latency, cost, usage and raw answer
 * @param {Array} goldenSet - the items
 * @param {object} workload - for quality_bar and latency_ceiling_ms
 */
export function evaluateCandidate(candidate, runs, goldenSet, workload) {
  const items = Array.isArray(goldenSet) ? goldenSet : [];
  const byId = new Map(items.map((item) => [item.id, item]));

  const scoredRuns = runs.map((run) => {
    const item = byId.get(run.id);
    // The kind travels on the run, not only inside its score. A call that failed in transport has
    // no score, and without this the per-kind table cannot tell which questions it never answered.
    const kind = item?.kind ?? "fact";
    // A run that never produced an answer is not scored at all. There is nothing to score.
    if (!item || run.error || run.answer == null) return { ...run, kind };
    return { ...run, kind, score: scoreItem(item, run.answer) };
  });

  const summary = summarise(scoredRuns);
  // A workload with no golden set has no machine quality bar, and that is a property of the
  // workload rather than of how the run went. An image workload is the case: the runs are
  // successful, they simply have nothing to be scored against.
  const qualityScored = items.length > 0;
  const { verdict, reasons, not_applied } = gate(
    summary,
    workload.quality_bar,
    workload.latency_ceiling_ms,
    { qualityScored }
  );

  return {
    name: candidate.name,
    slug: candidate.slug,
    route: candidate.route,
    source: candidate.source,
    provider: candidate.provider ?? null,
    summary,
    verdict,
    fail_reasons: reasons,
    // Which checks could not run, as distinct from which ones failed. A page that shows only
    // fail_reasons would render an ungated workload as a clean pass through a gate that never ran.
    not_applied,
    quality_scored: qualityScored,
    runs: scoredRuns,
  };
}

/** Convenience: the same gate across a whole shortlist. */
export function evaluateShortlist(candidates, runsBySlug, goldenSet, workload) {
  return candidates.map((c) =>
    evaluateCandidate(c, runsBySlug[c.slug] ?? [], goldenSet, workload)
  );
}
