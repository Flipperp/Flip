import fs from "node:fs";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";

/** Load a keypair from a base58 secret, a JSON byte array, or a path to a Solana CLI keypair file. */
export function loadKeypair(value: string): Keypair | null {
  if (!value) return null;
  const v = value.trim();
  if (v.startsWith("[")) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(v)));
  if (fs.existsSync(v)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(v, "utf8"))));
  return Keypair.fromSecretKey(bs58.decode(v));
}
