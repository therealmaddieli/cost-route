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

// ---------------------------------------------------------------------------
// The batch leg
// ---------------------------------------------------------------------------

/**
 * What gets sent for one text question, synchronously.
 *
 * This used to be built inline in `scripts/benchmark.mjs`, which runs on import and so cannot be
 * tested at all - the same reason `captureText` was moved here. It is here now because the batch
 * leg sends the *same* request body, and a copy of it living in the runner is exactly the drift
 * this module's header describes: two legs of one comparison, diverging in the one place the
 * comparison depends on them agreeing. `tests/batch.test.mjs` pins the batch bodies against this.
 */
export function textRequestBody({ model, answerInstruction, contract, question }) {
  return {
    model,
    messages: [
      { role: "system", content: answerInstruction },
      { role: "user", content: `${contract}\n\n---\n\nQuestion: ${question}` },
    ],
    temperature: 0,
    // Generous on purpose. A reasoning model spends completion tokens on hidden reasoning before it
    // writes a single visible character, and it is billed for them. At max_tokens 200, GPT-5 mini
    // spent all 200 on reasoning for five of the fourteen questions and returned an empty string -
    // which the first version of the runner then scored as a wrong answer. That made a harness limit
    // look like a model failure. Raising the cap, and treating an empty answer as a call failure
    // rather than an incorrect one, is what keeps the two apart.
    max_tokens: 3000,
    usage: { include: true },
  };
}

/** The only completion window the Batch API accepts. Rejected values fail the whole submission. */
export const BATCH_COMPLETION_WINDOW = "24h";

/** The endpoint a batch prices. `/v1/chat/completions` is the only one this project uses. */
export const BATCH_ENDPOINT = "/v1/chat/completions";

/** Terminal states. `finalizing` and `cancelling` are transient and are not terminal. */
export const BATCH_TERMINAL = new Set(["completed", "failed", "expired", "cancelled"]);

/**
 * A timestamp from the Batch API, as epoch milliseconds, or NaN if it cannot be read.
 *
 * **The API mixes two shapes in one object.** `created_at` and `finalized_at` are epoch *seconds* --
 * the batch id embeds `created_at`, which is why it reads `batch-1790584823-...` -- while everything
 * this project writes (`submitted_at`, `terminal_at`) is ISO. `Date.parse` answers NaN for a bare
 * number, and NaN here does not throw: it selects whatever fallback the caller wrote, so the wrong
 * number gets served under a label claiming the server supplied it. That is exactly what happened on
 * 2026-09-28 -- the runner read `finalized_at`, failed to parse it, and fell back to the poll clock,
 * reporting 0.30h for a batch the server had finalised in 0.12h while captioning it "server
 * finalized_at". One function that accepts both shapes, and callers that treat NaN as unreadable
 * rather than as zero, is what closes it.
 *
 * The magnitude test rather than a digit count: 1e11 seconds is the year 5138, and 1e11 milliseconds
 * is 1973, so anything at or above it is already in milliseconds.
 */
export function parseServerTime(value) {
  if (value == null) return NaN;
  if (typeof value === "number") return value >= 1e11 ? value : value * 1000;
  return Date.parse(value);
}

/**
 * Build the `POST /api/v1/batches` body.
 *
 * **The field order is load-bearing and is not a style choice.** OpenRouter's quickstart says, in
 * these words: "Serialize `endpoint`, `model`, and any `provider` or `completion_window` before
 * `requests`" - the API stream-parses the payload and "returns a `400` if `requests` appears
 * first". JavaScript preserves string-key insertion order through `JSON.stringify`, so building
 * this object in the order below is what makes the request legal. `tests/batch.test.mjs` asserts
 * the serialised key order, because a later refactor that sorted or spread these keys would break
 * the submission without breaking anything visible here.
 *
 * `custom_id` is the golden-set item id, which is what makes the results map back onto the same ids
 * a synchronous run produces - so everything downstream of the runs is shared between the legs.
 *
 * **`model` must be the `:batch` model id, not the base slug.** The quickstart's own example payloads
 * show `"model": "openai/gpt-4o"`, and copying that gets the submission rejected. A live submit on
 * 2026-09-28 returned:
 *
 *     400 {"error":{"message":"Model 'openai/gpt-4o-mini' does not have a :batch endpoint."}}
 *
 * So the catalogue's `:batch` entries are not merely a way to read the async price - they are the ids
 * you submit to, and the base slug is not. The documented example is wrong, or at least not universal.
 */
export function batchRequestBody({
  model,
  items,
  answerInstruction,
  contract,
  provider = null,
  completionWindow = BATCH_COMPLETION_WINDOW,
}) {
  const payload = {
    endpoint: BATCH_ENDPOINT,
    model,
  };

  // Both optional, both before `requests`. Omitted entirely rather than sent as null: an explicit
  // null is not the same as an absent key to a strict parser.
  if (provider) payload.provider = provider;
  if (completionWindow) payload.completion_window = completionWindow;

  payload.requests = items.map((item) => ({
    custom_id: item.id,
    // A complete chat-completions body, the same one the synchronous leg sends.
    body: textRequestBody({ model, answerInstruction, contract, question: item.question }),
  }));

  return payload;
}

/**
 * Turn a terminal batch body into the same run records a synchronous run produces.
 *
 * The result shape is **not** `{ custom_id, body }`. Each entry in `results[]` is
 * `{ id, custom_id, response: { status_code, request_id, body }, error }`, and the docs are explicit
 * that "exactly one of `response` or `error` is populated for each result". Reading `result.body`
 * would find nothing on every entry and report a completed batch as a run that produced no answers -
 * a silent zero dressed up as a model failure, which is the failure mode this project keeps meeting.
 *
 * `latency_ms` is null on every run, and it stays null rather than becoming 0. The Batch API exposes
 * no per-request timing, so there is no per-call latency to record; a 0 would pass the workload's
 * `<= 15000 ms` ceiling on a measurement that was never taken. Submit-to-terminal is the one timing
 * fact this leg has, and the runner records it as its own field.
 */
export function batchRuns(json) {
  const results = Array.isArray(json?.results) ? json.results : [];
  const runs = [];
  const failed = [];

  for (const [index, result] of results.entries()) {
    // A result with no custom_id cannot be mapped back to a question. It is reported under a
    // positional id rather than dropped, because a silently discarded result is an answer the
    // reader would never learn was missing.
    const id = result?.custom_id ?? `(result ${index}, no custom_id)`;

    if (!result?.response) {
      const detail = result?.error ? JSON.stringify(result.error).slice(0, 300) : "no response and no error";
      failed.push({ id, error: detail });
      runs.push({ id, latency_ms: null, attempts: 1, error: `BATCH REQUEST FAILED: ${detail}` });
      continue;
    }

    // A result can carry a response that is itself an HTTP error - the request was delivered and
    // rejected. That is a failed call, not an answer, and it must not be scored as a wrong one.
    const status = result.response.status_code;
    if (typeof status === "number" && status >= 400) {
      const detail = `HTTP ${status}: ${JSON.stringify(result.response.body ?? {}).slice(0, 300)}`;
      failed.push({ id, error: detail });
      runs.push({ id, latency_ms: null, attempts: 1, error: detail });
      continue;
    }

    runs.push({ id, ...captureText(result.response.body, null, 1, false) });
  }

  return { runs, failed };
}
