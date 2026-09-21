/**
 * Builds workflow.json for the Cost-Route n8n workflow.
 *
 * Not part of the published artifact: the workflow JSON is the source of truth once imported, and
 * this script exists so the JSON can be regenerated deterministically while it is authored.
 *
 * The workload is NOT baked into the pipeline. A customer supplies it through the Form Trigger or
 * the Webhook Trigger, one node validates and canonicalises it, and every downstream node reads it
 * from the data. The only embedded workload is the bundled sample the Manual Trigger runs, so the
 * demo still works in one click.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const legal = JSON.parse(fs.readFileSync(path.join(root, "samples/workload.legal.json"), "utf8"));
const contract = fs.readFileSync(path.join(root, legal.sample_input_path), "utf8");

/**
 * The bundled demo workload, and the only workload literally present in the file.
 *
 * It exists so the Manual Trigger path runs without any setup. It is a default, not the interface:
 * a customer's own contract, questions, criteria and shortlist arrive through the form or the
 * webhook and never touch this object.
 */
const SAMPLE_WORKLOAD = {
  workload_name: legal.workload_name,
  workload_kind: legal.workload_kind,
  task_description: legal.task_description,
  answer_instruction: legal.answer_instruction,
  contract,
  prompt: null,
  golden_set: legal.golden_set,
  quality_bar: legal.quality_bar,
  latency_ceiling_ms: legal.latency_ceiling_ms,
  monthly_requests: legal.monthly_requests,
  buyer_estimate: legal.buyer_estimate,
  candidates: legal.candidates
    .filter((c) => c.in_default_run !== false)
    .map((c) => ({
      name: c.name,
      slug: c.slug,
      source: c.source,
      route: c.route,
      provider: c.provider ?? null,
      incumbent: !!c.incumbent,
    })),
};

// The two API endpoints are infrastructure, not customer input, so they stay in the code that calls
// them rather than travelling with the workload.
const ENDPOINTS_SRC = `const ENDPOINTS = ${JSON.stringify({
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
  huggingface: "https://router.huggingface.co/v1/chat/completions",
})};\n`;

// ---------------------------------------------------------------------------
// node code
// ---------------------------------------------------------------------------

const CODE_NORMALISE = `// The one place a customer's workload is read and validated. Three entry points reach this node -
// the form, the webhook and the bundled sample - and each arrives in a slightly different shape, so
// the unwrapping happens here and nowhere else. Everything downstream reads the canonical object
// this node emits, which is why no shortlist, contract, quality bar or volume is baked into any
// later node.
const firstItem = $input.first();
const rawItem = (firstItem && firstItem.json) ? firstItem.json : {};

// Unwrap the wrappers n8n adds: {workload: ...} from the sample node, {body: ...} from a webhook.
let raw = rawItem;
if (raw.workload && typeof raw.workload === "object") raw = raw.workload;
else if (raw.body && typeof raw.body === "object") raw = raw.body;

function firstOf(names) {
  for (const n of names) if (raw[n] !== undefined && raw[n] !== null && raw[n] !== "") return raw[n];
  return undefined;
}
function asJson(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch (e) { throw new Error(label + " is not valid JSON: " + e.message); }
}
function num(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const n = Number(value);
  return isFinite(n) ? n : fallback;
}
function pick(flatName, nested, nestedKey, fallback) {
  const flat = firstOf([flatName]);
  if (flat !== undefined) return num(flat, fallback);
  if (nested && nested[nestedKey] !== undefined) return num(nested[nestedKey], fallback);
  return fallback;
}

const nestedBar = (raw.quality_bar && typeof raw.quality_bar === "object") ? raw.quality_bar : {};
const nestedBuyer = (raw.buyer_estimate && typeof raw.buyer_estimate === "object") ? raw.buyer_estimate : {};
const kind = String(firstOf(["workload_kind", "kind"]) || "text").toLowerCase();

const workload = {
  workload_name: String(firstOf(["workload_name", "name"]) || "Untitled workload"),
  workload_kind: kind === "image" ? "image" : "text",
  task_description: String(firstOf(["task_description", "task"]) || ""),
  answer_instruction: String(firstOf(["answer_instruction"]) || "Answer the question in ONE short sentence. State the figure or provision directly. Do not explain your reasoning."),
  contract: (function () { const c = firstOf(["contract", "contract_text", "sample_input"]); return c == null ? null : String(c); })(),
  prompt: (function () { const p = firstOf(["prompt"]); return p == null ? null : String(p); })(),
  golden_set: asJson(firstOf(["golden_set", "goldenSet"]), "golden_set") || [],
  candidates: asJson(firstOf(["candidates", "shortlist"]), "candidates") || [],
  quality_bar: {
    min_correct_share: pick("min_correct_share", nestedBar, "min_correct_share", 0.75),
    max_hallucinations: pick("max_hallucinations", nestedBar, "max_hallucinations", 0),
  },
  latency_ceiling_ms: pick("latency_ceiling_ms", raw, "latency_ceiling_ms", 15000),
  monthly_requests: pick("monthly_requests", raw, "monthly_requests", 1000),
  buyer_estimate: {
    assumed_input_tokens_per_request: pick("assumed_input_tokens_per_request", nestedBuyer, "assumed_input_tokens_per_request", 1500),
    assumed_output_tokens_per_request: pick("assumed_output_tokens_per_request", nestedBuyer, "assumed_output_tokens_per_request", 50),
    assumed_cost_per_month_usd: (function () {
      const flat = firstOf(["assumed_cost_per_month_usd"]);
      const v = flat !== undefined ? flat : nestedBuyer.assumed_cost_per_month_usd;
      return (v === undefined || v === null || v === "") ? null : num(v, null);
    })(),
  },
};

// Validate, and say which field is wrong. A form submission that fails silently, or with a stack
// trace, is worse than one that names the missing input.
const problems = [];
if (!workload.candidates.length) problems.push("candidates: supply at least one {name, slug, source, route}");
if (workload.workload_kind === "image") {
  if (!workload.prompt) problems.push("prompt: an image workload needs the exact prompt to send");
} else {
  if (!workload.golden_set.length) problems.push("golden_set: a text workload needs questions with known answers");
  if (!workload.contract) problems.push("contract: a text workload needs the document to review");
}
if (workload.candidates.some(function (c) { return !c || !c.slug || !c.source; })) {
  problems.push("candidates: every entry needs a slug and a source (openrouter or huggingface)");
}
if (problems.length) throw new Error("workload rejected - " + problems.join("; "));

// Fill the defaults a customer should not have to think about.
workload.candidates = workload.candidates
  .filter(function (c) { return c && c.slug && c.source; })
  .map(function (c) {
    return {
      name: c.name || c.slug,
      slug: c.slug,
      source: c.source,
      route: c.route || (c.source === "huggingface" ? "B" : "A"),
      provider: c.provider || null,
      incumbent: !!c.incumbent,
    };
  });

return [{ json: { workload: workload } }];`;

const CODE_SAMPLE = `// The bundled demo workload, so the Manual Trigger runs in one click with no setup. It is a
// default, not the interface: the form and the webhook are how a customer supplies their own.
return [{ json: { workload: ${JSON.stringify(SAMPLE_WORKLOAD)} } }];`;

const CODE_PLAN = `// Merge both catalogues, normalise every rate to USD per 1M tokens in this one place, validate the
// shortlist against what the catalogues actually publish, then explode one item per call to make.
// The workload itself arrives as an item from the normaliser, not from this file.
${ENDPOINTS_SRC}
const all = $input.all();
let workload = null;
for (const it of all) {
  const d = it.json;
  if (d && d.workload && d.workload.candidates) { workload = d.workload; break; }
}
if (!workload) throw new Error("no workload reached the planning node; it should arrive from the form, the webhook or the sample node");

let orCatalog = null;
let hfCatalog = null;
for (const it of all) {
  const d = it.json;
  const arr = Array.isArray(d) ? d : (d && d.data ? d.data : []);
  if (!arr.length) continue;
  const first = arr[0];
  if (first && first.providers) hfCatalog = arr;
  else if (first && first.pricing && typeof first.pricing.prompt === "string") orCatalog = arr;
}
const perM = function (s) {
  return s === undefined || s === null || s === "" ? null : Number(s) * 1e6;
};
const orBySlug = {};
for (const m of (orCatalog || [])) orBySlug[m.id] = m;
const hfBySlug = {};
for (const m of (hfCatalog || [])) hfBySlug[m.id] = m;

function lookup(c) {
  if (c.source === "openrouter") {
    const m = orBySlug[c.slug];
    if (!m) return { ok: false, reason: "not in the OpenRouter catalogue (renamed or withdrawn)" };
    const p = m.pricing || {};
    const tier = (p.overrides || [])[0] || null;
    return {
      ok: true, catalogued: true, context_length: m.context_length,
      input_per_m: perM(p.prompt), output_per_m: perM(p.completion),
      cache_read_per_m: perM(p.input_cache_read),
      tier_min_prompt_tokens: tier ? tier.min_prompt_tokens : null,
      tier_input_per_m: tier ? perM(tier.prompt) : null,
      output_modalities: (m.architecture && m.architecture.output_modalities) || null,
      providers_live: null,
    };
  }
  const m = hfBySlug[c.slug];
  if (!m) return { ok: false, reason: "not in the HF router catalogue" };
  const live = (m.providers || []).filter(function (p) { return p.status === "live"; });
  const chosen = live.filter(function (p) { return p.provider === c.provider; })[0] || live[0];
  if (!chosen) return { ok: false, reason: "no live provider publishes this model" };
  const pr = chosen.pricing || {};
  return {
    ok: true, catalogued: true, provider: chosen.provider, context_length: chosen.context_length,
    input_per_m: pr.input == null ? null : Number(pr.input),
    output_per_m: pr.output == null ? null : Number(pr.output),
    cache_read_per_m: null, tier_min_prompt_tokens: null, tier_input_per_m: null,
    output_modalities: ["text"], providers_live: live.length,
  };
}

const out = [];
const validationNotes = [];
// A text workload asks every golden-set question; an image workload sends the one prompt.
const questions = workload.workload_kind === "image"
  ? [{ id: "image-prompt", kind: "image", question: workload.prompt, expected: null, accept: [], reject: [] }]
  : workload.golden_set;

// Stamped onto every call item so the scoring, costing and ledger nodes read the customer's criteria
// from the data rather than from constants. This is what makes the workload an input.
const carried = {
  workload_name: workload.workload_name,
  workload_kind: workload.workload_kind,
  quality_bar: workload.quality_bar,
  latency_ceiling_ms: workload.latency_ceiling_ms,
  monthly_requests: workload.monthly_requests,
  buyer_estimate: workload.buyer_estimate,
};

for (const c of workload.candidates) {
  const info = lookup(c);
  if (!info.ok) {
    validationNotes.push(c.name + ": " + info.reason);
    continue;
  }
  const wantsText = workload.workload_kind !== "image";
  if (info.output_modalities && info.output_modalities.indexOf(wantsText ? "text" : "image") === -1) {
    validationNotes.push(c.name + ": catalogue says it does not output " + (wantsText ? "text" : "image"));
    continue;
  }
  for (const g of questions) {
    const messages = wantsText
      ? [
          { role: "system", content: workload.answer_instruction },
          { role: "user", content: "CONTRACT:\\n" + workload.contract + "\\n\\nQUESTION: " + g.question },
        ]
      : [{ role: "user", content: workload.prompt }];
    const body = { model: c.slug, messages: messages, max_tokens: 400, temperature: 0 };
    if (!wantsText) body.modalities = ["image", "text"];
    out.push({ json: Object.assign({}, carried, {
      candidate: c.name, slug: c.slug, source: c.source, route: c.route,
      provider: info.provider || c.provider || null, incumbent: c.incumbent,
      question_id: g.id, question_kind: g.kind, expected: g.expected,
      accept: g.accept || [], reject: g.reject || [],
      validation: info, validation_notes: validationNotes,
      url: c.source === "openrouter" ? ENDPOINTS.openrouter : ENDPOINTS.huggingface,
      body: body,
    })});
  }
}
// A shortlist whose entries were all renamed or withdrawn is a stated outcome, not a silent one.
if (!out.length) throw new Error("no candidate passed validation: " + validationNotes.join("; "));
return out;`;

const CODE_CALL = `// The calls themselves, timed to the last byte. n8n's HTTP Request node does not expose per-item
// timing, and latency is one of the three numbers the gate decides on, so the timed HTTP helper is
// used here instead of that node. Sequential on purpose: parallel calls measure the queue.
//
// n8n 2.x blocks environment access in nodes by default: reading $env throws "access to env vars
// denied" unless the instance sets N8N_BLOCK_ENV_ACCESS_IN_NODE=false. n8n Variables are the
// supported path and work on Cloud, so they are read first, and the environment is a self-hosted
// fallback. Both reads are guarded: a blocked $env throws rather than returning undefined, and a
// thrown lookup here would take down every call in the run.
function secret(name) {
  try { if (typeof $vars !== "undefined" && $vars && $vars[name]) return $vars[name]; } catch (e) { /* no Variables on this instance */ }
  try { if (typeof $env !== "undefined" && $env && $env[name]) return $env[name]; } catch (e) { /* env access blocked by default */ }
  return null;
}
const out = [];
for (const item of $input.all()) {
  const j = item.json;
  const keyName = j.source === "openrouter" ? "OPENROUTER_API_KEY" : "HF_TOKEN";
  const key = secret(keyName);
  const started = Date.now();
  let status = null;
  let body = null;
  let error = null;
  if (!key) {
    error = "missing " + keyName + ": set it as an n8n Variable, or in the environment with N8N_BLOCK_ENV_ACCESS_IN_NODE=false";
  } else {
    try {
      const res = await this.helpers.httpRequest({
        method: "POST", url: j.url,
        headers: { Authorization: "Bearer " + key, "Content-Type": "application/json", "HTTP-Referer": "https://github.com/therealmaddieli/cost-route", "X-Title": "Cost-Route n8n" },
        body: j.body, json: true, returnFullResponse: true, ignoreHttpStatusErrors: true,
        timeout: 120000,
      });
      status = res.statusCode;
      body = res.body;
    } catch (e) {
      error = String((e && e.message) || e);
    }
  }
  const latency_ms = Date.now() - started;
  const choice = body && body.choices && body.choices[0];
  const answer = choice && choice.message ? String(choice.message.content || "") : "";
  out.push({ json: Object.assign({}, j, {
    status: status, latency_ms: latency_ms, usage: (body && body.usage) || null,
    answer: answer, error: error,
  })});
}
return out;`;

const CODE_SCORE = `// Rule-based gate, ported from core/scorer.mjs so the canvas and the repository score the same
// answers the same way. The first n8n version regex-tested the raw text and scored GPT-4o mini 5/14
// where the repo scored 12/14: contracts spell numbers as "twenty-four (24) months", and no
// number-then-unit pattern matches with a ")" in between. Normalising that away first is the whole
// difference, and without it the workflow contradicted the published page about the same answers.
function normalise(text) {
  return String(text == null ? "" : text)
    .toLowerCase()
    .replace(/[\\u2010-\\u2015\\u2212]/g, "-")
    .replace(/[\\u00a0\\u2007\\u202f]/g, " ")
    .replace(/[\\u0060*_>#]|\\*\\*|__/g, " ")
    .replace(/\\(\\s*(\\d[\\d,.]*\\s*%?)\\s*\\)/g, "$1")
    .replace(/\\s+/g, " ")
    .trim();
}
function matchAny(haystack, patterns) {
  for (const p of (patterns || [])) {
    try { if (new RegExp(p, "i").test(haystack)) return p; } catch (e) { /* a bad pattern is skipped, not fatal */ }
  }
  return null;
}
function scoreItem(item, answer) {
  const text = normalise(answer);
  const kind = item.kind || "fact";
  // Absent items are scored the other way round: the only thing worth measuring is whether the
  // model says the document is silent. Checking accept first stops a correct "not specified" being
  // overturned by a figure the model mentioned from elsewhere.
  if (kind === "absent") {
    const accepted = matchAny(text, item.accept);
    const rejected = matchAny(text, item.reject);
    if (accepted) return { correct: true, hallucination: false, needs_review: false, hedged: Boolean(rejected) };
    if (rejected) return { correct: false, hallucination: true, needs_review: false, hedged: false };
    return { correct: false, hallucination: false, needs_review: true, hedged: false };
  }
  const rejected = matchAny(text, item.reject);
  if (rejected) return { correct: false, hallucination: true, needs_review: false, hedged: false };
  const accepted = matchAny(text, item.accept);
  if (accepted) return { correct: true, hallucination: false, needs_review: false, hedged: false };
  return { correct: false, hallucination: false, needs_review: true, hedged: false };
}
function percentile(values, p) {
  const v = values.filter(function (n) { return typeof n === "number" && isFinite(n); }).sort(function (a, b) { return a - b; });
  if (!v.length) return null;
  if (v.length === 1) return v[0];
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
}
const rows = $input.all().map(function (i) { return i.json; });
const groups = {};
for (const r of rows) {
  if (!groups[r.slug]) groups[r.slug] = {
    name: r.candidate, slug: r.slug, route: r.route, source: r.source, provider: r.provider,
    incumbent: r.incumbent, validation: r.validation, validation_notes: r.validation_notes,
    // Carried through from the planning node, which took them from the customer's workload.
    workload_name: r.workload_name, workload_kind: r.workload_kind, quality_bar: r.quality_bar,
    latency_ceiling_ms: r.latency_ceiling_ms, monthly_requests: r.monthly_requests,
    buyer_estimate: r.buyer_estimate,
    calls: [],
  };
  const answered = r.status === 200 && r.answer && r.answer.length > 0;
  groups[r.slug].calls.push({
    id: r.question_id, kind: r.question_kind, answered: answered,
    score: answered ? scoreItem(r, r.answer) : null,
    latency_ms: r.latency_ms, usage: r.usage, answer: r.answer, status: r.status, error: r.error,
  });
}
const out = [];
for (const key in groups) {
  const c = groups[key];
  const machineScored = c.workload_kind !== "image";
  const answered = c.calls.filter(function (x) { return x.answered; });
  const scored = machineScored ? answered.filter(function (x) { return x.score; }) : [];
  const correct = scored.filter(function (x) { return x.score.correct; }).length;
  const fabricated = scored.filter(function (x) { return x.score.hallucination; }).length;
  const needsReview = scored.filter(function (x) { return x.score.needs_review; }).length;
  const lat = answered.map(function (x) { return x.latency_ms; });
  const share = scored.length ? correct / scored.length : null;
  const bar = c.quality_bar || { min_correct_share: 0.75, max_hallucinations: 0 };
  const ceiling = c.latency_ceiling_ms == null ? 15000 : c.latency_ceiling_ms;
  const fails = [];
  // Image workloads have no golden set: whether the picture is any good is a human judgement, so the
  // only machine gate is the customer's own latency ceiling. Scoring an image against regex patterns
  // would manufacture a quality verdict out of nothing.
  if (machineScored) {
    if (share !== null && share < bar.min_correct_share) fails.push(Math.round(share * 100) + "% correct, below the " + Math.round(bar.min_correct_share * 100) + "% bar");
    if (fabricated > bar.max_hallucinations) fails.push(fabricated + " fabricated answer" + (fabricated === 1 ? "" : "s") + ", above the limit of " + bar.max_hallucinations);
  }
  const p50 = percentile(lat, 0.5);
  const p95 = percentile(lat, 0.95);
  if (p50 !== null && p50 > ceiling) fails.push("p50 " + Math.round(p50) + "ms is above the " + ceiling + "ms ceiling");
  if (!answered.length) fails.push("no call was served");
  const sum = function (fn) { return answered.reduce(function (s, x) { return s + fn(x); }, 0); };
  const n = answered.length || 1;
  out.push({ json: Object.assign({}, c, {
    machine_scored: machineScored,
    scored: scored.length, total: c.calls.length, correct: correct, fabricated: fabricated, needs_review: needsReview,
    share: share, p50: p50 == null ? null : Math.round(p50), p95: p95 == null ? null : Math.round(p95),
    passed: fails.length === 0, fail_reasons: fails,
    measured_input_tokens_per_call: Math.round(sum(function (x) { return (x.usage && x.usage.prompt_tokens) || 0; }) / n),
    measured_output_tokens_per_call: Math.round(sum(function (x) { return (x.usage && x.usage.completion_tokens) || 0; }) / n),
    measured_cached_input_tokens_per_call: Math.round(sum(function (x) { return (x.usage && x.usage.prompt_tokens_details && x.usage.prompt_tokens_details.cached_tokens) || 0; }) / n),
    measured_reasoning_tokens_per_call: Math.round(sum(function (x) { return (x.usage && x.usage.completion_tokens_details && x.usage.completion_tokens_details.reasoning_tokens) || 0; }) / n),
  })});
}
return out;`;

const CODE_COST = `// The five price mechanics, applied in one place and in a fixed order. Reasoning tokens are billed
// inside completion_tokens, so they are not added twice.
const perToken = function (perM) { return perM == null ? null : perM / 1e6; };
const out = [];
for (const item of $input.all()) {
  const c = item.json;
  const v = c.validation || {};
  const inp = c.measured_input_tokens_per_call || 0;
  const cached = c.measured_cached_input_tokens_per_call || 0;
  const uncached = Math.max(0, inp - cached);
  const outTok = c.measured_output_tokens_per_call || 0;
  const inRate = perToken(v.input_per_m);
  const cacheRate = perToken(v.cache_read_per_m);
  const outRate = perToken(v.output_per_m);
  let complete = inRate != null && outRate != null;
  let perCall = null;
  let parts = null;
  if (complete) {
    const uncachedCost = uncached * inRate;
    const cachedCost = cached * (cacheRate == null ? inRate : cacheRate);
    const outCost = outTok * outRate;
    perCall = uncachedCost + cachedCost + outCost;
    parts = {
      uncached_input_usd: uncachedCost, cached_input_usd: cachedCost, output_usd: outCost,
      cache_available: cacheRate != null, cache_used: cacheRate != null && cached > 0,
    };
  }
  out.push({ json: Object.assign({}, c, {
    pricing: { input_per_m: v.input_per_m, output_per_m: v.output_per_m, cache_read_per_m: v.cache_read_per_m },
    cost_parts: parts, cost_per_call_usd: perCall,
    // The volume is the customer's, carried from the planning node.
    monthly_cost_usd: perCall == null ? null : perCall * (c.monthly_requests == null ? 1000 : c.monthly_requests),
    priced: complete,
  })});
}
return out;`;

const CODE_LEDGER = `// Buyer's stated estimate, the buyer's own assumptions priced out, and the measurement. The gap
// between the first two is arithmetic; the gap between the last two is the measurement.
//
// This node reads the object the previous node produced, not the raw items, because the previous
// node is a summariser: Three routes turns the candidate list into a route table, so the candidates
// have to travel with it. The first version of that node returned only the rows, and this node then
// read the wrong shape and died on incumbent.pricing.input_per_m - after all 42 calls had been made
// and paid for. A summarising node that drops its input breaks everything downstream of it.
const carried = $input.first().json || {};
const cands = carried.candidates || [];
const routes = carried.routes || [];
const priced = cands.filter(function (c) { return c && c.pricing; });
if (!priced.length) {
  return [{ json: { available: false, reason: "no priced candidate reached the ledger", routes: routes } }];
}
const incumbent = priced.filter(function (c) { return c.incumbent; })[0] || priced[0];
// The customer's own inputs, carried on the candidates rather than read from this file.
const vol = incumbent.monthly_requests == null ? 1000 : incumbent.monthly_requests;
const be = incumbent.buyer_estimate || { assumed_input_tokens_per_request: 1500, assumed_output_tokens_per_request: 50, assumed_cost_per_month_usd: null };
const toRate = function (perM) { return perM == null ? null : perM / 1e6; };
const inRate = toRate(incumbent.pricing.input_per_m) || 0;
const outRate = toRate(incumbent.pricing.output_per_m) || 0;
const cacheRate = toRate(incumbent.pricing.cache_read_per_m);
const own = (be.assumed_input_tokens_per_request * inRate + be.assumed_output_tokens_per_request * outRate) * vol;
const measuredPrompt = incumbent.measured_input_tokens_per_call || 0;
const measuredOut = incumbent.measured_output_tokens_per_call || 0;
const measuredCached = incumbent.measured_cached_input_tokens_per_call || 0;
const promptStep = (measuredPrompt - be.assumed_input_tokens_per_request) * inRate * vol;
const answerStep = (measuredOut - be.assumed_output_tokens_per_request) * outRate * vol;
const cacheStep = cacheRate == null ? 0 : -(measuredCached * (inRate - cacheRate)) * vol;
return [{ json: {
  available: true,
  incumbent: incumbent.name,
  // Everything the renderer needs about this run's workload, so it does not read constants either.
  workload_name: incumbent.workload_name || "Untitled workload",
  workload_kind: incumbent.workload_kind || "text",
  machine_scored: incumbent.machine_scored !== false,
  quality_bar: incumbent.quality_bar || { min_correct_share: 0.75, max_hallucinations: 0 },
  latency_ceiling_ms: incumbent.latency_ceiling_ms == null ? 15000 : incumbent.latency_ceiling_ms,
  monthly_requests: vol,
  routes: routes,
  stated_estimate_usd: be.assumed_cost_per_month_usd,
  own_assumptions_usd: own,
  measured_usd: incumbent.monthly_cost_usd,
  arithmetic_gap_usd: be.assumed_cost_per_month_usd == null ? null : be.assumed_cost_per_month_usd - own,
  measurement_gap_usd: incumbent.monthly_cost_usd == null ? null : incumbent.monthly_cost_usd - own,
  steps: [
    { label: "Prompt size", from: be.assumed_input_tokens_per_request, to: measuredPrompt, usd: promptStep },
    { label: "Answer length", from: be.assumed_output_tokens_per_request, to: measuredOut, usd: answerStep },
    { label: "Prompt caching", from: 0, to: measuredCached, usd: cacheStep },
  ],
  candidates: cands.map(function (c) {
    return { name: c.name, route: c.route, passed: c.passed, machine_scored: c.machine_scored !== false, share: c.share, correct: c.correct, scored: c.scored, total: c.total, fabricated: c.fabricated, p50: c.p50, p95: c.p95, cost_per_call_usd: c.cost_per_call_usd, monthly_cost_usd: c.monthly_cost_usd, priced: c.priced, fail_reasons: c.fail_reasons };
  }),
}}];`;

const CODE_ROUTES = `// The three procurement routes. Route C is an estimate from named assumptions and is never given a
// monthly figure beside the two quoted routes.
const cands = $input.all().map(function (i) { return i.json; });
const selfHost = {
  route: "C", label: "Open weights, self-hosted", candidate: "any open-weight model (illustrative)",
  monthly_cost_usd: null,
  note: "An estimate from named assumptions, not a quoted price: one GPU instance held up all month, before throughput engineering, capacity planning, failover and an on-call rota. Everything except hardware cost is the buyer's.",
};
const rows = cands.map(function (c) {
  const v = c.validation || {};
  const notes = [];
  if (c.route === "B") {
    if (v.providers_live != null) notes.push(v.providers_live + " live provider" + (v.providers_live === 1 ? "" : "s") + " listed for this model.");
    notes.push("Open weights: the licence is nameable and readable, and gating is a real step that is not in the price.");
  } else {
    notes.push("One endpoint and one key. No weights to run and no serving stack to maintain.");
    if (v.cache_read_per_m != null) notes.push("Publishes a cache-read rate, so the prompt-caching discount depends on prompt structure rather than on choosing this model.");
    notes.push("Vendor lock: the model can be withdrawn or repriced without notice, and the only signal is its disappearance from the catalogue.");
  }
  if (v.tier_min_prompt_tokens != null) notes.push("Tiered rate above " + v.tier_min_prompt_tokens + " prompt tokens, so long-context work costs more than the list price.");
  return { route: c.route, label: c.route === "A" ? "Closed API model" : "Open weights, served by a third party", candidate: c.name, slug: c.slug, monthly_cost_usd: c.monthly_cost_usd, priced: c.priced, note: notes.join(" ") };
});
rows.push(selfHost);
// The candidate list travels with the route table, and that is load-bearing rather than tidy: the
// ledger node reads the candidates from here. Returning only the rows is what broke the first run.
return [{ json: { routes: rows, candidates: cands } }];`;

const CODE_RENDER = `// A compact decision summary as one HTML string. The full published page is rendered by
// core/report.mjs in the repository; this is the canvas-native version of the same argument.
const ledger = $input.first().json;
if (!ledger || ledger.available === false) {
  const reason = (ledger && ledger.reason) || "the ledger node produced nothing";
  return [{ json: { html: "<!doctype html><html lang=\\"en\\"><body><h1>Cost-Route: no ledger</h1><p>" + reason + "</p></body></html>", filename: "cost-route-summary.html" } }];
}
const usd = function (n, p) { return n == null || !isFinite(n) ? "n/a" : "$" + Number(n).toFixed(p == null ? 2 : p); };
const pctTxt = function (s) { return s == null ? "not measured" : Math.round(s * 100) + "%"; };
// Every fact about this run's workload comes from the ledger, which carried it from the caller's
// input. Nothing here is a constant, so the same node summarises any workload.
const wname = ledger.workload_name || "Untitled workload";
const vol = ledger.monthly_requests == null ? 1000 : ledger.monthly_requests;
const bar = ledger.quality_bar || { min_correct_share: 0.75, max_hallucinations: 0 };
const ceiling = ledger.latency_ceiling_ms == null ? 15000 : ledger.latency_ceiling_ms;
const machineScored = ledger.machine_scored !== false;
const rows = ledger.candidates.map(function (c) {
  const gate = c.machine_scored === false ? "not machine-scored" : (c.passed ? "PASS" : "FAIL");
  const quality = c.machine_scored === false
    ? "a human judges the output"
    : (pctTxt(c.share) + " (" + c.correct + "/" + c.scored + ")");
  return "<tr><td>" + c.name + "</td><td>route " + c.route + "</td><td>" + gate + "</td><td>" + quality + "</td><td>" + (c.p50 == null ? "n/a" : c.p50 + " ms") + "</td><td>" + usd(c.cost_per_call_usd, 4) + "</td><td>" + usd(c.monthly_cost_usd) + "</td></tr>";
}).join("");
const steps = ledger.steps.map(function (s) {
  return "<tr><td>" + s.label + "</td><td>" + s.from + " to " + s.to + "</td><td>" + (s.usd >= 0 ? "+" : "") + usd(Math.abs(s.usd)) + "</td></tr>";
}).join("");
const routeRows = (ledger.routes || []).map(function (r) {
  return "<tr><td>Route " + r.route + "</td><td>" + r.candidate + "</td><td>" + usd(r.monthly_cost_usd) + "</td><td>" + r.note + "</td></tr>";
}).join("");
const gateNote = machineScored
  ? "Quality bar " + Math.round(bar.min_correct_share * 100) + "% correct with at most " + bar.max_hallucinations + " fabricated answers; latency ceiling " + ceiling + " ms."
  : "Not machine-scored: a human judges the output, so the only machine gate is the " + ceiling + " ms latency ceiling.";
const html = [
  "<!doctype html><html lang=\\"en\\"><head><meta charset=\\"utf-8\\"><title>Cost-Route - n8n run</title>",
  "<style>body{font:15px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;max-width:900px;margin:40px auto;padding:0 24px;color:#14161a;background:#fbfbfc}",
  "h1{font-size:24px}h2{font-size:17px;margin-top:32px}table{width:100%;border-collapse:collapse;font-size:14px}",
  "th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #e3e6ea}th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280}",
  ".big{font:600 30px ui-monospace,Menlo,monospace}.hint{color:#6b7280;font-size:12.5px}.pass{color:#1f6f43;font-weight:600}.fail{color:#a4262c;font-weight:600}</style></head><body>",
  "<h1>Cost-Route: a measured decision from n8n</h1>",
  "<p class=\\"hint\\">" + wname + ", " + Number(vol).toLocaleString() + " requests a month. Live calls made by this workflow; catalogue rates read at run time.</p>",
  "<h2>Where the estimate went wrong</h2>",
  "<p>The buyer said <b>" + usd(ledger.stated_estimate_usd) + "</b>. Their own assumptions cost <b>" + usd(ledger.own_assumptions_usd) + "</b>. The calls actually cost <b class=\\"big\\">" + usd(ledger.measured_usd) + "</b> a month.</p>",
  "<p class=\\"hint\\">Arithmetic gap " + usd(ledger.arithmetic_gap_usd) + " (an estimate that does not follow from its own inputs); measurement gap " + usd(ledger.measurement_gap_usd) + " (the part only measuring could find).</p>",
  "<table><thead><tr><th>Step</th><th>Tokens per call</th><th>Effect</th></tr></thead><tbody>" + steps + "</tbody></table>",
  "<h2>Every candidate, at this volume</h2>",
  "<table><thead><tr><th>Candidate</th><th>Route</th><th>Gate</th><th>Correct</th><th>p50</th><th>Per call</th><th>Monthly</th></tr></thead><tbody>" + rows + "</tbody></table>",
  "<h2>The three procurement routes</h2>",
  "<table><thead><tr><th>Route</th><th>Candidate</th><th>Monthly</th><th>What price does not say</th></tr></thead><tbody>" + routeRows + "</tbody></table>",
  "<h2>Assumptions</h2>",
  "<ul><li>Inputs are the caller's own: the document or prompt, the questions with known answers, the criteria and the shortlist all came from the submitted workload. The bundled demo is synthetic.</li>",
  "<li>" + gateNote + "</li>",
  "<li>Route C, self-hosted, is an estimate from named assumptions and never a quoted price.</li>",
  "<li>Prices move. Re-running this workflow reproduces the method, not these exact figures.</li></ul>",
  "<p class=\\"hint\\">Generated by the Cost-Route n8n workflow. Full interactive page: https://therealmaddieli.github.io/cost-route/</p>",
  "</body></html>",
].join("");
// The binary is built here, where the HTML is, rather than by a Convert to File node downstream.
// That node's toBinary operation produced 14 bytes of garbage from this string, and a second node
// is a second place for the bytes to stop being the bytes. prepareBinaryData is n8n's documented way
// for a Code node to emit a file, and the Read/Write File node then writes exactly these bytes.
const binary = await this.helpers.prepareBinaryData(Buffer.from(html, "utf8"), "cost-route-summary.html", "text/html");
return [{ json: { html: html, filename: "cost-route-summary.html" }, binary: { data: binary } }];`;

// ---------------------------------------------------------------------------
// syntax check every Code node before it is written into the workflow
// ---------------------------------------------------------------------------

for (const [name, code] of Object.entries({ CODE_NORMALISE, CODE_SAMPLE, CODE_PLAN, CODE_CALL, CODE_SCORE, CODE_COST, CODE_LEDGER, CODE_ROUTES, CODE_RENDER })) {
  fs.writeFileSync(path.join(root, "out", `code-${name}.js`), code);
  try {
    // n8n runs a Code node as an async function, so top-level await is legal there and must be
    // legal here too, or the check would reject the one node that makes the HTTP calls.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    // eslint-disable-next-line no-new-func
    new AsyncFunction("$input", "$env", code);
  } catch (e) {
    throw new Error(`${name} has a syntax error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

const id = () => crypto.randomUUID();
const code = (name, jsCode, position) => ({
  parameters: { mode: "runOnceForAllItems", jsCode },
  type: "n8n-nodes-base.code",
  typeVersion: 2,
  position,
  id: id(),
  name,
});
const http = (name, url, position) => ({
  parameters: { method: "GET", url, options: {} },
  type: "n8n-nodes-base.httpRequest",
  typeVersion: 4.2,
  position,
  id: id(),
  name,
});
const sticky = (content, position, width, height) => ({
  parameters: { content, height, width, color: 4 },
  type: "n8n-nodes-base.stickyNote",
  typeVersion: 1,
  position,
  id: id(),
  name: `Note: ${content.split("\n")[0].slice(0, 40)}`,
});

const nodes = [
  // --- three ways in, none of them a hard-coded workload -------------------------------------
  {
    // The customer-facing entry point. Fill in your own contract, questions, criteria and shortlist
    // and the same pipeline runs on it; nothing needs editing in the canvas.
    parameters: {
      formTitle: "Run Cost-Route on your workload",
      // A form trigger is a webhook underneath: without a path n8n cannot register it, and it takes
      // the workflow's other webhooks down with it.
      path: "cost-route-form",
      formDescription:
        "Price one AI workload across three procurement routes and see where your own estimate goes wrong. Supply the document or prompt, 10-15 questions with known answers, your criteria, and the models you are already considering.",
      formFields: {
        values: [
          { fieldLabel: "Workload name", fieldName: "workload_name", fieldType: "text", requiredField: true, placeholder: "e.g. Legal contract review" },
          { fieldLabel: "Kind", fieldName: "workload_kind", fieldType: "dropdown", requiredField: true, defaultValue: "text", fieldOptions: { values: [{ option: "text" }, { option: "image" }] } },
          { fieldLabel: "Task description", fieldName: "task_description", fieldType: "text", placeholder: "One line, for the summary" },
          { fieldLabel: "Contract text (text workloads)", fieldName: "contract", fieldType: "textarea", placeholder: "Paste the document to be reviewed" },
          { fieldLabel: "Image prompt (image workloads)", fieldName: "prompt", fieldType: "text", placeholder: "The exact prompt to send" },
          { fieldLabel: "Golden set (JSON array)", fieldName: "golden_set", fieldType: "textarea", placeholder: '[{"id":"term-length","kind":"fact","question":"How long is the term?","expected":"24 months","accept":["24[\\\\s-]*months?"],"reject":[]}]' },
          { fieldLabel: "Candidates (JSON array)", fieldName: "candidates", fieldType: "textarea", requiredField: true, placeholder: '[{"name":"GPT-4o mini","slug":"openai/gpt-4o-mini","source":"openrouter","route":"A"}]' },
          { fieldLabel: "Quality bar: minimum correct share", fieldName: "min_correct_share", fieldType: "number", defaultValue: 0.75 },
          { fieldLabel: "Quality bar: maximum fabricated answers", fieldName: "max_hallucinations", fieldType: "number", defaultValue: 0 },
          { fieldLabel: "Latency ceiling (ms)", fieldName: "latency_ceiling_ms", fieldType: "number", defaultValue: 15000 },
          { fieldLabel: "Requests per month", fieldName: "monthly_requests", fieldType: "number", defaultValue: 1000 },
          { fieldLabel: "Assumed prompt tokens per request", fieldName: "assumed_input_tokens_per_request", fieldType: "number", defaultValue: 1500 },
          { fieldLabel: "Assumed answer tokens per request", fieldName: "assumed_output_tokens_per_request", fieldType: "number", defaultValue: 50 },
          { fieldLabel: "Your monthly estimate (USD)", fieldName: "assumed_cost_per_month_usd", fieldType: "number" },
        ],
      },
      // The form waits for the run and returns the summary, so the customer sees the result rather
      // than a "started" message.
      responseMode: "lastNode",
      options: {},
    },
    type: "n8n-nodes-base.formTrigger",
    typeVersion: 2.2,
    // The node's webhook path expression falls back to $webhookId, and an imported node has none
    // unless it is written here. Without it n8n logs "No webhook path could be found" and the form
    // never registers.
    webhookId: id(),
    position: [-760, 40],
    id: id(),
    name: "Form: your workload",
  },
  {
    // The programmatic entry point: POST the same workload JSON to /webhook/cost-route.
    parameters: { httpMethod: "POST", path: "cost-route", responseMode: "onReceived", options: {} },
    type: "n8n-nodes-base.webhook",
    typeVersion: 2,
    webhookId: id(),
    position: [-760, 320],
    id: id(),
    name: "Webhook: POST a workload",
  },
  {
    // Keeps the one-click demo. This is the only path with a workload embedded in the file.
    parameters: {},
    type: "n8n-nodes-base.manualTrigger",
    typeVersion: 1,
    position: [-760, 600],
    id: id(),
    name: "Manual Trigger",
  },
  code("Sample workload (demo)", CODE_SAMPLE, [-500, 600]),
  code("Normalise workload", CODE_NORMALISE, [-240, 320]),
  http("OpenRouter catalogue", "https://openrouter.ai/api/v1/models", [-20, 140]),
  http("HF router catalogue", "https://router.huggingface.co/v1/models", [-20, 500]),
  {
    // Without this, the Code node downstream runs ONCE PER INCOMING BRANCH, not once for all three:
    // the first live run built its 42 calls from the OpenRouter catalogue alone and then threw on
    // the HF branch, which saw no OpenRouter models at all. Merging first makes the two responses
    // and the workload one input, which is what the planning node was written to expect.
    parameters: { mode: "append", numberInputs: 3, options: {} },
    type: "n8n-nodes-base.merge",
    typeVersion: 3.1,
    position: [220, 320],
    id: id(),
    name: "Merge catalogues",
  },
  code("Plan the run", CODE_PLAN, [460, 320]),
  code("Call candidates (timed)", CODE_CALL, [720, 320]),
  code("Score: the quality gate", CODE_SCORE, [980, 320]),
  code("Cost engine", CODE_COST, [1240, 320]),
  code("Three routes", CODE_ROUTES, [1500, 320]),
  code("Estimate vs measured", CODE_LEDGER, [1760, 320]),
  code("Render summary HTML", CODE_RENDER, [2020, 320]),
  {
    parameters: {
      operation: "write",
      fileName: "cost-route-summary.html",
      dataPropertyName: "data",
      options: {},
    },
    type: "n8n-nodes-base.readWriteFile",
    typeVersion: 1,
    position: [2280, 320],
    id: id(),
    name: "Save summary",
    // n8n confines the Read/Write File node to an allow-list that defaults to ~/.n8n-files
    // (restrictFileAccessTo in @n8n/config), so this write is refused for any other path unless the
    // instance sets N8N_RESTRICT_FILE_ACCESS_TO to the output directory or to an empty string.
    // N8N_BLOCK_FILE_ACCESS_TO_N8N_FILES=false is not enough on its own: it removes the extra block
    // on n8n's own folder, not the allow-list. Refused-to-write is a different outcome from a failed
    // run - the HTML is already built and downloadable from the two nodes before this one - so the
    // workflow continues and the README says how to get the file on disk.
    onError: "continueRegularOutput",
  },
  sticky(
    "How to supply the workload.\n\nThree ways in, and none of them is a hard-coded shortlist:\n\n1. Form Trigger - fill in the form and submit. Slowest to fill, easiest to use.\n2. Webhook - POST the same workload as JSON to /webhook/cost-route.\n3. Manual Trigger - runs the bundled synthetic demo, so the workflow works in one click.\n\n'Normalise workload' is the single place the input is read and validated. Everything downstream reads the workload from the data, so you never edit a Code node to change the contract, the questions, the criteria or the models.",
    [-900, -320],
    900,
    300
  ),
  sticky(
    "Step 1 - requirements gate, before price.\n\nBoth catalogues are fetched with raw HTTP Request nodes and normalised to USD per 1M tokens in one Code node. The shortlist is validated against what the catalogues actually publish, then one item is created per candidate per golden-set question.",
    [-240, -140],
    760,
    200
  ),
  sticky(
    "Step 2 - measure, don't multiply.\n\nEvery call is made for real and timed to the last byte. Quality is scored by rules against known answers: correct share, p50/p95 latency, and a hallucination flag with the answer attached. No LLM judge. Image workloads are not machine-scored; only the latency ceiling gates them.\n\nKeys are read from n8n Variables (OPENROUTER_API_KEY, HF_TOKEN), or from the environment on a self-hosted instance with N8N_BLOCK_ENV_ACCESS_IN_NODE=false. Nothing secret is in this file.",
    [640, -140],
    760,
    260
  ),
  sticky(
    "Steps 3 and 4 - price the survivors, then show the gap.\n\nFive price mechanics, three procurement routes, and the caller's estimate against the measurement with each error named. Route C stays an estimate and is never given a monthly figure beside the two quoted routes.",
    [1460, -140],
    760,
    200
  ),
];

const order = [
  "Form: your workload",
  "Webhook: POST a workload",
  "Manual Trigger",
  "Sample workload (demo)",
  "Normalise workload",
  "OpenRouter catalogue",
  "HF router catalogue",
  "Merge catalogues",
  "Plan the run",
  "Call candidates (timed)",
  "Score: the quality gate",
  "Cost engine",
  "Three routes",
  "Estimate vs measured",
  "Render summary HTML",
  "Save summary",
];

const connections = {
  // The three entry points all land on the normaliser, which is the only node that reads a
  // customer's input. Only one of them fires per execution, so the normaliser runs once.
  "Form: your workload": { main: [[{ node: "Normalise workload", type: "main", index: 0 }]] },
  "Webhook: POST a workload": { main: [[{ node: "Normalise workload", type: "main", index: 0 }]] },
  "Manual Trigger": { main: [[{ node: "Sample workload (demo)", type: "main", index: 0 }]] },
  "Sample workload (demo)": { main: [[{ node: "Normalise workload", type: "main", index: 0 }]] },
  // One output, fanned out to the two catalogue fetches and, directly, to the merge as its third
  // input: the HTTP nodes replace their input with the response, so the workload has to reach the
  // merge without passing through them.
  "Normalise workload": {
    main: [[
      { node: "OpenRouter catalogue", type: "main", index: 0 },
      { node: "HF router catalogue", type: "main", index: 0 },
      { node: "Merge catalogues", type: "main", index: 2 },
    ]],
  },
  // The two catalogues and the workload converge before the planning node. Without the Merge, n8n
  // runs the planning node once per branch, and the branch that saw only the HF catalogue threw.
  "OpenRouter catalogue": { main: [[{ node: "Merge catalogues", type: "main", index: 0 }]] },
  "HF router catalogue": { main: [[{ node: "Merge catalogues", type: "main", index: 1 }]] },
  "Merge catalogues": { main: [[{ node: "Plan the run", type: "main", index: 0 }]] },
  "Plan the run": { main: [[{ node: "Call candidates (timed)", type: "main", index: 0 }]] },
  "Call candidates (timed)": { main: [[{ node: "Score: the quality gate", type: "main", index: 0 }]] },
  "Score: the quality gate": { main: [[{ node: "Cost engine", type: "main", index: 0 }]] },
  "Cost engine": { main: [[{ node: "Three routes", type: "main", index: 0 }]] },
  "Three routes": { main: [[{ node: "Estimate vs measured", type: "main", index: 0 }]] },
  "Estimate vs measured": { main: [[{ node: "Render summary HTML", type: "main", index: 0 }]] },
  "Render summary HTML": { main: [[{ node: "Save summary", type: "main", index: 0 }]] },
};

const workflow = {
  name: "Cost-Route: price an AI workload across three procurement routes",
  nodes,
  connections,
  active: false,
  settings: { executionOrder: "v1" },
  pinData: {},
  tags: [],
};

// A credential-free workflow: no key material and no credential stanzas. A shape check on the
// written file is a backstop, not a substitute for reading the diff before publishing.
const text = JSON.stringify(workflow, null, 2);
for (const bad of ["sk-or-", "hf_", "bfl_", "ghp_", "AIza"]) {
  if (text.includes(bad)) throw new Error(`workflow.json would contain a secret-looking value: ${bad}`);
}

fs.writeFileSync(path.join(root, "workflow.json"), text + "\n");
console.log(`wrote workflow.json: ${nodes.length} nodes (${order.length} wired), ${(text.length / 1024).toFixed(1)} KB`);
