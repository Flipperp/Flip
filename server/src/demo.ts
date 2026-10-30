import type { DB } from "./db.js";
import type { Engine } from "./engine/engine.js";
import { TradeError } from "./engine/engine.js";
import type { PriceStore } from "./oracle/priceStore.js";
import type { Arena } from "./engine/arena.js";

const SOL = 1_000_000_000;

/**
 * DEMO=true: synthetic markets with random-walk prices and bot traders in Practice mode, so the
 * whole product can be shown and tested without an RPC. Never touches real mode.
 */
export function startDemo(db: DB, engine: Engine, prices: PriceStore, arena?: Arena) {
  const coins = [
    { mint: "DemoTrnch1111111111111111111111111111111pump", symbol: "TRENCH", name: "Trench Warfare", venue: "pumpswap", p: 0.0000041, liq: 610 },
    { mint: "DemoGoose2222222222222222222222222222222pump", symbol: "GOOSE", name: "Silly Goose", venue: "pumpswap", p: 0.0000183, liq: 1840 },
    { mint: "DemoRugdr3333333333333333333333333333333pump", symbol: "RUGDR", name: "Rug Doctor", venue: "pumpfun", p: 0.00000006, liq: 62, ageH: 0.7, top10: 0.58 },
    { mint: "DemoMoths4444444444444444444444444444444pump", symbol: "MOTH", name: "Lamp Enjoyer", venue: "pumpswap", p: 0.0000009, liq: 240, ageH: 3, top10: 0.21 },
    { mint: "DemoBagel5555555555555555555555555555555pump", symbol: "BAGEL", name: "Everything Bagel", venue: "raydium", p: 0.000072, liq: 5200 },
    { mint: "DemoChad77777777777777777777777777777777pump", symbol: "CHAD", name: "Chad Frog", venue: "pumpswap", p: 0.0000351, liq: 2300 },
    { mint: "DemoNap888888888888888888888888888888888pump", symbol: "NAP", name: "Professional Napper", venue: "pumpswap", p: 0.0000027, liq: 410, ageH: 14, top10: 0.19 },
    { mint: "DemoDrip99999999999999999999999999999999pump", symbol: "DRIP", name: "Drip Check", venue: "raydium", p: 0.000144, liq: 3900 },
    { mint: "DemoTiny66666666666666666666666666666666pump", symbol: "TINY", name: "Tiny Liquidity", venue: "pumpfun", p: 0.00000002, liq: 18 },
  ] as { mint: string; symbol: string; name: string; venue: string; p: number; liq: number; ageH?: number; top10?: number }[];
  const now = Date.now();
  for (const c of coins) {
    // Most demo coins are established. A few are young, to show the age gate and the Arena.
    const born = now - (c.ageH ?? 30 * 24) * 3600_000;
    db.prepare("INSERT OR IGNORE INTO markets (mint, symbol, name, image, venue, source, supply, decimals, added_at, last_viewed, listed, born_at) VALUES (?, ?, ?, '', ?, '{\"kind\":\"demo\"}', 1e9, 6, ?, ?, 1, ?)").run(c.mint, c.symbol, c.name, c.venue, born, now, born);
  }
  const refreshHolders = () => {
    for (const c of coins) if (c.top10 !== undefined) engine.guard.setHolders(c.mint, { top10: c.top10, checkedAt: Date.now() });
  };
  refreshHolders();
  setInterval(refreshHolders, 10 * 60_000);
  // Per-second volatility between 0.15% and 0.45%, with mild pull back toward a slowly moving anchor
  // so prices wander like memecoins without running off to absurd market caps.
  const state = coins.map((c) => ({ ...c, vol: 0.0015 + Math.random() * 0.003, anchor: c.p }));
  const gauss = () => (Math.random() + Math.random() + Math.random() + Math.random() - 2) * 1.732;
  const step = (s: (typeof state)[number], p: number, secs: number) => {
    s.anchor *= Math.exp(gauss() * s.vol * 0.3 * Math.sqrt(secs));
    const pull = Math.log(s.anchor / p) * 0.002 * secs;
    const shock = Math.random() < 0.0008 * secs ? (Math.random() - 0.45) * 0.12 : 0;
    return p * Math.exp(gauss() * s.vol * Math.sqrt(secs) + pull + shock);
  };
  // Backfill 6h at 5-second resolution (1s for the last 40s) so every candle size and the 30s
  // average are ready on load.
  for (const s of state) {
    let p = s.p;
    let last = now - 6 * 3600_000;
    for (let t = last; t <= now; t += t < now - 40_000 ? 5000 : 1000) {
      p = step(s, p, Math.max(1, (t - last) / 1000));
      last = t;
      prices.push(s.mint, { price: p, liquidity: s.liq * SOL, mcapSol: p * 1e9, ts: t });
    }
    s.p = p;
  }
  setInterval(() => {
    const ts = Date.now();
    for (const s of state) {
      s.p = step(s, s.p, 1);
      prices.push(s.mint, { price: s.p, liquidity: s.liq * SOL, mcapSol: s.p * 1e9, ts });
    }
  }, 1000);

  const bots = Array.from({ length: 14 }, (_, i) => `Bot${i}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx${i}`);
  for (const b of bots) if (engine.balance(b, "paper") < SOL) engine.creditDeposit(b, "paper", 5 * SOL, "demo");
  const act = () => {
    const b = bots[Math.floor(Math.random() * bots.length)];
    try {
      const open = engine.walletPositions(b, "paper", "open");
      if (open.length && Math.random() < 0.45) {
        engine.close(open[Math.floor(Math.random() * open.length)].id, b);
      } else {
        const c = state[Math.floor(Math.random() * (state.length - 1))];
        engine.open({ wallet: b, mode: "paper", mint: c.mint, side: Math.random() < 0.55 ? "short" : "long", leverage: [2, 5, 10][Math.floor(Math.random() * 3)], stake: Math.floor((0.02 + Math.random() * 0.4) * SOL) });
      }
      if (engine.balance(b, "paper") < 0.2 * SOL) engine.creditDeposit(b, "paper", 5 * SOL, "demo");
    } catch (e) {
      if (!(e instanceof TradeError)) console.error(e);
    }
  };
  // Seed the tape so every coin shows trades on load, then keep trading.
  for (let i = 0; i < 60; i++) act();
  setInterval(act, 900);

  // Bots also play the Arena, so rounds have pots on both sides.
  if (arena) {
    const bet = () => {
      const b = bots[Math.floor(Math.random() * bots.length)];
      const c = state[Math.floor(Math.random() * (state.length - 1))];
      try {
        arena.bet({ wallet: b, mode: "paper", mint: c.mint, side: Math.random() < 0.5 ? "up" : "down", amount: Math.floor((0.02 + Math.random() * 0.3) * SOL), start: arena.bettableStart() });
        if (engine.balance(b, "paper") < 0.2 * SOL) engine.creditDeposit(b, "paper", 5 * SOL, "demo");
      } catch (e) {
        if (!(e instanceof TradeError)) console.error(e);
      }
    };
    for (let i = 0; i < 40; i++) bet();
    setInterval(bet, 1500);
  }
}
