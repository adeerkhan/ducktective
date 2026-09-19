/**
 * Benchmark metrics — C1..C12, computed from result rows.
 *
 * C1–C7 are design v2's metrics. **C8 and C9 are design v3's**: C8 is the
 * blind-checker overturn rate (how much the stripped-context re-derivation buys
 * over the same-process probe) and C9 is the E5 why/evidence consistency
 * violation rate. C10–C12 are this plan's ladder metrics.
 *
 * This file is arithmetic, deliberately. The row shape is documented here and
 * checked by `smoke.test.mjs`; the arm runner that *produces* rows is Phase 1 and
 * is not built. Until it is, do not describe these numbers as measured: they are
 * the capture path, and a capture path that has never seen a real row is not
 * evidence (docs/architecture.md §11).
 *
 * Row fields (one row = one instance × one arm):
 *   instance, arm            identity
 *   confirmed                emitted a reportable cause
 *   cause_hit                that cause intersects a gold bug-fix hunk
 *   abstained                stopped / labelled instead of asserting
 *   tokens, wall_ms          cost
 *   bisect_commit            bisect returned a first-bad commit
 *   bisect_gold              one of that commit's hunks is a gold hunk
 *   probe_demoted            an otherwise-confirmed verdict the probe killed
 *   blind_checked            reached the blind re-derivation (design v3 E2)
 *   blind_overturned         the blind checker downgraded a would-be confirmed
 *   why_violation            E5 flagged a why/hypothesis citing absent evidence
 *   replicated               a confirmed claim survived independent replication
 *   closure_closed           the repair/revert probe closed (L4)
 *   closure_wrong            it closed on a cause that misses every gold hunk
 *   cause_hash               cause identity, for recurrence
 */

/** num/den as a percentage, or null when the denominator is empty ("no data"). */
export function rate(num, den) {
  return { num, den, pct: den > 0 ? Math.round((num / den) * 100) : null };
}

const count = (rows, pred) => rows.filter(pred).length;

export function computeMetrics(rows) {
  const n = rows.length;
  const confirmed = rows.filter((r) => r.confirmed);
  const bisected = rows.filter((r) => r.bisect_commit);
  const demoted = count(rows, (r) => r.probe_demoted);
  const blindChecked = count(rows, (r) => r.blind_checked);
  const closed = count(rows, (r) => r.closure_closed);
  const hashes = new Set(rows.map((r) => r.cause_hash).filter(Boolean));
  const tokenTotal = rows.reduce((a, r) => a + (Number(r.tokens) || 0), 0);
  const wallTotal = rows.reduce((a, r) => a + (Number(r.wall_ms) || 0), 0);
  return {
    rows: n,
    C1_cause_hit: rate(
      count(rows, (r) => r.confirmed && r.cause_hit),
      n,
    ),
    C2_false_confirm: rate(
      count(rows, (r) => r.confirmed && !r.cause_hit),
      n,
    ),
    C3_abstention: rate(
      count(rows, (r) => r.abstained),
      n,
    ),
    C4_tokens: { total: tokenTotal, mean: n ? Math.round(tokenTotal / n) : null },
    C5_wall_ms: { total: wallTotal, mean: n ? Math.round(wallTotal / n) : null },
    C6_bisect_yield: rate(bisected.length, n),
    C6_bisect_gold: rate(
      count(bisected, (r) => r.bisect_gold),
      bisected.length,
    ),
    C7_probe_kill: rate(demoted, demoted + confirmed.length),
    C8_blind_overturn: rate(
      count(rows, (r) => r.blind_overturned),
      blindChecked,
    ),
    C9_why_consistency: rate(
      count(rows, (r) => r.why_violation),
      n,
    ),
    C10_replication_survival: rate(
      count(confirmed, (r) => r.replicated),
      confirmed.length,
    ),
    C11_closure_yield: rate(closed, confirmed.length),
    C11_closure_false_positive: rate(
      count(rows, (r) => r.closure_closed && r.closure_wrong),
      closed,
    ),
    C12_distinct_causes: { value: hashes.size, rows: n },
  };
}
