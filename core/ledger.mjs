/**
 * The estimate-versus-measured ledger. Scope calls this the headline, not an appendix, and it is
 * the reason the whole build exists.
 *
 * The job is to turn "your estimate was wrong" into "your estimate was wrong, by this much, for
 * these five named reasons, and here is what each one is worth in dollars."
 *
 * ## Two gaps, not one
 *
 * The first version of this was going to report a single ratio: the buyer said $18, the measurement
 * says $4.80, so the estimate was 3.75x too high. That number is true and it is nearly useless,
 * because it hides the most interesting fact in the dataset.
 *
 * The buyer's own stated assumptions do not produce $18. Feeding a 1,500-token prompt and a
 * 50-token answer on their own current model, at their own volume, costs **$5.10 a month**. They
 * wrote down $18.00.
 *
 * So there are two separate failures stacked on top of each other:
 *
 *   1. The buyer cannot reproduce their own arithmetic. $18.00 against $5.10 is a 3.5x error, and
 *      no amount of measurement would have caught it, because it is not a measurement problem.
 *   2. The buyer's assumptions about how a model bills are wrong. $5.10 against $4.80 is a 6%
 *      correction from cache behaviour and token accounting.
 *
 * Reporting only the combined 3.75x would have blamed the wrong thing, and it would have made the
 * tool look like it had found a bigger problem than it had.
 *
 * ## How a gap gets attributed
 *
 * A bridge: start at the buyer's configuration, change one thing at a time in a fixed order, and
 * recompute the whole bill after each change. Each step's dollar value is the difference it made
 * given everything already changed before it.
 *
 * The order is a choice, and it is stated in the output rather than buried, because a different
 * order gives different per-step figures even though the total is the same. This one runs from the
 * most fundamental quantity to the most specific: how much text you send, then how much comes back,
 * then how much of the answer is a picture, then how it is cached, then what is billed invisibly.
 * Mechanics that never applied on this route - tiered rates, cache savings, per-call charges, the
 * provider choice - are not steps at all; they are collected in `unexercised` and reported with the
 * reason, because a step that could not move would only pad the walk.
 *
 * Where a mechanic is available but unused on this route, the step is reported at $0.00 with the
 * reason, rather than being dropped. A missing row reads as a mechanic that does not exist.
 */

import { costPerCall } from "./cost.mjs";

// ---------------------------------------------------------------------------
// the bridge dimensions, in the order they are applied
// ---------------------------------------------------------------------------

/**
 * The order is deliberate and it is printed. See the module comment.
 *
 * Each entry reads its value from a configuration object, so a step is just "this field moves from
 * the buyer's value to the measured one".
 *
 * Each dimension may carry a `note(from, to, model)` that returns a sentence or null. It answers
 * "is there something to say about this row", which is NOT the same question as "did the input
 * change". An earlier version split this into `annotate` (fired on a change) and `unchangedNote`
 * (fired without one), and the split produced a silent, actively misleading row: the cache step on
 * a route that publishes no cache price moved 0 → 2,944, so it counted as "changed", so the change
 * branch ran, the cache dimension had no annotation, and the reader got `$0.00  0 → 2,944` with no
 * explanation at all. That is the single row where silence reads as a tool failure, because the
 * saving is real on other routes and simply cannot be claimed on this one.
 */
const DIMENSIONS = [
  {
    key: "input_tokens_per_call",
    label: "Prompt size",
    question: "How much text you send with every request",
    // Tier crossing is a consequence of this dimension rather than an independent lever: the rate
    // changes because the prompt got bigger. It is reported as a note here, not as a step, so the
    // bridge stays a decomposition of causes rather than of consequences.
    note: (before, after, model) => {
      const tiers = model.pricing?.tiers ?? [];
      const crossed = tiers.filter((t) => before < t.min_prompt_tokens && after >= t.min_prompt_tokens);
      if (!crossed.length) return null;
      return `This also crossed a pricing tier at ${crossed[0].min_prompt_tokens} tokens, so the per-token rate itself went up.`;
    },
  },
  {
    key: "output_tokens_per_call",
    label: "Answer length",
    question: "How much text comes back",
    // Nothing to explain. The rate is flat and the arithmetic is visible in the two numbers.
  },
  {
    key: "cached_input_tokens_per_call",
    label: "Prompt caching",
    question: "Whether the repeated part of the prompt is served from cache",
    // A zero here means something different on every route, and the difference is the point.
    note: (from, to, model) => {
      const noRate =
        model.pricing?.cache_read_per_m === null || model.pricing?.cache_read_per_m === undefined;

      if (to === 0) {
        return noRate
          ? "This route publishes no cache-read rate, so there is no discount to take. The measurement found no cache hits either, so the two agree for different reasons."
          : "The measurement found no cache hits, so a discount this route does publish was never taken.";
      }
      // The measured workload DID read from cache. What that is worth depends entirely on whether
      // the route sells the discount, and the two cases look identical in the dollar column.
      if (noRate) {
        return "The measurement found these tokens were served from cache, but this route publishes no cache-read rate, so they were charged at the full input rate and the row is worth $0.00. The saving is real on a route that sells it and cannot be claimed here.";
      }
      if (from === to) {
        return "The buyer already assumed the cache behaviour the measurement found, so there is nothing to attribute.";
      }
      return null;
    },
  },
  {
    key: "reasoning_tokens_per_call",
    label: "Reasoning tokens",
    question: "Work the model bills for but never shows you",
    // Only worth explaining when reasoning actually occurred. A model that is not a reasoning model
    // produces none, and a paragraph about reasoning rates next to a $0.00 would bury the real
    // finding under an explanation of a mechanic that never ran.
    note: (from, to) => {
      if (to === 0) {
        return "This model was billed for no reasoning tokens on this workload, so the mechanic did not apply. On a reasoning model it would, and it is billed without ever appearing in the answer.";
      }
      if (from === to) return "The buyer already assumed the reasoning volume the measurement found.";
      return "These tokens are billed but never appear in the answer, so nothing in the model's output would have shown the buyer this cost.";
    },
  },
];

/**
 * The image half of the bill, which is its own step rather than being folded into "Answer length".
 *
 * On an image workload the image tokens ARE the bill: 1,290 of them at $30/M is $0.0387, against
 * $0.0062 of prompt. Filing that under "Answer length" would put the largest single cause behind a
 * label that names a different mechanic, on the one tab whose whole argument is which mechanic
 * actually cost the money.
 */
const IMAGE_DIMENSION = {
  key: "image_tokens_per_call",
  label: "Image output tokens",
  question: "The image itself, which is billed by the token and not by the picture",
  note: (from, to, model) => {
    if (to === 0) {
      return "No image output tokens were billed on this run, so the mechanic did not apply.";
    }
    const imageRate = model.pricing?.image_output_per_m;
    const textRate = model.pricing?.output_per_m;
    if (imageRate != null && textRate != null && imageRate !== textRate) {
      return `This model bills image output at ${imageRate}/M against ${textRate}/M for text output, so the same token count costs ${(imageRate / textRate).toFixed(1)}x more when the output is a picture. The pricing page lists both rates one line apart and gives no hint which one an image lands on.`;
    }
    if (from === to) {
      return "The buyer already assumed the image volume the measurement found.";
    }
    return "An image model bills its image as completion tokens, so this quantity is visible in the response and absent from every estimate the buyer could have written from the pricing page.";
  },
};

/**
 * The steps to walk, for this model and this pair of configurations.
 *
 * The image step is inserted only when the model actually has an image mechanic, either a published
 * image rate or a measured image token count. A text ledger therefore keeps exactly the rows and row
 * order it had before this existed, which matters because the shipped text ledger is asserted in
 * tests and is the one the reader has already been shown.
 */
function bridgeDimensions(model, measuredConfig) {
  const hasImageMechanic =
    model.pricing?.image_output_per_m != null || (measuredConfig.image_tokens_per_call ?? 0) > 0;
  if (!hasImageMechanic) return DIMENSIONS;
  const after = DIMENSIONS.findIndex((d) => d.key === "output_tokens_per_call") + 1;
  return [...DIMENSIONS.slice(0, after), IMAGE_DIMENSION, ...DIMENSIONS.slice(after)];
}

// ---------------------------------------------------------------------------
// configuration helpers
// ---------------------------------------------------------------------------

/** The buyer's own stated assumptions, as a configuration the cost engine can price. */
export function configFromBuyerEstimate(buyerEstimate = {}, volume = null) {
  return {
    input_tokens_per_call: buyerEstimate.assumed_input_tokens_per_request ?? 0,
    output_tokens_per_call: buyerEstimate.assumed_output_tokens_per_request ?? 0,
    cached_input_tokens_per_call: 0,
    reasoning_tokens_per_call: 0,
    // The buyer has no field for image tokens, and that absence IS the finding on an image
    // workload: there is nowhere on the pricing page they could have read the count from. Zero
    // here is not the engine assuming images are free, it is the buyer failing to model them.
    image_tokens_per_call: 0,
    per_call_counts: { image: 0, web_search: 0, request: 0 },
    calls_per_month: volume,
  };
}

/** What was actually measured. */
export function configFromMeasured(profile = {}, volume = null) {
  return {
    input_tokens_per_call: profile.input_tokens_per_call ?? 0,
    output_tokens_per_call: profile.output_tokens_per_call ?? 0,
    cached_input_tokens_per_call: profile.cached_input_tokens_per_call ?? 0,
    reasoning_tokens_per_call: profile.reasoning_tokens_per_call ?? 0,
    // Was missing until 2026-09-17, and its absence was a live bug rather than a tidy-up: on an
    // image model the measured output tokens ARE the image tokens, so dropping this field left
    // 1,290 image tokens looking like 1,290 tokens of text and priced them at the completion rate.
    // That undercounts by 12x on this pair - the exact error core/cost.mjs was corrected for in the
    // same change. A ledger that reintroduces it would disagree with the candidates table one
    // section above it, on the same page, using the same measurement.
    image_tokens_per_call: profile.image_tokens_per_call ?? 0,
    per_call_counts: profile.per_call_counts ?? { image: 0, web_search: 0, request: 0 },
    calls_per_month: volume ?? profile.calls_per_month,
  };
}

/** Price one configuration at the buyer's volume. */
function monthlyFor(model, config, volume) {
  const result = costPerCall(model, { ...config, calls_per_month: volume });
  return {
    monthly: result.complete ? result.total * volume : null,
    complete: result.complete,
    assumptions: result.assumptions,
  };
}

const fmt = (n) =>
  n === null || n === undefined
    ? "n/a"
    : `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

// ---------------------------------------------------------------------------
// the ledger
// ---------------------------------------------------------------------------

/**
 * Build the estimate-versus-measured bridge.
 *
 * @param {object} model           the candidate being priced, from the catalogue
 * @param {object} buyerEstimate   the workload's buyer_estimate block
 * @param {object} measured        a measured token profile (see cost.mjs profileFromRuns)
 * @param {number} volume          calls per month
 * @param {object} options         { exercised: {tier, provider}, providerNote }
 */
export function buildLedger(model, buyerEstimate, measured, volume, options = {}) {
  if (!model) throw new Error("buildLedger needs a catalogue model");
  if (!measured) {
    // No measurement means no bridge. Refusing is the only honest output: a ledger built from the
    // buyer's guesses against other guesses is exactly the artifact this project argues against.
    return {
      available: false,
      reason:
        "no measured token profile for this candidate, so there is nothing to compare the estimate against",
      stated_estimate_usd: buyerEstimate?.assumed_cost_per_month_usd ?? null,
    };
  }

  const volumeUsed = volume ?? measured.calls_per_month ?? null;
  if (!volumeUsed) {
    return { available: false, reason: "no monthly volume, so no monthly cost to compare" };
  }

  const buyerConfig = configFromBuyerEstimate(buyerEstimate, volumeUsed);
  const measuredConfig = configFromMeasured(measured, volumeUsed);

  const stated = buyerEstimate?.assumed_cost_per_month_usd ?? null;
  const ownAssumptions = monthlyFor(model, buyerConfig, volumeUsed).monthly;
  const measuredCost = monthlyFor(model, measuredConfig, volumeUsed).monthly;

  // --- the two gaps ---
  const arithmeticGap = stated !== null && ownAssumptions !== null ? stated - ownAssumptions : null;
  const modellingGap =
    ownAssumptions !== null && measuredCost !== null ? ownAssumptions - measuredCost : null;

  // --- the bridge ---
  const steps = [];
  let running = { ...buyerConfig };
  let previousCost = ownAssumptions;

  for (const dim of bridgeDimensions(model, measuredConfig)) {
    const before = running[dim.key];
    const after = measuredConfig[dim.key];
    const from = before;
    const to = after;

    running = { ...running, [dim.key]: after };
    const { monthly, complete } = monthlyFor(model, running, volumeUsed);

    const delta = previousCost !== null && monthly !== null ? previousCost - monthly : null;
    const changed = from !== to;

    steps.push({
      key: dim.key,
      label: dim.label,
      question: dim.question,
      from,
      to,
      changed,
      before_usd: previousCost,
      after_usd: monthly,
      // Positive means this mechanic made the bill CHEAPER than the step before it.
      saving_usd: delta,
      complete,
      // The dimension decides whether there is anything to say. The renderer already prints
      // "assumed X, measured Y" for a step that did not move, so a generic fallback sentence here
      // would only restate the row above it.
      note: dim.note?.(from, to, model) ?? null,
    });

    previousCost = monthly;
  }

  // --- mechanics that this route or this workload never exercised ---
  const unexercised = [];
  if (!(model.pricing?.tiers ?? []).length) {
    unexercised.push({
      mechanic: "tiered rates",
      why: "this model publishes no tier thresholds, so the prompt size cannot change its rate",
    });
  } else if (!steps.find((s) => s.key === "input_tokens_per_call")?.note) {
    unexercised.push({
      mechanic: "tiered rates",
      why: `this model has tiers but a ${Math.round(measuredConfig.input_tokens_per_call)}-token prompt crosses none of them`,
    });
  }
  const cacheStep = steps.find((s) => s.key === "cached_input_tokens_per_call");
  if (cacheStep?.saving_usd === 0) {
    // Borrow the step's own note rather than re-wording the same fact, so the summary and the
    // waterfall cannot drift apart. The note already distinguishes "no rate is sold here" from
    // "a rate exists and went unused", which is the distinction that matters.
    unexercised.push({ mechanic: "prompt caching", why: cacheStep.note });
  }
  unexercised.push({
    mechanic: "provider choice",
    why:
      options.providerNote ??
      "route A does not let the buyer pick a provider, so there was no provider decision to price",
  });
  if (!(measuredConfig.per_call_counts?.web_search || measuredConfig.per_call_counts?.image)) {
    unexercised.push({
      mechanic: "per-call charges",
      // Deliberately says "input" on both counts. A GENERATED image is an output, it is billed in
      // tokens, and it lands in the image-token step above rather than here - which is the whole
      // distinction the units note exists to draw. The earlier wording said "sends no images" and
      // on an image workload that sentence is true and reads as the opposite.
      why: "this workload makes no web searches and sends no image as input, so no charge outside token arithmetic applied",
    });
  }

  // --- does the bridge actually add up ---
  // If it does not, the decomposition is wrong and every per-step figure is suspect. Better to say
  // so than to print a tidy waterfall that quietly does not reconcile.
  const stepSum = steps.reduce((a, s) => a + (s.saving_usd ?? 0), 0);
  const reconciles =
    modellingGap === null ? false : Math.abs(stepSum - modellingGap) < Math.max(0.01, Math.abs(modellingGap) * 0.001);

  return {
    available: true,
    model: model.slug,
    model_name: model.name,
    source: model.source,
    volume: volumeUsed,

    // The two gaps, kept apart on purpose. See the module comment.
    stated_estimate_usd: stated,
    own_assumptions_usd: ownAssumptions,
    measured_usd: measuredCost,
    arithmetic_gap_usd: arithmeticGap,
    modelling_gap_usd: modellingGap,
    total_gap_usd: stated !== null && measuredCost !== null ? stated - measuredCost : null,
    arithmetic_ratio: stated !== null && ownAssumptions ? stated / ownAssumptions : null,
    modelling_ratio: ownAssumptions && measuredCost ? ownAssumptions / measuredCost : null,
    total_ratio: stated !== null && measuredCost ? stated / measuredCost : null,

    steps,
    order_note:
      "Steps run from the most fundamental quantity to the most specific. Each dollar figure is what " +
      "that mechanic was worth, given everything changed before it. A different order would give " +
      "different per-step figures and the same total.",
    unexercised,
    reconciles,
    step_sum_usd: stepSum,

    buyer_config: buyerConfig,
    measured_config: measuredConfig,
  };
}

// ---------------------------------------------------------------------------
// presentation
// ---------------------------------------------------------------------------

/** The headline sentence, written once so every surface says the same thing. */
export function ledgerHeadline(ledger) {
  if (!ledger.available) return ledger.reason;
  const { stated_estimate_usd: stated, own_assumptions_usd: own, measured_usd: got } = ledger;

  if (stated !== null && own !== null && Math.abs(stated - own) > Math.max(0.01, own * 0.02)) {
    return (
      `The estimate of ${fmt(stated)}/month is wrong twice over. ${fmt(stated)} does not follow from ` +
      `the buyer's own stated assumptions, which cost ${fmt(own)} on their own model at their own ` +
      `volume. The measurement then says ${fmt(got)}. Two different errors, and only the second one ` +
      `is a measurement problem.`
    );
  }
  return `The estimate of ${fmt(stated)}/month is close to the buyer's own arithmetic. The measurement says ${fmt(got)}.`;
}

/** Signed dollar figure with an explicit sign, so a direction is never inferred from a dash. */
function signed(n) {
  if (n === null || n === undefined) return "n/a";
  if (Math.abs(n) < 0.005) return "$0.00";
  return `${n > 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;
}

/** Round a token count for display. The measured profile holds means, not whole tokens. */
const tok = (n) => (n === null || n === undefined ? "?" : Math.round(n).toLocaleString());

/**
 * A waterfall, as text, for the console and as the basis for the HTML report.
 *
 * SIGN CONVENTION: a positive figure means that step made the bill MORE expensive, a negative one
 * means it made it cheaper. An earlier version printed the saving, so a prompt growing from 1,500
 * to 3,000 tokens showed as a positive number in the same column as the caching discount, and the
 * two read as though they pushed in the same direction. They do not.
 */
export function renderLedger(ledger) {
  if (!ledger.available) return `  (no ledger: ${ledger.reason})`;
  const lines = [];
  const w = 30;

  lines.push(`  ${"Buyer's stated estimate".padEnd(w)} ${fmt(ledger.stated_estimate_usd).padStart(10)}`);

  if (ledger.arithmetic_gap_usd !== null && Math.abs(ledger.arithmetic_gap_usd) > 0.005) {
    lines.push(
      `  ${"  does not follow from their".padEnd(w)} ${signed(-ledger.arithmetic_gap_usd).padStart(10)}   ` +
        `own assumptions, before anything was measured`
    );
  }

  lines.push(`  ${"Buyer's own assumptions cost".padEnd(w)} ${fmt(ledger.own_assumptions_usd).padStart(10)}`);

  for (const s of ledger.steps) {
    const label = `  ${s.label}`;
    // delta_cost: how much this step moved the bill, positive meaning more expensive.
    const deltaCost = s.saving_usd === null ? null : -s.saving_usd;

    if (!s.changed) {
      lines.push(
        `  ${label.padEnd(w)} ${signed(0).padStart(10)}   ` +
          `assumed ${tok(s.from)}, measured ${tok(s.to)}` +
          `${s.note ? ` · ${s.note}` : ""}`
      );
    } else {
      lines.push(
        `  ${label.padEnd(w)} ${signed(deltaCost).padStart(10)}   ` +
          `${tok(s.from)} → ${tok(s.to)}` +
          `${s.note ? `\n  ${" ".repeat(w)} ${" ".repeat(10)}   ↳ ${s.note}` : ""}`
      );
    }
  }

  lines.push(`  ${"Measured".padEnd(w)} ${fmt(ledger.measured_usd).padStart(10)}`);
  lines.push(`  ${"─".repeat(w + 11)}`);
  lines.push(
    `  ${"Gap".padEnd(w)} ${signed(ledger.total_gap_usd).padStart(10)}   ` +
      `${ledger.total_ratio ? `${ledger.total_ratio.toFixed(2)}x` : "n/a"} the measured cost`
  );
  lines.push("");
  lines.push(
    ledger.reconciles
      ? `  The bridge reconciles: the steps account for the whole modelling gap of ${fmt(Math.abs(ledger.modelling_gap_usd))}.`
      : `  WARNING: the steps sum to ${fmt(ledger.step_sum_usd)} but the gap is ${fmt(ledger.modelling_gap_usd)}. The decomposition is wrong and these per-step figures should not be quoted.`
  );
  return lines.join("\n");
}
