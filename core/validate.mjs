/**
 * Validate the shortlist against the catalogue before anything is priced.
 *
 * A cost comparison between a model that can serve the workload and a model that cannot is not a
 * comparison. Every candidate has to survive these checks first, and when one does not, the fact
 * is reported with the reason rather than dropped from the table, because a silently missing row
 * reads exactly like a model that did not make the shortlist.
 *
 * Day 1 correction, enforced here rather than trusted to the caller: **do not use `expiration_date`
 * as a deprecation signal.** Only 4 of 446 OpenRouter models carry the field, so its absence means
 * nothing at all. A model is treated as deprecated when it has *disappeared* from the catalogue, or
 * when the `canonical_slug` has drifted away from the `id` it was asked for. That is the failure
 * that actually happened during Day 1, when a pinned `anthropic/claude-3.5-sonnet` kept resolving
 * to something other than what was asked for.
 */

import { formatPerMillion } from "./units.mjs";

// ---------------------------------------------------------------------------
// What the workload needs
// ---------------------------------------------------------------------------

/** The output modality a workload requires. Defaults to text, which almost everything supports. */
export function requiredModality(workload = {}) {
  const kind = String(workload.workload_kind ?? "text").toLowerCase();
  if (kind === "image") return "image";
  return "text";
}

/**
 * How many prompt tokens the workload actually needs.
 *
 * Taken from a measured run when one exists, because Day 2 measured a 3,000-token contract where
 * the buyer's own estimate said 1,500. Falls back to the buyer's assumption only when nothing has
 * been measured, and the returned `basis` records which of the two it was.
 */
export function requiredInputTokens(workload = {}, measured = null) {
  if (measured && Number.isFinite(measured.input_tokens_per_call)) {
    return { tokens: measured.input_tokens_per_call, basis: "measured" };
  }
  const assumed = workload.buyer_estimate?.assumed_input_tokens_per_request;
  if (Number.isFinite(assumed)) return { tokens: assumed, basis: "buyer's assumption" };
  return { tokens: null, basis: "unknown" };
}

// ---------------------------------------------------------------------------
// One candidate
// ---------------------------------------------------------------------------

/**
 * Run every check against one shortlist entry.
 *
 * Checks carry a status rather than just a boolean, because three different things can be wrong:
 *   pass    - the check ran and the candidate is fine
 *   fail    - the check ran and the candidate cannot serve this workload
 *   warn    - the check ran and revealed something the buyer should know, but it does not block
 *   unknown - the check could not run, usually because the catalogue does not publish the field
 *
 * `unknown` is deliberately not collapsed into `pass`. Most of the fields this tool needs are
 * simply absent for most models, and a validator that treats absent as fine is a rubber stamp.
 */
export function validateCandidate(candidate, catalogue, workload = {}, options = {}) {
  const checks = [];
  const add = (name, status, detail) => checks.push({ name, status, detail });

  // --- 0. is this even a shortlist entry ---
  //
  // The shortlist is a JSON file a human edits, so a malformed entry is a normal event rather than
  // a crash: a trailing comma in the wrong place leaves a `null` in the array, and writing the slug
  // on its own instead of `{ "slug": ... }` is an easy slip. Both used to throw out of `.slug` and
  // take the whole run with them, which is the worst available response - the file is still
  // readable and every other entry in it was fine. A failed check is returned instead, so the row
  // survives into the table with the reason printed beside it. That is what `validateShortlist`
  // promises and what the report needs in order to show a shortlist of four with one struck out.
  const isObject =
    candidate !== null && typeof candidate === "object" && !Array.isArray(candidate);
  const bareSlug =
    typeof candidate === "string" && candidate.trim() !== "" ? candidate.trim() : null;
  const hasSlug = isObject && typeof candidate.slug === "string" && candidate.slug.trim() !== "";

  if (!hasSlug) {
    // Naming the value rather than just rejecting it, because "the entry is wrong" sends the reader
    // back to a file with no hint of which of the two things to fix.
    const detail = !isObject
      ? `this shortlist entry is ${
          candidate === null
            ? "null"
            : Array.isArray(candidate)
              ? "an array"
              : bareSlug
                ? `the bare string "${bareSlug}"`
                : `a ${typeof candidate}`
        } rather than an object with a slug` +
        (bareSlug ? `, and needs to be {"slug": "${bareSlug}"}` : "") +
        `. Nothing can be looked up, so this entry cannot be priced.`
      : `this shortlist entry has no "slug", so there is nothing in the catalogue to look up` +
        (candidate.name ? ` ("${candidate.name}" is a display name, not an id)` : "") +
        `.`;

    return {
      slug: bareSlug ?? (typeof candidate?.slug === "string" ? candidate.slug : null),
      source: isObject ? (candidate.source ?? null) : null,
      name: (isObject ? candidate.name ?? candidate.slug : bareSlug) ?? "(unnamed entry)",
      ok: false,
      model: null,
      checks: [{ name: "shape", status: "fail", detail }],
    };
  }

  const source = candidate.source ?? null;
  const model = catalogue.bySlug.get(
    source ? `${source}:${candidate.slug}` : candidate.slug
  ) ?? null;

  // --- 1. does it exist at all ---
  if (!model) {
    // Before calling it gone, check whether it moved. A rename is not a disappearance, and the
    // two call for different actions: one is an update to the shortlist, the other is a re-plan.
    const elsewhere = catalogue.bySlug.get(candidate.slug) ?? null;
    if (elsewhere) {
      add(
        "exists",
        "fail",
        `not found in the ${source ?? "requested"} catalogue, but "${candidate.slug}" exists in ` +
          `${elsewhere.source}. The candidate's source field is probably wrong.`
      );
    } else {
      add(
        "exists",
        "fail",
        `"${candidate.slug}" is absent from the fetched catalogue. Either the id is wrong or the ` +
          `model has been withdrawn. This is the deprecation signal this tool trusts.`
      );
    }
    return { slug: candidate.slug, source, name: candidate.name, ok: false, model: null, checks };
  }

  add("exists", "pass", `found in the ${model.source} catalogue as "${model.slug}"`);

  // --- 2. has it been renamed under us ---
  // This is the check that would have caught the Day 1 claude-3.5-sonnet problem.
  if (model.source === "openrouter") {
    if (model.canonical_slug && model.canonical_slug !== model.slug) {
      add(
        "renamed",
        "warn",
        `requested as "${model.slug}", canonical slug is "${model.canonical_slug}". The id still ` +
          `resolves, but pinning the canonical slug is safer than pinning an alias that can move.`
      );
    } else {
      add("renamed", "pass", "requested id and canonical slug agree");
    }
    if (typeof model.slug === "string" && model.slug.startsWith("~")) {
      add(
        "renamed",
        "fail",
        "this is a floating alias (leading '~'). It resolves to whatever 'latest' means today, so " +
          "both the model and its price can change without notice."
      );
    }
  } else {
    add(
      "renamed",
      "unknown",
      "this catalogue does not publish a separate canonical slug, so drift cannot be detected from it alone"
    );
  }

  // --- 3. can it produce the output this workload needs ---
  const needed = requiredModality(workload);
  const outputs = model.output_modalities ?? [];
  if (outputs.length === 0) {
    add(
      "output_modalities",
      "unknown",
      `the catalogue does not publish output modalities for this model, so it cannot be confirmed ` +
        `to produce ${needed}`
    );
  } else if (outputs.includes(needed)) {
    add("output_modalities", "pass", `produces ${needed} (${outputs.join(", ")})`);
  } else {
    add(
      "output_modalities",
      "fail",
      `this workload needs ${needed} output but the model declares only: ${outputs.join(", ")}`
    );
  }

  // --- 4. context length against what the workload actually sends ---
  const need = requiredInputTokens(workload, options.measured ?? null);
  if (model.context_length === null || model.context_length === undefined) {
    add(
      "context_length",
      "unknown",
      "no context length published, so the prompt size cannot be checked against it"
    );
  } else if (need.tokens === null) {
    add(
      "context_length",
      "unknown",
      `context length is ${model.context_length}, but the workload's prompt size is unknown so ` +
        `there is nothing to check it against`
    );
  } else if (model.context_length >= need.tokens) {
    add(
      "context_length",
      "pass",
      `${model.context_length} tokens available, about ${Math.round(need.tokens)} needed ` +
        `(${need.basis})`
    );
  } else {
    add(
      "context_length",
      "fail",
      `${model.context_length} tokens available but about ${Math.round(need.tokens)} needed ` +
        `(${need.basis}). This candidate cannot be sent the workload at all.`
    );
  }

  // --- 5. route B specifics: which providers, live, at what size ---
  if (model.source === "huggingface") {
    const requested = candidate.provider ?? null;
    const live = model.providers.filter((p) => p.live);

    if (model.providers.length === 0) {
      add("providers", "fail", "this model lists no inference providers, so there is nothing to call");
    } else if (live.length === 0) {
      add(
        "providers",
        "fail",
        `all ${model.providers.length} listed provider(s) are not live. The model exists but ` +
          `currently has no route to serve it.`
      );
    } else {
      const named = live
        .map((p) => `${p.name} (${p.context_length ?? "?"} tokens${p.has_pricing ? "" : ", no price published"})`)
        .join(", ");
      add("providers", "pass", `${live.length} live provider(s): ${named}`);
    }

    if (requested) {
      const match = model.providers.find((p) => p.name.toLowerCase() === String(requested).toLowerCase());
      if (!match) {
        add(
          "requested_provider",
          "fail",
          `the shortlist names provider "${requested}" but it is not in the catalogue's list for ` +
            `this model`
        );
      } else if (!match.live) {
        add("requested_provider", "fail", `provider "${requested}" is listed but not live`);
      } else if (!match.has_pricing) {
        add(
          "requested_provider",
          "warn",
          `provider "${requested}" is live but publishes no price, so its cost cannot be projected. ` +
            `This is one of the entries Day 1 warned about.`
        );
      } else {
        add(
          "requested_provider",
          "pass",
          `"${requested}" is live at ${match.context_length ?? "?"} tokens, ` +
            `${formatPerMillion(match.input_per_m)} in, ${formatPerMillion(match.output_per_m)} out`
        );
      }

      // The check that stops "cheapest" being read as "best". Day 1 found the cheapest provider is
      // frequently the one with the smallest context window.
      if (match && match.context_length !== null && need.tokens !== null && match.context_length < need.tokens) {
        add(
          "provider_context",
          "fail",
          `the named provider "${requested}" offers ${match.context_length} tokens, below the ` +
            `${Math.round(need.tokens)} the workload sends. Another provider on the same model may ` +
            `be large enough, but it will not be the cheap one.`
        );
      }
    }

    if (live.length === 1 && model.providers.length > 1) {
      add(
        "fallback",
        "warn",
        `${model.providers.length} provider(s) listed but only one is live. There is no fallback ` +
          `if it goes down, which is real lock-in on an "open" model.`
      );
    } else if (live.length === 1) {
      add(
        "fallback",
        "warn",
        "only one provider serves this model. Open weights, but a single point of failure."
      );
    } else if (live.length > 1) {
      add("fallback", "pass", `${live.length} live providers, so a fallback exists`);
    }
  }

  // --- 6. price is actually published ---
  if (model.source === "huggingface") {
    if (model.pricing.input_per_m === null) {
      add(
        "priced",
        "fail",
        "no live provider publishes a price, so this candidate cannot appear in a cost comparison"
      );
    } else {
      add(
        "priced",
        "pass",
        `${formatPerMillion(model.pricing.input_per_m)} in, ${formatPerMillion(model.pricing.output_per_m)} out`
      );
    }
  } else if (model.pricing.input_per_m === null || model.pricing.output_per_m === null) {
    add("priced", "fail", "the catalogue publishes no input or output price for this model");
  } else {
    add(
      "priced",
      "pass",
      `${formatPerMillion(model.pricing.input_per_m)} in, ${formatPerMillion(model.pricing.output_per_m)} out`
    );
  }

  const ok = !checks.some((c) => c.status === "fail");
  return { slug: candidate.slug, source: model.source, name: candidate.name, ok, model, checks };
}

/**
 * Validate the whole shortlist.
 *
 * Ordering is preserved and failures are kept, so the report can show a shortlist of four with one
 * struck out and the reason beside it, rather than quietly comparing three.
 */
export function validateShortlist(candidates, catalogue, workload = {}, options = {}) {
  // Anything that is not an array has no entries to check, and `.map` on it throws where the
  // caller gets a stack trace instead of a count. An absent `candidates` key is the common case -
  // it is what a workload file looks like before anyone has filled the shortlist in - and an empty
  // shortlist is a true reading of that file, not a failure.
  const entries = Array.isArray(candidates) ? candidates : [];
  const results = entries.map((c) => validateCandidate(c, catalogue, workload, options));
  return {
    results,
    valid: results.filter((r) => r.ok),
    invalid: results.filter((r) => !r.ok),
  };
}

/** One line per candidate for a console table. */
export function describeValidation(result) {
  const fails = result.checks.filter((c) => c.status === "fail");
  const warns = result.checks.filter((c) => c.status === "warn");
  const unknowns = result.checks.filter((c) => c.status === "unknown");
  if (!result.ok) return `REJECTED: ${fails.map((c) => c.detail).join(" ")}`;
  const bits = [`${result.checks.length} checks passed`];
  if (warns.length) bits.push(`${warns.length} warning(s)`);
  if (unknowns.length) bits.push(`${unknowns.length} could not be checked`);
  return bits.join(", ");
}
