export interface Quote {
  /** Price in SOL per whole token. */
  price: number;
  /** SOL-side liquidity in lamports. */
  liquidity: number;
  /** Market cap in SOL. */
  mcapSol: number;
  ts: number;
}

export interface PriceView {
  live: number;
  twap: number;
  liquidity: number;
  mcapSol: number;
  updatedAt: number;
  /** Enough history for a valid 30s average and not stale. */
  ready: boolean;
  change1h: number | null;
}

export interface Candle {
  /** Bucket start, unix seconds. */
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

/** Candle timeframes in seconds and how many buckets to keep. */
export const TIMEFRAMES: Record<string, { sec: number; keep: number }> = {
  "5s": { sec: 5, keep: 720 },
  "1m": { sec: 60, keep: 1440 },
  "5m": { sec: 300, keep: 864 },
  "15m": { sec: 900, keep: 672 },
};

interface Series {
  samples: { ts: number; price: number }[];
  last?: Quote;
  hourly: { ts: number; price: number }[];
  candles: Record<string, Candle[]>;
}

export class PriceStore {
  private series = new Map<string, Series>();
  constructor(
    private windowMs: number,
    private minSamples: number,
    private staleMs: number,
    private now: () => number = Date.now,
  ) {}

  push(mint: string, q: Quote) {
    if (!(q.price > 0) || !Number.isFinite(q.price)) return;
    let s = this.series.get(mint);
    if (!s) {
      s = { samples: [], hourly: [], candles: Object.fromEntries(Object.keys(TIMEFRAMES).map((k) => [k, []])) };
      this.series.set(mint, s);
    }
    s.samples.push({ ts: q.ts, price: q.price });
    s.last = q;
    const cutoff = q.ts - this.windowMs * 2;
    while (s.samples.length && s.samples[0].ts < cutoff) s.samples.shift();
    // Minute-resolution history for charts and 1h change.
    const lastH = s.hourly[s.hourly.length - 1];
    if (!lastH || q.ts - lastH.ts >= 60_000) s.hourly.push({ ts: q.ts, price: q.price });
    const hcut = q.ts - 6 * 3600_000;
    while (s.hourly.length && s.hourly[0].ts < hcut) s.hourly.shift();
    for (const [tf, { sec, keep }] of Object.entries(TIMEFRAMES)) {
      const arr = s.candles[tf];
      const t = Math.floor(q.ts / 1000 / sec) * sec;
      const last = arr[arr.length - 1];
      if (last && last.t === t) {
        last.h = Math.max(last.h, q.price);
        last.l = Math.min(last.l, q.price);
        last.c = q.price;
      } else if (!last || t > last.t) {
        // Open at the previous close so candles connect without gaps.
        const o = last ? last.c : q.price;
        arr.push({ t, o, h: Math.max(o, q.price), l: Math.min(o, q.price), c: q.price });
        if (arr.length > keep) arr.splice(0, arr.length - keep);
      }
    }
  }

  candles(mint: string, tf: string): Candle[] {
    return this.series.get(mint)?.candles[tf in TIMEFRAMES ? tf : "1m"] ?? [];
  }

  /** Time-weighted average over the window ending now. */
  twap(mint: string): number | null {
    const s = this.series.get(mint);
    if (!s || s.samples.length === 0) return null;
    const end = this.now();
    const start = end - this.windowMs;
    const pts = s.samples;
    let acc = 0;
    let dur = 0;
    for (let i = 0; i < pts.length; i++) {
      const t0 = Math.max(pts[i].ts, start);
      const t1 = i + 1 < pts.length ? pts[i + 1].ts : end;
      if (t1 <= start || t1 <= t0) continue;
      acc += pts[i].price * (t1 - t0);
      dur += t1 - t0;
    }
    if (dur === 0) return pts[pts.length - 1].price;
    return acc / dur;
  }

  view(mint: string): PriceView | null {
    const s = this.series.get(mint);
    if (!s?.last) return null;
    const now = this.now();
    const twap = this.twap(mint) ?? s.last.price;
    const inWindow = s.samples.filter((p) => p.ts >= now - this.windowMs);
    const span = inWindow.length ? inWindow[inWindow.length - 1].ts - inWindow[0].ts : 0;
    const fresh = now - s.last.ts <= this.staleMs;
    const ready = fresh && inWindow.length >= this.minSamples && span >= this.windowMs * 0.8;
    const hourAgo = s.hourly.find((h) => h.ts >= now - 3600_000);
    const change1h = hourAgo && hourAgo.ts <= now - 50 * 60_000 ? s.last.price / hourAgo.price - 1 : null;
    return {
      live: s.last.price,
      twap,
      liquidity: s.last.liquidity,
      mcapSol: s.last.mcapSol,
      updatedAt: s.last.ts,
      ready,
      change1h,
    };
  }

  history(mint: string) {
    return this.series.get(mint)?.hourly ?? [];
  }

  recent(mint: string) {
    return this.series.get(mint)?.samples ?? [];
  }

  mints() {
    return [...this.series.keys()];
  }
}
