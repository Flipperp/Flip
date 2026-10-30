import type { DB } from "../db.js";

/**
 * Takes inactive markets off the polling list so auto-listed coins can't grow RPC load without
 * bound. A market is pruned when nobody has viewed it, it has no open position in either mode,
 * and it isn't protected (the project token, seed list, Hyperliquid-linked coins). Pruned
 * markets get listed = 2 and come back the moment someone opens or pastes them.
 */
export function pruneMarkets(db: DB, opts: { olderThanMs: number; protect: Set<string>; now?: number }): number {
  const now = opts.now ?? Date.now();
  const cutoff = now - opts.olderThanMs;
  const rows = db
    .prepare(
      `SELECT m.mint FROM markets m
       WHERE m.listed = 1 AND m.added_at < ? AND m.last_viewed < ?
       AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.mint = m.mint AND p.status = 'open')`,
    )
    .all(cutoff, cutoff) as { mint: string }[];
  const stmt = db.prepare("UPDATE markets SET listed = 2 WHERE mint = ? AND listed = 1");
  let n = 0;
  for (const r of rows) {
    if (opts.protect.has(r.mint)) continue;
    n += stmt.run(r.mint).changes;
  }
  return n;
}
