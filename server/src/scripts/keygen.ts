import fs from "node:fs";
import { Keypair } from "@solana/web3.js";

/** Generates the vault and creator keypairs as Solana CLI JSON files. Never commit these. */
for (const name of ["vault", "creator"]) {
  const file = `./keys/${name}.json`;
  if (fs.existsSync(file)) {
    console.log(`${name}: exists (${file}), skipping`);
    continue;
  }
  fs.mkdirSync("./keys", { recursive: true });
  const kp = Keypair.generate();
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 });
  console.log(`${name}: ${kp.publicKey.toBase58()} -> ${file}`);
}
