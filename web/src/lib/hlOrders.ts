// Order math for the Hyperliquid route. Pure functions, unit tested.
import { formatPrice, formatSize } from "@nktkas/hyperliquid/utils";

/** Hyperliquid rejects orders under $10 of notional. */
export const MIN_NOTIONAL_USD = 10;
/** The Arbitrum bridge credits nothing below 5 USDC; smaller deposits are lost. */
export const MIN_DEPOSIT_USDC = 5;

export interface MarketOrderInput {
  asset: number;
  szDecimals: number;
  isBuy: boolean;
  /** Current mid, USD per Hyperliquid unit. */
  mid: number;
  /** Max price move accepted, as a fraction of mid (0.03 = 3%). */
  slippage: number;
  /** Margin committed, USD. */
  marginUsd: number;
  leverage: number;
}

export interface BuiltOrder {
  a: number;
  b: boolean;
  p: string;
  s: string;
  r: boolean;
  t: { limit: { tif: "Ioc" } };
}

export class OrderBuildError extends Error {}

/** Worst acceptable price for an aggressive order, rounded to a price Hyperliquid will take. */
export function limitPrice(mid: number, isBuy: boolean, slippage: number, szDecimals: number): string {
  if (!(mid > 0)) throw new OrderBuildError("No price from Hyperliquid yet");
  const px = isBuy ? mid * (1 + slippage) : mid * (1 - slippage);
  return formatPrice(px, szDecimals, "perp");
}

/**
 * A market order is an immediate-or-cancel limit at mid ± slippage. Size is margin × leverage at
 * mid, truncated to the asset's lot size, so the position never exceeds what the user entered.
 */
export function buildMarketOpen(i: MarketOrderInput): { order: BuiltOrder; size: number; notional: number } {
  if (!(i.marginUsd > 0)) throw new OrderBuildError("Enter a size");
  if (!(i.leverage >= 1)) throw new OrderBuildError("Bad leverage");
  if (!(i.mid > 0)) throw new OrderBuildError("No price from Hyperliquid yet");
  const raw = (i.marginUsd * i.leverage) / i.mid;
  let s: string;
  try {
    s = formatSize(raw, i.szDecimals);
  } catch {
    throw new OrderBuildError(`Too small: minimum is $${MIN_NOTIONAL_USD} of position size`);
  }
  const size = Number(s);
  const notional = size * i.mid;
  if (notional < MIN_NOTIONAL_USD) throw new OrderBuildError(`Too small: minimum is $${MIN_NOTIONAL_USD} of position size ($${(MIN_NOTIONAL_USD / i.leverage).toFixed(2)} margin at ${i.leverage}x)`);
  return {
    order: { a: i.asset, b: i.isBuy, p: limitPrice(i.mid, i.isBuy, i.slippage, i.szDecimals), s, r: false, t: { limit: { tif: "Ioc" } } },
    size,
    notional,
  };
}

/** Reduce-only order that flattens a position of signed size `szi`. */
export function buildMarketClose(i: { asset: number; szDecimals: number; szi: string; mid: number; slippage: number; fraction?: number }): BuiltOrder {
  const n = Number(i.szi);
  if (!n) throw new OrderBuildError("No position to close");
  const isBuy = n < 0;
  const frac = i.fraction ?? 1;
  // A full close sends the exact position size Hyperliquid reported, so no dust is left open.
  const s = frac >= 1 ? i.szi.replace(/^-/, "") : formatSize(Math.abs(n) * frac, i.szDecimals);
  return { a: i.asset, b: isBuy, p: limitPrice(i.mid, isBuy, i.slippage, i.szDecimals), s, r: true, t: { limit: { tif: "Ioc" } } };
}

/** Maintenance margin fraction Hyperliquid uses for an asset: half the initial margin at max leverage. */
export const maintenanceFrac = (maxLeverage: number) => (maxLeverage > 0 ? 1 / (2 * maxLeverage) : 0.05);

/** Builder fee for this trader: base fee less their holder-tier discount. Tenths of a basis point. */
export function builderFeeFor(baseTenthsBps: number, discountBps: number): number {
  const f = Math.round((baseTenthsBps * (10_000 - Math.max(0, Math.min(10_000, discountBps)))) / 10_000);
  return Math.max(0, Math.min(100, f));
}

/** Tenths of a basis point to the "0.05%" string approveBuilderFee expects. */
export function feeRateString(tenthsBps: number): `${string}%` {
  const pct = tenthsBps / 1000;
  return `${Number(pct.toFixed(4))}%`;
}

/** Leverage presets the asset allows: Flip's presets up to the perp's max, plus the max itself. */
export function leverageChoices(presets: number[], maxLeverage: number): number[] {
  const out = presets.filter((l) => l <= maxLeverage);
  if (maxLeverage > 0 && !out.includes(maxLeverage) && maxLeverage <= 50) out.push(maxLeverage);
  if (out.length === 0 && maxLeverage >= 1) out.push(Math.floor(maxLeverage));
  return out.sort((a, b) => a - b);
}

/** Approximate isolated liquidation price for a new position (ignores fees and funding). */
export function estLiquidation(entry: number, isLong: boolean, leverage: number, maintenanceFrac: number) {
  // Isolated margin m = notional / lev; liquidation when loss = m - maintenance × notional.
  const move = 1 / leverage - maintenanceFrac;
  return isLong ? entry * (1 - move) : entry * (1 + move);
}

/** Raw USDC amount (6 decimals) from a decimal string, exact. */
export function usdcUnits(amount: string): bigint {
  const m = /^(\d+)(?:\.(\d{0,6})\d*)?$/.exec(amount.trim());
  if (!m) throw new OrderBuildError("Enter an amount");
  return BigInt(m[1]) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0");
}
