import { useHl } from "../lib/hl";
import { HlPositions } from "../components/HlPositions";
import { usd2 } from "../lib/format";
import { useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { useApp, usePoll } from "../lib/store";
import { forgetSession, get, type PositionV } from "../lib/api";
import { LAMPORTS, ago, duration, short, signedSol, sol } from "../lib/format";
import { History, OpenPositions } from "../components/Positions";
import { useNow } from "../components/bits";

interface Me {
  balance: number;
  inTrades: number;
  unrealized: number;
  realized: number;
  pool: { shares: number; value: number };
  tier: number;
  open: PositionV[];
  closed: PositionV[];
  withdrawals: { id: number; amount: number; status: string; sig: string | null; error: string | null; created_at: number }[];
  deposits: { sig: string; amount: number; ts: number }[];
  nextFaucetAt: number;
}

function Deposit({ onDone }: { onDone: () => void }) {
  const { config, toast } = useApp();
  const { connection } = useConnection();
  const { publicKey, sendTransaction } = useWallet();
  const [amt, setAmt] = useState("0.5");
  const [busy, setBusy] = useState(false);
  if (!config?.vault) return <p className="muted">Deposits open when real trading goes live.</p>;
  const vault = config.vault;
  const go = async () => {
    if (!publicKey) return;
    const lamports = Math.round(Number(amt) * LAMPORTS);
    if (!(lamports >= config.custody.minDeposit)) return toast("error", `Minimum deposit is ${sol(config.custody.minDeposit)} SOL`);
    setBusy(true);
    try {
      const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: new PublicKey(vault), lamports }));
      const sig = await sendTransaction(tx, connection);
      toast("info", "Deposit sent. It's credited once the network confirms it.");
      await connection.confirmTransaction(sig, "confirmed").catch(() => {});
      setTimeout(onDone, 3000);
    } catch (e: any) {
      toast("error", /reject/i.test(e?.message) ? "Deposit cancelled" : `Deposit failed: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="form-row">
      <div className="size-box">
        <label htmlFor="dep">Amount</label>
        <input id="dep" inputMode="decimal" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="unit">SOL</span>
      </div>
      <button className="btn btn-primary" onClick={go} disabled={busy}>
        {busy ? "Sending…" : "Deposit"}
      </button>
      <p className="fine">Send from this wallet only. SOL is credited to the wallet that sends it. Vault: {short(config.vault)}</p>
    </div>
  );
}

function Withdraw({ balance, onDone }: { balance: number; onDone: () => void }) {
  const { config, act } = useApp();
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  if (!config) return null;
  const go = async () => {
    const amount = Math.round(Number(amt) * LAMPORTS);
    setBusy(true);
    const r = await act({ action: "withdraw", amount }, { wallet: true, success: "Withdrawal queued. It goes to this wallet shortly." });
    setBusy(false);
    if (r) {
      setAmt("");
      onDone();
    }
  };
  return (
    <div className="form-row">
      <div className="size-box">
        <label htmlFor="wd">Amount</label>
        <input id="wd" inputMode="decimal" value={amt} placeholder="0.0" onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="unit">SOL</span>
      </div>
      <button className="btn" onClick={() => setAmt(String(Math.floor((balance / LAMPORTS) * 1e6) / 1e6))}>
        Max
      </button>
      <button className="btn btn-primary" onClick={go} disabled={busy || !(Number(amt) > 0)}>
        {busy ? "Signing…" : "Withdraw"}
      </button>
      <p className="fine">Your wallet signs a message; nothing is sent from it. Up to {sol(config.custody.dailyWithdrawalPerWallet, 0)} SOL a day.</p>
    </div>
  );
}

function HlPanel({ tier }: { tier: number }) {
  const hl = useHl();
  if (!hl.cfg?.enabled) return null;
  const a = hl.account;
  return (
    <section className="panel">
      <div className="pane-head">
        <h2>Hyperliquid</h2>
        <span className="venue hl-venue">real USDC</span>
        <span className="spacer" />
        {hl.user ? (
          <span className="mono faint small">
            {hl.user.slice(0, 6)}…{hl.user.slice(-4)}
          </span>
        ) : (
          <button className="btn btn-sm btn-primary" onClick={hl.connect}>
            Connect EVM wallet
          </button>
        )}
      </div>
      {hl.user && a && (
        <dl className="stat-row" style={{ padding: "0 12px" }}>
          <div>
            <dt>Perps equity</dt>
            <dd className="num">{usd2(a.accountValue)}</dd>
          </div>
          <div>
            <dt>Withdrawable</dt>
            <dd className="num">{usd2(a.withdrawable)}</dd>
          </div>
          <div>
            <dt>Margin in use</dt>
            <dd className="num">{usd2(a.marginUsed)}</dd>
          </div>
          <div>
            <dt>Unrealized</dt>
            <dd className={`num ${a.positions.reduce((x, p) => x + p.unrealizedPnl, 0) >= 0 ? "t-long" : "t-short"}`}>{usd2(a.positions.reduce((x, p) => x + p.unrealizedPnl, 0))}</dd>
          </div>
        </dl>
      )}
      <HlPositions tier={tier} />
    </section>
  );
}

export default function Portfolio() {
  const { mode, wallet, walletBump, act, config } = useApp();
  const { setVisible } = useWalletModal();
  const now = useNow(1000);
  const me = usePoll(() => (wallet ? get<Me>(`/api/me?mode=${mode}&wallet=${wallet}`) : Promise.resolve(null)), [wallet, mode, walletBump], 3000);
  const [tab, setTab] = useState<"open" | "history" | "transfers">("open");

  if (!wallet)
    return (
      <div className="page">
        <div className="empty">
          Connect a Solana wallet to see your Flip balance and pool positions.
          <button className="btn btn-primary" onClick={() => setVisible(true)}>
            Connect wallet
          </button>
        </div>
        <HlPanel tier={0} />
      </div>
    );
  const d = me.data;
  if (!d) return <div className="empty">Loading…</div>;
  const equity = d.balance + d.inTrades + d.unrealized + d.pool.value;
  const faucetWait = d.nextFaucetAt - now;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <span className="muted">{mode === "paper" ? "Test equity" : "Equity"}</span>
          <div className="big">{sol(equity)} SOL</div>
          <span className={`mono ${d.unrealized >= 0 ? "t-long" : "t-short"}`}>{signedSol(d.unrealized, 4)} SOL unrealized</span>
        </div>
      </div>
      <dl className="stat-row">
        <div>
          <dt>Available</dt>
          <dd className="num">{sol(d.balance)}</dd>
        </div>
        <div>
          <dt>In positions</dt>
          <dd className="num">{sol(d.inTrades)}</dd>
        </div>
        <div>
          <dt>In the pool</dt>
          <dd className="num">{sol(d.pool.value)}</dd>
        </div>
        <div>
          <dt>Realized P&amp;L</dt>
          <dd className={`num ${d.realized >= 0 ? "t-long" : "t-short"}`}>{signedSol(d.realized)}</dd>
        </div>
        <div>
          <dt>Holder tier</dt>
          <dd className="t-brand">{config?.tiers[d.tier]?.name ?? "None"}</dd>
        </div>
      </dl>

      <section className="panel">
        <div className="panel-body">
          {mode === "paper" ? (
            <div className="form-row">
              <button className="btn btn-primary" disabled={faucetWait > 0} onClick={() => act({ action: "faucet" }, { success: `Claimed ${sol(config?.paper.faucetAmount ?? 0, 0)} test SOL` }).then(() => me.reload())}>
                {faucetWait > 0 ? `Next claim in ${duration(faucetWait)}` : `Claim ${sol(config?.paper.faucetAmount ?? 0, 0)} test SOL`}
              </button>
              <p className="fine">Test SOL until real trading launches. Same prices, rules and pool math as the real thing.</p>
            </div>
          ) : (
            <div className="two-col">
              <div>
                <h3>Deposit</h3>
                <Deposit onDone={() => me.reload()} />
              </div>
              <div>
                <h3>Withdraw</h3>
                <Withdraw balance={d.balance} onDone={() => me.reload()} />
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel">
        <div className="pane-head">
          <div className="tabs" role="tablist">
            <button role="tab" aria-selected={tab === "open"} className={tab === "open" ? "on" : ""} onClick={() => setTab("open")}>
              Positions ({d.open.length})
            </button>
            <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "on" : ""} onClick={() => setTab("history")}>
              Trade history
            </button>
            {mode === "real" && (
              <button role="tab" aria-selected={tab === "transfers"} className={tab === "transfers" ? "on" : ""} onClick={() => setTab("transfers")}>
                Deposits and withdrawals
              </button>
            )}
          </div>
          <span className="spacer" />
          {tab === "open" && d.open.length > 1 && (
            <button className="btn btn-sm" onClick={() => act({ action: "close_all", mode }, { success: "Closed every position that could close" }).then(() => me.reload())}>
              Close all
            </button>
          )}
        </div>
        {tab === "open" && <OpenPositions positions={d.open} onChange={() => me.reload()} />}
        {tab === "history" && <History positions={d.closed} />}
        {tab === "transfers" && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Type</th>
                  <th className="num">Amount</th>
                  <th>Status</th>
                  <th className="num">Age</th>
                </tr>
              </thead>
              <tbody>
                {[
                  ...d.deposits.map((x) => ({ k: `d${x.sig}`, type: "Deposit", amount: x.amount, status: "Credited", ts: x.ts, sig: x.sig })),
                  ...d.withdrawals.map((x) => ({ k: `w${x.id}`, type: "Withdrawal", amount: x.amount, status: x.status === "failed" ? "Failed, refunded" : x.status === "sent" ? "Sent" : "Sending", ts: x.created_at, sig: x.sig })),
                ]
                  .sort((a, b) => b.ts - a.ts)
                  .map((r) => (
                    <tr key={r.k}>
                      <td>{r.type}</td>
                      <td className="num">{sol(r.amount)} SOL</td>
                      <td>
                        {r.sig ? (
                          <a href={`https://solscan.io/tx/${r.sig}`} target="_blank" rel="noreferrer">
                            {r.status}
                          </a>
                        ) : (
                          r.status
                        )}
                      </td>
                      <td className="num faint">{ago(r.ts, now)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <HlPanel tier={d.tier} />

      <p className="fine">
        Trades are signed by a browser key your wallet approved for 24 hours. It can trade but can't withdraw.{" "}
        <button
          className="link"
          onClick={async () => {
            await act({ action: "revoke_sessions" }, { wallet: true, success: "Signed out of trading on every device" });
            forgetSession(wallet);
          }}
        >
          Sign out everywhere
        </button>
      </p>
    </div>
  );
}
