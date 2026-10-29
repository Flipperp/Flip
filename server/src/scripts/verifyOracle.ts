import "dotenv/config";
import { Connection } from "@solana/web3.js";
import { openDb } from "../db.js";
import { PriceStore } from "../oracle/priceStore.js";
import { ChainOracle } from "../oracle/chainOracle.js";

/**
 * Checks the on-chain price readers against DexScreener before going live.
 *   npm run verify-oracle -- <mint> [<mint> ...]
 * Pass one coin still on the pump.fun curve, one on PumpSwap, and one on Raydium.
 * Each line should show a diff well under 2%.
 */
const mints = process.argv.slice(2);
if (!mints.length) {
  console.log("usage: npm run verify-oracle -- <mint> [<mint> ...]");
  process.exit(1);
}
const conn = new Connection(process.env.RPC_URL ?? "https://api.mainnet-beta.solana.com", "confirmed");
const db = openDb(":memory:");
const prices = new PriceStore(30_000, 1, 60_000);
const oracle = new ChainOracle(conn, db, prices, { pollMs: 1000, slowPollMs: 0, hotMints: () => mints });
let failed = false;
for (const mint of mints) {
  try {
    const m = await oracle.resolve(mint);
    await oracle.poll();
    const v = prices.view(mint);
    const ds = await fetch(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`).then((r) => r.json()).catch(() => []);
    const pair = (Array.isArray(ds) ? ds : []).filter((p: any) => p.quoteToken?.symbol === "SOL").sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
    const ref = pair ? Number(pair.priceNative) : null;
    const diff = v && ref ? v.live / ref - 1 : null;
    if (diff === null || Math.abs(diff) > 0.02) failed = true;
    console.log(
      `${m.symbol.padEnd(10)} ${m.venue.padEnd(9)} ours=${v?.live.toPrecision(6) ?? "none"} dexscreener=${ref?.toPrecision(6) ?? "none"} diff=${diff === null ? "?" : (diff * 100).toFixed(2) + "%"} liquidity=${v ? (v.liquidity / 1e9).toFixed(1) : "?"} SOL`,
    );
  } catch (e: any) {
    failed = true;
    console.log(`${mint}: ${e.message}`);
  }
}
process.exit(failed ? 1 : 0);
