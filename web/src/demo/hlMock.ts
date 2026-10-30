// Simulated Hyperliquid for the hosted demo. Runs in the page: orders fill at mid, balances are
// play USDC, and a demo EVM wallet stands in for Phantom/MetaMask so no real wallet is ever asked to
// sign or send anything. Signatures are not checked here (scripts/mock_hyperliquid.py does that).

export const DEMO_HL_URL = "https://demo-hyperliquid.invalid";
const SOL_USD = 150;
const DEMO_USER = "0xDe00000000000000000000000000000000000001";

export const DEMO_HL_MAP = [
  { mint: "DemoGoose2222222222222222222222222222222pump", coin: "GOOSE", mult: 1 },
  { mint: "DemoBagel5555555555555555555555555555555pump", coin: "kBAGEL", mult: 1000 },
  { mint: "DemoDrip99999999999999999999999999999999pump", coin: "DRIP", mult: 1 },
  { mint: "DemoChad77777777777777777777777777777777pump", coin: "CHAD", mult: 1 },
];

const UNIVERSE = [
  { name: "BTC", szDecimals: 5, maxLeverage: 40 },
  { name: "SOL", szDecimals: 2, maxLeverage: 20 },
  ...DEMO_HL_MAP.map((e) => ({ name: e.coin, szDecimals: 0, maxLeverage: 10 })),
];

interface Pos {
  szi: number;
  entryPx: number;
  margin: number;
  lev: number;
  cross: boolean;
}

const st = {
  usdc: 0,
  agent: false,
  agentAddr: "",
  builderMax: 0,
  pos: new Map<string, Pos>(),
  lev: new Map<string, { lev: number; cross: boolean }>(),
  chain: "0x1",
  connected: false,
};

let prices: Record<string, number> = {};
let pricesAt = 0;

async function refreshPrices(fetchLocal: typeof fetch) {
  if (Date.now() - pricesAt < 1000) return;
  pricesAt = Date.now();
  try {
    const ms = (await (await fetchLocal(`${location.origin}/api/markets?mode=paper`)).json()) as { mint: string; price: number | null }[];
    prices = Object.fromEntries(ms.filter((m) => m.price).map((m) => [m.mint, m.price!]));
  } catch {
    /* keep last */
  }
}

function mids(): Record<string, number> {
  const out: Record<string, number> = { BTC: 100_000, SOL: SOL_USD };
  for (const e of DEMO_HL_MAP) {
    const p = prices[e.mint];
    if (p) out[e.coin] = p * SOL_USD * e.mult * 1.002;
  }
  return out;
}

const s = (n: number) => String(Number(n.toPrecision(10)));

function clearinghouse() {
  const m = mids();
  let used = 0;
  let upnl = 0;
  const assetPositions = [...st.pos.entries()].map(([coin, p]) => {
    const mid = m[coin] ?? p.entryPx;
    const pnl = p.szi * (mid - p.entryPx);
    upnl += pnl;
    used += p.margin;
    const move = 1 / p.lev - 1 / 20;
    const liq = p.szi > 0 ? p.entryPx * (1 - move) : p.entryPx * (1 + move);
    return {
      type: "oneWay",
      position: {
        coin,
        szi: s(p.szi),
        leverage: { type: p.cross ? "cross" : "isolated", value: p.lev },
        entryPx: s(p.entryPx),
        positionValue: s(Math.abs(p.szi) * mid),
        unrealizedPnl: s(pnl),
        returnOnEquity: s(pnl / p.margin),
        liquidationPx: s(liq),
        marginUsed: s(p.margin + pnl),
        maxLeverage: 10,
        cumFunding: { allTime: "0", sinceOpen: "0", sinceChange: "0" },
      },
    };
  });
  const av = st.usdc + used + upnl;
  const summ = { accountValue: s(av), totalNtlPos: "0", totalRawUsd: s(av), totalMarginUsed: s(used) };
  return { marginSummary: summ, crossMarginSummary: summ, crossMaintenanceMarginUsed: "0", withdrawable: s(st.usdc), assetPositions, time: Date.now() };
}

function info(body: any) {
  const m = mids();
  switch (body.type) {
    case "meta":
      return { universe: UNIVERSE, marginTables: [], collateralToken: 0 };
    case "metaAndAssetCtxs":
      return [
        { universe: UNIVERSE, marginTables: [], collateralToken: 0 },
        UNIVERSE.map((u) => {
          const p = s(m[u.name] ?? 0);
          return { markPx: p, midPx: p, oraclePx: p, funding: "0.0000125", openInterest: "250000", dayNtlVlm: "4200000", prevDayPx: p, premium: "0", impactPxs: null, dayBaseVlm: "0" };
        }),
      ];
    case "allMids":
      return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, s(v)]));
    case "clearinghouseState":
      return clearinghouse();
    case "spotClearinghouseState":
      return { balances: [] };
    case "extraAgents":
      return st.agent ? [{ address: st.agentAddr, name: "Flip", validUntil: Date.now() + 1e10 }] : [];
    case "maxBuilderFee":
      return st.builderMax;
    case "userFees":
      return { userCrossRate: "0.00045", userAddRate: "0.00015", dailyUserVlm: [], feeSchedule: {}, userSpotCrossRate: "0.0007", userSpotAddRate: "0.0004", activeReferralDiscount: "0" };
  }
  return null;
}

const ok = { status: "ok", response: { type: "default" } };
const err = (m: string) => ({ status: "err", response: m });

function exchange(body: any) {
  const a = body.action;
  switch (a.type) {
    case "approveBuilderFee":
      st.builderMax = Math.round(Number(String(a.maxFeeRate).replace("%", "")) * 1000);
      return ok;
    case "approveAgent":
      if (st.usdc <= 0 && st.pos.size === 0) return err(`User or API Wallet ${DEMO_USER} does not exist.`);
      st.agent = true;
      st.agentAddr = a.agentAddress;
      return ok;
    case "withdraw3": {
      const n = Number(a.amount);
      if (n > st.usdc) return err("Insufficient balance for withdrawal");
      st.usdc -= n;
      return ok;
    }
    case "usdClassTransfer":
      return err("No spot USDC in the demo");
    case "updateLeverage": {
      const coin = UNIVERSE[a.asset].name;
      if (st.pos.has(coin)) return err("Cannot switch leverage type with open position.");
      st.lev.set(coin, { lev: a.leverage, cross: a.isCross });
      return ok;
    }
    case "order": {
      if (!st.agent) return err("User or API Wallet does not exist.");
      if (a.builder && a.builder.f > st.builderMax) return err("Builder fee has not been approved.");
      const m = mids();
      const statuses = a.orders.map((o: any) => {
        const coin = UNIVERSE[o.a].name;
        const mid = m[coin];
        const px = Number(o.p);
        const sz = Number(o.s);
        if (!mid || (o.b && px < mid) || (!o.b && px > mid)) return { error: "Order could not immediately match against any resting orders." };
        const fee = sz * mid * (0.00045 + (a.builder ? a.builder.f / 100_000 : 0));
        const p = st.pos.get(coin);
        const signed = o.b ? sz : -sz;
        if (o.r) {
          if (!p || p.szi > 0 === o.b || sz > Math.abs(p.szi) + 1e-9) return { error: "Reduce only order would increase position." };
          const frac = sz / Math.abs(p.szi);
          const pnl = (mid - p.entryPx) * (p.szi > 0 ? sz : -sz);
          st.usdc += p.margin * frac + pnl - fee;
          p.margin -= p.margin * frac;
          p.szi += signed;
          if (Math.abs(p.szi) < 1e-9) st.pos.delete(coin);
        } else {
          const { lev, cross } = st.lev.get(coin) ?? { lev: 5, cross: false };
          const margin = (sz * mid) / lev;
          if (margin + fee > st.usdc) return { error: "Insufficient margin to place order." };
          st.usdc -= margin + fee;
          if (p) {
            const tot = p.szi + signed;
            p.entryPx = (p.entryPx * Math.abs(p.szi) + mid * sz) / Math.abs(tot);
            p.szi = tot;
            p.margin += margin;
          } else st.pos.set(coin, { szi: signed, entryPx: mid, margin, lev, cross });
        }
        return { filled: { totalSz: o.s, avgPx: s(mid), oid: Date.now() } };
      });
      if (statuses.every((x: any) => x.error)) return err(statuses[0].error);
      return { status: "ok", response: { type: "order", data: { statuses } } };
    }
  }
  return err(`The demo doesn't simulate ${a.type}`);
}

/** Demo EVM wallet. Deposits credit play USDC; nothing leaves the page. */
const listeners: Record<string, ((x: any) => void)[]> = {};
export const demoEvmProvider = {
  isDemo: true,
  on(e: string, f: (x: any) => void) {
    (listeners[e] ??= []).push(f);
  },
  removeListener() {},
  async request({ method, params }: { method: string; params?: any[] }) {
    switch (method) {
      case "eth_requestAccounts":
      case "eth_accounts":
        st.connected = true;
        return [DEMO_USER];
      case "eth_chainId":
        return st.chain;
      case "wallet_switchEthereumChain":
        st.chain = params![0].chainId;
        return null;
      case "eth_signTypedData_v4":
        // Placeholder signature: the simulated exchange doesn't verify, a real one does.
        return "0x" + "11".repeat(32) + "22".repeat(32) + "1b";
      case "eth_call":
        return "0x" + (1000n * 1_000_000n).toString(16);
      case "eth_sendTransaction": {
        const data: string = params![0].data;
        const amount = Number(BigInt("0x" + data.slice(74))) / 1e6;
        setTimeout(() => (st.usdc += amount), 1500);
        return "0x" + "de".repeat(32);
      }
    }
    throw Object.assign(new Error(`Demo wallet doesn't support ${method}`), { code: 4200 });
  },
};

export function installHlMock(fetchLocal: typeof fetch) {
  (window as any).__flipDemoEvm = demoEvmProvider;
  const prev = window.fetch;
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(DEMO_HL_URL)) return prev(input as any, init);
    await refreshPrices(fetchLocal);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const path = new URL(url).pathname;
    const out = path === "/info" ? info(body) : path === "/exchange" ? exchange(body) : null;
    await new Promise((r) => setTimeout(r, 120)); // feel like a network
    return new Response(JSON.stringify(out), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}
