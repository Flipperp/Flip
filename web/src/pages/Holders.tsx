import { useApp, usePoll } from "../lib/store";
import { get } from "../lib/api";
import { duration, sol } from "../lib/format";
import { useNow } from "../components/bits";

const fmtTokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toLocaleString(undefined, { maximumFractionDigits: 2 })}M` : n.toLocaleString(undefined, { maximumFractionDigits: 0 }));

export default function Holders() {
  const { config, wallet } = useApp();
  const now = useNow(1000);
  const { data } = usePoll(() => get<any>(`/api/holders${wallet ? `?wallet=${wallet}` : ""}`), [wallet], 15_000);
  if (!config) return null;
  const t = config.brand.ticker;
  const s = config.splits;

  return (
    <div className="page holders">
      <section className="page-head">
        <div>
        <h1>Hold ${t}, get paid by every trade</h1>
        <p>
          Holders share {s.profitFee.holders / 100}% of profit fees and {s.creatorFee.holders / 100}% of ${t} creator fees, paid in SOL every {duration(config.holders.epochMs)} by how much you held and for how long. Bigger holders also pay lower fees and get part of their trading losses back.
        </p>
        </div>
      </section>

      {!data?.enabled ? (
        <section className="panel">
          <p className="empty-inline">Holder rewards start once ${t} launches on pump.fun. Tiers, rebates and the fee split below are how it works from day one.</p>
        </section>
      ) : (
        <>
          <section style={{ display: "grid", gap: 12 }}>
            <div>
              <span className="muted">Next payout in</span>
              <div className="big">{duration(Math.max(0, data.endsAt - now))}</div>
            </div>
            <dl className="stat-row">
              <div>
                <dt>In the holder pot</dt>
                <dd>{sol(data.pot)} SOL</dd>
              </div>
              <div>
                <dt>This payout</dt>
                <dd>{sol(data.projectedPayout)} SOL</dd>
              </div>
              <div>
                <dt>Holders</dt>
                <dd>{data.holders}</dd>
              </div>
              <div>
                <dt>Last payout</dt>
                <dd>{data.lastEpoch ? `${sol((data.lastEpoch.payout_total ?? 0) + (data.lastEpoch.rebate_total ?? 0))} SOL` : "None yet"}</dd>
              </div>
            </dl>
          </section>

          {wallet && data.me && (
            <section className="panel">
              <div className="pane-head">
                <h2>You</h2>
              </div>
              <div className="panel-body"><dl className="stat-row">
                <div>
                  <dt>Holding</dt>
                  <dd>
                    {fmtTokens(data.me.balance)} ${t}
                  </dd>
                </div>
                <div>
                  <dt>Counts toward tier</dt>
                  <dd>{fmtTokens(data.me.tierBalance)}</dd>
                </div>
                <div>
                  <dt>Tier</dt>
                  <dd>{config.tiers[data.me.tier]?.name}</dd>
                </div>
                <div>
                  <dt>Your share this epoch</dt>
                  <dd>{(data.me.share * 100).toFixed(3)}%</dd>
                </div>
                <div>
                  <dt>Projected</dt>
                  <dd className="t-long">{sol(data.me.projected, 4)} SOL</dd>
                </div>
                <div>
                  <dt>Earned so far</dt>
                  <dd>{sol(data.me.earnedRewards + data.me.earnedRebates, 4)} SOL</dd>
                </div>
              </dl>
              <p className="fine" style={{ marginTop: 10 }}>Rewards land in your balance on this site at each payout. Trade with them or withdraw any time.</p></div>
            </section>
          )}
        </>
      )}

      <section className="panel">
        <div className="pane-head">
          <h2>Tiers</h2>
          <span className="spacer" /><span className="faint small">Your tier uses the lower of what you hold now and what you held on average over the last full epoch.</span>
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Tier</th>
                <th className="num">Hold at least</th>
                <th className="num">Profit fee</th>
                <th className="num">Rekt rebate</th>
              </tr>
            </thead>
            <tbody>
              {config.tiers.map((tier, i) => (
                <tr key={tier.name} className={data?.me?.tier === i ? "row-hi" : ""}>
                  <td>{tier.name}</td>
                  <td className="num">{i === 0 ? "–" : `${fmtTokens(tier.minTokens)} $${t}`}</td>
                  <td className="num">{((config.profitFeeBps * (10_000 - tier.feeDiscountBps)) / 10_000 / 100).toFixed(2)}%</td>
                  <td className="num">{tier.rebateBps ? `${tier.rebateBps / 100}% of net losses` : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="fine" style={{ padding: "10px 14px" }}>
          The rekt rebate is paid from the holder pot at each payout, on your net trading loss for that epoch, up to {sol(config.rebate.maxPerWalletPerEpoch, 0)} SOL. Rebates can use at most {config.rebate.maxPotFrac * 100}% of a payout. One wallet's reward weight is capped at {config.holders.maxWeightSupplyFrac * 100}% of supply.
        </p>
      </section>

      <section className="panel">
        <div className="pane-head">
          <h2>Where the money goes</h2>
        </div>
        <div className="splits panel-body">
          {(
            [
              ["Profit fees", s.profitFee, `${config.profitFeeBps / 100}% of every winning trade's profit`],
              [`$${t} creator fees`, s.creatorFee, "Claimed from pump.fun and swept in automatically"],
            ] as const
          ).map(([name, sp, sub]) => (
            <div key={name} className="split">
              <h3>{name}</h3>
              <p className="muted small">{sub}</p>
              <div className="split-bar" aria-hidden>
                <span className="sb-pool" style={{ flex: sp.pool }} />
                <span className="sb-holders" style={{ flex: sp.holders }} />
                <span className="sb-treasury" style={{ flex: sp.treasury }} />
              </div>
              <ul className="split-legend">
                <li>
                  <i className="sb-pool" /> Pool {sp.pool / 100}%
                </li>
                <li>
                  <i className="sb-holders" /> Holders {sp.holders / 100}%
                </li>
                <li>
                  <i className="sb-treasury" /> Treasury {sp.treasury / 100}%
                </li>
              </ul>
            </div>
          ))}
        </div>
      </section>

      {data?.epochs?.length > 0 && (
        <section className="panel">
          <div className="pane-head">
            <h2>Past payouts</h2>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Epoch</th>
                  <th className="num">Yield paid</th>
                  <th className="num">Rebates</th>
                  <th className="num">Ended</th>
                </tr>
              </thead>
              <tbody>
                {data.epochs.map((e: any) => (
                  <tr key={e.id}>
                    <td>{e.id}</td>
                    <td className="num">{sol(e.payout_total)} SOL</td>
                    <td className="num">{sol(e.rebate_total)} SOL</td>
                    <td className="num small">{new Date(e.ended_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
