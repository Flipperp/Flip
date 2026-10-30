import type { PriceStore } from "../oracle/priceStore.js";

/**
 * Hyperliquid route.
 *
 * Coins that also trade as a Hyperliquid perp can be routed to Hyperliquid's order book instead of
 * the Flip pool. The trade is non-custodial: it is signed in the browser by a key the user approved
 * on their own Hyperliquid account, and Flip earns a builder fee on it. Nothing here moves funds.
 *
 * The server's job is deciding which Flip markets are the same asset as which Hyperliquid perp.
 * A ticker match is not proof (copycats share tickers), so every link comes from an explicit map
 * and is only switched on while the Solana pool price and the Hyperliquid mark agree.
 */

export interface HlPerp {
  /** Asset id used in orders (index in the main-dex universe). */
  asset: number;
  name: string;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  delisted: boolean;
  markPx: number;
  midPx: number | null;
  oraclePx: number;
  funding: number;
  openInterest: number;
  dayNtlVlm: number;
  prevDayPx: number;
}

export interface MapEntry {
  mint: string;
  coin: string;
  /** Tokens per Hyperliquid contract unit. kBONK quotes 1,000 BONK, so mult = 1000. */
  mult: number;
}

export type LinkState = "verified" | "checking" | "price_mismatch" | "no_flip_price" | "not_listed" | "delisted";

export interface HlLinkView {
  coin: string;
  asset: number;
  mult: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  state: LinkState;
  /** True only when orders may be routed. */
  routable: boolean;
  markPx: number | null;
  midPx: number | null;
  funding: number | null;
  openInterest: number | null;
  dayNtlVlm: number | null;
  prevDayPx: number | null;
  /** Hyperliquid mark per token, in SOL (uses Hyperliquid's own SOL mark). */
  markSol: number | null;
  /** flipPrice / hlPrice - 1, last check. */
  divergence: number | null;
  checkedAt: number | null;
}

/**
 * Solana mints that have a Hyperliquid perp. Each one is checked against the live price before it is
 * used, so an entry that is wrong (or a perp that is gone) simply stays off.
 */
export const DEFAULT_MAP: MapEntry[] = [
  { mint: "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263", coin: "kBONK", mult: 1000 },
  { mint: "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm", coin: "WIF", mult: 1 },
  { mint: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN", coin: "JUP", mult: 1 },
  { mint: "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3", coin: "PYTH", mult: 1 },
  { mint: "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL", coin: "JTO", mult: 1 },
  { mint: "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ", coin: "W", mult: 1 },
  { mint: "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr", coin: "POPCAT", mult: 1 },
  { mint: "2zMMhcVQEXDtdE6vsFS7S7D5oUodfJHE8vd1gnBouauv", coin: "PENGU", mult: 1 },
  { mint: "9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump", coin: "FARTCOIN", mult: 1 },
  { mint: "6p6xgHyF7AeE6TZkSmFsko444wqoP15icUSqi2jfGiPN", coin: "TRUMP", mult: 1 },
  { mint: "2qEHjDLDLbuBgRYvsxhc5D6uDWAivNFZGan56P1tpump", coin: "PNUT", mult: 1 },
  { mint: "CzLSujWBLFsSjncfkh59rUFqvafWcY5tzedWJSuypump", coin: "GOAT", mult: 1 },
  { mint: "ED5nyyWEzpPPiWimP8vYm7sD7TD3LAt3Q3gRTWHzPJBY", coin: "MOODENG", mult: 1 },
  { mint: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC", coin: "AI16Z", mult: 1 },
  { mint: "Df6yfrKC8kZE3KNkrHERKzAetSxbrWeniQfyJY4Jpump", coin: "CHILLGUY", mult: 1 },
  { mint: "MEW1gQWJ3nEXg2qgERiKu7FAFj79PHvQVREQUzScPP5", coin: "MEW", mult: 1 },
];

/** "mint:COIN:mult,mint:COIN" — entries override the defaults for the same mint. */
export function parseMap(spec: string, base: MapEntry[] = DEFAULT_MAP): MapEntry[] {
  const out = new Map(base.map((e) => [e.mint, e]));
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [mint, coin, mult] = part.split(":");
    if (!mint || !coin) continue;
    if (coin === "-") {
      out.delete(mint);
      continue;
    }
    const m = mult ? Number(mult) : /^k[A-Z0-9]/.test(coin) ? 1000 : 1;
    if (!(m > 0)) continue;
    out.set(mint, { mint, coin, mult: m });
  }
  return [...out.values()];
}

/** Parse a metaAndAssetCtxs response into perps keyed by name. */
export function parsePerps(raw: unknown): Map<string, HlPerp> {
  const out = new Map<string, HlPerp>();
  if (!Array.isArray(raw) || raw.length < 2) throw new Error("unexpected metaAndAssetCtxs shape");
  const [meta, ctxs] = raw as [{ universe: any[] }, any[]];
  if (!Array.isArray(meta?.universe) || !Array.isArray(ctxs)) throw new Error("unexpected metaAndAssetCtxs shape");
  meta.universe.forEach((u, i) => {
    const c = ctxs[i] ?? {};
    const num = (x: unknown) => (x === null || x === undefined || x === "" ? NaN : Number(x));
    out.set(String(u.name), {
      asset: i,
      name: String(u.name),
      szDecimals: Number(u.szDecimals),
      maxLeverage: Number(u.maxLeverage),
      onlyIsolated: !!u.onlyIsolated || u.marginMode === "strictIsolated" || u.marginMode === "noCross",
      delisted: !!u.isDelisted,
      markPx: num(c.markPx),
      midPx: Number.isFinite(num(c.midPx)) ? num(c.midPx) : null,
      oraclePx: num(c.oraclePx),
      funding: num(c.funding),
      openInterest: num(c.openInterest),
      dayNtlVlm: num(c.dayNtlVlm),
      prevDayPx: num(c.prevDayPx),
    });
  });
  return out;
}

export interface LinkOptions {
  apiUrl: string;
  pollMs: number;
  /** Max |flip/hl - 1| for a link to be routable. */
  maxDivergence: number;
  /** Consecutive agreeing checks before a link turns on; consecutive bad checks before it turns off. */
  confirmChecks: number;
  map: MapEntry[];
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface LinkMemo {
  good: number;
  bad: number;
  on: boolean;
  divergence: number | null;
  checkedAt: number | null;
  state: LinkState;
}

export class HlLink {
  public lastError: string | null = null;
  public lastPoll: number | null = null;
  private perps = new Map<string, HlPerp>();
  private memo = new Map<string, LinkMemo>();
  private byMint: Map<string, MapEntry>;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private prices: PriceStore,
    private isListed: (mint: string) => boolean,
    private opts: LinkOptions,
  ) {
    this.byMint = new Map(opts.map.map((e) => [e.mint, e]));
  }

  get mints() {
    return [...this.byMint.keys()];
  }

  private get now() {
    return this.opts.now ?? Date.now;
  }

  start() {
    this.stopped = false;
    const loop = async () => {
      await this.poll();
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.pollMs);
    };
    loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async poll() {
    try {
      const f = this.opts.fetchImpl ?? fetch;
      const r = await f(`${this.opts.apiUrl.replace(/\/$/, "")}/info`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "metaAndAssetCtxs" }),
        signal: AbortSignal.timeout(8000),
      });
      if (!r.ok) throw new Error(`Hyperliquid info ${r.status}`);
      this.ingest(await r.json());
      this.lastError = null;
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      // Stale data must not keep links on: after a missed poll window, everything turns off.
      if (this.lastPoll && this.now() - this.lastPoll > this.opts.pollMs * 4) {
        for (const m of this.memo.values()) {
          m.on = false;
          m.good = 0;
          m.state = "checking";
        }
      }
    }
  }

  /** Apply a metaAndAssetCtxs response and re-check every link. */
  ingest(raw: unknown) {
    this.perps = parsePerps(raw);
    this.lastPoll = this.now();
    for (const e of this.byMint.values()) this.check(e);
  }

  /** Hyperliquid's SOL mark, used to put perp prices in SOL so no third-party SOL/USD feed is needed. */
  solMark(): number | null {
    const s = this.perps.get("SOL");
    return s && s.markPx > 0 ? s.markPx : null;
  }

  private check(e: MapEntry) {
    const memo = this.memo.get(e.mint) ?? { good: 0, bad: 0, on: false, divergence: null, checkedAt: null, state: "checking" as LinkState };
    this.memo.set(e.mint, memo);
    const p = this.perps.get(e.coin);
    const fail = (state: LinkState, hard = false) => {
      memo.good = 0;
      memo.bad++;
      if (hard || memo.bad >= this.opts.confirmChecks) memo.on = false;
      memo.state = memo.on ? "verified" : state;
    };
    memo.checkedAt = this.now();
    if (!p) return fail("not_listed", true);
    if (p.delisted) return fail("delisted", true);
    const v = this.prices.view(e.mint);
    const sol = this.solMark();
    // The Solana price is slow-polled for coins nobody is watching, so allow it to be a minute old.
    if (!v || !(v.live > 0) || this.now() - v.updatedAt > 90_000 || !sol || !(p.markPx > 0)) {
      memo.divergence = null;
      return fail("no_flip_price");
    }
    const hlSol = p.markPx / e.mult / sol;
    const div = v.live / hlSol - 1;
    memo.divergence = div;
    if (Math.abs(div) > this.opts.maxDivergence) return fail("price_mismatch");
    memo.bad = 0;
    memo.good++;
    if (memo.good >= this.opts.confirmChecks) memo.on = true;
    memo.state = memo.on ? "verified" : "checking";
  }

  view(mint: string): HlLinkView | null {
    const e = this.byMint.get(mint);
    if (!e) return null;
    const p = this.perps.get(e.coin);
    const memo = this.memo.get(mint);
    const sol = this.solMark();
    const listed = this.isListed(mint);
    const state: LinkState = !p ? "not_listed" : (memo?.state ?? "checking");
    return {
      coin: e.coin,
      asset: p?.asset ?? -1,
      mult: e.mult,
      szDecimals: p?.szDecimals ?? 0,
      maxLeverage: p?.maxLeverage ?? 0,
      onlyIsolated: p?.onlyIsolated ?? false,
      state,
      routable: !!p && !p.delisted && !!memo?.on && listed,
      markPx: p && Number.isFinite(p.markPx) ? p.markPx : null,
      midPx: p?.midPx ?? null,
      funding: p && Number.isFinite(p.funding) ? p.funding : null,
      openInterest: p && Number.isFinite(p.openInterest) ? p.openInterest : null,
      dayNtlVlm: p && Number.isFinite(p.dayNtlVlm) ? p.dayNtlVlm : null,
      prevDayPx: p && Number.isFinite(p.prevDayPx) ? p.prevDayPx : null,
      markSol: p && sol ? p.markPx / e.mult / sol : null,
      divergence: memo?.divergence ?? null,
      checkedAt: memo?.checkedAt ?? null,
    };
  }

  all() {
    return [...this.byMint.keys()].map((mint) => ({ mint, ...this.view(mint)! }));
  }
}
