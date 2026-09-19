# Units: the one conversion, in one place

The two catalogs quote price in **different units**. Comparing them without converting is wrong by a
factor of **1,000,000**, and the error is silent. This is the canonical note; the code that
implements it lives in `scripts/smoke_test.py` and will be reused by the cost engine.

| Source | Field | Unit | Type | Example | Meaning |
|---|---|---|---|---|---|
| OpenRouter | `pricing.prompt`, `pricing.completion`, `pricing.input_cache_read`, `pricing.input_cache_write` | **USD per token** | string | `"0.00000003"` | $0.03 per 1M tokens |
| OpenRouter | `pricing.overrides[].prompt` etc. | USD per token | string | `"0.00002"` | tiered rate above `min_prompt_tokens` |
| OpenRouter | `pricing.image_output` | **USD per image output TOKEN** | string | `"0.00003"` | **CORRECTED 2026-09-14 by measurement.** NOT per image. Gemini 2.5 Flash Image billed 1,290 image tokens x $0.00003 = $0.0387 |
| OpenRouter | `pricing.image`, `pricing.web_search` | USD per unit | string | `"0.000002"` | per input image / per search. These ARE per call, unlike `image_output` |
| Hugging Face | `providers[].pricing.input`, `.output` | **USD per 1M tokens** | float | `0.03` | $0.03 per 1M tokens |
| BFL | `cost` in the `get_result` response | **credits**, 1 credit = $0.01 | number | `4.0` | $0.04 per image |

## The conversion

```python
def or_price_to_per_million(value):   # OpenRouter: USD/token string -> USD per 1M
    return float(value) * 1_000_000

def hf_price_to_per_million(value):   # Hugging Face: already USD per 1M
    return float(value)
```

**Internal standard: USD per 1,000,000 tokens.** Convert on ingest, keep the original alongside for
the report, and print the unit on every figure. A report that shows `0.00000003` next to `0.03`
without naming units is worse than no report.

## Verified

`scripts/smoke_test.py` asserts that OpenRouter's `"0.00000003"` and Hugging Face's `0.03` both
normalise to `$0.03/M`. If that check ever fails, stop and fix it before trusting any other number.

`scripts/smoke_test.py --images` additionally proves the image conversion by **paying for one real
generation and checking the arithmetic against what was actually charged.** Measured 2026-09-14 on
`google/gemini-2.5-flash-image`:

```
pricing.image_output      "0.00003"           USD per image token
usage.completion_tokens_details.image_tokens   1290
                  product                    $0.0387
usage.cost                 reported            $0.0387042   <-- matches, plus 14 prompt tokens
```

Three further facts from that same call, all of which the cost engine must handle:

1. **Image cost is billed as completion tokens.** There is no separate image line in the response.
   `usage.cost_details.upstream_inference_completions_cost` ($0.0387) *is* the image charge. Adding
   up "tokens x base rate" and expecting images to appear elsewhere will silently undercount by the
   entire image spend.
2. **Image models bill reasoning tokens too.** `openai/gpt-5-image-mini` charged 768 reasoning tokens
   on a prompt that asked for a picture. The `internal_reasoning` mechanic is not text-only.
3. **`usage.cost` is authoritative.** Prefer it over any arithmetic of our own, and use the
   arithmetic only to explain where the number came from. This is why the tool can honestly claim
   "measured, not multiplied."
