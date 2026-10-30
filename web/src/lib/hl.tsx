// Hyperliquid route: the user's own Hyperliquid account, traded from Flip's ticket.
//
// Custody never touches Flip. The user's EVM wallet (Phantom's Ethereum account, MetaMask, Rabby…)
// signs two one-time approvals: a builder fee cap for Flip, and an agent key generated in this
// browser. The agent signs orders without wallet popups, and Hyperliquid does not let agents
// withdraw. Withdrawals and deposits always go through the wallet itself.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import { encodeFunctionData, getAddress, type EIP1193Provider } from "viem";
import { eip1193Wallet } from "./eip1193Wallet";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { useApp } from "./store";
import { buildMarketClose, buildMarketOpen, builderFeeFor, feeRateString, MIN_DEPOSIT_USDC, OrderBuildError, usdcUnits } from "./hlOrders";

export interface HlConfig {
  enabled: boolean;
  testnet?: boolean;
  apiUrl?: string;
  builder?: string | null;
  builderFee?: number;
  slippage?: number;
  maxDivergence?: number;
}

export interface HlPosition {
  coin: string;
  szi: string;
  size: number;
  side: "long" | "short";
  entryPx: number;
  positionValue: number;
  unrealizedPnl: number;
  returnOnEquity: number;
  liquidationPx: number | null;
  marginUsed: number;
  leverage: number;
  leverageType: string;
}

export interface HlAccount {
  accountValue: number;
  withdrawable: number;
  marginUsed: number;
  positions: HlPosition[];
  spotUsdc: number;
}

export type HlStatus = "no_wallet" | "disconnected" | "loading" | "needs_deposit" | "needs_setup" | "ready";

interface Meta {
  byName: Map<string, { asset: number; szDecimals: number; maxLeverage: number }>;
  at: number;
}

interface StoredAgent {
  user: string;
  pk: `0x${string}`;
  address: string;
  approvedAt: number;
}

interface HlState {
  cfg: HlConfig | null;
  status: HlStatus;
  user: string | null;
  account: HlAccount | null;
  busy: string | null;
  /** Fee this trader pays Flip, tenths of a bp, after holder-tier discount. */
  feeFor: (discountBps: number) => number;
  connect: () => Promise<void>;
  disconnect: () => void;
  setup: () => Promise<boolean>;
  open: (args: { coin: string; asset: number; szDecimals: number; isBuy: boolean; marginUsd: number; leverage: number; isolated: boolean; discountBps: number }) => Promise<{ avgPx: number; size: number } | null>;
  close: (coin: string, discountBps: number) => Promise<boolean>;
  deposit: (amount: string) => Promise<boolean>;
  withdraw: (amount: string) => Promise<boolean>;
  toPerps: (amount: string) => Promise<boolean>;
  refresh: () => void;
  mids: Record<string, string>;
  /** The user's Hyperliquid taker fee rate (fraction), when known. */
  takerRate: number | null;
}

const Ctx = createContext<HlState | null>(null);

export function useHl() {
  const c = useContext(Ctx);
  if (!c) throw new Error("useHl outside provider");
  return c;
}

const ARB = {
  mainnet: { chainId: "0xa4b1", name: "Arbitrum One", rpc: "https://arb1.arbitrum.io/rpc", explorer: "https://arbiscan.io", usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", bridge: "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7" },
  testnet: { chainId: "0x66eee", name: "Arbitrum Sepolia", rpc: "https://sepolia-rollup.arbitrum.io/rpc", explorer: "https://sepolia.arbiscan.io", usdc: "0x1baAbB04529D43a73232B713C0FE471f7c7334d5", bridge: "0x08cfc1B6b2dCF36A1480b99353A354AA8AC56f89" },
} as const;

const ERC20 = [
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ name: "to", type: "address" }, { name: "amount", type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ name: "a", type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** Phantom's Ethereum account first, then any injected EVM wallet. */
export function evmProvider(): EIP1193Provider | null {
  const w = window as any;
  return (w.phantom?.ethereum as EIP1193Provider | undefined) ?? (w.ethereum as EIP1193Provider | undefined) ?? null;
}

const agentKey = (user: string, testnet: boolean) => `flip:hl:agent:${testnet ? "t" : "m"}:${user.toLowerCase()}`;
const userKey = "flip:hl:user";

function loadAgent(user: string, testnet: boolean): StoredAgent | null {
  try {
    const raw = localStorage.getItem(agentKey(user, testnet));
    if (!raw) return null;
    const a = JSON.parse(raw) as StoredAgent;
    return a.user.toLowerCase() === user.toLowerCase() && /^0x[0-9a-f]{64}$/i.test(a.pk) ? a : null;
  } catch {
    return null;
  }
}

function saveAgent(a: StoredAgent, testnet: boolean) {
  try {
    localStorage.setItem(agentKey(a.user, testnet), JSON.stringify(a));
  } catch {
    /* key lives in memory for this tab only */
  }
}

function dropAgent(user: string, testnet: boolean) {
  try {
    localStorage.removeItem(agentKey(user, testnet));
  } catch {
    /* ignore */
  }
}

/** Errors Hyperliquid returns when the agent key is unknown or was replaced elsewhere. */
const AGENT_GONE = /does not exist|not.*(approved|authorized)|agent.*(invalid|expired)|User or API Wallet/i;

function message(e: any): string {
  const m = String(e?.message ?? e ?? "Something went wrong");
  if (/user rejected|denied|rejected the request|cancel/i.test(m)) return "Cancelled in wallet";
  return m.replace(/^order \d+: /, "");
}

export function HlProvider({ children }: { children: ReactNode }) {
  const { config, toast } = useApp();
  const cfg = config?.hl as HlConfig | undefined;
  const enabled = !!cfg?.enabled;
  const testnet = !!cfg?.testnet;
  const [user, setUser] = useState<string | null>(() => {
    try {
      return localStorage.getItem(userKey);
    } catch {
      return null;
    }
  });
  const [account, setAccount] = useState<HlAccount | null>(null);
  const [agentOk, setAgentOk] = useState(false);
  const [builderOk, setBuilderOk] = useState(false);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [mids, setMids] = useState<Record<string, string>>({});
  const [takerRate, setTakerRate] = useState<number | null>(null);
  const memAgent = useRef<StoredAgent | null>(null);
  const meta = useRef<Meta | null>(null);

  const transport = useMemo(() => (enabled ? new HttpTransport({ apiUrl: cfg?.apiUrl, isTestnet: testnet, timeout: 10_000 }) : null), [enabled, cfg?.apiUrl, testnet]);
  const info = useMemo(() => (transport ? new InfoClient({ transport }) : null), [transport]);
  const builder = cfg?.builder ?? null;
  const baseFee = builder ? (cfg?.builderFee ?? 0) : 0;
  const slippage = cfg?.slippage ?? 0.03;

  const agent = useCallback((): StoredAgent | null => {
    if (!user) return null;
    if (memAgent.current?.user.toLowerCase() === user.toLowerCase()) return memAgent.current;
    const a = loadAgent(user, testnet);
    memAgent.current = a;
    return a;
  }, [user, testnet]);

  const getMeta = useCallback(async () => {
    if (!info) throw new Error("Hyperliquid is off");
    if (meta.current && Date.now() - meta.current.at < 60_000) return meta.current;
    const m = await info.meta();
    const byName = new Map(m.universe.map((u, i) => [u.name, { asset: i, szDecimals: u.szDecimals, maxLeverage: u.maxLeverage }]));
    meta.current = { byName, at: Date.now() };
    return meta.current;
  }, [info]);

  // ---------- account polling ----------

  const refreshAccount = useCallback(async () => {
    if (!info || !user) return;
    try {
      const [ch, spot] = await Promise.all([info.clearinghouseState({ user: user as `0x${string}` }), info.spotClearinghouseState({ user: user as `0x${string}` }).catch(() => null)]);
      const usdc = spot?.balances.find((b) => b.coin === "USDC");
      setAccount({
        accountValue: Number(ch.marginSummary.accountValue),
        withdrawable: Number(ch.withdrawable),
        marginUsed: Number(ch.marginSummary.totalMarginUsed),
        spotUsdc: usdc ? Math.max(0, Number(usdc.total) - Number(usdc.hold)) : 0,
        positions: ch.assetPositions
          .map((ap) => ap.position)
          .filter((p) => Number(p.szi) !== 0)
          .map((p) => ({
            coin: p.coin,
            szi: p.szi,
            size: Math.abs(Number(p.szi)),
            side: Number(p.szi) > 0 ? "long" : "short",
            entryPx: Number(p.entryPx),
            positionValue: Number(p.positionValue),
            unrealizedPnl: Number(p.unrealizedPnl),
            returnOnEquity: Number(p.returnOnEquity),
            liquidationPx: p.liquidationPx === null ? null : Number(p.liquidationPx),
            marginUsed: Number(p.marginUsed),
            leverage: Number(p.leverage.value),
            leverageType: p.leverage.type,
          })),
      });
    } catch {
      /* keep last snapshot; the next poll retries */
    }
  }, [info, user]);

  const refreshApprovals = useCallback(async () => {
    if (!info || !user) return;
    try {
      const a = agent();
      const [agents, maxFee] = await Promise.all([
        a ? info.extraAgents({ user: user as `0x${string}` }) : Promise.resolve([]),
        builder ? info.maxBuilderFee({ user: user as `0x${string}`, builder: builder as `0x${string}` }) : Promise.resolve(Infinity),
      ]);
      const now = Date.now();
      const listed = !!a && agents.some((x) => x.address.toLowerCase() === a.address.toLowerCase() && (!x.validUntil || x.validUntil > now));
      // extraAgents can lag right after approval; trust a fresh local approval for a minute.
      setAgentOk(listed || (!!a && now - a.approvedAt < 60_000));
      setBuilderOk(Number(maxFee) >= baseFee);
      setChecked(true);
    } catch {
      /* retry next poll */
    }
  }, [info, user, agent, builder, baseFee]);

  useEffect(() => {
    setAccount(null);
    setChecked(false);
    setAgentOk(false);
    if (!info || !user) return;
    refreshAccount();
    refreshApprovals();
    setTakerRate(null);
    info
      .userFees({ user: user as `0x${string}` })
      .then((f) => setTakerRate(Number(f.userCrossRate)))
      .catch(() => {});
    const t = setInterval(refreshAccount, 3000);
    const t2 = setInterval(refreshApprovals, 30_000);
    return () => {
      clearInterval(t);
      clearInterval(t2);
    };
  }, [info, user, refreshAccount, refreshApprovals]);

  useEffect(() => {
    if (!info) return;
    let stop = false;
    const tick = () =>
      info
        .allMids()
        .then((m) => !stop && setMids(m))
        .catch(() => {});
    tick();
    const t = setInterval(tick, 2000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [info]);

  // Follow account switches in the wallet.
  useEffect(() => {
    const p = evmProvider() as any;
    if (!p?.on) return;
    const onAccounts = (accs: string[]) => {
      const next = accs?.[0] ? getAddress(accs[0]) : null;
      setUser((cur) => {
        if (cur && next && cur.toLowerCase() === next.toLowerCase()) return cur;
        try {
          if (next) localStorage.setItem(userKey, next);
          else localStorage.removeItem(userKey);
        } catch {
          /* ignore */
        }
        memAgent.current = null;
        return cur ? next : cur;
      });
    };
    p.on("accountsChanged", onAccounts);
    return () => p.removeListener?.("accountsChanged", onAccounts);
  }, []);

  // ---------- wallet ----------

  const mainExchange = useCallback(async () => {
    const p = evmProvider();
    if (!p || !user || !transport) throw new Error("Connect an EVM wallet first");
    const [addr] = (await p.request({ method: "eth_requestAccounts" })) as string[];
    if (!addr || addr.toLowerCase() !== user.toLowerCase()) throw new Error("Your wallet switched accounts. Reconnect to continue.");
    return new ExchangeClient({ transport, wallet: eip1193Wallet(p as any, getAddress(addr)) });
  }, [user, transport]);

  const agentExchange = useCallback(() => {
    const a = agent();
    if (!a || !transport) throw new Error("Set up trading first");
    return new ExchangeClient({ transport, wallet: privateKeyToAccount(a.pk) });
  }, [agent, transport]);

  const connect = useCallback(async () => {
    const p = evmProvider();
    if (!p) {
      toast("info", "No EVM wallet found. In Phantom, turn on Ethereum in Settings → Active networks, or install MetaMask/Rabby.");
      return;
    }
    try {
      const [addr] = (await p.request({ method: "eth_requestAccounts" })) as string[];
      if (!addr) return;
      const a = getAddress(addr);
      try {
        localStorage.setItem(userKey, a);
      } catch {
        /* ignore */
      }
      memAgent.current = null;
      setUser(a);
    } catch (e) {
      toast("info", message(e));
    }
  }, [toast]);

  const disconnect = useCallback(() => {
    try {
      localStorage.removeItem(userKey);
    } catch {
      /* ignore */
    }
    memAgent.current = null;
    setUser(null);
  }, []);

  /** One-time: builder fee cap (if Flip charges one) and an agent key. Each is a wallet signature. */
  const setup = useCallback(async (): Promise<boolean> => {
    if (!user || !info) return false;
    setBusy("setup");
    try {
      const ex = await mainExchange();
      if (builder && baseFee > 0) {
        const cur = Number(await info.maxBuilderFee({ user: user as `0x${string}`, builder: builder as `0x${string}` }));
        if (cur < baseFee) {
          toast("info", "Approve Flip's fee cap in your wallet (1 of 2)");
          await ex.approveBuilderFee({ builder: builder as `0x${string}`, maxFeeRate: feeRateString(baseFee) });
        }
        setBuilderOk(true);
      }
      const pk = generatePrivateKey();
      const acct = privateKeyToAccount(pk);
      toast("info", builder && baseFee > 0 ? "Approve the trading key in your wallet (2 of 2)" : "Approve the trading key in your wallet");
      // Named agent: approving again from another browser replaces it rather than piling up keys.
      await ex.approveAgent({ agentAddress: acct.address, agentName: "Flip" });
      const stored = { user, pk, address: acct.address, approvedAt: Date.now() };
      saveAgent(stored, testnet);
      memAgent.current = stored;
      setAgentOk(true);
      toast("ok", "Hyperliquid trading is on. Orders now sign in the background.");
      return true;
    } catch (e: any) {
      const m = message(e);
      toast(m === "Cancelled in wallet" ? "info" : "error", /does not exist|deposit/i.test(m) ? "Deposit to Hyperliquid first, then turn trading on." : m);
      return false;
    } finally {
      setBusy(null);
    }
  }, [user, info, mainExchange, builder, baseFee, testnet, toast]);

  const builderParam = useCallback(
    (discountBps: number) => {
      const f = builderFeeFor(baseFee, discountBps);
      return builder && f > 0 ? { builder: { b: builder as `0x${string}`, f } } : {};
    },
    [builder, baseFee],
  );

  const onAgentError = useCallback(
    (e: any) => {
      if (AGENT_GONE.test(String(e?.message)) && user) {
        dropAgent(user, testnet);
        memAgent.current = null;
        setAgentOk(false);
        toast("error", "Your trading key isn't active on Hyperliquid anymore. Turn trading on again.");
        return true;
      }
      return false;
    },
    [user, testnet, toast],
  );

  const open = useCallback<HlState["open"]>(
    async (o) => {
      if (!info) return null;
      setBusy("open");
      try {
        const ex = agentExchange();
        const mid = Number((await info.allMids())[o.coin]);
        const built = buildMarketOpen({ asset: o.asset, szDecimals: o.szDecimals, isBuy: o.isBuy, mid, slippage, marginUsd: o.marginUsd, leverage: o.leverage });
        const existing = account?.positions.find((p) => p.coin === o.coin);
        // Leverage is per coin on Hyperliquid. It can't be changed under an open position, so adding
        // to one keeps its leverage.
        if (!existing) await ex.updateLeverage({ asset: o.asset, isCross: !o.isolated, leverage: o.leverage });
        const r = await ex.order({ orders: [built.order], grouping: "na", ...builderParam(o.discountBps) });
        const st = r.response.data.statuses[0] as any;
        refreshAccount();
        if (st?.filled) return { avgPx: Number(st.filled.avgPx), size: Number(st.filled.totalSz) };
        toast("info", "Order rested instead of filling");
        return null;
      } catch (e: any) {
        if (e instanceof OrderBuildError) toast("info", e.message);
        else if (!onAgentError(e)) toast("error", message(e));
        return null;
      } finally {
        setBusy(null);
      }
    },
    [info, agentExchange, slippage, account, builderParam, refreshAccount, toast, onAgentError],
  );

  const close = useCallback<HlState["close"]>(
    async (coin, discountBps) => {
      if (!info) return false;
      const pos = account?.positions.find((p) => p.coin === coin);
      if (!pos) return false;
      setBusy(`close:${coin}`);
      try {
        const ex = agentExchange();
        const [m, mids] = await Promise.all([getMeta(), info.allMids()]);
        const am = m.byName.get(coin);
        if (!am) throw new Error(`${coin} isn't in Hyperliquid's market list`);
        const order = buildMarketClose({ asset: am.asset, szDecimals: am.szDecimals, szi: pos.szi, mid: Number(mids[coin]), slippage });
        const r = await ex.order({ orders: [order], grouping: "na", ...builderParam(discountBps) });
        const st = r.response.data.statuses[0] as any;
        refreshAccount();
        if (st?.filled) {
          toast("ok", `Closed ${coin} at ${Number(st.filled.avgPx)}`);
          return true;
        }
        toast("info", "Close didn't fill. Try again.");
        return false;
      } catch (e: any) {
        if (e instanceof OrderBuildError) toast("info", e.message);
        else if (!onAgentError(e)) toast("error", message(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [info, account, agentExchange, getMeta, slippage, builderParam, refreshAccount, toast, onAgentError],
  );

  // ---------- funds ----------

  const deposit = useCallback(
    async (amount: string) => {
      const p = evmProvider();
      if (!p || !user) return false;
      const net = testnet ? ARB.testnet : ARB.mainnet;
      let units: bigint;
      try {
        units = usdcUnits(amount);
      } catch (e: any) {
        toast("info", e.message);
        return false;
      }
      if (units < BigInt(MIN_DEPOSIT_USDC) * 1_000_000n) {
        toast("error", `Minimum deposit is ${MIN_DEPOSIT_USDC} USDC. Hyperliquid's bridge loses anything smaller.`);
        return false;
      }
      setBusy("deposit");
      try {
        try {
          await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: net.chainId }] });
        } catch (e: any) {
          if (e?.code !== 4902) throw e;
          await p.request({
            method: "wallet_addEthereumChain",
            params: [{ chainId: net.chainId, chainName: net.name, rpcUrls: [net.rpc], nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, blockExplorerUrls: [net.explorer] }],
          });
        }
        const chain = String(await p.request({ method: "eth_chainId" })).toLowerCase();
        if (chain !== net.chainId) throw new Error(`Your wallet is not on ${net.name}. Switch it and try again.`);
        const bal = BigInt(
          (await p.request({ method: "eth_call", params: [{ to: net.usdc, data: encodeFunctionData({ abi: ERC20, functionName: "balanceOf", args: [user as `0x${string}`] }) }, "latest"] })) as string,
        );
        if (bal < units) throw new Error(`You have ${(Number(bal) / 1e6).toFixed(2)} USDC on ${net.name}.`);
        const hash = await p.request({
          method: "eth_sendTransaction",
          params: [{ from: user as `0x${string}`, to: net.usdc, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [net.bridge, units] }) }],
        });
        toast("ok", `Deposit sent (${String(hash).slice(0, 10)}…). Hyperliquid credits it in about a minute.`);
        return true;
      } catch (e: any) {
        const m = message(e);
        toast(m === "Cancelled in wallet" ? "info" : "error", /switch|chain|unrecognized|4902|unsupported/i.test(m) && !/You have/.test(m) ? `${m}. If your wallet can't use ${net.name}, deposit at app.hyperliquid.xyz with this same address.` : m);
        return false;
      } finally {
        setBusy(null);
      }
    },
    [user, testnet, toast],
  );

  const withdraw = useCallback(
    async (amount: string) => {
      if (!user) return false;
      setBusy("withdraw");
      try {
        const n = Number(amount);
        if (!(n > 1)) throw new OrderBuildError("Hyperliquid charges $1 per withdrawal, so withdraw more than 1 USDC");
        const ex = await mainExchange();
        await ex.withdraw3({ destination: user as `0x${string}`, amount: String(n) });
        toast("ok", `Withdrawing ${n} USDC to ${testnet ? ARB.testnet.name : ARB.mainnet.name}. It lands in a few minutes.`);
        refreshAccount();
        return true;
      } catch (e: any) {
        toast(e instanceof OrderBuildError || message(e) === "Cancelled in wallet" ? "info" : "error", message(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [user, mainExchange, testnet, toast, refreshAccount],
  );

  const toPerps = useCallback(
    async (amount: string) => {
      if (!user) return false;
      setBusy("toPerps");
      try {
        const n = Number(amount);
        if (!(n > 0)) throw new OrderBuildError("Enter an amount");
        const ex = await mainExchange();
        await ex.usdClassTransfer({ amount: String(n), toPerp: true });
        toast("ok", `Moved ${n} USDC to your perps balance`);
        refreshAccount();
        return true;
      } catch (e: any) {
        toast(e instanceof OrderBuildError || message(e) === "Cancelled in wallet" ? "info" : "error", message(e));
        return false;
      } finally {
        setBusy(null);
      }
    },
    [user, mainExchange, toast, refreshAccount],
  );

  const status: HlStatus = !enabled
    ? "disconnected"
    : !user
      ? evmProvider()
        ? "disconnected"
        : "no_wallet"
      : !account || !checked
        ? "loading"
        : account.accountValue <= 0 && account.spotUsdc <= 0 && account.positions.length === 0
          ? "needs_deposit"
          : agentOk && builderOk
            ? "ready"
            : "needs_setup";

  const value = useMemo<HlState>(
    () => ({
      cfg: cfg ?? null,
      status,
      user,
      account,
      busy,
      feeFor: (d: number) => builderFeeFor(baseFee, d),
      connect,
      disconnect,
      setup,
      open,
      close,
      deposit,
      withdraw,
      toPerps,
      refresh: refreshAccount,
      mids,
      takerRate,
    }),
    [cfg, status, user, account, busy, baseFee, connect, disconnect, setup, open, close, deposit, withdraw, toPerps, refreshAccount, mids, takerRate],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
