import { Connection, PublicKey } from "@solana/web3.js";
import type { Engine } from "../engine/engine.js";

/**
 * Continuous solvency audit. Halts real trading and withdrawals if:
 *  - the internal book doesn't conserve (any lamport out of place), or
 *  - the vault holds less on-chain than the book says it owes.
 * A surplus (e.g. dust deposits we don't credit) is reported but doesn't halt.
 */
export class Auditor {
  private timer?: NodeJS.Timeout;
  public last: { at: number; ok: boolean; vault: number; owed: number; diff: number; problems: string[] } | null = null;

  constructor(
    private conn: Connection | null,
    private engine: Engine,
    private vault: PublicKey | null,
    private opts: { everyMs: number; tolerance: number; reserve: number },
  ) {}

  start() {
    const loop = async () => {
      try {
        await this.run();
      } catch (e: any) {
        this.last = { at: Date.now(), ok: false, vault: 0, owed: 0, diff: 0, problems: [`audit error: ${e?.message ?? e}`] };
      }
      this.timer = setTimeout(loop, this.opts.everyMs);
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  async run() {
    for (const mode of ["paper", "real"] as const) {
      const c = this.engine.conservation(mode);
      if (!c.ok) {
        this.engine.halt(mode, "book check failed");
        this.last = { at: Date.now(), ok: false, vault: 0, owed: c.net, diff: 0, problems: c.problems.map((p) => `${mode}: ${p}`) };
        return;
      }
    }
    if (!this.conn || !this.vault) {
      this.last = { at: Date.now(), ok: true, vault: 0, owed: 0, diff: 0, problems: [] };
      return;
    }
    // Take the book total and the chain balance as close together as possible.
    const owedBefore = this.engine.conservation("real").net;
    const vaultBal = await this.conn.getBalance(this.vault, "confirmed");
    const owedAfter = this.engine.conservation("real").net;
    const owed = Math.max(owedBefore, owedAfter);
    // Withdrawals that are broadcast but not yet reconciled may already have left the vault.
    const inflight = this.engine.db.prepare("SELECT COALESCE(SUM(amount),0) AS s, COUNT(*) AS n FROM withdrawals WHERE status = 'sending'").get() as { s: number; n: number };
    const floor = owed - inflight.s - inflight.n * 20_000;
    // Pending deposits (on-chain, not yet credited) only add surplus, so this is conservative.
    const diff = vaultBal - this.opts.reserve - floor;
    const problems: string[] = [];
    if (diff < -this.opts.tolerance) {
      problems.push(`vault short by ${-diff} lamports`);
      this.engine.halt("real", "vault balance below book");
    } else if (diff > 5 * this.opts.tolerance) {
      problems.push(`unattributed surplus ${diff} lamports`);
    }
    this.last = { at: Date.now(), ok: diff >= -this.opts.tolerance, vault: vaultBal, owed, diff, problems };
  }
}
