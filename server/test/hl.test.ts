import { describe, it, expect } from "vitest";
import { HlLink, parseMap, parsePerps, DEFAULT_MAP } from "../src/hl/link.js";
import { PriceStore } from "../src/oracle/priceStore.js";

const MINT = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SOL_USD = 150;

function meta(perps: { name: string; markPx: number; szDecimals?: number; maxLeverage?: number; isDelisted?: boolean }[]) {
  return [
    { universe: perps.map((p) => ({ name: p.name, szDecimals: p.szDecimals ?? 0, maxLeverage: p.maxLeverage ?? 10, ...(p.isDelisted ? { isDelisted: true } : {}) })) },
    perps.map((p) => ({ markPx: String(p.markPx), midPx: String(p.markPx), oraclePx: String(p.markPx), funding: "0.0000125", openInterest: "1000", dayNtlVlm: "50000", prevDayPx: String(p.markPx) })),
  ];
}

function setup(flipPriceSol: number | null, opts: { listed?: boolean } = {}) {
  let t = 1_000_000;
  const now = () => t;
  const prices = new PriceStore(30_000, 1, 10_000, now);
  if (flipPriceSol !== null) prices.push(MINT, { price: flipPriceSol, liquidity: 1e12, mcapSol: 1e6, ts: t });
  const link = new HlLink(prices, () => opts.listed ?? true, {
    apiUrl: "http://x",
    pollMs: 15_000,
    maxDivergence: 0.03,
    confirmChecks: 2,
    map: [{ mint: MINT, coin: "kBONK", mult: 1000 }],
    now,
  });
  return { link, prices, tick: (ms: number) => (t += ms) };
}

// 1 BONK = 0.00002 USD → kBONK mark 0.02 → per token in SOL = 0.00002 / 150.
const bonkSol = 0.00002 / SOL_USD;

describe("hyperliquid link", () => {
  it("parses perps with asset ids in universe order", () => {
    const m = parsePerps(meta([{ name: "BTC", markPx: 100000 }, { name: "SOL", markPx: SOL_USD }, { name: "kBONK", markPx: 0.02, szDecimals: 0 }]));
    expect(m.get("BTC")!.asset).toBe(0);
    expect(m.get("kBONK")!.asset).toBe(2);
    expect(m.get("kBONK")!.markPx).toBe(0.02);
    expect(() => parsePerps({})).toThrow();
  });

  it("turns on only after consecutive agreeing checks", () => {
    const { link } = setup(bonkSol * 1.01);
    const raw = meta([{ name: "SOL", markPx: SOL_USD }, { name: "kBONK", markPx: 0.02 }]);
    link.ingest(raw);
    expect(link.view(MINT)!.state).toBe("checking");
    expect(link.view(MINT)!.routable).toBe(false);
    link.ingest(raw);
    const v = link.view(MINT)!;
    expect(v.state).toBe("verified");
    expect(v.routable).toBe(true);
    expect(v.asset).toBe(1);
    expect(v.divergence).toBeCloseTo(0.01, 6);
    expect(v.markSol).toBeCloseTo(bonkSol, 12);
  });

  it("refuses a link whose prices disagree (wrong mint, copycat ticker, wrong multiplier)", () => {
    const { link } = setup(bonkSol);
    // Same ticker but the perp quotes a single token, not 1,000 of them: 1000x off.
    const raw = meta([{ name: "SOL", markPx: SOL_USD }, { name: "kBONK", markPx: 20 }]);
    link.ingest(raw);
    link.ingest(raw);
    link.ingest(raw);
    expect(link.view(MINT)!.state).toBe("price_mismatch");
    expect(link.view(MINT)!.routable).toBe(false);
  });

  it("switches off after repeated disagreement and immediately on delisting", () => {
    const { link } = setup(bonkSol);
    const good = meta([{ name: "SOL", markPx: SOL_USD }, { name: "kBONK", markPx: 0.02 }]);
    link.ingest(good);
    link.ingest(good);
    expect(link.view(MINT)!.routable).toBe(true);
    const bad = meta([{ name: "SOL", markPx: SOL_USD }, { name: "kBONK", markPx: 0.03 }]);
    link.ingest(bad);
    expect(link.view(MINT)!.routable).toBe(true); // one bad check is tolerated
    link.ingest(bad);
    expect(link.view(MINT)!.routable).toBe(false);

    link.ingest(good);
    link.ingest(good);
    expect(link.view(MINT)!.routable).toBe(true);
    link.ingest(meta([{ name: "SOL", markPx: SOL_USD }, { name: "kBONK", markPx: 0.02, isDelisted: true }]));
    expect(link.view(MINT)!.state).toBe("delisted");
    expect(link.view(MINT)!.routable).toBe(false);
  });

  it("is off when the perp doesn't exist, the coin isn't listed, or there's no Solana price", () => {
    const a = setup(bonkSol);
    a.link.ingest(meta([{ name: "SOL", markPx: SOL_USD }]));
    a.link.ingest(meta([{ name: "SOL", markPx: SOL_USD }]));
    expect(a.link.view(MINT)!.state).toBe("not_listed");
    expect(a.link.view(MINT)!.routable).toBe(false);

    const b = setup(bonkSol, { listed: false });
    const raw = meta([{ name: "SOL", markPx: SOL_USD }, { name: "kBONK", markPx: 0.02 }]);
    b.link.ingest(raw);
    b.link.ingest(raw);
    expect(b.link.view(MINT)!.routable).toBe(false);

    const c = setup(null);
    c.link.ingest(raw);
    c.link.ingest(raw);
    expect(c.link.view(MINT)!.state).toBe("no_flip_price");
    expect(c.link.view(MINT)!.routable).toBe(false);
  });

  it("drops every link when Hyperliquid stops answering", async () => {
    const { link, tick, prices } = setup(bonkSol);
    const raw = meta([{ name: "SOL", markPx: SOL_USD }, { name: "kBONK", markPx: 0.02 }]);
    let fail = false;
    (link as any).opts.fetchImpl = async () => (fail ? new Response("", { status: 502 }) : new Response(JSON.stringify(raw)));
    await link.poll();
    await link.poll();
    expect(link.view(MINT)!.routable).toBe(true);
    fail = true;
    tick(20_000);
    prices.push(MINT, { price: bonkSol, liquidity: 1e12, mcapSol: 1e6, ts: 1_020_000 });
    await link.poll();
    expect(link.lastError).toMatch(/502/);
    expect(link.view(MINT)!.routable).toBe(true); // within the grace window
    tick(60_000);
    await link.poll();
    expect(link.view(MINT)!.routable).toBe(false);
  });

  it("only enables the builder fee once the builder account holds 100 USDC", async () => {
    const { link } = setup(bonkSol);
    (link as any).opts.builder = "0xabc";
    let value = "40";
    (link as any).opts.fetchImpl = async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      if (b.type === "clearinghouseState") return new Response(JSON.stringify({ marginSummary: { accountValue: value } }));
      return new Response(JSON.stringify(meta([{ name: "SOL", markPx: SOL_USD }, { name: "kBONK", markPx: 0.02 }])));
    };
    await link.poll();
    expect(link.builderValue).toBe(40);
    expect(link.builderReady()).toBe(false);
    value = "150";
    (link as any).builderCheckedAt = 0;
    await link.poll();
    expect(link.builderReady()).toBe(true);
  });

  it("parses map overrides", () => {
    const m = parseMap("Abc111:kPEPE,Def222:WIF:1," + DEFAULT_MAP[1].mint + ":-");
    expect(m.find((e) => e.mint === "Abc111")).toEqual({ mint: "Abc111", coin: "kPEPE", mult: 1000 });
    expect(m.find((e) => e.mint === "Def222")!.mult).toBe(1);
    expect(m.find((e) => e.mint === DEFAULT_MAP[1].mint)).toBeUndefined();
    expect(m.length).toBe(DEFAULT_MAP.length + 1);
  });
});
