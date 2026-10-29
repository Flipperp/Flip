import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import type { DB } from "../db.js";
import type { Engine } from "../engine/engine.js";

interface Row {
  id: number;
  wallet: string;
  amount: number;
  status: "pending" | "sending" | "sent" | "failed";
  sig: string | null;
  last_valid_height: number | null;
  attempts: number;
}

/**
 * Sends withdrawals from the vault. Crash-safe: the signed transaction's signature and expiry are
 * stored before broadcast, so after a restart we either find it on-chain or prove it expired
 * before retrying. A withdrawal is never sent twice.
 */
export class WithdrawalWorker {
  private running = false;
  private timer?: NodeJS.Timeout;
  public lastError: string | null = null;

  constructor(
    private conn: Connection,
    private db: DB,
    private engine: Engine,
    private vault: Keypair,
    private opts: { pollMs: number; priorityMicroLamports: number; reserve: number; maxAttempts: number },
  ) {}

  start() {
    const loop = async () => {
      try {
        await this.run();
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

  async run() {
    if (this.running) return;
    this.running = true;
    try {
      const inflight = this.db.prepare("SELECT * FROM withdrawals WHERE status = 'sending' ORDER BY id").all() as Row[];
      for (const w of inflight) await this.reconcile(w);
      if (this.engine.halted("real")) return;
      const pending = this.db.prepare("SELECT * FROM withdrawals WHERE status = 'pending' ORDER BY id LIMIT 20").all() as Row[];
      for (const w of pending) await this.send(w);
    } finally {
      this.running = false;
    }
  }

  private async send(w: Row) {
    const vaultBal = await this.conn.getBalance(this.vault.publicKey, "confirmed");
    if (vaultBal < w.amount + this.opts.reserve) {
      this.lastError = `vault low: ${vaultBal} < ${w.amount + this.opts.reserve}; withdrawal ${w.id} waiting`;
      return;
    }
    const { blockhash, lastValidBlockHeight } = await this.conn.getLatestBlockhash("confirmed");
    const tx = new Transaction({ feePayer: this.vault.publicKey, blockhash, lastValidBlockHeight });
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_000 }));
    tx.add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.opts.priorityMicroLamports }));
    tx.add(SystemProgram.transfer({ fromPubkey: this.vault.publicKey, toPubkey: new PublicKey(w.wallet), lamports: w.amount }));
    tx.sign(this.vault);
    const sig = tx.signatures[0].signature ? bs58.encode(tx.signatures[0].signature) : null;
    if (!sig) throw new Error("failed to sign");
    // Persist before broadcast.
    const r = this.db
      .prepare("UPDATE withdrawals SET status = 'sending', sig = ?, last_valid_height = ?, attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'pending'")
      .run(sig, lastValidBlockHeight, Date.now(), w.id);
    if (r.changes !== 1) return;
    try {
      await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
    } catch (e: any) {
      // Never resend here: a network error can still mean the tx was forwarded. The row stays
      // 'sending' and reconcile() retries only after the blockhash has provably expired.
      this.db.prepare("UPDATE withdrawals SET error = ?, updated_at = ? WHERE id = ?").run(String(e?.message ?? e), Date.now(), w.id);
    }
  }

  private async reconcile(w: Row) {
    if (!w.sig) {
      this.db.prepare("UPDATE withdrawals SET status = 'pending' WHERE id = ?").run(w.id);
      return;
    }
    const st = (await this.conn.getSignatureStatuses([w.sig], { searchTransactionHistory: true })).value[0];
    if (st && (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized")) {
      if (st.err) {
        this.engine.failWithdrawal(w.id, JSON.stringify(st.err));
        return;
      }
      const tx = await this.conn.getTransaction(w.sig, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const fee = tx?.meta?.fee ?? 5000;
      this.engine.settleWithdrawal(w.id, w.sig, fee);
      return;
    }
    const height = await this.conn.getBlockHeight("confirmed");
    if (w.last_valid_height !== null && height > w.last_valid_height + 10) {
      // Blockhash expired and the signature never landed: safe to retry with a new tx.
      if (w.attempts >= this.opts.maxAttempts) this.engine.failWithdrawal(w.id, "expired after max attempts");
      else this.db.prepare("UPDATE withdrawals SET status = 'pending', sig = NULL, updated_at = ? WHERE id = ?").run(Date.now(), w.id);
    }
  }
}
