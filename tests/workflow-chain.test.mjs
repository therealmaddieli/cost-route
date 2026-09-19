/**
 * Runs the n8n workflow's Code nodes as a chain, the way the canvas runs them.
 *
 * This file exists because the workflow's first live run passed every structural check here and then
 * died at run time: "Three routes" returned only its route rows, so "Estimate vs measured" read a
 * shape with no `pricing` and threw `Cannot read properties of undefined (reading 'input_per_m')` -
 * after all 42 paid API calls had already been made. Importing cleanly, having valid connections and
 * carrying no secrets are all necessary and none of them are sufficient. The only check that catches
 * this is running the node bodies in sequence and asserting what each one hands the next.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));
const jsCode = (name) => {
  const node = workflow.nodes.find((n) => n.name === name);
  assert.ok(node, `node is missing: ${name}`);
  return node.parameters.jsCode;
};

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

/** Run one Code node the way n8n does: an async function over $input, $env and $vars, with helpers. */
async function runNode(name, items) {
  const fn = new AsyncFunction("$input", "$env", "$vars", jsCode(name));
  const input = { all: () => items, first: () => items[0] };
  const helpers = {
    // What n8n gives a Code node for emitting a file. The stub keeps the bytes in the returned
    // object so a test can assert the summary is attached as binary, not merely left in JSON.
    prepareBinaryData: async (buf, fileName, mimeType) => ({
      data: Buffer.isBuffer(buf) ? buf.toString("base64") : String(buf),
      fileName,
      mimeType,
    }),
  };
  return fn.call({ helpers }, input, {}, {});
}

/** A priced, measured candidate, shaped as the Cost engine emits it. */
const costItem = (over = {}) => ({
  json: {
    name: "GPT-4o mini",
    slug: "openai/gpt-4o-mini",
    route: "A",
    source: "openrouter",
    provider: null,
    incumbent: true,
    passed: false,
    share: 12 / 14,
    correct: 12,
    scored: 14,
    total: 14,
    fabricated: 1,
    p50: 1404,
    p95: 2394,
    cost_per_call_usd: 0.0002,
    monthly_cost_usd: 4.0,
    priced: true,
    fail_reasons: ["1 fabricated answer, above the limit of 0"],
    measured_input_tokens_per_call: 3000,
    measured_output_tokens_per_call: 18,
    measured_cached_input_tokens_per_call: 2944,
    pricing: { input_per_m: 0.15, output_per_m: 0.6, cache_read_per_m: 0.075 },
    validation: {
      input_per_m: 0.15,
      output_per_m: 0.6,
      cache_read_per_m: 0.075,
      providers_live: null,
      tier_min_prompt_tokens: null,
    },
    ...over,
  },
});

test("every Code node parses as an async function", () => {
  for (const node of workflow.nodes) {
    if (node.type !== "n8n-nodes-base.code") continue;
    assert.doesNotThrow(() => {
      // eslint-disable-next-line no-new-func
      new AsyncFunction("$input", "$env", "$vars", node.parameters.jsCode);
    }, `${node.name} does not parse`);
  }
});

test("Three routes carries the candidates forward, it does not replace them", async () => {
  const out = await runNode("Three routes", [
    costItem(),
    costItem({ name: "GPT-5 Mini", slug: "openai/gpt-5-mini", incumbent: false }),
  ]);

  assert.equal(out.length, 1, "the route table should be one item, not one item per row");
  assert.ok(Array.isArray(out[0].json.routes), "no route rows");
  assert.ok(Array.isArray(out[0].json.candidates), "the candidates were dropped, and the ledger needs them");
  assert.equal(out[0].json.candidates.length, 2);

  const routeC = out[0].json.routes.find((r) => r.route === "C");
  assert.ok(routeC, "route C is missing");
  assert.equal(routeC.monthly_cost_usd, null, "route C must never carry a monthly price");
});

test("the ledger reads the carried candidates and builds the gap", async () => {
  const routes = await runNode("Three routes", [costItem()]);
  const out = await runNode("Estimate vs measured", routes);
  const ledger = out[0].json;

  assert.equal(ledger.available, true);
  assert.equal(ledger.incumbent, "GPT-4o mini");
  assert.equal(ledger.stated_estimate_usd, 18);
  assert.ok(ledger.own_assumptions_usd > 0, "the buyer's own assumptions were not priced");
  assert.equal(ledger.steps.length, 3);
  assert.ok(ledger.routes.length >= 2, "the route table did not travel with the ledger");
});

test("the render node produces the summary, with the routes on it", async () => {
  const routes = await runNode("Three routes", [costItem()]);
  const ledger = await runNode("Estimate vs measured", routes);
  const out = await runNode("Render summary HTML", ledger);
  const { html, filename } = out[0].json;

  assert.equal(filename, "cost-route-summary.html");
  assert.match(html, /Cost-Route: a measured decision from n8n/);
  assert.match(html, /The three procurement routes/);
  assert.match(html, /GPT-4o mini/);
  // The file the Read/Write File node writes is built here. A Convert to File node downstream once
  // turned this same string into 14 bytes of garbage, so the bytes are asserted where they are made.
  assert.ok(out[0].binary?.data, "the summary was not attached as binary");
  assert.equal(out[0].binary.data.fileName, "cost-route-summary.html");
  assert.equal(out[0].binary.data.mimeType, "text/html");
  assert.ok(out[0].binary.data.data.length > 1000, "the binary payload is suspiciously small");
});

test("a ledger with nothing priced degrades to a reason instead of throwing", async () => {
  const out = await runNode("Estimate vs measured", [{ json: { routes: [], candidates: [] } }]);
  assert.equal(out[0].json.available, false);
  assert.match(out[0].json.reason, /no priced candidate/);

  const rendered = await runNode("Render summary HTML", out);
  assert.match(rendered[0].json.html, /no priced candidate reached the ledger/);
});

/** A call item shaped as the "Call candidates" node emits it. */
const callItem = (over = {}) => ({
  json: {
    candidate: "GPT-4o mini",
    slug: "openai/gpt-4o-mini",
    route: "A",
    source: "openrouter",
    provider: null,
    incumbent: true,
    question_id: "term-length",
    question_kind: "fact",
    accept: ["24[\\s-]*months?", "twenty[\\s-]*four[\\s-]*months?"],
    reject: [],
    status: 200,
    latency_ms: 1500,
    answer: "The Initial Term is twenty-four (24) months, expiring 28 February 2028.",
    usage: { prompt_tokens: 3000, completion_tokens: 18, prompt_tokens_details: { cached_tokens: 2944 } },
    error: null,
    ...over,
  },
});

test("the gate scores a parenthetical numeral as correct, the way the repo does", async () => {
  // The exact regression: before the port, this answer scored incorrect, because the pattern list
  // expects "24 months" or "twenty-four months" and the model wrote "twenty-four (24) months".
  const out = await runNode("Score: the quality gate", [callItem()]);
  const c = out[0].json;
  assert.equal(c.correct, 1, "a correct parenthetical answer was scored wrong");
  assert.equal(c.fabricated, 0);
  assert.equal(c.share, 1);
  // Interpolated percentile, same definition as the repo: one value, so p50 is that value.
  assert.equal(c.p50, 1500);
  assert.equal(c.passed, true, "a single correct answer should clear the bar");
});

