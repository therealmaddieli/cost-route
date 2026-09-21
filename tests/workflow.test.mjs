/**
 * The published n8n workflow, checked at the level a reader of the repository would care about:
 * it carries no secrets, it does not depend on n8n configuration that is off by default, and every
 * connection points at a node that exists.
 *
 * The env-access assertion is not hypothetical. n8n 2.x blocks `$env` inside nodes by default
 * (`process.env.N8N_BLOCK_ENV_ACCESS_IN_NODE !== 'false'` in n8n-workflow), so a Code node reading
 * `$env.OPENROUTER_API_KEY` throws "access to env vars denied" at run time on a default instance,
 * including n8n Cloud. `$vars` is available in Code nodes, so Variables are read first and the
 * environment is a guarded self-hosted fallback.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const workflow = JSON.parse(fs.readFileSync(path.join(root, "workflow.json"), "utf8"));
const byName = (name) => workflow.nodes.find((n) => n.name === name);
const callNode = byName("Call candidates (timed)");

test("the workflow carries no credential or key material", () => {
  const text = JSON.stringify(workflow);
  for (const bad of ["sk-or-", "hf_", "bfl_", "ghp_", "AIza"]) {
    assert.equal(text.includes(bad), false, `workflow.json contains ${bad}`);
  }
  // Credential stanzas reference instance-specific ids and do not travel. The workflow reads
  // Variables (or the environment) instead, so an import needs no credential wiring.
  assert.equal(text.includes("credential"), false, "a credential stanza would not travel between instances");
});

test("key lookup reads n8n Variables first and cannot crash on blocked env access", () => {
  const code = callNode.parameters.jsCode;
  assert.ok(code.includes("function secret(name)"), "the guarded lookup is gone");
  assert.ok(
    code.indexOf("$vars[name]") < code.indexOf("$env[name]"),
    "the environment is read before n8n Variables"
  );
  assert.equal(
    code.includes('const env = (typeof $env === "undefined"'),
    false,
    "the unguarded env read that throws by default is back"
  );
  // A blocked $env throws rather than returning undefined, so both reads have to be inside try.
  assert.ok(code.includes("/* env access blocked by default */"));
});

test("every connection points at a node that exists", () => {
  const names = new Set(workflow.nodes.map((n) => n.name));
  for (const [from, branches] of Object.entries(workflow.connections)) {
    assert.ok(names.has(from), `connection source is missing: ${from}`);
    for (const branch of branches.main || []) {
      for (const c of branch || []) {
        assert.ok(names.has(c.node), `${from} points at a node that does not exist: ${c.node}`);
      }
    }
  }
});

test("the workflow has a manual trigger and the four documented gate nodes", () => {
  // The four steps are the product. If a future edit drops one, the canvas still looks plausible
  // and the argument silently disappears.
  for (const name of [
    "Manual Trigger",
    "Plan the run",
    "Call candidates (timed)",
    "Score: the quality gate",
    "Cost engine",
    "Three routes",
    "Estimate vs measured",
    "Render summary HTML",
  ]) {
    assert.ok(byName(name), `node is missing: ${name}`);
  }
});

test("the workload is supplied, not baked in: three entry points reach one normaliser", () => {
  // The whole point of the refactor. Before it, the contract, golden set, criteria and shortlist
  // were string literals inside "Plan the run", so changing them meant editing JavaScript.
  const targets = (name) => workflow.connections[name].main.flat().map((c) => c.node);
  for (const entry of ["Form: your workload", "Webhook: POST a workload", "Sample workload (demo)"]) {
    assert.deepEqual(targets(entry), ["Normalise workload"], `${entry} does not reach the normaliser`);
  }
  assert.ok(byName("Normalise workload"), "the normaliser is gone");
  assert.deepEqual(targets("Manual Trigger"), ["Sample workload (demo)"]);
});

test("no pipeline node carries a hard-coded workload", () => {
  // The sample node is allowed to embed one; nothing else may. If a future edit reintroduces a
  // literal, the workflow stops being usable on a customer's own workload without a code change.
  for (const node of workflow.nodes) {
    if (node.type !== "n8n-nodes-base.code") continue;
    if (node.name === "Sample workload (demo)") continue;
    assert.equal(
      /const WORKLOAD\s*=|WORKLOAD_[A-Z_]+/.test(node.parameters.jsCode),
      false,
      `${node.name} still reads a hard-coded workload`
    );
  }
});

test("both catalogues and the workload merge before the planning node", () => {
  // n8n runs a node once per incoming branch. Feeding the planning node straight from the HTTP
  // nodes made it run twice: once with both catalogues (which built the calls) and once with only
  // the HF catalogue, which found no OpenRouter models, threw, and marked the run failed. The Merge
  // is the fix, and now it carries the workload as its third input too.
  const merge = byName("Merge catalogues");
  assert.ok(merge, "the Merge node is gone");
  assert.equal(merge.type, "n8n-nodes-base.merge");
  assert.equal(merge.parameters.numberInputs, 3);

  const targets = (name) => workflow.connections[name].main.flat();
  assert.deepEqual(targets("OpenRouter catalogue").map((c) => [c.node, c.index]), [["Merge catalogues", 0]]);
  assert.deepEqual(targets("HF router catalogue").map((c) => [c.node, c.index]), [["Merge catalogues", 1]]);
  assert.deepEqual(targets("Merge catalogues").map((c) => c.node), ["Plan the run"]);

  // The workload reaches the merge directly, not through the HTTP nodes, which replace their input
  // with the response and would drop it.
  const fromNormaliser = targets("Normalise workload").map((c) => [c.node, c.index]);
  assert.deepEqual(fromNormaliser, [
    ["OpenRouter catalogue", 0],
    ["HF router catalogue", 0],
    ["Merge catalogues", 2],
  ]);
});

test("the quality gate normalises answers the way core/scorer.mjs does", () => {
  // This port exists because the first n8n gate scored GPT-4o mini 5/14 where the repo scored
  // 12/14: contracts spell numbers as "twenty-four (24) months" and no number-then-unit pattern
  // matches with a ")" between them. If this normalisation is dropped the workflow starts
  // contradicting the published page about the same answers, which is worse than being slow.
  const code = byName("Score: the quality gate").parameters.jsCode;
  assert.ok(code.includes("function normalise"), "the normalisation step is gone");
  assert.ok(code.includes("u0060"), "the markdown strip is gone");
  assert.ok(code.includes("(v.length - 1) * p"), "the percentile is not the interpolated one the repo uses");
  assert.ok(code.includes("needs_review"), "the needs_review outcome is gone");
});
