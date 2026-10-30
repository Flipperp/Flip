import "dotenv/config";

const LAMPORTS = 1_000_000_000;
const num = (k: string, d: number) => (process.env[k] !== undefined ? Number(process.env[k]) : d);
const str = (k: string, d = "") => process.env[k] ?? d;
const bool = (k: string, d: boolean) => (process.env[k] !== undefined ? process.env[k] === "true" : d);

export type Mode = "real" | "paper";

export const config = {
  brand: {
    name: str("BRAND_NAME", "flip"),
    ticker: str("TOKEN_TICKER", "FLIP"),
  },
  port: num("PORT", 8787),
  dbPath: str("DB_PATH", "./data/flip.db"),
  rpcUrl: str("RPC_URL", "https://api.mainnet-beta.solana.com"),
  wsRpcUrl: str("WS_RPC_URL", ""),
  /** Real-money trading. When false, only Practice (paper) mode works. */
  realEnabled: bool("REAL_ENABLED", false),
  /** Base58 secret key (or path to a JSON keypair file) of the vault hot wallet. */
  vaultSecret: str("VAULT_SECRET"),
  /** Base58 secret key (or JSON file) of the pump.fun creator wallet for the project token. */
  creatorSecret: str("CREATOR_SECRET"),
  /** The project token mint (launched on pump.fun). */
  tokenMint: str("TOKEN_MINT"),
  /** Wallets excluded from holder rewards (team, treasury, CEX, etc.), comma separated. */
  holderExclusions: str("HOLDER_EXCLUSIONS").split(",").map((s) => s.trim()).filter(Boolean),
  adminKey: str("ADMIN_KEY"),
  /** Solana wallet whose SOL transfers to the vault are paid entirely to token holders. */
  holderFundWallet: str("HOLDER_FUND_WALLET").trim(),
  corsOrigin: str("CORS_ORIGIN", "*"),

  trading: {
    leverages: [2, 5, 10] as number[],
    /** Max win as a multiple of stake (+200%). */
    maxWinMult: 2,
    /** Spread applied to every fill, in basis points. */
    spreadBps: num("SPREAD_BPS", 25),
    /** Profit fee in bps, before holder tier discount. */
    profitFeeBps: num("PROFIT_FEE_BPS", 300),
    twapWindowMs: 30_000,
    minTwapSamples: 20,
    minHoldMs: 10_000,
    minStake: Math.round(0.01 * LAMPORTS),
    /** Absolute cap per side per coin. */
    maxSidePerCoin: Math.round(num("MAX_SIDE_SOL", 5) * LAMPORTS),
    /** Per-side cap as a fraction of the coin's SOL liquidity. */
    sideCapLiquidityFrac: num("SIDE_CAP_LIQ_FRAC", 0.02),
    /** Per-side cap as a fraction of pool cash. */
    sideCapPoolFrac: num("SIDE_CAP_POOL_FRAC", 0.1),
    minLiquidity: Math.round(num("MIN_LIQ_SOL", 50) * LAMPORTS),
    /** Prices older than this block trading on the coin. */
    staleMs: 10_000,
    /** Max open positions per wallet. */
    maxOpenPerWallet: 25,
  },

  /** Where revenue goes. Each split must sum to 10_000 bps. */
  splits: {
    profitFee: { pool: 6000, holders: 2500, treasury: 1500 },
    creatorFee: { pool: 5000, holders: 4000, treasury: 1000 },
  },

  /** Holder tiers by time-weighted token balance (UI token units). */
  tiers: [
    { name: "None", minTokens: 0, feeDiscountBps: 0, rebateBps: 0 },
    { name: "Holder", minTokens: num("TIER1_TOKENS", 1_000_000), feeDiscountBps: 3333, rebateBps: 200 },
    { name: "Whale", minTokens: num("TIER2_TOKENS", 5_000_000), feeDiscountBps: 5000, rebateBps: 400 },
    { name: "Diamond", minTokens: num("TIER3_TOKENS", 10_000_000), feeDiscountBps: 6667, rebateBps: 600 },
  ],
  /**
   * Rekt rebate: at each epoch close, a holder whose net realized trading P&L for the epoch is
   * negative gets rebateBps of that net loss back from the holder pot. Netting per epoch means a
   * hedged long+short pair earns nothing.
   */
  rebate: {
    maxPerWalletPerEpoch: Math.round(1 * 1_000_000_000),
    /** Rebates may use at most this fraction of the epoch's holder payout. */
    maxPotFrac: 0.3,
  },

  holders: {
    snapshotEveryMs: num("HOLDER_SNAPSHOT_MS", 5 * 60_000),
    epochMs: num("HOLDER_EPOCH_MS", 24 * 3600_000),
    /** A single wallet's weight is capped at this share of supply (limits dev/whale capture). */
    maxWeightSupplyFrac: 0.03,
    minPayout: 10_000,
    /** Fraction of the holder pot paid out each epoch (rest rolls over to smooth yield). */
    payoutFrac: 0.8,
  },

  custody: {
    /** Lamports kept in the vault for rent + tx fees, never counted as liabilities. */
    vaultReserve: Math.round(0.05 * LAMPORTS),
    minDeposit: Math.round(0.005 * LAMPORTS),
    maxWithdrawal: Math.round(num("MAX_WITHDRAW_SOL", 50) * LAMPORTS),
    dailyWithdrawalPerWallet: Math.round(num("DAILY_WITHDRAW_SOL", 100) * LAMPORTS),
    /** Allowed drift between on-chain vault balance and the book before halting. */
    auditToleranceLamports: num("AUDIT_TOLERANCE", 100_000),
    commitment: "confirmed" as const,
  },

  /**
   * Hyperliquid route: coins with a Hyperliquid perp can be traded on Hyperliquid's order book from
   * the same ticket. Non-custodial; Flip earns a builder fee on routed volume.
   */
  hl: {
    enabled: bool("HL_ENABLED", true),
    testnet: bool("HL_TESTNET", false),
    apiUrl: str("HL_API_URL", bool("HL_TESTNET", false) ? "https://api.hyperliquid-testnet.xyz" : "https://api.hyperliquid.xyz"),
    /** EVM address that receives builder fees. Needs at least 100 USDC of perps account value on Hyperliquid. Empty = no fee. */
    builder: str("HL_BUILDER").toLowerCase(),
    /** Builder fee in tenths of a basis point (50 = 0.05%). Hyperliquid caps perps at 100 (0.1%). */
    builderFee: Math.min(100, Math.max(0, Math.round(num("HL_BUILDER_FEE", 50)))),
    /** Extra or overriding links, "mint:COIN[:mult]" comma separated. "mint:-" removes a default. */
    map: str("HL_MAP"),
    pollMs: num("HL_POLL_MS", 15_000),
    /** A link only routes while the Solana price and the Hyperliquid mark are within this fraction. */
    maxDivergence: num("HL_MAX_DIVERGENCE", 0.03),
    confirmChecks: num("HL_CONFIRM_CHECKS", 2),
    /** Slippage bound for market orders, as a fraction of mid. */
    slippage: num("HL_SLIPPAGE", 0.03),
  },

  paper: {
    faucetAmount: Math.round(5 * LAMPORTS),
    faucetCooldownMs: 24 * 3600_000,
    seedPool: Math.round(1000 * LAMPORTS),
  },
  LAMPORTS,
};

export type Config = typeof config;

for (const [name, s] of Object.entries(config.splits)) {
  const sum = s.pool + s.holders + s.treasury;
  if (sum !== 10_000) throw new Error(`split ${name} must sum to 10000 bps, got ${sum}`);
}
