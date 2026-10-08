#!/usr/bin/env node
/**
 * Scaffold a new workload file from a named archetype.
 *
 *   node scripts/new-workload.mjs <archetype-slug> <output-path> [--name "..."] [--questions N] [--force]
 *   node scripts/new-workload.mjs --list
 *
 * The output is a starter workload JSON file with the archetype's typical token ratio already in
 * buyer_estimate and a golden_set scaffold of placeholder questions - not a finished workload. The
 * fields still missing are printed after writing, the same "name what's missing" style the n8n
 * Normalise-workload node uses for a rejected submission.
 */

import fs from "node:fs";
import path from "node:path";

import { ARCHETYPES, scaffoldWorkload } from "../core/archetypes.mjs";

const argv = process.argv.slice(2);

function listArchetypes() {
  console.log("Available archetypes:\n");
  for (const a of Object.values(ARCHETYPES)) {
    console.log(`  ${a.slug}`);
    console.log(`    ${a.label} - ${a.description}`);
  }
}

if (argv.includes("--list") || argv.length === 0) {
  listArchetypes();
  process.exit(argv.length === 0 ? 1 : 0);
}

const [slug, outPath, ...rest] = argv.filter((a) => !a.startsWith("--"));
const force = argv.includes("--force");
const nameIdx = argv.indexOf("--name");
const name = nameIdx !== -1 ? argv[nameIdx + 1] : undefined;
const questionsIdx = argv.indexOf("--questions");
const questionCount = questionsIdx !== -1 ? Number(argv[questionsIdx + 1]) : undefined;

if (!slug || !outPath) {
  console.error("usage: node scripts/new-workload.mjs <archetype-slug> <output-path> [--name \"...\"] [--questions N] [--force]");
  console.error("");
  listArchetypes();
  process.exit(1);
}

if (!ARCHETYPES[slug]) {
  console.error(`error: unknown archetype "${slug}"\n`);
  listArchetypes();
  process.exit(1);
}

if (fs.existsSync(outPath) && !force) {
  console.error(`error: ${outPath} already exists. Pass --force to overwrite.`);
  process.exit(1);
}

const workload = scaffoldWorkload(slug, { name, questionCount });

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(workload, null, 2) + "\n");

console.log(`Wrote ${outPath} from the "${slug}" archetype.`);
console.log("");
console.log("Still missing before this is a real workload:");
console.log("  - sample_input_path: point it at the real document, or replace with a `prompt` for an image workload");
console.log("  - golden_set: every item is a TODO placeholder - replace question/expected/accept with the real ones");
console.log("  - candidates: empty - add at least one {name, slug, source, route}");
console.log("  - buyer_estimate.assumed_cost_per_month_usd and .note: replace the archetype default with the buyer's own stated numbers");
