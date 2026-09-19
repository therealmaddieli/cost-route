/**
 * The text half of the wire format.
 *
 * Pure. Takes a parsed response and returns a run record: no network, no filesystem, no clock. It
 * is the counterpart of core/imagery.mjs, and it lives here for the reason that module gives for
 * its own existence - "what gets sent" and "what gets recorded" are the two things worth testing,
 * and testing them against a live endpoint means paying to find out whether a rule was applied.
 *
 * This function used to sit inside scripts/benchmark.mjs, which runs on import and so cannot be
 * tested at all. The cost of that was not theoretical. The image leg was written second, and every
 * failure rule it learned - an unreadable payload, a capped output - was added to
 * `imageRunRecord` where a test could reach it and never made it back across to the text leg,
 * where the same rule for `finish_reason: "length"` stayed missing and untestable. Two legs of one
 * comparison, drifting apart in the one place the comparison depends on them agreeing.
 *
 * Shared with scripts/benchmark.mjs, which owns the transport.
 */

/**
 * What a text call returned, as a run record.
 *
 * The fields, their order and their meanings are unchanged from when this was a local function in
 * the runner, because the saved benchmark files were written by that version and are read back by
 * the report.
 *
 * Errors are returned, never thrown. A candidate that fails every call has to appear in the report
 * as failing every call, and a record builder that threw would turn a model's bad day into a run
 * that produced no file.
 */
export function captureText(json, latency_ms, attempts, droppedTemperature) {
  const usage = json?.usage ?? {};
  const choice = json?.choices?.[0] ?? {};
  const raw = choice.message?.content;
  const answer = typeof raw === "string" ? raw.trim() : "";

  const record = {
    latency_ms,
    attempts,
    usage,
    stop_reason: choice.finish_reason ?? null,
    // Both routes report a real dollar figure. Ours is only ever used to explain theirs.
    cost: typeof usage.cost === "number" ? usage.cost : (usage.estimated_cost ?? null),
    cost_source: typeof usage.cost === "number" ? "usage.cost" : "usage.estimated_cost",
    dropped_temperature: droppedTemperature || undefined,
  };

  // An empty answer is never scored. There is nothing to score, and calling it wrong would blame
  // the model for the harness. Report it as a failure and say which one it was.
  if (answer === "") {
    const reasoning =
      usage.completion_tokens_details?.reasoning_tokens ??
      usage.completion_tokens_details ??
      null;
    return {
      ...record,
      error:
        `EMPTY ANSWER (finish_reason=${choice.finish_reason ?? "?"}, ` +
        `completion_tokens=${usage.completion_tokens ?? "?"}` +
        `${reasoning ? `, reasoning_tokens=${reasoning}` : ""})`,
    };
  }

  // A capped output is a harness limit, not a model failure, and it is the rule the image leg
  // already applied. It was missing here, and it is the same confusion the empty-answer rule above
  // exists to prevent, one step milder: a truncated answer still looks like an answer, so it was
  // scored, and every question the harness cut short was counted against the model's accuracy.
  //
  // Checked after the empty case, which is the order the image leg uses for its own equivalent pair.
  // An answer that is empty *and* truncated is better described by the empty-answer message, which
  // names the reasoning tokens the cap was spent on; this one would only say the cap was hit.
  //
  // The wording is deliberately identical to the image leg's in core/imagery.mjs, because it is the
  // same phenomenon and a search for it should find both.
  if (choice.finish_reason === "length") {
    return {
      ...record,
      error:
        `TRUNCATED AT max_tokens (finish_reason=length, ` +
        `completion_tokens=${usage.completion_tokens ?? "?"}, ${answer.length} characters written)`,
    };
  }

  return { ...record, answer };
}
