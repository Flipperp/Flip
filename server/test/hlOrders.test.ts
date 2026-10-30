import { describe, it, expect } from "vitest";
import {
  buildMarketOpen,
  buildMarketClose,
  builderFeeFor,
  feeRateString,
  leverageChoices,
  estLiquidation,
  maintenanceFrac,
  usdcUnits,
  limitPrice,
  OrderBuildError,
} from "../../web/src/lib/hlOrders.js";

describe("hyperliquid order math", () => {
  it("builds an IOC buy capped at mid + slippage with lot-truncated size", () => {
    const r = buildMarketOpen({ asset: 5, szDecimals: 1, isBuy: true, mid: 1.2345, slippage: 0.03, marginUsd: 20, leverage: 5 });
    // 100 USD / 1.2345 = 81.004... → truncated to 1 decimal
    expect(r.order.s).toBe("81");
    expect(r.order.a).toBe(5);
    expect(r.order.b).toBe(true);
    expect(r.order.r).toBe(false);
    expect(r.order.t).toEqual({ limit: { tif: "Ioc" } });
    expect(Number(r.order.p)).toBeLessThanOrEqual(1.2345 * 1.03 + 1e-9);
    expect(Number(r.order.p)).toBeGreaterThan(1.2345 * 1.029);
    expect(r.notional).toBeLessThanOrEqual(100);
  });

  it("prices respect Hyperliquid's 5 significant figures and 6 - szDecimals decimals", () => {
    // kBONK style: tiny price, szDecimals 0 → up to 6 decimals and 5 sig figs.
    const p = limitPrice(0.0213456, false, 0.03, 0);
    expect(p).toMatch(/^0\.0\d{1,5}$/);
    expect(p.replace(/^0\.0*/, "").length).toBeLessThanOrEqual(5);
    // BTC style: szDecimals 5 → at most 1 decimal; integer prices allowed.
    const b = limitPrice(97123.456, true, 0.03, 5);
    expect(Number.isInteger(Number(b)) || b.split(".")[1].length <= 1).toBe(true);
  });

  it("refuses orders under $10 notional and empty sizes", () => {
    expect(() => buildMarketOpen({ asset: 0, szDecimals: 2, isBuy: true, mid: 2, slippage: 0.03, marginUsd: 1, leverage: 5 })).toThrow(OrderBuildError);
    expect(() => buildMarketOpen({ asset: 0, szDecimals: 0, isBuy: true, mid: 2, slippage: 0.03, marginUsd: 0, leverage: 5 })).toThrow(/size/);
    expect(() => buildMarketOpen({ asset: 0, szDecimals: 0, isBuy: true, mid: 0, slippage: 0.03, marginUsd: 20, leverage: 5 })).toThrow(/price/);
    // Truncation can push a borderline order under the minimum: 10.5 USD at mid 3 → 3 units = 9 USD.
    expect(() => buildMarketOpen({ asset: 0, szDecimals: 0, isBuy: true, mid: 3, slippage: 0.03, marginUsd: 2.1, leverage: 5 })).toThrow(/minimum/);
  });

  it("closes the exact reported size, reduce-only, on the opposite side", () => {
    const long = buildMarketClose({ asset: 3, szDecimals: 2, szi: "12.34", mid: 10, slippage: 0.03 });
    expect(long).toMatchObject({ a: 3, b: false, s: "12.34", r: true });
    expect(Number(long.p)).toBeCloseTo(9.7, 6);
    const short = buildMarketClose({ asset: 3, szDecimals: 2, szi: "-0.5", mid: 10, slippage: 0.03 });
    expect(short).toMatchObject({ b: true, s: "0.5", r: true });
    expect(Number(short.p)).toBeCloseTo(10.3, 6);
    expect(buildMarketClose({ asset: 3, szDecimals: 2, szi: "-1.27", mid: 10, slippage: 0.03, fraction: 0.5 }).s).toBe("0.63");
    expect(() => buildMarketClose({ asset: 3, szDecimals: 2, szi: "0.0", mid: 10, slippage: 0.03 })).toThrow();
  });

  it("applies holder discounts to the builder fee and formats the approval cap", () => {
    expect(builderFeeFor(50, 0)).toBe(50);
    expect(builderFeeFor(50, 5000)).toBe(25);
    expect(builderFeeFor(50, 6667)).toBe(17);
    expect(builderFeeFor(500, 0)).toBe(100); // Hyperliquid's perps cap
    expect(feeRateString(50)).toBe("0.05%");
    expect(feeRateString(100)).toBe("0.1%");
    expect(feeRateString(15)).toBe("0.015%");
  });

  it("offers leverage presets within the perp's max", () => {
    expect(leverageChoices([2, 5, 10], 3)).toEqual([2, 3]);
    expect(leverageChoices([2, 5, 10], 10)).toEqual([2, 5, 10]);
    expect(leverageChoices([2, 5, 10], 20)).toEqual([2, 5, 10, 20]);
    expect(leverageChoices([2, 5, 10], 1)).toEqual([1]);
  });

  it("estimates isolated liquidation", () => {
    // 10x long, max leverage 10 → maintenance 5%; liq at entry × (1 − (0.1 − 0.05)).
    expect(estLiquidation(100, true, 10, maintenanceFrac(10))).toBeCloseTo(95, 6);
    expect(estLiquidation(100, false, 5, maintenanceFrac(10))).toBeCloseTo(115, 6);
  });

  it("converts USDC amounts exactly", () => {
    expect(usdcUnits("5")).toBe(5_000_000n);
    expect(usdcUnits("12.345678")).toBe(12_345_678n);
    expect(usdcUnits("0.1234569")).toBe(123_456n); // extra digits truncate, never round up
    expect(() => usdcUnits("abc")).toThrow();
  });
});
