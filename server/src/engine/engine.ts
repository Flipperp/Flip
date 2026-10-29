import { EventEmitter } from "node:events";
import type { DB } from "../db.js";
import { kvGet, kvSet } from "../db.js";
import type { Config, Mode } from "../config.js";
import type { PriceStore, PriceView } from "../oracle/priceStore.js";
import { fillPrice, positionPnl, profitFee, returnRatio, split, worstCasePayout, type Side } from "./pricing.js";

export class TradeError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export type Bucket = "pool_cash" | "holders_pot" | "treasury" | "locked" | "pending_withdrawals" | "external_in" | "external_out";
const BUCKETS: Bucket[] = ["pool_cash", "holders_pot", "treasury", "locked", "pending_withdrawals", "external_in", "external_out"];

export interface Position {
  id: number;
  wallet: string;
  mode: Mode;
  mint: string;
  side: Side;
  leverage: number;
  stake: number;
  entry_price: number;
  opened_at: number;
  status: "open" | "closed";
  exit_price: number | null;
  closed_at: number | null;
  pnl: number | null;
  fee: number | null;
  payout: number | null;
  close_reason: string | null;
  origin: string;
  tier: number;
}

export interface MarketRow {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  venue: string;
  source: string;
  supply: number;
  decimals: number;
  added_at: number;
  last_viewed: number;
  listed: number;
}

export interface OpenArgs {
  wallet: string;
  mode: Mode;
  mint: string;
  side: Side;
  leverage: number;
  stake: number;
  origin?: string;
}

export const HOUSE = "house";

export class Engine extends EventEmitter {
  constructor(
    public db: DB,
    public prices: PriceStore,
    public cfg: Config,
    public now: () => number = Date.now,
  ) {
    super();
    this.setMaxListeners(100);
    for (const mode of ["real", "paper"] as Mode[]) {
      for (const b of BUCKETS) db.prepare("INSERT OR IGNORE INTO book (mode, bucket, amount) VALUES (?, ?, 0)").run(mode, b);
    }
    if (!kvGet(db, "paper_seeded")) {
      this.tx(() => {
        this.addBucket("paper", "external_in", cfg.paper.seedPool);
        this.addBucket("paper", "pool_cash", cfg.paper.seedPool);
        this.addShares(HOUSE, "paper", cfg.paper.seedPool);
        kvSet(db, "paper_seeded", "1");
      });
    }
  }

  // ---------- primitives ----------

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  bucket(mode: Mode, b: Bucket): number {
    return (this.db.prepare("SELECT amount FROM book WHERE mode = ? AND bucket = ?").get(mode, b) as { amount: number }).amount;
  }

  book(mode: Mode): Record<Bucket, number> {
    const rows = this.db.prepare("SELECT bucket, amount FROM book WHERE mode = ?").all(mode) as { bucket: Bucket; amount: number }[];
    const out = {} as Record<Bucket, number>;
    for (const r of rows) out[r.bucket] = r.amount;
    return out;
  }

  private addBucket(mode: Mode, b: Bucket, delta: number) {
    if (!Number.isSafeInteger(delta)) throw new Error(`non-integer bucket delta ${delta}`);
    this.db.prepare("UPDATE book SET amount = amount + ? WHERE mode = ? AND bucket = ?").run(delta, mode, b);
  }

  balance(wallet: string, mode: Mode): number {
    const r = this.db.prepare("SELECT balance FROM accounts WHERE wallet = ? AND mode = ?").get(wallet, mode) as { balance: number } | undefined;
    return r?.balance ?? 0;
  }

  private addBalance(wallet: string, mode: Mode, delta: number) {
    if (!Number.isSafeInteger(delta)) throw new Error(`non-integer balance delta ${delta}`);
    this.db.prepare("INSERT OR IGNORE INTO accounts (wallet, mode, balance) VALUES (?, ?, 0)").run(wallet, mode);
    const r = this.db.prepare("UPDATE accounts SET balance = balance + ? WHERE wallet = ? AND mode = ? AND balance + ? >= 0").run(delta, wallet, mode, delta);
    if (r.changes !== 1) throw new TradeError("insufficient_balance", "Not enough balance");
  }

  shares(wallet: string, mode: Mode): number {
    const r = this.db.prepare("SELECT shares FROM pool_shares WHERE wallet = ? AND mode = ?").get(wallet, mode) as { shares: number } | undefined;
    return r?.shares ?? 0;
  }

  totalShares(mode: Mode): number {
    return (this.db.prepare("SELECT COALESCE(SUM(shares), 0) AS s FROM pool_shares WHERE mode = ?").get(mode) as { s: number }).s;
  }

  private addShares(wallet: string, mode: Mode, delta: number) {
    this.db.prepare("INSERT OR IGNORE INTO pool_shares (wallet, mode, shares) VALUES (?, ?, 0)").run(wallet, mode);
    const r = this.db.prepare("UPDATE pool_shares SET shares = shares + ? WHERE wallet = ? AND mode = ? AND shares + ? >= 0").run(delta, wallet, mode, delta);
    if (r.changes !== 1) throw new TradeError("insufficient_shares", "Not enough pool shares");
  }

  private event(mode: Mode, kind: string, wallet: string | null, mint: string | null, amount: number, ref?: string | number, data?: object) {
    const ts = this.now();
    const info = this.db
      .prepare("INSERT INTO events (ts, mode, kind, wallet, mint, amount, ref, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ts, mode, kind, wallet, mint, amount, ref === undefined ? null : String(ref), data ? JSON.stringify(data) : null);
    const ev = { id: Number(info.lastInsertRowid), ts, mode, kind, wallet, mint, amount, ref: ref ?? null, data: data ?? null };
    // Emit after commit so listeners never see rolled-back state.
    queueMicrotask(() => this.emit("event", ev));
    return ev;
  }

  // ---------- halts ----------

  halted(mode: Mode): string | null {
    return kvGet(this.db, `halt:${mode}`) || null;
  }

  halt(mode: Mode, reason: string) {
    kvSet(this.db, `halt:${mode}`, reason);
    this.emit("halt", { mode, reason });
  }

  resume(mode: Mode) {
    this.db.prepare("DELETE FROM kv WHERE k = ?").run(`halt:${mode}`);
    this.emit("halt", { mode, reason: null });
  }

  private assertLive(mode: Mode) {
    if (mode === "real" && !this.cfg.realEnabled) throw new TradeError("real_disabled", "Real trading is not enabled");
    const h = this.halted(mode);
    if (h) throw new TradeError("halted", `Trading is paused: ${h}`);
  }

  // ---------- markets ----------

  market(mint: string): MarketRow | undefined {
    return this.db.prepare("SELECT * FROM markets WHERE mint = ?").get(mint) as MarketRow | undefined;
  }

  openPositions(mode: Mode, mint?: string): Position[] {
    return (mint
      ? this.db.prepare("SELECT * FROM positions WHERE status = 'open' AND mode = ? AND mint = ?").all(mode, mint)
      : this.db.prepare("SELECT * FROM positions WHERE status = 'open' AND mode = ?").all(mode)) as Position[];
  }

  allOpenPositions(): Position[] {
    return this.db.prepare("SELECT * FROM positions WHERE status = 'open'").all() as Position[];
  }

  position(id: number): Position | undefined {
    return this.db.prepare("SELECT * FROM positions WHERE id = ?").get(id) as Position | undefined;
  }

  /** Pool's worst-case payout across all coins. */
  reserve(mode: Mode): number {
    const byMint = new Map<string, Position[]>();
    for (const p of this.openPositions(mode)) {
      const arr = byMint.get(p.mint) ?? [];
      arr.push(p);
      byMint.set(p.mint, arr);
    }
    let total = 0;
    for (const arr of byMint.values()) total += worstCasePayout(arr, this.cfg.trading.maxWinMult);
    return total;
  }

  reserveFor(mode: Mode, mint: string): number {
    return worstCasePayout(this.openPositions(mode, mint), this.cfg.trading.maxWinMult);
  }

  /** Unrealized trader P&L at current close fills (what the pool owes if everyone closed now). */
  unrealized(mode: Mode): number {
    let total = 0;
    for (const p of this.openPositions(mode)) total += this.markPnl(p);
    return total;
  }

  markPnl(p: Position): number {
    const v = this.prices.view(p.mint);
    if (!v) return 0;
    const exit = fillPrice("close", p.side, v.live, v.twap, this.cfg.trading.spreadBps);
    return positionPnl(p, exit, this.cfg.trading.maxWinMult);
  }

  sideCap(mode: Mode, v: PriceView): number {
    const t = this.cfg.trading;
    return Math.max(
      0,
      Math.floor(Math.min(t.maxSidePerCoin, v.liquidity * t.sideCapLiquidityFrac, this.bucket(mode, "pool_cash") * t.sideCapPoolFrac)),
    );
  }

  marketState(mode: Mode, mint: string) {
    const v = this.prices.view(mint);
    const open = this.openPositions(mode, mint);
    const longOpen = open.filter((p) => p.side === "long").reduce((a, p) => a + p.stake, 0);
    const shortOpen = open.filter((p) => p.side === "short").reduce((a, p) => a + p.stake, 0);
    const tradable = !!v && v.ready && v.liquidity >= this.cfg.trading.minLiquidity;
    const cap = v ? this.sideCap(mode, v) : 0;
    return {
      price: v,
      tradable,
      reason: !v ? "no_price" : !v.ready ? "warming_up" : v.liquidity < this.cfg.trading.minLiquidity ? "too_thin" : null,
      longOpen,
      shortOpen,
      sideCap: cap,
      roomLong: tradable ? Math.max(0, cap - longOpen) : 0,
      roomShort: tradable ? Math.max(0, cap - shortOpen) : 0,
      openCount: open.length,
    };
  }

  // ---------- tiers ----------

  tierFor(wallet: string): number {
    const r = this.db.prepare("SELECT balance, twab FROM holder_balances WHERE wallet = ?").get(wallet) as { balance: number; twab: number } | undefined;
    if (!r) return 0;
    // Use the lower of current balance and the epoch's time-weighted balance so buying right
    // before a trade (or selling right after) can't game the tier.
    const eff = Math.min(r.balance, r.twab);
    let tier = 0;
    this.cfg.tiers.forEach((t, i) => {
      if (eff >= t.minTokens) tier = i;
    });
    return tier;
  }

  // ---------- trading ----------

  open(a: OpenArgs): Position {
    const t = this.cfg.trading;
    this.assertLive(a.mode);
    if (!t.leverages.includes(a.leverage)) throw new TradeError("bad_leverage", `Leverage must be one of ${t.leverages.join(", ")}`);
    if (a.side !== "long" && a.side !== "short") throw new TradeError("bad_side", "Side must be long or short");
    if (!Number.isSafeInteger(a.stake) || a.stake < t.minStake) throw new TradeError("too_small", `Minimum is ${t.minStake / this.cfg.LAMPORTS} SOL`);
    if (!this.market(a.mint)) throw new TradeError("unknown_market", "Market not found");

    return this.tx(() => {
      const st = this.marketState(a.mode, a.mint);
      if (!st.tradable || !st.price) throw new TradeError(st.reason ?? "not_tradable", st.reason === "too_thin" ? "Liquidity too thin to open" : "Price not ready yet");
      const room = a.side === "long" ? st.roomLong : st.roomShort;
      if (a.stake > room) throw new TradeError("size_cap", `Only ${(room / this.cfg.LAMPORTS).toFixed(3)} SOL of room left on this side`);
      const openCount = (this.db.prepare("SELECT COUNT(*) AS n FROM positions WHERE wallet = ? AND mode = ? AND status = 'open'").get(a.wallet, a.mode) as { n: number }).n;
      if (openCount >= t.maxOpenPerWallet) throw new TradeError("too_many", "Too many open positions");

      const v = st.price;
      const entry = fillPrice("open", a.side, v.live, v.twap, t.spreadBps);
      const candidate = { side: a.side, leverage: a.leverage, stake: a.stake, entry_price: entry };
      const before = this.reserveFor(a.mode, a.mint);
      const after = worstCasePayout([...this.openPositions(a.mode, a.mint), candidate], t.maxWinMult);
      const totalReserve = this.reserve(a.mode) - before + after;
      if (totalReserve > this.bucket(a.mode, "pool_cash")) throw new TradeError("pool_full", "The pool can't cover this trade's max win right now");

      this.addBalance(a.wallet, a.mode, -a.stake);
      this.addBucket(a.mode, "locked", a.stake);
      const tier = this.tierFor(a.wallet);
      const info = this.db
        .prepare(
          "INSERT INTO positions (wallet, mode, mint, side, leverage, stake, entry_price, opened_at, origin, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run(a.wallet, a.mode, a.mint, a.side, a.leverage, a.stake, entry, this.now(), a.origin ?? "direct", tier);
      const pos = this.position(Number(info.lastInsertRowid))!;
      this.event(a.mode, "open", a.wallet, a.mint, a.stake, pos.id, { side: a.side, leverage: a.leverage, entry, origin: pos.origin });
      return pos;
    });
  }

  /** Close at current fill. Manual closes respect the minimum hold time. */
  close(id: number, wallet: string | null, reason: "manual" | "max_win" | "liquidated" | "admin" = "manual"): Position {
    const t = this.cfg.trading;
    return this.tx(() => {
      const p = this.position(id);
      if (!p || p.status !== "open") throw new TradeError("not_open", "Position is not open");
      if (wallet !== null && p.wallet !== wallet) throw new TradeError("not_owner", "Not your position");
      if (reason === "manual") {
        if (this.halted(p.mode)) throw new TradeError("halted", "Trading is paused");
        if (this.now() - p.opened_at < t.minHoldMs) throw new TradeError("min_hold", `Positions can close after ${t.minHoldMs / 1000}s`);
      }
      const v = this.prices.view(p.mint);
      const fresh = v && this.now() - v.updatedAt <= t.staleMs;
      if (!v || !fresh) throw new TradeError("stale_price", "Price unavailable, try again shortly");
      const exit = fillPrice("close", p.side, v.live, v.twap, t.spreadBps);
      let pnl = positionPnl(p, exit, t.maxWinMult);
      if (reason === "max_win") pnl = Math.floor(p.stake * t.maxWinMult);
      if (reason === "liquidated") pnl = -p.stake;

      // Fee tier is the lower of the tier at open and now (can't upgrade by buying mid-trade).
      const tierNow = Math.min(p.tier, this.tierFor(p.wallet));
      const discount = (this.cfg.tiers[tierNow] ?? this.cfg.tiers[0]).feeDiscountBps;
      const fee = profitFee(pnl, t.profitFeeBps, discount);
      const payout = p.stake + pnl - fee;
      const parts = split(fee, this.cfg.splits.profitFee);

      this.addBucket(p.mode, "locked", -p.stake);
      this.addBucket(p.mode, "pool_cash", -pnl + parts.pool);
      this.addBucket(p.mode, "holders_pot", parts.holders);
      this.addBucket(p.mode, "treasury", parts.treasury);
      if (payout > 0) this.addBalance(p.wallet, p.mode, payout);

      this.db
        .prepare("UPDATE positions SET status = 'closed', exit_price = ?, closed_at = ?, pnl = ?, fee = ?, payout = ?, close_reason = ? WHERE id = ?")
        .run(exit, this.now(), pnl, fee, payout, reason, id);
      const kind = reason === "manual" || reason === "admin" ? "close" : reason;
      this.event(p.mode, kind, p.wallet, p.mint, pnl - fee, p.id, { side: p.side, leverage: p.leverage, stake: p.stake, exit, fee });
      return this.position(id)!;
    });
  }

  /** Auto-close positions that hit max win or full loss. Returns closed ids. */
  tick(): number[] {
    const t = this.cfg.trading;
    const closed: number[] = [];
    for (const p of this.allOpenPositions()) {
      const v = this.prices.view(p.mint);
      if (!v || this.now() - v.updatedAt > t.staleMs) continue;
      const exit = fillPrice("close", p.side, v.live, v.twap, t.spreadBps);
      const r = returnRatio(p.side, p.leverage, p.entry_price, exit, t.maxWinMult);
      let reason: "max_win" | "liquidated" | null = null;
      if (r >= t.maxWinMult) reason = "max_win";
      else if (r <= -1) reason = "liquidated";
      if (!reason) continue;
      try {
        this.close(p.id, null, reason);
        closed.push(p.id);
      } catch (e) {
        this.emit("error", e);
      }
    }
    return closed;
  }

  // ---------- pool ----------

  poolNav(mode: Mode): number {
    return this.bucket(mode, "pool_cash") - this.unrealized(mode);
  }

  poolState(mode: Mode) {
    const cash = this.bucket(mode, "pool_cash");
    const nav = this.poolNav(mode);
    const shares = this.totalShares(mode);
    const reserve = this.reserve(mode);
    const holders = (this.db.prepare("SELECT COUNT(*) AS n FROM pool_shares WHERE mode = ? AND shares > 0 AND wallet != ?").get(mode, HOUSE) as { n: number }).n;
    const outOnTrades = this.bucket(mode, "locked");
    return {
      cash,
      nav,
      shares,
      sharePrice: shares > 0 ? nav / shares : 1,
      reserve,
      free: Math.max(0, cash - reserve),
      outOnTrades,
      holders,
    };
  }

  poolDeposit(wallet: string, mode: Mode, amount: number) {
    this.assertLive(mode);
    if (!Number.isSafeInteger(amount) || amount < this.cfg.trading.minStake) throw new TradeError("too_small", "Amount too small");
    return this.tx(() => {
      const total = this.totalShares(mode);
      const nav = this.poolNav(mode);
      if (total > 0 && nav <= 0) throw new TradeError("pool_underwater", "Pool can't take deposits right now");
      const minted = total === 0 ? amount : Math.floor((amount * total) / nav);
      if (minted <= 0) throw new TradeError("too_small", "Amount too small");
      this.addBalance(wallet, mode, -amount);
      this.addBucket(mode, "pool_cash", amount);
      this.addShares(wallet, mode, minted);
      this.event(mode, "pool_add", wallet, null, amount, undefined, { shares: minted });
      return { shares: minted };
    });
  }

  poolWithdraw(wallet: string, mode: Mode, shares: number) {
    this.assertLive(mode);
    if (!Number.isSafeInteger(shares) || shares <= 0) throw new TradeError("bad_amount", "Invalid share amount");
    return this.tx(() => {
      const total = this.totalShares(mode);
      const nav = this.poolNav(mode);
      if (shares > this.shares(wallet, mode)) throw new TradeError("insufficient_shares", "Not enough pool shares");
      const amount = Math.floor((shares * Math.max(0, nav)) / total);
      const cash = this.bucket(mode, "pool_cash");
      if (cash - amount < this.reserve(mode)) throw new TradeError("pool_locked", "That much is backing open trades right now. Try a smaller amount or wait.");
      this.addShares(wallet, mode, -shares);
      this.addBucket(mode, "pool_cash", -amount);
      if (amount > 0) this.addBalance(wallet, mode, amount);
      this.event(mode, "pool_remove", wallet, null, amount, undefined, { shares });
      return { amount };
    });
  }

  // ---------- external flows ----------

  creditDeposit(wallet: string, mode: Mode, amount: number, ref: string) {
    this.tx(() => {
      this.addBucket(mode, "external_in", amount);
      this.addBalance(wallet, mode, amount);
      this.event(mode, "deposit", wallet, null, amount, ref);
    });
  }

  /** Creator fees from the project token, split between pool, holders and treasury. */
  creditCreatorFee(amount: number, ref: string) {
    this.tx(() => {
      const parts = split(amount, this.cfg.splits.creatorFee);
      this.addBucket("real", "external_in", amount);
      this.addBucket("real", "pool_cash", parts.pool);
      this.addBucket("real", "holders_pot", parts.holders);
      this.addBucket("real", "treasury", parts.treasury);
      this.event("real", "creator_fee", null, null, amount, ref, parts);
    });
  }

  claimPaper(wallet: string) {
    const now = this.now();
    return this.tx(() => {
      const r = this.db.prepare("SELECT last_claim FROM paper_claims WHERE wallet = ?").get(wallet) as { last_claim: number } | undefined;
      if (r && now - r.last_claim < this.cfg.paper.faucetCooldownMs) {
        throw new TradeError("cooldown", `Next claim in ${Math.ceil((this.cfg.paper.faucetCooldownMs - (now - r.last_claim)) / 3600_000)}h`);
      }
      this.db.prepare("INSERT INTO paper_claims (wallet, last_claim) VALUES (?, ?) ON CONFLICT(wallet) DO UPDATE SET last_claim = excluded.last_claim").run(wallet, now);
      this.addBucket("paper", "external_in", this.cfg.paper.faucetAmount);
      this.addBalance(wallet, "paper", this.cfg.paper.faucetAmount);
      this.event("paper", "faucet", wallet, null, this.cfg.paper.faucetAmount);
      return { amount: this.cfg.paper.faucetAmount };
    });
  }

  requestWithdrawal(wallet: string, amount: number): number {
    const c = this.cfg.custody;
    if (!this.cfg.realEnabled) throw new TradeError("real_disabled", "Real mode is not enabled");
    if (this.halted("real")) throw new TradeError("halted", "Withdrawals are paused while the book is checked");
    if (!Number.isSafeInteger(amount) || amount < c.minDeposit) throw new TradeError("too_small", "Amount too small");
    if (amount > c.maxWithdrawal) throw new TradeError("too_large", `Max ${c.maxWithdrawal / this.cfg.LAMPORTS} SOL per withdrawal`);
    return this.tx(() => {
      const since = this.now() - 24 * 3600_000;
      const used = (this.db.prepare("SELECT COALESCE(SUM(amount),0) AS s FROM withdrawals WHERE wallet = ? AND created_at >= ? AND status != 'failed'").get(wallet, since) as { s: number }).s;
      if (used + amount > c.dailyWithdrawalPerWallet) throw new TradeError("daily_limit", "Daily withdrawal limit reached");
      this.addBalance(wallet, "real", -amount);
      this.addBucket("real", "pending_withdrawals", amount);
      const now = this.now();
      const info = this.db
        .prepare("INSERT INTO withdrawals (wallet, amount, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)")
        .run(wallet, amount, now, now);
      const id = Number(info.lastInsertRowid);
      this.event("real", "withdraw_request", wallet, null, amount, id);
      return id;
    });
  }

  /** Withdrawal landed on-chain. networkFee is paid by the vault and charged to treasury. */
  settleWithdrawal(id: number, sig: string, networkFee: number) {
    this.tx(() => {
      const w = this.db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(id) as { wallet: string; amount: number; status: string } | undefined;
      if (!w || w.status === "sent" || w.status === "failed") return;
      this.addBucket("real", "pending_withdrawals", -w.amount);
      this.addBucket("real", "external_out", w.amount + networkFee);
      this.chargeOps("real", networkFee);
      this.db.prepare("UPDATE withdrawals SET status = 'sent', sig = ?, updated_at = ? WHERE id = ?").run(sig, this.now(), id);
      this.event("real", "withdraw", w.wallet, null, w.amount, sig);
    });
  }

  failWithdrawal(id: number, error: string) {
    this.tx(() => {
      const w = this.db.prepare("SELECT * FROM withdrawals WHERE id = ?").get(id) as { wallet: string; amount: number; status: string } | undefined;
      if (!w || w.status === "sent" || w.status === "failed") return;
      this.addBucket("real", "pending_withdrawals", -w.amount);
      this.addBalance(w.wallet, "real", w.amount);
      this.db.prepare("UPDATE withdrawals SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").run(error, this.now(), id);
      this.event("real", "withdraw_failed", w.wallet, null, w.amount, id, { error });
    });
  }

  /** Network fees for operations paid by the vault (withdrawals, sweeps). Treasury first, then pool. */
  chargeOps(mode: Mode, fee: number) {
    if (fee <= 0) return;
    const tre = Math.max(0, this.bucket(mode, "treasury"));
    const fromTreasury = Math.min(tre, fee);
    this.addBucket(mode, "treasury", -fromTreasury);
    this.addBucket(mode, "pool_cash", -(fee - fromTreasury));
  }

  /** Record a vault-paid network fee not tied to a withdrawal. */
  recordNetworkFee(mode: Mode, fee: number, ref: string) {
    this.tx(() => {
      this.addBucket(mode, "external_out", fee);
      this.chargeOps(mode, fee);
      this.event(mode, "network_fee", null, null, fee, ref);
    });
  }

  /** Pay from the holders pot to a wallet's balance (rewards and rebates). */
  payFromHolders(wallet: string, amount: number, kind: "reward" | "rebate", ref: string) {
    if (amount <= 0) return;
    this.addBucket("real", "holders_pot", -amount);
    this.addBalance(wallet, "real", amount);
    this.event("real", kind, wallet, null, amount, ref);
  }

  treasuryWithdraw(mode: Mode, amount: number, to: string) {
    return this.tx(() => {
      if (amount > this.bucket(mode, "treasury")) throw new TradeError("insufficient", "Treasury too small");
      this.addBucket(mode, "treasury", -amount);
      this.addBalance(to, mode, amount);
      this.event(mode, "treasury_out", to, null, amount);
    });
  }

  // ---------- audit ----------

  /** Internal conservation: assets held for others must equal net external flow. */
  conservation(mode: Mode) {
    const b = this.book(mode);
    const users = (this.db.prepare("SELECT COALESCE(SUM(balance), 0) AS s FROM accounts WHERE mode = ?").get(mode) as { s: number }).s;
    const locked = (this.db.prepare("SELECT COALESCE(SUM(stake), 0) AS s FROM positions WHERE mode = ? AND status = 'open'").get(mode) as { s: number }).s;
    const pending = (this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM withdrawals WHERE status IN ('pending','sending')").get() as { s: number }).s;
    const held = users + b.pool_cash + b.holders_pot + b.treasury + b.locked + b.pending_withdrawals;
    const net = b.external_in - b.external_out;
    const problems: string[] = [];
    if (held !== net) problems.push(`held ${held} != net external ${net}`);
    if (locked !== b.locked) problems.push(`locked bucket ${b.locked} != open stakes ${locked}`);
    if (mode === "real" && pending !== b.pending_withdrawals) problems.push(`pending bucket ${b.pending_withdrawals} != pending rows ${pending}`);
    if (b.pool_cash < 0) problems.push(`pool cash negative ${b.pool_cash}`);
    if (b.holders_pot < 0) problems.push(`holders pot negative ${b.holders_pot}`);
    return { ok: problems.length === 0, held, net, users, book: b, problems };
  }

  // ---------- reads ----------

  tape(mode: Mode, limit = 50) {
    return this.db
      .prepare(
        "SELECT * FROM events WHERE mode = ? AND kind IN ('open','close','max_win','liquidated','pool_add','pool_remove','creator_fee','reward') ORDER BY id DESC LIMIT ?",
      )
      .all(mode, limit)
      .map((e: any) => ({ ...e, data: e.data ? JSON.parse(e.data) : null }));
  }

  topTrades(mode: Mode, sinceMs: number | null, by: "sol" | "pct", limit = 10) {
    const order = by === "sol" ? "pnl - fee" : "CAST(pnl AS REAL) / stake";
    const since = sinceMs === null ? 0 : this.now() - sinceMs;
    return this.db
      .prepare(`SELECT * FROM positions WHERE mode = ? AND status = 'closed' AND closed_at >= ? AND pnl > 0 ORDER BY ${order} DESC LIMIT ?`)
      .all(mode, since, limit) as Position[];
  }

  walletPositions(wallet: string, mode: Mode, status: "open" | "closed", limit = 100) {
    return this.db
      .prepare(`SELECT * FROM positions WHERE wallet = ? AND mode = ? AND status = ? ORDER BY id DESC LIMIT ?`)
      .all(wallet, mode, status, limit) as Position[];
  }

  /** Net realized trading P&L (after fees) per wallet over a window, for rebates. */
  realizedPnlByWallet(mode: Mode, from: number, to: number) {
    return this.db
      .prepare("SELECT wallet, SUM(pnl - fee) AS net FROM positions WHERE mode = ? AND status = 'closed' AND closed_at >= ? AND closed_at < ? GROUP BY wallet")
      .all(mode, from, to) as { wallet: string; net: number }[];
  }
}
