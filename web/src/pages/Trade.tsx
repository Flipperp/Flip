import { useEffect, useMemo, useState } from "react";
import { Link, Navigate, useParams, useSearchParams } from "react-router-dom";
import { useApp, usePoll } from "../lib/store";
import { get, type Market, type PositionV } from "../lib/api";
import { pct, signedSol, sol } from "../lib/format";
import { CoinAvatar, OiBar, TradesColumn, useNow } from "../components/bits";
import TradeTicket from "../components/TradeTicket";
import CandleChart, { type ChartLine } from "../components/CandleChart";
import MarketBar from "../components/MarketBar";
import { History, OpenPositions } from "../components/Positions";

interface Detail extends Market {
  positions: PositionV[];
  reserve: number;
}

interface Me {
  balance: number;
  inTrades: number;
  unrealized: number;
  realized: number;
  tier: number;
  pool: { value: number };
  open: PositionV[];
  closed: PositionV[];
  nextFaucetAt: number;
}

/** "/" and "/trade" open the busiest tradable coin. */
export function TradeHome() {
  const { markets } = useApp();
  const list = [...markets.values()];
  if (list.length === 0) return <div className="empty">Loading markets…</div>;
  const best = list.filter((m) => m.tradable).sort((a, b) => b.longOpen + b.shortOpen - (a.longOpen + a.shortOpen) || (b.mcapSol ?? 0) - (a.mcapSol ?? 0))[0] ?? list[0];
  return <Navigate to={`/trade/${best.mint}`} replace />;
}

function TopTrades() {
  const { mode, walletBump } = useApp();
  const [window, setWindow] = useState<"24h" | "all">("24h");
  const { data } = usePoll(() => get<PositionV[]>(`/api/top?mode=${mode}&window=${window}&by=sol&limit=15`), [mode, window, walletBump], 15_000);
  return (
    <>
      <div className="pane-head" style={{ borderBottom: 0, paddingTop: 0 }}>
        <div className="seg">
          <button className={window === "24h" ? "on" : ""} onClick={() => setWindow("24h")}>
            24h
          </button>
          <button className={window === "all" ? "on" : ""} onClick={() => setWindow("all")}>
            All time
          </button>
        </div>
      </div>
      {!data?.length ? (
        <p className="empty-inline">No winning trades in this window yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>Coin</th>
                <th>Trader</th>
                <th>Side</th>
                <th className="num">Stake</th>
                <th className="num">Profit</th>
                <th className="num">Return</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p, i) => (
                <tr key={p.id}>
                  <td className="num faint">{i + 1}</td>
                  <td>
                    <Link to={`/trade/${p.mint}`} className="coin-cell">
                      <CoinAvatar image={p.image} symbol={p.symbol} size={18} />
                      {p.symbol}
                    </Link>
                  </td>
                  <td className="mono muted">{p.walletShort}</td>
                  <td>
                    <span className={`pill pill-${p.side}`}>
                      {p.side === "long" ? "Long" : "Short"} {p.leverage}x
                    </span>
                    {p.closeReason === "max_win" && <span className="venue" style={{ marginLeft: 6 }}>max win</span>}
                  </td>
                  <td className="num">{sol(p.stake)}</td>
                  <td className="num t-long">{signedSol((p.pnl ?? 0) - (p.fee ?? 0))}</td>
                  <td className="num t-long">{pct((p.pnl ?? 0) / p.stake, 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function AccountBox({ me, onChange }: { me: Me | null; onChange: () => void }) {
  const { wallet, mode, act, config } = useApp();
  const now = useNow(1000);
  if (!wallet || !me || !config) return null;
  const equity = me.balance + me.inTrades + me.unrealized + me.pool.value;
  const wait = me.nextFaucetAt - now;
  return (
    <div className="account-box">
      <h3>Account</h3>
      <div className="kv">
        <span>Equity</span>
        <span>{sol(equity)} SOL</span>
      </div>
      <div className="kv">
        <span>In positions</span>
        <span>{sol(me.inTrades)} SOL</span>
      </div>
      <div className="kv">
        <span>Unrealized</span>
        <span className={me.unrealized >= 0 ? "t-long" : "t-short"}>{signedSol(me.unrealized, 4)}</span>
      </div>
      <div className="kv">
        <span>Holder tier</span>
        <span className="tier-tag">{config.tiers[me.tier]?.name}</span>
      </div>
      {mode === "paper" ? (
        <button className="btn btn-sm" disabled={wait > 0} onClick={() => act({ action: "faucet" }, { success: `Claimed ${sol(config.paper.faucetAmount, 0)} paper SOL` }).then(onChange)}>
          {wait > 0 ? "Paper SOL claimed today" : `Claim ${sol(config.paper.faucetAmount, 0)} paper SOL`}
        </button>
      ) : (
        <Link className="btn btn-sm" to="/portfolio">
          Deposit or withdraw
        </Link>
      )}
    </div>
  );
}

export default function Trade() {
  const { mint = "" } = useParams();
  const [params] = useSearchParams();
  const { mode, markets, tape, watch, wallet, walletBump } = useApp();
  const [tab, setTab] = useState<"positions" | "history" | "top">("positions");
  const detail = usePoll(() => get<Detail>(`/api/market/${mint}?mode=${mode}`), [mint, mode, walletBump], 5000);
  const me = usePoll(() => (wallet ? get<Me>(`/api/me?mode=${mode}&wallet=${wallet}`) : Promise.resolve(null)), [wallet, mode, walletBump], 2000);

  useEffect(() => {
    watch(mint);
    const t = setInterval(() => watch(mint), 60_000);
    return () => clearInterval(t);
  }, [mint, watch]);

  const live = markets.get(mint);
  const m: Market | null = detail.data ? { ...detail.data, ...(live ?? {}) } : (live ?? null);
  const myOpen = useMemo(() => me.data?.open ?? [], [me.data]);
  const lines: ChartLine[] = useMemo(
    () =>
      myOpen
        .filter((p) => p.mint === mint)
        .flatMap((p) => [
          { price: p.entry, kind: p.side, title: `${p.side === "long" ? "Long" : "Short"} ${p.leverage}x` } as ChartLine,
          { price: p.liquidationAt, kind: "liq", title: "Liq" } as ChartLine,
        ]),
    [myOpen, mint],
  );

  useEffect(() => {
    if (m?.symbol) document.title = `${m.symbol} | Flip`;
  }, [m?.symbol]);

  if (!m && detail.error)
    return (
      <div className="empty">
        This coin isn't listed. Open the coin picker and paste its address to add it.
        <Link className="btn" to="/trade">
          Back to trading
        </Link>
      </div>
    );
  if (!m) return <div className="empty">Loading market…</div>;

  const initialSide = params.get("side") === "short" ? "short" : "long";
  const origin = params.get("origin") ?? undefined;
  const closedCount = me.data?.closed.length ?? 0;

  return (
    <div className="terminal">
      <MarketBar market={m} reserve={detail.data?.reserve ?? null} />
      <section className="t-chart" aria-label="Chart">
        <CandleChart mint={mint} live={m.price} lines={lines} />
      </section>
      <section className="t-trades" aria-label="Trades">
        <div className="pane-head">
          <h2>Trades</h2>
          <span className="spacer" />
          <span className="faint small">hover to fade or copy</span>
        </div>
        <TradesColumn events={tape} mint={mint} />
        <div className="oi-mini">
          <div className="kv small">
            <span className="muted">Open interest</span>
            <span className="mono">{sol(m.longOpen + m.shortOpen, 2)} SOL</span>
          </div>
          <OiBar long={m.longOpen} short={m.shortOpen} />
        </div>
      </section>
      <aside className="t-ticket">
        <TradeTicket market={m} balance={wallet ? (me.data?.balance ?? null) : null} tier={me.data?.tier ?? 0} initialSide={initialSide} origin={origin} onOpened={() => me.reload()} />
        <div style={{ padding: "0 12px 12px" }}>
          <AccountBox me={me.data} onChange={() => me.reload()} />
        </div>
      </aside>
      <section className="t-bottom" aria-label="Your trading">
        <div className="pane-head">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "positions"} className={tab === "positions" ? "on" : ""} onClick={() => setTab("positions")}>
              Positions{myOpen.length ? ` (${myOpen.length})` : ""}
            </button>
            <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
              Trade history{closedCount ? ` (${closedCount})` : ""}
            </button>
            <button role="tab" aria-selected={tab === "top"} className={tab === "top" ? "on" : ""} onClick={() => setTab("top")}>
              Top trades
            </button>
          </div>
        </div>
        {tab === "positions" &&
          (wallet ? <OpenPositions positions={myOpen} onChange={() => me.reload()} /> : <p className="empty-inline">Connect a wallet to see your positions.</p>)}
        {tab === "history" && (wallet ? <History positions={me.data?.closed ?? []} /> : <p className="empty-inline">Connect a wallet to see your trade history.</p>)}
        {tab === "top" && <TopTrades />}
      </section>
    </div>
  );
}
