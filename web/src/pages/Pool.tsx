import { useState } from "react";
import { Link } from "react-router-dom";
import { useApp, usePoll } from "../lib/store";
import { get, type TapeEvent } from "../lib/api";
import { LAMPORTS, ago, signedSol, sol } from "../lib/format";
import { CoinAvatar, useNow } from "../components/bits";

interface PoolResp {
  cash: number;
  nav: number;
  shares: number;
  sharePrice: number;
  reserve: number;
  free: number;
  outOnTrades: number;
  holders: number;
  exposure: { mint: string; symbol: string; image: string; long: number; short: number; reserve: number; poolPnl: number }[];
  recent: (TapeEvent & { walletShort: string })[];
  stats24h: { fees: number; poolPnl: number; trades: number };
}

export default function Pool() {
  const { mode, walletBump, wallet, act, config } = useApp();
  const now = useNow(10_000);
  const pool = usePoll(() => get<PoolResp>(`/api/pool?mode=${mode}`), [mode, walletBump], 3000);
  const me = usePoll(() => (wallet ? get<any>(`/api/me?mode=${mode}&wallet=${wallet}`) : Promise.resolve(null)), [wallet, mode, walletBump], 5000);
  const [add, setAdd] = useState("");
  const [removePct, setRemovePct] = useState(100);
  const p = pool.data;
  if (!p || !config) return <div className="empty">Loading pool…</div>;
  const myShares: number = me.data?.pool.shares ?? 0;
  const myValue: number = me.data?.pool.value ?? 0;
  const pf = config.splits.profitFee.pool / 100;
  const cf = config.splits.creatorFee.pool / 100;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Liquidity pool</h1>
          <p>
            The pool takes the other side of every long and short, so trades fill instantly. It keeps losing stakes, pays winners, and gets {pf}% of profit fees and {cf}% of ${config.brand.ticker} creator fees. It only accepts a trade while it can pay every open position's maximum win.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <span className="muted">Pool size</span>
          <div className="big">{sol(p.cash, 2)} SOL</div>
        </div>
      </div>
      <dl className="stat-row">
        <div>
          <dt>Share price</dt>
          <dd className="num">{p.sharePrice.toFixed(4)}</dd>
        </div>
        <div>
          <dt>Backing open trades</dt>
          <dd className="num">{sol(p.reserve, 2)}</dd>
        </div>
        <div>
          <dt>Free to withdraw</dt>
          <dd className="num">{sol(p.free, 2)}</dd>
        </div>
        <div>
          <dt>24h trader P&amp;L to pool</dt>
          <dd className={`num ${p.stats24h.poolPnl >= 0 ? "t-long" : "t-short"}`}>{signedSol(p.stats24h.poolPnl, 3)}</dd>
        </div>
        <div>
          <dt>24h trades</dt>
          <dd className="num">{p.stats24h.trades}</dd>
        </div>
        <div>
          <dt>Depositors</dt>
          <dd className="num">{p.holders}</dd>
        </div>
      </dl>

      <section className="panel">
        <div className="pane-head">
          <h2>Your share</h2>
        </div>
        <div className="panel-body">
          {!wallet ? (
            <p className="muted" style={{ margin: 0 }}>Connect a wallet to add SOL to the pool.</p>
          ) : (
            <div className="two-col">
              <div>
                <div className="big">{sol(myValue)} SOL</div>
                <p className="muted small">{p.shares > 0 ? ((myShares / p.shares) * 100).toFixed(3) : "0"}% of the pool</p>
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                <div className="form-row">
                  <div className="size-box">
                    <label htmlFor="pool-add">Add</label>
                    <input id="pool-add" inputMode="decimal" placeholder="0.0" value={add} onChange={(e) => setAdd(e.target.value.replace(/[^0-9.]/g, ""))} />
                    <span className="unit">SOL</span>
                  </div>
                  <button
                    className="btn btn-primary"
                    disabled={!(Number(add) > 0)}
                    onClick={() => act({ action: "pool_add", mode, amount: Math.round(Number(add) * LAMPORTS) }, { success: "Added to the pool" }).then((r) => r && setAdd(""))}
                  >
                    Add to pool
                  </button>
                  <p className="fine">Comes from your available balance. Your share rises and falls with trader results.</p>
                </div>
                {myShares > 0 && (
                  <div className="form-row">
                    <input id="pool-remove" type="range" min={1} max={100} value={removePct} onChange={(e) => setRemovePct(Number(e.target.value))} aria-label="Percent to withdraw" style={{ flex: "1 1 160px" }} />
                    <span className="mono muted">{removePct}%</span>
                    <button className="btn" onClick={() => act({ action: "pool_remove", mode, shares: Math.floor((myShares * removePct) / 100) }, { success: "Moved from the pool to your balance" })}>
                      Withdraw {sol((myValue * removePct) / 100)} SOL
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="pane-head">
          <h2>Where the pool is</h2>
          <span className="spacer" />
          <span className="faint small">{p.exposure.length} coins</span>
        </div>
        {p.exposure.length === 0 ? (
          <p className="empty-inline">Nothing at risk right now. The pool takes risk when one side of a coin is heavier than the other.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th className="num">Long</th>
                  <th className="num">Short</th>
                  <th className="num">Worst case</th>
                  <th className="num">Pool P&amp;L now</th>
                </tr>
              </thead>
              <tbody>
                {p.exposure.map((e) => (
                  <tr key={e.mint}>
                    <td>
                      <Link to={`/trade/${e.mint}`} className="coin-cell">
                        <CoinAvatar image={e.image} symbol={e.symbol} size={18} />
                        {e.symbol}
                      </Link>
                    </td>
                    <td className="num t-long">{sol(e.long)}</td>
                    <td className="num t-short">{sol(e.short)}</td>
                    <td className="num">{sol(e.reserve)}</td>
                    <td className={`num ${e.poolPnl >= 0 ? "t-long" : "t-short"}`}>{signedSol(e.poolPnl, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="pane-head">
          <h2>Pool activity</h2>
        </div>
        {p.recent.length === 0 ? (
          <p className="empty-inline">No deposits yet.</p>
        ) : (
          <ul className="list">
            {p.recent.map((e) => (
              <li key={e.id}>
                <span className="mono">{e.kind === "creator_fee" ? "Creator fees" : e.walletShort}</span>
                <span className="muted">{e.kind === "pool_add" ? "added" : e.kind === "pool_remove" ? "withdrew" : "split in"}</span>
                <span className="num">{sol(e.amount)} SOL</span>
                <span className="num faint">{ago(e.ts, now)}</span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
