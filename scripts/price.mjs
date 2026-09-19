#!/usr/bin/env node
/**
 * Cost-Route steps 2 and 3: what the shortlist costs, and what you are actually procuring.
 *
 *   node scripts/price.mjs                    # both catalogues, both tables
 *   node scripts/price.mjs --offline          # use the last saved catalogue instead of fetching
 *   node scripts/price.mjs --benchmark <file> # price against a specific benchmark run
 *
 * The token profile comes from a real benchmark run wherever one exists, because Day 2 measured a
 * 3,000-token prompt where the buyer's estimate said 1,500, and pricing the estimate would have
 * reproduced the exact error this project exists to expose. When no run is available the buyer's
 * assumption is used, and the table says which of the two it was on every row.
 *
 * Prices are read live and stamped with the time they were read. They move, and a cost figure with
 * no fetch date on it is a claim about the past presented as a claim about now.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCatalogue, catalogueSummary, findModel } from "../core/catalogue.mjs";
import { validateShortlist, describeValidation, requiredInputTokens } from "../core/validate.mjs";
import { profileFromRuns, projectMonthly, costPerCall } from "../core/cost.mjs";
import { buildRouteTable, routeFor, selfHostEstimate } from "../core/routes.mjs";
import { buildLedger, renderLedger, ledgerHeadline } from "../core/ledger.mjs";
import { formatPerMillion, formatUSD, conversionIsConsistent } from "../core/units.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const HF_ROUTER_MODELS = "https://router.huggingface.co/v1/models";
const hfHubModel = (id) => `https://huggingface.co/api/models/${id}`;

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const option = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? null : argv[i + 1];
};

const offline = flag("--offline");
const benchmarkFile = option("--benchmark");
const onlyCandidate = option("--candidate");

// ---------------------------------------------------------------------------
// fetching
// ---------------------------------------------------------------------------

async function getJson(url, what) {
  const res = await fetch(url, { headers: { "user-agent": "cost-route/0.3" } });
  if (!res.ok) {
    // The status code is carried through rather than flattened. Day 2 found HF returns 402 for a
    // rate limit and 402 for genuine exhaustion, so a generic "request failed" loses the one
    // detail that distinguishes them.
    throw new Error(`${what}: HTTP ${res.status} ${res.statusText}`);
  }
  return res.json();
}

const catalogueCache = path.join(root, "out", "catalogue-latest.json");

async function loadCatalogues() {
  if (offline) {
    if (!fs.existsSync(catalogueCache)) {
      throw new Error(`--offline was given but ${catalogueCache} does not exist. Run once online first.`);
    }
    const cached = JSON.parse(fs.readFileSync(catalogueCache, "utf8"));
    console.log(`Catalogue read from ${path.relative(root, catalogueCache)} (fetched ${cached.fetched_at})`);
    return cached;
  }

  const [openrouter, huggingface] = await Promise.all([
    getJson(OPENROUTER_MODELS, "OpenRouter /models"),
    getJson(HF_ROUTER_MODELS, "HF router /v1/models"),
  ]);
  const fetchedAt = new Date().toISOString();
  const payload = { fetched_at: fetchedAt, openrouter, huggingface };
  fs.mkdirSync(path.dirname(catalogueCache), { recursive: true });
  fs.writeFileSync(catalogueCache, JSON.stringify(payload));
  return payload;
}

// ---------------------------------------------------------------------------
// the measured profile
// ---------------------------------------------------------------------------

function latestBenchmark() {
  if (benchmarkFile) return path.resolve(root, benchmarkFile);
  const dir = path.join(root, "out");
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
    .sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

/** Pull the measured token shape for one candidate out of a benchmark run, if it ran. */
function measuredProfileFor(benchmark, slug, source, callsPerMonth) {
  if (!benchmark) return null;
  const result = (benchmark.results ?? []).find((r) => r.slug === slug && r.source === source);
  if (!result?.runs?.length) return null;
  const profile = profileFromRuns(result.runs, callsPerMonth);
  if (!profile) return null;
  return { profile, result };
}

// ---------------------------------------------------------------------------
// printing
// ---------------------------------------------------------------------------

const rule = (title) => {
  console.log(`\n${"─".repeat(78)}`);
  console.log(title);
  console.log("─".repeat(78));
};

function pad(s, n) {
  const str = String(s ?? "");
  return str.length >= n ? str : str + " ".repeat(n - str.length);
}

function padLeft(s, n) {
  const str = String(s ?? "");
  return str.length >= n ? str : " ".repeat(n - str.length) + str;
}

// ---------------------------------------------------------------------------

async function main() {
  console.log("Cost-Route: price mechanics and procurement routes\n");

  if (!conversionIsConsistent()) {
    // If this ever fails, every figure below is wrong by some power of a thousand and the report
    // should not be produced at all.
    throw new Error(
      "Unit conversion is inconsistent. The same price expressed per-token and per-million no " +
        "longer lands on the same number. Nothing downstream can be trusted until this is fixed."
    );
  }

  const workloadPath = path.join(root, "samples", "workload.legal.json");
  const workload = JSON.parse(fs.readFileSync(workloadPath, "utf8"));
  const callsPerMonth = workload.monthly_requests;

  const raw = await loadCatalogues();
  const catalogue = buildCatalogue(raw, raw.fetched_at);
  const summary = catalogueSummary(catalogue);

  rule("1. Catalogues");
  console.log(`Fetched            ${summary.fetched_at}`);
  console.log(`OpenRouter         ${summary.by_source.openrouter ?? 0} models`);
  console.log(
    `Hugging Face       ${summary.by_source.huggingface ?? 0} models, ` +
      `${summary.huggingface_provider_entries} provider entries`
  );
  console.log(`Total              ${summary.total} model records, one internal unit: USD per 1M tokens`);
  console.log(
    `\nPrice mechanics present in the OpenRouter catalogue:\n` +
      `  cache-read rate          ${summary.mechanisms.openrouter_models_with_cache_read_price} models\n` +
      `  tiered rates             ${summary.mechanisms.openrouter_tier_entries} tier entries\n` +
      `  reasoning tokens         ${summary.mechanisms.openrouter_models_with_reasoning_price} models\n` +
      `  image-output tokens      ${summary.mechanisms.openrouter_models_with_image_output_price} models\n` +
      `  base rate                ${summary.by_source.openrouter} models (the only one a headline price shows)`
  );
  console.log(
    `\n${summary.huggingface_providers_without_pricing} of ${summary.huggingface_provider_entries} ` +
      `Hugging Face provider entries carry no pricing key. Every one is charged as unknown, never ` +
      `as zero.`
  );

  let bench = null;
  const benchPath = latestBenchmark();
  if (benchPath && fs.existsSync(benchPath)) {
    bench = JSON.parse(fs.readFileSync(benchPath, "utf8"));
    console.log(`\nMeasured token profile from ${path.relative(root, benchPath)}`);
    console.log(`  run at ${bench.run_at}, ${bench.items} items per candidate`);
  } else {
    console.log("\nNo benchmark run found. Token counts fall back to the buyer's estimate.");
  }

  // --- shortlist ---
  const candidates = (workload.candidates ?? []).filter(
    (c) => !onlyCandidate || c.slug === onlyCandidate
  );

  rule("2. Shortlist validation");
  const measuredByCandidate = new Map();
  for (const c of candidates) {
    const m = measuredProfileFor(bench, c.slug, c.source, callsPerMonth);
    if (m) measuredByCandidate.set(`${c.source}:${c.slug}`, m);
  }
  const firstMeasured = [...measuredByCandidate.values()][0]?.profile ?? null;
  const need = requiredInputTokens(workload, firstMeasured);

  const validated = validateShortlist(candidates, catalogue, workload, { measured: firstMeasured });

  for (const r of validated.results) {
    const mark = r.ok ? "ok  " : "FAIL";
    console.log(`\n[${mark}] ${r.name}`);
    console.log(`       ${r.source}:${r.slug}`);
    for (const c of r.checks) {
      const tag = { pass: "  ok ", fail: " FAIL", warn: " WARN", unknown: "  ?  " }[c.status] ?? "  ?  ";
      console.log(`     ${tag} ${c.name}: ${c.detail}`);
    }
    if (r.ok) console.log(`     -> ${describeValidation(r)}`);
  }
  console.log(
    `\n${validated.valid.length} of ${validated.results.length} candidates can be priced on this workload.`
  );

  // --- cost ---
  rule("3. Cost at the buyer's volume");
  console.log(
    `Volume: ${callsPerMonth.toLocaleString()} requests/month. ` +
      `Prompt size: about ${Math.round(need.tokens)} tokens (${need.basis}).`
  );
  console.log(
    `Buyer's own estimate: ${formatUSD(workload.buyer_estimate?.assumed_cost_per_month_usd)}/month ` +
      `at ${workload.buyer_estimate?.assumed_input_tokens_per_request} tokens per request.`
  );

  const pricedEntries = [];
  const sizes = new Set();
  for (const r of validated.valid) {
    const key = `${r.source}:${r.slug}`;
    const measured = measuredByCandidate.get(key);
    const profile = measured?.profile ?? {
      input_tokens_per_call: workload.buyer_estimate?.assumed_input_tokens_per_request ?? 0,
      cached_input_tokens_per_call: 0,
      output_tokens_per_call: workload.buyer_estimate?.assumed_output_tokens_per_request ?? 0,
      reasoning_tokens_per_call: 0,
      calls_per_month: callsPerMonth,
      per_call_counts: { image: 0, web_search: 0, request: 0 },
      source: "buyer's assumption",
    };
    pricedEntries.push({ result: r, model: r.model, profile, measured });
  }

  // Each candidate is projected with ITS OWN measured profile. Passing one model's token shape to
  // every row is nearly invisible when the candidates ran the same workload, and is wrong the
  // moment they did not: a route that failed every call has a different profile from one that
  // answered fourteen questions, and pricing both from the same numbers hides the failure.
  const projected = pricedEntries.map((e) => ({
    entry: e,
    projection: projectMonthly(e.model, e.profile, callsPerMonth),
  }));
  const projections = {
    all: projected.map((p) => p.projection),
    ranked: projected
      .map((p) => p.projection)
      .filter((p) => p.complete && p.monthly_cost !== null)
      .sort((a, b) => a.monthly_cost - b.monthly_cost),
    incomplete: projected.map((p) => p.projection).filter((p) => !p.complete || p.monthly_cost === null),
  };

  console.log(
    `\n${pad("Candidate", 30)}${pad("src", 6)}${padLeft("in $/M", 10)}${padLeft("eff in $/M", 12)}` +
      `${padLeft("out $/M", 10)}${padLeft("context", 10)}${padLeft("/call", 10)}${padLeft("per month", 12)}`
  );
  console.log("─".repeat(100));

  for (const e of pricedEntries) {
    const p = projections.all.find((x) => x.slug === e.model.slug && x.source === e.model.source);
    const per = costPerCall(e.model, e.profile);

    // Effective input rate: what the buyer actually pays per million prompt tokens once caching is
    // accounted for. Both halves of the input cost count, cached and uncached. Dividing only the
    // uncached cost by the total token count produces a number in the low thousandths that looks
    // like a spectacular bargain and is simply arithmetic on the wrong denominator.
    let eff = null;
    if (per.breakdown.uncached_input !== null && e.profile.input_tokens_per_call > 0) {
      const inputCost = per.breakdown.uncached_input + (per.breakdown.cached_input ?? 0);
      eff = inputCost / (e.profile.input_tokens_per_call / 1e6);
    }

    // "assumed" is shown beside "measured" on every row, because a row priced from the buyer's
    // guess sitting next to rows priced from a real run is the exact confusion this tool exists
    // to catch. Name the source or the number is not worth reading.
    const prof = e.measured ? "measured" : "assumed";
    const shortSrc = e.model.source === "huggingface" ? "HF" : "OR";
    const name = e.result.name.length > 29 ? e.result.name.slice(0, 28) + "…" : e.result.name;

    console.log(
      pad(name, 30) +
        pad(shortSrc, 6) +
        padLeft(formatPerMillion(e.model.pricing.input_per_m), 10) +
        padLeft(eff === null ? "n/a" : formatPerMillion(eff), 12) +
        padLeft(formatPerMillion(e.model.pricing.output_per_m), 10) +
        padLeft(e.model.context_length ? e.model.context_length.toLocaleString() : "n/a", 10) +
        padLeft(formatUSD(p.cost_per_call), 10) +
        padLeft(p.monthly_cost === null ? "n/a" : formatUSD(p.monthly_cost), 12)
    );
    if (!e.measured) {
      console.log(
        `      ^ priced from ${e.profile.source} (~${Math.round(e.profile.input_tokens_per_call)} ` +
          `prompt tokens), not from a measurement: this route produced no usable run to measure`
      );
    }
    if (e.measured) sizes.add(Math.round(e.profile.input_tokens_per_call));
  }
  console.log("─".repeat(100));

  // The trap this whole project is about, catching itself.
  //
  // If one row is priced from a measurement and another from an assumption, the two describe
  // different workloads and their costs are not comparable, however cleanly they sit in the same
  // column. Saying so is the difference between a comparison table and a misleading one.
  //
  // The test is measured versus assumed, not whether the token counts differ at all: three routes
  // running the same workload tokenise it to 3,000, 2,999 and 3,351 tokens, and a warning that
  // fires on that would be noise that trains the reader to ignore it.
  const assumedRows = pricedEntries.filter((e) => !e.measured);
  if (assumedRows.length) {
    const measuredSizes = [...sizes];
    console.log(
      `\n  NOT COMPARABLE: ${assumedRows.length} row(s) above are priced from the buyer's assumed ` +
        `prompt size, not from a run, so they describe a different workload from the measured ` +
        `rows (${measuredSizes.join(", ")} tokens). Compare them as orders of magnitude, never as ` +
        `a ranking. ${assumedRows.map((e) => e.result.name).join(", ")}.`
    );
  }
  console.log("src = catalogue (OR OpenRouter, HF Hugging Face router).");
  console.log("eff in $/M = effective input rate after caching, computed from the measured profile.");
  console.log("Context length is printed beside price on purpose: the cheapest provider is often");
  console.log("the one with the smallest window.");

  // --- assumptions, printed for every candidate that made one ---
  const withAssumptions = projections.all.filter((p) => p.assumptions?.length);
  if (withAssumptions.length) {
    rule("6. What each projection assumed");
    for (const p of withAssumptions) {
      console.log(`\n${p.slug} (${p.profile_source})`);
      for (const a of p.assumptions) console.log(`  - ${a}`);
    }
  }

  // --- the ledger ---
  //
  // Scope calls this the headline and puts it up front, so it comes before the supporting tables
  // rather than after them. It is rendered on the buyer's incumbent, because the gap worth
  // explaining is the gap on the model they are running today.
  rule("4. Estimate against measurement: the gap, attributed");
  const incumbentCandidate =
    candidates.find((c) => c.incumbent) ?? candidates.find((c) => measuredByCandidate.has(`${c.source}:${c.slug}`));
  const incumbentEntry = pricedEntries.find(
    (e) => e.result.slug === incumbentCandidate?.slug && e.result.source === incumbentCandidate?.source
  );

  const ledgers = [];
  if (incumbentEntry?.measured) {
    const ledger = buildLedger(
      incumbentEntry.model,
      workload.buyer_estimate,
      incumbentEntry.measured.profile,
      callsPerMonth,
      { providerNote: "route A does not expose a provider choice, so there was no provider decision to price" }
    );
    ledgers.push(ledger);
    console.log(`\n${ledgerHeadline(ledger)}\n`);
    console.log(renderLedger(ledger));

    if (ledger.unexercised.length) {
      console.log("\n  Mechanics this route or workload never exercised, so they are absent rather than zero:");
      for (const u of ledger.unexercised) console.log(`    · ${u.mechanic}: ${u.why}`);
    }
  } else {
    console.log(
      `  No ledger: no measured token profile for ${
        incumbentCandidate ? `${incumbentCandidate.source}:${incumbentCandidate.slug}` : "any candidate"
      }. A bridge built from one set of guesses to another would be the artifact this project argues against.`
    );
  }

  // --- measured vs projected, where both exist ---
  rule("5. Projection against the measured run");
  console.log(
    "The engine's job is to explain the measured number, not to replace it. Where the two\n" +
      "disagree, the measured one is right and the engine has a bug or an unmodelled mechanic.\n"
  );
  console.log(
    `${pad("Candidate", 34)}${pad("src", 6)}${padLeft("calls", 7)}${padLeft("projected/run", 15)}` +
      `${padLeft("measured/run", 15)}${padLeft("ratio", 9)}`
  );
  console.log("─".repeat(86));
  for (const e of pricedEntries) {
    const measuredRuns = e.measured?.result?.runs ?? [];
    const okRuns = measuredRuns.filter((r) => !r.error && r.usage);

    // A route that never completed a call has nothing to compare against. Printing $0.00 here
    // would read as "this route was free", which is the opposite of what happened: it failed.
    if (okRuns.length === 0) {
      console.log(
        pad(e.result.name.slice(0, 33), 34) +
          pad(e.model.source === "huggingface" ? "HF" : "OR", 6) +
          padLeft("0", 7) +
          padLeft("n/a", 15) +
          padLeft("n/a", 15) +
          padLeft("no run", 9) +
          "   this route completed no call, so there is nothing to compare"
      );
      continue;
    }

    const measuredTotal = okRuns.reduce((a, r) => a + (r.usage?.cost ?? 0), 0);
    const projectedRun = costPerCall(e.model, e.profile).total * okRuns.length;
    const ratio = measuredTotal > 0 ? projectedRun / measuredTotal : null;
    console.log(
      pad(e.result.name.slice(0, 33), 34) +
        pad(e.model.source === "huggingface" ? "HF" : "OR", 6) +
        padLeft(okRuns.length, 7) +
        padLeft(formatUSD(projectedRun), 15) +
        padLeft(formatUSD(measuredTotal), 15) +
        padLeft(ratio === null ? "n/a" : `${ratio.toFixed(2)}x`, 9)
    );
  }

  // --- routes ---
  rule("7. The three procurement routes");

  const hubCards = new Map();
  if (!offline) {
    for (const e of pricedEntries) {
      if (e.model.source !== "huggingface") continue;
      try {
        hubCards.set(e.model.slug, await getJson(hfHubModel(e.model.slug), `HF hub ${e.model.slug}`));
      } catch (err) {
        // A missing model card is a finding, not a crash. Route B's licence column goes unknown.
        console.log(`  (could not read the model card for ${e.model.slug}: ${err.message})`);
      }
    }
  }

  const routeEntries = [];
  for (const e of pricedEntries) {
    const route = routeFor({ source: e.model.source, route: null });
    const p = projections.all.find((x) => x.slug === e.model.slug && x.source === e.model.source);
    routeEntries.push({
      route: route?.id ?? "A",
      model: e.model,
      monthly_cost: p.monthly_cost,
      cost_kind: p.complete ? "quoted price" : "incomplete",
      extras: { hub: hubCards.get(e.model.slug) ?? null, measured: e.measured?.profile ?? null },
      facts: {
        context_length: e.model.context_length,
        providers_live: (e.model.providers ?? []).filter((x) => x.live).length,
        license: hubCards.get(e.model.slug)?.cardData?.license ?? null,
        gated: hubCards.get(e.model.slug)?.gated ?? null,
      },
    });
  }

  // Route C is always shown, even with no open-weight candidate in the shortlist, because the
  // point of the row is to price the road not taken.
  //
  // It is estimated from the MEASURED token profile wherever one exists. Estimating self-hosting
  // from the buyer's guess while pricing the API routes from a real run would compare two
  // different workloads, which is the mistake this whole project is about.
  const openWeight = pricedEntries.find((e) => e.model.source === "huggingface");
  const selfHostProfile = pricedEntries.find((e) => e.measured)?.profile ?? pricedEntries[0].profile;

  // The cheapest quoted route, so route C can state how wrong its assumptions would have to be.
  //
  // Restricted to routes with a measured profile. Taking the cheapest row of any kind would have
  // used the open-weight row priced from the buyer's 1,500-token guess, and route C would then
  // have declared itself 637x too expensive against a number describing a different workload.
  // The comparison has to be like for like or it is worth less than no comparison.
  const measuredProjections = projected
    .filter((p) => p.entry.measured && p.projection.complete && p.projection.monthly_cost !== null)
    .map((p) => p.projection)
    .sort((a, b) => a.monthly_cost - b.monthly_cost);
  const cheapestQuoted = measuredProjections.length ? measuredProjections[0].monthly_cost : null;
  if (!cheapestQuoted) {
    console.log(
      "\n  Route C is compared against no quoted route: none of the priced routes has a measured " +
        "profile to compare it with."
    );
  }
  const selfHost = selfHostEstimate(selfHostProfile, { cheapestApiMonthly: cheapestQuoted });
  routeEntries.push({
    route: "C",
    model: { slug: openWeight ? `${openWeight.model.slug} (weights)` : "any open-weight model" },
    estimate: selfHost,
    cost_kind: "estimate",
    facts: { license: hubCards.get(openWeight?.model.slug)?.cardData?.license ?? null, gated: null },
  });

  // A, then B, then C. The order is the argument: what you are buying before what it costs.
  routeEntries.sort((a, b) => String(a.route).localeCompare(String(b.route)));

  const table = buildRouteTable(routeEntries);

  for (const row of table.rows) {
    console.log(`\n${row.route}. ${row.route_label}`);
    console.log(`   Model      ${row.model}`);
    console.log(`   Cost basis ${row.cost_basis}`);
    if (row.route === "C" && row.estimate?.available) {
      const e = row.estimate;
      console.log(`   ESTIMATE   ${formatUSD(e.estimate_low_usd)}/month if billed per second of use`);
      console.log(`              ${formatUSD(e.estimate_dedicated_usd)}/month on a dedicated instance`);
      for (const w of e.workings) console.log(`              ${w}`);
      for (const c of e.caveats) console.log(`              ! ${c}`);
      console.log("   Assumptions used (NOT VERIFIED):");
      for (const [k, v] of Object.entries(e.assumptions)) {
        if (k === "provenance" || k === "thinking") continue;
        console.log(`              ${k} = ${v}`);
      }
      console.log(`              ${e.assumptions.thinking}`);
    } else if (row.route === "C") {
      console.log(`   ESTIMATE   unavailable: ${row.estimate?.reason}`);
    } else {
      console.log(
        `   Cost       ${row.monthly_cost === null ? "could not be fully projected" : `${formatUSD(row.monthly_cost)}/month`} (${row.cost_kind})`
      );
    }
    if (row.pros.length) {
      console.log("   For");
      for (const p of row.pros) console.log(`     + ${p}`);
    }
    if (row.cons.length) {
      console.log("   Against");
      for (const c of row.cons) console.log(`     - ${c}`);
    }
  }

  console.log(`\n${table.caveat}`);

  // --- save ---
  const outPath = path.join(root, "out", `pricing-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        generated_at: new Date().toISOString(),
        catalogue_fetched_at: summary.fetched_at,
        catalogue_summary: summary,
        benchmark_file: benchPath ? path.relative(root, benchPath) : null,
        workload: workload.workload_name,
        volume: { calls_per_month: callsPerMonth, prompt_tokens: need.tokens, basis: need.basis },
        validation: validated.results.map((r) => ({
          name: r.name, slug: r.slug, source: r.source, ok: r.ok, checks: r.checks,
        })),
        projections: projections.all,
        measured_vs_projected: pricedEntries.map((e) => {
          const okRuns = (e.measured?.result?.runs ?? []).filter((r) => !r.error && r.usage);
          return {
            slug: e.model.slug, source: e.model.source, runs: okRuns.length,
            projected_per_run: costPerCall(e.model, e.profile).total * okRuns.length,
            measured_per_run: okRuns.reduce((a, r) => a + (r.usage?.cost ?? 0), 0),
          };
        }),
        routes: table,
      },
      null,
      2
    )
  );
  console.log(`\nSaved ${path.relative(root, outPath)}`);
}

main().catch((err) => {
  console.error(`\nFAILED: ${err.message}`);
  process.exit(1);
});
