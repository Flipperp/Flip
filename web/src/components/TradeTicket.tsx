import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useApp } from "../lib/store";
import type { Market, PositionV } from "../lib/api";
import { LAMPORTS, price, sol } from "../lib/format";

interface Props {
  market: Market;
  balance: number | null;
  tier: number;
  initialSide?: "long" | "short";
  origin?: string;
  onOpened?: (p: PositionV) => void;
}

export default function TradeTicket({ market, balance, tier, initialSide = "long", origin, onOpened }: Props) {
  const { config, mode, act, wallet } = useApp();
  const { setVisible } = useWalletModal();
  const [side, setSide] = useState<"long" | "short">(initialSide);
  const [leverage, setLeverage] = useState(5);
  const [amount, setAmount] = useState("0.1");
  const [busy, setBusy] = useState(false);
  const lockedSide = !!origin && origin !== "direct";

  useEffect(() => setSide(initialSide), [initialSide, market.mint]);
  useEffect(() => {
    if (config && !config.leverages.includes(leverage)) setLeverage(config.leverages[0]);
  }, [config, leverage]);

  const stake = Math.round((Number(amount) || 0) * LAMPORTS);
  const room = side === "long" ? market.roomLong : market.roomShort;
  const maxStake = Math.max(0, Math.min(balance ?? 0, room));
  const pctOfMax = maxStake > 0 ? Math.min(100, Math.round((stake / maxStake) * 100)) : 0;

  const est = useMemo(() => {
    if (!config || !market.price || !market.twap) return null;
    const s = config.spreadBps / 10_000;
    const hi = Math.max(market.price, market.twap);
    const lo = Math.min(market.price, market.twap);
    const entry = side === "long" ? hi * (1 + s) : lo * (1 - s);
    const maxWinAt = side === "long" ? entry * (1 + config.maxWinMult / leverage) : entry * (1 - config.maxWinMult / leverage);
    const liqAt = side === "long" ? entry * (1 - 1 / leverage) : entry * (1 + 1 / leverage);
    const discount = config.tiers[tier]?.feeDiscountBps ?? 0;
    const feeBps = (config.profitFeeBps * (10_000 - discount)) / 10_000;
    const maxProfit = stake * config.maxWinMult;
    const maxPayout = stake + maxProfit - Math.ceil((maxProfit * feeBps) / 10_000);
    return { entry, maxWinAt, liqAt, feeBps, maxPayout };
  }, [config, market.price, market.twap, side, leverage, stake, tier]);

  if (!config) return null;
  const tooSmall = stake < config.minStake;
  const overRoom = stake > room;
  const overBal = balance !== null && stake > balance;
  const halted = !!config.halted?.[mode];
  const blocked = !market.tradable
    ? market.reason === "too_thin"
      ? `Under ${sol(config.minLiquidity, 0)} SOL of liquidity, so this coin is close-only.`
      : market.reason === "warming_up"
        ? "Building the 30-second price average. Trading opens in a few seconds."
        : halted
          ? "Trading is paused."
          : "Price unavailable right now."
    : null;

  const setPct = (p: number) => setAmount(maxStake > 0 ? String(Math.floor(((maxStake * p) / 100 / LAMPORTS) * 1000) / 1000) : "0");

  const submit = async () => {
    if (!wallet) return setVisible(true);
    setBusy(true);
    const r = await act<{ position: PositionV }>(
      { action: "open", mode, mint: market.mint, side, leverage, stake, origin: lockedSide ? origin : undefined },
      { success: `${side === "long" ? "Long" : "Short"} ${leverage}x opened on $${market.symbol}` },
    );
    setBusy(false);
    if (r?.position) onOpened?.(r.position);
  };

  const label = !wallet
    ? "Connect wallet"
    : busy
      ? "Placing…"
      : tooSmall
        ? `Minimum ${sol(config.minStake, 2)} SOL`
        : overRoom
          ? `Only ${sol(room)} SOL of room`
          : overBal
            ? mode === "paper"
              ? "Not enough paper SOL"
              : "Not enough balance"
            : `${side === "long" ? "Long" : "Short"} $${market.symbol} ${leverage}x`;

  return (
    <section className="ticket" aria-label="Order ticket">
      <div className="side-tabs" role="radiogroup" aria-label="Side">
        {(["long", "short"] as const).map((s) => (
          <button key={s} role="radio" aria-checked={side === s} className={`${s} ${side === s ? "on" : ""}`} onClick={() => !lockedSide && setSide(s)} disabled={lockedSide && side !== s}>
            {s === "long" ? "Long" : "Short"}
          </button>
        ))}
      </div>
      {lockedSide && (
        <p className="ticket-note">
          {origin!.startsWith("fade") ? "Fading a trade from the tape: you take the other side." : "Copying a trade from the tape: same side."}{" "}
          <Link to={`/trade/${market.mint}`}>Clear</Link>
        </p>
      )}

      <div className="kv">
        <span>Available</span>
        <span>{balance === null ? "–" : `${sol(balance)} SOL`}</span>
      </div>

      <div className="lev-row" role="radiogroup" aria-label="Leverage">
        {config.leverages.map((l) => (
          <button key={l} role="radio" aria-checked={l === leverage} className={l === leverage ? "on" : ""} onClick={() => setLeverage(l)}>
            {l}x
          </button>
        ))}
      </div>

      <div className="size-box">
        <label htmlFor="stake">Size</label>
        <input id="stake" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="unit">SOL</span>
      </div>
      <div>
        <div className="slider">
          <input type="range" min={0} max={100} step={1} value={pctOfMax} onChange={(e) => setPct(Number(e.target.value))} aria-label="Size as a share of what you can open" disabled={maxStake <= 0} />
          <span className="pct-out">{pctOfMax}%</span>
        </div>
        <div className="slider-ticks">
          {[0, 25, 50, 75, 100].map((p) => (
            <button key={p} onClick={() => setPct(p)} disabled={maxStake <= 0}>
              {p}%
            </button>
          ))}
        </div>
      </div>

      {blocked ? (
        <p className="ticket-block">{blocked}</p>
      ) : (
        <button className={`btn btn-block btn-${side}`} onClick={submit} disabled={busy || (!!wallet && (tooSmall || overRoom || overBal || halted))}>
          {label}
        </button>
      )}

      {est && (
        <div className="ticket-summary">
          <div className="kv">
            <span>Est. fill</span>
            <span>{price(est.entry)}</span>
          </div>
          <div className="kv">
            <span>Liquidation</span>
            <span className="t-short">{price(est.liqAt)}</span>
          </div>
          <div className="kv">
            <span>Max win at</span>
            <span className="t-long">{est.maxWinAt > 0 ? price(est.maxWinAt) : "zero"}</span>
          </div>
          <div className="kv">
            <span>Best case back</span>
            <span>{sol(est.maxPayout)} SOL</span>
          </div>
          <div className="kv">
            <span>Profit fee</span>
            <span>
              {(est.feeBps / 100).toFixed(2)}%{tier > 0 && <span className="tier-tag"> {config.tiers[tier].name}</span>}
            </span>
          </div>
          <div className="kv">
            <span>Room on {side}</span>
            <span>{sol(room)} SOL</span>
          </div>
        </div>
      )}
      <p className="fine">
        Fills use the worse of the live price and its 30s average, plus {(config.spreadBps / 100).toFixed(2)}% spread. Closes itself at +{config.maxWinMult * 100}% or −100%. You can close after {config.minHoldMs / 1000}s and never owe more than your stake.
      </p>
    </section>
  );
}
