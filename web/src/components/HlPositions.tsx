import { Link } from "react-router-dom";
import { useApp } from "../lib/store";
import { useHl } from "../lib/hl";
import { pct, usd2, usdPx } from "../lib/format";

/** Positions on the user's Hyperliquid account, from any frontend. */
export function HlPositions({ tier }: { tier: number }) {
  const hl = useHl();
  const { config, markets } = useApp();
  if (!hl.user)
    return (
      <p className="empty-inline">
        Connect an EVM wallet on a coin with a Hyperliquid perp to trade there. <button className="link-btn" onClick={hl.connect}>Connect</button>
      </p>
    );
  const positions = hl.account?.positions ?? [];
  if (positions.length === 0) return <p className="empty-inline">No open Hyperliquid positions.</p>;
  const discount = config?.tiers[tier]?.feeDiscountBps ?? 0;
  const mintFor = (coin: string) => [...markets.values()].find((m) => m.hl?.coin === coin)?.mint;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Coin</th>
            <th>Side</th>
            <th className="num">Size</th>
            <th className="num">Entry</th>
            <th className="num">Mark</th>
            <th className="num">P&amp;L</th>
            <th className="num">Liq.</th>
            <th className="num">Margin</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const mint = mintFor(p.coin);
            const mark = Number(hl.mids[p.coin]) || null;
            return (
              <tr key={p.coin}>
                <td>
                  {mint ? (
                    <Link to={`/trade/${mint}`} className="coin-cell">
                      {p.coin}
                    </Link>
                  ) : (
                    p.coin
                  )}
                  <span className="venue hl-venue">HL</span>
                </td>
                <td>
                  <span className={`pill pill-${p.side}`}>
                    {p.side} {p.leverage}x
                  </span>
                </td>
                <td className="num">{usd2(p.positionValue)}</td>
                <td className="num">{usdPx(p.entryPx)}</td>
                <td className="num">{usdPx(mark)}</td>
                <td className={`num ${p.unrealizedPnl >= 0 ? "t-long" : "t-short"}`}>
                  {p.unrealizedPnl >= 0 ? "+" : "−"}
                  {usd2(Math.abs(p.unrealizedPnl))} <small>{pct(p.returnOnEquity)}</small>
                </td>
                <td className="num small">{usdPx(p.liquidationPx)}</td>
                <td className="num small">
                  {usd2(p.marginUsed)} <span className="faint">{p.leverageType}</span>
                </td>
                <td className="num">
                  <button className="btn btn-sm" disabled={hl.busy === `close:${p.coin}` || hl.status !== "ready"} onClick={() => hl.close(p.coin, discount)} title={hl.status !== "ready" ? "Turn on trading first" : undefined}>
                    {hl.busy === `close:${p.coin}` ? "Closing…" : "Close"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
