/**
 * Route C's hardware-derived throughput: three factors (named GPU, model size, batch) instead of
 * one asserted constant.
 *
 * The arithmetic is simple enough to hand-compute, so the tests below do exactly that rather than
 * asserting against the function's own output - a bug in the formula would otherwise pass against
 * itself.
 *
 * Run: node --test tests/
 */

import test from "node:test";
import assert from "node:assert/strict";

import { GPUS, estimateTokensPerSecond } from "../core/throughput.mjs";

// ---------------------------------------------------------------------------
// refusals
// ---------------------------------------------------------------------------

test("an unknown GPU refuses and names itself", () => {
  const r = estimateTokensPerSecond({ gpu: "rtx-whatever", modelParamsB: 7 });
  assert.equal(r.available, false);
  assert.match(r.reason, /unknown gpu "rtx-whatever"/);
  assert.match(r.reason, /l40s/, "the refusal should name the known GPUs");
});

test("a non-positive model size refuses", () => {
  const r = estimateTokensPerSecond({ gpu: "l40s", modelParamsB: 0 });
  assert.equal(r.available, false);
  assert.match(r.reason, /modelParamsB must be a positive number/);
});

test("a non-positive batch size refuses", () => {
  const r = estimateTokensPerSecond({ gpu: "l40s", modelParamsB: 7, batchSize: -1 });
  assert.equal(r.available, false);
  assert.match(r.reason, /batchSize must be a positive number/);
});

test("a utilization outside (0, 1] refuses", () => {
  assert.equal(estimateTokensPerSecond({ gpu: "l40s", modelParamsB: 7, utilization: 0 }).available, false);
  assert.equal(estimateTokensPerSecond({ gpu: "l40s", modelParamsB: 7, utilization: 1.5 }).available, false);
});

// ---------------------------------------------------------------------------
// hand-computed regimes
// ---------------------------------------------------------------------------

test("a small batch on L40S is memory-bandwidth-bound, and the figure matches hand arithmetic", () => {
  // 864 GB/s / (7B x 2 bytes) = 864e9 / 14e9 = 61.714... tokens/sec per request, at batch 1.
  const r = estimateTokensPerSecond({
    gpu: "l40s",
    modelParamsB: 7,
    batchSize: 1,
    bytesPerParam: 2,
    utilization: 1,
  });
  assert.equal(r.available, true);
  assert.equal(r.regime, "memory-bandwidth-bound");
  const expected = (864 * 1e9) / (7 * 1e9 * 2);
  assert.ok(Math.abs(r.tokens_per_second - expected) < 1e-6, `${r.tokens_per_second} vs ${expected}`);
  // Nowhere near the compute ceiling at batch 1.
  assert.ok(r.tokens_per_second < r.compute_bound_ceiling);
});

test("batching scales the memory-bound figure linearly, until the compute ceiling", () => {
  const base = estimateTokensPerSecond({ gpu: "l40s", modelParamsB: 7, batchSize: 1, utilization: 1 });
  const batched = estimateTokensPerSecond({ gpu: "l40s", modelParamsB: 7, batchSize: 8, utilization: 1 });
  assert.ok(Math.abs(batched.tokens_per_second - base.tokens_per_second * 8) < 1e-6);
  assert.equal(batched.regime, "memory-bandwidth-bound", "8x batch should not yet cross the compute ceiling");
});

test("a large enough batch crosses into compute-bound, and the ceiling matches hand arithmetic", () => {
  // Compute ceiling = 366e12 / (2 x 7e9) = 26,142.86 tokens/sec. Memory-bound per request is
  // ~61.71 tokens/sec, so a batch of 500 (aggregate ~30,857) comfortably crosses the ceiling.
  const r = estimateTokensPerSecond({
    gpu: "l40s",
    modelParamsB: 7,
    batchSize: 500,
    bytesPerParam: 2,
    utilization: 1,
  });
  assert.equal(r.regime, "compute-bound");
  const expectedCeiling = (366 * 1e12) / (2 * 7 * 1e9);
  assert.ok(Math.abs(r.tokens_per_second - expectedCeiling) < 1e-3, `${r.tokens_per_second} vs ${expectedCeiling}`);
  assert.ok(r.memory_bound_aggregate > r.compute_bound_ceiling, "the memory-bound figure should exceed the ceiling here");
});

test("utilization scales the final figure linearly within a fixed regime", () => {
  const full = estimateTokensPerSecond({ gpu: "l40s", modelParamsB: 7, batchSize: 1, utilization: 1 });
  const half = estimateTokensPerSecond({ gpu: "l40s", modelParamsB: 7, batchSize: 1, utilization: 0.5 });
  assert.ok(Math.abs(half.tokens_per_second - full.tokens_per_second / 2) < 1e-6);
});

// ---------------------------------------------------------------------------
// defaults and the shipped GPU table
// ---------------------------------------------------------------------------

test("batchSize, bytesPerParam and utilization default sensibly when omitted", () => {
  const r = estimateTokensPerSecond({ gpu: "h100-80gb-sxm", modelParamsB: 70 });
  assert.equal(r.available, true);
  assert.ok(r.tokens_per_second > 0);
});

test("every shipped GPU carries a name, a bandwidth and a TFLOPS figure", () => {
  for (const [slug, spec] of Object.entries(GPUS)) {
    assert.ok(spec.name, `${slug}: missing a name`);
    assert.ok(spec.memory_bandwidth_gbps > 0, `${slug}: missing memory bandwidth`);
    assert.ok(spec.bf16_tflops_dense > 0, `${slug}: missing BF16 TFLOPS`);
    assert.ok(spec.source, `${slug}: missing a source`);
  }
});

test("a successful estimate carries its own workings and caveats, not a bare number", () => {
  const r = estimateTokensPerSecond({ gpu: "a100-80gb-sxm", modelParamsB: 8, batchSize: 4 });
  assert.ok(r.workings.length > 0);
  assert.ok(r.caveats.length > 0);
  assert.match(r.caveats.join(" "), /first-order approximation/);
});
