import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { config } from "../src/config.js";
import { Engine } from "../src/engine/engine.js";
import { PriceStore } from "../src/oracle/priceStore.js";
import { HolderRewards } from "../src/chain/holders.js";
import { DepositWatcher } from "../src/chain/deposits.js";
import { Keypair, SystemProgram } from "@solana/web3.js";

const SOL = 1_000_000_000;
const H = 3600_000;
const SUPPLY = 1_000_000_000;

function setup() {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const cfg = { ...config, realEnabled: true };
  const db = openDb(":memory:");
  const prices = new PriceStore(30_000, 20, 10_000, now);
  const engine = new Engine(db, prices, cfg, now);
  const rewards = new HolderRewards(db, engine, cfg, now);
  return { db, engine, rewards, cfg, prices, advance: (ms: number) => (clock += ms), now };
}

describe("holder rewards", () => {
  it("pays pro-rata to time-weighted balance", () => {
    const t = setup();
    t.engine.creditCreatorFee(10 * SOL, "cf"); // 4 SOL to the holder pot
    t.rewards.currentEpoch();
    t.rewards.applySnapshot(new Map([["alice", 2_000_000]]), SUPPLY);
    t.advance(12 * H);
    t.rewards.applySnapshot(new Map([["alice", 2_000_000], ["bob", 2_000_000]]), SUPPLY);
    t.advance(12 * H);
    const res = t.rewards.applySnapshot(new Map([["alice", 2_000_000], ["bob", 2_000_000]]), SUPPLY);
    expect(res).not.toBeNull();
    const a = t.engine.balance("alice", "real");
    const b = t.engine.balance("bob", "real");
    // Alice held 24h, Bob 12h at the same size.
    expect(a / b).toBeCloseTo(2, 3);
    // 80% of the pot is paid, 20% rolls to the next epoch.
    expect(a + b).toBeLessThanOrEqual(Math.floor(4 * SOL * 0.8));
    expect(a + b).toBeGreaterThan(Math.floor(4 * SOL * 0.8) - 10);
    expect(t.engine.bucket("real", "holders_pot")).toBeGreaterThanOrEqual(0.8 * SOL - 10);
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("caps a single wallet's weight to limit dev or whale capture", () => {
    const t = setup();
    t.engine.creditCreatorFee(10 * SOL, "cf");
    t.rewards.currentEpoch();
    const m = new Map([["whale", 300_000_000], ["small", 30_000_000]]);
    t.rewards.applySnapshot(m, SUPPLY);
    t.advance(24 * H);
    t.rewards.applySnapshot(m, SUPPLY);
    // Both capped at 3% of supply = 30M, so they earn the same.
    expect(t.engine.balance("whale", "real")).toBe(t.engine.balance("small", "real"));
  });

  it("unlocks tiers only after holding through an epoch, and never above the live balance", () => {
    const t = setup();
    t.rewards.currentEpoch();
    t.rewards.applySnapshot(new Map([["h", 6_000_000]]), SUPPLY);
    t.advance(2 * H);
    t.rewards.applySnapshot(new Map([["h", 6_000_000]]), SUPPLY);
    expect(t.engine.tierFor("h")).toBe(0); // no closed epoch yet
    t.advance(22 * H);
    t.rewards.applySnapshot(new Map([["h", 6_000_000]]), SUPPLY);
    // Epoch closed with ~5.5M average (0 for the first 0s, then 6M); tier 2 needs 5M.
    expect(t.engine.tierFor("h")).toBe(2);
    t.advance(1 * H);
    t.rewards.applySnapshot(new Map([["h", 100]]), SUPPLY); // sold
    expect(t.engine.tierFor("h")).toBe(0);
  });

  it("pays rekt rebates on net epoch losses only, to tiered holders", () => {
    const t = setup();
    const MINT = "MintRebate11111111111111111111111111111111111";
    t.db.prepare("INSERT INTO markets (mint, symbol, name, venue, source, supply, added_at) VALUES (?, 'T', 'T', 'pumpswap', '{}', 1e9, 0)").run(MINT);
    t.engine.creditDeposit("lp", "real", 50 * SOL, "d");
    t.engine.poolDeposit("lp", "real", 50 * SOL);
    t.engine.creditCreatorFee(20 * SOL, "cf"); // 8 SOL holder pot
    t.engine.creditDeposit("trader", "real", 5 * SOL, "d2");
    t.engine.creditDeposit("hedger", "real", 5 * SOL, "d3");
    // Give both a tier from a prior epoch.
    t.db.prepare("INSERT INTO holder_balances (wallet, balance, twab, prev_avg, updated_at) VALUES ('trader', 2e6, 2e6, 2e6, 0), ('hedger', 2e6, 2e6, 2e6, 0)").run();
    t.rewards.currentEpoch();
    t.rewards.applySnapshot(new Map([["trader", 2e6], ["hedger", 2e6]]), SUPPLY);
    const feed = (price: number, secs: number) => {
      for (let i = 0; i < secs; i++) {
        t.advance(1000);
        t.prices.push(MINT, { price, liquidity: 500 * SOL, mcapSol: 1e9, ts: t.now() });
      }
    };
    feed(1, 31);
    const lose = t.engine.open({ wallet: "trader", mode: "real", mint: MINT, side: "long", leverage: 2, stake: SOL });
    const h1 = t.engine.open({ wallet: "hedger", mode: "real", mint: MINT, side: "long", leverage: 2, stake: SOL });
    const h2 = t.engine.open({ wallet: "hedger", mode: "real", mint: MINT, side: "short", leverage: 2, stake: SOL });
    feed(0.8, 31);
    t.engine.close(lose.id, "trader");
    t.engine.close(h1.id, "hedger");
    t.engine.close(h2.id, "hedger");
    const traderBefore = t.engine.balance("trader", "real");
    const hedgerBefore = t.engine.balance("hedger", "real");
    t.advance(24 * H);
    t.rewards.applySnapshot(new Map([["trader", 2e6], ["hedger", 2e6]]), SUPPLY);
    const rebates = t.db.prepare("SELECT wallet, rebate FROM holder_rewards WHERE rebate > 0").all() as { wallet: string; rebate: number }[];
    const tr = rebates.find((r) => r.wallet === "trader");
    expect(tr).toBeDefined();
    // Tier 1 rebate is 2% of the net loss (~0.4 SOL loss -> ~0.008 SOL).
    expect(tr!.rebate).toBeGreaterThan(0.005 * SOL);
    // Hedger's loss is only the spread, so their rebate is tiny or zero.
    const hr = rebates.find((r) => r.wallet === "hedger")?.rebate ?? 0;
    expect(hr).toBeLessThan(tr!.rebate / 5);
    expect(t.engine.balance("trader", "real")).toBeGreaterThan(traderBefore);
    expect(t.engine.balance("hedger", "real")).toBeGreaterThanOrEqual(hedgerBefore);
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("pays everything from the holder-fund wallet into the holder pot", () => {
    const t = setup();
    const vault = Keypair.generate().publicKey;
    const fund = Keypair.generate().publicKey;
    const w = new DepositWatcher(null as any, t.db, t.engine, vault, { pollMs: 1000, minDeposit: 5_000_000, creatorWallet: null, holderFundWallet: fund.toBase58(), commitment: "confirmed" });
    const ix = (from: string, lamports: number) => ({ programId: SystemProgram.programId, parsed: { type: "transfer", info: { source: from, destination: vault.toBase58(), lamports } } });
    const tx = (ixs: any[]) => ({ transaction: { message: { instructions: ixs } }, meta: { err: null, innerInstructions: [] } }) as any;
    const before = t.engine.bucket("real", "holders_pot");
    w.process("hf1", 1, tx([ix(fund.toBase58(), 3 * SOL)]));
    w.process("hf1", 1, tx([ix(fund.toBase58(), 3 * SOL)])); // replay
    expect(t.engine.bucket("real", "holders_pot") - before).toBe(3 * SOL);
    expect(t.engine.balance(fund.toBase58(), "real")).toBe(0);
    expect(t.engine.conservation("real").ok).toBe(true);
  });
});

describe("deposit watcher", () => {
  it("credits system transfers into the vault once, and routes creator sweeps to the fee split", () => {
    const t = setup();
    const vault = Keypair.generate().publicKey;
    const user = Keypair.generate().publicKey;
    const creator = Keypair.generate().publicKey;
    const w = new DepositWatcher(null as any, t.db, t.engine, vault, { pollMs: 1000, minDeposit: 5_000_000, creatorWallet: creator.toBase58(), commitment: "confirmed" });
    const ix = (from: string, lamports: number) => ({ programId: SystemProgram.programId, parsed: { type: "transfer", info: { source: from, destination: vault.toBase58(), lamports } } });
    const tx = (ixs: any[]) => ({ transaction: { message: { instructions: ixs } }, meta: { err: null, innerInstructions: [] } }) as any;
    w.process("sig1", 1, tx([ix(user.toBase58(), SOL)]));
    w.process("sig1", 1, tx([ix(user.toBase58(), SOL)])); // replay
    expect(t.engine.balance(user.toBase58(), "real")).toBe(SOL);
    w.process("sig2", 2, tx([ix(creator.toBase58(), 2 * SOL)]));
    expect(t.engine.bucket("real", "holders_pot")).toBe(0.8 * SOL);
    w.process("sig3", 3, tx([ix(user.toBase58(), 1000)])); // dust ignored
    expect(t.engine.balance(user.toBase58(), "real")).toBe(SOL);
    expect(t.engine.conservation("real").ok).toBe(true);
  });
});
