/**
 * The cost engine. Pure arithmetic, no I/O, no network.
 *
 * This module exists to answer one question: what would this model cost this buyer per month, at
 * the volume they actually run? It is the projection half of the project. The other half is the
 * benchmark, which measures what a call really costs. Day 2 established that the provider's
 * `usage.cost` is authoritative and our arithmetic only explains it, so this engine's output is
 * always a PROJECTION and is labelled as one wherever it appears.
 *
 * The five price mechanics, applied in order, exactly once each:
 *   1. base rate        - input and output tokens at the list price
 *   2. cached input     - the cached portion, at whatever cache rate exists, or not at all
 *   3. tiered rates     - which rate applies depends on the size of the prompt
 *   4. reasoning tokens - billed, invisible in the answer, and priced at a rate that is often
 *                         not published separately
 *   5. per-call charges - image inputs and web searches, which sit outside token maths entirely
 *
 * The engine's most important behaviour is not arithmetic. It is that every time it has to assume
 * something, it writes the assumption down in `assumptions` and carries it into the report. A
 * projection with a hidden assumption in it is indistinguishable from a wrong one, and this
 * project's whole argument is that a wrong cost number presented confidently is worse than no
 * number at all.
 */

// ---------------------------------------------------------------------------
// The token profile
// ---------------------------------------------------------------------------

/**
 * Describe the shape of one call, in tokens.
 *
 * Build this from a real benchmark run wherever one exists, rather than from a guess. Day 2
 * measured, for example, that a reasoning model can spend 73% of its billed output tokens on
 * reasoning the buyer never sees, which no estimate would have predicted.
 *
 * @typedef {Object} TokenProfile
 * @property {number} input_tokens_per_call         total prompt tokens
 * @property {number} [cached_input_tokens_per_call] the subset served from prompt cache
 * @property {number} output_tokens_per_call         visible answer tokens
 * @property {number} [reasoning_tokens_per_call]    billed, invisible
 * @property {number} calls_per_month
 * @property {Object} [per_call_counts]              counts, not prices: {image, web_search, request}
 */

/** Derive a profile from a benchmark run's raw usage records. Measured, not assumed. */
export function profileFromRuns(runs, callsPerMonth) {
  const ok = runs.filter((r) => r && !r.error && r.usage);
  if (ok.length === 0) return null;

  const sum = (fn) => ok.reduce((a, r) => a + (fn(r.usage) ?? 0), 0);
  const per = (fn) => sum(fn) / ok.length;

  const cached = per((u) => u.prompt_tokens_details?.cached_tokens);
  const prompt = per((u) => u.prompt_tokens) || per((u) => u.input_tokens);

  return {
    input_tokens_per_call: prompt,
    cached_input_tokens_per_call: cached,
    // Visible answer tokens. On an image call this STILL INCLUDES the image tokens, because
    // units.md:48 records that an image model bills its image as completion tokens with no
    // separate line in the response. `image_tokens_per_call` below says how many of these are the
    // image, and costPerCall splits them out. Doing the subtraction here instead would move the
    // decision into the profile, which cannot see the model and so cannot know whether a separate
    // image rate exists to charge them at.
    output_tokens_per_call: per((u) => Math.max(0, (u.completion_tokens ?? 0) - (u.completion_tokens_details?.reasoning_tokens ?? 0))),
    reasoning_tokens_per_call: per((u) => u.completion_tokens_details?.reasoning_tokens),
    // Absent on every text call, which is the common case, so this reads 0 there and nothing
    // downstream changes for a text workload.
    image_tokens_per_call: per((u) => u.completion_tokens_details?.image_tokens),
    calls_per_month: callsPerMonth,
    per_call_counts: { image: 0, web_search: 0, request: 0 },
    source: `measured over ${ok.length} call(s)`,
  };
}

// ---------------------------------------------------------------------------
// Tier selection
// ---------------------------------------------------------------------------

/**
 * Which rate applies to a prompt of this size.
 *
 * Tiered pricing only shows up in long-context work, which is exactly the work where nobody
 * re-checks the price. Returns the tier that applies and says whether one did.
 */
export function resolveRate(model, inputTokens) {
  const tiers = (model.pricing?.tiers ?? []).filter(
    (t) => t.min_prompt_tokens !== null && inputTokens >= t.min_prompt_tokens
  );
  // Highest threshold wins when several are crossed.
  const tier = tiers.sort((a, b) => b.min_prompt_tokens - a.min_prompt_tokens)[0] ?? null;

  const rate = {
    input_per_m: tier?.input_per_m ?? model.pricing?.input_per_m ?? null,
    output_per_m: tier?.output_per_m ?? model.pricing?.output_per_m ?? null,
    cache_read_per_m: tier?.cache_read_per_m ?? model.pricing?.cache_read_per_m ?? null,
  };
  return { rate, tier };
}

// ---------------------------------------------------------------------------
// One call
// ---------------------------------------------------------------------------

/**
 * The cost of a single call, with the arithmetic shown.
 *
 * Returns null for any component whose price the catalogue does not publish AND that the profile
 * actually uses. A component priced at zero and a component that cannot be priced are different
 * facts, and this function refuses to merge them.
 */
export function costPerCall(model, profile) {
  const assumptions = [];
  const breakdown = {};
  let total = 0;
  let complete = true;

  const inputTokens = profile.input_tokens_per_call ?? 0;
  const cachedTokens = Math.min(profile.cached_input_tokens_per_call ?? 0, inputTokens);
  const outputTokens = profile.output_tokens_per_call ?? 0;
  const reasoningTokens = profile.reasoning_tokens_per_call ?? 0;
  const counts = profile.per_call_counts ?? {};

  const { rate, tier } = resolveRate(model, inputTokens);

  if (tier) {
    assumptions.push(
      `tiered rate applied: the prompt is ${Math.round(inputTokens)} tokens, at or above the ${tier.min_prompt_tokens}-token threshold, so the higher tier rate is used`
    );
  }

  // --- 1 & 2. input, split into cached and uncached ---
  if (rate.input_per_m !== null) {
    const uncachedTokens = inputTokens - cachedTokens;
    breakdown.uncached_input = (uncachedTokens / 1e6) * rate.input_per_m;
    total += breakdown.uncached_input;

    if (cachedTokens > 0) {
      if (rate.cache_read_per_m !== null) {
        breakdown.cached_input = (cachedTokens / 1e6) * rate.cache_read_per_m;
        total += breakdown.cached_input;
        assumptions.push(
          `cache assumed: ${Math.round(cachedTokens)} of ${Math.round(inputTokens)} prompt tokens are served from cache at ${rate.cache_read_per_m}/M rather than the full input rate`
        );
      } else {
        // The catalogue publishes no cache rate, so we cannot claim the discount. Charging the
        // full rate is the conservative direction and the assumption says so out loud.
        breakdown.cached_input = (cachedTokens / 1e6) * rate.input_per_m;
        total += breakdown.cached_input;
        assumptions.push(
          `cache assumed NOT to apply: ${Math.round(cachedTokens)} prompt tokens could be cached but this model publishes no cache rate, so they are charged at the full input rate`
        );
      }
    }
  } else {
    complete = false;
    breakdown.uncached_input = null;
    assumptions.push("input price is not published in the catalogue; input cost cannot be projected");
  }

  // --- 3. output, and the image tokens that are billed inside it ---
  //
  // units.md:48-51 records, from a paid call, that an image model bills its image AS completion
  // tokens: there is no separate image line in the response. So on an image call
  // `completion_tokens - reasoning_tokens` IS the image token count, and pricing it at the text
  // output rate undercounts the bill by the entire image spend. Measured at 12x on
  // google/gemini-2.5-flash-image, where 1,290 image tokens came to $0.0032 at the output rate and
  // $0.0387 at the image rate - and usage.cost charged $0.0387042.
  const imageTokens = profile.image_tokens_per_call ?? 0;
  const imageRate = model.pricing?.image_output_per_m ?? null;
  // Split only when the catalogue publishes an image rate, so a model with no image price keeps
  // its tokens in the output bucket, where they are at least charged something rather than
  // vanishing. The subtraction is floored at zero, which makes it correct whether or not
  // completion_tokens happens to include the image.
  const textOutputTokens = imageRate === null ? outputTokens : Math.max(0, outputTokens - imageTokens);

  if (rate.output_per_m !== null) {
    breakdown.output = (textOutputTokens / 1e6) * rate.output_per_m;
    total += breakdown.output;
  } else {
    complete = false;
    breakdown.output = null;
  }

  if (imageTokens > 0) {
    if (imageRate !== null) {
      breakdown.image_output = (imageTokens / 1e6) * imageRate;
      total += breakdown.image_output;
      assumptions.push(
        `${Math.round(imageTokens)} image output tokens per call are charged at the image rate of ${imageRate}/M, not the text output rate of ${rate.output_per_m}/M, because an image model bills its image as completion tokens`
      );
    } else {
      // The profile uses image tokens and the catalogue publishes no rate for them. They have
      // already been charged at the output rate above, which makes that figure a guess. Report the
      // component as unpriced rather than let a merged number stand in for the image charge.
      complete = false;
      breakdown.image_output = null;
      assumptions.push(
        `the profile generates ${Math.round(imageTokens)} image tokens per call but this model publishes no image output rate, so those tokens are charged at the text output rate${rate.output_per_m !== null ? ` of ${rate.output_per_m}/M` : ""}. Treat this figure as unverified`
      );
    }
  } else {
    breakdown.image_output = 0;
  }

  // --- 4. reasoning tokens: billed, invisible, often not separately priced ---
  if (reasoningTokens > 0) {
    if (model.pricing?.reasoning_per_m != null) {
      breakdown.reasoning = (reasoningTokens / 1e6) * model.pricing.reasoning_per_m;
      assumptions.push(
        `reasoning tokens charged at the published reasoning rate of ${model.pricing.reasoning_per_m}/M`
      );
    } else if (rate.output_per_m !== null) {
      breakdown.reasoning = (reasoningTokens / 1e6) * rate.output_per_m;
      assumptions.push(
        `no separate reasoning rate is published, so ${Math.round(reasoningTokens)} reasoning tokens per call are charged at the output rate. Whether that is what the provider does is UNVERIFIED`
      );
    } else {
      complete = false;
      breakdown.reasoning = null;
    }
    total += breakdown.reasoning ?? 0;
  } else {
    breakdown.reasoning = 0;
  }

  // --- 5. per-call charges, which are outside token maths ---
  breakdown.per_call = 0;
  for (const [kind, count] of Object.entries(counts)) {
    if (!count) continue;
    const price = model.pricing?.per_call?.[kind];
    if (price === null || price === undefined) {
      complete = false;
      assumptions.push(`the profile uses ${count} ${kind} per call but no ${kind} price is published`);
      continue;
    }
    breakdown.per_call += count * price;
  }
  total += breakdown.per_call;

  return {
    slug: model.slug,
    source: model.source,
    total,
    breakdown,
    complete,
    rate_used: rate,
    tier_applied: tier?.min_prompt_tokens ?? null,
    assumptions,
  };
}

// ---------------------------------------------------------------------------
// The buyer's volume
// ---------------------------------------------------------------------------

/**
 * Project a month.
 *
 * The result always carries its own assumptions, and always carries `basis`, which says whether
 * the token counts came from a real run or from someone's guess. Those are different claims and
 * the report has to be able to tell them apart.
 */
export function projectMonthly(model, profile, callsPerMonth = null) {
  const calls = callsPerMonth ?? profile.calls_per_month ?? null;
  if (calls === null) {
    return {
      slug: model.slug,
      monthly_cost: null,
      cost_per_call: null,
      basis: "no volume given",
      assumptions: ["monthly cost needs a call volume; none was supplied"],
      complete: false,
    };
  }

  const per = costPerCall(model, profile);

  return {
    slug: model.slug,
    name: model.name,
    source: model.source,
    cost_per_call: per.total,
    monthly_cost: per.complete ? per.total * calls : null,
    breakdown_monthly: Object.fromEntries(
      Object.entries(per.breakdown).map(([k, v]) => [k, v === null ? null : v * calls])
    ),
    tier_applied: per.tier_applied,
    rate_used: per.rate_used,
    assumptions: per.assumptions,
    complete: per.complete,
    profile_source: profile.source ?? "assumed",
  };
}

/**
 * Project a whole shortlist and rank it.
 *
 * Candidates whose cost cannot be fully projected are NOT ranked as cheap. They are listed
 * separately with the reason, because a partial number sorted alongside complete ones is the
 * cheapest-looking lie in the table.
 */
export function projectShortlist(models, profile, callsPerMonth = null) {
  const projections = models.map((m) => projectMonthly(m, profile, callsPerMonth));
  const complete = projections
    .filter((p) => p.complete && p.monthly_cost !== null)
    .sort((a, b) => a.monthly_cost - b.monthly_cost);
  const incomplete = projections.filter((p) => !p.complete || p.monthly_cost === null);
  return { ranked: complete, incomplete, all: projections };
}
