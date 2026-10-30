import type { Config } from "../config.js";
import type { PriceStore } from "../oracle/priceStore.js";
import type { MarketRow } from "./engine.js";

/**
 * Decides whether the pool may take the other side of a coin right now, and how tightly.
 *
 * The pool is the counterparty, so anyone who controls a coin's price can farm it: open a short,
 * dump the bag, collect. That is cheapest on young coins and concentrated supplies, so the pool
 * stays out of them. The Arena, where players bet against each other, covers those coins instead.
 */

export interface HolderInfo {
  /** Share of total supply held by the 10 largest accounts, excluding the curve and pool vaults. */
  top10: number;
  checkedAt: number;
}

export type RiskReason = "too_new" | "concentrated" | "holders_unknown" | "liquidity_drop";

export interface Risk {
  /** Pool may open new positions on this coin. */
  poolOpen: boolean;
  reason: RiskReason | null;
  ageMs: number;
  /** When the age gate lifts (ms epoch), if it hasn't yet. */
  seasonedAt: number;
  /** Under youngHours: tighter caps, longer average, longer minimum hold. */
  young: boolean;
  top10: number | null;
  liqDrop: number;
  /** Averaging window for fills on this coin. */
  twapMs: number;
  sideCapMult: number;
  minHoldMs: number;
}

export class Guard {
  private holders = new Map<string, HolderInfo>();

  constructor(
    private cfg: Config,
    private prices: PriceStore,
    private now: () => number = Date.now,
    /** Coins exempt from the age and holder rules (Hyperliquid-linked majors). */
    private exempt: (mint: string) => boolean = () => false,
  ) {}

  setExempt(fn: (mint: string) => boolean) {
    this.exempt = fn;
  }

  setHolders(mint: string, info: HolderInfo) {
    this.holders.set(mint, info);
  }

  holderInfo(mint: string) {
    return this.holders.get(mint) ?? null;
  }

  /** Creation time, falling back to when Flip first listed the coin (can only make it look younger). */
  bornAt(m: MarketRow): number {
    return m.born_at && m.born_at > 0 ? Math.min(m.born_at, m.added_at) : m.added_at;
  }

  /** Coins young enough to need a holder check. */
  needsHolderCheck(m: MarketRow): boolean {
    if (this.exempt(m.mint)) return false;
    return this.now() - this.bornAt(m) < this.cfg.risk.holderCheckHours * 3600_000;
  }

  assess(m: MarketRow): Risk {
    const r = this.cfg.risk;
    const now = this.now();
    const born = this.bornAt(m);
    const ageMs = Math.max(0, now - born);
    const exempt = this.exempt(m.mint);
    const seasonedAt = born + r.seasonHours * 3600_000;
    const young = !exempt && ageMs < r.youngHours * 3600_000;
    const h = this.holders.get(m.mint) ?? null;
    const liqDrop = this.prices.liquidityDrop(m.mint, r.liqDropWindowMs);
    let reason: RiskReason | null = null;
    if (!exempt && now < seasonedAt) reason = "too_new";
    else if (liqDrop > r.liqDropMax) reason = "liquidity_drop";
    else if (!exempt && this.needsHolderCheck(m)) {
      // A stale reading is as good as none: supply can move fast on young coins.
      if (!h || now - h.checkedAt > 30 * 60_000) reason = "holders_unknown";
      else if (h.top10 > r.top10Max) reason = "concentrated";
    }
    return {
      poolOpen: reason === null,
      reason,
      ageMs,
      seasonedAt,
      young,
      top10: h?.top10 ?? null,
      liqDrop,
      twapMs: young ? r.youngTwapMs : this.cfg.trading.twapWindowMs,
      sideCapMult: young ? r.youngSideCapMult : 1,
      minHoldMs: young ? Math.max(r.youngMinHoldMs, this.cfg.trading.minHoldMs) : this.cfg.trading.minHoldMs,
    };
  }
}

/** Share of supply in the largest accounts, skipping the curve/pool vaults. Pure, for tests. */
export function top10Share(accounts: { address: string; uiAmount: number }[], exclude: Set<string>, supply: number): number {
  if (!(supply > 0)) return 1;
  const held = accounts
    .filter((a) => !exclude.has(a.address))
    .sort((a, b) => b.uiAmount - a.uiAmount)
    .slice(0, 10)
    .reduce((s, a) => s + (a.uiAmount > 0 ? a.uiAmount : 0), 0);
  return Math.min(1, held / supply);
}
