/**
 * Normalise two catalogues that describe the same kind of thing in two different ways.
 *
 * OpenRouter: one price per model. Hugging Face: one price per *provider*, several providers per
 * model, and 111 of those provider entries have no price at all.
 *
 * Everything here is pure. It takes already-fetched JSON and returns one internal shape, so it can
 * be tested without a network and pasted into an n8n Code node unchanged.
 *
 * Two rules that come from Day 1 and are enforced here rather than trusted to the caller:
 *   1. Never treat a missing price as zero. Missing means unknown, and unknown is reported.
 *   2. Detect a free model by price == 0, never by the is_free flag. No model reports is_free,
 *      yet at least one provider prices a model at 0.00.
 */

import { perTokenToPerMillion, perMillionToPerMillion, toNumber } from "./units.mjs";

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

/** OpenRouter prices are USD-per-token strings. Every one goes through the same conversion. */
function normaliseOpenRouterPricing(pricing = {}) {
  const tiers = (pricing.overrides ?? []).map((o) => ({
    min_prompt_tokens: o.min_prompt_tokens ?? null,
    input_per_m: perTokenToPerMillion(o.prompt),
    output_per_m: perTokenToPerMillion(o.completion),
    cache_read_per_m: perTokenToPerMillion(o.input_cache_read),
    cache_write_per_m: perTokenToPerMillion(o.input_cache_write),
  }));

  return {
    input_per_m: perTokenToPerMillion(pricing.prompt),
    output_per_m: perTokenToPerMillion(pricing.completion),
    cache_read_per_m: perTokenToPerMillion(pricing.input_cache_read),
    cache_write_per_m: perTokenToPerMillion(pricing.input_cache_write),
    // The rate charged for reasoning tokens where the model has a separate one. Null means
    // "not separately priced", which is NOT the same as free. The cost engine decides what to
    // charge instead, and states its assumption when it does.
    reasoning_per_m: perTokenToPerMillion(pricing.internal_reasoning),
    tiers,
    // These three are USD PER CALL, not per token, and must NOT go through the per-token
    // converter. Running pricing.web_search ("0.01") through it would report $10,000 per search.
    // The distinction the Day 1 unit error hinged on: `image` is per input image and `web_search`
    // is per search, while `image_output` below is per image TOKEN and does belong with the
    // per-token family. Two similar names, two different units, one line apart.
    per_call: {
      image: toNumber(pricing.image),
      web_search: toNumber(pricing.web_search),
      request: toNumber(pricing.request),
    },
    // Image OUTPUT is priced per image token, not per image. Kept in the per-token family
    // deliberately, because that is what it is. See docs/units.md.
    image_output_per_m: perTokenToPerMillion(pricing.image_output),
  };
}

export function normaliseOpenRouterModel(raw) {
  const pricing = normaliseOpenRouterPricing(raw.pricing);
  const flags = [];

  // A leading "~" marks a floating alias that resolves to whatever "latest" currently means.
  // The price is real but the target can move under the buyer, so it is flagged.
  if (typeof raw.id === "string" && raw.id.startsWith("~")) {
    flags.push("floating_alias: this id resolves to a moving target and can change without notice");
  }
  // Day 1 correction: do not rely on expiration_date. Only 4 of 446 models carry it, so its
  // absence says nothing. It is reported when present and never treated as a deprecation signal.
  if (raw.expiration_date) flags.push(`carries_expiration_date: ${raw.expiration_date}`);
  if (raw.pricing?.overrides?.length) {
    flags.push(
      `tiered_pricing: ${raw.pricing.overrides.length} tier(s) above ${raw.pricing.overrides[0].min_prompt_tokens} prompt tokens`
    );
  }
  if (pricing.input_per_m === null) flags.push("no_input_price_in_catalogue");

  return {
    slug: raw.id,
    canonical_slug: raw.canonical_slug ?? raw.id,
    name: raw.name ?? raw.id,
    source: "openrouter",
    context_length: raw.context_length ?? null,
    input_modalities: raw.architecture?.input_modalities ?? [],
    output_modalities: raw.architecture?.output_modalities ?? [],
    expiration_date: raw.expiration_date ?? null,
    pricing,
    // OpenRouter picks the provider for you; it does not expose a per-provider price list here.
    providers: [],
    raw_pricing: raw.pricing ?? null,
    flags,
  };
}

// ---------------------------------------------------------------------------
// Hugging Face
// ---------------------------------------------------------------------------

/**
 * Hugging Face prices per provider, so a model has no single price until you choose one.
 *
 * This picks the cheapest provider that is both `status: live` and actually carries a price, then
 * keeps the whole list so the runner-up and the context lengths can be shown beside it. Day 1
 * found the cheapest provider is often the one with the smallest context window, so a bare
 * "cheapest" figure is misleading and this shape exists to stop it being shown alone.
 */
export function normaliseHuggingFaceModel(raw) {
  const flags = [];

  const providers = (raw.providers ?? []).map((p) => {
    const hasPricing = p.pricing && (p.pricing.input !== undefined || p.pricing.output !== undefined);
    return {
      name: p.provider ?? "(unnamed)",
      live: p.status === "live",
      context_length: p.context_length ?? null,
      input_per_m: perMillionToPerMillion(p.pricing?.input),
      output_per_m: perMillionToPerMillion(p.pricing?.output),
      // The flag is reported but never used to decide anything: no model sets it, and one
      // provider prices a model at 0.00. Price is the only signal that behaves.
      is_free_flag: p.is_free ?? null,
      first_token_latency_ms: p.first_token_latency_ms ?? null,
      throughput: p.throughput ?? null,
      supports_tools: p.supports_tools ?? null,
      has_pricing: Boolean(hasPricing),
    };
  });

  const priced = providers.filter((p) => p.live && p.input_per_m !== null);
  const pricedAndOutput = priced.filter((p) => p.output_per_m !== null);
  const ranked = (pricedAndOutput.length ? pricedAndOutput : priced).sort(
    (a, b) => a.input_per_m - b.input_per_m
  );

  if (providers.length === 0) flags.push("no_providers_listed");
  if (priced.length === 0) flags.push("no_live_priced_provider: this model cannot be priced from the catalogue");
  if (providers.some((p) => !p.has_pricing)) {
    const n = providers.filter((p) => !p.has_pricing).length;
    flags.push(`${n} provider(s) carry no pricing key`);
  }
  if (ranked.length === 1) {
    flags.push("single_provider: no fallback if this provider is unavailable");
  }
  // A free model is one priced at exactly 0.00, not one flagged as free.
  if (ranked.length && ranked[0].input_per_m === 0 && ranked[0].output_per_m === 0) {
    flags.push("free_by_price");
  }
  if (ranked.length > 1 && ranked[0].context_length !== ranked[ranked.length - 1].context_length) {
    flags.push(
      "context_length_varies_by_provider: " +
        `${ranked[0].name} offers ${ranked[0].context_length}, ${ranked[ranked.length - 1].name} offers ${ranked[ranked.length - 1].context_length}`
    );
  }

  const cheapest = ranked[0] ?? null;

  return {
    slug: raw.id,
    canonical_slug: raw.id,
    name: raw.id,
    source: "huggingface",
    context_length: cheapest?.context_length ?? null,
    input_modalities: raw.architecture?.input_modalities ?? [],
    output_modalities: raw.architecture?.output_modalities ?? [],
    expiration_date: null,
    pricing: {
      input_per_m: cheapest?.input_per_m ?? null,
      output_per_m: cheapest?.output_per_m ?? null,
      cache_read_per_m: null, // not published on this route
      cache_write_per_m: null,
      reasoning_per_m: null,
      tiers: [],
      per_call: { image: null, web_search: null, request: null },
      image_output_per_m: null,
    },
    // EVERY provider, including the unpriced and the not-live ones. This list is the evidence for
    // the fallback question, and dropping the unpriced entries from it silently undercounts how
    // many routes exist. An earlier version stored only the priced-and-live survivors here, which
    // made a model with four listed providers look like a model with one.
    providers,
    // The priced, live providers, cheapest first. This is the list to select a route FROM.
    providers_ranked: ranked,
    cheapest_provider: cheapest?.name ?? null,
    runner_up_provider: ranked[1]?.name ?? null,
    raw_pricing: raw.providers ?? null,
    flags,
  };
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

/**
 * Build one lookup over both catalogues.
 *
 * @param {object} raw - { openrouter: <parsed /models body>, huggingface: <parsed /v1/models body> }
 * @param {string} fetchedAt - ISO timestamp. Prices move, so when they were read is part of them.
 */
export function buildCatalogue({ openrouter = null, huggingface = null }, fetchedAt = null) {
  const models = [];

  const orList = openrouter?.data ?? openrouter ?? [];
  for (const m of orList) {
    if (m?.id) models.push(normaliseOpenRouterModel(m));
  }

  const hfList = huggingface?.data ?? huggingface ?? [];
  for (const m of hfList) {
    if (m?.id) models.push(normaliseHuggingFaceModel(m));
  }

  // Indexed under every alias a caller might reasonably use, so a shortlist entry does not fail
  // to resolve merely because it used the canonical slug or the other catalogue's spelling.
  const bySlug = new Map();
  for (const model of models) {
    bySlug.set(model.slug, model);
    if (model.canonical_slug && !bySlug.has(model.canonical_slug)) {
      bySlug.set(model.canonical_slug, model);
    }
    bySlug.set(`${model.source}:${model.slug}`, model);
  }

  return { fetched_at: fetchedAt, models, bySlug };
}

/** Look up one model, optionally pinning which catalogue it must come from. */
export function findModel(catalogue, slug, source = null) {
  if (source) return catalogue.bySlug.get(`${source}:${slug}`) ?? null;
  return catalogue.bySlug.get(slug) ?? null;
}

/** How many models each source contributed, for the methodology line in the report. */
export function catalogueSummary(catalogue) {
  const bySource = {};
  for (const m of catalogue.models) {
    bySource[m.source] = (bySource[m.source] ?? 0) + 1;
  }
  const providerEntries = catalogue.models
    .filter((m) => m.source === "huggingface")
    .reduce((a, m) => a + m.providers.length, 0);

  // The count that decides whether the guard on every `providers[].pricing` read is load-bearing.
  // Day 1 found 111 of these and the scope cites 112. Reporting the live figure rather than either
  // note settles it, and it is the number that says how often "unknown" is the honest answer.
  const providersWithoutPricing = catalogue.models
    .filter((m) => m.source === "huggingface")
    .reduce((a, m) => a + m.providers.filter((p) => !p.has_pricing).length, 0);

  const openRouterTiers = catalogue.models
    .filter((m) => m.source === "openrouter")
    .reduce((a, m) => a + (m.pricing?.tiers?.length ?? 0), 0);

  const mechanisms = {
    openrouter_models_with_cache_read_price: catalogue.models.filter(
      (m) => m.source === "openrouter" && m.pricing?.cache_read_per_m !== null
    ).length,
    openrouter_tier_entries: openRouterTiers,
    openrouter_models_with_reasoning_price: catalogue.models.filter(
      (m) => m.source === "openrouter" && m.pricing?.reasoning_per_m !== null
    ).length,
    openrouter_models_with_image_output_price: catalogue.models.filter(
      (m) => m.source === "openrouter" && m.pricing?.image_output_per_m !== null
    ).length,
  };

  return {
    fetched_at: catalogue.fetched_at,
    total: catalogue.models.length,
    by_source: bySource,
    huggingface_provider_entries: providerEntries,
    huggingface_providers_without_pricing: providersWithoutPricing,
    mechanisms,
  };
}
