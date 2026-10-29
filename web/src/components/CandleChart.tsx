import { useEffect, useRef, useState } from "react";
import { CandlestickSeries, ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type IPriceLine, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { get } from "../lib/api";
import { price } from "../lib/format";

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface ChartLine {
  price: number;
  kind: "long" | "short" | "liq" | "win";
  title: string;
}

const TF_SEC: Record<string, number> = { "5s": 5, "1m": 60, "5m": 300, "15m": 900 };

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || undefined;

export default function CandleChart({ mint, live, lines }: { mint: string; live: number | null; lines: ChartLine[] }) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastRef = useRef<Candle | null>(null);
  const priceLines = useRef<IPriceLine[]>([]);
  const [tf, setTf] = useState<string>(() => {
    try {
      return localStorage.getItem("flip:tf") ?? "1m";
    } catch {
      return "1m";
    }
  });
  const [legend, setLegend] = useState<Candle | null>(null);
  const [empty, setEmpty] = useState(false);

  // Create the chart once.
  useEffect(() => {
    if (!host.current) return;
    const long = css("--long") ?? "#2bd9a0";
    const short = css("--short") ?? "#f35a6e";
    const chart = createChart(host.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: css("--muted") ?? "#7c9398", fontFamily: css("--mono"), fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "rgba(29,48,55,0.55)" }, horzLines: { color: "rgba(29,48,55,0.55)" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: css("--line") ?? "#1d3037", scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: css("--line") ?? "#1d3037", timeVisible: true, secondsVisible: true, rightOffset: 6 },
      localization: { priceFormatter: (p: number) => price(p) },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: long,
      downColor: short,
      wickUpColor: long,
      wickDownColor: short,
      borderVisible: false,
      priceFormat: { type: "custom", minMove: 1e-14, formatter: (p: number) => price(p) },
    });
    chart.subscribeCrosshairMove((p) => {
      const d = p.seriesData.get(series) as any;
      setLegend(d ? { t: Number(p.time), o: d.open, h: d.high, l: d.low, c: d.close } : lastRef.current);
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  // Load candles for the coin and timeframe, then resync periodically.
  useEffect(() => {
    let stop = false;
    try {
      localStorage.setItem("flip:tf", tf);
    } catch {
      /* ignore */
    }
    const load = async (fit: boolean) => {
      const cs = await get<Candle[]>(`/api/candles/${mint}?tf=${tf}`).catch(() => [] as Candle[]);
      if (stop || !seriesRef.current) return;
      seriesRef.current.setData(cs.map((c) => ({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c })));
      lastRef.current = cs[cs.length - 1] ?? null;
      setLegend(lastRef.current);
      setEmpty(cs.length === 0);
      if (fit) chartRef.current?.timeScale().scrollToRealTime();
    };
    load(true);
    const t = setInterval(() => load(false), 30_000);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [mint, tf]);

  // Fold live ticks into the current candle.
  useEffect(() => {
    if (!live || !seriesRef.current) return;
    const sec = TF_SEC[tf];
    const t = Math.floor(Date.now() / 1000 / sec) * sec;
    const last = lastRef.current;
    let c: Candle;
    if (last && last.t === t) c = { ...last, h: Math.max(last.h, live), l: Math.min(last.l, live), c: live };
    else if (!last || t > last.t) c = { t, o: last?.c ?? live, h: Math.max(last?.c ?? live, live), l: Math.min(last?.c ?? live, live), c: live };
    else return;
    lastRef.current = c;
    seriesRef.current.update({ time: c.t as UTCTimestamp, open: c.o, high: c.h, low: c.l, close: c.c });
    setEmpty(false);
  }, [live, tf]);

  // Entry, liquidation and max-win lines for the viewer's positions.
  useEffect(() => {
    const s = seriesRef.current;
    if (!s) return;
    for (const pl of priceLines.current) s.removePriceLine(pl);
    const color = { long: css("--long"), short: css("--short"), liq: "#f5c451", win: css("--brand") };
    priceLines.current = lines
      .filter((l) => l.price > 0)
      .map((l) =>
        s.createPriceLine({ price: l.price, color: color[l.kind] ?? "#888", lineWidth: 1, lineStyle: l.kind === "long" || l.kind === "short" ? LineStyle.Solid : LineStyle.Dashed, axisLabelVisible: true, title: l.title }),
      );
  }, [lines]);

  const up = legend ? legend.c >= legend.o : true;
  return (
    <>
      <div className="pane-head">
        <div className="seg tf-seg" role="radiogroup" aria-label="Candle size">
          {Object.keys(TF_SEC).map((k) => (
            <button key={k} role="radio" aria-checked={tf === k} className={tf === k ? "on" : ""} onClick={() => setTf(k)}>
              {k}
            </button>
          ))}
        </div>
        {legend && (
          <div className="chart-legend">
            <span>
              O <b className={up ? "t-long" : "t-short"}>{price(legend.o)}</b>
            </span>
            <span>
              H <b className={up ? "t-long" : "t-short"}>{price(legend.h)}</b>
            </span>
            <span>
              L <b className={up ? "t-long" : "t-short"}>{price(legend.l)}</b>
            </span>
            <span>
              C <b className={up ? "t-long" : "t-short"}>{price(legend.c)}</b>
            </span>
          </div>
        )}
        <span className="spacer" />
        <span className="faint small">Price in SOL</span>
      </div>
      <div className="chart-host">
        <div ref={host} style={{ position: "absolute", inset: 0 }} />
        {empty && <div className="chart-empty">Collecting prices. Candles appear as the coin trades.</div>}
      </div>
    </>
  );
}
