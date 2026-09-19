#!/usr/bin/env node
/**
 * Cost-Route step 4: generate the interactive report.
 *
 *   node scripts/report.mjs                 # every workload it knows about, from saved inputs
 *   node scripts/report.mjs --fetch         # refresh both catalogues first
 *   node scripts/report.mjs --benchmark f   # force one benchmark run for every workload
 *   node scripts/report.mjs --workload samples/workload.legal.json   # repeatable
 *   node scripts/report.mjs --out path.html
 *
 * By default this reads the saved catalogue rather than fetching. Not for speed: because the report
 * is an argument about numbers that were true at a timestamp, and regenerating it should reproduce
 * the same page from the same inputs rather than quietly producing a different one because a
 * provider moved a price between two runs. `--fetch` is how you deliberately move it.
 *
 * Each workload gets its own benchmark run, located by the `workload_kind` the runner stamped into
 * the file. It has to: `out/` accumulates one file per run, the image and text runs share a
 * directory, and "the newest file" was how this script picked its input until the first image run
 * landed there and the whole text page began rendering image measurements. A benchmark written
 * before that field existed is a text run, which is what the fallback says.
 *
 * The output is one HTML file with no external requests of any kind: no fonts, no scripts, no
 * stylesheets, no analytics. It opens from disk with the network unplugged.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildCatalogue, catalogueSummary, findModel } from "../core/catalogue.mjs";
import { profileFromRuns } from "../core/cost.mjs";
import { byKind, errorKinds, measuredCostPerCall } from "../core/scorer.mjs";
import { routeFor, buildRouteTable, selfHostEstimate } from "../core/routes.mjs";
import { buildLedger } from "../core/ledger.mjs";
import { buildReportModel, renderReportHtml } from "../core/report.mjs";
import { conversionIsConsistent } from "../core/units.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models";
const HF_ROUTER_MODELS = "https://router.huggingface.co/v1/models";
const hfHubModel = (id) => `https://huggingface.co/api/models/${id}`;
const catalogueCache = path.join(root, "out", "catalogue-latest.json");

// The workloads this script knows about. Both are built by default so the default command produces
// the whole page; naming one with --workload narrows it.
const DEFAULT_WORKLOADS = ["samples/workload.legal.json", "samples/workload.image.json"];

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const option = (n) => {
  const i = argv.indexOf(n);
  return i === -1 ? null : argv[i + 1];
};
/** Every value given for a repeatable flag, in the order given. */
const options = (n) => {
  const out = [];
  argv.forEach((a, i) => {
    if (a === n && argv[i + 1] != null) out.push(argv[i + 1]);
  });
  return out;
};

const refresh = flag("--fetch");
const benchmarkFile = option("--benchmark");
const outFile = path.resolve(root, option("--out") ?? path.join("out", "report.html"));
const workloadFiles = options("--workload").length ? options("--workload") : DEFAULT_WORKLOADS;

// ---------------------------------------------------------------------------
// input
// ---------------------------------------------------------------------------

async function getJson(url, what) {
  const res = await fetch(url, { headers: { "user-agent": "cost-route/0.4" } });
  if (!res.ok) throw new Error(`${what}: HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

async function loadCatalogues() {
  if (!refresh && fs.existsSync(catalogueCache)) {
    return { payload: JSON.parse(fs.readFileSync(catalogueCache, "utf8")), source: "cache" };
  }
  const [openrouter, huggingface] = await Promise.all([
    getJson(OPENROUTER_MODELS, "OpenRouter /models"),
    getJson(HF_ROUTER_MODELS, "HF router /v1/models"),
  ]);
  const payload = { fetched_at: new Date().toISOString(), openrouter, huggingface };
  fs.mkdirSync(path.dirname(catalogueCache), { recursive: true });
  fs.writeFileSync(catalogueCache, JSON.stringify(payload));
  return { payload, source: "fetched" };
}

/**
 * The newest benchmark run for one workload kind.
 *
 * Newest-wins is right, but only within a kind. `out/` holds every run ever made and the image and
 * text runs sit side by side; taking the newest file outright meant that the moment an image run
 * landed, the text page began rendering image measurements against a golden set it does not have,
 * and five tests caught it. Reading `workload_kind` is what keeps the two apart.
 */
function benchmarkForKind(kind) {
  if (benchmarkFile) return path.resolve(root, benchmarkFile);
  const dir = path.join(root, "out");
  if (!fs.existsSync(dir)) return null;

  const files = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
    .sort();

  for (let i = files.length - 1; i >= 0; i -= 1) {
    const candidate = path.join(dir, files[i]);
    try {
      const payload = JSON.parse(fs.readFileSync(candidate, "utf8"));
      // Files written before the runner stamped a kind are text runs: they carry a golden set and
      // the runner that produced them had exactly one shape.
      if ((payload.workload_kind ?? "text") === kind) return candidate;
    } catch {
      continue; // an unreadable or half-written run is skipped, not fatal
    }
  }
  return null;
}

/**
 * The licence and gating column. It comes from the Hub model-card API, which is a third source the
 * two price catalogues do not carry. A failure here is not fatal: the licence is reported as
 * unknown, which is a different statement from permissive and is rendered as such.
 */
async function hubCard(modelId) {
  try {
    const res = await fetch(hfHubModel(modelId), { headers: { "user-agent": "cost-route/0.4" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Embed the generated images as data URIs, from the files the runner wrote.
 *
 * The benchmark JSON deliberately carries file names rather than the base64 payloads: four PNGs
 * inline would have put megabytes of text into a file whose value is being readable and diffable.
 * They are read back here, at the one point that needs them, and re-encoded. A missing file is
 * reported as missing rather than as a broken image tag, because "the picture is gone" and "the
 * picture is black" are different failures.
 */
function imagesFor(result) {
  const runs = result?.runs ?? [];
  const images = [];

  for (const run of runs) {
    for (const entry of run.image_files ?? []) {
      if (!entry.file) {
        images.push({ run: run.id, error: entry.note ?? "unreadable image entry" });
        continue;
      }
      const abs = path.join(root, entry.file);
      if (!fs.existsSync(abs)) {
        images.push({ run: run.id, error: `file missing: ${entry.file}` });
        continue;
      }
      const bytes = fs.readFileSync(abs);
      const ext = path.extname(abs).slice(1) || "png";
      const mime = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      images.push({
        run: run.id,
        file: entry.file,
        mime,
        bytes: bytes.length,
        // A data URI rather than a file reference, because the page has to open from disk with the
        // network unplugged and from a sandbox that cannot fetch its own sibling files.
        data_uri: `data:${mime};base64,${bytes.toString("base64")}`,
        latency_ms: run.latency_ms ?? null,
        image_tokens: run.image_tokens ?? null,
        cost_usd: run.cost ?? null,
        cost_source: run.cost_source ?? null,
      });
    }
  }

  return images;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function measuredProfileFor(benchmark, slug, source, callsPerMonth) {
  if (!benchmark) return null;
  const result = (benchmark.results ?? []).find((r) => r.slug === slug && r.source === source);
  if (!result?.runs?.length) return null;
  const profile = profileFromRuns(result.runs, callsPerMonth);
  return profile ? { profile, result } : null;
}

/** The blended input rate after caching. Computed, never looked up. */
function effectiveInputRate(model, profile) {
  if (!profile || !profile.input_tokens_per_call) return null;
  const rate = model.pricing?.input_per_m;
  const cacheRate = model.pricing?.cache_read_per_m;
  if (rate === null || rate === undefined) return null;

  const input = profile.input_tokens_per_call;
  const cached = Math.min(profile.cached_input_tokens_per_call ?? 0, input);
  const uncached = input - cached;
  const cost = (uncached / 1e6) * rate + (cached / 1e6) * (cacheRate ?? rate);
  return (cost / (input / 1e6));
}

/** The quality gate as the page displays it: measured facts, locked. */
function qualityFor(result, kindById = {}) {
  if (!result?.summary) return null;
  const s = result.summary;

  // `scored` and `total` are different numbers and both have to reach the page. `correct / total`
  // was rendered for a candidate whose five missing answers were provider errors, so a model that
  // answered six of the nine questions it was served printed "6/14 correct" — the failures silently
  // counted as wrong answers, which is the one thing summarise goes out of its way not to do.
  return {
    verdict: result.verdict ?? null,
    fail_reasons: result.fail_reasons ?? [],
    // Which checks could not run, as distinct from which ones failed. Without this the image
    // workload — where no quality check exists at all — renders as an ungated clean pass.
    not_applied: result.not_applied ?? [],
    total: s.total,
    scored: s.scored,
    not_served: Math.max(0, (s.total ?? 0) - (s.scored ?? 0)),
    correct: s.correct,
    incorrect: s.incorrect,
    answered: s.answered,
    correct_share: s.correct_share,
    hallucination_count: s.hallucination_count ?? 0,
    error_count: s.error_count ?? 0,
    latency_ms: s.latency_ms ?? null,
    // The per-kind cut, and the status codes behind the failures. Both are computed by the same
    // functions `summarise` calls, so the fallback for benchmarks saved before these fields existed
    // cannot drift from the primary: it is the identical code over the identical runs.
    by_kind: s.by_kind ?? byKind(result.runs ?? [], kindById),
    error_kinds: s.error_kinds ?? errorKinds((result.runs ?? []).filter((r) => r.error)),
  };
}

/** Everything one workload contributes to the page. */
async function buildWorkload(workloadFile, catalogue, callsPerMonthOverride) {
  const file = path.isAbsolute(workloadFile) ? workloadFile : path.join(root, workloadFile);
  const workload = JSON.parse(fs.readFileSync(file, "utf8"));
  const kind = workload.workload_kind ?? "text";
  const callsPerMonth = callsPerMonthOverride ?? workload.monthly_requests;

  // An image workload has no golden set, so nothing is machine-scored and no quality block may be
  // built. Passing null rather than an all-null object is deliberate: the renderer cannot show a
  // correct-share it was never handed, whereas an object full of nulls invites it to print zeros.
  const qualityScored = (workload.golden_set?.length ?? 0) > 0;
  const kindById = Object.fromEntries((workload.golden_set ?? []).map((i) => [i.id, i.kind ?? "fact"]));

  const benchPath = benchmarkForKind(kind);
  const benchmark = benchPath && fs.existsSync(benchPath)
    ? JSON.parse(fs.readFileSync(benchPath, "utf8"))
    : null;

  console.log(`\n  workload     ${workload.workload_name} (${kind})`);
  console.log(`  file         ${path.relative(root, file)}`);
  console.log(`  benchmark    ${benchPath ? path.relative(root, benchPath) : "none found for this kind"}`);

  const candidates = workload.candidates ?? [];
  const entries = [];
  const routeEntries = [];

  for (const c of candidates) {
    // The same file the validator reads, so the same malformed entry can arrive here: a null left
    // by a stray comma, or a slug written on its own. Reading `.slug` off it threw and took the
    // whole page with it, one bad line in a file that was otherwise fine. Skipped with a reason,
    // like a candidate that is not in the catalogue - this loop already refuses rows it cannot
    // price, and the only thing that was wrong was refusing loudly enough to be a stack trace.
    if (c === null || typeof c !== "object" || Array.isArray(c) || typeof c.slug !== "string") {
      console.log(`  MALFORMED    shortlist entry is not an object with a slug: ${JSON.stringify(c)}`);
      continue;
    }

    const model = findModel(catalogue, c.slug, c.source);
    if (!model) {
      console.log(`  MISSING      ${c.source}:${c.slug} is not in the catalogue`);
      continue;
    }

    const measured = measuredProfileFor(benchmark, c.slug, c.source, callsPerMonth);
    // routeFor returns the ROUTES entry, not its key. Passing the object through renders every
    // route label as "[object Object]" in the page, so the id is taken here rather than relying on
    // the renderer to know which of the two it was handed.
    const route = routeFor(c)?.id ?? null;

    // Read for any candidate on the open-weights route, whichever catalogue priced it. The licence
    // and gating facts are properties of the model and its card, not of the aggregator that happens
    // to be quoting it, and gating the lookup on the source left the open-weight row priced by
    // OpenRouter arguing from a closed-API rulebook with its licence column empty.
    const hub = route === "B" ? await hubCard(c.slug) : null;

    // Sum, not per-call, and the conversion lives beside the code that creates the sum so the two
    // cannot drift. See measuredCostPerCall in core/scorer.mjs.
    const perCall = measuredCostPerCall(measured?.result?.summary ?? null);

    entries.push({
      key: `${model.source}:${model.slug}`,
      model,
      route,
      provider: c.provider ?? null,
      incumbent: c.incumbent === true,
      why_in_shortlist: c.why_in_shortlist ?? null,
      licence: hub?.cardData?.license ?? null,
      gated: hub?.gated ?? null,
      measured: measured?.profile ?? null,
      quality: qualityScored ? qualityFor(measured?.result, kindById) : null,
      // Carried for the image tab, which shows the pictures rather than a score. Null on every text
      // candidate, so nothing about the existing page changes.
      images: kind === "image" ? imagesFor(measured?.result) : null,
      // The aggregate the row of numbers under the pictures needs. Carried rather than recomputed
      // from `images` on the page, because the summary's cost rule is deliberately the opposite of
      // its latency rule - cost counts failed runs, latency does not - and a second implementation
      // of that in the renderer is exactly the drift the drift guard exists to prevent.
      image_summary: kind === "image" ? (measured?.result?.image_summary ?? null) : null,
      // The verdict, independently of the quality block. The image workload IS gated - on latency -
      // and on a workload with no golden set `quality` is null by construction, so reading the gate
      // out of it would report a gated run as an ungated one. `not_applied` rides along because
      // "which checks could not run" is the honest half of a PASS on a workload with no accuracy bar.
      gate: measured?.result
        ? {
            verdict: measured.result.verdict ?? null,
            fail_reasons: measured.result.fail_reasons ?? [],
            not_applied: measured.result.not_applied ?? [],
          }
        : null,
      effective_input_per_m: effectiveInputRate(model, measured?.profile),
      measured_cost_per_call: perCall != null && measured.result.summary.total ? perCall : null,
      // No `measured_runs`. It counted calls that returned usage; the page's Served column counts
      // calls that returned an answer. Two definitions of "served" one field apart is how the
      // scored/total conflation started, so the page reads quality.scored over quality.total and the
      // log line below reads the same two numbers.
    });

    routeEntries.push({
      route,
      model,
      // Without this the whole Monthly column in the routes table renders as a blank: buildRouteTable
      // reads e.monthly_cost and nothing was ever putting it there, so three rows that the candidates
      // table prices to the cent appeared in the routes table as "n/a" with no explanation.
      //
      // The figure is the candidate's own measured profile at the workload's volume, which is what
      // the candidates table shows on load. A candidate with no measured run gets null, and the
      // renderer says so rather than letting the buyer's assumption stand in as an observation.
      monthly_cost: perCall != null ? perCall * callsPerMonth : null,
      measured_cost_per_call: perCall,
      extras: {
        licence: hub?.cardData?.license ?? null,
        gated: hub?.gated ?? null,
        // Carried into the route table so the cache argument can quote what was measured instead of
        // describing the mechanic in the abstract. The candidates table has had these two figures
        // all along; the routes table was written as though the measurement did not exist.
        measured: {
          effective_input_per_m: effectiveInputRate(model, measured?.profile),
          // A rate, computed the same way buildReportModel computes it. The profile carries a token
          // count, not a rate, and the route table wants the rate so it can say what was measured
          // rather than what was counted.
          cache_hit_rate: measured?.profile?.input_tokens_per_call
            ? (measured.profile.cached_input_tokens_per_call ?? 0) / measured.profile.input_tokens_per_call
            : null,
        },
      },
    });

    // The same two numbers the page's Served column shows, read from the same field, so the console
    // and the page cannot disagree about how much of the benchmark a candidate actually answered.
    const q = entries[entries.length - 1].quality;
    console.log(
      `  ${measured ? "measured" : "assumed "}    ${model.source}:${model.slug}` +
        (q ? ` (${q.scored}/${q.total} calls answered)` : "")
    );
  }

  // --- the ledger, on the buyer's incumbent ---
  const incumbent = entries.find((e) => e.incumbent) ?? entries.find((e) => e.measured);
  let ledger = null;
  if (incumbent?.measured) {
    ledger = buildLedger(incumbent.model, workload.buyer_estimate, incumbent.measured, callsPerMonth, {
      providerNote:
        incumbent.route === "A"
          ? "route A does not let the buyer pick a provider, so there was no provider decision to price"
          : null,
    });
  }

  // --- route C, the estimate that is never a price ---
  //
  // Only for a workload where some candidate is actually open-weights. Route C prices GPU time from
  // a throughput assumption that was measured on text tokens, so running it over an image workload
  // would produce a confident number built from an assumption that does not apply to the thing being
  // priced. The image workload's self-hosting story is the licence row, and the page says so.
  const hasOpenWeights = routeEntries.some((e) => e.route === "B");
  if (hasOpenWeights) {
    const est = selfHostEstimate(incumbent?.measured ?? null, { benchmarkMonthly: null });
    if (est.available) routeEntries.push({ route: "C", model: null, estimate: est });
  }

  return {
    file,
    workload,
    qualityScored,
    candidates: entries,
    ledger,
    routes: buildRouteTable(routeEntries).rows,
    benchPath,
    benchmark,
    callsPerMonth,
  };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (!conversionIsConsistent()) {
    throw new Error(
      "Unit conversion is inconsistent. Every figure in the report would be wrong by a power of a " +
        "thousand, so no report is written."
    );
  }

  const { payload, source } = await loadCatalogues();
  const catalogue = buildCatalogue(payload, payload.fetched_at);
  const summary = catalogueSummary(catalogue);

  console.log(`Cost-Route: generating the interactive report`);
  console.log(`  catalogue    ${source} (fetched ${summary.fetched_at})`);

  const built = [];
  for (const file of workloadFiles) {
    if (!fs.existsSync(path.isAbsolute(file) ? file : path.join(root, file))) {
      // A named-but-absent workload is a stated skip, not a crash: the default list includes the
      // image workload, and a checkout that has not run it yet should still produce a text page.
      console.log(`\n  workload     SKIPPED, file not found: ${file}`);
      continue;
    }
    built.push(await buildWorkload(file, catalogue));
  }

  if (built.length === 0) throw new Error("no workloads could be loaded; nothing to render");

  // The n8n canvas screenshot, embedded as a data URI when it is present. The report's closing
  // section is where the "built with n8n" claim is made, and a picture of the canvas beside that
  // claim is a different kind of statement from a sentence. An absent file renders nothing rather
  // than a broken image, so a checkout without the screenshot still produces a whole page.
  const canvasPath = path.join(root, "docs", "n8n-canvas.png");
  const n8nCanvas = fs.existsSync(canvasPath)
    ? `data:image/png;base64,${fs.readFileSync(canvasPath).toString("base64")}`
    : null;

  const model = buildReportModel({
    workloads: built.map((b) => ({
      workload: b.workload,
      candidates: b.candidates,
      ledger: b.ledger,
      routes: b.routes,
      benchmarkMeta: b.benchmark
        ? {
            run_at: b.benchmark.run_at,
            // Null on the image leg on purpose, so the page says "no golden set" rather than "0".
            items: b.benchmark.items,
            path: path.relative(root, b.benchPath),
          }
        : {},
    })),
    catalogueMeta: {
      fetched_at: summary.fetched_at,
      openrouter_models: summary.by_source.openrouter ?? null,
      huggingface_models: summary.by_source.huggingface ?? null,
      hf_provider_entries: summary.huggingface_provider_entries ?? null,
      hf_unpriced: summary.huggingface_providers_without_pricing ?? null,
    },
    generatedAt: new Date().toISOString(),
    n8nCanvas,
  });

  const html = renderReportHtml(model);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`\n  wrote        ${path.relative(root, outFile)} (${kb} KB, self-contained)`);
  for (const w of model.workloads) {
    console.log(
      `  tab          ${w.workload.name}: ${w.candidates.length} priced, ` +
        `${w.candidates.filter((c) => c.measured).length} measured` +
        `${w.quality_scored ? "" : ", not machine-scored"}`
    );
  }
  const l = model.workloads[0]?.ledger;
  console.log(
    `  ledger       ${l?.available ? `stated $${l.stated_estimate_usd} → own $${l.own_assumptions_usd.toFixed(2)} → measured $${l.measured_usd.toFixed(2)}` : "not available"}`
  );
}

main().catch((err) => {
  console.error(`\n${err.message}`);
  process.exit(1);
});
