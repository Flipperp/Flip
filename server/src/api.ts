import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fs from "node:fs";
import path from "node:path";
import { PublicKey } from "@solana/web3.js";
import { z } from "zod";
import type { Config, Mode } from "./config.js";
import { Engine, TradeError, HOUSE, type Position, type MarketRow } from "./engine/engine.js";
import { Auth, AuthError } from "./auth.js";
import type { ChainOracle } from "./oracle/chainOracle.js";
import type { HolderRewards } from "./chain/holders.js";
import { fillPrice } from "./engine/pricing.js";
import type { HlLink } from "./hl/link.js";
import type { PumpFeed } from "./oracle/pumpFeed.js";
import type { Arena } from "./engine/arena.js";
import { riskMessage } from "./engine/engine.js";

export interface ApiDeps {
  cfg: Config;
  engine: Engine;
  auth: Auth;
  oracle: ChainOracle | null;
  rewards: HolderRewards | null;
  vault: string | null;
  status: () => Record<string, unknown>;
  solUsd: () => number;
  staticDir?: string;
  /** Hyperliquid route, when enabled. */
  hl?: HlLink | null;
  pumpFeed?: PumpFeed | null;
  arena?: Arena | null;
}

const modeSchema = z.enum(["real", "paper"]);
const lamports = z.number().int().positive().max(1_000_000 * 1e9);

const actionSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("open"),
    mode: modeSchema,
    mint: z.string().min(32).max(44),
    side: z.enum(["long", "short"]),
    leverage: z.number().int(),
    stake: lamports,
    origin: z.string().regex(/^(direct|fade:\d+|copy:\d+)$/).optional(),
  }),
  z.object({ action: z.literal("close"), id: z.number().int().positive() }),
  z.object({ action: z.literal("close_all"), mode: modeSchema }),
  z.object({ action: z.literal("pool_add"), mode: modeSchema, amount: lamports }),
  z.object({ action: z.literal("pool_remove"), mode: modeSchema, shares: z.number().int().positive() }),
  z.object({ action: z.literal("faucet") }),
  z.object({ action: z.literal("withdraw"), amount: lamports }),
  z.object({ action: z.literal("revoke_sessions") }),
  z.object({
    action: z.literal("arena_bet"),
    mode: modeSchema,
    mint: z.string().min(32).max(44),
    side: z.enum(["up", "down"]),
    amount: lamports,
    start: z.number().int().positive(),
  }),
]);

const short = (w: string) => (w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

class RateLimiter {
  private hits = new Map<string, { n: number; reset: number }>();
  constructor(private max: number, private windowMs: number) {}
  ok(key: string) {
    const now = Date.now();
    const h = this.hits.get(key);
    if (!h || h.reset < now) {
      this.hits.set(key, { n: 1, reset: now + this.windowMs });
      if (this.hits.size > 50_000) this.hits.clear();
      return true;
    }
    h.n++;
    return h.n <= this.max;
  }
}

export async function buildApi(d: ApiDeps): Promise<FastifyInstance> {
  const { cfg, engine } = d;
  const app = Fastify({ logger: false, bodyLimit: 32 * 1024, trustProxy: true });
  await app.register(cors, { origin: cfg.corsOrigin === "*" ? true : cfg.corsOrigin.split(",") });
  await app.register(websocket);

  const actionLimiter = new RateLimiter(30, 10_000);
  const resolveLimiter = new RateLimiter(10, 60_000);

  const parseMode = (q: any): Mode => (q?.mode === "real" ? "real" : "paper");

  const marketView = (m: MarketRow, mode: Mode) => {
    const st = engine.marketState(mode, m.mint);
    const p = st.price;
    return {
      mint: m.mint,
      symbol: m.symbol,
      name: m.name,
      image: m.image,
      venue: m.venue,
      addedAt: m.added_at,
      price: p?.live ?? null,
      twap: p?.twap ?? null,
      liquidity: p?.liquidity ?? null,
      mcapSol: p?.mcapSol ?? null,
      change1h: p?.change1h ?? null,
      updatedAt: p?.updatedAt ?? null,
      tradable: st.tradable && !engine.halted(mode) && (mode === "paper" || cfg.realEnabled),
      reason: st.reason,
      longOpen: st.longOpen,
      shortOpen: st.shortOpen,
      roomLong: st.roomLong,
      roomShort: st.roomShort,
      sideCap: st.sideCap,
      hl: d.hl?.view(m.mint) ?? null,
      risk: st.risk
        ? {
            poolOpen: st.risk.poolOpen,
            reason: st.risk.reason,
            message: st.risk.reason ? riskMessage(st.risk.reason, st.risk) : null,
            seasonedAt: st.risk.seasonedAt,
            young: st.risk.young,
            top10: st.risk.top10,
            liqDrop: st.risk.liqDrop,
            minHoldMs: st.risk.minHoldMs,
            twapMs: st.risk.twapMs,
          }
        : null,
    };
  };

  const positionView = (p: Position, includeWallet = true) => {
    const v = engine.view(p.mint);
    let mark: number | null = null;
    let upnl: number | null = null;
    if (p.status === "open" && v) {
      mark = fillPrice("close", p.side, v.live, v.twap, cfg.trading.spreadBps);
      upnl = engine.markPnl(p);
    }
    const m = engine.market(p.mint);
    return {
      id: p.id,
      wallet: includeWallet ? p.wallet : short(p.wallet),
      walletShort: short(p.wallet),
      mode: p.mode,
      mint: p.mint,
      symbol: m?.symbol ?? "",
      image: m?.image ?? "",
      side: p.side,
      leverage: p.leverage,
      stake: p.stake,
      entry: p.entry_price,
      openedAt: p.opened_at,
      status: p.status,
      exit: p.exit_price,
      closedAt: p.closed_at,
      pnl: p.status === "open" ? upnl : p.pnl,
      fee: p.fee,
      payout: p.payout,
      closeReason: p.close_reason,
      origin: p.origin,
      mark,
      // Prices where this auto-closes (approximate; actual triggers use averaged fills).
      maxWinAt: p.side === "long" ? p.entry_price * (1 + cfg.trading.maxWinMult / p.leverage) : p.entry_price * (1 - cfg.trading.maxWinMult / p.leverage),
      liquidationAt: p.side === "long" ? p.entry_price * (1 - 1 / p.leverage) : p.entry_price * (1 + 1 / p.leverage),
      canCloseAt: p.opened_at + cfg.trading.minHoldMs,
    };
  };

  const decorateEvent = (e: any) => {
    const m = e.mint ? engine.market(e.mint) : null;
    return { ...e, walletShort: e.wallet ? (e.wallet === HOUSE ? "house" : short(e.wallet)) : null, symbol: m?.symbol ?? null, image: m?.image ?? null };
  };

  // ---------- reads ----------

  app.get("/api/config", async () => ({
    brand: cfg.brand,
    tokenMint: cfg.tokenMint || null,
    vault: d.vault,
    realEnabled: cfg.realEnabled,
    leverages: cfg.trading.leverages,
    maxWinMult: cfg.trading.maxWinMult,
    spreadBps: cfg.trading.spreadBps,
    profitFeeBps: cfg.trading.profitFeeBps,
    minStake: cfg.trading.minStake,
    minHoldMs: cfg.trading.minHoldMs,
    minLiquidity: cfg.trading.minLiquidity,
    maxSidePerCoin: cfg.trading.maxSidePerCoin,
    twapWindowMs: cfg.trading.twapWindowMs,
    splits: cfg.splits,
    tiers: cfg.tiers,
    rebate: cfg.rebate,
    holders: { epochMs: cfg.holders.epochMs, payoutFrac: cfg.holders.payoutFrac, maxWeightSupplyFrac: cfg.holders.maxWeightSupplyFrac },
    paper: { faucetAmount: cfg.paper.faucetAmount, faucetCooldownMs: cfg.paper.faucetCooldownMs },
    custody: { minDeposit: cfg.custody.minDeposit, maxWithdrawal: cfg.custody.maxWithdrawal, dailyWithdrawalPerWallet: cfg.custody.dailyWithdrawalPerWallet },
    solUsd: d.solUsd(),
    halted: { real: engine.halted("real"), paper: engine.halted("paper") },
    arena: d.arena ? { enabled: cfg.arena.enabled, roundMs: cfg.arena.roundMs, priceWindowMs: cfg.arena.priceWindowMs, feeBps: cfg.arena.feeBps } : { enabled: false },
    risk: { seasonHours: cfg.risk.seasonHours, youngHours: cfg.risk.youngHours, top10Max: cfg.risk.top10Max, liqDropMax: cfg.risk.liqDropMax },
    hl: d.hl
      ? {
          enabled: true,
          testnet: cfg.hl.testnet,
          apiUrl: cfg.hl.apiUrl,
          // Only advertise the fee once Hyperliquid will accept it; otherwise orders would be rejected.
          builder: d.hl.builderReady() ? cfg.hl.builder : null,
          builderFee: d.hl.builderReady() ? cfg.hl.builderFee : 0,
          slippage: cfg.hl.slippage,
          maxDivergence: cfg.hl.maxDivergence,
        }
      : { enabled: false },
  }));

  app.get("/api/arena/:mint", async (req, reply) => {
    if (!d.arena) return { enabled: false };
    const { mint } = req.params as { mint: string };
    if (!engine.market(mint)) return reply.code(404).send({ error: "not_found" });
    const q = req.query as any;
    const wallet = typeof q.wallet === "string" && q.wallet.length >= 32 && q.wallet.length <= 44 ? q.wallet : undefined;
    d.oracle?.markHot(mint);
    return d.arena.view(mint, parseMode(q), wallet);
  });

  app.get("/api/new", async (req) => {
    const f = d.pumpFeed;
    if (!f) return { enabled: false, launches: [], graduations: [] };
    const limit = Math.min(200, Number((req.query as any)?.limit) || 100);
    const listed = (mint: string) => {
      const m = engine.market(mint);
      return m && m.listed === 1 ? true : false;
    };
    return {
      enabled: true,
      connected: f.connected,
      launches: f.recent(limit).map((p) => ({ ...p, listed: listed(p.mint) })),
      graduations: f.graduations(50).map((g) => {
        const m = engine.market(g.mint);
        return { ...g, listed: listed(g.mint), symbol: m?.symbol ?? null, name: m?.name ?? null, image: m?.image ?? null };
      }),
    };
  });

  app.get("/api/hl", async () => {
    if (!d.hl) return { enabled: false, links: [] };
    return {
      enabled: true,
      lastError: d.hl.lastError,
      lastPoll: d.hl.lastPoll,
      solMark: d.hl.solMark(),
      builder: cfg.hl.builder || null,
      builderValue: d.hl.builderValue,
      builderReady: d.hl.builderReady(),
      links: d.hl.all(),
    };
  });

  app.get("/api/markets", async (req) => {
    const mode = parseMode(req.query);
    const rows = engine.db.prepare("SELECT * FROM markets WHERE listed = 1").all() as MarketRow[];
    return rows.map((m) => marketView(m, mode));
  });

  app.get("/api/market/:mint", async (req, reply) => {
    const mode = parseMode(req.query);
    const { mint } = req.params as { mint: string };
    const m = engine.market(mint);
    if (!m) return reply.code(404).send({ error: "not_found" });
    engine.db.prepare("UPDATE markets SET last_viewed = ? WHERE mint = ?").run(Date.now(), mint);
    d.oracle?.markHot(mint);
    return {
      ...marketView(m, mode),
      history: engine.prices.history(mint),
      candles: engine.prices.candles(mint, String((req.query as any)?.tf ?? "1m")),
      recent: engine.prices.recent(mint).slice(-120),
      positions: engine.openPositions(mode, mint).map((p) => positionView(p, false)),
      reserve: engine.reserveFor(mode, mint),
    };
  });

  app.get("/api/candles/:mint", async (req) => {
    const { mint } = req.params as { mint: string };
    return engine.prices.candles(mint, String((req.query as any)?.tf ?? "1m"));
  });

  app.post("/api/market", async (req, reply) => {
    if (!resolveLimiter.ok(req.ip)) return reply.code(429).send({ error: "rate_limited", message: "Too many lookups, slow down" });
    const mint = String((req.body as any)?.mint ?? "").trim();
    try {
      new PublicKey(mint);
    } catch {
      return reply.code(400).send({ error: "bad_mint", message: "That isn't a valid contract address" });
    }
    if (!d.oracle) return reply.code(503).send({ error: "no_oracle", message: "Looking up new coins needs the live server. This demo has a fixed set of coins." });
    try {
      const m = await d.oracle.resolve(mint, { bornAt: d.pumpFeed?.launchedAt(mint) });
      return marketView(m, "paper");
    } catch (e: any) {
      return reply.code(422).send({ error: "unsupported", message: String(e?.message ?? e) });
    }
  });

  app.get("/api/pool", async (req) => {
    const mode = parseMode(req.query);
    const st = engine.poolState(mode);
    const mints = [...new Set(engine.openPositions(mode).map((p) => p.mint))];
    const exposure = mints
      .map((mint) => {
        const ps = engine.openPositions(mode, mint);
        const m = engine.market(mint);
        return {
          mint,
          symbol: m?.symbol ?? "",
          image: m?.image ?? "",
          long: ps.filter((p) => p.side === "long").reduce((a, p) => a + p.stake, 0),
          short: ps.filter((p) => p.side === "short").reduce((a, p) => a + p.stake, 0),
          reserve: engine.reserveFor(mode, mint),
          poolPnl: -ps.reduce((a, p) => a + engine.markPnl(p), 0),
        };
      })
      .sort((a, b) => b.reserve - a.reserve);
    const recent = engine.db
      .prepare("SELECT * FROM events WHERE mode = ? AND kind IN ('pool_add','pool_remove','creator_fee','holder_fund') ORDER BY id DESC LIMIT 20")
      .all(mode)
      .map(decorateEvent);
    const fees24h = (engine.db
      .prepare("SELECT COALESCE(SUM(fee),0) AS f, COALESCE(SUM(-pnl),0) AS p, COUNT(*) AS n FROM positions WHERE mode = ? AND status = 'closed' AND closed_at >= ?")
      .get(mode, Date.now() - 24 * 3600_000) as { f: number; p: number; n: number });
    return { ...st, exposure, recent, stats24h: { fees: fees24h.f, poolPnl: fees24h.p, trades: fees24h.n } };
  });

  app.get("/api/tape", async (req) => engine.tape(parseMode(req.query), 60).map(decorateEvent));

  app.get("/api/top", async (req) => {
    const q = req.query as any;
    const mode = parseMode(q);
    const window = q.window === "all" ? null : 24 * 3600_000;
    const by = q.by === "pct" ? "pct" : "sol";
    return engine.topTrades(mode, window, by, Math.min(50, Number(q.limit) || 10)).map((p) => positionView(p, false));
  });

  app.get("/api/me", async (req, reply) => {
    const q = req.query as any;
    const mode = parseMode(q);
    const wallet = String(q.wallet ?? "");
    try {
      new PublicKey(wallet);
    } catch {
      return reply.code(400).send({ error: "bad_wallet" });
    }
    const pool = engine.poolState(mode);
    const shares = engine.shares(wallet, mode);
    const open = engine.walletPositions(wallet, mode, "open").map((p) => positionView(p));
    const closed = engine.walletPositions(wallet, mode, "closed", 100).map((p) => positionView(p));
    const withdrawals = mode === "real" ? engine.db.prepare("SELECT id, amount, status, sig, error, created_at FROM withdrawals WHERE wallet = ? ORDER BY id DESC LIMIT 20").all(wallet) : [];
    const deposits = mode === "real" ? engine.db.prepare("SELECT sig, amount, ts FROM deposits WHERE wallet = ? AND kind = 'user' ORDER BY ts DESC LIMIT 20").all(wallet) : [];
    const claim = engine.db.prepare("SELECT last_claim FROM paper_claims WHERE wallet = ?").get(wallet) as { last_claim: number } | undefined;
    const realized = closed.reduce((a, p) => a + ((p.pnl ?? 0) - (p.fee ?? 0)), 0);
    return {
      wallet,
      mode,
      balance: engine.balance(wallet, mode),
      inTrades: open.reduce((a, p) => a + p.stake, 0),
      unrealized: open.reduce((a, p) => a + (p.pnl ?? 0), 0),
      realized,
      pool: { shares, value: pool.shares > 0 ? Math.floor((shares * Math.max(0, pool.nav)) / pool.shares) : 0, sharePrice: pool.sharePrice },
      tier: engine.tierFor(wallet),
      open,
      closed,
      withdrawals,
      deposits,
      nextFaucetAt: claim ? claim.last_claim + cfg.paper.faucetCooldownMs : 0,
    };
  });

  app.get("/api/holders", async (req) => {
    const wallet = (req.query as any)?.wallet as string | undefined;
    if (!d.rewards) return { enabled: false };
    const s = d.rewards.status(wallet);
    const top = engine.db
      .prepare("SELECT wallet, SUM(reward) AS reward, SUM(rebate) AS rebate FROM holder_rewards GROUP BY wallet ORDER BY reward + rebate DESC LIMIT 10")
      .all()
      .map((r: any) => ({ ...r, wallet: short(r.wallet) }));
    const epochs = engine.db.prepare("SELECT * FROM holder_epochs WHERE status = 'closed' ORDER BY id DESC LIMIT 14").all();
    return { enabled: true, ...s, top, epochs };
  });

  app.get("/api/status", async () => ({ ...d.status(), halted: { real: engine.halted("real"), paper: engine.halted("paper") } }));

  // ---------- writes ----------

  app.post("/api/session", async (req, reply) => {
    try {
      const v = d.auth.verify(req.body as any);
      if (v.payload?.action !== "session") throw new AuthError("Wrong action");
      return d.auth.createSession(v);
    } catch (e: any) {
      return reply.code(e instanceof AuthError ? 401 : 400).send({ error: "auth", message: e.message });
    }
  });

  app.post("/api/action", async (req, reply) => {
    let v;
    try {
      v = d.auth.verify(req.body as any);
    } catch (e: any) {
      return reply.code(401).send({ error: "auth", message: e.message });
    }
    if (!actionLimiter.ok(v.wallet)) return reply.code(429).send({ error: "rate_limited", message: "Slow down" });
    const parsed = actionSchema.safeParse(v.payload);
    if (!parsed.success) return reply.code(400).send({ error: "bad_request", message: parsed.error.issues[0]?.message ?? "Invalid request" });
    const a = parsed.data;
    try {
      switch (a.action) {
        case "open": {
          if (a.origin && a.origin !== "direct") {
            const [kind, ref] = a.origin.split(":");
            const src = engine.position(Number(ref));
            if (!src || src.mint !== a.mint || src.mode !== a.mode) throw new TradeError("bad_origin", "Original trade not found");
            const wantSide = kind === "fade" ? (src.side === "long" ? "short" : "long") : src.side;
            if (a.side !== wantSide) throw new TradeError("bad_origin", `A ${kind} must be ${wantSide}`);
          }
          const p = engine.open({ wallet: v.wallet, mode: a.mode, mint: a.mint, side: a.side, leverage: a.leverage, stake: a.stake, origin: a.origin });
          return { ok: true, position: positionView(p) };
        }
        case "close": {
          const p = engine.close(a.id, v.wallet, "manual");
          return { ok: true, position: positionView(p) };
        }
        case "close_all": {
          const out = [];
          const errors = [];
          for (const p of engine.walletPositions(v.wallet, a.mode, "open")) {
            try {
              out.push(positionView(engine.close(p.id, v.wallet, "manual")));
            } catch (e: any) {
              errors.push({ id: p.id, message: e.message });
            }
          }
          return { ok: true, closed: out, errors };
        }
        case "pool_add":
          return { ok: true, ...engine.poolDeposit(v.wallet, a.mode, a.amount) };
        case "pool_remove":
          return { ok: true, ...engine.poolWithdraw(v.wallet, a.mode, a.shares) };
        case "faucet":
          return { ok: true, ...engine.claimPaper(v.wallet) };
        case "withdraw": {
          if (v.viaSession) throw new AuthError("Withdrawals must be signed by your wallet");
          const id = engine.requestWithdrawal(v.wallet, a.amount);
          return { ok: true, id };
        }
        case "revoke_sessions":
          d.auth.revokeSessions(v.wallet);
          return { ok: true };
        case "arena_bet": {
          if (!d.arena) throw new TradeError("arena_off", "The Arena is off");
          const r = d.arena.bet({ wallet: v.wallet, mode: a.mode, mint: a.mint, side: a.side, amount: a.amount, start: a.start });
          return { ok: true, id: r.id };
        }
      }
    } catch (e: any) {
      if (e instanceof TradeError) return reply.code(400).send({ error: e.code, message: e.message });
      if (e instanceof AuthError) return reply.code(401).send({ error: "auth", message: e.message });
      console.error(e);
      return reply.code(500).send({ error: "internal", message: "Something went wrong" });
    }
  });

  // ---------- admin ----------

  app.post("/api/admin/:op", async (req, reply) => {
    if (!cfg.adminKey || req.headers["x-admin-key"] !== cfg.adminKey) return reply.code(403).send({ error: "forbidden" });
    const { op } = req.params as { op: string };
    const b = (req.body ?? {}) as any;
    const mode: Mode = b.mode === "paper" ? "paper" : "real";
    try {
      switch (op) {
        case "halt":
          engine.halt(mode, String(b.reason ?? "admin"));
          return { ok: true };
        case "resume":
          engine.resume(mode);
          return { ok: true };
        case "close":
          return { ok: true, position: engine.close(Number(b.id), null, "admin") };
        case "close_market": {
          const ids = engine.openPositions(mode, String(b.mint)).map((p) => engine.close(p.id, null, "admin").id);
          return { ok: true, ids };
        }
        case "delist":
          engine.db.prepare("UPDATE markets SET listed = 0 WHERE mint = ?").run(String(b.mint));
          return { ok: true };
        case "list":
          engine.db.prepare("UPDATE markets SET listed = 1 WHERE mint = ?").run(String(b.mint));
          return { ok: true };
        case "treasury_to":
          engine.treasuryWithdraw(mode, Number(b.amount), String(b.wallet));
          return { ok: true };
        case "close_epoch":
          return { ok: true, result: d.rewards?.closeEpoch() ?? null };
        case "book":
          return { real: engine.conservation("real"), paper: engine.conservation("paper"), status: d.status() };
        default:
          return reply.code(404).send({ error: "unknown_op" });
      }
    } catch (e: any) {
      return reply.code(400).send({ error: "failed", message: e.message });
    }
  });

  // ---------- websocket ----------

  const clients = new Set<{ send: (s: string) => void; mode: Mode; readyState: number }>();
  app.get("/ws", { websocket: true }, (socket, req) => {
    const mode = parseMode(req.query);
    const c = socket as any;
    c.mode = mode;
    clients.add(c);
    socket.on("message", (raw: Buffer) => {
      try {
        const m = JSON.parse(raw.toString());
        if (m.mode === "real" || m.mode === "paper") c.mode = m.mode;
        if (typeof m.watch === "string" && engine.market(m.watch)) {
          engine.db.prepare("UPDATE markets SET last_viewed = ? WHERE mint = ?").run(Date.now(), m.watch);
          d.oracle?.markHot(m.watch);
        }
      } catch {
        /* ignore */
      }
    });
    socket.on("close", () => clients.delete(c));
  });

  const broadcast = (mode: Mode | null, msg: object) => {
    const s = JSON.stringify(msg);
    for (const c of clients) if ((mode === null || c.mode === mode) && c.readyState === 1) c.send(s);
  };

  engine.on("event", (e) => broadcast(e.mode, { type: "event", event: decorateEvent(e) }));
  engine.on("halt", (h) => broadcast(null, { type: "halt", ...h }));

  const priceTimer = setInterval(() => {
    if (clients.size === 0) return;
    const rows = engine.db.prepare("SELECT * FROM markets WHERE listed = 1").all() as MarketRow[];
    for (const mode of ["real", "paper"] as Mode[]) {
      if (![...clients].some((c) => c.mode === mode)) continue;
      const pool = engine.poolState(mode);
      broadcast(mode, {
        type: "tick",
        ts: Date.now(),
        solUsd: d.solUsd(),
        pool: { cash: pool.cash, nav: pool.nav, sharePrice: pool.sharePrice, outOnTrades: pool.outOnTrades, free: pool.free },
        markets: rows.map((m) => {
          const v = marketView(m, mode);
          return { mint: v.mint, price: v.price, twap: v.twap, liquidity: v.liquidity, mcapSol: v.mcapSol, change1h: v.change1h, tradable: v.tradable, reason: v.reason, longOpen: v.longOpen, shortOpen: v.shortOpen, roomLong: v.roomLong, roomShort: v.roomShort, hl: v.hl, risk: v.risk };
        }),
      });
    }
  }, 1000);
  app.addHook("onClose", async () => clearInterval(priceTimer));

  // ---------- static frontend ----------
  if (d.staticDir && fs.existsSync(d.staticDir)) {
    await app.register(fastifyStatic, { root: path.resolve(d.staticDir), wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api") || req.url.startsWith("/ws")) return reply.code(404).send({ error: "not_found" });
      return reply.sendFile("index.html");
    });
  }

  return app;
}
