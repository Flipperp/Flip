// Runs the real server (engine, auth, API routes, demo market simulator) inside the page.
import initSqlJs from "sql.js/dist/sql-asm-memory-growth.js";
import { setSqlJs } from "./shims/better-sqlite3";

export async function startBackend() {
  setSqlJs(await (initSqlJs as any)());
  const [{ config }, { openDb }, { PriceStore }, { Engine }, { Auth }, { buildApi }, { startDemo }] = await Promise.all([
    import("../../../server/src/config"),
    import("../../../server/src/db"),
    import("../../../server/src/oracle/priceStore"),
    import("../../../server/src/engine/engine"),
    import("../../../server/src/auth"),
    import("../../../server/src/api"),
    import("../../../server/src/demo"),
  ]);
  const cfg = { ...config, realEnabled: false };
  const db = openDb(":memory:");
  const prices = new PriceStore(cfg.trading.twapWindowMs, cfg.trading.minTwapSamples, cfg.trading.staleMs);
  const engine = new Engine(db, prices, cfg);
  startDemo(db, engine, prices);
  setInterval(() => {
    try {
      engine.tick();
    } catch (e) {
      console.error(e);
    }
  }, 1000);
  const auth = new Auth(db, cfg.brand.name);
  const app: any = await buildApi({
    cfg,
    engine,
    auth,
    oracle: null,
    rewards: null,
    vault: null,
    solUsd: () => 0,
    status: () => ({ demo: true }),
  });

  const realFetch = window.fetch.bind(window);
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const u = new URL(url, window.location.href);
    if (!u.pathname.startsWith("/api/") || u.origin !== window.location.origin) return realFetch(input as any, init);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const r = await app.handle((init?.method ?? "GET").toUpperCase(), u.pathname + u.search, body);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  const RealWS = window.WebSocket;
  class LocalSocket extends EventTarget {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    readyState = 0;
    onopen: ((e: Event) => void) | null = null;
    onclose: ((e: Event) => void) | null = null;
    onmessage: ((e: MessageEvent) => void) | null = null;
    onerror: ((e: Event) => void) | null = null;
    private server: any;
    constructor(url: string) {
      super();
      const handler = app.ws(url);
      const listeners: Record<string, ((x: any) => void)[]> = {};
      const client = this;
      this.server = {
        get readyState() {
          return client.readyState;
        },
        send(s: string) {
          if (client.readyState !== 1) return;
          const ev = new MessageEvent("message", { data: s });
          client.onmessage?.(ev);
          client.dispatchEvent(ev);
        },
        on(evt: string, fn: (x: any) => void) {
          (listeners[evt] ??= []).push(fn);
        },
        emit(evt: string, x?: any) {
          (listeners[evt] ?? []).forEach((f) => f(x));
        },
      };
      setTimeout(() => {
        this.readyState = 1;
        const q = Object.fromEntries(new URL(url, "http://local").searchParams);
        handler?.(this.server, { query: q });
        const ev = new Event("open");
        this.onopen?.(ev);
        this.dispatchEvent(ev);
      }, 0);
    }
    send(s: string) {
      this.server.emit("message", { toString: () => s });
    }
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.server.emit("close");
      const ev = new Event("close");
      this.onclose?.(ev);
      this.dispatchEvent(ev);
    }
  }
  window.WebSocket = function (url: string | URL, protocols?: string | string[]) {
    const s = String(url);
    if (s.includes("/ws?") || s.endsWith("/ws")) return new LocalSocket(s) as any;
    return new RealWS(url, protocols);
  } as any;
  Object.assign(window.WebSocket, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
}
