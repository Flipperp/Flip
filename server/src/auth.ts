import nacl from "tweetnacl";
import bs58 from "bs58";
import type { DB } from "./db.js";

/**
 * Every state-changing request is a signed message:
 *
 *   <brand>:v1
 *   <json payload>
 *   signer:<base58 pubkey>
 *   nonce:<random>
 *   ts:<unix ms>
 *
 * Wallets sign with signMessage (nothing is sent from the wallet). To avoid a popup per trade a
 * wallet can authorize a short-lived browser session key, which may trade but never withdraw or
 * create further sessions.
 */
export interface Signed {
  message: string;
  signature: string;
}

export interface Verified {
  payload: any;
  signer: string;
  /** The wallet the action applies to (the signer, or the wallet behind a session key). */
  wallet: string;
  viaSession: boolean;
}

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
  }
}

const MAX_SKEW_MS = 60_000;
const MAX_SESSION_MS = 24 * 3600_000;

export class Auth {
  constructor(private db: DB, private brand: string, private now: () => number = Date.now) {}

  static format(brand: string, payload: object, signer: string, nonce: string, ts: number) {
    return `${brand}:v1\n${JSON.stringify(payload)}\nsigner:${signer}\nnonce:${nonce}\nts:${ts}`;
  }

  verify(s: Signed): Verified {
    if (typeof s?.message !== "string" || typeof s?.signature !== "string") throw new AuthError("Missing signature");
    if (s.message.length > 4000) throw new AuthError("Message too long");
    const lines = s.message.split("\n");
    if (lines.length !== 5 || lines[0] !== `${this.brand}:v1`) throw new AuthError("Bad message format");
    let payload: any;
    try {
      payload = JSON.parse(lines[1]);
    } catch {
      throw new AuthError("Bad payload");
    }
    const field = (line: string, key: string) => {
      if (!line.startsWith(`${key}:`)) throw new AuthError(`Missing ${key}`);
      return line.slice(key.length + 1);
    };
    const signer = field(lines[2], "signer");
    const nonce = field(lines[3], "nonce");
    const ts = Number(field(lines[4], "ts"));
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(nonce)) throw new AuthError("Bad nonce");
    if (!Number.isFinite(ts) || Math.abs(this.now() - ts) > MAX_SKEW_MS) throw new AuthError("Signature expired, check your clock");
    let pub: Uint8Array, sig: Uint8Array;
    try {
      pub = bs58.decode(signer);
      sig = bs58.decode(s.signature);
    } catch {
      throw new AuthError("Bad encoding");
    }
    if (pub.length !== 32 || sig.length !== 64) throw new AuthError("Bad key or signature length");
    if (!nacl.sign.detached.verify(new TextEncoder().encode(s.message), sig, pub)) throw new AuthError("Invalid signature");

    // Replay protection.
    const ins = this.db.prepare("INSERT OR IGNORE INTO nonces (signer, nonce, ts) VALUES (?, ?, ?)").run(signer, nonce, ts);
    if (ins.changes !== 1) throw new AuthError("Replayed request");

    const sess = this.db.prepare("SELECT wallet, expires_at FROM sessions WHERE session_pubkey = ?").get(signer) as { wallet: string; expires_at: number } | undefined;
    if (sess) {
      if (sess.expires_at < this.now()) throw new AuthError("Session expired, reconnect your wallet");
      return { payload, signer, wallet: sess.wallet, viaSession: true };
    }
    return { payload, signer, wallet: signer, viaSession: false };
  }

  /** Wallet-signed: { action: "session", session: <pubkey>, expiresAt } */
  createSession(v: Verified) {
    if (v.viaSession) throw new AuthError("Sessions must be created by the wallet itself");
    const { session, expiresAt } = v.payload;
    if (typeof session !== "string" || bs58.decode(session).length !== 32) throw new AuthError("Bad session key");
    const exp = Math.min(Number(expiresAt) || 0, this.now() + MAX_SESSION_MS);
    if (exp <= this.now()) throw new AuthError("Bad expiry");
    if (session === v.wallet) throw new AuthError("Session key must differ from wallet");
    this.db.prepare("DELETE FROM sessions WHERE wallet = ? AND expires_at < ?").run(v.wallet, this.now());
    this.db
      .prepare("INSERT INTO sessions (session_pubkey, wallet, expires_at, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(session_pubkey) DO NOTHING")
      .run(session, v.wallet, exp, this.now());
    const row = this.db.prepare("SELECT wallet FROM sessions WHERE session_pubkey = ?").get(session) as { wallet: string };
    if (row.wallet !== v.wallet) throw new AuthError("Session key already in use");
    return { session, expiresAt: exp };
  }

  revokeSessions(wallet: string) {
    this.db.prepare("DELETE FROM sessions WHERE wallet = ?").run(wallet);
  }

  pruneNonces() {
    this.db.prepare("DELETE FROM nonces WHERE ts < ?").run(this.now() - 2 * MAX_SKEW_MS);
    this.db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(this.now());
  }
}
