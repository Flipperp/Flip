import { Connection, PublicKey, type AccountInfo } from "@solana/web3.js";
import { pump, pumpSwap } from "../pumpSdk.js";
import { getMint, getTokenMetadata, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import type { DB } from "../db.js";
import type { PriceStore } from "./priceStore.js";
import type { MarketRow } from "../engine/engine.js";

export const WSOL = "So11111111111111111111111111111111111111112";
const RAY_AMM_V4 = "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8";
const RAY_CPMM = "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C";
const METAPLEX = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bmuJ7JqG");
const LAMPORTS = 1_000_000_000;

export type Source =
  | { kind: "pumpfun"; curve: string }
  | { kind: "pumpswap"; pool: string; baseVault: string; quoteVault: string }
  | { kind: "raydium_amm"; pool: string; baseVault: string; quoteVault: string; baseIsMint: boolean }
  | { kind: "raydium_cpmm"; pool: string; vault0: string; vault1: string; mint0IsToken: boolean }
  | { kind: "jupiter" };

interface ResolveResult {
  venue: string;
  source: Source;
  symbol: string;
  name: string;
  image: string;
  supply: number;
  decimals: number;
}

const { PUMP_SDK, bondingCurvePda, canonicalPumpPoolPda, SOL_LIKE_QUOTE_MINTS } = pump;
const { PUMP_AMM_SDK } = pumpSwap;
const isSolQuote = (pk: PublicKey) => SOL_LIKE_QUOTE_MINTS.some((m) => m.equals(pk)) || pk.toBase58() === WSOL;
const u64 = (buf: Buffer, off: number) => Number(buf.readBigUInt64LE(off));
const pk = (buf: Buffer, off: number) => new PublicKey(buf.subarray(off, off + 32)).toBase58();
/** SPL token account amount (same offset for Token and Token-2022). */
const tokenAmount = (info: AccountInfo<Buffer> | null) => (info && info.data.length >= 72 ? u64(info.data, 64) : null);

async function fetchJson(url: string, timeoutMs = 5000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Reads prices straight from each coin's own pool on-chain:
 *  - pump.fun bonding curve (virtual reserves)
 *  - PumpSwap canonical pool (vault balances + virtual quote reserves)
 *  - Raydium AMM v4 / CPMM (vault balances net of pending fees)
 *  - anything else falls back to Jupiter's price API (flagged as "jupiter")
 */
export class ChainOracle {
  private polling = false;
  private solUsd = 0;
  private hot = new Set<string>();
  private lastSlowPoll = 0;
  private timer?: NodeJS.Timeout;
  public lastError: string | null = null;

  constructor(
    private conn: Connection,
    private db: DB,
    private prices: PriceStore,
    private opts: { pollMs: number; slowPollMs: number; hotMints: () => string[] },
  ) {}

  start() {
    const loop = async () => {
      try {
        await this.poll();
        this.lastError = null;
      } catch (e: any) {
        this.lastError = String(e?.message ?? e);
      }
      this.timer = setTimeout(loop, this.opts.pollMs);
    };
    loop();
  }

  stop() {
    if (this.timer) clearTimeout(this.timer);
  }

  markHot(mint: string) {
    this.hot.add(mint);
  }

  /** Find where a mint trades and add it as a market. Throws if unsupported. */
  async resolve(mint: string, hint?: { bornAt?: number }): Promise<MarketRow> {
    const existing = this.db.prepare("SELECT * FROM markets WHERE mint = ?").get(mint) as MarketRow | undefined;
    if (existing) {
      // listed = 2 means pruned for inactivity: asking for it again puts it back. listed = 0 is an
      // admin delist and stays off.
      if (existing.listed === 2) {
        this.db.prepare("UPDATE markets SET listed = 1, last_viewed = ? WHERE mint = ?").run(Date.now(), mint);
        this.hot.add(mint);
        return { ...existing, listed: 1 };
      }
      return existing;
    }
    const mintPk = new PublicKey(mint);
    const r = await this.discover(mintPk);
    const now = Date.now();
    this.db
      .prepare("INSERT OR REPLACE INTO markets (mint, symbol, name, image, venue, source, supply, decimals, added_at, last_viewed, listed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)")
      .run(mint, r.symbol, r.name, r.image, r.venue, JSON.stringify(r.source), r.supply, r.decimals, now, now);
    this.fillBornAt(mint, hint?.bornAt).catch(() => {});
    this.hot.add(mint);
    return this.db.prepare("SELECT * FROM markets WHERE mint = ?").get(mint) as MarketRow;
  }

  /**
   * When the coin was created. The earliest DexScreener pair (pump.fun lists the curve from launch)
   * or a launch time seen on the live feed. Unknown stays null and the risk rules fall back to
   * when Flip first listed the coin, which can only make a coin look younger, never older.
   */
  async fillBornAt(mint: string, hint?: number) {
    let t = hint && hint > 1.5e12 ? hint : null;
    if (!t) {
      const pairs: any[] = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/solana/${mint}`).catch(() => []);
      const ts = (Array.isArray(pairs) ? pairs : []).map((p) => Number(p?.pairCreatedAt)).filter((x) => x > 1.5e12 && x <= Date.now() + 60_000);
      t = ts.length ? Math.min(...ts) : null;
    }
    if (t) this.db.prepare("UPDATE markets SET born_at = CASE WHEN born_at IS NULL OR born_at > ? THEN ? ELSE born_at END WHERE mint = ?").run(t, t, mint);
  }

  /** Fill in creation times for markets listed before born_at existed. A few per call. */
  async backfillBornAt(max = 15) {
    const rows = this.db.prepare("SELECT mint FROM markets WHERE listed = 1 AND born_at IS NULL LIMIT ?").all(max) as { mint: string }[];
    for (const r of rows) {
      await this.fillBornAt(r.mint).catch(() => {});
      await new Promise((ok) => setTimeout(ok, 500));
    }
  }

  private reresolving = new Set<string>();
  async reresolve(mint: string) {
    if (this.reresolving.has(mint)) return;
    this.reresolving.add(mint);
    try {
      const r = await this.discover(new PublicKey(mint));
      this.db.prepare("UPDATE markets SET venue = ?, source = ?, supply = ? WHERE mint = ?").run(r.venue, JSON.stringify(r.source), r.supply, mint);
    } finally {
      this.reresolving.delete(mint);
    }
  }

  private async discover(mint: PublicKey): Promise<ResolveResult> {
    const mintInfo = await this.conn.getAccountInfo(mint);
    if (!mintInfo) throw new Error("Mint not found");
    const programId = mintInfo.owner;
    const m = await getMint(this.conn, mint, "confirmed", programId);
    const decimals = m.decimals;
    const supply = Number(m.supply) / 10 ** decimals;
    const meta = await this.metadata(mint, programId);

    // 1) pump.fun bonding curve still live
    const curvePk = bondingCurvePda(mint);
    const curveInfo = await this.conn.getAccountInfo(curvePk);
    if (curveInfo) {
      const c = PUMP_SDK.decodeBondingCurveNullable(curveInfo);
      if (c && !c.complete && (!c.quoteMint || isSolQuote(c.quoteMint))) {
        return { venue: "pumpfun", source: { kind: "pumpfun", curve: curvePk.toBase58() }, decimals, supply, ...meta };
      }
    }
    // 2) graduated to PumpSwap
    const poolPk = canonicalPumpPoolPda(mint);
    const poolInfo = await this.conn.getAccountInfo(poolPk);
    if (poolInfo) {
      const pool = PUMP_AMM_SDK.decodePool(poolInfo);
      if (isSolQuote(pool.quoteMint)) {
        return {
          venue: "pumpswap",
          source: { kind: "pumpswap", pool: poolPk.toBase58(), baseVault: pool.poolBaseTokenAccount.toBase58(), quoteVault: pool.poolQuoteTokenAccount.toBase58() },
          decimals,
          supply,
          ...meta,
        };
      }
    }
    // 3) other venues via DexScreener discovery, verified on-chain
    const pairs: any[] = await fetchJson(`https://api.dexscreener.com/token-pairs/v1/solana/${mint.toBase58()}`).catch(() => []);
    const candidates = (Array.isArray(pairs) ? pairs : [])
      .filter((p) => p.quoteToken?.address === WSOL || p.baseToken?.address === WSOL)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
    const dsMeta = (Array.isArray(pairs) ? pairs : []).find((p) => p.baseToken?.address === mint.toBase58());
    const merged = {
      symbol: meta.symbol || dsMeta?.baseToken?.symbol || "",
      name: meta.name || dsMeta?.baseToken?.name || "",
      image: meta.image || dsMeta?.info?.imageUrl || "",
    };
    for (const p of candidates) {
      const info = await this.conn.getAccountInfo(new PublicKey(p.pairAddress)).catch(() => null);
      if (!info) continue;
      const owner = info.owner.toBase58();
      if (owner === RAY_AMM_V4 && info.data.length >= 496) {
        const baseMint = pk(info.data, 400);
        const quoteMint = pk(info.data, 432);
        const ours = mint.toBase58();
        if ((baseMint === ours && quoteMint === WSOL) || (baseMint === WSOL && quoteMint === ours)) {
          return {
            venue: "raydium",
            source: { kind: "raydium_amm", pool: p.pairAddress, baseVault: pk(info.data, 336), quoteVault: pk(info.data, 368), baseIsMint: baseMint === ours },
            decimals,
            supply,
            ...merged,
          };
        }
      }
      if (owner === RAY_CPMM && info.data.length >= 373) {
        const m0 = pk(info.data, 168);
        const m1 = pk(info.data, 200);
        const ours = mint.toBase58();
        if ((m0 === ours && m1 === WSOL) || (m0 === WSOL && m1 === ours)) {
          return {
            venue: "raydium",
            source: { kind: "raydium_cpmm", pool: p.pairAddress, vault0: pk(info.data, 72), vault1: pk(info.data, 104), mint0IsToken: m0 === ours },
            decimals,
            supply,
            ...merged,
          };
        }
      }
    }
    if (candidates.length) return { venue: "jupiter", source: { kind: "jupiter" }, decimals, supply, ...merged };
    throw new Error("No SOL liquidity found for this coin");
  }

  private async metadata(mint: PublicKey, programId: PublicKey) {
    const out = { symbol: "", name: "", image: "" };
    try {
      if (programId.equals(TOKEN_2022_PROGRAM_ID)) {
        const md = await getTokenMetadata(this.conn, mint, "confirmed", programId);
        if (md) {
          out.symbol = md.symbol;
          out.name = md.name;
          out.image = await this.imageFromUri(md.uri);
          return out;
        }
      }
      const [pda] = PublicKey.findProgramAddressSync([Buffer.from("metadata"), METAPLEX.toBuffer(), mint.toBuffer()], METAPLEX);
      const info = await this.conn.getAccountInfo(pda);
      if (info) {
        // Metaplex Metadata: key(1) updateAuth(32) mint(32) name(4+32) symbol(4+10) uri(4+200)
        let o = 65;
        const readStr = () => {
          const len = info.data.readUInt32LE(o);
          o += 4;
          const s = info.data.subarray(o, o + len).toString("utf8").replace(/\0/g, "").trim();
          o += len;
          return s;
        };
        out.name = readStr();
        out.symbol = readStr();
        out.image = await this.imageFromUri(readStr());
      }
    } catch {
      /* metadata is cosmetic */
    }
    return out;
  }

  private async imageFromUri(uri: string) {
    if (!uri) return "";
    try {
      const j = await fetchJson(uri, 3000);
      return typeof j?.image === "string" ? j.image : "";
    } catch {
      return "";
    }
  }

  /** One polling pass. Hot markets every tick, the rest every slowPollMs. */
  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const now = Date.now();
      const slow = now - this.lastSlowPoll >= this.opts.slowPollMs;
      if (slow) this.lastSlowPoll = now;
      const hot = new Set([...this.hot, ...this.opts.hotMints()]);
      const markets = (this.db.prepare("SELECT * FROM markets WHERE listed = 1").all() as MarketRow[]).filter((m) => slow || hot.has(m.mint));
      if (markets.length === 0) return;

      const keys: string[] = [];
      const plan: { m: MarketRow; src: Source; idx: number[] }[] = [];
      const jup: MarketRow[] = [];
      for (const m of markets) {
        const src = JSON.parse(m.source) as Source;
        const want: string[] =
          src.kind === "pumpfun"
            ? [src.curve]
            : src.kind === "pumpswap"
              ? [src.pool, src.baseVault, src.quoteVault]
              : src.kind === "raydium_amm"
                ? [src.pool, src.baseVault, src.quoteVault]
                : src.kind === "raydium_cpmm"
                  ? [src.pool, src.vault0, src.vault1]
                  : [];
        if (src.kind === "jupiter") {
          jup.push(m);
          continue;
        }
        plan.push({ m, src, idx: want.map((k) => keys.push(k) - 1) });
      }

      const infos: (AccountInfo<Buffer> | null)[] = [];
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100).map((k) => new PublicKey(k));
        infos.push(...(await this.conn.getMultipleAccountsInfo(chunk, "confirmed")));
      }
      const ts = Date.now();
      for (const { m, src, idx } of plan) {
        try {
          const q = this.quote(m, src, idx.map((i) => infos[i]));
          if (q === "graduated") {
            // Curve completed: switch the market to its PumpSwap pool in place.
            this.reresolve(m.mint).catch(() => {});
            continue;
          }
          if (q) this.prices.push(m.mint, { ...q, ts });
        } catch {
          /* skip bad market this tick */
        }
      }
      if (jup.length) await this.pollJupiter(jup, ts);
      // Hot set decays: keep only mints viewed in the last 10 minutes.
      const cutoff = now - 10 * 60_000;
      for (const mint of this.hot) {
        const r = this.db.prepare("SELECT last_viewed FROM markets WHERE mint = ?").get(mint) as { last_viewed: number } | undefined;
        if (!r || r.last_viewed < cutoff) this.hot.delete(mint);
      }
    } finally {
      this.polling = false;
    }
  }

  private quote(m: MarketRow, src: Source, a: (AccountInfo<Buffer> | null)[]): { price: number; liquidity: number; mcapSol: number } | "graduated" | null {
    const dec = 10 ** m.decimals;
    if (src.kind === "pumpfun") {
      if (!a[0]) return null;
      const c = PUMP_SDK.decodeBondingCurve(a[0]);
      if (c.complete) return "graduated";
      const vSol = Number(c.virtualQuoteReserves.toString()) / LAMPORTS;
      const vTok = Number(c.virtualTokenReserves.toString()) / dec;
      const price = vSol / vTok;
      const supply = Number(c.tokenTotalSupply.toString()) / dec || m.supply;
      return { price, liquidity: Number(c.realQuoteReserves.toString()), mcapSol: price * supply };
    }
    if (src.kind === "pumpswap") {
      const [poolInfo, baseInfo, quoteInfo] = a;
      const base = tokenAmount(baseInfo);
      const quote = tokenAmount(quoteInfo);
      if (!poolInfo || base === null || quote === null || base === 0) return null;
      const pool = PUMP_AMM_SDK.decodePool(poolInfo);
      const effQuote = quote + Number(pool.virtualQuoteReserves?.toString() ?? 0);
      const price = effQuote / LAMPORTS / (base / dec);
      return { price, liquidity: quote, mcapSol: price * m.supply };
    }
    if (src.kind === "raydium_amm") {
      const [poolInfo, baseInfo, quoteInfo] = a;
      const bv = tokenAmount(baseInfo);
      const qv = tokenAmount(quoteInfo);
      if (!poolInfo || bv === null || qv === null) return null;
      const base = bv - u64(poolInfo.data, 192);
      const quote = qv - u64(poolInfo.data, 200);
      const [tok, sol] = src.baseIsMint ? [base, quote] : [quote, base];
      if (tok <= 0) return null;
      const price = sol / LAMPORTS / (tok / dec);
      return { price, liquidity: sol, mcapSol: price * m.supply };
    }
    if (src.kind === "raydium_cpmm") {
      const [poolInfo, v0, v1] = a;
      const a0 = tokenAmount(v0);
      const a1 = tokenAmount(v1);
      if (!poolInfo || a0 === null || a1 === null) return null;
      const r0 = a0 - u64(poolInfo.data, 341) - u64(poolInfo.data, 357);
      const r1 = a1 - u64(poolInfo.data, 349) - u64(poolInfo.data, 365);
      const [tok, sol] = src.mint0IsToken ? [r0, r1] : [r1, r0];
      if (tok <= 0) return null;
      const price = sol / LAMPORTS / (tok / dec);
      return { price, liquidity: sol, mcapSol: price * m.supply };
    }
    return null;
  }

  private async pollJupiter(markets: MarketRow[], ts: number) {
    for (let i = 0; i < markets.length; i += 49) {
      const chunk = markets.slice(i, i + 49);
      const ids = [WSOL, ...chunk.map((m) => m.mint)].join(",");
      const j = await fetchJson(`https://lite-api.jup.ag/price/v3?ids=${ids}`).catch(() => null);
      if (!j) continue;
      this.solUsd = j[WSOL]?.usdPrice ?? this.solUsd;
      if (!this.solUsd) continue;
      for (const m of chunk) {
        const usd = j[m.mint]?.usdPrice;
        if (!usd) continue;
        const price = usd / this.solUsd;
        const liqUsd = j[m.mint]?.liquidity ?? 0;
        // Jupiter reports total liquidity in USD; SOL side is about half.
        this.prices.push(m.mint, { price, liquidity: Math.floor(((liqUsd / 2) / this.solUsd) * LAMPORTS), mcapSol: price * m.supply, ts });
      }
    }
  }
}
