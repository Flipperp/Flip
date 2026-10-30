import { describe, it, expect, beforeAll, afterAll } from "vitest";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { openDb } from "../src/db.js";
import { config } from "../src/config.js";
import { Engine } from "../src/engine/engine.js";
import { PriceStore } from "../src/oracle/priceStore.js";
import { Auth } from "../src/auth.js";
import { buildApi } from "../src/api.js";

const SOL = 1_000_000_000;
const MINT = Keypair.generate().publicKey.toBase58();

let clock = Date.now();
const now = () => clock;
const cfg = { ...config, realEnabled: true, adminKey: "secret" };
const db = openDb(":memory:");
const prices = new PriceStore(30_000, 20, 10_000, now);
const engine = new Engine(db, prices, cfg, now);
const auth = new Auth(db, cfg.brand.name, now);
let app: Awaited<ReturnType<typeof buildApi>>;

const wallet = Keypair.generate();
const session = Keypair.generate();

function sign(kp: Keypair, payload: object) {
  const nonce = bs58.encode(nacl.randomBytes(16));
  const message = Auth.format(cfg.brand.name, payload, kp.publicKey.toBase58(), nonce, clock);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), kp.secretKey));
  return { message, signature };
}

async function post(url: string, body: object) {
  const r = await app.inject({ method: "POST", url, payload: body });
  return { status: r.statusCode, body: r.json() };
}

beforeAll(async () => {
  app = await buildApi({ cfg, engine, auth, oracle: null, rewards: null, vault: null, status: () => ({}), solUsd: () => 150 });
  db.prepare("INSERT INTO markets (mint, symbol, name, venue, source, supply, added_at) VALUES (?, 'TST', 'Test', 'pumpswap', '{}', 1e9, 0)").run(MINT);
  engine.creditDeposit("lp", "real", 100 * SOL, "seed");
  engine.poolDeposit("lp", "real", 100 * SOL);
  engine.creditDeposit(wallet.publicKey.toBase58(), "real", 5 * SOL, "d0");
  for (let i = 0; i < 31; i++) {
    clock += 1000;
    prices.push(MINT, { price: 0.000001, liquidity: 200 * SOL, mcapSol: 1000, ts: clock });
  }
});
afterAll(async () => app.close());

describe("api", () => {
  it("serves config and markets", async () => {
    const c = (await app.inject("/api/config")).json();
    expect(c.leverages).toEqual([2, 5, 10]);
    const m = (await app.inject("/api/markets?mode=real")).json();
    expect(m[0].tradable).toBe(true);
  });

  it("rejects bad and replayed signatures", async () => {
    const s = sign(wallet, { action: "close_all", mode: "real" });
    expect((await post("/api/action", { ...s, signature: bs58.encode(new Uint8Array(64)) })).status).toBe(401);
    expect((await post("/api/action", s)).status).toBe(200);
    const replay = await post("/api/action", s);
    expect(replay.status).toBe(401);
    expect(replay.body.message).toMatch(/Replayed/);
  });

  it("trades through a session key, but the session can't withdraw", async () => {
    const created = await post("/api/session", sign(wallet, { action: "session", session: session.publicKey.toBase58(), expiresAt: clock + 3600_000 }));
    expect(created.status).toBe(200);
    const open = await post("/api/action", sign(session, { action: "open", mode: "real", mint: MINT, side: "short", leverage: 5, stake: 0.5 * SOL }));
    expect(open.status).toBe(200);
    expect(open.body.position.side).toBe("short");
    const me = (await app.inject(`/api/me?mode=real&wallet=${wallet.publicKey.toBase58()}`)).json();
    expect(me.open.length).toBe(1);
    expect(me.balance).toBe(4.5 * SOL);

    // Fade it from another wallet: must be the opposite side.
    const other = Keypair.generate();
    engine.creditDeposit(other.publicKey.toBase58(), "real", SOL, "d1");
    const badFade = await post("/api/action", sign(other, { action: "open", mode: "real", mint: MINT, side: "short", leverage: 2, stake: 0.1 * SOL, origin: `fade:${open.body.position.id}` }));
    expect(badFade.status).toBe(400);
    const fade = await post("/api/action", sign(other, { action: "open", mode: "real", mint: MINT, side: "long", leverage: 2, stake: 0.1 * SOL, origin: `fade:${open.body.position.id}` }));
    expect(fade.status).toBe(200);

    const tooSoon = await post("/api/action", sign(session, { action: "close", id: open.body.position.id }));
    expect(tooSoon.body.message).toMatch(/after 10s/);
    for (let i = 0; i < 11; i++) {
      clock += 1000;
      prices.push(MINT, { price: 0.0000009, liquidity: 200 * SOL, mcapSol: 900, ts: clock });
    }
    const closed = await post("/api/action", sign(session, { action: "close", id: open.body.position.id }));
    expect(closed.status).toBe(200);
    expect(closed.body.position.pnl).toBeGreaterThan(0);

    const viaSession = await post("/api/action", sign(session, { action: "withdraw", amount: 0.1 * SOL }));
    expect(viaSession.status).toBe(401);
    const direct = await post("/api/action", sign(wallet, { action: "withdraw", amount: 0.1 * SOL }));
    expect(direct.status).toBe(200);
  });

  it("validates payloads and protects admin routes", async () => {
    const bad = await post("/api/action", sign(wallet, { action: "open", mode: "real", mint: MINT, side: "sideways", leverage: 2, stake: 1 }));
    expect(bad.status).toBe(400);
    expect((await app.inject({ method: "POST", url: "/api/admin/halt", payload: { mode: "real" } })).statusCode).toBe(403);
    const ok = await app.inject({ method: "POST", url: "/api/admin/book", headers: { "x-admin-key": "secret" }, payload: {} });
    expect(ok.json().real.ok).toBe(true);
    expect(ok.json().paper.ok).toBe(true);
  });

  it("has one mode: with real trading live, test balances are refused", async () => {
    const faucet = await post("/api/action", sign(wallet, { action: "faucet" }));
    expect(faucet.status).toBe(400);
    expect(faucet.body.error).toBe("test_off");
    const paper = await post("/api/action", sign(wallet, { action: "open", mode: "paper", mint: MINT, side: "long", leverage: 2, stake: 0.1 * SOL }));
    expect(paper.body.error).toBe("test_off");
  });

  it("exposes pool, tape and top trades", async () => {
    const pool = (await app.inject("/api/pool?mode=real")).json();
    expect(pool.cash).toBeGreaterThan(0);
    expect(pool.exposure.length).toBe(1);
    const tape = (await app.inject("/api/tape?mode=real")).json();
    expect(tape.some((e: any) => e.kind === "open")).toBe(true);
    const top = (await app.inject("/api/top?mode=real&window=all")).json();
    expect(top.length).toBe(1);
  });
});
