import { Link } from "react-router-dom";
import { useState } from "react";
import { useApp } from "../lib/store";
import type { PositionV } from "../lib/api";
import { ago, pct, price, signedSol, sol } from "../lib/format";
import { CoinAvatar, useNow } from "./bits";

const reasonText: Record<string, string> = { manual: "Closed", max_win: "Max win", liquidated: "Liquidated", admin: "Settled" };

export function OpenPositions({ positions, onChange, showCoin = true }: { positions: PositionV[]; onChange?: () => void; showCoin?: boolean }) {
  const { act } = useApp();
  const now = useNow(1000);
  const [closing, setClosing] = useState<number | null>(null);
  if (positions.length === 0) return <p className="empty-inline">No open positions. Pick a coin and choose a side.</p>;
  const close = async (p: PositionV) => {
    setClosing(p.id);
    const r = await act({ action: "close", id: p.id }, { success: `Closed ${p.side} on $${p.symbol}` });
    setClosing(null);
    if (r) onChange?.();
  };
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            {showCoin && <th>Coin</th>}
            <th>Side</th>
            <th className="num">Stake</th>
            <th className="num">Entry</th>
            <th className="num">Now</th>
            <th className="num">P&amp;L</th>
            <th className="num">Liq / Max</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const r = p.pnl !== null ? p.pnl / p.stake : null;
            const wait = p.canCloseAt - now;
            return (
              <tr key={p.id}>
                {showCoin && (
                  <td>
                    <Link to={`/trade/${p.mint}`} className="coin-cell">
                      <CoinAvatar image={p.image} symbol={p.symbol} size={18} />${p.symbol}
                    </Link>
                  </td>
                )}
                <td>
                  <span className={`pill pill-${p.side}`}>
                    {p.side} {p.leverage}x
                  </span>
                </td>
                <td className="num">{sol(p.stake)}</td>
                <td className="num">{price(p.entry)}</td>
                <td className="num">{price(p.mark)}</td>
                <td className={`num ${p.pnl === null ? "" : p.pnl >= 0 ? "t-long" : "t-short"}`}>
                  {signedSol(p.pnl, 4)} <small>{pct(r)}</small>
                </td>
                <td className="num small">
                  <span className="t-short">{price(p.liquidationAt)}</span> / <span className="t-long">{p.maxWinAt > 0 ? price(p.maxWinAt) : "zero"}</span>
                </td>
                <td className="num">
                  <button className="btn btn-sm" onClick={() => close(p)} disabled={wait > 0 || closing === p.id}>
                    {closing === p.id ? "Closing…" : wait > 0 ? `Close in ${Math.ceil(wait / 1000)}s` : "Close"}
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

export function History({ positions }: { positions: PositionV[] }) {
  const now = useNow(30_000);
  if (positions.length === 0) return <p className="empty-inline">Closed trades show up here with their final P&amp;L.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Coin</th>
            <th>Side</th>
            <th className="num">Stake</th>
            <th className="num">Entry → Exit</th>
            <th className="num">Net</th>
            <th>Result</th>
            <th className="num">When</th>
          </tr>
        </thead>
        <tbody>
          {positions.map((p) => {
            const net = (p.pnl ?? 0) - (p.fee ?? 0);
            return (
              <tr key={p.id}>
                <td>
                  <Link to={`/trade/${p.mint}`} className="coin-cell">
                    <CoinAvatar image={p.image} symbol={p.symbol} size={18} />${p.symbol}
                  </Link>
                </td>
                <td>
                  <span className={`pill pill-${p.side}`}>
                    {p.side} {p.leverage}x
                  </span>
                </td>
                <td className="num">{sol(p.stake)}</td>
                <td className="num small">
                  {price(p.entry)} → {price(p.exit)}
                </td>
                <td className={`num ${net >= 0 ? "t-long" : "t-short"}`}>
                  {signedSol(net, 4)} <small>{pct(net / p.stake)}</small>
                </td>
                <td>{reasonText[p.closeReason ?? ""] ?? p.closeReason}</td>
                <td className="num small">{p.closedAt ? ago(p.closedAt, now) : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
