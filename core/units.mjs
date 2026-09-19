/**
 * The one place a price is converted.
 *
 * The two catalogues quote price in different units. OpenRouter is USD per token as a string
 * ("0.00000003"). Hugging Face is USD per million tokens as a float (0.03). Those two numbers
 * describe the same price, and comparing them without converting is wrong by a factor of a
 * million, silently.
 *
 * So every conversion in this project happens here, and nowhere else. If a price ever needs
 * converting a second time, that is a bug in the design, not a reason to add a second helper.
 * The original value is always kept alongside the converted one so the report can show what the
 * catalogue actually said.
 *
 * Canonical note: docs/units.md.
 */

/** Internal standard: USD per 1,000,000 tokens. Every price in this project is this unit. */
export const PER_MILLION = 1_000_000;

/**
 * Parse a price that may be a string, a number, null, undefined, or an empty string.
 *
 * Returns null rather than 0 for anything unparseable, because those are different facts. A
 * missing price means "the catalogue does not say", and a cost engine that renders it as $0.00
 * would report a model as free when it is merely unknown. Day 1 found 111 Hugging Face provider
 * entries carrying no pricing key at all, so this path is the common one, not the edge case.
 */
export function toNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Number(String(value).trim());
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Round a converted price to a precision a price can actually have.
 *
 * Multiplying a per-token string by 1e6 reintroduces binary floating point noise: $0.05/M comes
 * back as 0.049999999999999996. Rounding here rather than at print time matters because these
 * numbers are also compared and serialised, and a report that shows "$0.0500/M" while its JSON
 * says something else is two sources of truth. Six decimal places leaves any real price intact.
 */
export function roundPrice(value) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(6));
}

/** OpenRouter: USD per token -> USD per 1M tokens. */
export function perTokenToPerMillion(value) {
  const n = toNumber(value);
  return n === null ? null : roundPrice(n * PER_MILLION);
}

/** Hugging Face: already USD per 1M tokens. Present so the asymmetry is visible, not implied. */
export function perMillionToPerMillion(value) {
  return roundPrice(toNumber(value));
}

/** Format a USD-per-million figure for a report, with the unit attached. Never bare. */
export function formatPerMillion(perM) {
  if (perM === null || perM === undefined) return "n/a";
  return `$${perM.toFixed(4)}/M`;
}

/** Format a dollar amount at a scale that suits it. */
export function formatUSD(value) {
  if (value === null || value === undefined) return "n/a";
  if (value === 0) return "$0.00";
  if (Math.abs(value) < 0.01) return `$${value.toFixed(6)}`;
  if (Math.abs(value) < 1) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/**
 * Sanity check used by the tests and by the smoke test.
 *
 * The same underlying price expressed in each catalogue's own unit must land on the same number
 * here. If this ever stops being true, every other figure in the project is suspect.
 */
export function conversionIsConsistent() {
  const fromOpenRouter = perTokenToPerMillion("0.00000003"); // $0.03 per 1M
  const fromHuggingFace = perMillionToPerMillion(0.03); // $0.03 per 1M
  return fromOpenRouter === fromHuggingFace;
}
