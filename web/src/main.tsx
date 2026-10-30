import { Buffer } from "buffer";
(globalThis as any).Buffer = Buffer;
import { StrictMode, useMemo } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, HashRouter } from "react-router-dom";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import { AppProvider } from "./lib/store";
import { HlProvider } from "./lib/hl";
import App from "./App";
import { DemoWalletAdapter } from "./demo/wallet";

const DEMO = (import.meta as any).env?.VITE_DEMO === "true";
const Router = DEMO ? HashRouter : BrowserRouter;

const RPC = (import.meta.env.VITE_RPC_URL as string | undefined) ?? "https://api.mainnet-beta.solana.com";

function Root() {
  // Wallet Standard auto-detects Phantom, Solflare, Backpack and others; no adapters needed.
  const wallets = useMemo(() => (DEMO ? [new DemoWalletAdapter()] : []), []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>
          <Router>
            <AppProvider>
              <HlProvider>
                <App />
              </HlProvider>
            </AppProvider>
          </Router>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
