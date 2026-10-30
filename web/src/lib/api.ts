import nacl from "tweetnacl";
import bs58 from "bs58";

export type Mode = "real" | "paper";

export interface Config {
  brand: { name: string; ticker: string };
  tokenMint: string | null;
  vault: string | null;
  realEnabled: boolean;
  leverages: number[];
  maxWinMult: number;
  spreadBps: number;
  profitFeeBps: number;
  minStake: number;
  minHoldMs: number;
  minLiquidity: number;
  maxSidePerCoin: number;
  twapWindowMs: number;
  splits: { profitFee: Record<string, number>; creatorFee: Record<string, number> };
  tiers: { name: string; minTokens: number; feeDiscountBps: number; rebateBps: number }[];
  rebate: { maxPerWalletPerEpoch: number; maxPotFrac: number };
  holders: { epochMs: number; payoutFrac: number; maxWeightSupplyFrac: number };
  paper: { faucetAmount: number; faucetCooldownMs: number };
  custody: { minDeposit: number; maxWithdrawal: number; dailyWithdrawalPerWallet: number };
  solUsd: number;
  halted: Record<Mode, string | null>;
  hl?: { enabled: boolean; testnet?: boolean; apiUrl?: string; builder?: string | null; builderFee?: number; slippage?: number; maxDivergence?: number };
}

export interface HlLink {
  coin: string;
  asset: number;
  mult: number;
  szDecimals: number;
  maxLeverage: number;
  onlyIsolated: boolean;
  state: "verified" | "checking" | "price_mismatch" | "no_flip_price" | "not_listed" | "delisted";
  routable: boolean;
  markPx: number | null;
  midPx: number | null;
  funding: number | null;
  openInterest: number | null;
  dayNtlVlm: number | null;
  prevDayPx: number | null;
  markSol: number | null;
  divergence: number | null;
  checkedAt: number | null;
}

export interface Market {
  mint: string;
  symbol: string;
  name: string;
  image: string;
  venue: string;
  addedAt: number;
  price: number | null;
  twap: number | null;
  liquidity: number | null;
  mcapSol: number | null;
  change1h: number | null;
  tradable: boolean;
  reason: string | null;
  longOpen: number;
  shortOpen: number;
  roomLong: number;
  roomShort: number;
  sideCap?: number;
  hl?: HlLink | null;
}

export interface PositionV {
  id: number;
  wallet: string;
  walletShort: string;
  mode: Mode;
  mint: string;
  symbol: string;
  image: string;
  side: "long" | "short";
  leverage: number;
  stake: number;
  entry: number;
  openedAt: number;
  status: "open" | "closed";
  exit: number | null;
  closedAt: number | null;
  pnl: number | null;
  fee: number | null;
  payout: number | null;
  closeReason: string | null;
  origin: string;
  mark: number | null;
  maxWinAt: number;
  liquidationAt: number;
  canCloseAt: number;
}

export interface TapeEvent {
  id: number;
  ts: number;
  mode: Mode;
  kind: string;
  wallet: string | null;
  walletShort: string | null;
  mint: string | null;
  symbol: string | null;
  image: string | null;
  amount: number;
  ref: string | null;
  data: any;
}

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const base = ((import.meta as any).env?.VITE_API_URL as string | undefined) ?? "";

export async function get<T>(path: string): Promise<T> {
  const r = await fetch(`${base}${path}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error ?? "error", j.message ?? `Request failed (${r.status})`, r.status);
  return j as T;
}

export async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(j.error ?? "error", j.message ?? `Request failed (${r.status})`, r.status);
  return j as T;
}

export const wsUrl = (mode: Mode) => {
  const b = base || window.location.origin;
  return `${b.replace(/^http/, "ws")}/ws?mode=${mode}`;
};

// ---------- signing ----------

const nonce = () => bs58.encode(nacl.randomBytes(16));

export function formatMessage(brand: string, payload: object, signer: string) {
  return `${brand}:v1\n${JSON.stringify(payload)}\nsigner:${signer}\nnonce:${nonce()}\nts:${Date.now()}`;
}

export type WalletSigner = (msg: Uint8Array) => Promise<Uint8Array>;

interface StoredSession {
  wallet: string;
  secret: string;
  expiresAt: number;
}

const storeKey = (wallet: string) => `flip:session:${wallet}`;

function loadSession(wallet: string): StoredSession | null {
  try {
    const raw = localStorage.getItem(storeKey(wallet));
    if (!raw) return null;
    const s = JSON.parse(raw) as StoredSession;
    return s.wallet === wallet && s.expiresAt > Date.now() + 60_000 ? s : null;
  } catch {
    return null;
  }
}

function saveSession(s: StoredSession) {
  try {
    localStorage.setItem(storeKey(s.wallet), JSON.stringify(s));
  } catch {
    /* in-memory only */
  }
}

const memorySessions = new Map<string, StoredSession>();

export function forgetSession(wallet: string) {
  memorySessions.delete(wallet);
  try {
    localStorage.removeItem(storeKey(wallet));
  } catch {
    /* ignore */
  }
}

export function hasSession(wallet: string) {
  return !!(memorySessions.get(wallet) ?? loadSession(wallet));
}

/** One wallet popup authorizes a browser key that signs trades for 24h. It can never withdraw. */
export async function ensureSession(brand: string, wallet: string, signWithWallet: WalletSigner): Promise<StoredSession> {
  const existing = memorySessions.get(wallet) ?? loadSession(wallet);
  if (existing && existing.expiresAt > Date.now() + 60_000) return existing;
  const kp = nacl.sign.keyPair();
  const sessionPub = bs58.encode(kp.publicKey);
  const expiresAt = Date.now() + 24 * 3600_000;
  const message = formatMessage(brand, { action: "session", session: sessionPub, expiresAt }, wallet);
  const sig = await signWithWallet(new TextEncoder().encode(message));
  await post("/api/session", { message, signature: bs58.encode(sig) });
  const s = { wallet, secret: bs58.encode(kp.secretKey), expiresAt };
  memorySessions.set(wallet, s);
  saveSession(s);
  return s;
}

export async function sessionAction<T = any>(brand: string, wallet: string, signWithWallet: WalletSigner, payload: object): Promise<T> {
  const s = await ensureSession(brand, wallet, signWithWallet);
  const secret = bs58.decode(s.secret);
  const pub = bs58.encode(secret.slice(32));
  const message = formatMessage(brand, payload, pub);
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(message), secret));
  try {
    return await post<T>("/api/action", { message, signature });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401 && /Session/.test(e.message)) {
      forgetSession(wallet);
      return sessionAction(brand, wallet, signWithWallet, payload);
    }
    throw e;
  }
}

/** Actions that must be signed by the wallet itself (withdrawals). */
export async function walletAction<T = any>(brand: string, wallet: string, signWithWallet: WalletSigner, payload: object): Promise<T> {
  const message = formatMessage(brand, payload, wallet);
  const sig = await signWithWallet(new TextEncoder().encode(message));
  return post<T>("/api/action", { message, signature: bs58.encode(sig) });
}
