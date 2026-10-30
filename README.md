# Flip

Long or short any Solana coin at 2x, 5x or 10x. Coins that also trade as a Hyperliquid perp route to Hyperliquid's order book from the same ticket: non-custodial, no pool on the other side, and Flip earns a builder fee. Everything else fills instantly against a house pool, on the same model as useinverse.xyz, with a pump.fun token whose creator fees and trading fees pay holders.

## Run it

```bash
npm run install:all
npm test            # 44 tests: engine math, solvency, auth, holder rewards, deposits, Hyperliquid links and order math
npm run demo        # http://localhost:8787 with simulated markets and bot traders
```

For development, run `npm --prefix server run dev` and `npm --prefix web run dev` (Vite proxies `/api` and `/ws`).

## How it works

**The book.** Users deposit SOL to a vault wallet. The server credits the sender, keeps a double-entry ledger in SQLite, and settles trades against a pool. Trades are signed messages, so nothing is sent from the user's wallet. One wallet signature authorizes a 24h browser session key that can trade but can never withdraw. Withdrawals always need a wallet signature.

**Prices.** These are read from each coin's own pool on-chain, every second for coins with open positions or recent viewers:

| Venue | Source |
|---|---|
| pump.fun curve | Virtual reserves |
| PumpSwap | Vault balances plus virtual quote reserves |
| Raydium AMM v4 / CPMM | Vault balances net of pending fees |

Curves that graduate switch to their PumpSwap pool automatically. Anything else falls back to Jupiter's price API and is labelled that way.

**Trading rules** (`server/src/config.ts`):

| Rule | Value |
|---|---|
| Leverage | 2x, 5x, 10x |
| Limits | Max win +200%, max loss −100%; positions auto-close at either end |
| Fills | Worse of the live price and its 30s TWAP, plus a 0.25% spread, so a one-second wick can't be farmed |
| Minimum hold | 10s |
| Minimum trade | 0.01 SOL |
| Close-only | Coins under 50 SOL of liquidity |
| Size cap per side per coin | Smallest of 5 SOL, 2% of the coin's liquidity, and 10% of the pool |
| Pool solvency | Only takes a trade if it can pay every open position's maximum win |

The pool's maximum-win check nets longs against shorts on the same coin. It uses the exact worst case over all future prices, and is tested against a brute-force price sweep.

**Fees and where they go:**

| Revenue | Pool | Holders | Treasury |
|---|---|---|---|
| Profit fee (3% of profit, plus spread) | 60% | 25% | 15% |
| $TOKEN creator fees (claimed from pump.fun automatically) | 50% | 40% | 10% |

Inverse sends 80% of both to its pool and nothing to holders.

### Hyperliquid route

A coin with the **HL perp** tag has two tabs in the ticket: **Hyperliquid** (the default) and **Flip pool**.

- **Non-custodial.** Orders trade the user's own Hyperliquid account in USDC. Flip never holds the funds.
- **Wallet.** Any injected EVM wallet works. Phantom's Ethereum address is a Hyperliquid account, and MetaMask and Rabby work too.
- **One-time setup, two signatures, no gas.**
  1. Approve Flip's builder fee cap (`approveBuilderFee`).
  2. Approve a trading key generated in the browser (`approveAgent`, named "Flip").

  The key signs orders without popups. Hyperliquid doesn't let agent keys withdraw, and deposits and withdrawals always go through the wallet.
- **Orders.** Market orders are immediate-or-cancel limits at mid ± `HL_SLIPPAGE`. Positions use isolated margin at the chosen leverage. The minimum is $10 notional, which Hyperliquid enforces.
- **Builder fee.** The fee (`HL_BUILDER_FEE`, in tenths of a basis point, default 50 = 0.05%) is added to every fill. $FLIP tiers cut it by the same discount as the profit fee.
- **Deposits.** Deposits send USDC on Arbitrum to Hyperliquid's bridge from the ticket. The ticket refuses anything under 5 USDC, because the bridge loses it.
- **Which coins route.** A coin routes only through an explicit mint → perp map (`server/src/hl/link.ts`, extend with `HL_MAP`), and only while the coin's on-chain price and the perp's mark agree within `HL_MAX_DIVERGENCE` (3%) on consecutive checks.
  - A ticker match is never trusted on its own.
  - The route turns off if the prices drift apart, the perp is delisted, or Hyperliquid stops answering.
  - `/api/hl` shows every link and why it is on or off.

Builder fees accrue in USDC on Hyperliquid, not in the SOL book. Claim them from the builder address through Hyperliquid's referral rewards. Routing them into the holder pot is a manual step for now.

### Holder moat

1. **SOL yield for holders.** Every 24h, 80% of the holder pot is paid out by time-weighted balance. The other 20% rolls over to smooth payouts.
   - Wallets are snapshotted every 5 minutes.
   - Program-owned accounts (curve, pool, lockers) are excluded automatically.
   - One wallet's weight is capped at 3% of supply, which limits what the dev or a whale can capture.
   - Payouts land in the holder's balance on the site. Holders don't need to have used the site first.
2. **Tiers** (1M / 5M / 10M tokens) cut the profit fee from 3% to 2% / 1.5% / 1%.
   - Your tier is the lower of what you hold now and your average over the last full epoch, so buying right before a trade doesn't count.
3. **Rekt rebate.** Tiered holders get 2% / 4% / 6% of their *net* epoch trading loss back, up to 1 SOL each.
   - Losses are netted across the whole epoch, so a hedged long+short pair earns nothing.
4. **Fade and Copy.** Every open on the live tape has one-click buttons to take the opposite side or the same side.

### Safety rails

- **Withdrawals are crash-safe.** The signature and expiry are stored before broadcast. A withdrawal is only retried after its blockhash has provably expired, so it can't be sent twice.
- **A solvency audit runs every 15s.** It checks internal conservation (every lamport accounted for), then compares the vault's on-chain balance to what the book owes. On any shortfall it halts real trading and withdrawals. Auto-close keeps settling positions during a halt.
- **Real money is off by default** (`REAL_ENABLED=false`). Practice mode uses an isolated paper book with the same rules and real prices.
- **Admin tools.** The admin CLI can halt, resume, settle positions, delist coins and check the book: `npm --prefix server run admin -- book`.

## Go-live runbook

1. **Get a paid RPC** (Helius or similar). Put it in `server/.env` as `RPC_URL` and in `web/.env` as `VITE_RPC_URL`.
2. **Generate wallets.** In `server`, run `npm run keygen`. This writes `keys/vault.json` and `keys/creator.json`. Back them up offline. They must be different wallets.
3. **Launch the token on pump.fun from the creator wallet.** Import `keys/creator.json` into Phantom and launch with it, so creator fees accrue to a key the server holds. Set `TOKEN_MINT`.
4. **Verify the price readers on mainnet.** Run `npm run verify-oracle -- <curve coin> <PumpSwap coin> <Raydium coin>`. Every diff should be under 2%.
5. **Run Practice on mainnet prices first.** Use `REAL_ENABLED=false` for at least a few days and watch `/api/status` for oracle, holder or audit errors.
6. **Go live with tight limits.** Fund the vault with about 0.1 SOL for fees, then set `REAL_ENABLED=true`.
   - Keep `MAX_SIDE_SOL` and `MAX_WITHDRAW_SOL` small at first.
   - Seed the pool yourself: deposit to the vault from your wallet, then use Pool → Add.
7. **Turn on builder fees.** Set `HL_BUILDER` to an EVM address you control. It needs at least 100 USDC of perps account value on Hyperliquid, or orders carrying the fee are rejected. Without it, the route still works with no fee.
8. **Run behind HTTPS** (Caddy or nginx) with `CORS_ORIGIN` set to your domain. Back up `data/flip.db` continuously, for example with Litestream.

## What's verified and what isn't

**Hyperliquid route.**

- Signing is verified byte for byte against Hyperliquid's official Python SDK.
  - This covers every action the browser signs: builder approval, agent approval, leverage, orders with the builder code, withdrawal, and spot→perps transfer.
  - Reproduce with: `node web/scripts/hl-signing-capture.mjs > /tmp/hl.json && python3 scripts/hl_verify_signing.py /tmp/hl.json`.
- The full UI flow passes in a headless browser against `scripts/mock_hyperliquid.py`. That covers connect, deposit, setup, long, close, and the builder fee being charged.
  - The mock checks signatures with the official SDK's recovery code.
  - Run it with `scripts/hl_e2e.py`.
- Not yet run against Hyperliquid mainnet, because this sandbox can't reach it. Before launch:
  - Check `/api/hl` on the live server and confirm the expected coins show `verified`.
  - Place one minimum-size trade from a real wallet, including Phantom.
  - Confirm Phantom can switch to Arbitrum for the deposit. If it can't, users can deposit at app.hyperliquid.xyz to the same address.

**Pool route.**

- **Verified.** Everything off-chain:
  - The full engine, with a 600-step randomized stress test: book conservation, reserves always covered.
  - Signed-message auth, session keys and replay rejection.
  - Holder epochs, rebates and deposit parsing.
  - The API, and every page rendering against a live demo server.
  - The browser signing library, run end to end against the server.
- **Not yet verified against mainnet.** This sandbox has no Solana network access:
  - The on-chain account readers.
  - Deposit/withdrawal transactions.
  - Creator-fee claims.

  The pump.fun decoding uses pump.fun's official SDKs. The Raydium readers check that both mints in the account match before trusting the layout, and fall back to Jupiter otherwise. Steps 4–5 above exist to close this gap before any real SOL moves.

## Risks you're taking on

- **Custody.** This is custodial. The hot wallet key is the whole treasury, so if the server is compromised, users' funds are gone. Before real volume, keep the vault balance low and move excess to cold storage. An audit is worth considering.
- **Pool risk.** The pool can lose: if traders win, LP share value drops.
- **Hyperliquid route.** Users trade real USDC even while the site is in Practice mode; the ticket labels it. Agent keys live in browser storage like the pool's session keys: an XSS bug could place trades (not withdraw) for connected users, so keep the frontend's dependencies tight.
- **Legal exposure.** House-banked leveraged long/short betting for the public is likely to be treated as unregistered derivatives or gambling in the US, and Washington is strict on online gambling. Talk to a lawyer before taking real money. Geoblocking US users is the usual minimum.
