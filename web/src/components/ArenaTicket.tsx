import { useState } from "react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useApp, usePoll } from "../lib/store";
import { get, type Market } from "../lib/api";
import { LAMPORTS, price, sol } from "../lib/format";
import { useNow } from "./bits";

interface RoundSide {
  start: number;
  end: number;
  upPot: number;
  downPot: number;
  lockPrice: number | null;
  status: string;
  myUp: number;
  myDown: number;
}

interface ArenaView {
  enabled: boolean;
  eligible: boolean;
  reason: string | null;
  now: number;
  roundMs: number;
  lockBufferMs: number;
  feeBps: number;
  minBet: number;
  maxBetPerRound: number;
  next: RoundSide;
  live: RoundSide;
  recent: { start: number; status: string; result: "up" | "down" | null; lock: number | null; close: number | null; upPot: number; downPot: number }[];
  mine: { start: number; side: "up" | "down"; amount: number; payout: number | null; result: string | null; status: string }[];
}

const clockText = (ms: number) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};

/** Payout multiple for a new bet of `add` on one side, after the fee. */
const multiple = (side: number, other: number, add: number, feeBps: number) => {
  const pot = side + other + add;
  const mine = side + add;
  return mine > 0 ? (pot * (1 - feeBps / 10_000)) / mine : 0;
};

export default function ArenaTicket({ market }: { market: Market }) {
  const { mode, wallet, act, config } = useApp();
  const { setVisible } = useWalletModal();
  const now = useNow(250);
  const [amount, setAmount] = useState("0.1");
  const [busy, setBusy] = useState<"up" | "down" | null>(null);
  const { data, reload } = usePoll(() => get<ArenaView>(`/api/arena/${market.mint}?mode=${mode}${wallet ? `&wallet=${wallet}` : ""}`), [market.mint, mode, wallet], 2000);

  if (!data) return <div className="arena-ticket"><p className="empty-inline">Loading the Arena…</p></div>;
  if (!data.enabled) return <div className="arena-ticket"><p className="ticket-block">The Arena is off.</p></div>;

  // Countdowns use the viewer's clock; the server enforces the real cutoff (and has a 10s buffer).
  const t = now;
  const lockIn = data.next.start - data.lockBufferMs - t;
  const liveLeft = data.live.end - t;
  const stake = Math.round((Number(amount) || 0) * LAMPORTS);
  const n = data.next;
  const upX = multiple(n.upPot, n.downPot, stake, data.feeBps);
  const downX = multiple(n.downPot, n.upPot, stake, data.feeBps);
  const myNext = n.myUp + n.myDown;
  const cur = market.price;
  const lv = data.live;
  const liveDir = lv.lockPrice && cur ? (cur > lv.lockPrice ? "up" : cur < lv.lockPrice ? "down" : null) : null;
  const tooSmall = stake < data.minBet;
  const overCap = myNext + stake > data.maxBetPerRound;

  const place = async (side: "up" | "down") => {
    if (!wallet) return setVisible(true);
    setBusy(side);
    const r = await act(
      { action: "arena_bet", mode, mint: market.mint, side, amount: stake, start: n.start },
      { success: `${side === "up" ? "Up" : "Down"} ${sol(stake)} SOL on the next $${market.symbol} round` },
    );
    setBusy(null);
    if (r) reload();
  };

  const blocked = !data.eligible
    ? data.reason === "too_thin"
      ? "This coin's liquidity is too thin for a fair round."
      : "Waiting for a live price on this coin."
    : null;

  return (
    <div className="arena-ticket">
      <div className="hl-head">
        <span className="hl-coin">Arena</span>
        <span className="faint small">{data.roundMs / 60_000}-minute rounds</span>
        <span className="spacer" />
        <span className="arena-badge">vs players</span>
      </div>
      <p className="arena-pitch">Call where ${market.symbol} goes next round. Winners split the losing side's pot. The pool never takes a side.</p>

      <div className="arena-round">
        <div className="arena-round-head">
          <span>Live round</span>
          <span className="mono">{clockText(liveLeft)} left</span>
        </div>
        <div className="kv">
          <span>Locked at</span>
          <span className="mono">{lv.lockPrice ? price(lv.lockPrice) : lv.upPot + lv.downPot ? "locking…" : "–"}</span>
        </div>
        <div className="kv">
          <span>Now</span>
          <span className={`mono ${liveDir === "up" ? "t-long" : liveDir === "down" ? "t-short" : ""}`}>
            {price(cur)} {liveDir === "up" ? "▲" : liveDir === "down" ? "▼" : ""}
          </span>
        </div>
        <PotBar up={lv.upPot} down={lv.downPot} />
        {lv.myUp + lv.myDown > 0 && (
          <p className="ticket-note">
            You're in: {lv.myUp > 0 && <span className="t-long">Up {sol(lv.myUp)}</span>} {lv.myDown > 0 && <span className="t-short">Down {sol(lv.myDown)}</span>} SOL
          </p>
        )}
      </div>

      <div className="arena-round arena-next">
        <div className="arena-round-head">
          <span>Next round</span>
          <span className="mono">{lockIn > 0 ? `betting closes in ${clockText(lockIn)}` : "starting…"}</span>
        </div>
        <PotBar up={n.upPot} down={n.downPot} />
        {blocked ? (
          <p className="ticket-block">{blocked}</p>
        ) : (
          <>
            <div className="size-box">
              <label htmlFor="arena-amt">Bet</label>
              <input id="arena-amt" inputMode="decimal" autoComplete="off" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span className="unit">SOL</span>
            </div>
            <div className="arena-buttons">
              <button className="btn btn-long" disabled={!!busy || (!!wallet && (tooSmall || overCap)) || lockIn <= 0} onClick={() => place("up")}>
                <span>{busy === "up" ? "Placing…" : "Up"}</span>
                <small>{upX > 0 ? `${upX.toFixed(2)}x` : "–"}</small>
              </button>
              <button className="btn btn-short" disabled={!!busy || (!!wallet && (tooSmall || overCap)) || lockIn <= 0} onClick={() => place("down")}>
                <span>{busy === "down" ? "Placing…" : "Down"}</span>
                <small>{downX > 0 ? `${downX.toFixed(2)}x` : "–"}</small>
              </button>
            </div>
            {wallet && tooSmall && <p className="fine">Minimum bet is {sol(data.minBet, 2)} SOL.</p>}
            {wallet && overCap && <p className="fine">Max {sol(data.maxBetPerRound, 0)} SOL per round.</p>}
            {myNext > 0 && (
              <p className="ticket-note">
                Your bets: {n.myUp > 0 && <span className="t-long">Up {sol(n.myUp)}</span>} {n.myDown > 0 && <span className="t-short">Down {sol(n.myDown)}</span>} SOL
              </p>
            )}
          </>
        )}
      </div>

      {data.recent.length > 0 && (
        <div className="arena-recent" aria-label="Recent results">
          {data.recent
            .slice()
            .reverse()
            .map((r) => (
              <span key={r.start} className={`arena-chip ${r.result ?? "void"}`} title={r.status === "refunded" ? "Refunded" : `${r.result} · ${sol(r.upPot + r.downPot)} SOL pot`}>
                {r.result === "up" ? "▲" : r.result === "down" ? "▼" : "–"}
              </span>
            ))}
        </div>
      )}

      {data.mine.length > 0 && (
        <div className="arena-mine">
          {data.mine.slice(0, 5).map((b, i) => {
            const won = b.payout !== null && b.payout > b.amount;
            const pending = b.payout === null;
            return (
              <div className="kv small" key={`${b.start}-${i}`}>
                <span>
                  <span className={b.side === "up" ? "t-long" : "t-short"}>{b.side === "up" ? "Up" : "Down"}</span> {sol(b.amount)}
                </span>
                <span className={`mono ${pending ? "faint" : won ? "t-long" : b.status === "refunded" ? "" : "t-short"}`}>
                  {pending ? "open" : b.status === "refunded" ? "refunded" : won ? `+${sol((b.payout ?? 0) - b.amount)}` : `−${sol(b.amount)}`}
                </span>
              </div>
            );
          })}
        </div>
      )}

      <p className="fine">
        Lock and close prices are {`${(config?.arena?.priceWindowMs ?? 10_000) / 1000}`}-second averages of the coin's on-chain price. Up wins if close is above lock. {(data.feeBps / 100).toFixed(0)}% of each pot goes to ${config?.brand.ticker} holders and the treasury. A round with one side empty, or no price change, refunds in full.
      </p>
    </div>
  );
}

function PotBar({ up, down }: { up: number; down: number }) {
  const total = up + down;
  const upPct = total > 0 ? (up / total) * 100 : 50;
  return (
    <div className="arena-pots">
      <div className="arena-bar">
        <span className="up" style={{ width: `${upPct}%` }} />
        <span className="down" style={{ width: `${100 - upPct}%` }} />
      </div>
      <div className="kv small">
        <span className="t-long mono">Up {sol(up, 2)}</span>
        <span className="t-short mono">{sol(down, 2)} Down</span>
      </div>
    </div>
  );
}
