#!/usr/bin/env node
/**
 * Cost-Route step 4b: the publishable variant of the report.
 *
 *   node scripts/artifact.mjs                 # out/report.html -> out/report-artifact.html
 *   node scripts/artifact.mjs --title "..."   # override the page name
 *
 * The report is authored as a standalone document: doctype, html, head, body, its own viewport
 * meta. That is correct for a file someone opens from disk, and it is not what a hosting page that
 * wraps the file in its own document skeleton wants. Nested document tags are ignored by a browser
 * rather than rejected, so the failure is quiet: a duplicated viewport meta and a head element
 * opened inside a body, on a page that still renders well enough that nobody looks.
 *
 * So this strips the skeleton and keeps what the page actually is: the title, one style block, the
 * markup, and the one script. Nothing else changes. Every figure, every word and the whole client
 * script are passed through byte for byte, so the published page and the local file cannot drift
 * apart in content, only in their outer shell.
 *
 * It fails loudly rather than writing a half-transformed file. Every step asserts on the shape it
 * expects, because the alternative is a published page with a stray `</head>` in it.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const argv = process.argv.slice(2);
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i === -1 ? fallback : argv[i + 1];
};

const inFile = path.join(root, option("--in", "out/report.html"));
const outFile = path.join(root, option("--out", "out/report-artifact.html"));
// A name, not a caption. The report's own title names the workload, which is right for a document
// and wrong for a page in a list of pages, where the subject is on the card underneath.
const TITLE = option("--title", "Cost-Route Legal Review");

if (!fs.existsSync(inFile)) {
  console.error(`\n${path.relative(root, inFile)} does not exist. Run scripts/report.mjs first.`);
  process.exit(1);
}

const html = fs.readFileSync(inFile, "utf8");

/** Take the one thing out, or throw. A transform that silently matches nothing is how this breaks. */
function cut(source, pattern, what) {
  const m = source.match(pattern);
  if (!m) throw new Error(`Could not find ${what} in ${path.relative(root, inFile)}.`);
  return m[0];
}

const doctype = cut(html, /<!doctype html>\n/i, "the doctype");
const headOpen = cut(html, /<html lang="[^"]*">\n<head>\n/, "the <head> block");
const metas = cut(html, /<meta charset="utf-8">\n<meta name="viewport"[^>]*>\n/, "the meta tags");
const title = cut(html, /<title>[\s\S]*?<\/title>\n/, "the <title>");
const headClose = cut(html, /<\/head>\n<body>\n/, "the </head> and <body>");
const bodyClose = cut(html, /<\/body>\n<\/html>\n?$/, "the closing tags");

const content = html
  .replace(doctype, "")
  .replace(headOpen, "")
  .replace(metas, "")
  .replace(title, `<title>${TITLE}</title>\n`)
  .replace(headClose, "")
  .replace(bodyClose, "");

// The whole point of the exercise. If any of these survived, the file is still a document.
for (const [pattern, what] of [
  [/<!doctype/i, "a doctype"],
  [/<html[\s>]/i, "an <html> tag"],
  [/<head[\s>]/i, "<head>"],
  [/<body[\s>]/i, "<body>"],
  [/<meta[\s>]/i, "a meta tag"],
]) {
  if (pattern.test(content)) throw new Error(`The output still contains ${what}.`);
}

// And the things that must have survived, because a page stripped down to nothing is worse than a
// page with a stray tag in it.
for (const [needle, what] of [
  ["<style>", "the stylesheet"],
  ["<script>", "the client script"],
  ['class="wrap"', "the page body"],
  ["var DATA = ", "the embedded data"],
]) {
  if (!content.includes(needle)) throw new Error(`The output lost ${what}.`);
}

fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, content);

const kb = (n) => `${(Buffer.byteLength(n) / 1024).toFixed(1)} KB`;
console.log(`Cost-Route: artifact variant`);
console.log(`  read   ${path.relative(root, inFile)} (${kb(html)})`);
console.log(`  wrote  ${path.relative(root, outFile)} (${kb(content)})`);
console.log(`  title  ${TITLE}`);
console.log(`  shell  stripped: doctype, html, head, meta, body`);
