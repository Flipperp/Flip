import { Connection, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { DB } from "../db.js";
import type { MarketRow } from "../engine/engine.js";
import { Guard, top10Share } from "../engine/guard.js";

/**
 * Reads the largest holders of young coins on-chain (one RPC call per coin) and feeds the share
 * held by the top 10 into the guard. Bundled launches show up as a few wallets holding a big
 * slice of supply. Spreading a bag across many wallets gets around it; the age gate and size caps
 * are the backstop for that.
 */
export class HolderCheck {
  public lastError: string | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;

  constructor(
    private conn: Connection,
    private db: DB,
    private guard: Guard,
    private opts: { everyMs: number; gapMs: number; maxPerRun: number },
  ) {}

  start() {
    const loop = async () => {
      try {
        await this.run();
        this.lastError = null;
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.opts.everyMs);
    };
    loop();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async run() {
    const rows = (this.db.prepare("SELECT * FROM markets WHERE listed = 1").all() as MarketRow[])
      .filter((m) => this.guard.needsHolderCheck(m))
      // Oldest reading first, so every young coin gets refreshed in turn.
      .sort((a, b) => (this.guard.holderInfo(a.mint)?.checkedAt ?? 0) - (this.guard.holderInfo(b.mint)?.checkedAt ?? 0))
      .slice(0, this.opts.maxPerRun);
    for (const m of rows) {
      await this.check(m).catch(() => {});
      await new Promise((r) => setTimeout(r, this.opts.gapMs));
    }
  }

  async check(m: MarketRow) {
    const mint = new PublicKey(m.mint);
    const res = await this.conn.getTokenLargestAccounts(mint, "confirmed");
    const exclude = new Set<string>();
    const src = JSON.parse(m.source) as Record<string, unknown>;
    for (const k of ["baseVault", "quoteVault", "vault0", "vault1", "pool"]) if (typeof src[k] === "string") exclude.add(src[k] as string);
    if (typeof src.curve === "string") {
      const curve = new PublicKey(src.curve);
      for (const prog of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) exclude.add(getAssociatedTokenAddressSync(mint, curve, true, prog).toBase58());
    }
    const accounts = res.value.map((a) => ({ address: a.address.toBase58(), uiAmount: Number(a.uiAmount ?? 0) }));
    this.guard.setHolders(m.mint, { top10: top10Share(accounts, exclude, m.supply), checkedAt: Date.now() });
  }
}
