/** Pure trading math. No I/O. All money values are integer lamports. */

export type Side = "long" | "short";

export interface PosLike {
  side: Side;
  leverage: number;
  stake: number;
  entry_price: number;
}

/** Fill price for opening or closing, using the worse (for the trader) of live and TWAP plus spread. */
export function fillPrice(action: "open" | "close", side: Side, live: number, twap: number, spreadBps: number): number {
  const s = spreadBps / 10_000;
  const hi = Math.max(live, twap);
  const lo = Math.min(live, twap);
  const buying = (action === "open" && side === "long") || (action === "close" && side === "short");
  return buying ? hi * (1 + s) : lo * (1 - s);
}

/** Return on stake, clamped to [-1, maxWin]. */
export function returnRatio(side: Side, leverage: number, entry: number, exit: number, maxWin: number): number {
  const move = exit / entry - 1;
  const r = side === "long" ? leverage * move : -leverage * move;
  return Math.max(-1, Math.min(maxWin, r));
}

/** P&L in lamports, rounded in the pool's favor. */
export function pnlLamports(stake: number, r: number, maxWin: number): number {
  const raw = Math.floor(stake * r);
  return Math.max(-stake, Math.min(Math.floor(stake * maxWin), raw));
}

export function positionPnl(p: PosLike, exit: number, maxWin: number): number {
  return pnlLamports(p.stake, returnRatio(p.side, p.leverage, p.entry_price, exit, maxWin), maxWin);
}

/**
 * Worst-case amount the pool would pay out on one coin across every possible future price.
 * Pool payout P(x) is piecewise linear in the exit price x with kinks only at each position's
 * cap and floor prices, so the maximum is attained at a kink or at an end of the domain.
 * Losing stakes are netted against winners because those stakes flow to the pool.
 */
export function worstCasePayout(positions: PosLike[], maxWin: number): number {
  if (positions.length === 0) return 0;
  const xs = new Set<number>([0]);
  let maxX = 0;
  for (const p of positions) {
    const e = p.entry_price;
    const L = p.leverage;
    const pts =
      p.side === "long" ? [e * (1 - 1 / L), e * (1 + maxWin / L)] : [e * (1 + 1 / L), e * (1 - maxWin / L)];
    for (const x of pts) {
      const v = Math.max(0, x);
      xs.add(v);
      maxX = Math.max(maxX, v);
    }
  }
  xs.add(maxX * 2 + 1e-18);
  let worst = 0;
  for (const x of xs) {
    let total = 0;
    for (const p of positions) {
      // At x = 0 a long is fully lost and a short fully won; compute via ratio safely.
      const r =
        x === 0
          ? p.side === "long"
            ? -1
            : Math.min(maxWin, p.leverage)
          : returnRatio(p.side, p.leverage, p.entry_price, x, maxWin);
      // Use the trader-favorable (ceil) rounding here so the reserve is never understated.
      total += Math.max(-p.stake, Math.min(p.stake * maxWin, Math.ceil(p.stake * r)));
    }
    if (total > worst) worst = total;
  }
  return worst;
}

/** Profit fee after holder discount, in lamports. */
export function profitFee(pnl: number, feeBps: number, discountBps: number): number {
  if (pnl <= 0) return 0;
  const eff = Math.max(0, Math.round((feeBps * (10_000 - discountBps)) / 10_000));
  return Math.ceil((pnl * eff) / 10_000);
}

/** Split an amount by bps into named parts; rounding remainder goes to the first key. */
export function split<K extends string>(amount: number, bps: Record<K, number>): Record<K, number> {
  const keys = Object.keys(bps) as K[];
  const out = {} as Record<K, number>;
  let used = 0;
  for (const k of keys.slice(1)) {
    out[k] = Math.floor((amount * bps[k]) / 10_000);
    used += out[k];
  }
  out[keys[0]] = amount - used;
  return out;
}
