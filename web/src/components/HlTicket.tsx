import { useEffect, useMemo, useState } from "react";
import { useApp } from "../lib/store";
import { useHl } from "../lib/hl";
import type { HlLink, Market } from "../lib/api";
import { estLiquidation, leverageChoices, maintenanceFrac, MIN_DEPOSIT_USDC, MIN_NOTIONAL_USD } from "../lib/hlOrders";
import { usdPx, usd2 } from "../lib/format";

interface Props {
  market: Market;
  link: HlLink;
  tier: number;
  initialSide?: "long" | "short";
}

/** Order ticket for the Hyperliquid route. Trades the user's own Hyperliquid account. */
export default function HlTicket({ market, link, tier, initialSide = "long" }: Props) {
  const { config } = useApp();
  const hl = useHl();
  const [side, setSide] = useState<"long" | "short">(initialSide);
  const levs = useMemo(() => leverageChoices(config?.leverages ?? [2, 5, 10], link.maxLeverage), [config?.leverages, link.maxLeverage]);
  const [leverage, setLeverage] = useState(() => levs.find((l) => l >= 5) ?? levs[levs.length - 1] ?? 1);
  const [amount, setAmount] = useState("20");
  const [depAmount, setDepAmount] = useState("");

  useEffect(() => setSide(initialSide), [initialSide, market.mint]);
  useEffect(() => {
    if (!levs.includes(leverage)) setLeverage(levs.find((l) => l >= 5) ?? levs[levs.length - 1] ?? 1);
  }, [levs, leverage]);

  const existing = hl.account?.positions.find((p) => p.coin === link.coin) ?? null;
  const effLev = existing ? existing.leverage : leverage;
  const mid = Number(hl.mids[link.coin]) || link.midPx || link.markPx || 0;
  const margin = Number(amount) || 0;
  const notional = margin * effLev;
  const avail = hl.account?.withdrawable ?? 0;
  const discount = config?.tiers[tier]?.feeDiscountBps ?? 0;
  const feeTenths = hl.feeFor(discount);
  const builderPct = feeTenths / 1000;
  const takerPct = hl.takerRate !== null ? hl.takerRate * 100 : null;
  const est = mid > 0 ? estLiquidation(mid, side === "long", effLev, maintenanceFrac(link.maxLeverage)) : null;
  const unit = link.mult > 1 ? `1 ${link.coin} = ${link.mult.toLocaleString()} ${market.symbol}` : null;
  const realBadge = <span className="hl-real">{(import.meta as any).env?.VITE_DEMO === "true" ? "Demo USDC" : "Real USDC"}</span>;

  const head = (
    <div className="hl-head">
      <span className="hl-coin">
        {link.coin}-USD <span className="faint">perp</span>
      </span>
      <span className="spacer" />
      {realBadge}
    </div>
  );

  if (!link.routable) {
    const why: Record<string, string> = {
      checking: "Checking that this coin's Solana price matches the Hyperliquid perp…",
      price_mismatch: `The Solana price and the ${link.coin} perp disagree by more than ${((hl.cfg?.maxDivergence ?? 0.03) * 100).toFixed(0)}%, so routing is off for safety.`,
      no_flip_price: "Waiting for this coin's Solana price to compare against Hyperliquid.",
      not_listed: `${link.coin} isn't listed on Hyperliquid right now.`,
      delisted: `${link.coin} was delisted on Hyperliquid.`,
      verified: "Routing is paused.",
    };
    return (
      <div className="hl-ticket">
        {head}
        <p className="ticket-block">{why[link.state] ?? "Routing is off."}</p>
      </div>
    );
  }

  if (hl.status === "no_wallet" || hl.status === "disconnected") {
    return (
      <div className="hl-ticket">
        {head}
        <p className="hl-pitch">
          Trade {market.symbol} on Hyperliquid's order book from your own account. Flip never holds your funds, and there's no pool on the other side.
        </p>
        <button className="btn btn-block btn-primary" onClick={hl.connect}>
          Connect EVM wallet
        </button>
        <p className="fine">Phantom works: its Ethereum address is your Hyperliquid account. MetaMask and Rabby work too.</p>
      </div>
    );
  }

  if (hl.status === "loading") {
    return (
      <div className="hl-ticket">
        {head}
        <p className="empty-inline">Loading your Hyperliquid account…</p>
      </div>
    );
  }

  if (hl.status === "needs_deposit") {
    const ok = Number(depAmount) >= MIN_DEPOSIT_USDC;
    return (
      <div className="hl-ticket">
        {head}
        <p className="hl-pitch">Your Hyperliquid account is empty. Deposit USDC from Arbitrum to start.</p>
        <div className="size-box">
          <label htmlFor="hl-dep">Deposit</label>
          <input id="hl-dep" inputMode="decimal" autoComplete="off" placeholder={`min ${MIN_DEPOSIT_USDC}`} value={depAmount} onChange={(e) => setDepAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span className="unit">USDC</span>
        </div>
        <button className="btn btn-block btn-primary" disabled={!ok || hl.busy === "deposit"} onClick={() => hl.deposit(depAmount)}>
          {hl.busy === "deposit" ? "Confirm in wallet…" : ok ? `Deposit ${depAmount} USDC` : `Minimum ${MIN_DEPOSIT_USDC} USDC`}
        </button>
        <p className="fine">
          Sends USDC on Arbitrum to Hyperliquid's bridge. It's credited to this same address in about a minute. Under {MIN_DEPOSIT_USDC} USDC is lost, so the button won't send less. You can also deposit at app.hyperliquid.xyz.
        </p>
        <Acct />
      </div>
    );
  }

  if (hl.status === "needs_setup") {
    const two = !!hl.cfg?.builder && (hl.cfg?.builderFee ?? 0) > 0;
    return (
      <div className="hl-ticket">
        {head}
        <ol className="hl-steps">
          {two && <li>Approve Flip's fee cap: at most {((hl.cfg!.builderFee ?? 0) / 1000).toFixed(3)}% per trade.</li>}
          <li>Approve a trading key made in this browser. It can place and close orders. It can't withdraw.</li>
        </ol>
        <button className="btn btn-block btn-primary" disabled={hl.busy === "setup"} onClick={hl.setup}>
          {hl.busy === "setup" ? "Confirm in wallet…" : two ? "Turn on trading (2 signatures)" : "Turn on trading"}
        </button>
        <p className="fine">Signatures only, no gas. After this, orders go through without wallet popups.</p>
        <Acct />
      </div>
    );
  }

  // ready
  const tooSmall = notional < MIN_NOTIONAL_USD;
  const overBal = margin > avail;
  const label =
    hl.busy === "open"
      ? "Placing…"
      : !mid
        ? "Waiting for price"
        : tooSmall
          ? `Min $${(MIN_NOTIONAL_USD / effLev).toFixed(2)} at ${effLev}x`
          : overBal
            ? "Not enough USDC"
            : `${side === "long" ? "Long" : "Short"} ${link.coin} ${effLev}x`;
  const setPct = (p: number) => setAmount(avail > 0 ? String(Math.floor(((avail * p) / 100) * 100) / 100) : "0");
  const pctOfMax = avail > 0 ? Math.min(100, Math.round((margin / avail) * 100)) : 0;

  return (
    <div className="hl-ticket">
      {head}
      <div className="side-tabs" role="radiogroup" aria-label="Side">
        {(["long", "short"] as const).map((s) => (
          <button key={s} role="radio" aria-checked={side === s} className={`${s} ${side === s ? "on" : ""}`} onClick={() => setSide(s)}>
            {s === "long" ? "Long" : "Short"}
          </button>
        ))}
      </div>
      <div className="kv">
        <span>Available</span>
        <span className="mono">{usd2(avail)} USDC</span>
      </div>
      {existing ? (
        <p className="ticket-note">
          You have a {existing.side} open at {existing.leverage}x {existing.leverageType}. New orders add to it at that leverage.
        </p>
      ) : (
        <div className="lev-row" role="radiogroup" aria-label="Leverage">
          {levs.map((l) => (
            <button key={l} role="radio" aria-checked={l === leverage} className={l === leverage ? "on" : ""} onClick={() => setLeverage(l)}>
              {l}x
            </button>
          ))}
        </div>
      )}
      <div className="size-box">
        <label htmlFor="hl-size">Margin</label>
        <input id="hl-size" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="unit">USDC</span>
      </div>
      <div>
        <div className="slider">
          <input type="range" min={0} max={100} step={1} value={pctOfMax} onChange={(e) => setPct(Number(e.target.value))} aria-label="Margin as a share of available USDC" disabled={avail <= 0} />
          <span className="pct-out">{pctOfMax}%</span>
        </div>
        <div className="slider-ticks">
          {[0, 25, 50, 75, 100].map((p) => (
            <button key={p} onClick={() => setPct(p)} disabled={avail <= 0}>
              {p}%
            </button>
          ))}
        </div>
      </div>
      <button
        className={`btn btn-block btn-${side}`}
        disabled={hl.busy === "open" || !mid || tooSmall || overBal}
        onClick={() => hl.open({ coin: link.coin, asset: link.asset, szDecimals: link.szDecimals, isBuy: side === "long", marginUsd: margin, leverage: effLev, isolated: !existing, discountBps: discount })}
      >
        {label}
      </button>
      <div className="ticket-summary">
        <div className="kv">
          <span>Mark</span>
          <span className="mono">{usdPx(mid)}</span>
        </div>
        <div className="kv">
          <span>Position size</span>
          <span className="mono">{usd2(notional)}</span>
        </div>
        {est && !existing && (
          <div className="kv">
            <span>Est. liquidation</span>
            <span className="mono t-short">{usdPx(est)}</span>
          </div>
        )}
        <div className="kv">
          <span>Fees</span>
          <span className="mono">
            {takerPct !== null ? `${takerPct.toFixed(3)}%` : "HL taker"} + {builderPct.toFixed(3)}% Flip
            {tier > 0 && builderPct > 0 && <span className="tier-tag"> {config?.tiers[tier].name}</span>}
          </span>
        </div>
        {link.funding !== null && (
          <div className="kv">
            <span>Funding / 1h</span>
            <span className="mono">{(link.funding * 100).toFixed(4)}%</span>
          </div>
        )}
        {unit && <p className="fine">{unit}</p>}
      </div>
      <p className="fine">
        Market order: fills on Hyperliquid's book within {((hl.cfg?.slippage ?? 0.03) * 100).toFixed(0)}% of mid or not at all. Isolated margin, so you can't lose more than the margin on this coin.
      </p>
      <Acct />
    </div>
  );
}

function Acct() {
  const hl = useHl();
  const [wd, setWd] = useState("");
  const [dep, setDep] = useState("");
  const [open, setOpen] = useState(false);
  if (!hl.user) return null;
  const a = hl.account;
  return (
    <div className="account-box hl-acct">
      <h3>
        Hyperliquid account
        <button className="link-btn" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Funds"}
        </button>
      </h3>
      <div className="kv">
        <span>Address</span>
        <span className="mono">
          {hl.user.slice(0, 6)}…{hl.user.slice(-4)}
        </span>
      </div>
      <div className="kv">
        <span>Perps equity</span>
        <span className="mono">{a ? `${usd2(a.accountValue)}` : "–"}</span>
      </div>
      {a && a.spotUsdc > 0.01 && (
        <div className="kv">
          <span>Spot USDC</span>
          <span className="mono">{usd2(a.spotUsdc)}</span>
        </div>
      )}
      {open && (
        <div className="hl-funds">
          {hl.status !== "needs_deposit" && (
            <>
              <div className="size-box">
                <label htmlFor="hl-dep2">Deposit</label>
                <input id="hl-dep2" inputMode="decimal" autoComplete="off" value={dep} onChange={(e) => setDep(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={`min ${MIN_DEPOSIT_USDC}`} />
                <span className="unit">USDC</span>
              </div>
              <button className="btn btn-sm" disabled={!!hl.busy || Number(dep) < MIN_DEPOSIT_USDC} onClick={() => hl.deposit(dep).then((ok) => ok && setDep(""))}>
                {hl.busy === "deposit" ? "Confirm in wallet…" : "Deposit from Arbitrum"}
              </button>
            </>
          )}
          {a && a.spotUsdc > 0.01 && (
            <button className="btn btn-sm" disabled={!!hl.busy} onClick={() => hl.toPerps(String(Math.floor(a.spotUsdc * 100) / 100))}>
              Move {usd2(Math.floor(a.spotUsdc * 100) / 100)} spot USDC to perps
            </button>
          )}
          <div className="size-box">
            <label htmlFor="hl-wd">Withdraw</label>
            <input id="hl-wd" inputMode="decimal" autoComplete="off" value={wd} onChange={(e) => setWd(e.target.value.replace(/[^0-9.]/g, ""))} placeholder={a ? String(Math.floor(a.withdrawable * 100) / 100) : ""} />
            <span className="unit">USDC</span>
          </div>
          <button className="btn btn-sm" disabled={!!hl.busy || !(Number(wd) > 1)} onClick={() => hl.withdraw(wd).then((ok) => ok && setWd(""))}>
            {hl.busy === "withdraw" ? "Confirm in wallet…" : "Withdraw to Arbitrum"}
          </button>
          <p className="fine">Withdrawals are signed by your wallet, never the trading key. Hyperliquid charges $1.</p>
          <button className="link-btn" onClick={hl.disconnect}>
            Disconnect this account
          </button>
        </div>
      )}
    </div>
  );
}
