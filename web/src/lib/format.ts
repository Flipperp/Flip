export const LAMPORTS = 1_000_000_000;

export const sol = (lamports: number | null | undefined, digits = 3) =>
  lamports === null || lamports === undefined ? "–" : (lamports / LAMPORTS).toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const signedSol = (lamports: number | null | undefined, digits = 3) => {
  if (lamports === null || lamports === undefined) return "–";
  const s = sol(Math.abs(lamports), digits);
  return lamports > 0 ? `+${s}` : lamports < 0 ? `−${s}` : s;
};

export const pct = (x: number | null | undefined, digits = 1) => {
  if (x === null || x === undefined || !Number.isFinite(x)) return "–";
  const v = Math.abs(x * 100).toFixed(digits);
  return x > 0 ? `+${v}%` : x < 0 ? `−${v}%` : `${v}%`;
};

export const usd = (n: number | null | undefined) => {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
};

export const compactSol = (sol: number | null | undefined) => {
  if (sol === null || sol === undefined || !Number.isFinite(sol)) return "–";
  if (sol >= 1e6) return `${(sol / 1e6).toFixed(2)}M`;
  if (sol >= 1e3) return `${(sol / 1e3).toFixed(1)}K`;
  return sol.toFixed(sol >= 100 ? 0 : 1);
};

const SUB = "₀₁₂₃₄₅₆₇₈₉";

/**
 * Memecoin price in SOL. Runs of leading zeros collapse to a subscript count the way DEX
 * screens show them: 0.0000183 -> 0.0₄183.
 */
export const price = (p: number | null | undefined, sig = 4) => {
  if (!p || !Number.isFinite(p)) return "–";
  if (p >= 1) return p.toFixed(4);
  if (p >= 0.001) return p.toPrecision(sig);
  const zeros = Math.ceil(-Math.log10(p)) - 1;
  const digits = Math.round(p * 10 ** (zeros + sig)).toString().slice(0, sig);
  return `0.0${String(zeros).split("").map((d) => SUB[Number(d)]).join("")}${digits}`;
};

/** Plain decimal for inputs and chart axes. */
export const priceRaw = (p: number) => (p >= 1 ? p.toFixed(4) : p.toFixed(Math.min(14, Math.floor(-Math.log10(p)) + 4)));

export const short = (w: string | null | undefined) => (!w ? "" : w.length > 10 ? `${w.slice(0, 4)}…${w.slice(-4)}` : w);

export const ago = (ts: number, now = Date.now()) => {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

export const clock = (ts: number) => new Date(ts).toLocaleTimeString(undefined, { hour12: false });

export const duration = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
};

export const venueName: Record<string, string> = {
  pumpfun: "pump.fun",
  pumpswap: "PumpSwap",
  raydium: "Raydium",
  jupiter: "Jupiter",
};

/** USD price with enough significant digits for memecoin perps. */
export const usdPx = (p: number | null | undefined) => {
  if (!p || !Number.isFinite(p)) return "–";
  if (p >= 1000) return `$${p.toLocaleString(undefined, { maximumFractionDigits: 1 })}`;
  if (p >= 1) return `$${p.toFixed(p >= 100 ? 2 : 4)}`;
  return `$${Number(p.toPrecision(5))}`;
};

/** Dollar amount with cents. */
export const usd2 = (n: number | null | undefined) =>
  n === null || n === undefined || !Number.isFinite(n) ? "–" : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
