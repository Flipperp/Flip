import { describe, it, expect, beforeEach } from "vitest";
import { openDb } from "../src/db.js";
import { config } from "../src/config.js";
import { Engine, TradeError, HOUSE } from "../src/engine/engine.js";
import { PriceStore } from "../src/oracle/priceStore.js";
import { worstCasePayout, fillPrice, positionPnl, split, profitFee } from "../src/engine/pricing.js";

const SOL = 1_000_000_000;
const MINT = "Mint1111111111111111111111111111111111111111";
const MINT2 = "Mint2222222222222222222222222222222222222222";

function setup(overrides: Partial<typeof config> = {}) {
  let clock = 1_700_000_000_000;
  const now = () => clock;
  const cfg = { ...config, realEnabled: true, ...overrides };
  const db = openDb(":memory:");
  const prices = new PriceStore(cfg.trading.twapWindowMs, cfg.trading.minTwapSamples, cfg.trading.staleMs, now);
  const engine = new Engine(db, prices, cfg, now);
  for (const m of [MINT, MINT2]) {
    db.prepare("INSERT INTO markets (mint, symbol, name, venue, source, supply, added_at) VALUES (?, 'T', 'Test', 'pumpswap', '{}', 1e9, ?)").run(m, clock - 30 * 86_400_000);
  }
  const liq = 300 * SOL;
  /** Feed one price per second for `secs` seconds at a constant price. */
  const feed = (mint: string, price: number, secs = 31) => {
    for (let i = 0; i < secs; i++) {
      clock += 1000;
      prices.push(mint, { price, liquidity: liq, mcapSol: price * 1e9, ts: clock });
    }
  };
  const advance = (ms: number) => (clock += ms);
  return { db, engine, prices, cfg, feed, advance, now };
}

function seedRealPool(engine: Engine, amount = 100 * SOL) {
  engine.creditDeposit("lp", "real", amount, "seed");
  engine.poolDeposit("lp", "real", amount);
}

describe("pricing", () => {
  it("fills at the worse of live and twap plus spread", () => {
    expect(fillPrice("open", "long", 1.0, 1.1, 25)).toBeCloseTo(1.1 * 1.0025);
    expect(fillPrice("open", "short", 1.0, 1.1, 25)).toBeCloseTo(1.0 * 0.9975);
    expect(fillPrice("close", "long", 1.0, 1.1, 25)).toBeCloseTo(1.0 * 0.9975);
    expect(fillPrice("close", "short", 1.0, 1.1, 25)).toBeCloseTo(1.1 * 1.0025);
  });

  it("caps pnl at +200% and -100%", () => {
    const p = { side: "long" as const, leverage: 2, stake: SOL, entry_price: 1 };
    expect(Math.abs(positionPnl(p, 1.1, 2) - 0.2 * SOL)).toBeLessThanOrEqual(1);
    expect(positionPnl(p, 10, 2)).toBe(2 * SOL);
    expect(positionPnl(p, 0.1, 2)).toBe(-SOL);
    const s = { ...p, side: "short" as const };
    expect(Math.abs(positionPnl(s, 0.9, 2) - 0.2 * SOL)).toBeLessThanOrEqual(1);
    expect(positionPnl(s, 3, 2)).toBe(-SOL);
  });

  it("nets long and short reserves on the same coin", () => {
    const long = { side: "long" as const, leverage: 2, stake: SOL, entry_price: 1 };
    const short = { side: "short" as const, leverage: 2, stake: SOL, entry_price: 1 };
    expect(worstCasePayout([long], 2)).toBe(2 * SOL);
    // Equal long and short: when the long wins 2, the short loses 1 -> net 1.
    expect(worstCasePayout([long, short], 2)).toBe(SOL);
    // Brute-force check against a dense price grid.
    const ps = [long, short, { side: "long" as const, leverage: 10, stake: 3 * SOL, entry_price: 1.3 }, { side: "short" as const, leverage: 5, stake: 2 * SOL, entry_price: 0.8 }];
    let brute = 0;
    for (let x = 0.0001; x < 10; x *= 1.001) {
      const tot = ps.reduce((a, p) => a + positionPnl(p, x, 2), 0);
      brute = Math.max(brute, tot);
    }
    const wc = worstCasePayout(ps, 2);
    expect(wc).toBeGreaterThanOrEqual(brute);
    expect(wc - brute).toBeLessThan(0.01 * SOL);
  });

  it("splits fees exactly and applies tier discounts", () => {
    const s = split(1001, { pool: 6000, holders: 2500, treasury: 1500 });
    expect(s.pool + s.holders + s.treasury).toBe(1001);
    expect(profitFee(SOL, 300, 0)).toBe(0.03 * SOL);
    expect(profitFee(SOL, 300, 5000)).toBe(0.015 * SOL);
    expect(profitFee(-SOL, 300, 0)).toBe(0);
  });
});

describe("engine", () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => {
    t = setup();
  });

  it("refuses trades until the 30s average is warm", () => {
    seedRealPool(t.engine);
    t.engine.creditDeposit("alice", "real", SOL, "d1");
    t.feed(MINT, 1, 5);
    expect(() => t.engine.open({ wallet: "alice", mode: "real", mint: MINT, side: "long", leverage: 2, stake: 0.1 * SOL })).toThrow(TradeError);
    t.feed(MINT, 1, 30);
    const p = t.engine.open({ wallet: "alice", mode: "real", mint: MINT, side: "long", leverage: 2, stake: 0.1 * SOL });
    expect(p.status).toBe("open");
  });

  it("full lifecycle conserves every lamport", () => {
    seedRealPool(t.engine);
    t.engine.creditDeposit("alice", "real", 2 * SOL, "d1");
    t.engine.creditDeposit("bob", "real", 2 * SOL, "d2");
    t.feed(MINT, 1);
    const a = t.engine.open({ wallet: "alice", mode: "real", mint: MINT, side: "long", leverage: 2, stake: SOL });
    const b = t.engine.open({ wallet: "bob", mode: "real", mint: MINT, side: "short", leverage: 5, stake: 0.5 * SOL });
    expect(t.engine.conservation("real").ok).toBe(true);
    t.feed(MINT, 1.1);
    const ca = t.engine.close(a.id, "alice");
    expect(ca.pnl!).toBeGreaterThan(0);
    expect(ca.fee!).toBeGreaterThan(0);
    const cb = t.engine.close(b.id, "bob");
    expect(cb.pnl!).toBeLessThan(0);
    const c = t.engine.conservation("real");
    expect(c.problems).toEqual([]);
    // Spread means a round trip at a flat price loses money.
    t.feed(MINT2, 2);
    const flat = t.engine.open({ wallet: "alice", mode: "real", mint: MINT2, side: "long", leverage: 2, stake: 0.1 * SOL });
    t.advance(11_000);
    t.feed(MINT2, 2, 1);
    expect(t.engine.close(flat.id, "alice").pnl!).toBeLessThan(0);
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("a one-second wick can't be farmed because fills use the worse of live and TWAP", () => {
    seedRealPool(t.engine);
    t.engine.creditDeposit("whale", "real", SOL, "d");
    t.feed(MINT, 1);
    const p = t.engine.open({ wallet: "whale", mode: "real", mint: MINT, side: "long", leverage: 2, stake: 0.5 * SOL });
    t.advance(10_000);
    t.feed(MINT, 1.5, 1); // single-tick pump
    const closed = t.engine.close(p.id, "whale");
    // Exit uses min(live, twap) ~ just above 1, so the pump barely registers.
    expect(closed.pnl!).toBeLessThan(0.05 * SOL);
  });

  it("enforces minimum hold for manual closes", () => {
    seedRealPool(t.engine);
    t.engine.creditDeposit("a", "real", SOL, "d");
    t.feed(MINT, 1);
    const p = t.engine.open({ wallet: "a", mode: "real", mint: MINT, side: "long", leverage: 2, stake: 0.1 * SOL });
    expect(() => t.engine.close(p.id, "a")).toThrow(/after 10s/);
  });

  it("auto-closes at max win and at liquidation", () => {
    seedRealPool(t.engine);
    t.engine.creditDeposit("a", "real", 2 * SOL, "d");
    t.feed(MINT, 1);
    const w = t.engine.open({ wallet: "a", mode: "real", mint: MINT, side: "long", leverage: 10, stake: 0.5 * SOL });
    const l = t.engine.open({ wallet: "a", mode: "real", mint: MINT, side: "short", leverage: 10, stake: 0.5 * SOL });
    t.feed(MINT, 1.5, 31);
    const closed = t.engine.tick();
    expect(closed.sort()).toEqual([w.id, l.id].sort());
    expect(t.engine.position(w.id)!.close_reason).toBe("max_win");
    expect(t.engine.position(w.id)!.pnl).toBe(SOL);
    expect(t.engine.position(l.id)!.close_reason).toBe("liquidated");
    expect(t.engine.position(l.id)!.payout).toBe(0);
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("never lets reserves exceed pool cash", () => {
    seedRealPool(t.engine, 3 * SOL);
    t.engine.creditDeposit("a", "real", 10 * SOL, "d");
    for (let i = 0; i < 31; i++) {
      t.feed(MINT, 1, 1);
      t.prices.push(MINT2, { price: 1, liquidity: 300 * SOL, mcapSol: 1e9, ts: t.now() });
    }
    // Side cap = min(5 SOL, 2% of 300 SOL liquidity = 6 SOL, 10% of 3 SOL pool = 0.3 SOL)
    expect(() => t.engine.open({ wallet: "a", mode: "real", mint: MINT, side: "long", leverage: 2, stake: 0.4 * SOL })).toThrow(/room/);
    let opened = 0;
    try {
      for (let i = 0; i < 50; i++) {
        t.engine.open({ wallet: "a", mode: "real", mint: i % 2 ? MINT : MINT2, side: "long", leverage: 2, stake: 0.1 * SOL });
        opened++;
      }
    } catch (e) {
      expect((e as TradeError).code).toMatch(/size_cap|pool_full/);
    }
    expect(t.engine.reserve("real")).toBeLessThanOrEqual(t.engine.bucket("real", "pool_cash"));
    expect(opened).toBeGreaterThan(0);
  });

  it("pool shares track NAV including unrealized P&L, and withdrawals respect reserves", () => {
    seedRealPool(t.engine, 10 * SOL);
    t.engine.creditDeposit("lp2", "real", 10 * SOL, "d");
    t.engine.creditDeposit("trader", "real", 5 * SOL, "d");
    t.feed(MINT, 1);
    t.engine.open({ wallet: "trader", mode: "real", mint: MINT, side: "long", leverage: 2, stake: SOL });
    t.feed(MINT, 1.2);
    const navBefore = t.engine.poolState("real").sharePrice;
    expect(navBefore).toBeLessThan(1); // pool is losing to the long
    // Original LP can't pull cash that is backing the open trade's max win.
    const lpShares = t.engine.shares("lp", "real");
    expect(() => t.engine.poolWithdraw("lp", "real", lpShares)).toThrow(/backing open trades/);
    t.engine.poolWithdraw("lp", "real", Math.floor(lpShares / 4));
    const { shares } = t.engine.poolDeposit("lp2", "real", 5 * SOL);
    // New LP buys in at the marked-down price, so gets more shares than lamports.
    expect(shares).toBeGreaterThan(5 * SOL);
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("splits creator fees and profit fees into pool, holders and treasury", () => {
    seedRealPool(t.engine);
    const potBefore = t.engine.bucket("real", "holders_pot");
    t.engine.creditCreatorFee(SOL, "cf1");
    expect(t.engine.bucket("real", "holders_pot") - potBefore).toBe(0.4 * SOL);
    expect(t.engine.bucket("real", "treasury")).toBe(0.1 * SOL);
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("withdrawals move to pending, settle with fees, and refund on failure", () => {
    t.engine.creditDeposit("a", "real", 2 * SOL, "d");
    t.engine.creditCreatorFee(0.1 * SOL, "cf"); // treasury pays network fees
    const id = t.engine.requestWithdrawal("a", SOL);
    expect(t.engine.balance("a", "real")).toBe(SOL);
    expect(t.engine.conservation("real").ok).toBe(true);
    t.engine.settleWithdrawal(id, "sig", 5000);
    expect(t.engine.conservation("real").ok).toBe(true);
    const id2 = t.engine.requestWithdrawal("a", 0.5 * SOL);
    t.engine.failWithdrawal(id2, "boom");
    expect(t.engine.balance("a", "real")).toBe(SOL);
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("test balances only exist before launch, and are isolated from real", () => {
    expect(() => t.engine.claimPaper("x")).toThrow(/real trading is live/);
    t = setup({ realEnabled: false });
    t.engine.claimPaper("p");
    expect(t.engine.balance("p", "paper")).toBe(5 * SOL);
    expect(() => t.engine.claimPaper("p")).toThrow(/Next claim/);
    expect(t.engine.shares(HOUSE, "paper")).toBe(config.paper.seedPool);
    t.feed(MINT, 1);
    const p = t.engine.open({ wallet: "p", mode: "paper", mint: MINT, side: "short", leverage: 5, stake: SOL });
    expect(t.engine.openPositions("real").length).toBe(0);
    t.advance(11_000);
    t.feed(MINT, 1, 1);
    t.engine.close(p.id, "p");
    expect(t.engine.conservation("paper").ok).toBe(true);
    expect(t.engine.conservation("real").ok).toBe(true);
  });

  it("real mode is blocked when disabled", () => {
    const off = setup({ realEnabled: false });
    off.engine.creditDeposit("a", "real", SOL, "d");
    off.feed(MINT, 1);
    expect(() => off.engine.open({ wallet: "a", mode: "real", mint: MINT, side: "long", leverage: 2, stake: 0.1 * SOL })).toThrow(/not enabled/);
  });

  it("halts block opens but auto-close still settles", () => {
    seedRealPool(t.engine);
    t.engine.creditDeposit("a", "real", SOL, "d");
    t.feed(MINT, 1);
    const p = t.engine.open({ wallet: "a", mode: "real", mint: MINT, side: "long", leverage: 10, stake: 0.1 * SOL });
    t.engine.halt("real", "test");
    expect(() => t.engine.open({ wallet: "a", mode: "real", mint: MINT, side: "long", leverage: 2, stake: 0.1 * SOL })).toThrow(/paused/);
    t.feed(MINT, 0.5);
    t.engine.tick();
    expect(t.engine.position(p.id)!.status).toBe("closed");
  });

  it("tier uses the lower of live and time-weighted balance", () => {
    t.db.prepare("INSERT INTO holder_balances (wallet, balance, twab, updated_at) VALUES ('h', 20000000, 500000, 0)").run();
    expect(t.engine.tierFor("h")).toBe(0);
    t.db.prepare("UPDATE holder_balances SET twab = 6000000 WHERE wallet = 'h'").run();
    expect(t.engine.tierFor("h")).toBe(2);
  });

  it("randomized stress keeps the book balanced and reserves covered", () => {
    seedRealPool(t.engine, 50 * SOL);
    const wallets = ["w1", "w2", "w3", "w4", "w5"];
    for (const w of wallets) t.engine.creditDeposit(w, "real", 5 * SOL, `d-${w}`);
    let price = 1;
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    t.feed(MINT, price);
    t.feed(MINT2, price);
    for (let step = 0; step < 600; step++) {
      price *= 1 + (rnd() - 0.5) * 0.08;
      t.feed(MINT, price, 1);
      t.feed(MINT2, 1 / price, 1);
      const w = wallets[Math.floor(rnd() * wallets.length)];
      const r = rnd();
      try {
        if (r < 0.4) {
          t.engine.open({ wallet: w, mode: "real", mint: rnd() < 0.5 ? MINT : MINT2, side: rnd() < 0.5 ? "long" : "short", leverage: [2, 5, 10][Math.floor(rnd() * 3)], stake: Math.floor((0.01 + rnd() * 0.5) * SOL) });
        } else if (r < 0.7) {
          const open = t.engine.walletPositions(w, "real", "open");
          if (open.length) t.engine.close(open[0].id, w);
        } else if (r < 0.75) {
          t.engine.poolDeposit(w, "real", Math.floor(0.2 * SOL));
        } else if (r < 0.8) {
          const s = t.engine.shares(w, "real");
          if (s > 0) t.engine.poolWithdraw(w, "real", Math.floor(s / 2));
        } else if (r < 0.82) {
          t.engine.creditCreatorFee(Math.floor(rnd() * SOL), `cf${step}`);
        }
      } catch (e) {
        if (!(e instanceof TradeError)) throw e;
      }
      t.engine.tick();
      expect(t.engine.reserve("real")).toBeLessThanOrEqual(t.engine.bucket("real", "pool_cash"));
    }
    const c = t.engine.conservation("real");
    expect(c.problems).toEqual([]);
  });
});

describe("candles", () => {
  it("aggregates OHLC per timeframe and connects buckets", () => {
    let clock = 1_700_000_000_000 - (1_700_000_000_000 % 60_000);
    const ps = new PriceStore(30_000, 1, 10_000, () => clock);
    const feed = (p: number) => ps.push("m", { price: p, liquidity: 1, mcapSol: 1, ts: clock });
    feed(1);
    clock += 10_000;
    feed(3);
    clock += 10_000;
    feed(0.5);
    clock += 10_000;
    feed(2);
    clock += 40_000; // next minute
    feed(2.5);
    const c = ps.candles("m", "1m");
    expect(c.length).toBe(2);
    expect(c[0]).toMatchObject({ o: 1, h: 3, l: 0.5, c: 2 });
    expect(c[1].o).toBe(2);
    expect(c[1].c).toBe(2.5);
    expect(ps.candles("m", "5s").length).toBe(5);
  });
});
