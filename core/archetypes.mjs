/**
 * Named workload archetypes: reusable starting points for a new workload file.
 *
 * Every workload on this page today is hand-authored from a blank JSON file. That is fine for
 * the two shipped demos, and it is friction for every prospect conversation after them, where
 * the shape of the workload is usually known before any of its details are ("this one looks
 * like a coding assistant") and only the details are missing.
 *
 * An archetype is a named, typical token-ratio default for one kind of workload - coding,
 * chat, document analysis, agentic tool use - the same four shapes SemiAnalysis's Tokenomics
 * Model treats as first-class, each with its own token profile.
 *
 * Two rules keep this from undermining the project's measured/assumed discipline:
 *
 *   1. An archetype only ever acts at SCAFFOLD time, via scaffoldWorkload() below, writing its
 *      defaults into the saved workload file as plain, visible, editable JSON. Nothing in
 *      core/report.mjs or the benchmark pipeline re-applies an archetype's numbers at render
 *      time - a workload file is self-contained, and a reader should never have to know an
 *      archetype exists to understand what a saved file says.
 *
 *   2. An archetype never fabricates a working quality gate. golden_set accept/reject patterns
 *      are inherently document-specific (see samples/workload.legal.json), so the scaffold
 *      ships placeholder SHAPE only - ids, a kind distribution, TODO text - never patterns that
 *      would look like real scoring logic without being any.
 */

// ---------------------------------------------------------------------------
// the archetypes
// ---------------------------------------------------------------------------

export const ARCHETYPES = {
  "coding-assistant": {
    slug: "coding-assistant",
    label: "Coding assistant",
    description:
      "Reads a large file or repo context and returns a short diff or snippet. Context is " +
      "often repeated turn to turn, so cache reuse is typically high.",
    typical_io_ratio: {
      assumed_input_tokens_per_request: 3000,
      assumed_output_tokens_per_request: 300,
    },
    cache_expectation_note: "High - repeated file or repo context across calls is the common case.",
    reasoning_note: "Usually none, unless the candidate is itself a reasoning model.",
  },
  "chat-support": {
    slug: "chat-support",
    label: "Chat / customer support",
    description: "A short user message plus a short rolling history, and a short reply.",
    typical_io_ratio: {
      assumed_input_tokens_per_request: 500,
      assumed_output_tokens_per_request: 150,
    },
    cache_expectation_note: "Low to moderate - mostly a repeated system prompt.",
    reasoning_note: "Usually none.",
  },
  "document-analysis": {
    slug: "document-analysis",
    label: "Document analysis",
    description:
      "A full document in the prompt, a short extracted answer out. This is the shape of " +
      "samples/workload.legal.json.",
    typical_io_ratio: {
      assumed_input_tokens_per_request: 1500,
      assumed_output_tokens_per_request: 50,
    },
    cache_expectation_note:
      "Varies - high if the same document is queried repeatedly, near-zero otherwise.",
    reasoning_note: "Usually none.",
  },
  "agentic-tool-use": {
    slug: "agentic-tool-use",
    label: "Agentic / tool use",
    description:
      "Context accumulates across turns as tool outputs are appended; the output includes " +
      "tool calls as well as the final answer.",
    typical_io_ratio: {
      assumed_input_tokens_per_request: 4000,
      assumed_output_tokens_per_request: 500,
    },
    cache_expectation_note: "Low - the growing, changing context caches poorly turn to turn.",
    reasoning_note:
      "Often significant and billed invisibly - see core/cost.mjs's reasoning-token mechanic.",
  },
};

/** Look up an archetype by slug, or null. Never throws - a stale slug is a report-time note, not a crash. */
export function archetypeFor(slug) {
  if (!slug) return null;
  return ARCHETYPES[slug] ?? null;
}

// ---------------------------------------------------------------------------
// the golden-set scaffold
// ---------------------------------------------------------------------------

/**
 * Which `kind` each placeholder question gets, in the same rough 60/30/10 split already used by
 * samples/workload.legal.json (9 fact, 3 multi_hop, 1 absent, roughly) - fact questions first,
 * multi_hop next, the absent/trap question last, so the file reads in the order a person fills
 * it in.
 */
function kindPlan(count) {
  const absent = count >= 5 ? 1 : 0;
  const multiHop = Math.max(0, Math.round((count - absent) * 0.3));
  const fact = count - absent - multiHop;
  return [...Array(fact).fill("fact"), ...Array(multiHop).fill("multi_hop"), ...Array(absent).fill("absent")];
}

function scaffoldItem(kind, index) {
  const id = `${kind.replace("_", "-")}-${index}`;
  if (kind === "absent") {
    return {
      id,
      kind,
      $TODO: "Replace with a question the source material does NOT answer, and name the trap below.",
      question: "TODO: a question the document/context does not answer",
      expected: "Not specified. TODO: state what 'not specified' means for this workload.",
      accept: ["\\bno\\s+\\w+\\s+(?:provision|mechanism|requirement)", "\\bnot\\s+specified\\b", "\\bsilent\\b"],
      reject: [],
      trap: "TODO: name the nearby real figure a model might wrongly reuse here.",
    };
  }
  return {
    id,
    kind,
    $TODO:
      kind === "multi_hop"
        ? "Replace with a question whose answer requires combining two separate facts."
        : "Replace with a question whose answer is stated once, directly.",
    question: "TODO: write the real question",
    expected: "TODO: the real expected answer",
    accept: ["TODO: a regex the real answer must match"],
    reject: [],
  };
}

/**
 * A full starter workload object for the given archetype. Pure - the caller decides whether and
 * where to write it to disk (see scripts/new-workload.mjs).
 *
 * @param {string} slug         an ARCHETYPES key
 * @param {object} [options]
 * @param {string} [options.name]          workload_name; defaults to the archetype's label
 * @param {number} [options.questionCount] golden_set scaffold size, default 12
 */
export function scaffoldWorkload(slug, options = {}) {
  const archetype = archetypeFor(slug);
  if (!archetype) {
    const known = Object.keys(ARCHETYPES).join(", ");
    throw new Error(`unknown archetype "${slug}". Known archetypes: ${known}`);
  }

  const questionCount = options.questionCount ?? 12;
  const name = options.name ?? archetype.label;

  return {
    archetype: archetype.slug,
    workload_name: name,
    workload_kind: "text",
    task_description: `TODO: describe the task. Scaffolded from the "${archetype.label}" archetype: ${archetype.description}`,

    sample_input_path: "TODO: path to the document/context this workload sends",

    quality_bar: {
      min_correct_share: 0.75,
      max_hallucinations: 0,
      notes: "Default gate. Replace with the buyer's stated tolerance before this number means anything.",
    },

    latency_ceiling_ms: 15000,
    monthly_requests: 1000,

    buyer_estimate: {
      ...archetype.typical_io_ratio,
      assumed_cost_per_month_usd: null,
      stated_assumption: `Seeded from the "${archetype.label}" archetype's typical token ratio, not from this buyer. Cache expectation: ${archetype.cache_expectation_note} Reasoning tokens: ${archetype.reasoning_note}`,
      note:
        "These are archetype defaults, not the buyer's numbers. Replace assumed_input_tokens_per_request, " +
        "assumed_output_tokens_per_request and assumed_cost_per_month_usd with what the buyer actually said " +
        "before trusting the gap analysis.",
    },

    candidates: [],

    golden_set: kindPlan(questionCount).map((kind, i) => scaffoldItem(kind, i + 1)),
  };
}
