/**
 * Live pump.fun launches and graduations from PumpPortal's free data websocket.
 *
 * The feed is a discovery hint only. Nothing from it is used as a price: a coin becomes a Flip
 * market through ChainOracle.resolve, which reads the curve or pool on-chain. PumpPortal asks
 * clients to hold a single connection and subscribe on it, which is what this does.
 */

export interface NewPair {
  mint: string;
  name: string;
  symbol: string;
  image: string | null;
  creator: string;
  createdAt: number;
  /** SOL the creator bought at launch. */
  devBuySol: number;
  /** Market cap in SOL right after the create transaction. */
  launchMcapSol: number;
}

export interface Graduation {
  mint: string;
  at: number;
}

export interface PumpFeedOptions {
  url: string;
  keep: number;
  /** List coins on Flip as they graduate to PumpSwap. */
  autoListGraduated: boolean;
  /** Delay between on-chain lookups for graduated coins, so a burst can't flood the RPC. */
  resolveGapMs: number;
  /** Fetch launch images from the token's metadata URI. */
  fetchImages: boolean;
  resolve: ((mint: string, hint?: { bornAt?: number }) => Promise<unknown>) | null;
  onPair?: (p: NewPair) => void;
  onGraduation?: (g: Graduation) => void;
  fetchImpl?: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
  now?: () => number;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Feed strings are untrusted: strip control characters and clamp length. */
export function clean(s: unknown, max: number): string {
  return String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .trim()
    .slice(0, max);
}

export function safeImageUrl(u: unknown): string | null {
  if (typeof u !== "string" || u.length > 500) return null;
  try {
    const url = new URL(u);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/** Parse one PumpPortal message into a launch or graduation, or null for anything else. */
export function parseMessage(raw: unknown, now: number): { pair?: NewPair; graduation?: Graduation; uri?: string } | null {
  if (!raw || typeof raw !== "object") return null;
  const m = raw as Record<string, unknown>;
  const mint = typeof m.mint === "string" && BASE58.test(m.mint) ? m.mint : null;
  if (!mint) return null;
  if (m.txType === "create") {
    const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) && x >= 0 ? x : 0);
    return {
      pair: {
        mint,
        name: clean(m.name, 40),
        symbol: clean(m.symbol, 16),
        image: null,
        creator: typeof m.traderPublicKey === "string" && BASE58.test(m.traderPublicKey) ? m.traderPublicKey : "",
        createdAt: now,
        devBuySol: num(m.solAmount),
        launchMcapSol: num(m.marketCapSol),
      },
      uri: typeof m.uri === "string" ? m.uri : undefined,
    };
  }
  if (m.txType === "migrate") return { graduation: { mint, at: now } };
  return null;
}

export class PumpFeed {
  public connected = false;
  public lastError: string | null = null;
  public lastMessageAt: number | null = null;
  public counts = { launches: 0, graduations: 0, listed: 0 };
  private pairs: NewPair[] = [];
  private grads: Graduation[] = [];
  private ws: WebSocket | null = null;
  private stopped = false;
  private retryMs = 1000;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private watchdog?: ReturnType<typeof setInterval>;
  private resolveQueue: string[] = [];
  private resolving = false;
  private imageQueue: { mint: string; uri: string }[] = [];
  private imagesActive = 0;

  constructor(private opts: PumpFeedOptions) {}

  private get now() {
    return this.opts.now ?? Date.now;
  }

  start() {
    this.stopped = false;
    this.connect();
    // Reconnect if the socket goes quiet: launches arrive every few seconds around the clock.
    this.watchdog = setInterval(() => {
      if (this.connected && this.lastMessageAt && this.now() - this.lastMessageAt > 120_000) {
        this.lastError = "feed went quiet, reconnecting";
        try {
          this.ws?.close();
        } catch {
          /* ignore */
        }
      }
    }, 30_000);
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.watchdog) clearInterval(this.watchdog);
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }

  private connect() {
    const WS = this.opts.WebSocketImpl ?? (globalThis as any).WebSocket;
    if (!WS) {
      this.lastError = "WebSocket is not available in this runtime";
      return;
    }
    let ws: WebSocket;
    try {
      ws = new WS(this.opts.url);
    } catch (e: any) {
      this.lastError = String(e?.message ?? e);
      return this.scheduleReconnect();
    }
    this.ws = ws;
    ws.onopen = () => {
      this.connected = true;
      this.retryMs = 1000;
      this.lastError = null;
      ws.send(JSON.stringify({ method: "subscribeNewToken" }));
      ws.send(JSON.stringify({ method: "subscribeMigration" }));
    };
    ws.onmessage = (ev: MessageEvent) => {
      this.lastMessageAt = this.now();
      try {
        this.handle(JSON.parse(String(ev.data)));
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onerror = () => {
      this.lastError = "feed connection error";
    };
    ws.onclose = () => {
      this.connected = false;
      if (this.ws === ws) this.ws = null;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.retryTimer = setTimeout(() => this.connect(), this.retryMs);
    this.retryMs = Math.min(60_000, this.retryMs * 2);
  }

  /** Apply one message. Public for tests. */
  handle(raw: unknown) {
    const r = parseMessage(raw, this.now());
    if (!r) return;
    if (r.pair) {
      this.counts.launches++;
      this.pairs.unshift(r.pair);
      if (this.pairs.length > this.opts.keep) this.pairs.length = this.opts.keep;
      if (r.uri && this.opts.fetchImages) this.queueImage(r.pair.mint, r.uri);
      this.opts.onPair?.(r.pair);
    }
    if (r.graduation) {
      this.counts.graduations++;
      if (this.grads.some((g) => g.mint === r.graduation!.mint)) return;
      this.grads.unshift(r.graduation);
      if (this.grads.length > this.opts.keep) this.grads.length = this.opts.keep;
      this.opts.onGraduation?.(r.graduation);
      if (this.opts.autoListGraduated && this.opts.resolve) this.queueResolve(r.graduation.mint);
    }
  }

  private queueResolve(mint: string) {
    if (this.resolveQueue.includes(mint)) return;
    // Under a burst, newest graduations matter most; drop the oldest waiting ones.
    this.resolveQueue.push(mint);
    if (this.resolveQueue.length > 50) this.resolveQueue.shift();
    if (!this.resolving) this.drainResolves();
  }

  private async drainResolves() {
    this.resolving = true;
    while (this.resolveQueue.length && !this.stopped) {
      const mint = this.resolveQueue.shift()!;
      try {
        // A coin just migrated: its PumpSwap pool may take a few seconds to be readable.
        await new Promise((r) => setTimeout(r, this.opts.resolveGapMs));
        const seen = this.pairs.find((p) => p.mint === mint);
        await this.opts.resolve!(mint, seen ? { bornAt: seen.createdAt } : undefined);
        this.counts.listed++;
      } catch {
        /* not resolvable yet or unsupported; the seeder or a user paste can add it later */
      }
    }
    this.resolving = false;
  }

  private queueImage(mint: string, uri: string) {
    const url = safeImageUrl(uri);
    if (!url) return;
    this.imageQueue.unshift({ mint, uri: url });
    if (this.imageQueue.length > 30) this.imageQueue.length = 30;
    this.pumpImages();
  }

  private pumpImages() {
    while (this.imagesActive < 3 && this.imageQueue.length) {
      const job = this.imageQueue.shift()!;
      this.imagesActive++;
      this.fetchImage(job)
        .catch(() => {})
        .finally(() => {
          this.imagesActive--;
          this.pumpImages();
        });
    }
  }

  private async fetchImage(job: { mint: string; uri: string }) {
    const f = this.opts.fetchImpl ?? fetch;
    const r = await f(job.uri, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return;
    const text = await r.text();
    if (text.length > 20_000) return;
    const img = safeImageUrl(JSON.parse(text)?.image);
    const p = this.pairs.find((x) => x.mint === job.mint);
    if (p && img) p.image = img;
  }

  /** Launch time if this server saw the launch. */
  launchedAt(mint: string): number | undefined {
    return this.pairs.find((p) => p.mint === mint)?.createdAt;
  }

  recent(limit = 100) {
    return this.pairs.slice(0, limit);
  }

  graduations(limit = 50) {
    return this.grads.slice(0, limit);
  }
}
