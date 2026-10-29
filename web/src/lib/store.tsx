import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { ApiError, get, sessionAction, walletAction, wsUrl, type Config, type Market, type Mode, type TapeEvent } from "./api";

interface PoolTick {
  cash: number;
  nav: number;
  sharePrice: number;
  outOnTrades: number;
  free: number;
}

interface Toast {
  id: number;
  kind: "ok" | "error" | "info";
  text: string;
}

interface AppState {
  config: Config | null;
  mode: Mode;
  setMode: (m: Mode) => void;
  markets: Map<string, Market>;
  upsertMarket: (m: Market) => void;
  tape: TapeEvent[];
  pool: PoolTick | null;
  solUsd: number;
  connected: boolean;
  /** Increments whenever an event touches the connected wallet, so pages can refetch. */
  walletBump: number;
  toasts: Toast[];
  toast: (kind: Toast["kind"], text: string) => void;
  watch: (mint: string) => void;
  act: <T = any>(payload: object, opts?: { wallet?: boolean; success?: string }) => Promise<T | null>;
  wallet: string | null;
}

const Ctx = createContext<AppState | null>(null);

export function useApp() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useApp outside provider");
  return c;
}

function initialMode(): Mode {
  try {
    const m = localStorage.getItem("flip:mode");
    if (m === "real" || m === "paper") return m;
  } catch {
    /* ignore */
  }
  return "paper";
}

export function AppProvider({ children }: { children: ReactNode }) {
  const { publicKey, signMessage } = useWallet();
  const wallet = publicKey?.toBase58() ?? null;
  const [config, setConfig] = useState<Config | null>(null);
  const [mode, setModeState] = useState<Mode>(initialMode);
  const [markets, setMarkets] = useState<Map<string, Market>>(new Map());
  const [tape, setTape] = useState<TapeEvent[]>([]);
  const [pool, setPool] = useState<PoolTick | null>(null);
  const [solUsd, setSolUsd] = useState(0);
  const [connected, setConnected] = useState(false);
  const [walletBump, setWalletBump] = useState(0);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const walletRef = useRef(wallet);
  walletRef.current = wallet;

  const toast = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3500);
  }, []);

  const setMode = useCallback((m: Mode) => {
    setModeState(m);
    try {
      localStorage.setItem("flip:mode", m);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    get<Config>("/api/config")
      .then((c) => {
        setConfig(c);
        setSolUsd(c.solUsd);
        if (!c.realEnabled) setModeState("paper");
      })
      .catch(() => toast("error", "Can't reach the server. Retrying…"));
  }, [toast]);

  // REST snapshot when mode changes.
  useEffect(() => {
    let cancelled = false;
    Promise.all([get<Market[]>(`/api/markets?mode=${mode}`), get<TapeEvent[]>(`/api/tape?mode=${mode}`)])
      .then(([ms, t]) => {
        if (cancelled) return;
        setMarkets(new Map(ms.map((m) => [m.mint, m])));
        setTape(t);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [mode]);

  // Live socket with reconnect.
  useEffect(() => {
    let closed = false;
    let retry: ReturnType<typeof setTimeout>;
    const open = () => {
      const ws = new WebSocket(wsUrl(mode));
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) retry = setTimeout(open, 2000);
      };
      ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "tick") {
          setSolUsd(msg.solUsd || 0);
          setPool(msg.pool);
          setMarkets((prev) => {
            const next = new Map(prev);
            for (const t of msg.markets) {
              const cur = next.get(t.mint);
              if (cur) next.set(t.mint, { ...cur, ...t });
            }
            return next;
          });
        } else if (msg.type === "event") {
          const e = msg.event as TapeEvent;
          if (["open", "close", "max_win", "liquidated", "pool_add", "pool_remove", "creator_fee", "reward"].includes(e.kind)) {
            setTape((t) => [e, ...t].slice(0, 80));
          }
          if (e.wallet && e.wallet === walletRef.current) setWalletBump((b) => b + 1);
          if (e.kind === "liquidated" && e.wallet === walletRef.current) toast("error", `Your ${e.data?.side} on $${e.symbol} was liquidated`);
          if (e.kind === "max_win" && e.wallet === walletRef.current) toast("ok", `Your ${e.data?.side} on $${e.symbol} hit max win`);
        } else if (msg.type === "halt") {
          setConfig((c) => (c ? { ...c, halted: { ...c.halted, [msg.mode]: msg.reason } } : c));
        }
      };
    };
    open();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
    };
  }, [mode, toast]);

  const watch = useCallback((mint: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ watch: mint }));
  }, []);

  const upsertMarket = useCallback((m: Market) => setMarkets((prev) => new Map(prev).set(m.mint, m)), []);

  const act = useCallback(
    async <T,>(payload: object, opts?: { wallet?: boolean; success?: string }): Promise<T | null> => {
      if (!config) return null;
      if (!wallet || !signMessage) {
        toast("info", "Connect a wallet that supports message signing");
        return null;
      }
      try {
        const fn = opts?.wallet ? walletAction : sessionAction;
        const r = await fn<T>(config.brand.name, wallet, signMessage, payload);
        if (opts?.success) toast("ok", opts.success);
        setWalletBump((b) => b + 1);
        return r;
      } catch (e: any) {
        if (e instanceof ApiError) toast("error", e.message);
        else if (/reject|denied|cancel/i.test(String(e?.message))) toast("info", "Signature cancelled");
        else toast("error", String(e?.message ?? e));
        return null;
      }
    },
    [config, wallet, signMessage, toast],
  );

  const value = useMemo<AppState>(
    () => ({ config, mode, setMode, markets, upsertMarket, tape, pool, solUsd, connected, walletBump, toasts, toast, watch, act, wallet }),
    [config, mode, setMode, markets, upsertMarket, tape, pool, solUsd, connected, walletBump, toasts, toast, watch, act, wallet],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePoll<T>(fn: () => Promise<T>, deps: unknown[], everyMs = 0) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(() => {
    fn()
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e) => setError(String(e?.message ?? e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    reload();
    if (!everyMs) return;
    const t = setInterval(reload, everyMs);
    return () => clearInterval(t);
  }, [reload, everyMs]);
  return { data, error, reload, setData };
}
