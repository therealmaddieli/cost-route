# Cost-Route

One page that prices the same AI workload across three procurement routes and shows where the
buyer's own estimate went wrong. Every measured figure on it comes from calls that were actually
made and billed, and every assumption is labelled as an assumption. The page is a single
self-contained HTML file: it opens in a browser with no server, no build step and no key.

**Read the report: https://therealmaddieli.github.io/cost-route/**

## What is on the page

Two workloads, as tabs.

**Legal contract review**, a text workload: 14 questions against a golden set, four candidate routes
across the three procurement routes, of which two produced answers on the day. Quality is gated by a
stated bar, 75% correct with no fabricated answers, and the page shows which candidates clear it.

**Image generation**: one prompt, two models, two runs each. There is no golden set, because whether
a generated picture is any good is a human judgement and not a machine one. The only machine gate is
the buyer's own 15,000ms latency ceiling.

For each workload the page opens with a three-column ledger: what the buyer stated their monthly
bill would be, what the buyer's own assumptions cost when priced out, and what the calls actually
cost. The gap between the first two columns is an arithmetic mistake, and no measurement could have
caught it. The gap between the last two is a measurement problem. A waterfall then names each reason
the estimate was wrong and what each reason was worth.

Two fields stay locked: the prompt size and the answer length that were actually measured. A reader
can move their own volume and their own estimate and watch the answer travel. The measurement is
held fixed in the arithmetic and not only in the markup, so the locked fields cannot be typed into
and cannot be set by script either.

## Where the numbers come from

- The measured figures were produced on **17 September 2026** by running the calls live. That run
  cost $0.17 in API spend.
- Prices were read from the OpenRouter, Hugging Face and Black Forest Labs catalogues on
  **15 September 2026**, and the report itself prints the fetch time it used.
- The workload inputs are synthetic: a made-up contract, made-up questions with known answers, and a
  made-up buyer estimate. No real client documents, no scraped contracts, no real counterparty names.
- Prices move. Re-running the pipeline reproduces the method, not these exact figures, and the page
  says so about itself in the section on what it cannot tell you.

## What is not in this repository

The pipeline that generates this page, meaning the benchmark runner, the ledger, the report renderer,
the benchmark runner's saved run files and the test suite, is not published here yet. This repository
currently holds the report itself, so that it has a link. The fuller README, with setup instructions
and how to point the tool at your own workload, arrives with the code.

## Limitations

- **One workload per kind, and a sample of one each.** These figures describe one contract and one
  image prompt. A different task has different token counts, a different cache hit rate, and may
  have a different winner.
- **The quality gate is evidence, not a guarantee.** 14 questions is enough to separate these
  candidates on this contract and not enough to promise anything about anyone else's.
- **A free route refused every call on the day.** `google/gemma-3-4b-it` on the Hugging Face router
  returned HTTP 429 to all 14 questions after the full retry schedule, with the provider reporting
  the model as rate-limited upstream. The page shows that route as unmeasured rather than pricing it
  from a guess.
- **Image quality is not scored here.** The pictures are on the page so that a reader can make the
  judgement no script here makes.
- **Latency varies between runs, enough to change a verdict.** The page shows the spread per
  candidate rather than hiding it behind one number, and one image candidate's verdict turned on
  exactly this.
- **Route C, open weights self-hosted, is an estimate.** It is built from named assumptions and is
  not a quoted price. The page says so on the row itself rather than sorting it in beside the two
  routes that do have prices.

## Built with

Claude Code, used as an agentic coding tool. The benchmark runner, the ledger, the report renderer,
the test suite and this page were written in sessions with it, and every measured claim the report
makes is backed by either a test or a saved run file.

Built by Madeline Li.
