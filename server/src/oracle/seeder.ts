import type { ChainOracle } from "./chainOracle.js";

/**
 * Keeps the Markets list populated with what's moving on Solana: DexScreener's boosted and newly
 * profiled tokens, plus any mints listed in SEED_MINTS. Users can still paste any CA.
 */
export class MarketSeeder {
  private timer?: NodeJS.Timeout;
  public lastError: string | null = null;
  private tried = new Map<string, number>();

  constructor(private oracle: ChainOracle, private opts: { everyMs: number; seedMints: string[]; maxPerRun: number }) {}

  start() {
    const loop = async () => {
      try {
        await this.run();
        this.lastError = null;
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
      }
      this.timer = setTimeout(loop, this.opts.everyMs);
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  async run() {
    const mints = new Set(this.opts.seedMints);
    for (const url of ["https://api.dexscreener.com/token-boosts/top/v1", "https://api.dexscreener.com/token-boosts/latest/v1", "https://api.dexscreener.com/token-profiles/latest/v1"]) {
      try {
        const r = await fetch(url);
        if (!r.ok) continue;
        const arr = await r.json();
        for (const t of Array.isArray(arr) ? arr : []) if (t.chainId === "solana" && t.tokenAddress) mints.add(t.tokenAddress);
      } catch {
        /* next source */
      }
    }
    let n = 0;
    const now = Date.now();
    for (const m of mints) {
      if (n >= this.opts.maxPerRun) break;
      const last = this.tried.get(m);
      if (last && now - last < 6 * 3600_000) continue;
      this.tried.set(m, now);
      n++;
      await this.oracle.resolve(m).catch(() => {});
    }
  }
}
