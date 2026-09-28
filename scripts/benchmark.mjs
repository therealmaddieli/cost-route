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
import { buildCatalogue, findModel } from "../core/catalogue.mjs";
import {
  captureText,
  textRequestBody,
  batchRequestBody,
  batchRuns,
  parseServerTime,
  BATCH_TERMINAL,
  BATCH_COMPLETION_WINDOW,
} from "../core/textruns.mjs";
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
// One slug, or several separated by commas. The batch leg needs the latter: it is cheapest per
// dollar to submit the whole affordable subset in one phase, and `--candidate` repeated would only
// ever match the last one.
const onlyCandidate = option("--candidate");
const onlyCandidates = onlyCandidate ? onlyCandidate.split(",").map((s) => s.trim()).filter(Boolean) : null;
const onlySource = option("--source");
const runAll = flag("--all");
const itemLimit = option("--items") ? Number(option("--items")) : null;

// The batch leg. `--batch` submits and waits; `--batch-collect <id>` picks up a batch that was
// submitted earlier (by this run or a previous one) and finishes the job. The second exists because
// the beta's 99th percentile was 10.3 hours - a submission can outlive the session that made it.
const batchMode = flag("--batch");
const batchCollect = option("--batch-collect");
// How long to wait before giving up and leaving the id on disk. Not a timeout on the batch, which
// keeps running server-side; a timeout on the sitting.
const batchWaitMinutes = option("--batch-wait") ? Number(option("--batch-wait")) : 45;

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

// The Batch API rejects base64 and `data:` URI images on every provider, and this workload sends a
// PNG inline. Refused here, before anything is submitted, rather than discovered as a batch of
// rejected requests that still cost a round trip to learn.
if ((batchMode || batchCollect) && isImage) {
  console.error(
    "an image workload has no batch leg: the Batch API rejects base64 and data: URI images on every provider."
  );
  process.exit(2);
}

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
  if (onlyCandidates && !onlyCandidates.includes(c.slug)) return false;
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
    : // Shared with the batch leg rather than built here. See textRequestBody in core/textruns.mjs:
      // the batch leg sends this same body, and two copies of it is how the legs drift apart.
      textRequestBody({
        model: route.model,
        answerInstruction: workload.answer_instruction,
        contract,
        question,
      });

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
// the batch leg
// ---------------------------------------------------------------------------

/**
 * The Batch API, as a second way to run the *same* golden set.
 *
 *   node scripts/benchmark.mjs --batch
 *   node scripts/benchmark.mjs --batch-collect <batch_id>
 *
 * Everything downstream of the runs is shared with the synchronous leg: the batch produces the same
 * `{ id, question, ...capture }` records, so scoring, the gate and the tables do not know which leg
 * they are reading. That is the whole design - one comparison, two transports.
 *
 * Three things are genuinely different and are called out where they bite:
 *   1. Submission is asynchronous, and the beta's 99th percentile was 10.3 hours. A blocking wait is
 *      not viable, so the batch id is written to disk on the `202` and the collect step is
 *      re-runnable against it.
 *   2. There is no per-request latency. See `batchRuns` in core/textruns.mjs.
 *   3. `usage.cost` on the completed batch is the bill for the whole batch, and is the authority.
 *      The per-run costs sum to our explanation of it, not the other way round.
 */

const BATCH_URL = "https://openrouter.ai/api/v1/batches";
const BATCH_DIR = path.join(root, "out");

/** Batch ids are opaque. This keeps one out of a path traversal without guessing its shape. */
const batchStoreFile = (id) => path.join(BATCH_DIR, `batch-${String(id).replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

/**
 * Which candidates can be batched at all, answered from the saved catalogue before anything is sent.
 *
 * The docs are explicit: "A submit for a model with no `:batch` endpoint returns `400`." The
 * catalogue already lists every `:batch` endpoint as an entry, so eligibility is knowable for free,
 * and learning it by submission costs a round trip to be told what a cached file already said.
 *
 * Returns null when there is no saved catalogue. That is not a failure - the catalogue is a cache and
 * the API is the authority - so the run proceeds unchecked rather than refusing to start. Guessing
 * "eligible" would be worse than the 400 the API returns, which at least names the real reason.
 */
function batchEligibility(candidate) {
  const cache = path.join(BATCH_DIR, "catalogue-latest.json");
  if (!fs.existsSync(cache)) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(cache, "utf8"));
    const catalogue = buildCatalogue(
      { openrouter: payload.openrouter, huggingface: payload.huggingface },
      payload.fetched_at
    );
    // Looked up source-scoped: a dual-listed model resolves to the Hugging Face entry on the bare
    // key, and an HF entry never carries an OpenRouter batch card.
    const model = findModel(catalogue, candidate.slug, "openrouter");
    if (!model) return { eligible: null, reason: `${candidate.slug} is not in the saved catalogue` };
    if (!model.batch_variant) {
      return {
        eligible: false,
        reason: `no :batch endpoint for ${candidate.slug}, so the submit would return 400`,
      };
    }
    return { eligible: true, batch_slug: model.batch_variant.slug };
  } catch (err) {
    return { eligible: null, reason: `catalogue could not be read (${err.message})` };
  }
}

/** OpenRouter's batch headers. Same attribution as the sync calls, so the spend is one story. */
function batchHeaders() {
  if (!env.OPENROUTER_API_KEY) throw new Error("OPENROUTER_API_KEY is not set; add it to .env");
  return {
    Authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
    "Content-Type": "application/json",
    "HTTP-Referer": "https://github.com/therealmaddieli/cost-route",
    "X-Title": "Cost-Route benchmark",
  };
}

/** Write the batch record, and never print the key it was submitted with. */
function persistBatch(record) {
  fs.mkdirSync(BATCH_DIR, { recursive: true });
  fs.writeFileSync(batchStoreFile(record.batch_id), JSON.stringify(record, null, 2) + "\n");
}

/**
 * Submit one batch for one candidate and persist its id before anything else happens.
 *
 * The persistence order matters: the id is written the moment the `202` lands, so a run that is
 * interrupted mid-poll can still be collected. A batch that has been paid for but whose id was only
 * ever in the terminal's scrollback is money spent for nothing.
 */
async function submitBatch(candidate, items, batchSlug) {
  const payload = batchRequestBody({
    // The `:batch` model id, NOT the base slug. The quickstart's example payloads show the base slug
    // ("model": "openai/gpt-4o"), and submitting that is rejected: a live submit on 2026-09-28
    // returned `400 {"error":{"message":"Model 'openai/gpt-4o-mini' does not have a :batch
    // endpoint."}}`. The docs and the API disagree here and the API is the one that answers, which is
    // the whole reason this leg was run against the live service rather than reasoned about.
    model: batchSlug ?? candidate.slug,
    items,
    answerInstruction: workload.answer_instruction,
    contract,
    provider: workload.batch?.provider ?? null,
    completionWindow: workload.batch?.completion_window ?? BATCH_COMPLETION_WINDOW,
  });

  // The order check, made explicit. `JSON.stringify` preserves insertion order, so this is a real
  // guard and not a comment: if a refactor ever puts `requests` first the API returns 400, and it is
  // better to fail here with a readable message than to spend a round trip finding out.
  const keys = Object.keys(payload);
  if (keys[keys.length - 1] !== "requests") {
    throw new Error(
      `batch payload key order is ${keys.join(", ")}; OpenRouter requires 'requests' last and returns 400 otherwise`
    );
  }

  const res = await fetch(BATCH_URL, { method: "POST", headers: batchHeaders(), body: JSON.stringify(payload) });

  if (!res.ok) {
    const text = await res.text();
    // 402 here is the sync leg's 402 wearing different clothes: no credit, come back later. Say
    // which, because the two call for different responses from the person reading it.
    throw new Error(`batch submit failed: HTTP ${res.status} ${text.slice(0, 400)}`);
  }

  const batch = await res.json();
  const record = {
    batch_id: batch.id,
    submitted_at: new Date().toISOString(),
    workload: workload.workload_name,
    workload_kind: workload.workload_kind ?? "text",
    workload_file: path.relative(root, workloadFile),
    candidate: { name: candidate.name, slug: candidate.slug, route: candidate.route, source: candidate.source },
    // What was asked, so a partial result can be read against the question set even if the batch is
    // never collected.
    request_ids: items.map((i) => i.id),
    request_count: items.length,
    model: batch.model ?? candidate.slug,
    completion_window: batch.completion_window ?? null,
    status_at_submit: batch.status ?? null,
    status: batch.status ?? null,
    // Filled in by the poll. Null means "not known yet", never zero.
    submit_to_terminal_ms: null,
    terminal_at: null,
    request_counts: batch.request_counts ?? null,
    usage: null,
  };
  persistBatch(record);

  console.log(`  submitted ${batch.id}  (${items.length} requests, status ${batch.status ?? "?"})`);
  console.log(`  id persisted to ${path.relative(root, batchStoreFile(batch.id))} - this run is resumable`);
  return record;
}

/**
 * Poll one batch until it reaches a terminal state or the shared deadline passes.
 *
 * The deadline is absolute, not a per-batch duration, because several batches are polled in one
 * run: a per-batch budget would let the first slow batch consume the whole sitting. It bounds the
 * waiting, never the batch - a batch that outlives the deadline keeps running server-side and its id
 * is on disk.
 */
async function pollBatch(record, deadline) {
  let last = null;
  let consecutiveFailures = 0;

  for (;;) {
    // A poll that dies on one failed request is worse than useless: it throws away a paid-for batch
    // that is still running perfectly well server-side. This is a long-running loop over a
    // multi-hour queue, so transient network failures are expected rather than exceptional, and they
    // are absorbed. The first version of this threw, and a single connect timeout killed a run whose
    // batches were both still in progress.
    let batch;
    try {
      const res = await fetch(`${BATCH_URL}/${record.batch_id}`, { headers: batchHeaders() });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      batch = await res.json();
      consecutiveFailures = 0;
    } catch (err) {
      consecutiveFailures += 1;
      // Only give up on the sitting, never on the batch: the id is on disk and the job keeps running.
      // The threshold exists so a genuinely wrong id or a revoked key still terminates.
      if (consecutiveFailures >= 5) {
        record.status = `${record.status ?? "unknown"}(poll gave up: ${err.message})`;
        persistBatch(record);
        return { batch: null, record, timedOut: true };
      }
      process.stderr.write(`poll error ${consecutiveFailures}/5 (${err.message.slice(0, 50)}), retrying `);
      await new Promise((r) => setTimeout(r, 15000));
      continue;
    }

    const status = batch.status ?? "?";
    const counts = batch.request_counts ?? {};
    const line = `${String(counts.completed ?? 0)}/${counts.total ?? record.request_count} done, ${counts.failed ?? 0} failed`;

    if (status !== last) {
      console.log(`  ${status.padEnd(12)} ${line}`);
      last = status;
    }

    if (BATCH_TERMINAL.has(status)) {
      record.status = status;
      record.terminal_at = new Date().toISOString();
      // The API's own `finalized_at`, not the clock in this process. `Date.now() - started` was
      // measuring how long THIS POLL took, which on a resume against an already-terminal batch is a
      // few hundred milliseconds - so a batch that sat in the queue for thirteen minutes was
      // reported, and captioned on the page, as taking 0.35s. The one timing fact this leg has was
      // silently the wrong one.
      //
      // And `finalized_at` is not the ISO string it looks like: the API sends epoch SECONDS, the
      // same shape as `created_at` (which is why the batch id embeds it). `Date.parse` answers NaN
      // for a bare number, so the first version of this fix read the server's timestamp, failed to
      // parse it, and fell back to the poll clock it was written to replace - reporting 0.30h for a
      // batch the server finalised in 0.12h, while the caption said "server finalized_at". The
      // fallback hid the parse failure instead of surfacing it, which is the whole reason the number
      // has a source string attached.
      const finalized = parseServerTime(batch.finalized_at);
      const submitted = Date.parse(record.submitted_at);
      record.timing_source = Number.isFinite(finalized)
        ? "server finalized_at"
        : "observed, which is an upper bound: the batch may have finished before this poll saw it";
      record.submit_to_terminal_ms = Number.isFinite(finalized)
        ? Math.max(0, finalized - submitted)
        : Date.now() - submitted;
      record.request_counts = batch.request_counts ?? null;
      record.usage = batch.usage ?? null;
      record.results = Array.isArray(batch.results) ? batch.results : null;
      record.error = batch.error ?? null;
      persistBatch(record);
      return { batch, record };
    }

    if (Date.now() > deadline) {
      record.status = status;
      persistBatch(record);
      return { batch, record, timedOut: true };
    }

    await new Promise((r) => setTimeout(r, 15000));
  }
}

/**
 * Turn a terminal batch into run records, and say what could not be accounted for.
 *
 * Returns the runs whatever happens, including on a batch that failed or expired, because a batch
 * that produced nothing is a result the report has to be able to show. Reporting it as a missing
 * row would be the tool hiding a failure it paid for.
 */
function runsFromBatch(batch, items) {
  const questionsById = new Map(items.map((i) => [i.id, i.question]));
  const { runs, failed } = batchRuns(batch);

  const withQuestion = runs.map((r) => ({ ...r, question: questionsById.get(r.id) ?? null }));

  // Anything that was asked for and is not in the results. A completed batch should return one
  // result per request; if it does not, the shortfall is named rather than absorbed into the
  // correct-share denominator.
  const returned = new Set(runs.map((r) => r.id));
  const missing = items.map((i) => i.id).filter((id) => !returned.has(id));

  return { runs: withQuestion, failed, missing };
}

/**
 * The one note the batch leg has to attach, because the gate cannot notice the absence itself.
 *
 * `gate` skips the latency ceiling when p50 is null, which is right - there is nothing to compare.
 * But a PASS that never ran a check looks exactly like a PASS that passed one, and the difference is
 * the whole point of this project. So the leg says so in the field the report already renders for
 * "which checks could not run".
 */
function batchNotApplied(record) {
  const hours = record.submit_to_terminal_ms == null ? null : (record.submit_to_terminal_ms / 3600000).toFixed(2);
  return (
    `the ${workload.latency_ceiling_ms}ms p50 latency ceiling did not run on this leg: the Batch API ` +
    `exposes no per-request latency, so there is no p50 to hold against it and no latency check was applied. ` +
    `The only timing fact measured is submit-to-terminal` +
    (hours ? `, ${hours}h for this batch` : "") +
    `, which is a property of the queue and not of the model.`
  );
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
    if (batchMode) {
      // The pre-check, before any of it is paid for. A candidate the catalogue has no `:batch`
      // endpoint for is skipped by the live run, and the dry run is where that should first be seen.
      const eligible = batchEligibility(c);
      console.log(
        eligible?.eligible === false
          ? `  batch:    SKIP - ${eligible.reason}`
          : eligible?.eligible === true
            ? `  batch:    ok (${eligible.batch_slug})`
            : `  batch:    unchecked - ${eligible?.reason ?? "no saved catalogue"}`
      );
    }
    console.log("");
  }
  if (batchMode) {
    // Show the submission shape without making one. The key order is the part that earns a 400 if it
    // is ever wrong, so a dry run that printed only the model would be skipping the risky half.
    const payload = batchRequestBody({
      model: candidates[0].slug,
      items: goldenSet,
      answerInstruction: workload.answer_instruction,
      contract,
      provider: workload.batch?.provider ?? null,
      completionWindow: workload.batch?.completion_window ?? BATCH_COMPLETION_WINDOW,
    });
    console.log(`transport:  batch (asynchronous, one submission per candidate)`);
    console.log(`  submit:   POST ${BATCH_URL}`);
    console.log(`  poll:     GET  ${BATCH_URL}/:id`);
    console.log(`  payload keys, in order: ${Object.keys(payload).join(", ")}`);
    console.log(`  requests: ${payload.requests.length}, custom_id = the golden-set item id`);
    console.log(`  first request body:`);
    console.log(`    ${JSON.stringify(payload.requests[0].body).slice(0, 220)}...`);
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

/**
 * Resume a batch that was submitted earlier, and run it through the same scoring as any other.
 *
 * This is the path that makes the session's risk survivable: if the batch had not finished when the
 * first run gave up, this reads the stored id, polls it to a terminal state, and produces exactly
 * the benchmark file the original run would have written.
 */
async function collectStoredBatches(batchIds) {
  const collected = [];
  const unfinished = [];

  // Slugs a collected or in-flight batch covers, so the skip report at the bottom neither
  // double-counts a candidate that ran nor buries one the API refused.
  const covered = new Set();

  for (const batchId of batchIds) {
    const file = batchStoreFile(batchId);
    if (!fs.existsSync(file)) {
      console.error(`no stored batch record at ${path.relative(root, file)}`);
      console.error(
        `stored batches: ${
          fs.existsSync(BATCH_DIR)
            ? fs.readdirSync(BATCH_DIR).filter((f) => f.startsWith("batch-")).join(", ") || "(none)"
            : "(none)"
        }`
      );
      process.exit(2);
    }

    const record = JSON.parse(fs.readFileSync(file, "utf8"));
    const items = workload.golden_set.filter((i) => record.request_ids.includes(i.id));

    console.log(`\n${record.candidate.name}  (${record.candidate.slug})`);
    console.log(`  resuming ${record.batch_id}, submitted ${record.submitted_at}, last seen ${record.status ?? "?"}`);

    const { batch, record: updated, timedOut } = await pollBatch(
      record,
      Date.now() + batchWaitMinutes * 60_000
    );

    if (timedOut) {
      console.log(`  still ${updated.status}; nothing was lost and the id is on disk`);
      unfinished.push(updated);
      continue;
    }

    console.log(`  terminal: ${updated.status}`);
    if (updated.usage?.cost != null) {
      console.log(`  measured batch cost: $${Number(updated.usage.cost).toFixed(6)} (usage.cost, the authority)`);
    }

    const { runs, failed, missing } = runsFromBatch(batch, items);
    if (failed.length) console.log(`  ${failed.length} request(s) failed inside the batch`);
    if (missing.length) console.log(`  ${missing.length} request(s) never came back: ${missing.join(", ")}`);

    // Reconstruct the candidate from the workload, so a resumed run is scored against the same
    // shortlist entry as the original - not a hand-built stand-in.
    const candidate = workload.candidates.find((c) => c.slug === record.candidate.slug) ?? record.candidate;
    const result = evaluateCandidate(candidate, runs, workload.golden_set, workload);
    result.not_applied = [...(result.not_applied ?? []), batchNotApplied(updated)];
    result.batch = batchMetadata(updated);

    console.log(`  -> ${result.verdict}${result.fail_reasons.length ? `: ${result.fail_reasons.join("; ")}` : ""}`);
    for (const note of result.not_applied) console.log(`  .. ${note}`);
    collected.push(result);
    covered.add(record.candidate.slug);
  }

  // The candidates this workload has that no batch covers, and why.
  //
  // A resumed collect never runs the submit phase, so without this the run file it writes carries no
  // skip record at all - and that file is the only place the report can learn that a candidate with
  // a perfectly good published `:batch` card was refused by the API when it was submitted. The
  // finding would survive only in the console of a run that has already scrolled away. Batches that
  // are merely still in flight are excluded: unfinished is not skipped.
  const inFlight = new Set(unfinished.map((r) => r.candidate?.slug).filter(Boolean));
  for (const c of workload.candidates ?? []) {
    if (!c?.slug || covered.has(c.slug) || inFlight.has(c.slug)) continue;
    const eligible = batchEligibility(c);
    skipped.push({
      candidate: c.slug,
      reason:
        eligible.eligible === true
          ? "no batch was submitted for this candidate, and no stored batch covers it"
          : eligible.reason,
    });
  }

  // Written when there is anything to say, not only when a batch came back. A collect where every
  // candidate was refused has no results and one important finding - which model's published batch
  // card the API will not sell - and suppressing the file would throw that away as the collected
  // half being empty. Only a run with neither results nor skips has nothing to record.
  if (collected.length || skipped.length) {
    if (collected.length) printTable(collected);
    writeRunFile(collected, workload.golden_set.length);
  }
  if (unfinished.length) {
    console.log(`${unfinished.length} batch(es) still running. Collect again with:`);
    for (const r of unfinished) console.log(`  node scripts/benchmark.mjs --batch-collect ${r.batch_id}`);
    console.log("");
    process.exitCode = 3;
  }
  return collected;
}

/** What the batch leg measured, kept in its own block so it cannot be read as a per-call figure. */
function batchMetadata(record) {
  return {
    batch_id: record.batch_id,
    status: record.status,
    submitted_at: record.submitted_at,
    terminal_at: record.terminal_at ?? null,
    // Submit-to-terminal, never presented as latency. It measures the queue, not the model. The
    // source travels with it, because "the server said when it finished" and "we looked and it was
    // already done" are different qualities of the same number.
    submit_to_terminal_ms: record.submit_to_terminal_ms ?? null,
    timing_source: record.timing_source ?? null,
    request_counts: record.request_counts ?? null,
    // The bill for the whole batch, from OpenRouter. This is the authority for the async route.
    batch_cost_usd: record.usage?.cost ?? null,
    batch_tokens: record.usage
      ? { prompt: record.usage.prompt_tokens ?? null, completion: record.usage.completion_tokens ?? null }
      : null,
    is_byok: record.usage?.is_byok ?? null,
    error: record.error ?? null,
    // There is no per-request cost in a batch: the API returns `usage` per result with no `cost`
    // field, so `captureText` records null for every run and `measured_cost_per_call` is null by
    // construction. The only real figure is the batch total, and dividing it is an ALLOCATION, not
    // a measurement - so it is named one here and carried with its own source string rather than
    // being passed off as a per-call price the API never reported.
    cost_per_call_allocated_usd:
      record.usage?.cost != null && record.request_counts?.completed
        ? record.usage.cost / record.request_counts.completed
        : null,
    cost_source: "allocated: batch usage.cost / requests completed",
  };
}

/** Candidates the batch leg could not run, and why. Reported, never silently dropped. */
const skipped = [];

if (batchCollect) {
  // Several ids at once, comma-separated: a run that submitted three batches has three to collect,
  // and collecting them one command at a time re-serialises the waiting the submit phase avoided.
  await collectStoredBatches(batchCollect.split(",").map((s) => s.trim()).filter(Boolean));
  process.exit(process.exitCode ?? 0);
}

const results = [];

/**
 * Phase one of the batch leg: submit every eligible candidate BEFORE polling any of them.
 *
 * The Batch API is asynchronous and the beta's 99th percentile was 10.3 hours, so batches submitted
 * one-at-a-time-and-awaited would take the sum of their queue times. They are independent jobs, so
 * they are submitted together and awaited together, and the run costs the slowest queue rather than
 * the total. This is the difference between a run that can plausibly finish today and one that
 * cannot.
 */
async function submitAll() {
  const pending = [];
  for (const candidate of candidates) {
    console.log(`\n${candidate.name}  (${candidate.slug})`);

    // Checked against the catalogue before submitting. A candidate with no `:batch` endpoint cannot
    // be batched at any price, and the API's answer to trying is a 400 - so the skip is a fact about
    // the catalogue, reported as such, rather than a failure.
    const eligible = batchEligibility(candidate);
    if (eligible?.eligible === false) {
      console.log(`  SKIPPED - ${eligible.reason}`);
      console.log(`  this candidate is priced and scored on the synchronous leg only; nothing is missing`);
      skipped.push({ candidate: candidate.slug, reason: eligible.reason });
      continue;
    }
    if (eligible?.eligible === null) console.log(`  note: ${eligible.reason}; submitting unchecked`);

    // One batch per candidate: the Batch API takes a single model per submission, chosen at submit
    // with no fallback, so a batch cannot span the shortlist.
    //
    // A rejected submission is reported and skipped, never thrown. The other candidates' batches are
    // independent, and one model that cannot be batched is not a reason to abandon the run that was
    // going to measure the others - the same rule the per-call path follows.
    try {
      pending.push({ candidate, record: await submitBatch(candidate, goldenSet, eligible?.batch_slug) });
    } catch (err) {
      console.log(`  SUBMIT FAILED - ${err.message}`);
      skipped.push({ candidate: candidate.slug, reason: err.message });
    }
  }
  return pending;
}

/** Phase two: poll everything submitted, under one deadline, then score. */
async function collectAll(pending) {
  const deadline = Date.now() + batchWaitMinutes * 60_000;
  const collected = [];
  const stillRunning = [];

  for (const { candidate, record } of pending) {
    console.log(`\n${candidate.name}  (${candidate.slug})`);
    const { batch, record: updated, timedOut } = await pollBatch(record, deadline);

    if (timedOut) {
      console.log(`  still ${updated.status}; nothing was lost and the id is on disk`);
      stillRunning.push(updated);
      continue;
    }

    console.log(`  terminal: ${updated.status}`);
    if (updated.usage?.cost != null) {
      console.log(`  measured batch cost: $${Number(updated.usage.cost).toFixed(6)} (usage.cost, the authority)`);
    }

    const { runs, failed, missing } = runsFromBatch(batch, goldenSet);
    if (failed.length) console.log(`  ${failed.length} request(s) failed inside the batch`);
    if (missing.length) console.log(`  ${missing.length} request(s) never came back: ${missing.join(", ")}`);

    const result = evaluateCandidate(candidate, runs, workload.golden_set, workload);
    // The gate cannot see that the latency check did not run, so the leg says so itself.
    result.not_applied = [...(result.not_applied ?? []), batchNotApplied(updated)];
    result.batch = batchMetadata(updated);

    console.log(`  -> ${result.verdict}${result.fail_reasons.length ? `: ${result.fail_reasons.join("; ")}` : ""}`);
    for (const note of result.not_applied) console.log(`  .. ${note}`);
    collected.push(result);
  }

  return { collected, stillRunning };
}

if (batchMode) {
  const pending = await submitAll();
  if (pending.length === 0) {
    console.error(
      `\nno candidate has a :batch endpoint, so there is nothing to submit. ` +
        `The synchronous leg is unaffected: node scripts/benchmark.mjs`
    );
    process.exit(2);
  }

  console.log(`\n${pending.length} batch(es) submitted. Waiting up to ${batchWaitMinutes} minutes in total.\n`);
  const { collected, stillRunning } = await collectAll(pending);
  results.push(...collected);

  if (stillRunning.length) {
    console.log(`\n${stillRunning.length} batch(es) had not finished. They are running server-side; nothing is lost.`);
    console.log(`Collect them with:`);
    for (const r of stillRunning) console.log(`  node scripts/benchmark.mjs --batch-collect ${r.batch_id}`);
    console.log("");
  }

  if (collected.length) {
    printTable(collected);
    writeRunFile(collected, goldenSet.length);
  }
  process.exit(results.some((r) => r.verdict === "FAIL") ? 1 : 0);
}

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

/**
 * Persist the full run so the report can cite it and the numbers can be re-checked later.
 *
 * Shared by the live path and the resume path, because a resumed batch has to produce the same file
 * the original run would have - otherwise the report has two shapes of benchmark to read and the
 * resumed one is the shape nobody tested.
 */
function writeRunFile(results, itemCount) {
  const outDir = path.join(root, "out");
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = path.join(outDir, `benchmark-${stamp}.json`);
  fs.writeFileSync(
    outFile,
    JSON.stringify(
      {
        run_at: new Date().toISOString(),
        // Which transport produced these runs. Without it the report cannot tell a synchronous run
        // from a batch one, and the latency columns mean different things on each.
        run_mode: batchMode || batchCollect ? "batch" : "sync",
        workload: workload.workload_name,
        // Additive for the text leg, and the only way a reader can tell the two apart without
        // inferring it from a missing golden set.
        workload_kind: workload.workload_kind ?? "text",
        workload_file: path.relative(root, workloadFile),
        // Null rather than 0 on the image leg. `items` is a golden-set count and an image workload
        // has no golden set; 0 would read as "the set was empty", which is a different and wrong
        // statement. `runs_per_candidate` is the figure that means something on both legs.
        items: isImage ? null : itemCount,
        runs_per_candidate: runsPerCandidate,
        monthly_requests: workload.monthly_requests,
        quality_bar: workload.quality_bar,
        latency_ceiling_ms: workload.latency_ceiling_ms,
        // Candidates the batch leg could not run. On disk rather than only on stdout, because "why
        // is this candidate missing from the batch comparison" is a question asked days later.
        ...(skipped.length ? { batch_skipped: skipped } : {}),
        results,
      },
      null,
      2
    )
  );
  console.log(`full run written to ${path.relative(root, outFile)}\n`);
  return outFile;
}

writeRunFile(results, goldenSet.length);

const passed = results.filter((r) => r.verdict === "PASS").length;
console.log(`${passed} of ${results.length} candidates cleared the bar.`);
if (passed === 0) process.exitCode = 1;
