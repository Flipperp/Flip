import { useState } from "react";
import { NavLink, Navigate, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useApp } from "./lib/store";
import { short } from "./lib/format";
import Trade, { TradeHome } from "./pages/Trade";
import Markets from "./pages/Markets";
import Portfolio from "./pages/Portfolio";
import Pool from "./pages/Pool";
import Holders from "./pages/Holders";
import How from "./pages/How";

const DEMO = (import.meta as any).env?.VITE_DEMO === "true";

function Logo() {
  return (
    <svg viewBox="0 0 28 28" width="24" height="24" aria-hidden>
      {/* Two arrows trading places: long and short on one coin. */}
      <path d="M5 10h14l-4-4M23 18H9l4 4" fill="none" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function WalletButton() {
  const { publicKey, disconnect, connecting, wallet } = useWallet();
  const { setVisible } = useWalletModal();
  const [menu, setMenu] = useState(false);
  if (!publicKey)
    return (
      <button className="btn btn-primary" onClick={() => setVisible(true)} disabled={connecting}>
        {connecting ? "Connecting…" : "Connect wallet"}
      </button>
    );
  return (
    <div className="wallet-menu">
      <button className="btn" onClick={() => setMenu((m) => !m)} aria-expanded={menu}>
        {wallet?.adapter.icon && <img src={wallet.adapter.icon} alt="" width={16} height={16} />}
        <span className="mono">{short(publicKey.toBase58())}</span>
      </button>
      {menu && (
        <div className="menu" onMouseLeave={() => setMenu(false)}>
          <NavLink to="/portfolio" onClick={() => setMenu(false)}>
            Portfolio
          </NavLink>
          <button
            onClick={() => {
              navigator.clipboard?.writeText(publicKey.toBase58()).catch(() => {});
              setMenu(false);
            }}
          >
            Copy address
          </button>
          <button
            onClick={() => {
              disconnect();
              setMenu(false);
            }}
          >
            Disconnect
          </button>
        </div>
      )}
    </div>
  );
}

function TokenChip() {
  const { config } = useApp();
  const [copied, setCopied] = useState(false);
  if (!config) return null;
  return (
    <button
      className="token-chip"
      onClick={() => {
        if (!config.tokenMint) return;
        navigator.clipboard?.writeText(config.tokenMint).catch(() => {});
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      }}
      title={config.tokenMint ? "Copy token address" : "Token not launched yet"}
    >
      ${config.brand.ticker}
      <span>{copied ? "copied" : config.tokenMint ? short(config.tokenMint) : "soon"}</span>
    </button>
  );
}

function Toasts() {
  const { toasts } = useApp();
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

function LegacyCoin() {
  const { mint } = useParams();
  const { search } = useLocation();
  return <Navigate to={`/trade/${mint}${search}`} replace />;
}

export default function App() {
  const { config, mode, connected } = useApp();
  const halted = config?.halted?.[mode];
  return (
    <>
      <header className="top">
        <NavLink to="/trade" className="logo" aria-label="Flip home">
          <Logo />
          Flip
        </NavLink>
        <nav className="nav" aria-label="Main">
          <NavLink to="/trade">Trade</NavLink>
          <NavLink to="/markets">Markets</NavLink>
          <NavLink to="/portfolio">Portfolio</NavLink>
          <NavLink to="/pool">Pool</NavLink>
          <NavLink to="/holders">Holders</NavLink>
          <NavLink to="/docs">Docs</NavLink>
        </nav>
        <div className="top-right">
          <TokenChip />
          <WalletButton />
        </div>
      </header>
      {DEMO ? (
        <div className="banner banner-paper">Demo: simulated coins, simulated Hyperliquid, demo wallets. Nothing here is real money.</div>
      ) : config && !config.realEnabled && <div className="banner banner-paper">Pre-launch: pool trades use test SOL on live prices. Hyperliquid trades are real.</div>}
      {halted && <div className="banner banner-halt">Trading is paused: {halted}. Open positions still settle at their limits.</div>}
      {!connected && config && <div className="banner banner-warn">Reconnecting to live prices…</div>}
      <main>
        <Routes>
          <Route path="/" element={<TradeHome />} />
          <Route path="/trade" element={<TradeHome />} />
          <Route path="/trade/:mint" element={<Trade />} />
          <Route path="/coin/:mint" element={<LegacyCoin />} />
          <Route path="/markets" element={<Markets />} />
          <Route path="/portfolio" element={<Portfolio />} />
          <Route path="/pool" element={<Pool />} />
          <Route path="/holders" element={<Holders />} />
          <Route path="/docs" element={<How />} />
          <Route path="/how" element={<Navigate to="/docs" replace />} />
          <Route
            path="*"
            element={
              <div className="empty">
                Nothing at this address.
                <NavLink className="btn" to="/trade">
                  Go to trading
                </NavLink>
              </div>
            }
          />
        </Routes>
      </main>
      <Toasts />
    </>
  );
}
