/**
 * The image half of the wire format.
 *
 * Pure. Takes plain values, returns plain values: no network, no filesystem, no clock. That is
 * deliberate, because the two things worth testing here are "what gets sent" and "what gets
 * recorded", and testing them against a live endpoint would mean paying to find out whether a
 * request body was correct.
 *
 * Shared with scripts/benchmark.mjs, which owns the transport.
 *
 * The one fact this module exists to protect is that an image model's answer does not arrive in
 * `message.content`. It arrives in `message.images[]` as base64 data URIs, and `content` is
 * typically empty. Every check that treats an empty `content` as a failure is correct for text and
 * wrong for images, and would report two working models as producing nothing.
 */

import { Buffer } from "node:buffer";

/** The request body for one image call. Matches the call proven on 2026-09-14. */
export function imageRequestBody({ model, prompt, modalities = ["image", "text"] }) {
  return {
    model,
    // No system message, no temperature, no max_tokens. Not an oversight: the paid call that
    // established the pricing reconciliation sent exactly this shape, and adding knobs would make
    // the new run incomparable with the one docs/units.md is built on.
    messages: [{ role: "user", content: prompt }],
    // Without this the endpoint treats the request as text-only and returns prose describing a
    // picture rather than the picture. It is the single field that makes this an image call.
    modalities,
    usage: { include: true },
  };
}

/**
 * Split a data URI into its media type and its bytes.
 *
 * Returns null for anything that is not a data URI, rather than guessing. A provider that returns a
 * bare URL instead of an embedded payload is a different fact from one that returned nothing, and
 * the caller needs to be able to tell them apart.
 */
export function dataUriToBytes(dataUri) {
  if (typeof dataUri !== "string") return null;
  const match = dataUri.match(/^data:([^;,]*)(;base64)?,([\s\S]*)$/);
  if (!match) return null;

  const mime = match[1] || "application/octet-stream";
  const base64 = Boolean(match[2]);
  const payload = match[3];

  try {
    return {
      mime,
      bytes: base64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8"),
    };
  } catch {
    return null;
  }
}

/** The extension to write these bytes under. Unknown types get .bin rather than a wrong guess. */
export function imageExtension(mime) {
  if (/png/i.test(mime ?? "")) return "png";
  if (/jpe?g/i.test(mime ?? "")) return "jpg";
  if (/webp/i.test(mime ?? "")) return "webp";
  if (/gif/i.test(mime ?? "")) return "gif";
  return "bin";
}

/**
 * A filesystem-safe file name for one returned image.
 *
 * Slugs carry a slash (`google/gemini-2.5-flash-image`), and writing that straight to disk would
 * create a directory instead of a file. Dots and dashes survive because model names are full of
 * them and a name that no longer matches the model is worse than useless in a folder of images.
 */
export function imageFileName(slug, index = null, ext = "png") {
  const safe = String(slug)
    .replace(/[^a-zA-Z0-9.-]+/g, "_")
    .replace(/^[_.]+|[_.]+$/g, "");
  const base = safe || "image";
  // The run index goes in the name because each candidate is called more than once and the
  // variation between runs is itself a finding. Overwriting would hide it.
  return index == null ? `${base}.${ext}` : `${base}-run${index + 1}.${ext}`;
}

/**
 * Pull the image payload out of one entry of `message.images[]`.
 *
 * The element shape is not recorded anywhere in this repo. `scripts/smoke_test.py:381-385` reads
 * the array and checks `len(images)`, which proves images come back and says nothing about what one
 * looks like. OpenRouter's documented chat shape is `{type, image_url: {url}}`, but "documented" and
 * "what this endpoint actually sent" are different claims, and guessing wrong here means four paid
 * calls that produce zero files.
 *
 * So every shape seen in the wild is accepted, and `imageEntryShape` below records which one
 * arrived. The first paid run then answers the question rather than inheriting an answer, and a
 * later provider change shows up as a changed field instead of as a silently empty folder.
 */
export function imageSource(entry) {
  if (typeof entry === "string") return entry;
  if (!entry || typeof entry !== "object") return null;
  if (typeof entry.image_url?.url === "string") return entry.image_url.url;
  if (typeof entry.url === "string") return entry.url;
  if (typeof entry.b64_json === "string") return `data:image/png;base64,${entry.b64_json}`;
  if (typeof entry.data === "string") return entry.data;
  return null;
}

/** A short name for the shape of an image entry. Diagnostic only; no logic reads it. */
export function imageEntryShape(entry) {
  if (typeof entry === "string") return "string";
  if (!entry || typeof entry !== "object") return typeof entry;
  if (typeof entry.image_url?.url === "string") return "object:image_url.url";
  if (typeof entry.url === "string") return "object:url";
  if (typeof entry.b64_json === "string") return "object:b64_json";
  if (typeof entry.data === "string") return "object:data";
  const keys = Object.keys(entry).filter((k) => entry[k] != null);
  return keys.length ? `object:${keys.sort().join(",")}` : "object:empty";
}

/**
 * What one image call actually returned, as a benchmark run record.
 *
 * The record shape matches the text path's on purpose: `usage`, `latency_ms`, `cost` and
 * `attempts` are read by the same profile and ledger code either way, and a second reader for the
 * image leg is a second place for the two to disagree.
 */
export function imageRunRecord({ json, latency_ms, attempts, dropped_temperature = false }) {
  const usage = json?.usage ?? {};
  const choice = json?.choices?.[0] ?? {};
  const details = usage.completion_tokens_details ?? {};
  const entries = Array.isArray(choice.message?.images) ? choice.message.images : [];
  const raw = choice.message?.content;
  const text = typeof raw === "string" ? raw.trim() : "";

  // Only embedded payloads count as images we have. A bare URL is a real possibility and a
  // different finding from a model that returned nothing, so it is surfaced rather than written
  // out as a zero-byte file.
  const images = entries
    .map(imageSource)
    .filter((source) => typeof source === "string" && source.startsWith("data:"));

  const record = {
    latency_ms,
    attempts,
    usage,
    stop_reason: choice.finish_reason ?? null,
    // Both routes report a real dollar figure. Ours is only ever used to explain theirs.
    cost: typeof usage.cost === "number" ? usage.cost : (usage.estimated_cost ?? null),
    cost_source: typeof usage.cost === "number" ? "usage.cost" : "usage.estimated_cost",
    dropped_temperature: dropped_temperature || undefined,

    // The image-specific fields. `image_tokens` is repeated here from usage because it is the
    // quantity the whole image argument rests on, and reading it back out of a nested usage object
    // at every call site is how a field ends up quietly read as zero.
    image_count: images.length,
    // How many entries the provider actually sent, which differs from image_count when an entry
    // cannot be read. Keeping both is what makes an extractor bug visible instead of invisible.
    image_entries: entries.length,
    image_entry_shape: entries.length ? imageEntryShape(entries[0]) : null,
    image_tokens: details.image_tokens ?? null,
    reasoning_tokens: details.reasoning_tokens ?? null,
    images,
    // Any prose that came back with the picture. Usually empty and never required: an image model
    // answering an image request with no words is correct behaviour, not a missing answer.
    answer: text || null,
  };

  if (entries.length === 0) {
    // The mirror of the text path's EMPTY ANSWER rule, and the reason this module exists. For an
    // image call the picture IS the answer, so "no image" is the failure and empty prose is not.
    return {
      ...record,
      error:
        `NO IMAGE RETURNED (finish_reason=${choice.finish_reason ?? "?"}, ` +
        `completion_tokens=${usage.completion_tokens ?? "?"}, ` +
        `image_tokens=${details.image_tokens ?? "?"}` +
        `${text ? `, text="${text.slice(0, 80)}"` : ""})`,
    };
  }

  // An entry we cannot read is worse than no entry, because it looks like success all the way down
  // to the empty folder. Name the shape that arrived so the extractor can be fixed in one step.
  if (images.length === 0) {
    return {
      ...record,
      error:
        `IMAGE ENTRY NOT READABLE (${entries.length} returned, first has shape ` +
        `"${imageEntryShape(entries[0])}") - the payload is not an embedded data URI. ` +
        `image_tokens=${details.image_tokens ?? "?"}, so the call was still billed`,
    };
  }

  // A capped output is not a failure, but it is a harness limit and it has to be visible: an image
  // cut off by max_tokens would otherwise look like a model that draws worse pictures.
  if (choice.finish_reason === "length") {
    return {
      ...record,
      error:
        `TRUNCATED AT max_tokens (finish_reason=length, completion_tokens=${usage.completion_tokens ?? "?"})`,
    };
  }

  return record;
}

/**
 * The per-candidate image summary, for the console table.
 *
 * The quality fields are absent rather than zero. A zero here would render as "0 of 0 correct",
 * which is a claim about quality that was never measured, on a workload where the buyer judges the
 * pictures by eye.
 */
export function summariseImageRuns(runs) {
  const ok = runs.filter((r) => !r.error);
  const latencies = ok.map((r) => r.latency_ms).filter((n) => typeof n === "number");
  // Cost is summed over EVERY run that reported one, failed runs included, and that is the opposite
  // of the latency rule above on purpose. A call that came back without a picture was still billed
  // for the tokens it burned getting there; excluding it would understate what this workload costs
  // per month, which is the one number the whole page exists to produce. Latency is excluded from a
  // failure because the time a failed call took is not a generation time.
  const costs = runs.map((r) => r.cost).filter((c) => typeof c === "number");
  const imageCounts = ok.map((r) => r.image_count);

  const median = (values) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };

  return {
    runs: runs.length,
    succeeded: ok.length,
    failed: runs.length - ok.length,
    // Median rather than mean, unlike the text leg's percentile call. With two runs per candidate a
    // mean is defensible and a median is identical; with one run it is that run. Neither is a p95,
    // and reporting a p95 from two samples would dress a sample size up as a distribution.
    latency_ms: { median: median(latencies), min: latencies.length ? Math.min(...latencies) : null,
                   max: latencies.length ? Math.max(...latencies) : null },
    // The sum and its coverage, so a run that reported no cost cannot be divided in as a zero.
    measured_cost_usd: costs.length ? costs.reduce((a, b) => a + b, 0) : null,
    cost_coverage: `${costs.length}/${runs.length}`,
    image_tokens: ok.map((r) => r.image_tokens).filter((n) => typeof n === "number"),
    images_returned: imageCounts.reduce((a, b) => a + b, 0),
    // Present so the renderer can tell "not measured" from "measured and zero".
    quality_scored: false,
  };
}
