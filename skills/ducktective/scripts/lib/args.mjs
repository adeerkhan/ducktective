/**
 * Flag validation, once.
 *
 * Three tools each hand-rolled the same "is this a number in range" check, which
 * is how a value like `9m` once landed in a ledger as a string and quietly
 * dropped out of a mean. The message is part of the contract: agents read stderr
 * and retry, so the accepted range belongs in the text — `hint` overrides the
 * derived wording where a tool's phrasing is already asserted in tests.
 *
 * `max` rejects; `max` + `clamp` grants the ceiling and hands it back, leaving
 * the caller to report it. The difference matters: a rejected `--max-candidates 9`
 * makes an agent retry with a smaller number it invented, which is the same list
 * with less provenance, where the cap was policy all along.
 */

/** @returns {number} the parsed value, or throws with a retryable message. */
export function numFlag(
  flag,
  value,
  { min = 1, max = null, integer = true, hint, clamp = false } = {},
) {
  const n = Number(value);
  const isWhole = !integer || Number.isInteger(n);
  const withinMax = max === null || n <= max;
  if (!Number.isFinite(n) || n < min || !isWhole || (!withinMax && !clamp)) {
    throw new Error(`${flag} wants ${hint ?? derived(min, max, integer)}, got "${value}"`);
  }
  return clamp && max !== null ? Math.min(n, max) : n;
}

const derived = (min, max, integer) => {
  const kind = integer ? "whole number" : "number";
  if (max === null && min === 1) return `a positive ${kind}`;
  return max === null ? `a ${kind} >= ${min}` : `a ${kind} ${min}-${max}`;
};
