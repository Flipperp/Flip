import { Connection, PublicKey, SystemProgram, type ParsedTransactionWithMeta } from "@solana/web3.js";
import type { DB } from "../db.js";
import { kvGet, kvSet } from "../db.js";
import type { Engine } from "../engine/engine.js";

/**
 * Credits SOL sent to the vault. The sender of a system transfer is credited, so users deposit by
 * sending SOL from the wallet they trade with. Transfers from the project's creator wallet are
 * creator-fee sweeps and go through the fee split instead.
 */
export class DepositWatcher {
  private running = false;
  private timer?: NodeJS.Timeout;
  public lastError: string | null = null;

  constructor(
    private conn: Connection,
    private db: DB,
    private engine: Engine,
    private vault: PublicKey,
    private opts: { pollMs: number; minDeposit: number; creatorWallet: string | null; commitment: "confirmed" | "finalized" },
  ) {}

  start() {
    const loop = async () => {
      try {
        await this.scan();
        this.lastError = null;
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
      }
      this.timer = setTimeout(loop, this.opts.pollMs);
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  async scan() {
    if (this.running) return;
    this.running = true;
    try {
      const cursor = kvGet(this.db, "deposit_cursor");
      // Walk back from newest until we reach the cursor, then process oldest-first.
      const sigs: { signature: string; slot: number; err: unknown }[] = [];
      let before: string | undefined;
      for (let page = 0; page < 20; page++) {
        const batch = await this.conn.getSignaturesForAddress(this.vault, { before, until: cursor, limit: 1000 }, this.opts.commitment);
        sigs.push(...batch);
        if (batch.length < 1000) break;
        before = batch[batch.length - 1].signature;
      }
      if (sigs.length === 0) return;
      sigs.reverse();
      for (let i = 0; i < sigs.length; i += 50) {
        const chunk = sigs.slice(i, i + 50);
        const txs = await this.conn.getParsedTransactions(
          chunk.map((s) => s.signature),
          { maxSupportedTransactionVersion: 0, commitment: this.opts.commitment },
        );
        for (let j = 0; j < chunk.length; j++) {
          const tx = txs[j];
          if (!tx) throw new Error(`transaction ${chunk[j].signature} not yet available`);
          if (!chunk[j].err && !tx.meta?.err) this.process(chunk[j].signature, chunk[j].slot, tx);
          kvSet(this.db, "deposit_cursor", chunk[j].signature);
        }
      }
    } finally {
      this.running = false;
    }
  }

  /** Extract system transfers into the vault (top-level and inner instructions). */
  process(sig: string, slot: number, tx: ParsedTransactionWithMeta) {
    const vault = this.vault.toBase58();
    const ixs: any[] = [...tx.transaction.message.instructions];
    for (const inner of tx.meta?.innerInstructions ?? []) ixs.push(...inner.instructions);
    ixs.forEach((ix, n) => {
      if (ix.programId?.toBase58?.() !== SystemProgram.programId.toBase58()) return;
      const p = ix.parsed;
      if (!p || (p.type !== "transfer" && p.type !== "transferWithSeed")) return;
      const info = p.info;
      if (info.destination !== vault) return;
      const from: string = info.source ?? info.from;
      const amount = Number(info.lamports);
      if (!from || from === vault || !Number.isSafeInteger(amount)) return;
      const already = this.db.prepare("SELECT 1 FROM deposits WHERE sig = ? AND ix = ?").get(sig, n);
      if (already) return;
      let kind: "user" | "creator_fee" | "ignored" = "user";
      if (this.opts.creatorWallet && from === this.opts.creatorWallet) kind = "creator_fee";
      else if (amount < this.opts.minDeposit) kind = "ignored";
      this.engine.tx(() => {
        this.db
          .prepare("INSERT INTO deposits (sig, ix, wallet, amount, slot, kind, ts) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(sig, n, from, amount, slot, kind, Date.now());
        if (kind === "user") this.engine.creditDeposit(from, "real", amount, sig);
        else if (kind === "creator_fee") this.engine.creditCreatorFee(amount, sig);
      });
    });
  }
}
