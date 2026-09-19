#!/usr/bin/env python3
"""
Cost-Route smoke test.

Verifies every external endpoint the workflow depends on, before any n8n work starts.
Unauthenticated checks always run. Authenticated checks report SKIP when the key is absent,
so this is safe to run in CI or on a fresh clone.

Usage:
    python3 scripts/smoke_test.py             # free checks only; paid ones report SKIP
    python3 scripts/smoke_test.py --images    # also generate one image (~$0.01) to prove the image leg
    python3 scripts/smoke_test.py --bfl       # also probe BFL; parked 2026-09-14, no credits by choice

Keys are read from the environment, and from a .env file next to the repo root if one exists.
Secrets are never printed.
"""

from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

OPENROUTER_MODELS = "https://openrouter.ai/api/v1/models"
OPENROUTER_CHAT = "https://openrouter.ai/api/v1/chat/completions"
HF_ROUTER_MODELS = "https://router.huggingface.co/v1/models"
HF_ROUTER_CHAT = "https://router.huggingface.co/v1/chat/completions"
HF_MODEL_INFO = "https://huggingface.co/api/models/{id}"
BFL_BASE = os.environ.get("BFL_BASE_URL", "https://api.bfl.ai/v1")

UA = "cost-route-smoke/0.1"
TIMEOUT = 45

results: list[tuple[str, str, str]] = []  # (status, name, detail)


def record(status: str, name: str, detail: str = "") -> None:
    results.append((status, name, detail))
    icon = {"PASS": "  ok  ", "FAIL": " FAIL ", "SKIP": " skip "}[status]
    print(f"[{icon}] {name}")
    if detail:
        for line in detail.splitlines():
            print(f"         {line}")


def load_dotenv() -> None:
    """Minimal .env loader. Real environment always wins."""
    path = os.path.join(ROOT, ".env")
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key, value = key.strip(), value.strip().strip('"').strip("'")
            if key and value and key not in os.environ:
                os.environ[key] = value


def http(url: str, *, method: str = "GET", headers: dict | None = None,
         body: dict | None = None, timeout: int = TIMEOUT):
    """Return (status_code, parsed_json_or_text). Never raises for HTTP errors."""
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("User-Agent", UA)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", "replace")
            try:
                return resp.status, json.loads(raw)
            except json.JSONDecodeError:
                return resp.status, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw
    except Exception as exc:  # network, DNS, timeout
        return 0, f"{type(exc).__name__}: {exc}"


# ----------------------------------------------------------------------------
# Unit normalisation. THE ONE PLACE THIS CONVERSION LIVES.
# OpenRouter quotes USD per token as strings ("0.00000003").
# Hugging Face quotes USD per million tokens as floats (0.03).
# Comparing them without this conversion is wrong by a factor of 1,000,000.
# ----------------------------------------------------------------------------

def or_price_to_per_million(value) -> float | None:
    """OpenRouter pricing string (USD/token) -> USD per 1M tokens."""
    try:
        return float(value) * 1_000_000
    except (TypeError, ValueError):
        return None


def hf_price_to_per_million(value) -> float | None:
    """Hugging Face pricing float (already USD per 1M tokens) -> unchanged."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


# ----------------------------------------------------------------------------
# Unauthenticated checks
# ----------------------------------------------------------------------------

def check_openrouter_catalog() -> dict | None:
    status, payload = http(OPENROUTER_MODELS)
    if status != 200 or not isinstance(payload, dict):
        record("FAIL", "OpenRouter /models", f"HTTP {status} {str(payload)[:200]}")
        return None

    models = payload.get("data") or []
    priced = 0
    with_cache = with_tier = 0
    for m in models:
        pricing = m.get("pricing") or {}
        if or_price_to_per_million(pricing.get("prompt")) is not None:
            priced += 1
        if pricing.get("input_cache_read") is not None:
            with_cache += 1
        if pricing.get("overrides"):
            with_tier += 1

    record("PASS", "OpenRouter /models", "\n".join([
        f"{len(models)} models, {priced} priced, no auth required",
        f"{with_cache} expose input_cache_read, {with_tier} expose tiered overrides",
        "unit: USD per token, strings (needs the /1e6 conversion)",
    ]))
    return payload


def check_hf_catalog() -> dict | None:
    status, payload = http(HF_ROUTER_MODELS)
    if status != 200 or not isinstance(payload, dict):
        record("FAIL", "Hugging Face router /v1/models", f"HTTP {status} {str(payload)[:200]}")
        return None

    models = payload.get("data") or []
    multi = no_price = live = 0
    for m in models:
        provs = [p for p in (m.get("providers") or []) if isinstance(p, dict)]
        if len(provs) > 1:
            multi += 1
        for p in provs:
            if p.get("status") == "live":
                live += 1
            if not isinstance(p.get("pricing"), dict):
                no_price += 1

    record("PASS", "Hugging Face router /v1/models", "\n".join([
        f"{len(models)} models, {multi} served by more than one provider, {live} live provider entries",
        f"unit: USD per million tokens, floats (no conversion needed)",
        f"WATCH OUT: {no_price} provider entries carry NO pricing key - guard every read",
    ]))
    return payload


def check_hf_metadata() -> None:
    mid = "meta-llama/Llama-3.3-70B-Instruct"
    url = HF_MODEL_INFO.format(id=mid) + "?expand[]=cardData&expand[]=gated"
    status, payload = http(url)
    if status != 200 or not isinstance(payload, dict):
        record("FAIL", "Hugging Face model metadata (licence/gating)", f"HTTP {status}")
        return
    card = payload.get("cardData") or {}
    record("PASS", "Hugging Face model metadata (licence/gating)", "\n".join([
        f"{mid} -> licence={card.get('license')!r} gated={payload.get('gated')!r}",
        "licence and gating are the procurement facts a price table cannot express",
    ]))


def check_bfl_liveness() -> None:
    """Both BFL endpoints, without a key. Auth failures still prove the endpoint is alive."""
    ok = True
    detail = []

    status, payload = http(f"{BFL_BASE}/get_result?id=00000000-0000-0000-0000-000000000000")
    if isinstance(payload, dict) and "status" in payload:
        detail.append(f"get_result reachable (HTTP {status}, body {payload.get('status')!r})")
    else:
        ok = False
        detail.append(f"get_result unexpected: HTTP {status} {str(payload)[:120]}")

    status, payload = http(f"{BFL_BASE}/flux-dev", method="POST", body={"prompt": "smoke test"})
    if status in (401, 403):
        detail.append(f"flux-dev reachable, demands auth (HTTP {status}) - BFL returns 403, not 401")
    elif status == 200:
        detail.append("flux-dev answered without a key - unexpected")
    else:
        ok = False
        detail.append(f"flux-dev unexpected: HTTP {status} {str(payload)[:120]}")

    record("PASS" if ok else "FAIL", "Black Forest Labs endpoints", "\n".join(detail))


def check_cross_catalog_overlap(or_payload: dict | None, hf_payload: dict | None) -> None:
    if not or_payload or not hf_payload:
        record("SKIP", "Cross-catalog overlap", "depends on the two catalog fetches")
        return
    or_ids = {m.get("id") for m in (or_payload.get("data") or [])}
    hf_ids = {m.get("id") for m in (hf_payload.get("data") or [])}
    shared = sorted(or_ids & hf_ids)
    record("PASS", "Cross-catalog overlap", "\n".join([
        f"{len(shared)} models appear on BOTH catalogs: {', '.join(shared[:6])}"
        + (" ..." if len(shared) > 6 else ""),
        "the routes mostly serve DIFFERENT model populations - the comparison is",
        "best-closed vs best-open-weight-served vs self-hosted, not the same model twice",
    ]))


# ----------------------------------------------------------------------------
# Authenticated checks
# ----------------------------------------------------------------------------

def check_openrouter_live(key: str | None, model: str | None) -> None:
    if not key:
        record("SKIP", "OpenRouter chat completion", "OPENROUTER_API_KEY not set")
        return
    if not model:
        record("SKIP", "OpenRouter chat completion", "catalog fetch failed, no model to call")
        return
    status, payload = http(
        OPENROUTER_CHAT, method="POST",
        headers={"Authorization": f"Bearer {key}"},
        body={"model": model, "messages": [{"role": "user", "content": "Reply with the single word OK."}],
              "max_tokens": 8},
    )
    if status != 200 or not isinstance(payload, dict):
        record("FAIL", "OpenRouter chat completion", f"HTTP {status} {str(payload)[:220]}")
        return
    usage = payload.get("usage") or {}
    record("PASS", "OpenRouter chat completion", "\n".join([
        f"model={model}",
        f"usage: prompt={usage.get('prompt_tokens')} completion={usage.get('completion_tokens')}"
        + (f" reasoning={usage.get('completion_tokens_details', {}).get('reasoning_tokens')}"
           if isinstance(usage.get('completion_tokens_details'), dict) else ""),
        "this is the measured-cost path: real usage, not an estimate",
    ]))


def check_hf_live(token: str | None) -> None:
    if not token:
        record("SKIP", "Hugging Face inference", "HF_TOKEN not set (create one at huggingface.co/settings/tokens)")
        return
    model = "openai/gpt-oss-120b"  # present on both catalogs
    status, payload = http(
        HF_ROUTER_CHAT, method="POST",
        headers={"Authorization": f"Bearer {token}"},
        body={"model": model, "messages": [{"role": "user", "content": "Reply with the single word OK."}],
              "max_tokens": 8},
    )
    if status != 200 or not isinstance(payload, dict):
        record("FAIL", "Hugging Face inference", f"HTTP {status} {str(payload)[:220]}")
        return
    usage = payload.get("usage") or {}
    record("PASS", "Hugging Face inference", "\n".join([
        f"model={model}",
        f"usage: prompt={usage.get('prompt_tokens')} completion={usage.get('completion_tokens')}",
    ]))


def check_bfl_live(key: str | None) -> None:
    if not key:
        record("SKIP", "FLUX generate + poll", "BFL_API_KEY not set")
        return
    status, payload = http(f"{BFL_BASE}/flux-dev", method="POST",
                           headers={"x-key": key}, body={"prompt": "a single red circle on white"})
    if status != 200 or not isinstance(payload, dict) or "id" not in payload:
        # BFL distinguishes these clearly, and the distinction changes what you do about it.
        diagnosis = {
            401: "key rejected - check BFL_API_KEY",
            403: "forbidden - key is valid but lacks access to this endpoint/tier",
            402: "KEY IS VALID, ACCOUNT HAS NO CREDITS - top up at dashboard.bfl.ai",
            404: "route not found - the slug does not exist",
            429: "rate limited - retry later",
        }.get(status, f"unexpected status {status}")
        record("FAIL", "FLUX generate + poll", "\n".join([
            f"submit HTTP {status}: {diagnosis}",
            f"body: {str(payload)[:160]}",
        ]))
        return

    task_id = payload["id"]
    poll_url = payload.get("polling_url") or f"{BFL_BASE}/get_result?id={task_id}"
    deadline = time.time() + 90
    last = {}
    while time.time() < deadline:
        code, last = http(poll_url, headers={"x-key": key})
        if isinstance(last, dict) and last.get("status") != "Pending":
            break
        time.sleep(3)

    state = (last or {}).get("status")
    if state != "Ready":
        record("FAIL", "FLUX generate + poll", f"ended in status={state!r} after ~90s")
        return
    result = last.get("result") or {}
    record("PASS", "FLUX generate + poll", "\n".join([
        f"status=Ready, image={str(result.get('sample'))[:70]}",
        f"response cost field={last.get('cost')!r}",
        "async confirmed: submit, then poll until Ready",
    ]))


def image_models(or_payload: dict | None) -> list[tuple[str, str]]:
    """Concrete image-output models, cheapest image_output first. Routers excluded."""
    out = []
    for m in (or_payload or {}).get("data") or []:
        arch = m.get("architecture") or {}
        if "image" not in (arch.get("output_modalities") or []):
            continue
        mid = m.get("id") or ""
        if mid.startswith("openrouter/auto"):
            continue  # OpenRouter's own auto-routers, not models
        price = (m.get("pricing") or {}).get("image_output")
        out.append((mid, price))
    def key(row):
        try:
            v = float(row[1])
            return v if v >= 0 else 9e9
        except (TypeError, ValueError):
            return 9e9
    return sorted(out, key=key)


def check_image_catalog(or_payload: dict | None) -> None:
    """Which models produce images and at what rate. Free - reads the catalog only."""
    if not or_payload:
        record("SKIP", "Image models in catalog", "depends on the OpenRouter fetch")
        return
    rows = image_models(or_payload)
    detail = [f"{len(rows)} concrete image models, cheapest image_output first:"]
    for mid, price in rows[:5]:
        detail.append(f"  {mid:<40} image_output={price!r}")
    detail += [
        "image_output is USD per image output TOKEN, not per image",
        "confirmed by payment 2026-09-14: 1290 image tokens x 0.00003 = $0.0387 = usage.cost",
    ]
    record("PASS" if rows else "FAIL", "Image models in catalog", "\n".join(detail))


def check_image_live(key: str | None, model: str | None) -> None:
    """PAID - spends real money. Only runs behind --images."""
    if not key:
        record("SKIP", "Image generation (paid)", "OPENROUTER_API_KEY not set")
        return
    if not model:
        record("SKIP", "Image generation (paid)", "no image model in the catalog")
        return

    status, payload = http(
        OPENROUTER_CHAT, method="POST", timeout=180,
        headers={"Authorization": f"Bearer {key}"},
        body={"model": model,
              "messages": [{"role": "user", "content": "a single red circle on a plain white background"}],
              "modalities": ["image", "text"]},
    )
    if status != 200 or not isinstance(payload, dict):
        record("FAIL", "Image generation (paid)", f"HTTP {status} {str(payload)[:220]}")
        return

    usage = payload.get("usage") or {}
    details = usage.get("completion_tokens_details") or {}
    images = ((payload.get("choices") or [{}])[0].get("message") or {}).get("images") or []
    cost = usage.get("cost")

    lines = [
        f"model={model}  images returned={len(images)}",
        f"prompt_tokens={usage.get('prompt_tokens')} "
        f"image_tokens={details.get('image_tokens')} reasoning_tokens={details.get('reasoning_tokens')}",
        f"usage.cost={cost!r}   <-- the authority, never our own arithmetic",
    ]
    if cost is None:
        lines.append("WARNING: usage.cost missing - the measured-cost path has no fallback")
    if not images:
        lines.append("WARNING: response carried no image block")
    record("PASS" if (cost is not None and images) else "FAIL", "Image generation (paid)", "\n".join(lines))


def check_units() -> None:
    """Prove the conversion behaves on real values from both catalogs."""
    sample_or = "0.00000003"   # $0.03 per 1M tokens
    sample_hf = 0.03           # $0.03 per 1M tokens
    a, b = or_price_to_per_million(sample_or), hf_price_to_per_million(sample_hf)
    ok = a is not None and b is not None and abs(a - b) < 1e-9
    record("PASS" if ok else "FAIL", "Unit normalisation", "\n".join([
        f'OpenRouter "0.00000003" per token -> ${a}/M',
        f"Hugging Face 0.03 per M          -> ${b}/M",
        "same model, same real price: conversion is correct",
    ]))


# ----------------------------------------------------------------------------

def main() -> int:
    load_dotenv()

    print("\nCost-Route Day 1 smoke test")
    print(f"{time.strftime('%Y-%m-%d %H:%M')}  root={ROOT}\n")

    or_payload = check_openrouter_catalog()
    hf_payload = check_hf_catalog()
    check_hf_metadata()
    check_bfl_liveness()
    check_cross_catalog_overlap(or_payload, hf_payload)
    check_image_catalog(or_payload)
    check_units()

    print()
    # Pick a cheap, plainly available model from the live catalog for the auth probe.
    probe_model = "openai/gpt-4o-mini"
    if or_payload:
        ids = {m.get("id") for m in (or_payload.get("data") or [])}
        if probe_model not in ids:
            cheap = sorted(
                (m for m in or_payload["data"]
                 if (m.get("pricing") or {}).get("prompt")
                 and "text" in ((m.get("architecture") or {}).get("output_modalities") or [])),
                key=lambda m: float(m["pricing"]["prompt"]),
            )
            probe_model = cheap[0]["id"] if cheap else None

    check_openrouter_live(os.environ.get("OPENROUTER_API_KEY"), probe_model)
    check_hf_live(os.environ.get("HF_TOKEN"))

    image_rows = image_models(or_payload)
    if "--images" in sys.argv:
        check_image_live(os.environ.get("OPENROUTER_API_KEY"), image_rows[0][0] if image_rows else None)
    else:
        record("SKIP", "Image generation (paid)",
               f"{len(image_rows)} image models available; rerun with --images to spend ~$0.01 and verify")

    # BFL is parked by decision (2026-09-14): no credit top-up, and no longer on the critical path.
    # The account is known to be creditless, so running it would only produce a red line that means
    # nothing. Opt in with --bfl when there is a reason to look again.
    if "--bfl" in sys.argv:
        check_bfl_live(os.environ.get("BFL_API_KEY"))
    else:
        record("SKIP", "FLUX generate + poll",
               "parked 2026-09-14 - not a build dependency; the account has no credits by choice")

    passed = sum(1 for s, _, _ in results if s == "PASS")
    failed = sum(1 for s, _, _ in results if s == "FAIL")
    skipped = sum(1 for s, _, _ in results if s == "SKIP")

    print(f"\n{'=' * 62}")
    print(f"  {passed} passed   {failed} failed   {skipped} skipped")
    if skipped:
        print("  skipped = a key missing from .env, or an opt-in flag not passed")
        print("            --images spends ~$0.01;  --bfl is parked by decision 2026-09-14")
    if failed:
        print("  FAILURES above - fix before building on top")
    print(f"{'=' * 62}\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
