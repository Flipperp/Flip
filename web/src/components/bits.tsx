import { Link } from "react-router-dom";
import { useEffect, useState } from "react";
import type { TapeEvent } from "../lib/api";
import { ago, signedSol, sol } from "../lib/format";

export function CoinAvatar({ image, symbol, size = 24 }: { image?: string | null; symbol?: string | null; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (image && !broken) return <img className="avatar" src={image} alt="" width={size} height={size} onError={() => setBroken(true)} loading="lazy" />;
  return (
    <span className="avatar avatar-fallback" style={{ width: size, height: size, fontSize: size }} aria-hidden>
      {(symbol ?? "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

export function useNow(everyMs = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(t);
  }, [everyMs]);
  return now;
}

export function OiBar({ long, short }: { long: number; short: number }) {
  const total = long + short;
  const lp = total > 0 ? (long / total) * 100 : 50;
  return (
    <div>
      <div className="oi-bar" aria-hidden>
        <span className="oi-long" style={{ width: `${total ? lp : 0}%` }} />
        <span className="oi-short" style={{ width: `${total ? 100 - lp : 0}%` }} />
      </div>
      <div className="oi-labels">
        <span className="t-long">{sol(long, 2)} L</span>
        <span className="t-short">{sol(short, 2)} S</span>
      </div>
    </div>
  );
}

const sideLetter = (s?: string) => (s === "long" ? "L" : "S");

function row(e: TapeEvent) {
  const side = e.data?.side as string | undefined;
  const lev = e.data?.leverage;
  switch (e.kind) {
    case "open":
      return { label: `${side === "long" ? "Long" : "Short"} ${lev}x`, tone: side === "long" ? "t-long" : "t-short", size: sol(e.amount), sizeTone: "" };
    case "close":
      return { label: `Close ${sideLetter(side)} ${lev}x`, tone: "muted", size: signedSol(e.amount), sizeTone: e.amount >= 0 ? "t-long" : "t-short" };
    case "max_win":
      return { label: `Max win ${sideLetter(side)}`, tone: "t-brand", size: signedSol(e.amount), sizeTone: "t-long" };
    case "liquidated":
      return { label: `Liq ${sideLetter(side)} ${lev ?? ""}x`, tone: "t-short", size: signedSol(e.amount), sizeTone: "t-short" };
    default:
      return null;
  }
}

/** Live trades for one coin. Hovering an open shows Fade (take the other side) and Copy. */
export function TradesColumn({ events, mint }: { events: TapeEvent[]; mint: string }) {
  const now = useNow(2000);
  const list = events.filter((e) => e.mint === mint && row(e));
  return (
    <>
      <div className="trades-head">
        <span>Trade</span>
        <span>SOL</span>
        <span>Age</span>
      </div>
      {list.length === 0 ? (
        <p className="empty-inline">No trades on this coin yet. They stream in here as they fill.</p>
      ) : (
        <ul className="trades-list">
          {list.slice(0, 80).map((e) => {
            const r = row(e)!;
            const opposite = e.data?.side === "long" ? "short" : "long";
            return (
              <li key={e.id} className={`trade-row ${now - e.ts < 2500 ? "flash" : ""}`} tabIndex={e.kind === "open" ? 0 : -1} title={e.walletShort ?? ""}>
                <span className={r.tone}>{r.label}</span>
                <span className={r.sizeTone}>{r.size}</span>
                <span className="faint">{ago(e.ts, now)}</span>
                {e.kind === "open" && e.ref && (
                  <span className="tr-actions">
                    <Link className={`chip chip-${opposite}`} to={`/trade/${e.mint}?side=${opposite}&origin=fade:${e.ref}`} title={`Take the ${opposite} side of this trade`}>
                      Fade
                    </Link>
                    <Link className="chip" to={`/trade/${e.mint}?side=${e.data?.side}&origin=copy:${e.ref}`} title="Open the same side">
                      Copy
                    </Link>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
