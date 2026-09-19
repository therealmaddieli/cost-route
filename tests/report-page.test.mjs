/**
 * Day 4 tests: the report page actually runs.
 *
 * report.test.mjs checks the page's arithmetic by calling the client function directly. This file
 * checks something different and much weaker-looking but easy to get wrong: that the script the
 * page ships, wired to the DOM the page ships, produces the right numbers on a real render.
 *
 * A syntax check is not enough. A page can parse perfectly and still write "n/a" into every field
 * because an element id was renamed, or throw on the first render because a field it expects is
 * absent. Neither shows up in a syntax check and neither shows up in a unit test of the arithmetic,
 * and both produce a page that looks broken to a reader without telling anyone why.
 *
 * So this runs the page's own script against a stub DOM and reads what it wrote.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { normaliseOpenRouterModel } from "../core/catalogue.mjs";
import { buildReportModel, renderReportHtml } from "../core/report.mjs";
import { buildLedger } from "../core/ledger.mjs";

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

const incumbentModel = () =>
  normaliseOpenRouterModel({
    id: "openai/gpt-4o-mini",
    canonical_slug: "openai/gpt-4o-mini",
    name: "GPT-4o mini",
    context_length: 128000,
    architecture: { input_modalities: ["text"], output_modalities: ["text"] },
    pricing: { prompt: "0.00000015", completion: "0.0000006", input_cache_read: "0.000000075" },
  });

const MEASURED_PROFILE = {
  input_tokens_per_call: 3000,
  cached_input_tokens_per_call: 2944,
  output_tokens_per_call: 18,
  reasoning_tokens_per_call: 0,
  calls_per_month: 20000,
  per_call_counts: { image: 0, web_search: 0, request: 0 },
};

const WORKLOAD = {
  workload_name: "Legal contract review",
  workload_kind: "text",
  task_description: "Answer one question about a commercial contract.",
  monthly_requests: 20000,
  quality_bar: { min_correct_share: 0.75, max_hallucinations: 0 },
  latency_ceiling_ms: 15000,
  buyer_estimate: {
    assumed_input_tokens_per_request: 1500,
    assumed_output_tokens_per_request: 50,
    assumed_cost_per_month_usd: 18.0,
  },
};

function build(over = {}) {
  const model = incumbentModel();
  const entry = {
    key: `openrouter:${model.slug}`,
    model,
    route: "A",
    provider: null,
    incumbent: true,
    measured: MEASURED_PROFILE,
    effective_input_per_m: 0.0764,
    ...over.entry,
  };

  const ledger = buildLedger(model, WORKLOAD.buyer_estimate, MEASURED_PROFILE, 20000, {
    providerNote: "route A does not expose a provider choice",
  });

  const reportModel = buildReportModel({
    workload: WORKLOAD,
    candidates: [entry],
    ledger,
    catalogueMeta: { fetched_at: "2026-09-15T09:00:00.000Z" },
    benchmarkMeta: { run_at: "2026-09-15T08:14:42.871Z", items: 14, path: "out/benchmark.json" },
    generatedAt: "2026-09-15T18:00:00.000Z",
  });

  return { html: renderReportHtml(reportModel), reportModel };
}

/** The one script block the page ships. */
function pageScript(html) {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1, `expected exactly one script block, found ${blocks.length}`);
  return blocks[0];
}

// ---------------------------------------------------------------------------
// a stub DOM, just enough for this page
// ---------------------------------------------------------------------------

function makeElement(id = "") {
  const attrs = {};
  const el = {
    id,
    attrs,
    value: "",
    textContent: "",
    innerHTML: "",
    listeners: {},
    addEventListener(type, fn) {
      (this.listeners[type] ||= []).push(fn);
    },
    // The tab machinery reads and writes attributes on every panel and button. A stub without these
    // made `activate` throw on its first line, so the whole two-tab path - which panel is showing,
    // which tab is marked selected, whether a field is locked - went untested while the module tests
    // all passed. The methods exist here so that path is exercised rather than skipped.
    getAttribute(name) {
      return name in attrs ? attrs[name] : null;
    },
    setAttribute(name, value) {
      attrs[name] = String(value);
    },
    removeAttribute(name) {
      delete attrs[name];
    },
    hasAttribute(name) {
      return name in attrs;
    },
    focus() {
      el.focused = true;
    },
  };
  return el;
}

/**
 * A DOM with the ids the page writes to, plus the tabs, the panels and the candidate rows.
 *
 * `workloads` builds a panel and a row set per workload, which is what makes a tab switch testable:
 * with only workload 0 present, `activate` had nothing to switch between and a two-tab page passed
 * every test in this file. `missing` deletes an element, to prove the page survives a layout that
 * lost one.
 */
function makeDom({ rowCount = 1, missing = [], workloads = 1 } = {}) {
  const ids = [
    "in-volume",
    "in-prompt",
    "in-output",
    "in-estimate",
    "hint-volume",
    "hint-prompt",
    "hint-output",
    "out-measured",
    "out-measured-sub",
    "out-arith",
    "out-arith-note",
    "out-model",
    "out-model-note",
    "out-scope",
    "out-notes",
    "out-panel-name",
    "out-panel-left-h",
    "out-panel-sub",
    "gapbox-model",
    "out-waterfall-ref",
  ];
  const byId = {};
  for (const id of ids) {
    if (!missing.includes(id)) byId[id] = makeElement(id);
  }

  const cells = [];
  const panels = [];
  const tabs = [];
  const rowsByWorkload = [];

  for (let w = 0; w < workloads; w += 1) {
    if (!missing.includes(`panel-${w}`)) {
      const panel = makeElement(`panel-${w}`);
      panel.setAttribute("data-workload", String(w));
      panels.push(panel);
      byId[`panel-${w}`] = panel;

      const tab = makeElement(`tab-${w}`);
      tab.setAttribute("data-tab", String(w));
      tabs.push(tab);
      byId[`tab-${w}`] = tab;
    }

    const rows = [];
    for (let i = 0; i < rowCount; i += 1) {
      rows.push({
        attributes: { "data-row": String(i) },
        querySelector(sel) {
          const key = sel.includes("per_call") ? "per_call" : "monthly";
          const cell = makeElement(`${key}-${w}-${i}`);
          cells.push(cell);
          return cell;
        },
      });
    }
    rowsByWorkload.push(rows);
  }

  return {
    byId,
    panels,
    tabs,
    cells,
    document: {
      getElementById: (id) => byId[id] ?? null,
      querySelectorAll: (sel) => {
        if (sel === "[data-workload]") return panels;
        if (sel === "[data-tab]") return tabs;
        return [];
      },
      querySelector: (sel) => {
        // The page scopes every row lookup to the panel that owns it, so that a tab switch followed
        // by a render cannot price one workload's inputs against another's candidates.
        const rowMatch = sel.match(/data-row="(\d+)"/);
        if (rowMatch) {
          const w = sel.match(/data-workload="(\d+)"/);
          return (rowsByWorkload[w ? Number(w[1]) : 0] ?? [])[Number(rowMatch[1])] ?? null;
        }
        const tabMatch = sel.match(/^\[data-tab="(\d+)"\]$/);
        if (tabMatch) return tabs[Number(tabMatch[1])] ?? null;
        return null;
      },
    },
  };
}

/** Fire the click a reader would make on a tab, which is the only way the other panel is reached. */
function clickTab(dom, index) {
  const tab = dom.byId[`tab-${index}`];
  assert.ok(tab, `there is no tab ${index} in this DOM`);
  for (const fn of tab.listeners.click ?? []) fn({ target: tab });
  return dom;
}

/**
 * Run the page's script against a stub DOM and return that DOM.
 *
 * `inputs` overrides the shipped defaults, so a test can render the page in a state a reader could
 * reach without simulating typing. Passing `""` is how a test clears a field.
 */
function runPage(html, { inputs = {}, dom = makeDom() } = {}) {
  const doc = dom.document;
  const fn = new Function("document", pageScript(html));
  fn(doc);

  // The overrides are applied AFTER the page has initialised, then the same input event a reader
  // would fire is dispatched. Before the tab machinery this order did not matter, because the page
  // only ever read the fields when one of them changed. It matters now: the page initialises itself
  // by pointing its one panel at the first workload, which writes those defaults back, so a
  // pre-loaded override was being overwritten and every "the reader cleared the box" test was
  // silently exercising the default state instead.
  for (const [id, value] of Object.entries(inputs)) {
    const el = doc.getElementById(id);
    if (!el) continue;
    el.value = String(value);
    for (const listener of el.listeners.input ?? []) listener({ target: el });
  }

  return dom;
}

// ---------------------------------------------------------------------------
// the page renders
// ---------------------------------------------------------------------------

test("the page renders without throwing and writes a monthly figure", () => {
  const { html } = build();
  const dom = runPage(html);

  // The page opens on the buyer's own configuration: 20,000 requests, 1,500 prompt tokens, 50
  // answer tokens, $18. The figure is that configuration priced at measured rates.
  assert.ok(dom.byId["out-measured"].innerHTML.includes("$"), dom.byId["out-measured"].innerHTML);
  assert.equal(dom.byId["out-measured"].innerHTML.includes("–"), false);
  assert.ok(dom.byId["out-arith"].textContent.includes("$"), "no arithmetic gap was written");
  assert.ok(dom.byId["out-model"].textContent.includes("$"), "no cache gap was written");
});

test("the panel's own-assumptions figure reproduces the ledger's, which is the check that it is honest", () => {
  const { html, reportModel } = build();
  const dom = runPage(html);

  // The panel opens on exactly the buyer's stated assumptions, so pricing them must land on the
  // same $5.10 the waterfall reports. If these two ever diverge, the page is contradicting the
  // ledger it is built from.
  const arith = Number(dom.byId["out-arith"].textContent.replace(/[^0-9.]/g, ""));
  assert.ok(Math.abs(arith - 12.9) < 0.02, `expected the $12.90 arithmetic gap, got ${arith}`);

  const ledgerOwn = reportModel.ledger.own_assumptions_usd;
  const estimate = reportModel.workload.buyer_estimate.assumed_cost_per_month_usd;
  assert.ok(
    Math.abs(estimate - ledgerOwn - arith) < 0.02,
    `panel and ledger disagree: ledger implies ${estimate - ledgerOwn}, panel says ${arith}`
  );
});

test("the two gap boxes are different numbers, because caching is only one of them", () => {
  const { html } = build();
  const dom = runPage(html);

  const arith = dom.byId["out-arith"].textContent;
  const cacheGap = dom.byId["out-model"].textContent;

  // If the page priced both boxes with the measured cache rate they would collapse into one
  // figure, and the finding would disappear.
  assert.notEqual(arith, cacheGap);
});

test("the panel says out loud that it is not the measurement", () => {
  const { html } = build();
  const dom = runPage(html);

  // Both figures are correct and they differ, because they price different configurations. Unsaid,
  // that reads as the page contradicting itself.
  assert.ok(dom.byId["out-scope"].textContent.includes("not the measurement"));
  assert.ok(dom.byId["out-measured-sub"].textContent.includes("cache hit rate"));
});

test("moving the volume moves the monthly figure in proportion", () => {
  const { html } = build();
  const at20k = runPage(html, { inputs: { "in-volume": 20000 } });
  const at40k = runPage(html, { inputs: { "in-volume": 40000 } });

  const a = Number(at20k.byId["out-measured"].innerHTML.match(/\$([\d.]+)/)[1]);
  const b = Number(at40k.byId["out-measured"].innerHTML.match(/\$([\d.]+)/)[1]);
  assert.ok(Math.abs(b - a * 2) < 0.02, `${a} doubled should be ${a * 2}, got ${b}`);
});

test("moving the prompt size changes the measured figure", () => {
  const { html } = build();
  const small = runPage(html, { inputs: { "in-prompt": 1000 } });
  const large = runPage(html, { inputs: { "in-prompt": 6000 } });

  const a = Number(small.byId["out-measured"].innerHTML.match(/\$([\d.]+)/)[1]);
  const b = Number(large.byId["out-measured"].innerHTML.match(/\$([\d.]+)/)[1]);
  assert.ok(b > a, `a larger prompt should cost more: ${a} then ${b}`);
});

test("the candidate row is filled in, not left as the em-dash placeholder", () => {
  const { html } = build();
  const dom = runPage(html);
  const perCall = dom.cells.find((c) => c.id.startsWith("per_call"));
  const monthly = dom.cells.find((c) => c.id.startsWith("monthly"));

  assert.ok(perCall.textContent.startsWith("$"), `per-call cell held "${perCall.textContent}"`);
  assert.ok(monthly.textContent.startsWith("$"), `monthly cell held "${monthly.textContent}"`);
});

// ---------------------------------------------------------------------------
// robustness: a reader poking at the page must get a sentence, not a blank
// ---------------------------------------------------------------------------

test("an empty volume is explained rather than rendered as zero", () => {
  const { html } = build();
  const dom = runPage(html, { inputs: { "in-volume": "" } });

  assert.ok(dom.byId["out-notes"].innerHTML.includes("Enter a monthly request volume"));
  // The monthly figure must not silently become $0.00, which would read as "free".
  assert.equal(dom.byId["out-measured"].innerHTML.includes("$0"), false);
});

test("a zero volume is priced at zero and says that is what zero means", () => {
  const { html } = build();
  const dom = runPage(html, { inputs: { "in-volume": 0 } });

  assert.ok(dom.byId["out-measured"].innerHTML.includes("$0.00"));
  assert.ok(dom.byId["out-notes"].innerHTML.includes("Zero requests is a real answer"));
});

test("a negative volume is refused with a reason, not priced", () => {
  const { html } = build();
  const dom = runPage(html, { inputs: { "in-volume": -500 } });

  assert.ok(dom.byId["out-notes"].innerHTML.includes("negative request volume"));
  assert.equal(dom.byId["out-measured"].innerHTML.includes("$-"), false);
});

test("a wildly high volume is priced but flagged as beyond what was measured", () => {
  const { html } = build();
  const dom = runPage(html, { inputs: { "in-volume": 50000000 } });

  assert.ok(dom.byId["out-notes"].innerHTML.includes("ten times the volume"));
  assert.ok(dom.byId["out-measured"].innerHTML.includes("$"));
});

test("an empty prompt size is explained rather than defaulted to something plausible", () => {
  const { html } = build();
  const dom = runPage(html, { inputs: { "in-prompt": "" } });

  assert.ok(dom.byId["out-notes"].innerHTML.includes("Enter a prompt size"));
  // Defaulting to the buyer's 1,500 would be the page inventing an input, which is the one thing
  // it must never do.
  assert.equal(dom.byId["out-measured"].innerHTML.includes("$"), false);
});

test("a prompt beyond the context window is flagged as a call that cannot be made", () => {
  const { html } = build();
  const dom = runPage(html, { inputs: { "in-prompt": 500000 } });

  assert.ok(dom.byId["out-notes"].innerHTML.includes("context window"));
});

test("non-numeric input does not produce NaN on the page", () => {
  const { html } = build();
  const dom = runPage(html, { inputs: { "in-volume": "abc", "in-prompt": "xyz" } });

  assert.equal(dom.byId["out-notes"].innerHTML.includes("NaN"), false);
  assert.equal(dom.byId["out-measured"].innerHTML.includes("NaN"), false);
});

test("a missing estimate is stated as missing, not treated as zero", () => {
  const { html } = build();
  const dom = runPage(html, { inputs: { "in-estimate": "" } });

  assert.ok(dom.byId["out-arith-note"].textContent.includes("enter your own estimate"));
  // Zero would produce a large, confident, meaningless gap against a number nobody gave.
  assert.equal(dom.byId["out-arith"].textContent.includes("$"), false);
});

test("the reasons behind the numbers are written out for the reader", () => {
  const { html } = build();
  const dom = runPage(html);
  const notes = dom.byId["out-notes"].innerHTML;

  // The cached tokens and the rate they were charged at are the substance of the finding, so the
  // page has to say which rate applied rather than only showing a total.
  assert.ok(notes.includes("cached rate") || notes.includes("per million"), notes.slice(0, 300));
});

// ---------------------------------------------------------------------------
// the second tab
// ---------------------------------------------------------------------------

/**
 * The picture the image workload is built around: a one-sentence prompt, and a completion that IS
 * the image. Copied from the 2026-09-17 run against Google's image model.
 */
const IMAGE_PROFILE = {
  input_tokens_per_call: 9,
  cached_input_tokens_per_call: 0,
  output_tokens_per_call: 1290,
  reasoning_tokens_per_call: 0,
  image_tokens_per_call: 1290,
  calls_per_month: 2000,
  per_call_counts: { image: 0, web_search: 0, request: 0 },
};

const IMAGE_WORKLOAD = {
  workload_name: "Image generation",
  workload_kind: "image",
  task_description: "Generate one picture from one sentence.",
  monthly_requests: 2000,
  latency_ceiling_ms: 10000,
  measured_input_tokens_per_call: 9,
  measured_output_tokens_per_call: 1290,
  measured_image_tokens_per_call: 1290,
  buyer_estimate: {
    assumed_input_tokens_per_request: 30,
    assumed_output_tokens_per_request: 1000,
    assumed_cost_per_month_usd: 25.0,
  },
};

/**
 * The other image model from the same run. Its image rate is 4x its text rate where the first
 * model's is 12x, which is the whole reason the factor is computed per row rather than written into
 * the sentence.
 */
const IMAGE_PROFILE_MINI = {
  input_tokens_per_call: 2267,
  cached_input_tokens_per_call: 0,
  output_tokens_per_call: 4175,
  reasoning_tokens_per_call: 0,
  image_tokens_per_call: 4175,
  calls_per_month: 2000,
  per_call_counts: { image: 0, web_search: 0, request: 0 },
};

/**
 * A two-tab page, assembled the way scripts/report.mjs assembles it.
 *
 * `imageIncumbent` picks which of the two image candidates the panel is pointed at. Both models are
 * on both versions of the page; only the subject changes, which is what makes the rate note's
 * factor testable as a per-row figure rather than as a constant.
 */
/**
 * The same workload with nothing measured yet.
 *
 * This is a reachable state, not a contrivance: it is what the page looks like for a workload whose
 * benchmark has not been run, which is every new workload on the day it is added and the state a
 * checkout is in if the paid run fails. Nothing about the panel may claim a measurement that no run
 * produced.
 */
const IMAGE_WORKLOAD_UNMEASURED = {
  ...IMAGE_WORKLOAD,
  measured_input_tokens_per_call: null,
  measured_output_tokens_per_call: null,
  measured_image_tokens_per_call: null,
};

function buildTwo({ imageIncumbent = 0, imageMeasured = true } = {}) {
  const textModel = incumbentModel();
  const imageModel = normaliseOpenRouterModel({
    id: "google/gemini-2.5-flash-image",
    canonical_slug: "google/gemini-2.5-flash-image",
    name: "Gemini 2.5 Flash Image",
    context_length: 32768,
    architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] },
    // The cache-read rate is here on purpose: this model publishes one, so it is the case that
    // proves the image tab's note must not claim image models sell no caching.
    pricing: {
      prompt: "0.0000003",
      completion: "0.0000025",
      input_cache_read: "0.00000003",
      image_output: "0.00003",
    },
  });

  const miniModel = normaliseOpenRouterModel({
    id: "openai/gpt-5-image-mini",
    canonical_slug: "openai/gpt-5-image-mini",
    name: "GPT-5 Image Mini",
    context_length: 32768,
    architecture: { input_modalities: ["text"], output_modalities: ["image", "text"] },
    pricing: {
      prompt: "0.000002",
      completion: "0.000002",
      input_cache_read: "0.0000002",
      image_output: "0.000008",
    },
  });

  const entry = (model, profile, incumbent) => ({
    key: `openrouter:${model.slug}`,
    model,
    route: "A",
    provider: null,
    incumbent,
    measured: profile,
  });

  const reportModel = buildReportModel({
    workloads: [
      {
        workload: WORKLOAD,
        candidates: [entry(textModel, MEASURED_PROFILE, true)],
        ledger: buildLedger(textModel, WORKLOAD.buyer_estimate, MEASURED_PROFILE, 20000),
        benchmarkMeta: { items: 14 },
      },
      {
        workload: imageMeasured ? IMAGE_WORKLOAD : IMAGE_WORKLOAD_UNMEASURED,
        candidates: [
          entry(imageModel, imageMeasured ? IMAGE_PROFILE : null, imageIncumbent === 0),
          entry(miniModel, imageMeasured ? IMAGE_PROFILE_MINI : null, imageIncumbent === 1),
        ],
        // A workload with no run behind it has no ledger either, which is what the generator passes:
        // buildLedger needs a measured profile and there is not one.
        ledger: imageMeasured
          ? buildLedger(imageModel, IMAGE_WORKLOAD.buyer_estimate, IMAGE_PROFILE, 2000)
          : null,
        benchmarkMeta: imageMeasured ? { items: 2 } : {},
      },
    ],
    catalogueMeta: { fetched_at: "2026-09-15T09:00:00.000Z" },
    generatedAt: "2026-09-17T10:00:00.000Z",
  });

  return { html: renderReportHtml(reportModel), reportModel };
}

const TWO_TABS = () => makeDom({ workloads: 2, rowCount: 1 });

test("switching tabs re-points the one panel at the other workload's own numbers", () => {
  const { html } = buildTwo();
  const dom = runPage(html, { dom: TWO_TABS() });

  assert.equal(dom.byId["out-panel-name"].textContent, "Legal contract review");
  assert.equal(dom.byId["in-volume"].value, "20000");

  clickTab(dom, 1);

  // The panel opens on the buyer's own assumptions for whichever workload is showing, and there is
  // one panel for both tabs. A second panel would mean a second set of ids and a second place for
  // this arithmetic to be wired up wrong.
  assert.equal(dom.byId["out-panel-name"].textContent, "Image generation");
  assert.equal(dom.byId["in-volume"].value, "2000");
});

test("the tab the reader picked is marked selected and the other panel is hidden", () => {
  const { html } = buildTwo();
  const dom = runPage(html, { dom: TWO_TABS() });

  assert.equal(dom.tabs[0].getAttribute("aria-selected"), "true");
  assert.equal(dom.tabs[1].getAttribute("aria-selected"), "false");
  assert.equal(dom.panels[0].hasAttribute("hidden"), false, "the first panel should be showing");
  assert.equal(dom.panels[1].hasAttribute("hidden"), true, "the second panel should be hidden");

  clickTab(dom, 1);

  assert.equal(dom.tabs[0].getAttribute("aria-selected"), "false");
  assert.equal(dom.tabs[1].getAttribute("aria-selected"), "true");
  assert.equal(dom.panels[0].hasAttribute("hidden"), true);
  assert.equal(dom.panels[1].hasAttribute("hidden"), false);
  // Roving tabindex, so the tablist is one stop in the reader's tab order rather than two.
  assert.equal(dom.tabs[1].getAttribute("tabindex"), "0");
  assert.equal(dom.tabs[0].getAttribute("tabindex"), "-1");
});

test("each tab prices its own candidates, and the switch reprices rather than leaving the old figure", () => {
  const { html } = buildTwo();
  const dom = runPage(html, { dom: TWO_TABS() });

  // Every render appends a fresh cell, so the last one for a workload is what that tab's row shows.
  const lastCell = (prefix) => dom.cells.filter((c) => c.id.startsWith(prefix)).pop();
  const textRow = lastCell("per_call-0-");
  assert.ok(textRow, "the first tab's row was never written");

  clickTab(dom, 1);
  const imageRow = lastCell("per_call-1-");
  assert.ok(imageRow, "the second tab's row was never written");

  // The row lookup is scoped to the active workload's panel. Unscoped, this render would have
  // written the image model's price into the first tab's row and left the legal tab showing a
  // figure for a model that is not on it.
  assert.ok(textRow.textContent.startsWith("$"), `text row held "${textRow.textContent}"`);
  assert.ok(imageRow.textContent.startsWith("$"), `image row held "${imageRow.textContent}"`);
  assert.notEqual(textRow.textContent, imageRow.textContent);
});

test("the image tab locks the prompt and answer fields at what the run measured", () => {
  const { html } = buildTwo();
  const dom = runPage(html, { dom: TWO_TABS() });

  // On the text tab all four are the reader's to move.
  assert.equal(dom.byId["in-prompt"].hasAttribute("disabled"), false);
  assert.equal(dom.byId["in-output"].hasAttribute("disabled"), false);

  clickTab(dom, 1);

  // The 263x prompt-token gap between two candidates on the same one-sentence prompt IS this tab's
  // finding. A field that let a reader type a prompt size here would generate exactly the estimate
  // the page exists to correct, so the measured number stays on screen and the edit is refused.
  assert.equal(dom.byId["in-prompt"].value, "9");
  assert.equal(dom.byId["in-prompt"].hasAttribute("disabled"), true);
  assert.equal(dom.byId["in-output"].value, "1290");
  assert.equal(dom.byId["in-output"].hasAttribute("disabled"), true);

  // Volume and the reader's own estimate are still theirs. That is the one axis this tab is
  // interactive along.
  assert.equal(dom.byId["in-volume"].hasAttribute("disabled"), false);
  assert.equal(dom.byId["in-estimate"].hasAttribute("disabled"), false);
});

test("the second gap box is hidden on the image tab and the note says why", () => {
  const { html } = buildTwo();
  const dom = runPage(html, { dom: TWO_TABS() });

  assert.equal(dom.byId["gapbox-model"].hasAttribute("hidden"), false);

  clickTab(dom, 1);

  // Image models sell no caching, so the mechanic the reader's inputs cannot express does not
  // apply. A box reading $0.00 beside a mechanic reads as a saving nobody took, and the sentence
  // beneath it used to explain a box that was not on the page.
  assert.equal(dom.byId["gapbox-model"].hasAttribute("hidden"), true);
  assert.ok(
    dom.byId["out-scope"].textContent.includes("no second gap box"),
    dom.byId["out-scope"].textContent
  );
});

test("the image tab's headline names the picture, not a cache hit rate it never measured", () => {
  const { html } = buildTwo();
  const dom = runPage(html, { dom: TWO_TABS() });

  assert.ok(dom.byId["out-measured-sub"].textContent.includes("cache hit rate"));

  clickTab(dom, 1);

  // This line read "with the measured 0% cache hit rate" on the image tab, which asserts a
  // measurement of a mechanic the workload does not have.
  assert.equal(dom.byId["out-measured-sub"].textContent.includes("cache hit rate"), false);
  assert.ok(
    dom.byId["out-measured-sub"].textContent.includes("1,290 are the picture itself"),
    dom.byId["out-measured-sub"].textContent
  );
});

test("a page that lost its tab bar still renders the panel, because a missing element is not a crash", () => {
  const { html } = buildTwo();
  // The page is one file, opened wherever a reader opens it. With no panels there is nothing to
  // switch between, and the panel of inputs still has to work off the first workload.
  const dom = runPage(html, { dom: makeDom({ workloads: 2, rowCount: 1, missing: ["panel-0", "panel-1"] }) });

  assert.ok(dom.byId["out-measured"].innerHTML.includes("$"));
  assert.equal(dom.byId["out-measured"].innerHTML.includes("NaN"), false);
});

test("the image tab does not call a mechanic absent while the same page prices it", () => {
  const { html } = buildTwo();
  const dom = runPage(html, { dom: TWO_TABS() });
  clickTab(dom, 1);

  // The first replacement note for the hidden gap box said "image models sell no caching". The model
  // on this tab publishes a cache-read rate, and the routes table further down the same page prints
  // it, so the page was contradicting itself about a fact both sections can see. The true reason the
  // box holds nothing is the measured hit rate, so that is what the sentence has to say.
  assert.equal(
    dom.byId["out-scope"].textContent.includes("no caching"),
    false,
    dom.byId["out-scope"].textContent
  );
  assert.ok(
    dom.byId["out-scope"].textContent.includes("served no prompt token from cache"),
    dom.byId["out-scope"].textContent
  );
});

test("both rates and the factor between them reach the reader, computed not written into the copy", () => {
  const { html } = buildTwo();
  const dom = runPage(html, { dom: TWO_TABS() });
  clickTab(dom, 1);

  // The whole reason this project exists, said where the number it explains is. The note is built by
  // the page's own script, not baked into the markup, so an integration test reading the generated
  // HTML never sees it - which is why it is checked here, against a DOM the script has run on.
  const notes = dom.byId["out-notes"].innerHTML;
  assert.ok(notes.includes("$30.00 per million"), notes.slice(0, 400));
  assert.ok(notes.includes("$2.50 per million"), notes.slice(0, 400));

  // The factor is computed from the two published rates rather than written into the sentence. It is
  // 12x on this model and 4x on the other, so a hard-coded multiple would be wrong on that row.
  assert.ok(notes.includes("a factor of 12.0"), notes.slice(0, 400));
  assert.ok(notes.includes("1,290 of the output tokens are the picture itself"), notes.slice(0, 400));
});

test("the rate factor follows the row, because it is 12x on one model and 4x on the other", () => {
  const onGemini = runPage(buildTwo({ imageIncumbent: 0 }).html, { dom: TWO_TABS() });
  clickTab(onGemini, 1);

  // Pointing the panel at the second model is the only thing that differs. Nothing about either
  // model changed, so if the factor were written into the sentence rather than computed from the
  // two rates, this would still read 12.0.
  const onMini = runPage(buildTwo({ imageIncumbent: 1 }).html, { dom: TWO_TABS() });
  clickTab(onMini, 1);

  const geminiNotes = onGemini.byId["out-notes"].innerHTML;
  const miniNotes = onMini.byId["out-notes"].innerHTML;

  assert.ok(geminiNotes.includes("a factor of 12.0"), geminiNotes.slice(0, 300));
  assert.ok(miniNotes.includes("a factor of 4.0"), miniNotes.slice(0, 300));
  assert.equal(miniNotes.includes("a factor of 12.0"), false);
  assert.equal(geminiNotes.includes("a factor of 4.0"), false);
});

// ---------------------------------------------------------------------------
// robustness on the second tab: the same degradation, one panel over
// ---------------------------------------------------------------------------

/**
 * Open the image tab, then change the fields the way a reader would.
 *
 * The order matters and is the whole reason this helper exists. `runPage` applies its input
 * overrides after the page opens on workload 0, and clicking a tab re-points the panel and rewrites
 * every field from the workload now showing. So a value set before the click is discarded, and a
 * test written that way would be exercising the tab-switch defaults while claiming to exercise the
 * reader's own input.
 */
function onImageTab(inputs = {}) {
  const dom = runPage(buildTwo().html, { dom: TWO_TABS() });
  clickTab(dom, 1);
  for (const [id, value] of Object.entries(inputs)) {
    const el = dom.byId[id];
    el.value = String(value);
    for (const fn of el.listeners.input ?? []) fn({ target: el });
  }
  return dom;
}

test("the image tab prices the same reader inputs the text tab does", () => {
  // The baseline the tests below depart from: with the buyer's own defaults in the boxes, the image
  // tab produces a monthly figure. Without this, an empty or malformed note below would pass for
  // the wrong reason - a panel that never prices anything produces no complaint about pricing.
  const dom = onImageTab();
  assert.ok(dom.byId["out-measured"].innerHTML.includes("$"), dom.byId["out-measured"].innerHTML);
});

test("an empty volume on the image tab is explained rather than rendered as zero", () => {
  const dom = onImageTab({ "in-volume": "" });
  assert.ok(dom.byId["out-notes"].innerHTML.includes("Enter a monthly request volume"));
  assert.equal(dom.byId["out-measured"].innerHTML.includes("$0"), false);
});

test("zero and negative volumes are handled on the image tab as they are on the text tab", () => {
  const zero = onImageTab({ "in-volume": 0 });
  assert.ok(zero.byId["out-notes"].innerHTML.includes("Zero requests is a real answer"));
  assert.ok(zero.byId["out-measured"].innerHTML.includes("$0.00"));

  const negative = onImageTab({ "in-volume": -500 });
  assert.ok(negative.byId["out-notes"].innerHTML.includes("negative request volume"));
  assert.equal(negative.byId["out-measured"].innerHTML.includes("$-"), false);
});

test("a volume orders of magnitude beyond the measured one is priced but flagged", () => {
  const dom = onImageTab({ "in-volume": 50000000 });
  assert.ok(dom.byId["out-notes"].innerHTML.includes("ten times the volume"));
  assert.ok(dom.byId["out-measured"].innerHTML.includes("$"));
});

test("non-numeric input on the image tab does not produce NaN on the page", () => {
  // `type="number"` keeps most of this out of the browser, but the field can still be empty or
  // hold something the parser rejects, and the page must not print NaN either way.
  const dom = onImageTab({ "in-volume": "abc", "in-estimate": "xyz" });
  assert.equal(dom.byId["out-notes"].innerHTML.includes("NaN"), false);
  assert.equal(dom.byId["out-measured"].innerHTML.includes("NaN"), false);
});

test("a missing estimate on the image tab is stated as missing, not treated as zero", () => {
  const dom = onImageTab({ "in-estimate": "" });
  assert.ok(dom.byId["out-arith-note"].textContent.includes("enter your own estimate"));
  assert.equal(dom.byId["out-arith"].textContent.includes("$"), false);
});

test("the locked fields cannot be typed into, and typing into them changes nothing", () => {
  // The scope's rule is that the page is interactive along exactly one axis. The 177x prompt-token
  // gap between the two candidates for the same sentence IS the finding on this tab, so letting a
  // reader type a prompt size would make the page generate the estimate it exists to correct.
  const dom = onImageTab();
  assert.equal(dom.byId["in-prompt"].hasAttribute("disabled"), true);
  assert.equal(dom.byId["in-output"].hasAttribute("disabled"), true);
  // Volume and the reader's own estimate are theirs to move. Locking those too would leave the tab
  // with nothing to say about the reader's own month.
  assert.equal(dom.byId["in-volume"].hasAttribute("disabled"), false);
  assert.equal(dom.byId["in-estimate"].hasAttribute("disabled"), false);

  const priced = dom.cells.filter((c) => c.id.startsWith("per_call-1-")).pop().textContent;

  // Set the locked fields anyway, the way a script or devtools would, and re-render. The figure must
  // not move: a locked field is locked to a measurement, not merely greyed out.
  for (const id of ["in-prompt", "in-output"]) {
    dom.byId[id].value = "1";
    for (const fn of dom.byId[id].listeners.input ?? []) fn({ target: dom.byId[id] });
  }
  const after = dom.cells.filter((c) => c.id.startsWith("per_call-1-")).pop().textContent;
  assert.equal(after, priced, "the locked prompt and answer length changed the price");

  // Switching tabs and back restores the measured values rather than keeping the tampered ones.
  clickTab(dom, 0);
  clickTab(dom, 1);
  assert.equal(dom.byId["in-prompt"].value, "9");
  assert.equal(dom.byId["in-output"].value, "1290");
});

// ---------------------------------------------------------------------------
// a workload with no run behind it
// ---------------------------------------------------------------------------

test("a workload with no measured run does not lock its fields to a measurement that does not exist", () => {
  // Reachable by deleting the benchmark, or for any workload added before its run. Locking to null
  // left a disabled, empty box captioned "this is what the prompt actually measured", and the panel
  // then asked the reader to enter a prompt size - an instruction to fill in a field that cannot be
  // typed into, about a measurement no run produced.
  const dom = runPage(buildTwo({ imageMeasured: false }).html, { dom: TWO_TABS() });
  clickTab(dom, 1);

  assert.equal(dom.byId["in-prompt"].hasAttribute("disabled"), false, "a null measurement was locked");
  assert.equal(dom.byId["in-output"].hasAttribute("disabled"), false);
  assert.notEqual(dom.byId["in-prompt"].value, "", "the field is empty and cannot be typed into");
  assert.equal(
    dom.byId["out-notes"].innerHTML.includes("Enter a prompt size"),
    false,
    "the page asked for an input it had already locked"
  );

  // And the captions say why the fields are the reader's again, rather than claiming a measurement.
  const promptHint = dom.byId["hint-prompt"].textContent;
  assert.equal(/actually measured/.test(promptHint), false, promptHint);
  assert.ok(/no measured run/i.test(promptHint), promptHint);
});

test("a workload with no measured run claims no measurement anywhere in its panel", () => {
  const dom = runPage(buildTwo({ imageMeasured: false }).html, { dom: TWO_TABS() });
  clickTab(dom, 1);

  // A figure with no measurement behind it is a dash, never a zero. Zero would read as "measured,
  // and it costs nothing", which is the claim this whole project exists to refuse.
  assert.ok(dom.byId["out-measured"].innerHTML.includes("–"), dom.byId["out-measured"].innerHTML);
  for (const id of ["out-measured", "out-measured-sub", "out-scope"]) {
    assert.equal(
      /\bmeasured\b/i.test(dom.byId[id].textContent) && dom.byId[id].textContent.trim() !== "",
      false,
      `${id} talks about a measurement that was never made: ${dom.byId[id].textContent.trim()}`
    );
  }
  assert.equal(dom.byId["out-measured-sub"].textContent, "per month");
});

test("the words above the fields follow the tab, because two of the boxes are not the reader's", () => {
  // The headings are the page's own claim about the fields underneath them. On a locked workload two
  // of the four boxes hold measurements, so "You change this" was false over half the column and
  // "everything here is a guess" called a measured prompt size a guess.
  const dom = runPage(buildTwo().html, { dom: TWO_TABS() });

  // The text tab: all four boxes are the reader's.
  assert.match(dom.byId["out-panel-left-h"].innerHTML, /You change this/);
  assert.match(dom.byId["out-panel-sub"].textContent, /Everything here is a guess/);
  assert.match(dom.byId["out-panel-sub"].textContent, /switching tabs re-points it/);

  clickTab(dom, 1);

  assert.match(dom.byId["out-panel-left-h"].innerHTML, /Two of these are yours/);
  assert.equal(
    /You change this/.test(dom.byId["out-panel-left-h"].innerHTML),
    false,
    "the page still claims the reader changes a locked field"
  );
  const sub = dom.byId["out-panel-sub"].textContent;
  assert.match(sub, /shown rather than offered/);
  assert.equal(/Everything here is a guess/.test(sub), false, sub);

  // And back, so the copy is re-pointed in both directions rather than only away from the first tab.
  clickTab(dom, 0);
  assert.match(dom.byId["out-panel-left-h"].innerHTML, /You change this/);
  assert.match(dom.byId["out-panel-sub"].textContent, /Everything here is a guess/);
});

test("a one-workload page does not promise a tab switch", () => {
  // The same tail serves both page shapes, and it is the half the server template used to decide. A
  // single-workload page saying "switching tabs re-points it" points at a control that is not there.
  const dom = runPage(build().html);
  const sub = dom.byId["out-panel-sub"].textContent;
  assert.equal(/switching tabs/.test(sub), false, sub);
  assert.match(sub, /one workload, so this panel has one configuration/);
});

test("the paragraph the server sends is the paragraph the script would write", () => {
  // The client rewrites this paragraph on every activate, including the first one, so a drift between
  // the two is invisible in the browser and only shows up as the text flickering on load. Both halves
  // are asserted because the server template picks between them from the workload count, and it is the
  // half a single-workload page got wrong.
  const one = /id="out-panel-sub">([\s\S]*?)<\/p>/.exec(build().html);
  const two = /id="out-panel-sub">([\s\S]*?)<\/p>/.exec(buildTwo().html);
  assert.ok(one && two, "the panel sub-paragraph is not in the served HTML");

  const flatten = (s) => s.replace(/\s+/g, " ").trim();
  assert.match(flatten(one[1]), /There is one workload, so this panel has one configuration\.$/);
  assert.match(
    flatten(two[1]),
    /switching tabs re-points it at the other workload's own measurements\.$/
  );
  // And the same words the client writes, which is the point of the assertion.
  assert.match(flatten(two[1]), /Everything measured is fixed and timestamped\. Everything here is a guess/);
});
