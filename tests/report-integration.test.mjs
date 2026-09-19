/**
 * Day 4 tests: the generator, run for real.
 *
 * Every other test in this directory exercises a module. This one runs `scripts/report.mjs` end to
 * end against the saved catalogue and the saved benchmark and inspects the HTML it writes, because
 * the bugs that actually shipped on Day 4 were not module bugs. They were wiring bugs: a field one
 * module reads and another never sets, an object passed where its key was wanted, a cost sum used
 * as a per-call price. Each module was correct in isolation and the page was wrong.
 *
 * No network. Both inputs are read from out/, and the generator defaults to the cached catalogue,
 * so this runs offline and reproduces the same page from the same files.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const outDir = path.join(root, "out");

const catalogue = path.join(outDir, "catalogue-latest.json");
const benchmark = fs
  .readdirSync(fs.existsSync(outDir) ? outDir : root)
  .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
  .sort()
  .map((f) => path.join(outDir, f))
  .pop();

// Both inputs are artefacts of a live run, not fixtures. Without them there is nothing to
// regenerate and the test would be asserting against a page it silently made up, so it says so.
const ready = fs.existsSync(catalogue) && benchmark;

/** Generate a report into a temp file and return its HTML. */
function generate() {
  const target = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cost-route-")), "report.html");
  execFileSync(process.execPath, ["scripts/report.mjs", "--out", target], {
    cwd: root,
    stdio: "pipe",
  });
  return fs.readFileSync(target, "utf8");
}

/** Generate with extra arguments into a directory of the caller's choosing, keeping the console output. */
function generateWith(extra, dir) {
  const target = path.join(dir, "report.html");
  const stdout = execFileSync(process.execPath, ["scripts/report.mjs", ...extra, "--out", target], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
  return { html: fs.readFileSync(target, "utf8"), stdout };
}

const routesSection = (html) => {
  const start = html.indexOf("The three procurement routes");
  assert.notEqual(start, -1, "the routes section is missing from the page");
  return html.slice(start, html.indexOf("What this page cannot tell you", start));
};

test("the generator runs against the saved inputs and writes a page", { skip: !ready }, () => {
  const html = generate();
  assert.ok(html.includes("<!doctype html>"));
  assert.ok(html.includes("<!doctype html>") && html.length > 20000, "the page came out truncated");
});

test("no row renders an object where a value belongs", { skip: !ready }, () => {
  // routeFor returns the ROUTES record, not its id. It was passed straight through, and every row
  // in the routes table printed "[object Object]" as its route. The page still rendered, still
  // parsed, and every unit test passed, because a renderer handed the wrong shape of thing will
  // happily stringify it.
  const html = generate();
  assert.equal(html.includes("[object Object]"), false, "an object was stringified into the page");
  assert.equal(html.includes(">undefined<"), false, "an undefined value was written into the page");
  assert.equal(html.includes(">null<"), false, "a null was written into the page");
});

test("every route with a measured profile carries a monthly figure", { skip: !ready }, () => {
  // The field buildRouteTable reads was never set by the generator, so the entire Monthly column
  // rendered as n/a for rows the candidates table priced to the cent. Nothing threw. The column was
  // just empty, and a reader would conclude the catalogue carries no prices.
  const section = routesSection(generate());
  const monthlies = [...section.matchAll(/<span class="num">\$([\d,.]+)<\/span>/g)].map((m) => m[1]);

  assert.ok(monthlies.length >= 2, `expected priced rows, found ${monthlies.length}`);
  for (const m of monthlies) {
    assert.notEqual(Number(m.replace(/,/g, "")), 0, "a route was priced at exactly nothing");
  }
  // And the rows that genuinely have no measurement say why, rather than showing a blank cell.
  if (section.includes("no measured profile on this route")) {
    assert.ok(section.includes("not priced"), "an unmeasured row showed an unexplained blank");
  }
});

test("the routes table agrees with the ledger on the incumbent, to the cent", { skip: !ready }, () => {
  // The check that would have caught the 23x error. Two sections of one page priced the same model
  // at $4.80 and $67.18 a month while both called their figure a price. Each was internally
  // consistent; only the reader comparing them would have seen it.
  const html = generate();

  const headline = html.match(/The measurement then says\s*<strong>\$([\d.]+)<\/strong>/);
  assert.ok(headline, "the ledger headline is missing its measured figure");
  const measured = Number(headline[1]);

  const section = routesSection(html);
  const routeMonthly = [...section.matchAll(/<span class="num">\$([\d,.]+)<\/span>/g)].map((m) =>
    Number(m[1].replace(/,/g, ""))
  );

  assert.ok(
    routeMonthly.includes(measured),
    `the ledger says $${measured}/month and the routes table offers ${routeMonthly.join(", ")}`
  );
});

test("the page is still self-contained after generation", { skip: !ready }, () => {
  const html = generate();
  assert.equal(/<script[^>]+src=/i.test(html), false);
  assert.equal(/<link[^>]+stylesheet/i.test(html), false);
  // Same refinement as report.test.mjs: outbound anchors are navigation, not subresources, and the
  // closing section exists so a reader can reach the repository.
  assert.equal(
    /https?:\/\/(?!www\.w3\.org)/i.test(html.replace(/<a\b[^>]*>/gi, "").replace(/href="#[^"]*"/g, "")),
    false
  );
});

// ---------------------------------------------------------------------------
// what the page says about the runs, cross-checked against the payload it ships
// ---------------------------------------------------------------------------

/**
 * The model the page embeds for its own client script. Reading it back is the point: every
 * assertion below compares what a reader sees with what the page itself was told, so the test is
 * about the wiring rather than about this particular benchmark's numbers. Re-run the benchmark and
 * the numbers move; the agreement has to hold either way.
 */
function embeddedData(html) {
  const m = html.match(/var DATA = (\{[\s\S]*?\});\n/);
  assert.ok(m, "the page no longer embeds its data in the expected shape");
  const data = JSON.parse(m[1]);

  // Every workload's candidates, in tab order, because the page now renders more than one and a
  // check that only ever looked at the first would silently stop covering the second the day it was
  // added. The flat shape is still read as a fallback so this keeps working if the payload ever goes
  // back to one workload.
  data.candidates = data.workloads
    ? data.workloads.flatMap((w) => w.candidates)
    : (data.candidates ?? []);
  return data;
}

test("every rendered quality fraction matches the payload, counted over answered calls", { skip: !ready }, () => {
  const html = generate();
  const measured = embeddedData(html).candidates.filter((c) => c.quality);

  assert.ok(measured.length, "no candidate carried a measured quality record");
  for (const c of measured) {
    const q = c.quality;
    assert.ok(
      html.includes(`${q.correct}/${q.scored}</span> correct`),
      `${c.name}: the page does not print ${q.correct}/${q.scored} correct`
    );
    // The exact bug: correct over the run count, which counts a failed call as a wrong answer.
    if (q.scored !== q.total) {
      assert.equal(
        html.includes(`${q.correct}/${q.total}</span> correct`),
        false,
        `${c.name}: quality is still divided by the run count, not by the calls that answered`
      );
    }
  }
});

test("every failed call is visible on the page, with the status code it failed with", { skip: !ready }, () => {
  const html = generate();
  const measured = embeddedData(html).candidates.filter((c) => c.quality);

  let anyFailure = false;
  for (const c of measured) {
    const q = c.quality;
    if (!q.not_served) continue;
    anyFailure = true;
    assert.ok(
      html.includes(`${q.scored}/${q.total}</span>`),
      `${c.name}: ${q.not_served} failed calls are not shown in the Served column`
    );
    for (const [code, n] of Object.entries(q.error_kinds ?? {})) {
      const label = code === "unknown" ? `${n} unclassified` : `HTTP ${code} x${n}`;
      assert.ok(html.includes(label), `${c.name}: the page does not say why the calls failed (${label})`);
    }
  }

  // Not a skipped assertion in disguise. If the saved benchmark happens to have a clean run, the
  // column is still exercised by the module tests, and this says so rather than passing silently.
  if (!anyFailure) console.log("# note: this benchmark run has no failed calls to display");
});

test("the per-kind cut reaches the page from the same runs", { skip: !ready }, () => {
  const html = generate();
  const measured = embeddedData(html).candidates.filter((c) => c.quality?.by_kind?.length);
  assert.ok(measured.length, "no candidate carried a per-kind breakdown");

  assert.ok(html.includes("cut by question kind"), "the per-kind table is missing from the page");
  for (const c of measured) {
    const kinds = c.quality.by_kind;
    const totalAsked = kinds.reduce((a, b) => a + b.asked, 0);
    // Every run is accounted for in exactly one kind. A kind breakdown that quietly loses runs is
    // worse than no breakdown, because the columns still look complete.
    assert.equal(
      totalAsked,
      c.quality.total,
      `${c.name}: the kinds account for ${totalAsked} of ${c.quality.total} runs`
    );
    for (const b of kinds) {
      assert.equal(b.scored + b.not_served, b.asked, `${c.name}: ${b.kind} does not add up`);
      assert.equal(b.correct + b.incorrect, b.scored, `${c.name}: ${b.kind} does not add up`);
    }
  }
});

test("every failing candidate's reasons are on the page, not only the incumbent's", { skip: !ready }, () => {
  const html = generate();
  const candidates = embeddedData(html).candidates;
  const failing = candidates.filter((c) => String(c.quality?.verdict ?? "").toUpperCase() === "FAIL");

  assert.ok(failing.length, "no candidate failed the bar in this run");
  for (const c of failing) {
    for (const reason of c.quality.fail_reasons ?? []) {
      assert.ok(html.includes(reason.replace(/&/g, "&amp;")), `${c.name}: the page omits "${reason}"`);
    }
  }
});

// ---------------------------------------------------------------------------
// the image tab, against the run that actually produced it
// ---------------------------------------------------------------------------

/**
 * The picture workload is a second benchmark file with its own `workload_kind`. Found by reading the
 * files rather than by parsing a timestamp out of a filename, so this keeps working the next time
 * the benchmark is re-run.
 */
const imageBenchmark = fs
  .readdirSync(fs.existsSync(outDir) ? outDir : root)
  .filter((f) => f.startsWith("benchmark-") && f.endsWith(".json"))
  .map((f) => path.join(outDir, f))
  .find((f) => {
    try {
      return JSON.parse(fs.readFileSync(f, "utf8")).workload_kind === "image";
    } catch {
      return false;
    }
  });

const imagesDir = path.join(root, "samples", "images");
const imageReady = ready && Boolean(imageBenchmark) && fs.existsSync(imagesDir);

const imageWorkload = (html) => {
  const w = embeddedData(html).workloads?.find((x) => x.kind === "image");
  assert.ok(w, "the image workload is not on the page");
  return w;
};

test("the page carries a tab per workload, each with its own candidates", { skip: !imageReady }, () => {
  const data = embeddedData(generate());
  assert.ok(data.workloads?.length >= 2, `only ${data.workloads?.length} workload reached the page`);

  const image = imageWorkload(generate());
  assert.ok(image.name, "the image tab has no name");
  // One candidate is not a comparison. The whole value of this tab is that the two models bill
  // differently for the same sentence.
  assert.ok(image.candidates.length >= 2, `the image tab has ${image.candidates.length} candidates`);
  for (const c of image.candidates) {
    assert.ok(c.image_summary, `${c.name} has no image summary, so the tab has nothing to show`);
  }
});

test("an image candidate reports no quality rather than a zero", { skip: !imageReady }, () => {
  const image = imageWorkload(generate());

  for (const c of image.candidates) {
    // There is no golden set for a generated picture, so `quality` is null by construction. A zero
    // would render as "0/0 correct", which is a claim about quality nobody made.
    assert.equal(c.quality, null, `${c.name} carries a quality record it cannot have`);
    assert.equal(c.image_summary.quality_scored, false, `${c.name} claims to be machine-scored`);

    // And because quality is null, the gate verdict has to travel on its own or a gated run would
    // read as an ungated one.
    assert.ok(c.gate && c.gate.verdict, `${c.name} lost its gate verdict`);
    assert.ok(
      (c.gate.not_applied ?? []).some((n) => n.includes("no golden set")),
      `${c.name} does not say which check was skipped`
    );
  }

  // The page must not print a quality column for a workload that has none.
  assert.equal(
    /<\/span> correct/.test(generate().slice(generate().indexOf('data-workload="1"'))),
    false,
    "the image tab rendered a correct-share for a workload with no golden set"
  );
});

test("the pictures are embedded on the page and the payload does not ship them twice", { skip: !imageReady }, () => {
  const html = generate();
  const image = imageWorkload(html);

  const returned = image.candidates.reduce((a, c) => a + (c.image_summary?.images_returned ?? 0), 0);
  assert.ok(returned >= 2, `the run returned ${returned} pictures to show`);
  assert.equal(
    [...html.matchAll(/<figure class="shot">/g)].length,
    returned,
    "the page does not show one figure per returned picture"
  );

  // Each picture is a base64 data URI in the markup, as the img src. Carrying the same bytes in the
  // embedded JSON as well ships every picture twice, which took this page from 5.0 MB to 9.8 MB.
  const payload = html.match(/var DATA = (\{[\s\S]*?\});\n/)[1];
  assert.equal(payload.includes("data:image"), false, "the payload ships the picture bytes a second time");
});

test("the embedded pictures are the committed files, byte for byte", { skip: !imageReady }, () => {
  const html = generate();
  const files = fs.readdirSync(imagesDir).filter((f) => f.endsWith(".png")).sort();
  assert.ok(files.length >= 2, "no pictures are committed, so the demo report has nothing to show");

  // The n8n canvas screenshot is the fifth embedded image and is deliberately not one of the
  // workload's pictures. Strip it first, or this test would demand that a committed model output
  // also exist as the canvas, which is a different file that means a different thing.
  const withoutCanvas = html.replace(/<img class="canvas"[^>]*>/g, "");
  const embedded = new Set(
    [...withoutCanvas.matchAll(/src="data:image\/png;base64,([A-Za-z0-9+/=]+)"/g)].map((m) => m[1])
  );
  assert.equal(
    embedded.size,
    files.length,
    `the page shows ${embedded.size} pictures and ${files.length} are committed`
  );
  for (const f of files) {
    const b64 = fs.readFileSync(path.join(imagesDir, f)).toString("base64");
    assert.ok(embedded.has(b64), `${f} is committed but is not one of the pictures the page shows`);
  }
});

test("a malformed shortlist entry is named and skipped, not thrown", { skip: !imageReady }, () => {
  // The workload file is hand-edited, so a null left by a stray comma and a slug written without
  // its object are both edits a person makes by accident. Reading `.slug` off either one threw out
  // of the generator and produced no page at all, over one bad line in a file that was otherwise
  // fine. This runs the generator for real, because the throw was in the wiring: the validator was
  // never the thing reading this file.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cost-route-bad-"));
  const workload = JSON.parse(
    fs.readFileSync(path.join(root, "samples", "workload.image.json"), "utf8")
  );
  workload.candidates = [...workload.candidates, null, "openai/gpt-5-image-mini"];
  const file = path.join(dir, "workload.bad.json");
  fs.writeFileSync(file, JSON.stringify(workload, null, 2));

  const { html, stdout } = generateWith(["--workload", file], dir);

  assert.match(stdout, /MALFORMED/, "the bad entry was not named in the run's output");
  assert.equal(stdout.includes("TypeError"), false, "the run reported a stack trace");
  assert.ok(html.includes("<!doctype html>") && html.length > 20000, "no page was written");

  // Degraded rather than truncated: the entries that were fine are still priced and still on the
  // tab. A run that survives by dropping the whole shortlist is not a run that survived.
  const image = embeddedData(html).workloads.find((w) => w.kind === "image");
  assert.equal(image.candidates.length, 2, "a good candidate went down with the bad one");
});

test("each returned picture is shown with its own run's numbers, not an average", { skip: !imageReady }, () => {
  const html = generate();
  const image = imageWorkload(html);

  for (const c of image.candidates) {
    // The run-to-run variation is the finding on this tab: identical image token counts, different
    // bills, and a latency spread of several times. An average would hide exactly that.
    const runs = c.image_summary.latency_ms;
    assert.ok(runs.min <= runs.median && runs.median <= runs.max, `${c.name} has an impossible spread`);

    for (const ms of [runs.min, runs.max]) {
      assert.ok(
        html.includes(`${ms.toLocaleString("en-US")}</b> ms`),
        `${c.name}: the ${ms}ms run is not printed on its own`
      );
    }
  }
});
