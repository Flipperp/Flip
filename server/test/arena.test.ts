import { describe, it, expect } from "vitest";
import { openDb } from "../src/db.js";
import { config } from "../src/config.js";
import { Engine, TradeError } from "../src/engine/engine.js";
import { Arena } from "../src/engine/arena.js";
import { PriceStore } from "../src/oracle/priceStore.js";
import { top10Share } from "../src/engine/guard.js";

const SOL = 1_000_000_000;
const MINT = "Mint1111111111111111111111111111111111111111";
const R = config.arena.roundMs;

function setup(opts: { ageHours?: number; liq?: number } = {}) {
  // Start exactly 1 minute into a round.
  let clock = Math.floor(1_700_000_000_000 / R) * R + 60_000;
  const now = () => clock;
  const cfg = { ...config, realEnabled: true };
  const db = openDb(":memory:");
  const prices = new PriceStore(cfg.trading.twapWindowMs, cfg.trading.minTwapSamples, cfg.trading.staleMs, now);
  const engine = new Engine(db, prices, cfg, now);
  const arena = new Arena(engine, prices, cfg, now);
  const born = clock - (opts.ageHours ?? 1) * 3600_000;
  db.prepare("INSERT INTO markets (mint, symbol, name, venue, source, supply, added_at, born_at) VALUES (?, 'T', 'T', 'pumpswap', '{}', 1e9, ?, ?)").run(MINT, born, born);
  let price = 1;
  const liq = opts.liq ?? 100 * SOL;
  /** Advance time one second at a time, posting the current price each second. */
  const run = (ms: number, p?: number | ((t: number) => number)) => {
    for (let i = 0; i < ms; i += 1000) {
      clock += 1000;
      if (p !== undefined) price = typeof p === "function" ? p(clock) : p;
      prices.push(MINT, { price, liquidity: liq, mcapSol: price * 1e9, ts: clock });
      arena.tick();
    }
  };
  /** Advance time with the oracle silent (no new prices). */
  const wait = (ms: number) => {
    for (let i = 0; i < ms; i += 1000) {
      clock += 1000;
      arena.tick();
    }
  };
  const fund = (w: string, amt = 10 * SOL) => engine.creditDeposit(w, "real", amt, `d-${w}-${Math.random()}`);
  return { db, engine, arena, prices, cfg, run, wait, fund, now: () => clock };
}

describe("pool risk rules", () => {
  it("keeps the pool out of young coins and opens it once they season", () => {
    const t = setup({ ageHours: 1 });
    t.engine.creditDeposit("lp", "real", 100 * SOL, "seed");
    t.engine.poolDeposit("lp", "real", 100 * SOL);
    t.fund("a");
    t.run(130_000, 1);
    const st = t.engine.marketState("real", MINT);
    expect(st.tradable).toBe(false);
    expect(st.reason).toBe("too_new");
    expect(() => t.engine.open({ wallet: "a", mode: "real", mint: MINT, side: "short", leverage: 10, stake: 0.1 * SOL })).toThrow(/Too new for the pool/);
  });

  it("requires a fresh, unconcentrated holder reading for coins under the holder-check age", () => {
    const t = setup({ ageHours: 10 });
    t.run(130_000, 1);
    expect(t.engine.marketState("real", MINT).reason).toBe("holders_unknown");
    t.engine.guard.setHolders(MINT, { top10: 0.45, checkedAt: t.now() });
    expect(t.engine.marketState("real", MINT).reason).toBe("concentrated");
    t.engine.guard.setHolders(MINT, { top10: 0.2, checkedAt: t.now() });
    const st = t.engine.marketState("real", MINT);
    expect(st.reason).toBe(null);
    // Still young (< 24h): half the side cap and a 2-minute average.
    expect(st.risk!.young).toBe(true);
    expect(st.risk!.sideCapMult).toBe(0.5);
    expect(st.risk!.twapMs).toBe(120_000);
  });

  it("pauses new positions after a liquidity crash", () => {
    const t = setup({ ageHours: 100 });
    t.run(130_000, 1);
    expect(t.engine.marketState("real", MINT).reason).toBe(null);
    // 100 SOL -> 55 SOL: still above the 50 SOL floor, but a 45% drop.
    for (let i = 0; i < 5; i++) t.prices.push(MINT, { price: 0.5, liquidity: 55 * SOL, mcapSol: 1, ts: t.now() + i });
    expect(t.engine.marketState("real", MINT).reason).toBe("liquidity_drop");
  });

  it("measures the top 10 share without the curve and pool vaults", () => {
    const accts = [{ address: "vault", uiAmount: 600 }, ...Array.from({ length: 12 }, (_, i) => ({ address: `w${i}`, uiAmount: 30 - i }))];
    // Top 10 wallets excluding the vault: 30+29+...+21 = 255 of 1000.
    expect(top10Share(accts, new Set(["vault"]), 1000)).toBeCloseTo(0.255);
    expect(top10Share(accts, new Set(), 1000)).toBeGreaterThan(0.8);
  });
});

describe("arena", () => {
  it("only takes bets for the next round, before its lock buffer", () => {
    const t = setup();
    t.fund("a");
    t.run(30_000, 1);
    const next = t.arena.bettableStart();
    expect(next % R).toBe(0);
    expect(next).toBeGreaterThan(t.now());
    expect(() => t.arena.bet({ wallet: "a", mode: "real", mint: MINT, side: "up", amount: 0.1 * SOL, start: next - R })).toThrow(/closed/);
    t.arena.bet({ wallet: "a", mode: "real", mint: MINT, side: "up", amount: 0.1 * SOL, start: next });
    // Inside the last 10 seconds before the round starts, the round after becomes the open one.
    t.run(next - t.now() - 5000, 1);
    expect(t.arena.bettableStart()).toBe(next + R);
    expect(() => t.arena.bet({ wallet: "a", mode: "real", mint: MINT, side: "up", amount: 0.1 * SOL, start: next })).toThrow(/closed/);
  });

  it("pays winners the whole pot pro rata, minus the fee, and conserves every lamport", () => {
    const t = setup();
    for (const w of ["u1", "u2", "d1"]) t.fund(w);
    t.run(10_000, 1);
    const s = t.arena.bettableStart();
    t.arena.bet({ wallet: "u1", mode: "real", mint: MINT, side: "up", amount: 1 * SOL, start: s });
    t.arena.bet({ wallet: "u2", mode: "real", mint: MINT, side: "up", amount: 3 * SOL, start: s });
    t.arena.bet({ wallet: "d1", mode: "real", mint: MINT, side: "down", amount: 2 * SOL, start: s });
    expect(t.engine.conservation("real").ok).toBe(true);
    expect(t.engine.bucket("real", "arena_escrow")).toBe(6 * SOL);
    // Price flat into the start, then up 10% across the round.
    t.run(s - t.now(), 1);
    t.run(R + 5000, (c) => (c < s + R - 20_000 ? 1.05 : 1.1));
    const r = t.arena.round(MINT, "real", s)!;
    expect(r.status).toBe("settled");
    expect(r.result).toBe("up");
    expect(r.lock_price).toBeCloseTo(1);
    // Pot 6 SOL, 3% fee = 0.18 SOL, 5.82 SOL to Up split 1:3.
    expect(t.engine.balance("u1", "real")).toBe(9 * SOL + Math.floor((1 * SOL * 5.82 * SOL) / (4 * SOL)));
    expect(t.engine.balance("u2", "real")).toBe(7 * SOL + Math.floor((3 * SOL * 5.82 * SOL) / (4 * SOL)));
    expect(t.engine.balance("d1", "real")).toBe(8 * SOL);
    expect(r.fee).toBeGreaterThanOrEqual(0.18 * SOL);
    expect(t.engine.bucket("real", "arena_escrow")).toBe(0);
    expect(t.engine.bucket("real", "pool_cash")).toBe(0); // the pool takes no side and no fee
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("refunds a one-sided round, an unchanged price, and a round with no price", () => {
    const t = setup();
    for (const w of ["a", "b"]) t.fund(w);
    t.run(10_000, 1);
    let s = t.arena.bettableStart();
    t.arena.bet({ wallet: "a", mode: "real", mint: MINT, side: "up", amount: 1 * SOL, start: s });
    t.run(s - t.now() + R + 5000, (c) => (c < s ? 1 : 2));
    expect(t.arena.round(MINT, "real", s)!.status).toBe("refunded");
    expect(t.engine.balance("a", "real")).toBe(10 * SOL);

    s = t.arena.bettableStart();
    t.arena.bet({ wallet: "a", mode: "real", mint: MINT, side: "up", amount: 1 * SOL, start: s });
    t.arena.bet({ wallet: "b", mode: "real", mint: MINT, side: "down", amount: 1 * SOL, start: s });
    t.run(s - t.now() + R + 5000, 2);
    expect(t.arena.round(MINT, "real", s)!.status).toBe("refunded");

    s = t.arena.bettableStart();
    t.arena.bet({ wallet: "a", mode: "real", mint: MINT, side: "up", amount: 1 * SOL, start: s });
    t.arena.bet({ wallet: "b", mode: "real", mint: MINT, side: "down", amount: 1 * SOL, start: s });
    t.run(s - t.now() - 20_000, 2);
    // Oracle goes dark across the lock: no samples near the start, so the round refunds.
    t.wait(20_000 + 20_000);
    const r = t.arena.round(MINT, "real", s)!;
    expect(r.status).toBe("refunded");
    expect(t.engine.balance("a", "real")).toBe(10 * SOL);
    expect(t.engine.balance("b", "real")).toBe(10 * SOL);
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("refuses bets over the per-round cap and on coins too thin to price", () => {
    const t = setup();
    t.fund("a", 20 * SOL);
    t.run(10_000, 1);
    const s = t.arena.bettableStart();
    t.arena.bet({ wallet: "a", mode: "real", mint: MINT, side: "up", amount: 5 * SOL, start: s });
    expect(() => t.arena.bet({ wallet: "a", mode: "real", mint: MINT, side: "down", amount: 0.1 * SOL, start: s })).toThrow(TradeError);
    const thin = setup({ liq: 1 * SOL });
    thin.fund("a");
    thin.run(10_000, 1);
    expect(() => thin.arena.bet({ wallet: "a", mode: "real", mint: MINT, side: "up", amount: 0.1 * SOL, start: thin.arena.bettableStart() })).toThrow(/too thin/);
  });

  it("an insider who dumps wins the other side's pot, never more", () => {
    const t = setup();
    t.fund("insider", 10 * SOL);
    t.fund("victim", 10 * SOL);
    t.run(10_000, 1);
    const s = t.arena.bettableStart();
    t.arena.bet({ wallet: "insider", mode: "real", mint: MINT, side: "down", amount: 5 * SOL, start: s });
    t.arena.bet({ wallet: "victim", mode: "real", mint: MINT, side: "up", amount: 0.5 * SOL, start: s });
    // Dump 90% during the round.
    t.run(s - t.now(), 1);
    t.run(R + 5000, 0.1);
    const gain = t.engine.balance("insider", "real") - 10 * SOL;
    expect(gain).toBeLessThanOrEqual(0.5 * SOL);
    expect(gain).toBeGreaterThan(0);
    expect(t.engine.bucket("real", "pool_cash")).toBe(0);
    expect(t.engine.conservation("real").ok).toBe(true);
  });
});
