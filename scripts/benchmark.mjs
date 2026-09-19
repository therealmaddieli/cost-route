#!/usr/bin/env node
/**
 * Cost-Route step 1, end to end: run the golden set against every candidate and apply the gate.
 *
 *   node scripts/benchmark.mjs                 # all candidates, text workload
 *   node scripts/benchmark.mjs --dry-run       # print what would be sent, spend nothing
 *   node scripts/benchmark.mjs --candidate openai/gpt-4o-mini
 *   node scripts/benchmark.mjs --items 3       # first 3 golden items only, for a cheap smoke
 *   node scripts/benchmark.mjs --workload samples/workload.image.json
 *
 * Two workload shapes, chosen by `workload_kind` in the workload file. `text` runs a golden set of
 * questions against a contract document; `image` sends one prompt and captures the pictures. They
 * differ in what gets sent and what counts as an answer, and nowhere else - the retry policy,
 * backoff, latency clock and output schema are shared, so the two legs are comparable.
 *
 * Calls run SEQUENTIALLY, on purpose. Firing them in parallel would measure the queue rather
 * than the model, and p50 latency is one of the three numbers the gate decides on. A benchmark
 * that distorts its own measurement is worth nothing.
 *
 * Every figure this prints is measured. Where a number is missing, it prints as missing rather
 * than as zero, because "we did not measure it" and "it was free" are different claims.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateCandidate, gate } from "../core/scorer.mjs";
import { captureText } from "../core/textruns.mjs";
import {
  imageRequestBody,
  imageRunRecord,
  dataUriToBytes,
  imageExtension,
  imageFileName,
  summariseImageRuns,
} from "../core/imagery.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

// ---------------------------------------------------------------------------
// environment
// ---------------------------------------------------------------------------

/** Minimal .env reader. No dependency, and it never prints a value. */
function loadEnv() {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return {};
  const out = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let value = m[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[m[1]] = value;
  }
  return { ...out, ...process.env };
}

const env = loadEnv();

const OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions";
const HF_ROUTER_CHAT = "https://router.huggingface.co/v1/chat/completions";

// ---------------------------------------------------------------------------
// args
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const option = (name) => {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1];
};

const dryRun = flag("--dry-run");
const onlyCandidate = option("--candidate");
const onlySource = option("--source");
const runAll = flag("--all");
const itemLimit = option("--items") ? Number(option("--items")) : null;

// Which workload to run. Defaults to the text one so every existing command line keeps working.
const workloadOption = option("--workload") ?? path.join("samples", "workload.legal.json");

// ---------------------------------------------------------------------------
// workload
// ---------------------------------------------------------------------------

const workloadFile = path.isAbsolute(workloadOption)
  ? workloadOption
  : path.join(root, workloadOption);
const workload = JSON.parse(fs.readFileSync(workloadFile, "utf8"));

// An image workload is a different shape, not a variant of the same one. It has no contract
// document and no golden set, because image quality is judged by a human looking at the output.
// Reading either field would throw on a file that is perfectly correct.
const isImage = workload.workload_kind === "image";

const contract = isImage ? null : fs.readFileSync(path.join(root, workload.sample_input_path), "utf8");

const goldenSet = isImage
  ? []
  : itemLimit
    ? workload.golden_set.slice(0, itemLimit)
    : workload.golden_set;

// How many times each candidate is called. The text workload asks one question per golden item.
// The image workload has no items, so it sends the same prompt twice: Day 1 measured the same
// prompt twice on gpt-5-image-mini and found prompt tokens, reasoning tokens and cost all moving
// by about 2%. A single run would let the report quote a three-decimal figure it cannot defend,
// so the second call is not redundancy, it is the only evidence for how stable the first one is.
const IMAGE_RUNS_PER_CANDIDATE = 2;
const runsPerCandidate = isImage ? IMAGE_RUNS_PER_CANDIDATE : goldenSet.length;

// The same model can appear twice on different aggregators, so a slug alone does not identify a
// candidate. --source disambiguates. Candidates flagged in_default_run:false are routes held back
// from the headline comparison on purpose, and --all is how you ask for them anyway.
const candidates = workload.candidates.filter((c) => {
  if (onlyCandidate && c.slug !== onlyCandidate) return false;
  if (onlySource && c.source !== onlySource) return false;
  if (!onlyCandidate && !runAll && c.in_default_run === false) return false;
  return true;
});

if (candidates.length === 0) {
  console.error(
    `no candidate matched --candidate ${onlyCandidate ?? "(any)"} --source ${onlySource ?? "(any)"}`
  );
  console.error(`available: ${workload.candidates.map((c) => `${c.slug} [${c.source}]`).join(", ")}`);
  process.exit(2);
}

// ---------------------------------------------------------------------------
// calling one candidate
// ---------------------------------------------------------------------------

/** Route a candidate to its endpoint, credentials and provider suffix. */
function routeFor(candidate) {
  if (candidate.source === "huggingface") {
    if (!env.HF_TOKEN) throw new Error("HF_TOKEN is not set; add it to .env");
    // The :provider suffix pins routing. Without it the router picks, and a benchmark that
    // silently compares different providers on different runs is not reproducible.
    const model = candidate.provider ? `${candidate.slug}:${candidate.provider}` : candidate.slug;
    return {
      url: HF_ROUTER_CHAT,
      headers: { Authorization: `Bearer ${env.HF_TOKEN}` },
      model,
    };
  }
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set; add it to .env");
  return {
    url: OPENROUTER_CHAT,
    headers: {
      Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      // OpenRouter attributes traffic by these two headers. Harmless, and they make the
      // dashboard readable if the spend is ever audited.
      "HTTP-Referer": "https://github.com/therealmaddieli/cost-route",
      "X-Title": "Cost-Route benchmark",
    },
    model: candidate.slug,
  };
}

/**
 * Ask one question. Returns the raw answer plus everything the cost engine will need.
 *
 * Errors are returned, never thrown. A candidate that fails every call must appear in the
 * report as failing every call; a script that dies on the first 429 would hide exactly the
 * result the buyer needs to see.
 *
 * Two lines differ between the legs: the request body, and what counts as a valid response. The
 * retry policy, the backoff schedule, the latency clock and the temperature fallback are shared,
 * because a benchmark whose transport differs between legs cannot compare them.
 */
async function askOne(route, question) {
  const body = isImage
    ? imageRequestBody({
        model: route.model,
        prompt: question,
        modalities: workload.modalities,
      })
    : {
        model: route.model,
        messages: [
          { role: "system", content: workload.answer_instruction },
          { role: "user", content: `${contract}\n\n---\n\nQuestion: ${question}` },
        ],
        temperature: 0,
        // Generous on purpose. A reasoning model spends completion tokens on hidden reasoning before
        // it writes a single visible character, and it is billed for them. At max_tokens 200, GPT-5
        // mini spent all 200 on reasoning for five of the fourteen questions and returned an empty
        // string - which the first version of this script then scored as a wrong answer. That made a
        // harness limit look like a model failure. Raising the cap, and treating an empty answer as a
        // call failure rather than an incorrect one, is what keeps the two apart.
        max_tokens: 3000,
        usage: { include: true },
      };

  const send = async (payload) =>
    fetch(route.url, {
      method: "POST",
      headers: { ...route.headers, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

  // Retry only what is worth retrying. A 429 or a 5xx is the route telling you to come back; a
  // 400 is the request being wrong and retrying it just wastes the allowance. 402 is included
  // because Hugging Face returns it as a burst rate limit wearing a billing message, which was
  // reproduced: nine consecutive calls pass, the tenth returns 402. See docs/day-2-findings.md.
  const RETRYABLE = new Set([402, 429, 500, 502, 503, 504]);
  const BACKOFF_MS = [5000, 15000, 45000];

  let attempts = 0;
  let droppedTemperature = false;
  let lastError = null;

  for (let attempt = 0; attempt <= BACKOFF_MS.length; attempt += 1) {
    attempts += 1;
    const started = Date.now();

    try {
      let res = await send(body);

      // Some reasoning models reject a temperature other than 1. Retrying without it is honest:
      // the alternative is dropping the model from the shortlist for a harness reason, not a
      // model one. Noted in the run record so the difference stays visible.
      //
      // Guarded on the body actually carrying one. An image request sends no temperature, so
      // dropping it would resend a byte-identical payload and burn an attempt learning nothing.
      if (res.status === 400 && "temperature" in body) {
        const text = await res.text();
        if (/temperature/i.test(text)) {
          const { temperature, ...rest } = body;
          void temperature;
          res = await send(rest);
          droppedTemperature = true;
        } else {
          return { latency_ms: Date.now() - started, attempts, error: `HTTP 400: ${text.slice(0, 300)}` };
        }
      }

      if (res.ok) {
        const json = await res.json();
        // The clock stops when the body has been read, not when the headers arrive.
        //
        // `send` resolves on the headers, so timing there measured time-to-first-byte and this
        // runner wrote it into a column every other instrument in the project fills with
        // time-to-complete: Day 1's image figures (40.8s, 585ms) came from curl's `time_total`, which
        // runs until the last byte. Two instruments, one column heading, and the report reads that
        // column as if it were one quantity.
        //
        // What this does *not* explain, and must not be made to: the 585ms is not a measurement
        // artifact. curl reported the same 585ms for a full 1024x1024 PNG response, twice, on two
        // different days, so a fast image run is a real observation and the header-versus-body gap is
        // not the reason for it. See docs/day-1-findings.md, where the latency column is already
        // marked unverified for that reason. How much the two clocks differ here is unmeasured - it
        // needs a paid run to find out - so this fix is made because the quantity was wrong, not
        // because it is expected to move a number.
        const latency_ms = Date.now() - started;
        // The two legs disagree about what an answer even is. Text arrives in message.content and
        // an empty one is a harness failure; an image arrives in message.images[] as base64 data
        // URIs and an empty message.content alongside it is normal, correct behaviour. Reading the
        // image response with the text rule would report both working models as producing nothing.
        return isImage
          ? imageRunRecord({ json, latency_ms, attempts, dropped_temperature: droppedTemperature })
          : captureText(json, latency_ms, attempts, droppedTemperature);
      }

      lastError = `HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`;

      if (!RETRYABLE.has(res.status)) {
        return { latency_ms: Date.now() - started, attempts, error: lastError };
      }
    } catch (err) {
      lastError = `${err.name}: ${err.message}`;
    }

    if (attempt < BACKOFF_MS.length) {
      const wait = BACKOFF_MS[attempt];
      process.stderr.write(`retry in ${Math.round(wait / 1000)}s (${lastError.slice(0, 60)}) `);
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  return { latency_ms: null, attempts, error: `${lastError} (gave up after ${attempts} attempts)` };
}

/** Where the generated images are written. Committed on purpose: `!samples/**\/*.png` covers it. */
const IMAGE_DIR = path.join(root, "samples", "images");

/**
 * Persist the images one call returned, and return just the file names.
 *
 * The base64 payload is deliberately kept out of the run record. Four PNGs inline would put
 * megabytes of text into a JSON file whose whole value is being readable and diffable, and the
 * report does not need them there: it reads the files off disk and embeds them at render time.
 */
function writeImages(candidate, runIndex, images) {
  fs.mkdirSync(IMAGE_DIR, { recursive: true });
  const written = [];

  for (const [i, dataUri] of images.entries()) {
    const decoded = dataUriToBytes(dataUri);
    // A provider that hands back a URL instead of an embedded payload is a real possibility and a
    // different finding from a model that returned nothing. Say which, rather than writing a
    // zero-byte file and calling it an image.
    if (!decoded) {
      written.push({ file: null, note: `entry ${i} was not a data URI: ${String(dataUri).slice(0, 60)}` });
      continue;
    }
    const ext = imageExtension(decoded.mime);
    const name = imageFileName(candidate.slug, runIndex, ext);
    fs.writeFileSync(path.join(IMAGE_DIR, name), decoded.bytes);
    written.push({ file: `samples/images/${name}`, mime: decoded.mime, bytes: decoded.bytes.length });
  }

  return written;
}

/** Run the whole golden set for one candidate, one question at a time. */
async function runCandidate(candidate) {
  const route = routeFor(candidate);
  const runs = [];

  if (isImage) {
    for (let i = 0; i < IMAGE_RUNS_PER_CANDIDATE; i += 1) {
      process.stderr.write(`  [${i + 1}/${IMAGE_RUNS_PER_CANDIDATE}] ${"image".padEnd(26)} `);
      const r = await askOne(route, workload.prompt);
      if (r.error) {
        process.stderr.write(`FAIL  ${r.error.slice(0, 70)}\n`);
      } else {
        const cost = r.cost == null ? "cost n/a" : `$${r.cost.toFixed(6)}`;
        process.stderr.write(
          `${String(r.latency_ms).padStart(6)}ms  ${cost.padStart(11)}  ` +
            `${String(r.image_count).padStart(2)} img  ${String(r.image_tokens ?? "?").padStart(5)} img-tok\n`
        );
      }
      // The images come out of the record before it is stored; see writeImages.
      const { images, ...rest } = r;
      runs.push({
        id: `image-run-${i + 1}`,
        question: workload.prompt,
        ...rest,
        image_files: images?.length ? writeImages(candidate, i, images) : [],
      });
    }
    return runs;
  }

  for (const [i, item] of goldenSet.entries()) {
    process.stderr.write(
      `  [${String(i + 1).padStart(2)}/${goldenSet.length}] ${item.id.padEnd(26)} `
    );
    const r = await askOne(route, item.question);
    if (r.error) {
      process.stderr.write(`FAIL  ${r.error.slice(0, 70)}\n`);
    } else {
      const cost = r.cost == null ? "cost n/a" : `$${r.cost.toFixed(6)}`;
      process.stderr.write(`${String(r.latency_ms).padStart(6)}ms  ${cost.padStart(11)}\n`);
    }
    runs.push({ id: item.id, question: item.question, ...r });
  }

  return runs;
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

const ms = (v) => (v == null ? "n/a" : `${Math.round(v)}`);
const usd = (v) => (v == null ? "n/a" : `$${v.toFixed(6)}`);
const share = (v) => (v == null ? "n/a" : `${Math.round(v * 100)}%`);

/** The one table this whole build exists to produce. Widest columns first, FAILs last. */
function printTable(results) {
  const rows = results.map((r) => ({
    candidate: r.name,
    route: r.route,
    correct: `${r.summary.correct}/${r.summary.scored}`,
    pct: share(r.summary.correct_share),
    halluc: r.summary.hallucination_count,
    hedged: r.summary.hedged_count,
    review: r.summary.needs_review.length,
    p50: ms(r.summary.latency_ms.p50),
    p95: ms(r.summary.latency_ms.p95),
    cost: usd(r.summary.measured_cost_usd),
    coverage: r.summary.cost_coverage,
    errors: r.summary.error_count,
    verdict: r.verdict,
  }));

  const cols = [
    ["candidate", "Candidate"],
    ["route", "Route"],
    ["correct", "Correct"],
    ["pct", "Share"],
    ["halluc", "Halluc"],
    ["hedged", "Hedged"],
    ["review", "Review"],
    ["p50", "p50 ms"],
    ["p95", "p95 ms"],
    ["cost", "Cost (run)"],
    ["coverage", "Cost cov."],
    ["errors", "Errors"],
    ["verdict", "Verdict"],
  ];

  const width = Object.fromEntries(
    cols.map(([k, label]) => [k, Math.max(label.length, ...rows.map((r) => String(r[k]).length))])
  );

  const line = (cells) => cells.map((c, i) => String(c).padEnd(width[cols[i][0]])).join("  ");

  console.log("");
  console.log(line(cols.map(([, label]) => label)));
  console.log(line(cols.map(([k]) => "-".repeat(width[k]))));
  for (const r of rows) console.log(line(cols.map(([k]) => r[k])));
  console.log("");
}

/**
 * The image table.
 *
 * Separate from the text one rather than a mode of it, because it has no correct-share column and
 * no hallucination column and pretending otherwise with blanks would imply a check that never ran.
 * What it has instead is the thing the image decision actually turns on: how long one call took,
 * how many image tokens it was billed for, and what that cost.
 */
function printImageTable(results) {
  const rows = results.map((r) => {
    const s = r.image_summary ?? {};
    const lat = s.latency_ms ?? {};
    return {
      candidate: r.name,
      route: r.route,
      runs: `${s.succeeded ?? 0}/${s.runs ?? 0}`,
      images: s.images_returned ?? "n/a",
      median: ms(lat.median),
      min: ms(lat.min),
      max: ms(lat.max),
      // The spread across the repeated calls, which is the reason each candidate is called twice.
      spread: lat.min != null && lat.max != null && lat.min > 0
        ? `${Math.round(((lat.max - lat.min) / lat.min) * 100)}%`
        : "n/a",
      tokens: (s.image_tokens ?? []).length ? (s.image_tokens ?? []).join(", ") : "n/a",
      cost: usd(s.measured_cost_usd),
      coverage: s.cost_coverage ?? "n/a",
      verdict: r.verdict,
    };
  });

  const cols = [
    ["candidate", "Candidate"],
    ["route", "Route"],
    ["runs", "OK"],
    ["images", "Images"],
    ["median", "Median ms"],
    ["min", "Min ms"],
    ["max", "Max ms"],
    ["spread", "Spread"],
    ["tokens", "Image tok."],
    ["cost", "Cost (run)"],
    ["coverage", "Cost cov."],
    ["verdict", "Verdict"],
  ];

  const width = Object.fromEntries(
    cols.map(([k, label]) => [k, Math.max(label.length, ...rows.map((r) => String(r[k]).length))])
  );
  const line = (cells) => cells.map((c, i) => String(c).padEnd(width[cols[i][0]])).join("  ");

  console.log("");
  console.log(line(cols.map(([, label]) => label)));
  console.log(line(cols.map(([k]) => "-".repeat(width[k]))));
  for (const r of rows) console.log(line(cols.map(([k]) => r[k])));
  console.log("");
  console.log("No quality column: this workload has no golden set, so accuracy was not measured.");
  console.log("");
}

/** Why a candidate failed, in the candidate's own numbers. Never just a red mark. */
function printFailures(results) {
  for (const r of results.filter((x) => x.verdict === "FAIL")) {
    console.log(`${r.name} - FAIL`);
    for (const reason of r.fail_reasons) console.log(`  - ${reason}`);

    for (const run of r.runs.filter((x) => x.error)) {
      console.log(`  - [CALL FAILED] ${run.id}`);
      console.log(`      ${run.error.replace(/\s+/g, " ").slice(0, 200)}`);
    }

    const wrong = r.runs.filter((x) => x.score && !x.score.correct);
    for (const run of wrong) {
      const s = run.score;
      const tag = s.hallucination ? "HALLUCINATION" : s.needs_review ? "NEEDS REVIEW" : "WRONG";
      console.log(`  - [${tag}] ${run.id}`);
      console.log(`      asked:    ${run.question}`);
      console.log(`      answered: ${String(run.answer ?? "").replace(/\s+/g, " ").slice(0, 160)}`);
      if (s.reason) console.log(`      why:      ${s.reason}`);
    }
    console.log("");
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

if (dryRun) {
  console.log(`dry run - nothing will be sent\n`);
  console.log(`workload:   ${path.relative(root, workloadFile)} (${workload.workload_kind ?? "text"})`);
  if (isImage) {
    console.log(`prompt:     "${workload.prompt}"`);
    console.log(`modalities: ${(workload.modalities ?? ["image", "text"]).join(", ")}`);
    console.log(`runs:       ${IMAGE_RUNS_PER_CANDIDATE} per candidate (same prompt each time)\n`);
  } else {
    console.log(`contract:   ${workload.sample_input_path}`);
    console.log(`contract size: ${contract.length} chars (~${Math.round(contract.length / 4)} tokens)`);
    console.log(`items:      ${goldenSet.length}`);
  }
  console.log(`monthly volume: ${workload.monthly_requests} requests\n`);
  for (const c of candidates) {
    const route = routeFor(c);
    console.log(`${c.name}`);
    console.log(`  endpoint: ${route.url}`);
    console.log(`  model:    ${route.model}`);
    console.log(
      isImage
        ? `  requests: ${IMAGE_RUNS_PER_CANDIDATE} x ~${Math.round(workload.prompt.length / 4)} prompt tokens`
        : `  requests: ${goldenSet.length} x ~${Math.round((contract.length + 200) / 4)} input tokens`
    );
    console.log("");
  }
  console.log(
    isImage ? `the prompt would be:\n  ${workload.prompt}` : `first question would be:\n  ${goldenSet[0].question}`
  );
  process.exit(0);
}

/**
 * The quality fields are not measurements on a workload with no golden set.
 *
 * `summarise` computes correct_share 0 and hallucination_count 0 out of an empty score list, which
 * is arithmetically right and reads as a verdict. "0 of 0 correct" is a claim about the pictures
 * that nobody made. `quality_scored: false` on the result is what the page keys on; nulling the
 * fields as well is so that a person opening the raw JSON sees "not measured" rather than a
 * genuine-looking zero.
 *
 * This runs after the gate, never before: the gate is the thing that decided the verdict, and it
 * needs the real numbers even when the answer is that there are none.
 */
const QUALITY_FIELDS = [
  "scored", "answered", "correct", "incorrect", "correct_share",
  "hallucination_count", "hallucinations", "needs_review",
  "hedged_count", "hedged", "by_kind",
];

function nullQuality(summary) {
  const out = { ...summary };
  for (const field of QUALITY_FIELDS) if (field in out) out[field] = null;
  return out;
}

const results = [];
for (const candidate of candidates) {
  console.log(`\n${candidate.name}  (${candidate.slug})`);
  const runs = await runCandidate(candidate);
  const result = evaluateCandidate(candidate, runs, workload.golden_set, workload);
  if (!result.quality_scored) {
    // `summarise` counts scores, and an image workload has none, so every quality field it computed
    // came from an empty list. Replace those with nulls and attach the aggregate that does describe
    // this run: how it failed, how long it took and what it cost.
    result.image_summary = summariseImageRuns(runs);
    result.summary = nullQuality(result.summary);
  }
  results.push(result);
  console.log(`  -> ${result.verdict}${result.fail_reasons.length ? `: ${result.fail_reasons.join("; ")}` : ""}`);
  for (const note of result.not_applied ?? []) console.log(`  .. ${note}`);
}

if (isImage) printImageTable(results); else printTable(results);

// The verdict is only ever as good as the bar it was measured against, so show how the answer
// moves when the bar does. A tool that reports one verdict and hides its sensitivity is asking
// to be trusted rather than checked.
//
// Gated on there being a scored result at all. An image workload has no hallucination count to
// vary, and running this over an all-null column would print a sensitivity table for a rule that
// was never applied.
{
  const maxHalluc = Math.max(0, ...results.map((r) => r.summary.hallucination_count ?? 0));
  if (maxHalluc > 0 && results.some((r) => r.quality_scored)) {
    console.log(`Sensitivity to the hallucination rule (currently allows ${workload.quality_bar.max_hallucinations}):`);
    for (let allowed = 0; allowed <= maxHalluc; allowed += 1) {
      const passed = results
        .filter(
          (r) =>
            gate(r.summary, { ...workload.quality_bar, max_hallucinations: allowed }, workload.latency_ceiling_ms)
              .verdict === "PASS"
        )
        .map((r) => r.slug.replace(/^.*\//, ""));
      console.log(
        `  allow ${allowed}: ${passed.length} of ${results.length} pass` +
          (passed.length ? `  (${passed.join(", ")})` : "")
      );
    }
    console.log("");
  }
}

// A route that needed retries is not a route that works. Say so rather than letting the green
// PASS column imply the calls sailed through.
for (const r of results) {
  const retried = r.runs.filter((x) => (x.attempts ?? 1) > 1);
  if (retried.length === 0) continue;
  const extra = retried.reduce((a, x) => a + (x.attempts - 1), 0);
  console.log(
    `${r.name}: needed ${extra} extra attempt(s) across ${retried.length} of ${r.runs.length} calls.`
  );
  for (const run of retried) console.log(`  - ${run.id}: ${run.attempts} attempts`);
  console.log("");
}

printFailures(results);

// Persist the full run so the report can cite it and the numbers can be re-checked later.
const outDir = path.join(root, "out");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outFile = path.join(outDir, `benchmark-${stamp}.json`);
fs.writeFileSync(
  outFile,
  JSON.stringify(
    {
      run_at: new Date().toISOString(),
      workload: workload.workload_name,
      // Additive for the text leg, and the only way a reader can tell the two apart without
      // inferring it from a missing golden set.
      workload_kind: workload.workload_kind ?? "text",
      workload_file: path.relative(root, workloadFile),
      // Null rather than 0 on the image leg. `items` is a golden-set count and an image workload
      // has no golden set; 0 would read as "the set was empty", which is a different and wrong
      // statement. `runs_per_candidate` is the figure that means something on both legs.
      items: isImage ? null : goldenSet.length,
      runs_per_candidate: runsPerCandidate,
      monthly_requests: workload.monthly_requests,
      quality_bar: workload.quality_bar,
      latency_ceiling_ms: workload.latency_ceiling_ms,
      results,
    },
    null,
    2
  )
);
console.log(`full run written to ${path.relative(root, outFile)}\n`);

const passed = results.filter((r) => r.verdict === "PASS").length;
console.log(`${passed} of ${results.length} candidates cleared the bar.`);
if (passed === 0) process.exitCode = 1;
