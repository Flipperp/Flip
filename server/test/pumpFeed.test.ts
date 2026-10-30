import { describe, it, expect } from "vitest";
import { PumpFeed, parseMessage, clean, safeImageUrl } from "../src/oracle/pumpFeed.js";
import { pruneMarkets } from "../src/oracle/prune.js";
import { openDb } from "../src/db.js";

const MINT = "D8rv2bojgw9fXSxHgRFGwqVfUzm54BmtxRzA2sqYpump";
// Shape of a real PumpPortal create event (captured from the live feed).
const CREATE = {
  signature: "2qkAn9s52eWdtEGuTUXz2tLJjRZzsUgWAEx1uoR9YgvQ22ZbBDNFM9PvEdDNojFvbeGCcgYBhocw7kH8NEyJRcRc",
  mint: MINT,
  traderPublicKey: "9k8fSCeUiFPt6umv9E5iWWeiHsPKtbN1W3BJNwXHfcdm",
  txType: "create",
  initialBuy: 2115327.702796,
  solAmount: 0.059259258,
  bondingCurveKey: "G8yYByjCcDubuqyz8tdNfELFTdmmxvy4kGX81oyphpUg",
  vTokensInBondingCurve: 1070884672.297204,
  vSolInBondingCurve: 30.059259257999976,
  marketCapSol: 28.069557848389476,
  name: "Plsx100",
  symbol: "Plsx100",
  uri: "https://ipfs.io/ipfs/bafkreiaxt5sxc62jcixoef33rizjfhjcnhmoix2u6uzrzxnbd4odva6mge",
  pool: "pump",
};

describe("pump.fun feed", () => {
  it("parses launches and graduations, ignores everything else", () => {
    const r = parseMessage(CREATE, 1000)!;
    expect(r.pair).toMatchObject({ mint: MINT, symbol: "Plsx100", devBuySol: 0.059259258, createdAt: 1000 });
    expect(r.pair!.launchMcapSol).toBeCloseTo(28.07, 2);
    expect(r.uri).toBe(CREATE.uri);
    expect(parseMessage({ txType: "migrate", mint: MINT }, 5)!.graduation).toEqual({ mint: MINT, at: 5 });
    expect(parseMessage({ message: "Successfully subscribed to token creation events." }, 1)).toBeNull();
    expect(parseMessage({ txType: "create", mint: "not a mint" }, 1)).toBeNull();
    expect(parseMessage({ txType: "buy", mint: MINT }, 1)).toBeNull();
  });

  it("treats feed text as untrusted", () => {
    expect(clean("A‮B\u0000C" + "x".repeat(100), 10)).toBe("ABCxxxxxxx");
    expect(safeImageUrl("javascript:alert(1)")).toBeNull();
    expect(safeImageUrl("http://insecure.example/x.png")).toBeNull();
    expect(safeImageUrl("https://ipfs.io/ipfs/abc")).toBe("https://ipfs.io/ipfs/abc");
  });

  it("keeps the newest launches, dedupes graduations, and lists graduated coins through the resolver", async () => {
    const resolved: string[] = [];
    const f = new PumpFeed({
      url: "x",
      keep: 3,
      autoListGraduated: true,
      resolveGapMs: 0,
      fetchImages: false,
      resolve: async (m) => {
        resolved.push(m);
      },
    });
    for (let i = 0; i < 5; i++) f.handle({ ...CREATE, symbol: `T${i}` });
    expect(f.recent().map((p) => p.symbol)).toEqual(["T4", "T3", "T2"]);
    f.handle({ txType: "migrate", mint: MINT });
    f.handle({ txType: "migrate", mint: MINT });
    await new Promise((r) => setTimeout(r, 10));
    expect(f.graduations().length).toBe(1);
    expect(resolved).toEqual([MINT]);
    expect(f.counts).toMatchObject({ launches: 5, graduations: 2, listed: 1 });
  });

  it("reconnects after the socket closes", async () => {
    const sockets: any[] = [];
    class FakeWS {
      onopen?: () => void;
      onclose?: () => void;
      onmessage?: (e: any) => void;
      onerror?: () => void;
      sent: string[] = [];
      constructor() {
        sockets.push(this);
        setTimeout(() => this.onopen?.(), 0);
      }
      send(s: string) {
        this.sent.push(s);
      }
      close() {
        this.onclose?.();
      }
    }
    const f = new PumpFeed({ url: "x", keep: 10, autoListGraduated: false, resolveGapMs: 0, fetchImages: false, resolve: null, WebSocketImpl: FakeWS as any });
    f.start();
    await new Promise((r) => setTimeout(r, 5));
    expect(f.connected).toBe(true);
    expect(sockets[0].sent.map((s: string) => JSON.parse(s).method)).toEqual(["subscribeNewToken", "subscribeMigration"]);
    sockets[0].onmessage({ data: JSON.stringify(CREATE) });
    expect(f.recent().length).toBe(1);
    sockets[0].close();
    expect(f.connected).toBe(false);
    await new Promise((r) => setTimeout(r, 1100));
    expect(sockets.length).toBe(2);
    expect(f.connected).toBe(true);
    f.stop();
  });
});

describe("market pruning", () => {
  it("prunes inactive, unprotected markets with no open positions", () => {
    const db = openDb(":memory:");
    const add = (mint: string, t: number) =>
      db.prepare("INSERT INTO markets (mint, symbol, name, venue, source, supply, added_at, last_viewed) VALUES (?, 'S', 'S', 'pumpswap', '{}', 1e9, ?, ?)").run(mint, t, t);
    const day = 24 * 3600_000;
    const now = 10 * day;
    add("old", 0);
    add("fresh", now - 1000);
    add("protected", 0);
    add("busy", 0);
    db.prepare("INSERT INTO positions (wallet, mode, mint, side, leverage, stake, entry_price, opened_at) VALUES ('w', 'paper', 'busy', 'long', 2, 1, 1, 0)").run();
    expect(pruneMarkets(db, { olderThanMs: day, protect: new Set(["protected"]), now })).toBe(1);
    const listed = (m: string) => (db.prepare("SELECT listed FROM markets WHERE mint = ?").get(m) as { listed: number }).listed;
    expect(listed("old")).toBe(2);
    expect(listed("fresh")).toBe(1);
    expect(listed("protected")).toBe(1);
    expect(listed("busy")).toBe(1);
  });
});
