import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useApp, usePoll } from "../lib/store";
import { ApiError, get, post, type Market } from "../lib/api";
import { ago, compactSol, sol, usd } from "../lib/format";
import { CoinAvatar, useNow } from "../components/bits";

interface Launch {
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  creator: string;
  createdAt: number;
  devBuySol: number;
  launchMcapSol: number;
  listed: boolean;
}

interface Grad {
  mint: string;
  at: number;
  listed: boolean;
  symbol: string | null;
  name: string | null;
  image: string | null;
}

interface Feed {
  enabled: boolean;
  connected?: boolean;
  launches: Launch[];
  graduations: Grad[];
}

/** Live pump.fun launches and graduations. Opening one verifies it on-chain and lists it. */
export default function NewPairs() {
  const nav = useNavigate();
  const { config, solUsd, upsertMarket, toast } = useApp();
  const now = useNow(1000);
  const { data } = usePoll(() => get<Feed>("/api/new?limit=100"), [], 3000);
  const [opening, setOpening] = useState<string | null>(null);

  const open = async (mint: string, listed: boolean) => {
    if (listed) return nav(`/trade/${mint}`);
    setOpening(mint);
    try {
      const m = await post<Market>("/api/market", { mint });
      upsertMarket(m);
      nav(`/trade/${m.mint}`);
    } catch (e: any) {
      toast("error", e instanceof ApiError ? e.message : "Couldn't open that coin");
    } finally {
      setOpening(null);
    }
  };

  const mcap = (s: number) => (solUsd ? usd(s * solUsd) : `${compactSol(s)} SOL`);
  const minLiq = sol(config?.minLiquidity ?? 50e9, 0);

  if (data && !data.enabled)
    return (
      <div className="page">
        <div className="empty">The live pump.fun feed runs on the deployed site. This copy doesn't connect to it.</div>
      </div>
    );

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>New pairs</h1>
          <p>
            Every pump.fun launch and graduation as it happens. Opening a coin reads its curve or pool on-chain before it's listed. Fresh launches are close-only until their curve holds {minLiq} SOL; graduated coins can be traded once their price average is ready.
          </p>
        </div>
        <span className={`venue ${data?.connected ? "hl-venue" : ""}`}>{data?.connected ? "live" : "connecting…"}</span>
      </div>

      <section className="panel">
        <div className="pane-head">
          <h2>Just graduated</h2>
          <span className="spacer" />
          <span className="faint small">listed on Flip automatically</span>
        </div>
        {!data?.graduations.length ? (
          <p className="empty-inline">No graduations since the server started. They arrive a few times an hour.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th className="num">Graduated</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.graduations.map((g) => (
                  <tr key={g.mint}>
                    <td>
                      <div className="coin-cell">
                        <CoinAvatar image={g.image} symbol={g.symbol ?? "?"} size={22} />
                        <div>
                          <strong>{g.symbol ?? `${g.mint.slice(0, 4)}…${g.mint.slice(-4)}`}</strong>
                          <span className="faint small">{g.name ?? (g.listed ? "" : "verifying on-chain…")}</span>
                        </div>
                        <span className="venue">PumpSwap</span>
                      </div>
                    </td>
                    <td className="num faint">{ago(g.at, now)} ago</td>
                    <td className="num">
                      <button className="btn btn-sm btn-primary" disabled={opening === g.mint} onClick={() => open(g.mint, g.listed)}>
                        {opening === g.mint ? "Opening…" : "Trade"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="pane-head">
          <h2>Launches</h2>
          <span className="spacer" />
          <span className="faint small">newest first · updates every few seconds</span>
        </div>
        {!data?.launches.length ? (
          <p className="empty-inline">{data ? "Waiting for the next launch…" : "Connecting to the feed…"}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Coin</th>
                  <th className="num">Age</th>
                  <th className="num">Launch mcap</th>
                  <th className="num">Dev buy</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.launches.map((p) => (
                  <tr key={p.mint}>
                    <td>
                      <div className="coin-cell">
                        <CoinAvatar image={p.image} symbol={p.symbol} size={22} />
                        <div>
                          <strong>{p.symbol || "?"}</strong>
                          <span className="faint small">{p.name}</span>
                        </div>
                        <span className="venue">pump.fun</span>
                      </div>
                    </td>
                    <td className="num faint">{ago(p.createdAt, now)}</td>
                    <td className="num">{mcap(p.launchMcapSol)}</td>
                    <td className="num">{p.devBuySol ? `${p.devBuySol.toFixed(2)} SOL` : "–"}</td>
                    <td className="num">
                      <button className="btn btn-sm" disabled={opening === p.mint} onClick={() => open(p.mint, p.listed)}>
                        {opening === p.mint ? "Opening…" : p.listed ? "Open" : "Watch"}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <p className="fine">Launch data comes from PumpPortal's public feed. Prices on Flip always come from the coin's own curve or pool on-chain.</p>
    </div>
  );
}
