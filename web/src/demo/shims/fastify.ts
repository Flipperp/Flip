// Just enough of Fastify for server/src/api.ts to register its routes in the browser.
type Handler = (req: any, reply: any) => any;
type WsHandler = (socket: any, req: any) => void;

interface Route {
  method: "GET" | "POST";
  parts: string[];
  handler: Handler;
  ws?: WsHandler;
}

export interface ShimApp {
  handle(method: string, url: string, body?: unknown): Promise<{ status: number; body: unknown }>;
  ws(url: string): WsHandler | null;
}

class Reply {
  status = 200;
  payload: unknown = undefined;
  sent = false;
  code(n: number) {
    this.status = n;
    return this;
  }
  send(p: unknown) {
    this.payload = p;
    this.sent = true;
    return this;
  }
}

export default function Fastify(_opts?: unknown) {
  const routes: Route[] = [];
  const add = (method: "GET" | "POST") => (path: string, a: any, b?: any) => {
    const opts = typeof a === "function" ? {} : a;
    const fn = typeof a === "function" ? a : b;
    routes.push({ method, parts: path.split("/").filter(Boolean), handler: opts.websocket ? () => undefined : fn, ws: opts.websocket ? fn : undefined });
  };
  const match = (method: string, pathname: string) => {
    const segs = pathname.split("/").filter(Boolean);
    for (const r of routes) {
      if (r.method !== method || r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      r.parts.forEach((p, i) => {
        if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(segs[i]);
        else if (p !== segs[i]) ok = false;
      });
      if (ok) return { r, params };
    }
    return null;
  };
  const app: any = {
    register: async () => {},
    addHook: () => {},
    setNotFoundHandler: () => {},
    listen: async () => {},
    close: async () => {},
    get: add("GET"),
    post: add("POST"),
    async handle(method: string, url: string, body?: unknown) {
      const u = new URL(url, "http://local");
      const m = match(method, u.pathname);
      if (!m) return { status: 404, body: { error: "not_found" } };
      const reply = new Reply();
      const req = { query: Object.fromEntries(u.searchParams), params: m.params, body, ip: "local", headers: {}, url };
      try {
        const out = await m.r.handler(req, reply);
        const payload = out instanceof Reply ? out.payload : reply.sent ? reply.payload : out;
        return { status: reply.status, body: JSON.parse(JSON.stringify(payload ?? null)) };
      } catch (e: any) {
        console.error(e);
        return { status: 500, body: { error: "internal", message: String(e?.message ?? e) } };
      }
    },
    ws(url: string) {
      const u = new URL(url, "http://local");
      return match("GET", u.pathname)?.r.ws ?? null;
    },
  };
  return app;
}
