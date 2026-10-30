import type { Config, Mode } from "../config.js";
import type { PriceStore } from "../oracle/priceStore.js";
import { Engine, TradeError } from "./engine.js";
import { split } from "./pricing.js";

/**
 * Arena: up/down rounds on any coin, players against each other.
 *
 * Round `start` runs live from start to start + roundMs. Bets for it are taken in the round
 * before, up to lockBufferMs before it starts, so nobody bets after seeing the move. The lock and
 * close prices are averages over priceWindowMs ending at start and at the end. If close > lock the
 * Up side wins, otherwise Down. Winners split the whole pot pro rata after a fee; the pool never
 * takes a side. A round refunds in full if either side is empty, the price doesn't move, or the
 * price wasn't available at lock or close.
 *
 * Someone who can move the price (an insider dumping) can still win the round. What they win is
 * the other players' pot, which is capped by what those players chose to bet.
 */

export type ArenaSide = "up" | "down";

export interface RoundRow {
  mint: string;
  mode: Mode;
  start: number;
  up_pot: number;
  down_pot: number;
  lock_price: number | null;
  close_price: number | null;
  status: "open" | "settled" | "refunded";
  result: ArenaSide | null;
  fee: number;
  settled_at: number | null;
}

export class Arena {
  constructor(
    private engine: Engine,
    private prices: PriceStore,
    private cfg: Config,
    private now: () => number = Date.now,
  ) {}

  get roundMs() {
    return this.cfg.arena.roundMs;
  }

  /** The round currently accepting bets. */
  bettableStart(t = this.now()): number {
    const R = this.roundMs;
    let s = Math.floor(t / R) * R + R;
    if (s - t < this.cfg.arena.lockBufferMs) s += R;
    return s;
  }

  /** The round currently live (started, not ended). */
  liveStart(t = this.now()): number {
    return Math.floor(t / this.roundMs) * this.roundMs;
  }

  round(mint: string, mode: Mode, start: number): RoundRow | undefined {
    return this.engine.db.prepare("SELECT * FROM arena_rounds WHERE mint = ? AND mode = ? AND start = ?").get(mint, mode, start) as RoundRow | undefined;
  }

  /** Can this coin host a round right now? */
  eligible(mint: string): { ok: boolean; reason: string | null } {
    if (!this.cfg.arena.enabled) return { ok: false, reason: "arena_off" };
    if (!this.engine.market(mint)) return { ok: false, reason: "unknown_market" };
    const v = this.prices.view(mint);
    if (!v || this.now() - v.updatedAt > this.cfg.trading.staleMs) return { ok: false, reason: "no_price" };
    if (v.liquidity < this.cfg.arena.minLiquidity) return { ok: false, reason: "too_thin" };
    return { ok: true, reason: null };
  }

  bet(a: { wallet: string; mode: Mode; mint: string; side: ArenaSide; amount: number; start: number }) {
    const c = this.cfg.arena;
    this.engine.assertLive(a.mode);
    if (a.side !== "up" && a.side !== "down") throw new TradeError("bad_side", "Pick Up or Down");
    if (!Number.isSafeInteger(a.amount) || a.amount < c.minBet) throw new TradeError("too_small", `Minimum bet is ${c.minBet / this.cfg.LAMPORTS} SOL`);
    const bettable = this.bettableStart();
    if (a.start !== bettable) throw new TradeError("round_closed", "Betting on that round has closed. The next round is open.");
    const el = this.eligible(a.mint);
    if (!el.ok) throw new TradeError(el.reason ?? "not_eligible", el.reason === "too_thin" ? "This coin's liquidity is too thin for the Arena" : "Price unavailable right now");
    return this.engine.tx(() => {
      const mine = (
        this.engine.db
          .prepare("SELECT COALESCE(SUM(amount),0) AS s FROM arena_bets WHERE mint = ? AND mode = ? AND start = ? AND wallet = ?")
          .get(a.mint, a.mode, a.start, a.wallet) as { s: number }
      ).s;
      if (mine + a.amount > c.maxBetPerRound) throw new TradeError("too_large", `Max ${c.maxBetPerRound / this.cfg.LAMPORTS} SOL per round`);
      this.engine.addBalance(a.wallet, a.mode, -a.amount);
      this.engine.addBucket(a.mode, "arena_escrow", a.amount);
      this.engine.db.prepare("INSERT OR IGNORE INTO arena_rounds (mint, mode, start) VALUES (?, ?, ?)").run(a.mint, a.mode, a.start);
      const col = a.side === "up" ? "up_pot" : "down_pot";
      this.engine.db.prepare(`UPDATE arena_rounds SET ${col} = ${col} + ? WHERE mint = ? AND mode = ? AND start = ?`).run(a.amount, a.mint, a.mode, a.start);
      const info = this.engine.db
        .prepare("INSERT INTO arena_bets (mint, mode, start, wallet, side, amount, placed_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(a.mint, a.mode, a.start, a.wallet, a.side, a.amount, this.now());
      this.engine.event(a.mode, "arena_bet", a.wallet, a.mint, a.amount, Number(info.lastInsertRowid), { side: a.side, start: a.start });
      return { id: Number(info.lastInsertRowid), round: this.round(a.mint, a.mode, a.start)! };
    });
  }

  /** Lock prices for rounds that just started, settle rounds that ended. Run every second. */
  tick(): { locked: number; settled: number; refunded: number } {
    const now = this.now();
    const w = this.cfg.arena.priceWindowMs;
    const out = { locked: 0, settled: 0, refunded: 0 };
    const due = this.engine.db.prepare("SELECT * FROM arena_rounds WHERE status = 'open' AND start <= ?").all(now) as RoundRow[];
    for (const r of due) {
      const end = r.start + this.roundMs;
      if (r.lock_price === null) {
        // Lock as soon as the start has passed; give the oracle a few seconds to land a sample.
        const lock = this.prices.averageBetween(r.mint, r.start - w, r.start + 2000);
        if (lock !== null && lock > 0) {
          this.engine.db.prepare("UPDATE arena_rounds SET lock_price = ? WHERE mint = ? AND mode = ? AND start = ?").run(lock, r.mint, r.mode, r.start);
          r.lock_price = lock;
          out.locked++;
        } else if (now > r.start + 15_000) {
          this.refund(r, "no lock price");
          out.refunded++;
          continue;
        } else continue;
      }
      if (now < end + 2000) continue;
      const close = this.prices.averageBetween(r.mint, end - w, end + 2000);
      if (close === null || !(close > 0)) {
        if (now > end + 15_000) {
          this.refund(r, "no close price");
          out.refunded++;
        }
        continue;
      }
      if (this.settle(r, close)) out.settled++;
      else out.refunded++;
    }
    return out;
  }

  /** Returns true if settled with a winner, false if refunded. */
  settle(r: RoundRow, close: number): boolean {
    const lock = r.lock_price!;
    const moved = Math.abs(close / lock - 1) > 1e-9;
    if (!r.up_pot || !r.down_pot || !moved) {
      this.refund(r, !moved ? "price unchanged" : "one side empty", close);
      return false;
    }
    const result: ArenaSide = close > lock ? "up" : "down";
    this.engine.tx(() => {
      const cur = this.round(r.mint, r.mode, r.start);
      if (!cur || cur.status !== "open") return;
      const total = cur.up_pot + cur.down_pot;
      const winPot = result === "up" ? cur.up_pot : cur.down_pot;
      let fee = Math.floor((total * this.cfg.arena.feeBps) / 10_000);
      const distributable = total - fee;
      const bets = this.engine.db.prepare("SELECT * FROM arena_bets WHERE mint = ? AND mode = ? AND start = ?").all(r.mint, r.mode, r.start) as {
        id: number;
        wallet: string;
        side: ArenaSide;
        amount: number;
      }[];
      let paid = 0;
      const setPayout = this.engine.db.prepare("UPDATE arena_bets SET payout = ? WHERE id = ?");
      for (const b of bets) {
        const payout = b.side === result ? Math.floor((b.amount * distributable) / winPot) : 0;
        setPayout.run(payout, b.id);
        if (payout > 0) this.engine.addBalance(b.wallet, r.mode, payout);
        paid += payout;
      }
      // Rounding dust goes to the fee.
      fee += distributable - paid;
      const parts = split(fee, this.cfg.splits.arenaFee);
      this.engine.addBucket(r.mode, "arena_escrow", -total);
      this.engine.addBucket(r.mode, "pool_cash", parts.pool);
      this.engine.addBucket(r.mode, "holders_pot", parts.holders);
      this.engine.addBucket(r.mode, "treasury", parts.treasury);
      this.engine.db
        .prepare("UPDATE arena_rounds SET status = 'settled', close_price = ?, result = ?, fee = ?, settled_at = ? WHERE mint = ? AND mode = ? AND start = ?")
        .run(close, result, fee, this.now(), r.mint, r.mode, r.start);
      this.engine.event(r.mode, "arena_settle", null, r.mint, total, r.start, { result, lock, close, up: cur.up_pot, down: cur.down_pot, fee });
    });
    return true;
  }

  refund(r: RoundRow, why: string, close: number | null = null) {
    this.engine.tx(() => {
      const cur = this.round(r.mint, r.mode, r.start);
      if (!cur || cur.status !== "open") return;
      const bets = this.engine.db.prepare("SELECT * FROM arena_bets WHERE mint = ? AND mode = ? AND start = ?").all(r.mint, r.mode, r.start) as {
        id: number;
        wallet: string;
        amount: number;
      }[];
      const setPayout = this.engine.db.prepare("UPDATE arena_bets SET payout = ? WHERE id = ?");
      for (const b of bets) {
        setPayout.run(b.amount, b.id);
        this.engine.addBalance(b.wallet, r.mode, b.amount);
      }
      this.engine.addBucket(r.mode, "arena_escrow", -(cur.up_pot + cur.down_pot));
      this.engine.db
        .prepare("UPDATE arena_rounds SET status = 'refunded', close_price = ?, settled_at = ? WHERE mint = ? AND mode = ? AND start = ?")
        .run(close, this.now(), r.mint, r.mode, r.start);
      this.engine.event(r.mode, "arena_refund", null, r.mint, cur.up_pot + cur.down_pot, r.start, { why });
    });
  }

  /** Coins with a round that is accepting bets or live, so the oracle keeps their price hot. */
  activeMints(): string[] {
    const since = this.liveStart() - this.roundMs;
    return (this.engine.db.prepare("SELECT DISTINCT mint FROM arena_rounds WHERE status = 'open' OR start >= ?").all(since) as { mint: string }[]).map((r) => r.mint);
  }

  /** Everything the ticket needs for one coin. */
  view(mint: string, mode: Mode, wallet?: string) {
    const now = this.now();
    const bettable = this.bettableStart(now);
    const live = this.liveStart(now);
    const side = (start: number) => {
      const r = this.round(mint, mode, start);
      const mine = wallet
        ? (this.engine.db
            .prepare("SELECT side, COALESCE(SUM(amount),0) AS s FROM arena_bets WHERE mint = ? AND mode = ? AND start = ? AND wallet = ? GROUP BY side")
            .all(mint, mode, start, wallet) as { side: ArenaSide; s: number }[])
        : [];
      return {
        start,
        end: start + this.roundMs,
        upPot: r?.up_pot ?? 0,
        downPot: r?.down_pot ?? 0,
        lockPrice: r?.lock_price ?? null,
        status: r?.status ?? "open",
        myUp: mine.find((m) => m.side === "up")?.s ?? 0,
        myDown: mine.find((m) => m.side === "down")?.s ?? 0,
      };
    };
    const recent = this.engine.db
      .prepare("SELECT * FROM arena_rounds WHERE mint = ? AND mode = ? AND status != 'open' ORDER BY start DESC LIMIT 12")
      .all(mint, mode) as RoundRow[];
    const myHistory = wallet
      ? this.engine.db
          .prepare(
            "SELECT b.start, b.side, b.amount, b.payout, r.result, r.status FROM arena_bets b JOIN arena_rounds r ON r.mint = b.mint AND r.mode = b.mode AND r.start = b.start WHERE b.mint = ? AND b.mode = ? AND b.wallet = ? ORDER BY b.id DESC LIMIT 20",
          )
          .all(mint, mode, wallet)
      : [];
    const el = this.eligible(mint);
    return {
      enabled: this.cfg.arena.enabled,
      eligible: el.ok,
      reason: el.reason,
      now,
      roundMs: this.roundMs,
      lockBufferMs: this.cfg.arena.lockBufferMs,
      feeBps: this.cfg.arena.feeBps,
      minBet: this.cfg.arena.minBet,
      maxBetPerRound: this.cfg.arena.maxBetPerRound,
      next: side(bettable),
      live: side(live),
      recent: recent.map((r) => ({ start: r.start, status: r.status, result: r.result, lock: r.lock_price, close: r.close_price, upPot: r.up_pot, downPot: r.down_pot })),
      mine: myHistory,
    };
  }
}
