/**
 * The three procurement routes, side by side.
 *
 *   A. Closed API model      - USD per token, read from OpenRouter
 *   B. Open weights, served  - USD per million tokens, per provider, read from the HF router
 *   C. Open weights, self-hosted - no price exists. An estimate with named assumptions, or nothing.
 *
 * The point of this module is the last column of that table: what price cannot express. Licence,
 * gating, provider count, fallback, and whether an "open" model is actually open to this buyer.
 *
 * Two rules that shape everything below:
 *
 *   1. Route C is never given a price. It gets an estimate whose every input is named and whose
 *      provenance is stated, and it is formatted differently from A and B so it cannot be read as
 *      one more row of the same table. The project's argument is that a confident number with a
 *      hidden assumption is worse than no number; producing one here would be self-refuting.
 *
 *   2. Pros and cons are derived from catalogue facts, never from adjectives. "Open" is not a pro.
 *      "Two of four listed providers are live, so there is a fallback" is a pro, and it is one the
 *      catalogue can be asked to confirm or deny.
 */

import { formatPerMillion } from "./units.mjs";

// ---------------------------------------------------------------------------
// Which route is this
// ---------------------------------------------------------------------------

export const ROUTES = {
  A: {
    id: "A",
    label: "Closed API model",
    cost_basis: "USD per token, quoted as a string, converted to USD per 1M tokens",
    source: "openrouter",
  },
  B: {
    id: "B",
    label: "Open weights, served by a third party",
    cost_basis: "USD per 1M tokens, quoted as a float, per provider",
    source: "huggingface",
  },
  C: {
    id: "C",
    label: "Open weights, self-hosted",
    cost_basis: "no price exists; the figure below is an estimate with stated assumptions",
    source: null,
  },
};

/** Resolve a candidate's route, preferring an explicit one over a guess from the source. */
export function routeFor(candidate) {
  if (candidate?.route && ROUTES[candidate.route]) return ROUTES[candidate.route];
  if (candidate?.source === "huggingface") return ROUTES.B;
  if (candidate?.source === "openrouter") return ROUTES.A;
  return null;
}

// ---------------------------------------------------------------------------
// Route C. An estimate, or an honest refusal to give one.
// ---------------------------------------------------------------------------

/**
 * The assumptions behind every self-hosting figure this tool prints.
 *
 * NOTHING HERE IS VERIFIED IN THIS BUILD. These are defaults so the demo has a row C at all, and
 * each one is a number a real buyer would replace with their own quote before making a decision.
 * They are exported as data rather than buried as literals so the report can print them verbatim
 * and a reader can disagree with any one of them.
 */
export const SELF_HOST_ASSUMPTIONS = {
  gpu_hourly_usd: 2.0,
  gpu_name: "single mid-range datacentre GPU",
  tokens_per_second: 80,
  thinking: "a 4B-class model with batching on one mid-range GPU",
  ops_hours_per_month: 8,
  ops_hourly_usd: 75,
  provenance:
    "ASSUMED, NOT VERIFIED. These defaults exist so the build has a row C. Replace them with a " +
    "real quote; every one of them changes the answer.",
};

/**
 * What self-hosting would cost, as an estimate that shows its own working.
 *
 * Two numbers come out, and the difference between them is the actual finding:
 *
 *   serverless_hours  - GPU time genuinely consumed. The floor.
 *   dedicated_hours   - GPU time you pay for if you want the endpoint up at 3am. A month of clock.
 *
 * When the workload only needs a few hours of GPU a month, and nothing else can share the hardware,
 * the buyer is paying for an idle server either way, and that is a conclusion no per-token price
 * column will ever show them.
 */
export function selfHostEstimate(profile, options = {}) {
  const a = { ...SELF_HOST_ASSUMPTIONS, ...(options.assumptions ?? {}) };
  const calls = profile?.calls_per_month;
  if (!calls) {
    return {
      available: false,
      reason: "self-hosting is priced per month and no monthly volume was given",
    };
  }

  const tokensPerCall =
    (profile.input_tokens_per_call ?? 0) +
    (profile.output_tokens_per_call ?? 0) +
    (profile.reasoning_tokens_per_call ?? 0);
  const tokensPerMonth = tokensPerCall * calls;

  if (!a.tokens_per_second || a.tokens_per_second <= 0) {
    return {
      available: false,
      reason: "no throughput assumption was supplied, so GPU time cannot be estimated",
      tokens_per_month: tokensPerMonth,
    };
  }

  const gpuHoursNeeded = tokensPerMonth / a.tokens_per_second / 3600;
  const hoursInMonth = 24 * 30;
  const dedicatedHours = hoursInMonth;
  const utilization = gpuHoursNeeded / dedicatedHours;

  const computeOnly = gpuHoursNeeded * a.gpu_hourly_usd;
  const opsCost = a.ops_hours_per_month * a.ops_hourly_usd;
  const serverless = computeOnly + opsCost;
  const dedicated = dedicatedHours * a.gpu_hourly_usd + opsCost;

  // How wrong would these assumptions have to be before the answer changes?
  //
  // This is the only honest way to present an estimate built mostly from invented inputs. A single
  // figure invites the reader to audit one number; a required error factor lets them judge whether
  // the conclusion is worth auditing at all. The comparison uses `serverless`, the most favourable
  // of the two self-hosting figures, so the stated factor is a floor rather than a flattering one.
  const benchmarkMonthly = options.cheapestApiMonthly ?? null;
  const errorFactor = benchmarkMonthly && benchmarkMonthly > 0 ? serverless / benchmarkMonthly : null;

  return {
    available: true,
    // Not `monthly_cost`. Deliberately a different key, so nothing downstream can treat this as a
    // price that sits alongside routes A and B.
    estimate_low_usd: serverless,
    estimate_dedicated_usd: dedicated,
    tokens_per_month: tokensPerMonth,
    gpu_hours_needed: gpuHoursNeeded,
    gpu_hours_billed_if_dedicated: dedicatedHours,
    utilization,
    ops_share_of_estimate: serverless > 0 ? opsCost / serverless : null,
    error_factor_to_compete: errorFactor,
    assumptions: a,
    workings: [
      `${Math.round(tokensPerCall)} tokens per call x ${calls.toLocaleString()} calls = ` +
        `${Math.round(tokensPerMonth).toLocaleString()} tokens per month`,
      `${Math.round(tokensPerMonth).toLocaleString()} tokens / ${a.tokens_per_second} tokens per ` +
        `second = ${gpuHoursNeeded.toFixed(2)} GPU-hours of compute needed`,
      `that is ${(utilization * 100).toFixed(1)}% of a month's ${dedicatedHours} hours, so a ` +
        `dedicated instance is idle ${(100 - utilization * 100).toFixed(1)}% of the time`,
      `compute at $${a.gpu_hourly_usd}/hour = ${usd(computeOnly)}; plus ` +
        `${a.ops_hours_per_month}h/month of operations at $${a.ops_hourly_usd}/hour = ${usd(opsCost)}`,
      `billing by the second of actual use = ${usd(serverless)}; holding the instance up all ` +
        `month = ${usd(dedicated)}, which is the real price of an endpoint that answers at 3am`,
    ],
    caveats: [
      "This is an estimate, not a price. No vendor is quoted anywhere in it, and it must never be " +
        "placed in a table beside the quoted prices of routes A and B as though it were one.",
      "It excludes egress, storage, redundancy, and the engineering time to make the throughput " +
        "assumption true in the first place.",
      `Operations is ${Math.round((opsCost / (serverless || 1)) * 100)}% of the low estimate. The ` +
        `human cost of running the thing is larger than the GPU bill.`,
      errorFactor
        ? `The cheapest quoted route on this workload costs ${usd(benchmarkMonthly)}/month. On the ` +
          `most favourable reading of these assumptions, self-hosting has to be ${errorFactor.toFixed(0)}x ` +
          `cheaper than this estimate to compete. Every input above would have to be wrong by that ` +
          `factor, all in the same direction, before the recommendation changes. That is what makes ` +
          `this estimate robust despite being built from assumed numbers.`
        : `No quoted route was supplied to compare against, so how far these assumptions could be ` +
          `wrong before they changed the answer is unknown.`,
    ],
  };
}

function usd(n) {
  if (n === null || n === undefined) return "n/a";
  return n < 1 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Pros and cons, from facts
// ---------------------------------------------------------------------------

/**
 * Licences that ask nothing of the buyer.
 *
 * Kept as a list of prefixes because model cards write them with suffixes and version numbers
 * ("apache-2.0", "mit", "cc-by-4.0"). Anything not on this list is treated as carrying terms worth
 * reading, which is the safe direction: a licence this tool has never heard of is not thereby
 * permissive.
 */
export const PERMISSIVE_LICENSES = ["apache", "mit", "bsd", "cc0", "cc-by-4.0", "cc-by-sa"];

/**
 * Derive the arguments for and against a route from what the catalogue actually says.
 *
 * Every line returned here is either a fact read out of the catalogue or a fact this project
 * measured. Nothing is a general claim about open versus closed models, because a general claim is
 * the thing the buyer can get from any comparison site for free.
 *
 * @param {object} entry - a model record plus whatever was measured about it
 * @param {object} extras - { hub, measured, route }
 */
export function prosAndCons(entry, extras = {}) {
  const pros = [];
  const cons = [];
  const { measured = null } = extras;

  // The model card arrives in two shapes and both are accepted here: the raw Hub response, and the
  // two fields lifted out of it. This function read only the first while the generator supplied
  // only the second, so on the live page the licence and gating facts were always "unknown" - and
  // were reported as unknown with the same confidence as if the card had genuinely been silent.
  // Gemma 3 4B's card says `license: gemma` and `gated: manual`; the page said neither.
  const hub =
    extras.hub ??
    ("licence" in extras || "gated" in extras
      ? { cardData: { license: extras.licence ?? null }, gated: extras.gated ?? null }
      : null);

  // Which arguments apply is a question about the ROUTE, not about which catalogue the price came
  // from. The two usually agree and one shortlist entry makes them disagree: Gemma 3 4B is served
  // by OpenRouter (a closed aggregator) but the weights are open. Branching on the source there
  // printed "Route B / Open weights, served by a third party" over a list of closed-API arguments,
  // including a vendor-lock warning that is simply false about open weights.
  const route = extras.route ?? (entry.source === "huggingface" ? "B" : "A");
  const openWeights = route === "B";

  // --- how the buyer reaches the model ---
  if (entry.source === "openrouter") {
    pros.push(
      "One endpoint and one key. No weights to run, no capacity to plan, no serving stack to maintain."
    );
  }

  // --- what the price does and does not include ---
  if (entry.pricing?.cache_read_per_m !== null && entry.pricing?.cache_read_per_m !== undefined) {
    // Stated as a conditional, not as a pro, because whether the discount lands is a measured
    // question about prompt structure rather than a property of choosing this model. Day 2
    // measured the same contract cached at 98% on one route and 0% on another.
    pros.push(
      `Publishes a cache-read rate of ${formatPerMillion(entry.pricing.cache_read_per_m)} against ` +
        `a list input rate of ${formatPerMillion(entry.pricing.input_per_m)}. Whether you get it ` +
        `depends on prompt structure, not on choosing this model.` +
        (measured?.effective_input_per_m != null
          ? ` Measured effective input rate on this workload: ${formatPerMillion(measured.effective_input_per_m)}.`
          : "")
    );
  } else {
    // Applies on either route. Put in the route-B branch originally, where it was true but not
    // exclusively so: Gemma on OpenRouter publishes no cache-read rate either, and that row carries
    // the argument just as much as the Hugging Face one does.
    cons.push(
      "No cache pricing is published on this route, so the prompt-caching discount that dominates " +
        "the measured cost on route A does not apply here." +
        (measured?.cache_hit_rate != null
          ? ` Day 2 measured ${Math.round(measured.cache_hit_rate * 100)}% cache hits on this ` +
            `workload against 98% on the closed incumbent.`
          : "")
    );
  }

  // --- lock-in, which only bites when the weights are not open ---
  if (!openWeights) {
    cons.push(
      "Vendor lock. The model can be withdrawn or repriced without notice, and the only signal is " +
        "it disappearing from the catalogue. Note that expiration_date is not a usable warning: " +
        "only 4 of 446 models carry it."
    );
  }
  if (entry.flags?.some((f) => f.startsWith("tiered_pricing"))) {
    cons.push(
      "Tiered pricing: the rate changes once the prompt crosses a size threshold, so a longer " +
        "document silently costs more per token than the headline figure."
    );
  }

  // --- route B: open weights, served ---
  if (openWeights) {
    const live = (entry.providers ?? []).filter((p) => p.live);
    // The Hub reports gating as false, "manual" or "auto". Absent means the Hub did not say.
    if (hub?.gated && hub.gated !== false) {
      cons.push(
        `Gated: the Hub reports gated: "${hub.gated}", so access requires an accepted licence ` +
          `before any call can be made. That is a real step, and it is not in the price.`
      );
    }
    // The Hub keeps the licence under cardData; the router does not report it at all. Reading the
    // wrong level here silently drops the single most valuable column on this route, which is
    // exactly what happened on the first run of this file.
    const license = hub?.cardData?.license ?? null;

    if (license) {
      pros.push(
        `Licence is named and readable: "${license}". With a closed model the equivalent terms ` +
          `are in a vendor agreement, not a file you can inspect.`
      );
      if (PERMISSIVE_LICENSES.some((p) => license.startsWith(p))) {
        pros.push(
          `"${license}" is a permissive licence, so there is no question to ask before use.`
        );
      } else {
        cons.push(
          `The licence is a bespoke or restricted one ("${license}"), not Apache or MIT. It ` +
            `carries use restrictions that a permissive licence does not, and they are the buyer's ` +
            `to check.`
        );
      }
    } else {
      cons.push("No licence could be read from the model card, so the terms of use are unknown.");
    }
    if ((entry.providers ?? []).length > 1) {
      // Live is not the same as usable. A provider with no published price can serve the model but
      // cannot be costed, so it is a fallback for availability and not for budget. Saying "2
      // providers are live" without that distinction overstates what the buyer is actually getting.
      const pricedLive = live.filter((p) => p.has_pricing).length;
      pros.push(
        `${entry.providers.length} providers list this model and ${live.length} are live, so a ` +
          `failing provider can be swapped for another without changing the model.` +
          (pricedLive < live.length
            ? ` Note that only ${pricedLive} of the ${live.length} live providers publishes a ` +
              `price, so the fallback route cannot be costed from the catalogue.`
            : "")
      );
    }
    // Only the Hub reports a provider list. An open-weight model quoted by a closed aggregator has
    // an empty one, and reading that empty list as "no provider is live" told the reader there was
    // no way to serve a model the page had just finished measuring nine successful calls on.
    if (entry.source === "huggingface" && live.length <= 1) {
      cons.push(
        live.length === 1
          ? "Only one provider is live. The weights are open but the route to them is not, which " +
            "is lock-in wearing an open-source label."
          : "No provider is currently live, so there is no route to serve this model at all."
      );
    }
    if (entry.flags?.some((f) => f.startsWith("context_length_varies_by_provider"))) {
      const note = entry.flags.find((f) => f.startsWith("context_length_varies_by_provider"));
      cons.push(
        `Context length varies by provider, so "the model's context window" is not a single number. ${note}`
      );
    }
  }

  return { pros, cons };
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/**
 * Assemble the comparison.
 *
 * Entries arrive already priced (or, for route C, already estimated). This function's job is to
 * keep the three kinds of number from being mistaken for each other, which is why each row carries
 * `cost_kind` and why route C's estimate is never placed in the `monthly_cost` field.
 *
 * @param {Array} entries - [{ route, model, monthly_cost, cost_kind, estimate, extras }]
 */
export function buildRouteTable(entries) {
  const rows = entries.map((e) => {
    const route = ROUTES[e.route] ?? null;
    const { pros, cons } = e.route === "C"
      ? { pros: [], cons: [] }
      : prosAndCons(e.model, { ...(e.extras ?? {}), route: route?.id ?? e.route });

    if (e.route === "C") {
      pros.push(
        "No per-token meter and no vendor between the buyer and the model. Inference stays inside " +
          "the buyer's own infrastructure."
      );
      cons.push(
        "Everything except hardware cost. Throughput engineering, capacity planning, failover, and " +
          "an on-call rota are now the buyer's."
      );
      cons.push("No price exists, so this row cannot be compared numerically with A and B.");
    }

    return {
      route: route?.id ?? e.route,
      route_label: route?.label ?? "(unknown route)",
      model: e.model?.slug ?? e.model?.name ?? null,
      // Which catalogue and which serving provider this price came from. Two rows can share a model
      // and a route and differ only here, and without it they render identically while carrying
      // different prices, which reads as a bug rather than as the two offers it actually is.
      platform: e.model?.source ?? null,
      // The provider whose price the figure actually came from, which on route B is the cheapest
      // live provider the catalogue found rather than whichever one the shortlist named.
      provider: e.model?.cheapest_provider ?? e.extras?.provider ?? null,
      cost_basis: route?.cost_basis ?? null,
      cost_kind: e.cost_kind ?? (e.route === "C" ? "estimate" : "quoted price"),
      monthly_cost: e.route === "C" ? null : (e.monthly_cost ?? null),
      // Null rather than absent when there is no measurement, so the renderer can say "not priced
      // here" instead of printing a figure the buyer's guess would have supplied.
      measured_cost_per_call: e.measured_cost_per_call ?? null,
      estimate: e.estimate ?? null,
      pros,
      cons,
      facts: e.facts ?? {},
    };
  });

  return {
    rows,
    // Stated once, in the table itself, so a screenshot of it carries the caveat with it.
    caveat:
      "Routes A and B are quoted prices read from live catalogues. Route C is an estimate built " +
      "from stated assumptions and is not a price. The three are not interchangeable.",
  };
}
