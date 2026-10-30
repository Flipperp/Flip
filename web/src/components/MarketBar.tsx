import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/store";
import { post, type Market } from "../lib/api";
import { compactSol, pct, price, sol, usd, usdPx, venueName } from "../lib/format";
import { CoinAvatar } from "./bits";

export type Filter = "all" | "tradable" | "hl" | "curve" | "graduated" | "open";

export function MarketTable({ onPick, current, filter, q }: { onPick: (m: Market) => void; current?: string; filter: Filter; q: string }) {
  const { markets, solUsd } = useApp();
  const [sort, setSort] = useState<"mcap" | "change" | "liq" | "oi">("mcap");
  const rows = useMemo(() => {
    let list = [...markets.values()];
    const qq = q.trim().toLowerCase();
    if (qq) list = list.filter((m) => m.symbol.toLowerCase().includes(qq) || m.name.toLowerCase().includes(qq) || m.mint.toLowerCase() === qq);
    if (filter === "tradable") list = list.filter((m) => m.tradable);
    if (filter === "hl") list = list.filter((m) => m.hl?.routable);
    if (filter === "curve") list = list.filter((m) => m.venue === "pumpfun");
    if (filter === "graduated") list = list.filter((m) => m.venue !== "pumpfun");
    if (filter === "open") list = list.filter((m) => m.longOpen + m.shortOpen > 0);
    const key = { mcap: (m: Market) => m.mcapSol ?? -1, change: (m: Market) => m.change1h ?? -1e9, liq: (m: Market) => m.liquidity ?? -1, oi: (m: Market) => m.longOpen + m.shortOpen }[sort];
    return list.sort((a, b) => (a.tradable !== b.tradable ? (a.tradable ? -1 : 1) : key(b) - key(a)));
  }, [markets, q, filter, sort]);
  const th = (k: typeof sort, label: string) => (
    <th className="num">
      <button className="link" style={{ color: sort === k ? "var(--text)" : "inherit", textDecoration: "none" }} onClick={() => setSort(k)}>
        {label}
        {sort === k ? " ↓" : ""}
      </button>
    </th>
  );
  if (rows.length === 0) return <p className="empty-inline">No coins match. Paste a contract address to add one.</p>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>Coin</th>
            <th className="num">Price</th>
            {th("change", "1h")}
            {th("mcap", "Market cap")}
            {th("liq", "Liquidity")}
            {th("oi", "Open interest")}
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.mint} className={`clickable ${m.mint === current ? "row-on" : ""} ${m.tradable ? "" : "row-dim"}`} onClick={() => onPick(m)}>
              <td>
                <div className="coin-cell">
                  <CoinAvatar image={m.image} symbol={m.symbol} size={22} />
                  <div>
                    <strong>{m.symbol || "?"}</strong>
                    <span className="faint small">{m.name}</span>
                  </div>
                  <span className="venue">{venueName[m.venue] ?? m.venue}</span>
                  {m.hl?.routable && <span className="venue hl-venue">HL perp</span>}
                  {!m.tradable && <span className="venue">{m.reason === "too_thin" ? "close only" : "warming up"}</span>}
                </div>
              </td>
              <td className="num">{price(m.price)}</td>
              <td className={`num ${(m.change1h ?? 0) >= 0 ? "t-long" : "t-short"}`}>{pct(m.change1h)}</td>
              <td className="num">{m.mcapSol ? (solUsd ? usd(m.mcapSol * solUsd) : `${compactSol(m.mcapSol)} SOL`) : "–"}</td>
              <td className="num">{compactSol((m.liquidity ?? 0) / 1e9)} SOL</td>
              <td className="num">
                <span className="t-long">{sol(m.longOpen, 2)}</span> / <span className="t-short">{sol(m.shortOpen, 2)}</span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FilterSeg({ value, onChange }: { value: Filter; onChange: (f: Filter) => void }) {
  const opts: [Filter, string][] = [
    ["all", "All"],
    ["tradable", "Tradable"],
    ["hl", "Hyperliquid"],
    ["curve", "On curve"],
    ["graduated", "Graduated"],
    ["open", "Has positions"],
  ];
  return (
    <div className="seg">
      {opts.map(([k, l]) => (
        <button key={k} className={value === k ? "on" : ""} onClick={() => onChange(k)}>
          {l}
        </button>
      ))}
    </div>
  );
}

/** Pick a coin from the list, or paste any contract address to add it. */
function Selector({ current, onClose }: { current: string; onClose: () => void }) {
  const nav = useNavigate();
  const { upsertMarket, toast } = useApp();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest(".selector-btn")) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);
  const looksLikeMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(q.trim());
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!looksLikeMint) return;
    setBusy(true);
    try {
      const m = await post<Market>("/api/market", { mint: q.trim() });
      upsertMarket(m);
      nav(`/trade/${m.mint}`);
      onClose();
    } catch (err: any) {
      toast("error", err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="selector-pop" ref={ref} role="dialog" aria-label="Choose a coin">
      <form className="pop-head" onSubmit={submit}>
        <input className="input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search coins or paste a contract address" aria-label="Search coins or paste a contract address" spellCheck={false} />
        {looksLikeMint && (
          <button className="btn btn-primary" disabled={busy}>
            {busy ? "Finding pool…" : "Add coin"}
          </button>
        )}
        <FilterSeg value={filter} onChange={setFilter} />
      </form>
      <MarketTable
        current={current}
        q={q}
        filter={filter}
        onPick={(m) => {
          nav(`/trade/${m.mint}`);
          onClose();
        }}
      />
    </div>
  );
}

export default function MarketBar({ market, reserve }: { market: Market; reserve: number | null }) {
  const { solUsd, pool } = useApp();
  const [open, setOpen] = useState(false);
  const up = (market.change1h ?? 0) >= 0;
  return (
    <div className="t-bar" style={{ position: "relative" }}>
      <div className="market-bar">
        <button className="selector-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="dialog">
          <CoinAvatar image={market.image} symbol={market.symbol} size={26} />
          <span className="sym">{market.symbol || "?"}</span>
          <span className="venue">{venueName[market.venue] ?? market.venue}</span>
          {market.hl?.routable && <span className="venue hl-venue" title={`Also trades as the ${market.hl.coin} perp on Hyperliquid`}>HL perp</span>}
          <svg className="caret" width="12" height="12" viewBox="0 0 12 12" aria-hidden>
            <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
        <span className={`bar-price ${up ? "t-long" : "t-short"}`}>{price(market.price)}</span>
        <dl className="bar-stats">
          <div>
            <dt title="Change over the last hour">1h change</dt>
            <dd className={`num ${up ? "t-long" : "t-short"}`}>{pct(market.change1h, 2)}</dd>
          </div>
          <div>
            <dt title="Fills use the worse of this and the live price">30s average</dt>
            <dd className="num">{price(market.twap)}</dd>
          </div>
          <div>
            <dt>Market cap</dt>
            <dd className="num">{market.mcapSol ? (solUsd ? usd(market.mcapSol * solUsd) : `${compactSol(market.mcapSol)} SOL`) : "–"}</dd>
          </div>
          <div>
            <dt title="SOL side of the coin's own pool">Liquidity</dt>
            <dd className="num">{compactSol((market.liquidity ?? 0) / 1e9)} SOL</dd>
          </div>
          <div>
            <dt>Open long / short</dt>
            <dd className="num">
              <span className="t-long">{sol(market.longOpen, 2)}</span> / <span className="t-short">{sol(market.shortOpen, 2)}</span>
            </dd>
          </div>
          {market.hl?.routable && (
            <>
              <div>
                <dt title={`Hyperliquid ${market.hl.coin} perp mark price`}>HL mark</dt>
                <dd className="num">{usdPx(market.hl.markPx)}</dd>
              </div>
              <div>
                <dt title="Hyperliquid funding rate, paid hourly. Positive: longs pay shorts.">HL funding / 1h</dt>
                <dd className="num">{market.hl.funding === null ? "–" : `${(market.hl.funding * 100).toFixed(4)}%`}</dd>
              </div>
              <div>
                <dt title="Hyperliquid open interest">HL open interest</dt>
                <dd className="num">{market.hl.openInterest !== null && market.hl.markPx ? usd(market.hl.openInterest * market.hl.markPx) : "–"}</dd>
              </div>
              <div>
                <dt title="Hyperliquid 24h notional volume">HL 24h volume</dt>
                <dd className="num">{usd(market.hl.dayNtlVlm)}</dd>
              </div>
            </>
          )}
          <div>
            <dt title="What the pool would pay on this coin in the worst case">Pool at risk here</dt>
            <dd className="num">{reserve === null ? "–" : `${sol(reserve, 2)} SOL`}</dd>
          </div>
          <div>
            <dt title="Pool cash not backing open trades">Pool free</dt>
            <dd className="num">{pool ? `${compactSol(pool.free / 1e9)} SOL` : "–"}</dd>
          </div>
        </dl>
      </div>
      {open && <Selector current={market.mint} onClose={() => setOpen(false)} />}
    </div>
  );
}
