/**
 * A tiny target for the Tier-1 canary. Every function has tests that kill at
 * least one mutation, and the shapes are chosen so both failure kinds appear:
 * a mutant that throws (localizable from the traceback) and a mutant that
 * silently returns a wrong value (the traceback points at the test line).
 *
 * This file is mutated by `evals/canary.mjs`; it is never imported by the skill.
 */
export function add(a, b) {
  return a + b;
}

export function isPositive(n) {
  return n > 0;
}

export function max(a, b) {
  if (a > b) return a;
  return b;
}

export function clamp(n, lo, hi) {
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}
