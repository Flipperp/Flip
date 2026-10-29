import { BaseMessageSignerWalletAdapter, WalletReadyState, WalletNotConnectedError, type WalletName } from "@solana/wallet-adapter-base";
import { Keypair, PublicKey, type Transaction, type VersionedTransaction } from "@solana/web3.js";
import nacl from "tweetnacl";

/** A throwaway in-browser wallet for the hosted Practice demo. Holds paper SOL only. */
export class DemoWalletAdapter extends BaseMessageSignerWalletAdapter {
  name = "Demo wallet (practice only)" as WalletName<"Demo wallet (practice only)">;
  url = "https://example.invalid";
  icon =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%23B9A4FF'/%3E%3Cpath d='M7 9h18l-7 7 7 7H7' fill='none' stroke='%2315122A' stroke-width='3' stroke-linejoin='round'/%3E%3C/svg%3E";
  readyState = WalletReadyState.Installed;
  supportedTransactionVersions = null;
  private kp: Keypair | null = null;
  private _connecting = false;

  get publicKey(): PublicKey | null {
    return this.kp?.publicKey ?? null;
  }
  get connecting() {
    return this._connecting;
  }

  async connect() {
    this._connecting = true;
    let secret: Uint8Array | null = null;
    try {
      const raw = localStorage.getItem("flip:demo-wallet");
      if (raw) secret = Uint8Array.from(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    this.kp = secret ? Keypair.fromSecretKey(secret) : Keypair.generate();
    try {
      localStorage.setItem("flip:demo-wallet", JSON.stringify(Array.from(this.kp.secretKey)));
    } catch {
      /* in-memory only */
    }
    this._connecting = false;
    this.emit("connect", this.kp.publicKey);
  }

  async disconnect() {
    this.kp = null;
    this.emit("disconnect");
  }

  async signMessage(message: Uint8Array) {
    if (!this.kp) throw new WalletNotConnectedError();
    return nacl.sign.detached(message, this.kp.secretKey);
  }

  async signTransaction<T extends Transaction | VersionedTransaction>(_tx: T): Promise<T> {
    throw new Error("The demo wallet can't send transactions. Practice mode doesn't need deposits.");
  }
  async signAllTransactions<T extends Transaction | VersionedTransaction>(_txs: T[]): Promise<T[]> {
    throw new Error("The demo wallet can't send transactions.");
  }
}
