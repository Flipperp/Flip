import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import type { DB } from "../db.js";
import type { Config } from "../config.js";
import type { Engine } from "../engine/engine.js";

/**
 * Reads every holder of the project token. Owners that are off the ed25519 curve (program PDAs:
 * the bonding curve, PumpSwap pool, lockers) are excluded automatically, plus any configured
 * exclusions (team, vault, creator, CEX wallets).
 */
export async function fetchHolderBalances(conn: Connection, mint: PublicKey, exclude: Set<string>): Promise<{ balances: Map<string, number>; supply: number }> {
  const mintInfo = await conn.getAccountInfo(mint);
  if (!mintInfo) throw new Error("token mint not found");
  const programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const decimals = mintInfo.data[44];
  const supplyRaw = Number(mintInfo.data.readBigUInt64LE(36));
  const filters: any[] = [{ memcmp: { offset: 0, bytes: mint.toBase58() } }];
  if (programId.equals(TOKEN_PROGRAM_ID)) filters.push({ dataSize: 165 });
  const accounts = await conn.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters,
    dataSlice: { offset: 32, length: 40 }, // owner (32) + amount (8)
  });
  const balances = new Map<string, number>();
  for (const a of accounts) {
    const data = a.account.data;
    if (data.length < 40) continue;
    const owner = new PublicKey(data.subarray(0, 32));
    const amount = Number(data.readBigUInt64LE(32)) / 10 ** decimals;
    if (amount <= 0) continue;
    const o = owner.toBase58();
    if (exclude.has(o) || !PublicKey.isOnCurve(owner.toBytes())) continue;
    balances.set(o, (balances.get(o) ?? 0) + amount);
  }
  return { balances, supply: supplyRaw / 10 ** decimals };
}

interface EpochRow {
  id: number;
  started_at: number;
  ended_at: number | null;
  last_snapshot_at: number | null;
  status: string;
}

/**
 * Holder yield. Each snapshot accrues balance x time into the open epoch. When an epoch closes:
 *   1. Rekt rebates: tiered holders with a net realized trading loss in the epoch get a % back.
 *   2. The rest of this epoch's payout goes to every holder pro-rata to time-weighted balance.
 * Rewards are credited to the holder's in-app balance, withdrawable at any time.
 */
export class HolderRewards {
  constructor(
    private db: DB,
    private engine: Engine,
    private cfg: Config,
    private now: () => number = Date.now,
  ) {}

  currentEpoch(): EpochRow {
    let e = this.db.prepare("SELECT * FROM holder_epochs WHERE status = 'open' ORDER BY id DESC LIMIT 1").get() as EpochRow | undefined;
    if (!e) {
      const info = this.db.prepare("INSERT INTO holder_epochs (started_at, status) VALUES (?, 'open')").run(this.now());
      e = this.db.prepare("SELECT * FROM holder_epochs WHERE id = ?").get(Number(info.lastInsertRowid)) as EpochRow;
    }
    return e;
  }

  /** Apply a balance snapshot. Accrues weight using each wallet's previous balance. */
  applySnapshot(balances: Map<string, number>, supply: number) {
    const now = this.now();
    const cap = supply * this.cfg.holders.maxWeightSupplyFrac;
    this.engine.tx(() => {
      const e = this.currentEpoch();
      const last = e.last_snapshot_at ?? e.started_at;
      const dt = Math.max(0, now - last);
      const prev = this.db.prepare("SELECT wallet, last_balance FROM holder_weights WHERE epoch_id = ?").all(e.id) as { wallet: string; last_balance: number }[];
      const upd = this.db.prepare(
        "INSERT INTO holder_weights (epoch_id, wallet, weight, last_balance) VALUES (?, ?, ?, ?) ON CONFLICT(epoch_id, wallet) DO UPDATE SET weight = weight + excluded.weight, last_balance = excluded.last_balance",
      );
      const seen = new Set<string>();
      for (const p of prev) {
        const nb = balances.get(p.wallet) ?? 0;
        upd.run(e.id, p.wallet, Math.min(p.last_balance, cap) * dt, nb);
        seen.add(p.wallet);
      }
      for (const [w, b] of balances) if (!seen.has(w)) upd.run(e.id, w, 0, b);
      this.db.prepare("UPDATE holder_epochs SET last_snapshot_at = ? WHERE id = ?").run(now, e.id);

      // Tier balances.
      const elapsed = Math.max(1, now - e.started_at);
      const rows = this.db.prepare("SELECT wallet, weight, last_balance FROM holder_weights WHERE epoch_id = ?").all(e.id) as { wallet: string; weight: number; last_balance: number }[];
      const prevAvg = new Map(
        (this.db.prepare("SELECT wallet, prev_avg FROM holder_balances").all() as { wallet: string; prev_avg: number }[]).map((r) => [r.wallet, r.prev_avg]),
      );
      const up = this.db.prepare(
        "INSERT INTO holder_balances (wallet, balance, twab, prev_avg, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(wallet) DO UPDATE SET balance = excluded.balance, twab = excluded.twab, updated_at = excluded.updated_at",
      );
      for (const r of rows) {
        const pa = prevAvg.get(r.wallet) ?? 0;
        const curAvg = r.weight / elapsed;
        // Need an hour of history in the current epoch before it can lower or confirm a tier.
        const tierBal = elapsed >= 3600_000 ? Math.min(pa, curAvg) : pa;
        up.run(r.wallet, r.last_balance, tierBal, pa, now);
      }
    });
    if (now - this.currentEpoch().started_at >= this.cfg.holders.epochMs) return this.closeEpoch();
    return null;
  }

  closeEpoch() {
    const now = this.now();
    return this.engine.tx(() => {
      const e = this.currentEpoch();
      const duration = Math.max(1, now - e.started_at);
      const pot = this.engine.bucket("real", "holders_pot");
      const payout = Math.floor(pot * this.cfg.holders.payoutFrac);
      const weights = this.db.prepare("SELECT wallet, weight FROM holder_weights WHERE epoch_id = ? AND weight > 0").all(e.id) as { wallet: string; weight: number }[];

      // 1) Rekt rebates for tiered holders with a net loss this epoch.
      const pnl = this.engine.realizedPnlByWallet("real", e.started_at, now).filter((r) => r.net < 0);
      const wanted: { wallet: string; amount: number }[] = [];
      for (const r of pnl) {
        const tier = this.engine.tierFor(r.wallet);
        const bps = this.cfg.tiers[tier]?.rebateBps ?? 0;
        if (bps <= 0) continue;
        const amt = Math.min(this.cfg.rebate.maxPerWalletPerEpoch, Math.floor((-r.net * bps) / 10_000));
        if (amt > 0) wanted.push({ wallet: r.wallet, amount: amt });
      }
      const rebateBudget = Math.floor(payout * this.cfg.rebate.maxPotFrac);
      const wantedTotal = wanted.reduce((a, w) => a + w.amount, 0);
      const scale = wantedTotal > rebateBudget ? rebateBudget / wantedTotal : 1;
      let rebateTotal = 0;
      const ins = this.db.prepare(
        "INSERT INTO holder_rewards (epoch_id, wallet, reward, rebate) VALUES (?, ?, ?, ?) ON CONFLICT(epoch_id, wallet) DO UPDATE SET reward = reward + excluded.reward, rebate = rebate + excluded.rebate",
      );
      for (const w of wanted) {
        const amt = Math.floor(w.amount * scale);
        if (amt < this.cfg.holders.minPayout) continue;
        this.engine.payFromHolders(w.wallet, amt, "rebate", `epoch:${e.id}`);
        ins.run(e.id, w.wallet, 0, amt);
        rebateTotal += amt;
      }

      // 2) Pro-rata holder yield.
      const yieldPool = payout - rebateTotal;
      const totalW = weights.reduce((a, w) => a + w.weight, 0);
      let paid = 0;
      if (totalW > 0 && yieldPool > 0) {
        for (const w of weights) {
          const amt = Math.floor((yieldPool * w.weight) / totalW);
          if (amt < this.cfg.holders.minPayout) continue;
          this.engine.payFromHolders(w.wallet, amt, "reward", `epoch:${e.id}`);
          ins.run(e.id, w.wallet, amt, 0);
          paid += amt;
        }
      }

      // Roll averages forward for tiers.
      const setPrev = this.db.prepare("UPDATE holder_balances SET prev_avg = ?, twab = MIN(?, balance) WHERE wallet = ?");
      const allW = this.db.prepare("SELECT wallet, weight, last_balance FROM holder_weights WHERE epoch_id = ?").all(e.id) as { wallet: string; weight: number; last_balance: number }[];
      for (const w of allW) {
        const avg = w.weight / duration;
        setPrev.run(avg, avg, w.wallet);
      }
      this.db.prepare("UPDATE holder_epochs SET status = 'closed', ended_at = ?, payout_total = ?, rebate_total = ? WHERE id = ?").run(now, paid, rebateTotal, e.id);
      // Open the next epoch and carry balances over so accrual is continuous.
      const info = this.db.prepare("INSERT INTO holder_epochs (started_at, last_snapshot_at, status) VALUES (?, ?, 'open')").run(now, now);
      const next = Number(info.lastInsertRowid);
      const carry = this.db.prepare("INSERT INTO holder_weights (epoch_id, wallet, weight, last_balance) VALUES (?, ?, 0, ?)");
      for (const w of allW) if (w.last_balance > 0) carry.run(next, w.wallet, w.last_balance);
      return { epoch: e.id, paid, rebates: rebateTotal, holders: weights.length };
    });
  }

  /** Public view of the current epoch and a wallet's standing. */
  status(wallet?: string) {
    const e = this.currentEpoch();
    const now = this.now();
    const pot = this.engine.bucket("real", "holders_pot");
    const totalW = (this.db.prepare("SELECT COALESCE(SUM(weight),0) AS s FROM holder_weights WHERE epoch_id = ?").get(e.id) as { s: number }).s;
    const holders = (this.db.prepare("SELECT COUNT(*) AS n FROM holder_weights WHERE epoch_id = ? AND last_balance > 0").get(e.id) as { n: number }).n;
    const last = this.db.prepare("SELECT * FROM holder_epochs WHERE status = 'closed' ORDER BY id DESC LIMIT 1").get();
    const out: any = {
      epoch: e.id,
      startedAt: e.started_at,
      endsAt: e.started_at + this.cfg.holders.epochMs,
      pot,
      projectedPayout: Math.floor(pot * this.cfg.holders.payoutFrac),
      holders,
      lastEpoch: last ?? null,
      now,
    };
    if (wallet) {
      const w = this.db.prepare("SELECT weight, last_balance FROM holder_weights WHERE epoch_id = ? AND wallet = ?").get(e.id, wallet) as { weight: number; last_balance: number } | undefined;
      const hb = this.db.prepare("SELECT * FROM holder_balances WHERE wallet = ?").get(wallet) as { balance: number; twab: number; prev_avg: number } | undefined;
      const share = w && totalW > 0 ? w.weight / totalW : 0;
      const earned = (this.db.prepare("SELECT COALESCE(SUM(reward),0) AS r, COALESCE(SUM(rebate),0) AS b FROM holder_rewards WHERE wallet = ?").get(wallet) as { r: number; b: number });
      const tier = this.engine.tierFor(wallet);
      out.me = {
        balance: hb?.balance ?? w?.last_balance ?? 0,
        tierBalance: hb ? Math.min(hb.balance, hb.twab) : 0,
        tier,
        share,
        projected: Math.floor(out.projectedPayout * share),
        earnedRewards: earned.r,
        earnedRebates: earned.b,
        history: this.db.prepare("SELECT r.*, e.ended_at FROM holder_rewards r JOIN holder_epochs e ON e.id = r.epoch_id WHERE r.wallet = ? ORDER BY r.epoch_id DESC LIMIT 30").all(wallet),
      };
    }
    return out;
  }
}

/** Runs fetch + apply on an interval. */
export class HolderTracker {
  private timer?: NodeJS.Timeout;
  public lastError: string | null = null;
  public lastCount = 0;
  constructor(
    private conn: Connection,
    private rewards: HolderRewards,
    private mint: PublicKey,
    private exclude: Set<string>,
    private everyMs: number,
  ) {}

  start() {
    const loop = async () => {
      try {
        const { balances, supply } = await fetchHolderBalances(this.conn, this.mint, this.exclude);
        this.lastCount = balances.size;
        this.rewards.applySnapshot(balances, supply);
        this.lastError = null;
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
      }
      this.timer = setTimeout(loop, this.everyMs);
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }
}
