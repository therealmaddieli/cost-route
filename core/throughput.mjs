/**
 * Route C's throughput, derived from named hardware instead of asserted as a flat constant.
 *
 * `core/routes.mjs`'s SELF_HOST_ASSUMPTIONS prices GPU time from one hardcoded number,
 * `tokens_per_second: 80`, labelled "NOTHING HERE IS VERIFIED IN THIS BUILD." This module is an
 * opt-in alternative: throughput derived from three factors - a named GPU's public spec, the
 * model's parameter count, and the batch size the buyer actually plans to run - rather than one
 * invented constant. It is a first-order approximation, not a simulation, and it says so in its
 * own caveats rather than pretending to be more precise than it is.
 *
 * The GPU specs below are public vendor spec-sheet numbers (BF16 tensor core, dense, no
 * structural sparsity), verified against current spec sheets before this module was written -
 * not pulled from memory and asserted as fact. Re-verify them if NVIDIA revises a spec sheet.
 */

export const GPUS = {
  "l40s": {
    name: "NVIDIA L40S",
    memory_bandwidth_gbps: 864,
    bf16_tflops_dense: 366,
    source: "vendor spec sheet, BF16 tensor core, dense (no structural sparsity)",
  },
  "a100-80gb-sxm": {
    name: "NVIDIA A100 80GB SXM",
    memory_bandwidth_gbps: 2039,
    bf16_tflops_dense: 312,
    source: "vendor spec sheet, BF16 tensor core, dense (no structural sparsity)",
  },
  "h100-80gb-sxm": {
    name: "NVIDIA H100 80GB SXM",
    memory_bandwidth_gbps: 3350,
    bf16_tflops_dense: 989,
    source: "vendor spec sheet, BF16 tensor core, dense (no structural sparsity)",
  },
};

/**
 * Derive tokens/second from hardware x model size x batch, instead of asserting it.
 *
 * Two regimes, and the smaller one wins:
 *
 *   memory-bandwidth-bound - autoregressive decode reads ~all weights once per token, per
 *     request. Batching shares that read across concurrent requests, so throughput scales with
 *     batch size until the compute ceiling below is hit.
 *   compute-bound - a forward pass costs ~2 FLOPs per parameter per token, the standard
 *     transformer-FLOPs approximation. This is the ceiling batching runs into.
 *
 * Refuses rather than throws on a bad input, the same shape selfHostEstimate already uses for its
 * own refusals, so a caller can tell "no answer" from "a wrong answer" without a try/catch.
 */
export function estimateTokensPerSecond({
  gpu,
  modelParamsB,
  batchSize = 1,
  bytesPerParam = 2,
  utilization = 0.35,
} = {}) {
  const spec = GPUS[gpu];
  if (!spec) {
    const known = Object.keys(GPUS).join(", ");
    return { available: false, reason: `unknown gpu "${gpu}". Known GPUs: ${known}` };
  }
  if (!modelParamsB || modelParamsB <= 0) {
    return { available: false, reason: "modelParamsB must be a positive number" };
  }
  if (!batchSize || batchSize <= 0) {
    return { available: false, reason: "batchSize must be a positive number" };
  }
  if (!utilization || utilization <= 0 || utilization > 1) {
    return { available: false, reason: "utilization must be a number greater than 0 and at most 1" };
  }

  const paramsBytes = modelParamsB * 1e9 * bytesPerParam;
  const memoryBoundPerRequest = (spec.memory_bandwidth_gbps * 1e9) / paramsBytes;
  const memoryBoundAggregate = memoryBoundPerRequest * batchSize;
  const computeBoundCeiling = (spec.bf16_tflops_dense * 1e12) / (2 * modelParamsB * 1e9);

  const peakTokensPerSecond = Math.min(memoryBoundAggregate, computeBoundCeiling);
  const tokensPerSecond = peakTokensPerSecond * utilization;
  const regime = memoryBoundAggregate <= computeBoundCeiling ? "memory-bandwidth-bound" : "compute-bound";

  return {
    available: true,
    tokens_per_second: tokensPerSecond,
    regime,
    memory_bound_aggregate: memoryBoundAggregate,
    compute_bound_ceiling: computeBoundCeiling,
    gpu: spec.name,
    workings: [
      `${spec.name}: ${spec.memory_bandwidth_gbps.toLocaleString()} GB/s memory bandwidth, ` +
        `${spec.bf16_tflops_dense.toLocaleString()} TFLOPS BF16 dense (${spec.source})`,
      `${modelParamsB}B params x ${bytesPerParam} bytes/param = ${(paramsBytes / 1e9).toFixed(1)} GB ` +
        `of weights read per token, per request`,
      `memory-bound: ${memoryBoundPerRequest.toFixed(1)} tokens/sec per request x ${batchSize} batch ` +
        `= ${memoryBoundAggregate.toFixed(1)} tokens/sec aggregate`,
      `compute-bound ceiling: ${computeBoundCeiling.toFixed(1)} tokens/sec, from ~2 FLOPs/param/token`,
      `binding regime: ${regime === "memory-bandwidth-bound" ? "memory bandwidth" : "compute"}`,
      `at ${(utilization * 100).toFixed(0)}% utilization: ${tokensPerSecond.toFixed(1)} tokens/sec`,
    ],
    caveats: [
      "This is a first-order approximation: one dense forward pass per token, one GPU with no " +
        "tensor or pipeline parallelism, no MoE active-vs-total-params distinction, and no KV-cache " +
        "growth with context length. Each of these moves the real number, sometimes by a lot.",
      "utilization is a serving-efficiency guess, not a measurement - real-world inference serving " +
        "commonly lands well below theoretical peak.",
    ],
  };
}
