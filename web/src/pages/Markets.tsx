import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp } from "../lib/store";
import { FilterSeg, MarketTable } from "../components/MarketBar";
import { compactSol, sol } from "../lib/format";

export default function Markets() {
  const nav = useNavigate();
  const { markets, pool, config } = useApp();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | "tradable" | "curve" | "graduated" | "open">("all");
  const list = [...markets.values()];
  const oi = list.reduce((a, m) => a + m.longOpen + m.shortOpen, 0);
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Markets</h1>
          <p>
            Every coin here can be longed or shorted at {config?.leverages.join("x, ")}x against the pool. Open the picker on the trade screen and paste any contract address with {sol(config?.minLiquidity ?? 50e9, 0)}+ SOL of liquidity to add it.
          </p>
        </div>
      </div>
      <dl className="stat-row">
        <div>
          <dt>Listed coins</dt>
          <dd className="num">{list.length}</dd>
        </div>
        <div>
          <dt>Tradable now</dt>
          <dd className="num">{list.filter((m) => m.tradable).length}</dd>
        </div>
        <div>
          <dt>Open interest</dt>
          <dd className="num">{sol(oi, 2)} SOL</dd>
        </div>
        <div>
          <dt>Pool size</dt>
          <dd className="num">{pool ? `${compactSol(pool.cash / 1e9)} SOL` : "–"}</dd>
        </div>
        <div>
          <dt>Pool free</dt>
          <dd className="num">{pool ? `${compactSol(pool.free / 1e9)} SOL` : "–"}</dd>
        </div>
      </dl>
      <section className="panel">
        <div className="pane-head" style={{ flexWrap: "wrap" }}>
          <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or ticker" aria-label="Search markets" style={{ flex: "1 1 220px", maxWidth: 320 }} />
          <FilterSeg value={filter} onChange={setFilter} />
        </div>
        <MarketTable q={q} filter={filter} onPick={(m) => nav(`/trade/${m.mint}`)} />
      </section>
    </div>
  );
}
