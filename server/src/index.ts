import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "./config.js";
import { openDb } from "./db.js";
import { PriceStore } from "./oracle/priceStore.js";
import { Engine } from "./engine/engine.js";
import { ChainOracle, WSOL } from "./oracle/chainOracle.js";
import { MarketSeeder } from "./oracle/seeder.js";
import { DepositWatcher } from "./chain/deposits.js";
import { WithdrawalWorker } from "./chain/withdrawals.js";
import { CreatorFeeSweeper } from "./chain/creatorFees.js";
import { HolderRewards, HolderTracker } from "./chain/holders.js";
import { Auditor } from "./chain/audit.js";
import { loadKeypair } from "./chain/keys.js";
import { Auth } from "./auth.js";
import { buildApi } from "./api.js";
import { startDemo } from "./demo.js";
import { HlLink, parseMap } from "./hl/link.js";

async function main() {
  const cfg = config;
  const db = openDb(cfg.dbPath);
  const conn = new Connection(cfg.rpcUrl, { commitment: "confirmed", wsEndpoint: cfg.wsRpcUrl || undefined });
  const prices = new PriceStore(cfg.trading.twapWindowMs, cfg.trading.minTwapSamples, cfg.trading.staleMs);
  const engine = new Engine(db, prices, cfg);
  engine.on("error", (e) => console.error("[engine]", e?.message ?? e));

  const vault = loadKeypair(cfg.vaultSecret);
  const creator = loadKeypair(cfg.creatorSecret);
  if (cfg.realEnabled && !vault) throw new Error("REAL_ENABLED=true requires VAULT_SECRET");
  // Real balances live in the database. On ephemeral storage a restart would wipe every balance
  // while the SOL stays in the vault, so refuse to start unless storage is declared persistent.
  if (cfg.realEnabled && process.env.PERSISTENT_DB !== "true") {
    throw new Error("REAL_ENABLED=true requires PERSISTENT_DB=true and DB_PATH on a persistent disk");
  }
  if (cfg.holderFundWallet) {
    new PublicKey(cfg.holderFundWallet); // throws on a malformed address
    if (cfg.holderFundWallet === vault?.publicKey.toBase58() || cfg.holderFundWallet === creator?.publicKey.toBase58())
      throw new Error("HOLDER_FUND_WALLET must differ from the vault and creator wallets");
  }
  if (cfg.realEnabled && !cfg.adminKey) throw new Error("REAL_ENABLED=true requires ADMIN_KEY");
  if (vault) console.log(`[vault] ${vault.publicKey.toBase58()}`);
  if (vault && creator && vault.publicKey.equals(creator.publicKey)) throw new Error("Vault and creator wallets must be different");

  if (cfg.hl.builder && !/^0x[0-9a-f]{40}$/.test(cfg.hl.builder)) throw new Error("HL_BUILDER must be a 0x-prefixed EVM address");
  const hl = cfg.hl.enabled
    ? new HlLink(prices, (mint) => !!engine.market(mint)?.listed, {
        apiUrl: cfg.hl.apiUrl,
        pollMs: cfg.hl.pollMs,
        maxDivergence: cfg.hl.maxDivergence,
        confirmChecks: cfg.hl.confirmChecks,
        map: parseMap(cfg.hl.map),
      })
    : null;

  const oracle = new ChainOracle(conn, db, prices, {
    pollMs: Number(process.env.POLL_MS ?? 1000),
    slowPollMs: Number(process.env.SLOW_POLL_MS ?? 15_000),
    hotMints: () => [...new Set(engine.allOpenPositions().map((p) => p.mint))],
  });
  const demo = process.env.DEMO === "true";
  if (demo) {
    if (cfg.realEnabled) throw new Error("DEMO=true cannot run with REAL_ENABLED=true");
    startDemo(db, engine, prices);
  } else oracle.start();

  const seeder = new MarketSeeder(oracle, {
    everyMs: 10 * 60_000,
    // Coins with a Hyperliquid perp are always listed so the route can be checked against their price.
    seedMints: [cfg.tokenMint, ...(process.env.SEED_MINTS ?? "").split(","), ...(hl?.mints ?? [])].map((s) => s.trim()).filter(Boolean),
    maxPerRun: Number(process.env.SEED_PER_RUN ?? 30),
    gapMs: Number(process.env.SEED_GAP_MS ?? 1500),
  });
  if (!demo && process.env.DISABLE_SEEDER !== "true") seeder.start();
  hl?.start();

  // Settlement loop: auto-close max wins and liquidations every second.
  const tickTimer = setInterval(() => {
    try {
      engine.tick();
    } catch (e: any) {
      console.error("[tick]", e?.message ?? e);
    }
  }, 1000);

  let deposits: DepositWatcher | null = null;
  let withdrawals: WithdrawalWorker | null = null;
  if (vault) {
    deposits = new DepositWatcher(conn, db, engine, vault.publicKey, {
      pollMs: 2000,
      minDeposit: cfg.custody.minDeposit,
      creatorWallet: creator?.publicKey.toBase58() ?? null,
      holderFundWallet: cfg.holderFundWallet || null,
      commitment: cfg.custody.commitment,
    });
    deposits.start();
    withdrawals = new WithdrawalWorker(conn, db, engine, vault, { pollMs: 3000, priorityMicroLamports: 50_000, reserve: cfg.custody.vaultReserve, maxAttempts: 5 });
    withdrawals.start();
  }

  let sweeper: CreatorFeeSweeper | null = null;
  if (creator && vault && cfg.tokenMint) {
    sweeper = new CreatorFeeSweeper(conn, creator, vault.publicKey, { everyMs: 10 * 60_000, minClaimLamports: 10_000_000, keepLamports: 20_000_000 });
    sweeper.start();
  }

  let rewards: HolderRewards | null = null;
  let tracker: HolderTracker | null = null;
  if (cfg.tokenMint) {
    rewards = new HolderRewards(db, engine, cfg);
    const exclude = new Set([...cfg.holderExclusions, vault?.publicKey.toBase58(), creator?.publicKey.toBase58()].filter(Boolean) as string[]);
    tracker = new HolderTracker(conn, rewards, new PublicKey(cfg.tokenMint), exclude, cfg.holders.snapshotEveryMs);
    tracker.start();
  }

  const auditor = new Auditor(cfg.realEnabled ? conn : null, engine, vault?.publicKey ?? null, {
    everyMs: 15_000,
    tolerance: cfg.custody.auditToleranceLamports,
    reserve: cfg.custody.vaultReserve,
  });
  auditor.start();

  let solUsd = 0;
  const refreshSol = async () => {
    try {
      const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${WSOL}`);
      const j = await r.json();
      solUsd = j?.[WSOL]?.usdPrice ?? solUsd;
    } catch {
      /* keep last */
    }
  };
  refreshSol();
  const solTimer = setInterval(refreshSol, 60_000);

  const auth = new Auth(db, cfg.brand.name);
  const pruneTimer = setInterval(() => auth.pruneNonces(), 60_000);

  const app = await buildApi({
    cfg,
    engine,
    auth,
    oracle,
    rewards,
    vault: vault?.publicKey.toBase58() ?? null,
    solUsd: () => solUsd,
    staticDir: process.env.STATIC_DIR ?? "../web/dist",
    hl,
    status: () => ({
      hyperliquid: hl ? { error: hl.lastError, lastPoll: hl.lastPoll, routable: hl.all().filter((l) => l.routable).map((l) => l.coin) } : null,
      oracle: { error: oracle.lastError, tracked: prices.mints().length },
      deposits: deposits ? { error: deposits.lastError } : null,
      withdrawals: withdrawals ? { error: withdrawals.lastError } : null,
      creatorFees: sweeper ? { error: sweeper.lastError, lastSweep: sweeper.lastSweep } : null,
      holders: tracker ? { error: tracker.lastError, count: tracker.lastCount } : null,
      seeder: { error: seeder.lastError },
      audit: auditor.last,
    }),
  });
  await app.listen({ port: cfg.port, host: "0.0.0.0" });
  console.log(`[${cfg.brand.name}] listening on :${cfg.port} real=${cfg.realEnabled} vault=${vault?.publicKey.toBase58() ?? "-"}`);

  const shutdown = async () => {
    clearInterval(tickTimer);
    clearInterval(solTimer);
    clearInterval(pruneTimer);
    oracle.stop();
    seeder.stop();
    deposits?.stop();
    withdrawals?.stop();
    sweeper?.stop();
    tracker?.stop();
    auditor.stop();
    hl?.stop();
    await app.close();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
