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
