import { ComputeBudgetProgram, Connection, Keypair, PublicKey, SystemProgram, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import { pump } from "../pumpSdk.js";
type OnlinePumpSdk = InstanceType<typeof pump.OnlinePumpSdk>;

/**
 * Claims the project token's pump.fun creator fees (bonding curve + PumpSwap) into the creator
 * wallet, then sweeps everything above a small float into the vault. The deposit watcher
 * recognises transfers from the creator wallet and splits them pool / holders / treasury.
 */
export class CreatorFeeSweeper {
  private timer?: NodeJS.Timeout;
  private sdk: OnlinePumpSdk;
  public lastError: string | null = null;
  public lastSweep: { at: number; amount: number; sig: string } | null = null;

  constructor(
    private conn: Connection,
    private creator: Keypair,
    private vault: PublicKey,
    private opts: { everyMs: number; minClaimLamports: number; keepLamports: number },
  ) {
    this.sdk = new pump.OnlinePumpSdk(conn);
  }

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

  async pending(): Promise<number> {
    const bn = await this.sdk.getCreatorVaultBalanceBothPrograms(this.creator.publicKey);
    return Number(bn.toString());
  }

  async run() {
    const pending = await this.pending();
    if (pending >= this.opts.minClaimLamports) {
      const ixs = await this.sdk.collectCoinCreatorFeeAllQuotesInstructions(this.creator.publicKey, this.creator.publicKey);
      if (ixs.length) {
        const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 20_000 }), ...ixs);
        await sendAndConfirmTransaction(this.conn, tx, [this.creator], { commitment: "confirmed" });
      }
    }
    const bal = await this.conn.getBalance(this.creator.publicKey, "confirmed");
    const sweep = bal - this.opts.keepLamports;
    if (sweep >= this.opts.minClaimLamports) {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: this.creator.publicKey, toPubkey: this.vault, lamports: sweep }));
      const sig = await sendAndConfirmTransaction(this.conn, tx, [this.creator], { commitment: "confirmed" });
      this.lastSweep = { at: Date.now(), amount: sweep, sig };
    }
  }
}
