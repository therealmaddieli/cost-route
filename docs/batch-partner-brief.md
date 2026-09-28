# Batch API: partner adoption brief

Written 2026-09-28, for OpenRouter's product-partnerships function. Everything below is either read
from OpenRouter's own live API on that date or quoted from their published docs; where a number is
measured rather than read, it says so. Sources are named inline.

**The one-line version:** Batch is a 50% price cut that most partners cannot afford to sell, because
a partner paid on a share of consumption loses half their revenue per unit to give the customer the
saving. The adoption problem is a compensation-design problem, not a documentation problem.

---

## 1. What Batch actually is, commercially

`POST /api/v1/batches` takes one model, one provider and up to a large set of `{custom_id, body}`
requests, returns `202`, and delivers results in a single `results[]` array when the batch reaches
`completed`. Statuses run `validating → in_progress → finalizing → completed`, with `failed`,
`expired`, `cancelled` as terminal exits.

Four properties decide who can use it, and each one maps to a customer segment:

| property | consequence |
|---|---|
| **Asynchronous**, `completion_window: "24h"` is the only accepted value | Only latency-tolerant work. Anything with a human waiting is out. |
| **Text only** — "Base64 and `data:` URI images are rejected on every provider"; audio and video too | Every multimodal pipeline is out, at every provider, with no workaround. |
| **No OpenRouter-orchestrated web search**; `:online` variants rejected with `422` | Research-augmented generation is out. |
| **One provider, chosen at submit, no fallback** | A provider outage fails the batch rather than rerouting it. |

The addressable workload is therefore: **high-volume, non-interactive, text-in/text-out.** Batch
scoring runs, dataset labelling and enrichment, document backfills, nightly summarisation, regression
suites, bulk classification. That is a real and large market — but it is a *different* market from
the interactive traffic that most partners' integrations were built around, and that distinction is
the first thing a partner conversation has to settle.

## 2. The commercial asymmetry — the actual blocker

The docs say: *"Batch requests are typically billed at 50% of the model's standard per-token
pricing."*

For a partner whose take is a share of customer spend — the standard shape for an aggregator, a
reseller, a platform taking a margin on inference — a 50% unit-price cut is a 50% revenue cut on
every workload moved to Batch, unless the contract says otherwise. The customer's saving is the
partner's loss, one for one.

The partners best positioned to drive adoption are exactly the ones with the strongest reason not to:

- They have the existing integration and the customer relationship.
- They also have per-seat or per-spend economics that Batch directly erodes.
- Their sales compensation, if it is quota-on-revenue, pays them half as much for the same work.

So the question to bring to a partner is not "would your customers like to pay less" — obviously they
would. It is **"what makes it worth your while to tell them?"** Three structures to consider, in
rough order of how easy they are to administer:

1. **Flat per-request or per-batch bounty.** Decouples partner compensation from the price cut
   entirely. Cleanest to explain, and it works for a partner whose volume is unknown at signing.
2. **A revenue-share floor.** Guarantee the partner's per-unit economics for a defined period or
   volume band, so the cut is absorbed by the platform for as long as it takes the volume to grow
   past the loss. This is a bet on elasticity, and it should be priced as one.
3. **Crediting batch consumption at gross for tier attainment.** The partner is paid on the
   undiscounted rate for status and tier purposes, while the customer is billed the batch rate. Keeps
   the ladder intact; costs the platform the difference.

None of these is free. The point of stating them together is that "launch batch and tell partners"
is not a plan: it asks partners to fund a customer discount out of their own margin, and the ones
who understand their numbers will quietly not do it.

## 3. What the catalogue actually says

The Batch discount is not one number. On 2026-09-28, `GET /api/v1/models` carried **72 `:batch`
entries**, each a full model entry with its own `pricing` object — so the whole comparison is
readable without submitting anything. All figures in this section are from the catalogue read at
**09:03:36Z on 2026-09-28**; the read time travels with the numbers, for the reason under *"the ratio
is a property of a read"* below.

| | count |
|---|---|
| batch cards published | 72 |
| exactly 0.5× the standard card | 65 |
| cheaper than 0.5× | 3 |
| dearer than 0.5×, still a discount | 2 |
| **more expensive than the standard card** | **2** |

The seven that are not 0.5×:

| model | prompt | completion |
|---|---|---|
| `openai/gpt-oss-120b` | ×0.197 | ×0.227 |
| `z-ai/glm-5.3` | ×0.321 | ×0.455 |
| `z-ai/glm-5.3-flash` | ×0.400 | ×0.400 |
| `moonshotai/kimi-k3` | ×0.760 | ×0.760 |
| `x-ai/grok-4.3` | ×0.800 | ×0.800 |
| `openai/gpt-oss-20b` | **×1.333** | **×1.244** |
| `deepseek/deepseek-v4.1-flash` | **×4.480** | ×0.560 |

Both surcharges were submitted to the live Batch API on 2026-09-28 and both were accepted, so they
are purchasable rather than a listing artefact. A partner who integrates batch and routes work to
either pays *more* than if they had sent the same requests synchronously — which, for a partner whose
pitch to their customer is "batch will save you money", is a support ticket waiting to happen.

**The ratio is a property of a read, not of the model** — and this is not a hypothetical. On
2026-09-28, `z-ai/glm-5.3` was read twice from the same endpoint with the same key: once showing a
standard prompt rate of $0.1785/M against a batch rate of $0.45/M, a ×2.521 async **surcharge**, and
then at $1.40/M against the same $0.45/M minutes later, a ×0.321 async **discount**. The batch card
never moved; the standard card was read two ways, a factor of 7.8 apart, and a second model disagreed
between the same two reads while its own batch card did not. Whatever that is — and the mechanism is
not knowable from outside — it is not a number to build a contract on.

**The commercial consequence, which is the part that matters to a partnerships role:** the batch
price cannot go into a partner contract as a fixed number, into a partner deck as a promise, or into
a partner's own forecast as an input. A partner who reads the ratio on the wrong request prices in
the wrong direction and nothing in their integration tells them. If this is what the endpoint does,
then "read the card at the point of use, and put the read date next to the number" is not good
practice — it is a term of the deal.

**Cached input is a separate discount, and on some models there isn't one.** The docs warn that
"prompt-caching rates vary by model", and the catalogue confirms it: of the 61 batch cards that
publish a cache-read rate on both sides, 53 discount it by exactly half and **three discount it not
at all** — `google/gemini-2.5-flash`, `google/gemini-2.5-flash-lite` and `google/gemini-2.5-pro` all
carry an identical cache rate on both cards ($0.03/M, $0.01/M and $0.125/M respectively).

That last group is where the headline number does real damage. Cached tokens are not discounted on
either card, so the 50% applies only to the uncached remainder — and the size of the saving is set
by the cache-hit rate, not by the announcement:

| cache-hit rate | effective batch saving, `gemini-2.5-flash` |
|---|---|
| 0% | 50.0% |
| 50% | 25.0% |
| 90% | **5.0%** |

A partner running a cache-heavy pipeline on Gemini is being told to migrate to batch to save 50% and
will actually save **5%** — while, per section 2, giving up half their revenue per unit to do it.
This is the single most important number in this brief for anyone whose workload caches well: on
these three cards the batch discount and the cache discount are not additive, they are the same
discount applied to different tokens, and one of them is zero.

**The bill can be a deeper cut than the card.** One batch was actually bought and compared against the
synchronous run of the same 14 questions on the same model, so the two are comparable down to the
prompt: **41,991 prompt tokens on each leg.**

| | sync, 2026-09-21 | batch, 2026-09-28 |
|---|---|---|
| billed | $0.10869 | $0.043896 |
| **ratio** | | **0.404 — not 0.500** |

The published card is exactly what it claims — the batch bill is $41,991 × $1/M + 381 × $5/M to the
cent. The gap comes from the input side: the synchronous leg wrote ~3,000 tokens to cache on every
call and read back none, so it paid the cache-*write* rate of $2.50/M on every prompt token — 1.25×
its listed $2/M. The batch leg wrote nothing and read nothing and paid the plain $1/M. And
0.5 ÷ 1.25 = 0.400, which is the measured ratio exactly.

For a partner this makes the compensation problem in section 2 **worse, not better**: the customer's
saving on a workload like this is 60%, not the 50% the announcement implies, and every point of it
comes off the partner's top line. It also means the saving is not a fixed property of the model — it
moves with the cache behaviour of the run, so a partner cannot simply be told "expect half".

**And one published card cannot be bought.** `openai/gpt-4o-mini:batch` is listed by
`GET /api/v1/models` at $0.075/M input — exactly half the standard $0.15/M — and its own endpoints
listing shows a provider endpoint for it. Submitting to it returns:

```
400 {"error":{"message":"Model 'openai/gpt-4o-mini:batch' does not have a :batch endpoint."}}
```

Submitting the base slug returns the same error. Both were reproduced; `openai/gpt-5.6-sol:batch`,
`anthropic/claude-fable-5.1:batch` and `google/gemini-2.5-flash:batch` all accepted the identical
payload in the same minute, so the model is the only variable. This matters commercially because
`gpt-4o-mini` is the cheap default a great many integrations are built on: the first model a partner
will reach for is the one whose advertised batch price cannot be used.

**Scope of this claim, stated honestly.** One model was verified as unpurchasable. How many of the
other 71 are in the same state is **not known** — establishing that would mean one submission per
card against a live API, which is not a thing to do uninvited. The finding is that the published
catalogue is not a reliable statement of what can be bought, not a rate.

## 4. Who to sell it to first

Segment by workload shape, not by industry. The best first partners have all four:

- **Batch-native volume** — work that already runs as a job, not a request. Evaluation harnesses,
  labelling pipelines, nightly document processing.
- **Text-only** — no images, audio, or web-search augmentation, because none of those can go to batch
  at any provider.
- **High cache-hit rate *and* a model whose cache rate is actually discounted** — check the card
  before promising a number.
- **A pricing model that does not pay them on a share of spend**, or a contract that has already been
  restructured per section 2.

The worst first partner is a consumer-facing integration on an image or search-augmented model. They
will spend a quarter integrating something they can never route.

## 5. Four decisions to make before pushing adoption

1. **Fix or withdraw `openai/gpt-4o-mini:batch`.** Either make it submittable or drop it from the
   models listing. A price that cannot be bought is worse than no price, and this one sits on the
   most-used cheap model in the catalogue.
2. **Decide whether the sub-50% and above-50% cards are intentional.** `openai/gpt-oss-120b` at
   ×0.197 is a gift; `deepseek/deepseek-v4.1-flash` at ×4.480 on input is a trap. If they are
   deliberate pricing, they need a note; if they are not, they are a data bug with a customer-visible
   blast radius.
3. **Find out why the same read returned two different standard cards four minutes apart.**
   `z-ai/glm-5.3` at $0.1785/M and then $1.40/M, with the batch card at $0.45/M throughout. If that
   is an upstream provider repricing and propagating unevenly, partners need to know it moves
   mid-session. If it is a caching or data-freshness inconsistency in the models listing, it is a
   bug — and it is one that makes any quoted batch ratio unreliable, which is worse than either.
4. **Settle the partner-compensation question in section 2 before the partner conversations start.**
   It is the actual constraint, and a partner who raises it in the first call has already decided
   against adoption.

## 6. What I would do in the first 90 days

- **Weeks 1–2.** Audit the 72 published batch cards against submittability; publish the exception
  list. This is a data question with a commercial answer and it is currently unanswered.
- **Weeks 2–6.** Take the compensation structure to three or four partners with batch-native volume
  and get real numbers back. The elasticity assumption in any revenue-share floor should be tested
  before it is written into more than one contract.
- **Weeks 4–12.** Build the reference integration for the one workload shape that needs no
  negotiation: an offline evaluation or labelling job. It demonstrates the saving without requiring
  the customer to change how anything interactive works.
- **Continuous.** Keep the price-vs-bill gap visible. The whole reason this brief exists is that the
  headline number and the invoice disagree on some models, and the partners most likely to notice are
  the ones already burned.

---

### Provenance

| claim | source | read |
|---|---|---|
| batch body fields, order, statuses, results shape, text-only limits | `openrouter.ai/docs/batch-quickstart.md` | 2026-09-28 |
| 72 `:batch` entries; the ratio table; the cache-rate counts | `GET https://openrouter.ai/api/v1/models` | 2026-09-28 **09:03:36Z** |
| `z-ai/glm-5.3` read two ways four minutes apart; `deepseek/deepseek-v4.1-flash` likewise | the same endpoint, sampled directly 2026-09-28 09:00Z and six times across 09:03:59–09:05:23Z; the batch rates identical in every sample, the standard rates not | 2026-09-28 |
| `gpt-4o-mini:batch` listed with a provider endpoint | `GET /api/v1/models/openai/gpt-4o-mini:batch/endpoints` | 2026-09-28 |
| the `400` on submit, reproduced; three control models accepted | `POST https://openrouter.ai/api/v1/batches` | 2026-09-28, re-confirmed 09:01Z |
| the measured bill and its token decomposition | `usage.cost` and per-call `cost_details` on batch `batch-1790584823-viV1KTi3dSpvTgQ29B6i` and on the synchronous run of the same 14 questions | 2026-09-28 |
| effective saving by cache-hit rate | computed from the two published cards per model at the **09:03:36Z** read, the read section 3 declares; the three cache rates are identical in the 08:59:55Z and 09:03:36Z reads | 2026-09-28 |

The scan that produces the ratio table is `scripts/batch-scan.mjs`, which reads the catalogue and
costs nothing to run. **Read the ratios from a fresh scan rather than from this document**, and read
them more than once — the `z-ai/glm-5.3` row above is the evidence that one read is not a
measurement, and the date a number was read is part of the number.
