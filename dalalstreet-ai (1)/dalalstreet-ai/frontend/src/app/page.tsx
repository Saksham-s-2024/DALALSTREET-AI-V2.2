"use client";
import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import { Zap, TrendingUp, Clock, FileText, LogOut } from "lucide-react";
import { authHeaders, clearToken, getToken } from "@/lib/auth";

// ── Types ─────────────────────────────────────────────────────
type Mode = "trader" | "investor";
type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "EXTREME";
type Decision = "BUY" | "SELL" | "HOLD" | "AVOID";

interface QuoteData {
  symbol: string; ltp: number; open: number; high: number;
  low: number; close: number; volume: number; change_pct: number;
  bid: number; ask: number; timestamp: string; is_mock?: boolean;
}

interface TraderReport {
  symbol: string; timestamp: string;
  technical: { ltp: number; change_pct: number; volume: number; rsi_14: number;
    vwap: number; bollinger: { upper: number; mid: number; lower: number };
    high_52w: number; low_52w: number; };
  assessment: { risk_level: RiskLevel; risk_score: number; decision: Decision;
    confidence_pct: number; entry_price: number | null; stop_loss: number | null;
    target_price: number | null; holding_period: string; summary: string;
    key_signals: string[]; warnings: string[]; technical_bias: string;
    predicted_prices_next_sessions?: number[];
    model_diagnostics?: { trained_samples?: number; used_mlp?: boolean };
  };
  from_cache: boolean;
}

interface InvestorPick {
  symbol: string; type: string; rationale: string; risk_rating: string;
  expected_return_range: string; suggested_allocation_pct: number; sip_suitable: boolean;
}

interface InvestorReport {
  asset_type: string; risk_appetite: string;
  recommendation: { recommendation_summary: string; top_picks: InvestorPick[];
    diversification_tip: string; risk_warning: string;
    holding_horizon: string; tax_note: string; };
  from_cache: boolean;
}

const API = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

const SYMBOLS = ["RELIANCE","TCS","HDFCBANK","INFY","HINDUNILVR","ICICIBANK",
  "KOTAKBANK","BHARTIARTL","ITC","AXISBANK","LT","ASIANPAINT","MARUTI",
  "TITAN","BAJFINANCE","SUNPHARMA","HCLTECH","WIPRO","NESTLEIND","ULTRACEMCO"];

// ── Utils ─────────────────────────────────────────────────────
const fmt = (n: number) => new Intl.NumberFormat("en-IN").format(n);
const fmtPrice = (n: number) => `₹${fmt(n)}`;
const clamp = (n: number, min: number, max: number) => Math.min(Math.max(n, min), max);

const RISK_COLOR: Record<RiskLevel, string> = {
  LOW: "#22d3a0", MEDIUM: "#f59e0b", HIGH: "#f97316", EXTREME: "#ef4444",
};
const DECISION_COLOR: Record<Decision, string> = {
  BUY: "#22d3a0", SELL: "#ef4444", HOLD: "#f59e0b", AVOID: "#6b7280",
};
const DECISION_BG: Record<Decision, string> = {
  BUY: "rgba(34,211,160,0.12)", SELL: "rgba(239,68,68,0.12)",
  HOLD: "rgba(245,158,11,0.12)", AVOID: "rgba(107,114,128,0.1)",
};

// ── Mini Sparkline ─────────────────────────────────────────────
function Sparkline({ data, color = "#22d3a0", width = 80, height = 30 }: {
  data: number[]; color?: string; width?: number; height?: number;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data), max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ── Animated Counter ──────────────────────────────────────────
function AnimatedNumber({ value, prefix = "", suffix = "", decimals = 2 }: {
  value: number; prefix?: string; suffix?: string; decimals?: number;
}) {
  const [display, setDisplay] = useState(value);
  useEffect(() => {
    let start = display;
    const end = value;
    if (start === end) return;
    const dur = 600;
    const step = (end - start) / (dur / 16);
    let raf: number;
    const tick = () => {
      start += step;
      if ((step > 0 && start >= end) || (step < 0 && start <= end)) {
        setDisplay(end);
        return;
      }
      setDisplay(parseFloat(start.toFixed(decimals)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- animate from last displayed frame; `display` omitted on purpose
  }, [value, decimals]);
  return <span>{prefix}{display.toFixed(decimals)}{suffix}</span>;
}

// ── Risk Gauge ────────────────────────────────────────────────
function RiskGauge({ score, level }: { score: number; level: RiskLevel }) {
  const color = RISK_COLOR[level];
  const angle = (score / 100) * 180 - 90;
  return (
    <div className="flex flex-col items-center gap-1">
      <svg width="120" height="70" viewBox="0 0 120 70">
        <defs>
          <linearGradient id="gaugeGrad" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#22d3a0" />
            <stop offset="50%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#ef4444" />
          </linearGradient>
        </defs>
        <path d="M10 65 A50 50 0 0 1 110 65" fill="none" stroke="#1e293b" strokeWidth="10" strokeLinecap="round" />
        <path d="M10 65 A50 50 0 0 1 110 65" fill="none" stroke="url(#gaugeGrad)"
          strokeWidth="10" strokeLinecap="round" strokeDasharray="157" strokeDashoffset={157 - (score / 100) * 157} />
        <g transform={`rotate(${angle}, 60, 65)`}>
          <line x1="60" y1="65" x2="60" y2="22" stroke={color} strokeWidth="2.5" strokeLinecap="round" />
          <circle cx="60" cy="65" r="4" fill={color} />
        </g>
        <text x="60" y="80" textAnchor="middle" fill={color} fontSize="13" fontWeight="bold">{score}</text>
      </svg>
      <span className="text-xs font-semibold tracking-widest" style={{ color }}>{level} RISK</span>
    </div>
  );
}

// ── Allocation Bar ─────────────────────────────────────────────
function AllocationBar({ pct, color = "#22d3a0" }: { pct: number; color?: string }) {
  return (
    <div className="relative h-1.5 w-full rounded-full overflow-hidden" style={{ background: "rgba(255,255,255,0.07)" }}>
      <motion.div className="absolute top-0 left-0 h-full rounded-full"
        style={{ background: color }}
        initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={{ duration: 1, ease: "easeOut" }} />
    </div>
  );
}

// ── Ticker Tape ───────────────────────────────────────────────
function TickerTape({ quotes }: { quotes: Record<string, QuoteData> }) {
  const items = Object.values(quotes).slice(0, 10);
  if (!items.length) return null;
  return (
    <div className="overflow-hidden border-b border-white/5 bg-[#0a0f1a]" style={{ height: 32 }}>
      <motion.div className="flex gap-8 items-center h-full"
        animate={{ x: ["0%", "-50%"] }} transition={{ duration: 30, repeat: Infinity, ease: "linear" }}>
        {[...items, ...items].map((q, i) => (
          <span key={i} className="flex items-center gap-2 whitespace-nowrap text-xs font-mono">
            <span className="text-[#64748b]">{q.symbol}</span>
            <span className="text-white">{fmtPrice(q.ltp)}</span>
            <span className={q.change_pct >= 0 ? "text-[#22d3a0]" : "text-[#ef4444]"}>
              {q.change_pct >= 0 ? "▲" : "▼"} {Math.abs(q.change_pct).toFixed(2)}%
            </span>
          </span>
        ))}
      </motion.div>
    </div>
  );
}

// ── Main App ──────────────────────────────────────────────────
export default function DalalStreetAI() {
  const router = useRouter();
  const [sessionOk, setSessionOk] = useState(false);
  const [mode, setMode] = useState<Mode>("trader");
  const [symbol, setSymbol] = useState("RELIANCE");
  const [quote, setQuote] = useState<QuoteData | null>(null);
  const [quotes, setQuotes] = useState<Record<string, QuoteData>>({});
  const [priceHistory, setPriceHistory] = useState<number[]>([]);
  const [traderReport, setTraderReport] = useState<TraderReport | null>(null);
  const [investorReport, setInvestorReport] = useState<InvestorReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [marketOpen, setMarketOpen] = useState(false);
  const [assetType, setAssetType] = useState("large_cap");
  const [riskAppetite, setRiskAppetite] = useState<"LOW"|"MODERATE"|"HIGH">("MODERATE");
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<"chart"|"report"|"indicators">("chart");
  const [istTime, setIstTime] = useState("");
  const wsRef = useRef<WebSocket | null>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const chartApiRef = useRef<any>(null);
  const seriesRef = useRef<any>(null);
  const candleDataRef = useRef<any[]>([]);

  useEffect(() => {
    if (!getToken()) {
      router.replace("/login");
      return;
    }
    setSessionOk(true);
  }, [router]);

  // ── Market status ─────────────────────────────────────────
  useEffect(() => {
    fetch(`${API}/api/v1/market/status`)
      .then(r => r.json())
      .then(d => setMarketOpen(d.is_open))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const tick = () =>
      setIstTime(
        new Date().toLocaleTimeString("en-IN", {
          timeZone: "Asia/Kolkata",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: true,
        }),
      );
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  // ── Demo quotes for ticker tape ───────────────────────────
  useEffect(() => {
    const fetchQuotes = async () => {
      const syms = SYMBOLS.slice(0, 8);
      const results: Record<string, QuoteData> = {};
      await Promise.all(syms.map(async s => {
        try {
          const r = await fetch(`${API}/api/v1/market/quote/${s}`);
          if (r.ok) results[s] = await r.json();
        } catch {}
      }));
      setQuotes(results);
    };
    fetchQuotes();
    const interval = setInterval(fetchQuotes, 10000);
    return () => clearInterval(interval);
  }, []);

  // ── WebSocket live price ──────────────────────────────────
  useEffect(() => {
    if (wsRef.current) { wsRef.current.close(); wsRef.current = null; }
    const wsUrl = API.replace("http", "ws") + `/ws/market/${symbol}`;
    let ws: WebSocket | undefined;
    try {
      ws = new WebSocket(wsUrl);
      ws.onmessage = (e) => {
        const data: QuoteData = JSON.parse(e.data);
        setQuote(data);
        setPriceHistory(prev => [...prev.slice(-59), data.ltp]);
        // Update TradingView chart
        if (seriesRef.current) {
          const ts = Math.floor(Date.now() / 1000);
          const last = candleDataRef.current[candleDataRef.current.length - 1];
          if (last && Math.floor(last.time / 60) === Math.floor(ts / 60)) {
            const updated = { ...last, high: Math.max(last.high, data.ltp),
              low: Math.min(last.low, data.ltp), close: data.ltp };
            candleDataRef.current[candleDataRef.current.length - 1] = updated;
            seriesRef.current.update(updated);
          } else {
            const newCandle = { time: Math.floor(ts / 60) * 60,
              open: data.ltp, high: data.ltp, low: data.ltp, close: data.ltp };
            candleDataRef.current.push(newCandle);
            seriesRef.current.update(newCandle);
          }
        }
      };
      ws.onerror = () => {};
      wsRef.current = ws;
    } catch {}
    return () => { ws?.close(); };
  }, [symbol]);

  // ── TradingView Chart ─────────────────────────────────────
  useEffect(() => {
    if (!chartRef.current) return;
    let chart: any, series: any;
    const init = async () => {
      try {
        const { createChart } = await import("lightweight-charts");
        chart = createChart(chartRef.current!, {
          layout: { background: { color: "transparent" }, textColor: "#64748b" },
          grid: { vertLines: { color: "rgba(255,255,255,0.03)" }, horzLines: { color: "rgba(255,255,255,0.03)" } },
          crosshair: { mode: 1 },
          rightPriceScale: { borderColor: "rgba(255,255,255,0.08)", textColor: "#64748b" },
          timeScale: { borderColor: "rgba(255,255,255,0.08)", timeVisible: true },
          width: chartRef.current!.offsetWidth,
          height: 260,
        });
        series = chart.addCandlestickSeries({
          upColor: "#22d3a0", downColor: "#ef4444",
          borderUpColor: "#22d3a0", borderDownColor: "#ef4444",
          wickUpColor: "#22d3a0", wickDownColor: "#ef4444",
        });
        chartApiRef.current = chart;
        seriesRef.current = series;

        // Load historical data
        const r = await fetch(`${API}/api/v1/market/ohlc/${symbol}?days=2&interval=1minute`);
        if (r.ok) {
          const d = await r.json();
          const candles = d.candles.map((c: any) => ({
            time: typeof c.time === "string" ? Math.floor(new Date(c.time).getTime() / 1000) : c.time,
            open: c.open, high: c.high, low: c.low, close: c.close,
          })).sort((a: any, b: any) => a.time - b.time);
          candleDataRef.current = candles;
          series.setData(candles);
          chart.timeScale().fitContent();
        }
      } catch {}
    };
    init();
    const handleResize = () => { if (chartApiRef.current && chartRef.current)
      chartApiRef.current.applyOptions({ width: chartRef.current.offsetWidth }); };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (chartApiRef.current) { try { chartApiRef.current.remove(); } catch {} }
      chartApiRef.current = null; seriesRef.current = null;
    };
  }, [symbol]);

  // ── Generate Trader Report ────────────────────────────────
  const generateTraderReport = async () => {
    setLoading(true); setError(null); setTraderReport(null);
    try {
      const r = await fetch(`${API}/api/v1/trader/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ symbol, timestamp: new Date().toISOString() }),
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.detail || "Report generation failed");
      }
      const data = await r.json();
      setTraderReport(data);
      setActiveTab("report");
    } catch (e: any) {
      setError(e.message || "Failed to generate report");
    } finally { setLoading(false); }
  };

  // ── Generate Investor Report ──────────────────────────────
  const generateInvestorReport = async () => {
    setLoading(true); setError(null); setInvestorReport(null);
    try {
      const r = await fetch(`${API}/api/v1/investor/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({
          asset_type: assetType,
          risk_appetite: riskAppetite,
          symbols: [],
        }),
      });
      if (!r.ok) {
        const e = await r.json();
        throw new Error(e.detail || "Report generation failed");
      }
      const data = await r.json();
      setInvestorReport(data);
    } catch (e: any) {
      setError(e.message || "Failed to generate report");
    } finally { setLoading(false); }
  };

  const switchMode = (m: Mode) => {
    setMode(m);
    setTraderReport(null);
    setInvestorReport(null);
    setError(null);
    setActiveTab("chart");
  };

  if (!sessionOk) {
    return (
      <div className="min-h-screen flex items-center justify-center text-slate-500 text-sm" style={{ background: "#070c14" }}>
        Loading…
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: "#070c14", color: "#e2e8f0" }}>

      {/* Ambient gradient */}
      <div className="fixed inset-0 pointer-events-none" style={{
        background: "radial-gradient(ellipse 80% 50% at 20% -10%, rgba(34,211,160,0.07) 0%, transparent 60%),radial-gradient(ellipse 60% 40% at 80% 110%, rgba(99,102,241,0.06) 0%, transparent 60%)",
      }} />

      {/* Ticker Tape */}
      <TickerTape quotes={quotes} />

      {/* Header — grid keeps logo / mode / status aligned on all widths */}
      <header
        className="relative z-10 border-b border-white/[0.06] backdrop-blur-md"
        style={{ background: "linear-gradient(180deg, rgba(7,12,20,0.92) 0%, rgba(7,12,20,0.75) 100%)" }}>
        <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto] sm:items-center lg:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] lg:gap-4">
            {/* Brand */}
            <div className="flex items-center gap-3 min-w-0 lg:justify-self-start">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", delay: 0.08 }}
                className="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-lg shadow-emerald-500/10"
                style={{ background: "linear-gradient(135deg, #22d3a0, #6366f1)" }}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" aria-hidden>
                  <polyline points="22 7 13.5 15.5 8.5 10.5 2 17" />
                  <polyline points="16 7 22 7 22 13" />
                </svg>
              </motion.div>
              <div className="min-w-0">
                <motion.h1
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  className="text-base sm:text-lg font-bold tracking-tight truncate"
                  style={{ color: "#f1f5f9", letterSpacing: "-0.02em" }}>
                  DalalStreet <span style={{ color: "#22d3a0" }}>AI</span>
                </motion.h1>
                <p className="text-[10px] text-slate-500 tracking-[0.2em] uppercase">Indian market intelligence</p>
              </div>
            </div>

            {/* Mode switch — centered on large screens */}
            <div className="flex justify-center sm:col-span-2 lg:col-span-1 lg:justify-self-center">
              <div
                className="inline-flex items-center gap-0.5 p-1 rounded-xl"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                  boxShadow: "inset 0 1px 0 rgba(255,255,255,0.04)",
                }}
                role="tablist"
                aria-label="Trading mode">
                {(["trader", "investor"] as Mode[]).map(m => {
                  const active = mode === m;
                  const trader = m === "trader";
                  return (
                    <motion.button
                      key={m}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => switchMode(m)}
                      whileTap={{ scale: 0.97 }}
                      className="relative flex items-center justify-center gap-1.5 px-4 sm:px-5 py-2 rounded-lg text-[11px] sm:text-xs font-bold tracking-wide uppercase min-h-[40px] min-w-[118px] sm:min-w-[132px] transition-colors"
                      style={{
                        color: active ? "#070c14" : "#94a3b8",
                        background: active ? (trader ? "#22d3a0" : "#818cf8") : "transparent",
                        boxShadow: active ? "0 2px 12px rgba(34,211,160,0.25)" : "none",
                      }}>
                      {trader ? <Zap className="w-3.5 h-3.5 shrink-0" strokeWidth={2.5} /> : <TrendingUp className="w-3.5 h-3.5 shrink-0" strokeWidth={2.5} />}
                      <span className="whitespace-nowrap">{trader ? "Trader" : "Investor"}</span>
                    </motion.button>
                  );
                })}
              </div>
            </div>

            {/* Market status + clock — aligned row, fixed visual height */}
            <div className="flex flex-wrap items-center justify-end gap-2 sm:col-span-2 lg:col-span-1 lg:justify-self-end">
              <Link
                href="/reports"
                className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg text-xs font-semibold text-slate-400 hover:text-emerald-400 transition-colors"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}>
                <FileText className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                <span className="hidden sm:inline">Reports</span>
              </Link>
              <button
                type="button"
                onClick={() => { clearToken(); router.push("/login"); }}
                className="inline-flex items-center gap-1.5 h-10 px-3 rounded-lg text-xs font-semibold text-slate-400 hover:text-red-400 transition-colors"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}
                title="Sign out">
                <LogOut className="w-3.5 h-3.5 shrink-0" strokeWidth={2} aria-hidden />
                <span className="hidden sm:inline">Log out</span>
              </button>
              <div
                className="inline-flex items-center gap-2.5 h-10 px-3 rounded-lg"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}>
                <span className="relative flex h-2.5 w-2.5 shrink-0" aria-hidden>
                  {marketOpen && (
                    <span className="absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-40 animate-ping" />
                  )}
                  <span
                    className="relative inline-flex rounded-full h-2.5 w-2.5"
                    style={{ background: marketOpen ? "#22d3a0" : "#ef4444" }}
                  />
                </span>
                <span className="text-xs font-semibold leading-none" style={{ color: marketOpen ? "#22d3a0" : "#94a3b8" }}>
                  NSE {marketOpen ? "Open" : "Closed"}
                </span>
              </div>
              <div
                className="inline-flex items-center gap-2 h-10 px-3 rounded-lg tabular-nums"
                style={{
                  background: "rgba(255,255,255,0.04)",
                  border: "1px solid rgba(255,255,255,0.08)",
                }}>
                <Clock className="w-3.5 h-3.5 text-slate-500 shrink-0" strokeWidth={2} aria-hidden />
                <span className="text-[11px] sm:text-xs font-mono text-slate-400 leading-none">{istTime || "—"}</span>
                <span className="text-[10px] text-slate-600 uppercase tracking-wider hidden sm:inline">IST</span>
              </div>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        <AnimatePresence mode="wait">
          {mode === "trader" ? (
            <motion.div key="trader" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.3 }}
              className="grid grid-cols-1 xl:grid-cols-3 gap-5">

              {/* Left Panel */}
              <div className="xl:col-span-2 flex flex-col gap-5">

                {/* Symbol Selector + Quote Bar */}
                <div className="rounded-2xl p-5 ds-panel">
                  <div className="flex flex-wrap items-center gap-4 mb-4">
                    <div>
                      <label className="text-[10px] text-[#475569] tracking-widest block mb-1.5">SELECT SYMBOL</label>
                      <select value={symbol} onChange={e => setSymbol(e.target.value)}
                        className="rounded-lg px-3 py-2 text-sm font-bold appearance-none cursor-pointer outline-none"
                        style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", color: "#22d3a0", minWidth: 160 }}>
                        {SYMBOLS.map(s => <option key={s} value={s} style={{ background: "#0a0f1a" }}>{s}</option>)}
                      </select>
                    </div>
                    {quote && (
                      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-wrap gap-5 items-end">
                        <div>
                          <div className="text-[10px] text-[#475569] mb-0.5">LTP</div>
                          <div className="text-3xl font-bold tracking-tight" style={{ color: "#f1f5f9" }}>
                            ₹<AnimatedNumber value={quote.ltp} decimals={2} />
                          </div>
                        </div>
                        <div className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-bold`}
                          style={{ background: quote.change_pct >= 0 ? "rgba(34,211,160,0.1)" : "rgba(239,68,68,0.1)",
                            color: quote.change_pct >= 0 ? "#22d3a0" : "#ef4444" }}>
                          {quote.change_pct >= 0 ? "▲" : "▼"} {Math.abs(quote.change_pct).toFixed(2)}%
                        </div>
                        <div className="text-xs text-[#475569] space-y-0.5">
                          <div>Vol: <span className="text-[#94a3b8]">{fmt(quote.volume)}</span></div>
                          <div>Bid/Ask: <span className="text-[#94a3b8]">₹{quote.bid} / ₹{quote.ask}</span></div>
                        </div>
                        <div className="ml-auto">
                          <Sparkline data={priceHistory} color={priceHistory.length > 1 && priceHistory[priceHistory.length-1] >= priceHistory[0] ? "#22d3a0" : "#ef4444"} width={90} height={36} />
                        </div>
                      </motion.div>
                    )}
                  </div>

                  {/* Tab Bar */}
                  <div className="flex gap-1 mb-4" style={{ borderBottom: "1px solid rgba(255,255,255,0.06)" }}>
                    {(["chart","report","indicators"] as const).map(t => (
                      <button key={t} onClick={() => setActiveTab(t)}
                        className="px-4 py-2 text-xs tracking-widest uppercase transition-all relative"
                        style={{ color: activeTab === t ? "#22d3a0" : "#475569" }}>
                        {t}
                        {activeTab === t && <motion.div layoutId="tabIndicator" className="absolute bottom-0 left-0 right-0 h-0.5 rounded-full" style={{ background: "#22d3a0" }} />}
                      </button>
                    ))}
                  </div>

                  <AnimatePresence mode="wait">
                    {activeTab === "chart" && (
                      <motion.div key="chart" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                        <div ref={chartRef} style={{ height: 260, borderRadius: 8, overflow: "hidden" }} />
                      </motion.div>
                    )}
                    {activeTab === "report" && traderReport && (
                      <motion.div key="report" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                        <TraderReportView report={traderReport} />
                      </motion.div>
                    )}
                    {activeTab === "report" && !traderReport && (
                      <motion.div key="no-report" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="h-40 flex items-center justify-center text-[#334155] text-sm">
                        Generate a report to see analysis here
                      </motion.div>
                    )}
                    {activeTab === "indicators" && quote && (
                      <motion.div key="indicators" initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                        className="grid grid-cols-2 sm:grid-cols-4 gap-3 py-2">
                        {[
                          { label: "OPEN", value: fmtPrice(quote.open) },
                          { label: "HIGH", value: fmtPrice(quote.high), color: "#22d3a0" },
                          { label: "LOW", value: fmtPrice(quote.low), color: "#ef4444" },
                          { label: "CLOSE (PREV)", value: fmtPrice(quote.close) },
                        ].map(item => (
                          <div key={item.label} className="rounded-lg p-3"
                            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <div className="text-[10px] text-[#475569] tracking-widest mb-1">{item.label}</div>
                            <div className="text-sm font-bold" style={{ color: item.color || "#e2e8f0" }}>{item.value}</div>
                          </div>
                        ))}
                        {traderReport && [
                          { label: "RSI (14)", value: traderReport.technical.rsi_14.toFixed(1),
                            color: traderReport.technical.rsi_14 > 70 ? "#ef4444" : traderReport.technical.rsi_14 < 30 ? "#22d3a0" : "#f59e0b" },
                          { label: "VWAP", value: fmtPrice(traderReport.technical.vwap) },
                          { label: "BB UPPER", value: fmtPrice(traderReport.technical.bollinger.upper) },
                          { label: "BB LOWER", value: fmtPrice(traderReport.technical.bollinger.lower) },
                        ].map(item => (
                          <div key={item.label} className="rounded-lg p-3"
                            style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
                            <div className="text-[10px] text-[#475569] tracking-widest mb-1">{item.label}</div>
                            <div className="text-sm font-bold" style={{ color: item.color || "#e2e8f0" }}>{item.value}</div>
                          </div>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>
              </div>

              {/* Right Panel — Punch-in + Report */}
              <div className="flex flex-col gap-5">
                <PunchInPanel symbol={symbol} loading={loading} marketOpen={marketOpen}
                  onGenerate={generateTraderReport} error={error} report={traderReport} />
              </div>
            </motion.div>
          ) : (
            <motion.div key="investor" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -16 }} transition={{ duration: 0.3 }}>
              <InvestorPanel loading={loading} error={error} report={investorReport}
                assetType={assetType} setAssetType={setAssetType}
                riskAppetite={riskAppetite} setRiskAppetite={setRiskAppetite}
                onGenerate={generateInvestorReport} />
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer */}
      <footer className="border-t border-white/5 py-4 px-6 text-center">
        <p className="text-[10px] text-[#1e293b] tracking-widest">
          ⚠ SEBI DISCLAIMER: DalalStreet AI is for educational purposes only. Not SEBI registered. Past performance ≠ future results. Invest responsibly.
        </p>
      </footer>
    </div>
  );
}

// ── Punch-In Panel ─────────────────────────────────────────────
function PunchInPanel({ symbol, loading, marketOpen, onGenerate, error, report }: {
  symbol: string; loading: boolean; marketOpen: boolean;
  onGenerate: () => void; error: string | null; report: TraderReport | null;
}) {
  return (
    <div className="rounded-2xl overflow-hidden" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
      <div className="p-5">
        <div className="flex items-center gap-2 mb-1">
          <span className="text-[10px] text-[#475569] tracking-widest">RISK ASSESSMENT ENGINE</span>
          {report?.from_cache && (
            <span className="text-[9px] px-2 py-0.5 rounded-full" style={{ background: "rgba(99,102,241,0.15)", color: "#6366f1" }}>CACHED</span>
          )}
        </div>
        <h2 className="text-base font-bold mb-4" style={{ color: "#e2e8f0" }}>
          Intraday Report — <span style={{ color: "#22d3a0" }}>{symbol}</span>
        </h2>

        {!marketOpen && (
          <div className="rounded-lg p-3 mb-4 text-xs flex items-center gap-2"
            style={{ background: "rgba(245,158,11,0.08)", border: "1px solid rgba(245,158,11,0.2)", color: "#f59e0b" }}>
            ⏰ Market is currently closed. Reports use last available data.
          </div>
        )}

        <motion.button onClick={onGenerate} disabled={loading} whileTap={{ scale: 0.97 }}
          className="w-full py-3.5 rounded-xl font-bold text-sm tracking-wider relative overflow-hidden transition-all"
          style={{ background: loading ? "rgba(34,211,160,0.1)" : "linear-gradient(135deg, #22d3a0, #059669)",
            color: loading ? "#22d3a0" : "#070c14",
            border: loading ? "1px solid rgba(34,211,160,0.3)" : "none" }}>
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                className="w-4 h-4 border-2 border-current border-t-transparent rounded-full block" />
              Analysing Market…
            </span>
          ) : (
            <span className="flex items-center justify-center gap-2">
              ⚡ PUNCH IN — Generate Report
            </span>
          )}
        </motion.button>

        {error && (
          <motion.div initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }}
            className="mt-3 rounded-lg p-3 text-xs"
            style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
            {error}
          </motion.div>
        )}
      </div>

      {/* Report Summary Card */}
      {report && (
        <motion.div initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} className="border-t border-white/5 p-5 space-y-4">
          {/* Decision Badge */}
          <div className="flex items-center justify-between">
            <div className="rounded-xl px-5 py-3 text-center"
              style={{ background: DECISION_BG[report.assessment.decision], border: `1px solid ${DECISION_COLOR[report.assessment.decision]}30` }}>
              <div className="text-2xl font-black tracking-wider" style={{ color: DECISION_COLOR[report.assessment.decision] }}>
                {report.assessment.decision}
              </div>
              <div className="text-[10px] tracking-widest mt-0.5" style={{ color: DECISION_COLOR[report.assessment.decision] + "aa" }}>
                {report.assessment.confidence_pct}% CONFIDENCE
              </div>
            </div>
            <RiskGauge score={report.assessment.risk_score} level={report.assessment.risk_level} />
          </div>

          {/* Summary */}
          <p className="text-xs leading-relaxed" style={{ color: "#94a3b8" }}>
            {report.assessment.summary}
          </p>

          {/* Prices */}
          {(report.assessment.entry_price || report.assessment.stop_loss || report.assessment.target_price) && (
            <div className="grid grid-cols-3 gap-2">
              {[
                { label: "ENTRY", value: report.assessment.entry_price, color: "#f59e0b" },
                { label: "SL", value: report.assessment.stop_loss, color: "#ef4444" },
                { label: "TARGET", value: report.assessment.target_price, color: "#22d3a0" },
              ].map(item => item.value && (
                <div key={item.label} className="rounded-lg p-2 text-center"
                  style={{ background: "rgba(255,255,255,0.03)", border: `1px solid ${item.color}25` }}>
                  <div className="text-[9px] tracking-widest mb-1" style={{ color: item.color + "99" }}>{item.label}</div>
                  <div className="text-xs font-bold" style={{ color: item.color }}>₹{item.value}</div>
                </div>
              ))}
            </div>
          )}

          {/* Signals */}
          <div>
            <div className="text-[10px] text-[#475569] tracking-widest mb-2">KEY SIGNALS</div>
            <div className="space-y-1.5">
              {report.assessment.key_signals.map((s, i) => (
                <motion.div key={i} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: i * 0.08 }}
                  className="flex items-start gap-2 text-xs" style={{ color: "#94a3b8" }}>
                  <span style={{ color: "#22d3a0", marginTop: 1 }}>◆</span> {s}
                </motion.div>
              ))}
            </div>
          </div>

          {/* Warnings */}
          {report.assessment.warnings.length > 0 && (
            <div>
              <div className="text-[10px] text-[#475569] tracking-widest mb-2">⚠ WARNINGS</div>
              {report.assessment.warnings.map((w, i) => (
                <div key={i} className="text-xs rounded p-2 mb-1" style={{ background: "rgba(245,158,11,0.06)", color: "#f59e0b" }}>
                  {w}
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-between text-[10px] text-[#334155] pt-2 border-t border-white/5">
            <span>BIAS: <span style={{ color: report.assessment.technical_bias === "BULLISH" ? "#22d3a0" : report.assessment.technical_bias === "BEARISH" ? "#ef4444" : "#f59e0b" }}>{report.assessment.technical_bias}</span></span>
            <span>{new Date(report.timestamp).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })}</span>
          </div>
        </motion.div>
      )}
    </div>
  );
}

// ── Trader Report Full View ────────────────────────────────────
function TraderReportView({ report }: { report: TraderReport }) {
  return (
    <div className="space-y-4 py-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "RSI (14)", value: report.technical.rsi_14.toFixed(1),
            color: report.technical.rsi_14 > 70 ? "#ef4444" : report.technical.rsi_14 < 30 ? "#22d3a0" : "#f59e0b",
            note: report.technical.rsi_14 > 70 ? "Overbought" : report.technical.rsi_14 < 30 ? "Oversold" : "Neutral" },
          { label: "VWAP", value: `₹${report.technical.vwap}`, color: "#e2e8f0",
            note: report.technical.ltp > report.technical.vwap ? "Above VWAP ↑" : "Below VWAP ↓" },
          { label: "52W HIGH", value: `₹${report.technical.high_52w}`, color: "#22d3a0", note: "" },
          { label: "52W LOW", value: `₹${report.technical.low_52w}`, color: "#ef4444", note: "" },
        ].map(item => (
          <div key={item.label} className="rounded-xl p-3" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
            <div className="text-[10px] text-[#475569] tracking-widest mb-1">{item.label}</div>
            <div className="text-base font-bold" style={{ color: item.color }}>{item.value}</div>
            {item.note && <div className="text-[10px] mt-0.5" style={{ color: item.color + "99" }}>{item.note}</div>}
          </div>
        ))}
      </div>

      {/* Bollinger Bands */}
      <div className="rounded-xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
        <div className="text-[10px] text-[#475569] tracking-widest mb-3">BOLLINGER BANDS</div>
        <div className="relative h-8">
          {[
            { label: "Lower", val: report.technical.bollinger.lower, pos: 0, color: "#ef4444" },
            { label: "Mid", val: report.technical.bollinger.mid, pos: 50, color: "#f59e0b" },
            { label: "Upper", val: report.technical.bollinger.upper, pos: 100, color: "#22d3a0" },
          ].map(b => (
            <div key={b.label} className="absolute flex flex-col items-center" style={{ left: `${b.pos}%`, transform: "translateX(-50%)" }}>
              <span className="text-[9px]" style={{ color: b.color }}>₹{b.val}</span>
              <span className="text-[9px] text-[#334155]">{b.label}</span>
            </div>
          ))}
          <div className="absolute top-3 left-0 right-0 h-0.5 rounded-full" style={{ background: "linear-gradient(to right, #ef4444, #f59e0b, #22d3a0)" }} />
          {/* LTP marker */}
          {(() => {
            const r = report.technical;
            const range = r.bollinger.upper - r.bollinger.lower;
            const pct = range > 0 ? clamp(((r.ltp - r.bollinger.lower) / range) * 100, 0, 100) : 50;
            return <div className="absolute top-1.5 w-2 h-2 rounded-full -ml-1" style={{ left: `${pct}%`, background: "#fff", boxShadow: "0 0 6px rgba(255,255,255,0.8)" }} />;
          })()}
        </div>
      </div>
    </div>
  );
}

// ── Investor Panel ─────────────────────────────────────────────
function InvestorPanel({ loading, error, report, assetType, setAssetType, riskAppetite, setRiskAppetite, onGenerate }: {
  loading: boolean; error: string | null; report: InvestorReport | null;
  assetType: string; setAssetType: (v: string) => void;
  riskAppetite: "LOW"|"MODERATE"|"HIGH"; setRiskAppetite: (v: "LOW"|"MODERATE"|"HIGH") => void;
  onGenerate: () => void;
}) {
  const ASSET_TYPES = [
    { value: "large_cap", label: "Large Cap", icon: "🏛️", desc: "Nifty 50 blue-chip stocks" },
    { value: "small_cap", label: "Small Cap", icon: "🚀", desc: "High growth potential" },
    { value: "etf", label: "ETFs", icon: "📊", desc: "Index-tracking funds" },
    { value: "mutual_fund", label: "Mutual Funds", icon: "🏦", desc: "Professionally managed" },
  ];

  return (
    <div className="space-y-6">
      {/* Config Panel */}
      <div className="rounded-2xl p-6" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
        <h2 className="text-sm font-bold tracking-widest text-[#64748b] mb-5">CONFIGURE YOUR INVESTMENT PROFILE</h2>

        <div className="grid md:grid-cols-2 gap-6">
          {/* Asset Type */}
          <div>
            <label className="text-[10px] text-[#475569] tracking-widest block mb-3">ASSET TYPE</label>
            <div className="grid grid-cols-2 gap-2">
              {ASSET_TYPES.map(a => (
                <motion.button key={a.value} onClick={() => setAssetType(a.value)} whileTap={{ scale: 0.97 }}
                  className="p-3 rounded-xl text-left transition-all"
                  style={{
                    background: assetType === a.value ? "rgba(99,102,241,0.15)" : "rgba(255,255,255,0.03)",
                    border: `1px solid ${assetType === a.value ? "rgba(99,102,241,0.4)" : "rgba(255,255,255,0.07)"}`,
                  }}>
                  <div className="text-lg mb-1">{a.icon}</div>
                  <div className="text-xs font-bold" style={{ color: assetType === a.value ? "#818cf8" : "#e2e8f0" }}>{a.label}</div>
                  <div className="text-[10px] text-[#475569] mt-0.5">{a.desc}</div>
                </motion.button>
              ))}
            </div>
          </div>

          {/* Risk Appetite */}
          <div>
            <label className="text-[10px] text-[#475569] tracking-widest block mb-3">RISK APPETITE</label>
            <div className="space-y-2">
              {(["LOW","MODERATE","HIGH"] as const).map(r => {
                const colors: Record<string, string> = { LOW: "#22d3a0", MODERATE: "#f59e0b", HIGH: "#ef4444" };
                const descs: Record<string, string> = {
                  LOW: "Capital preservation, stable returns",
                  MODERATE: "Balanced growth & safety",
                  HIGH: "Aggressive growth, volatility ok",
                };
                return (
                  <motion.button key={r} onClick={() => setRiskAppetite(r)} whileTap={{ scale: 0.98 }}
                    className="w-full p-3 rounded-xl flex items-center gap-3 transition-all"
                    style={{
                      background: riskAppetite === r ? `rgba(${r === "LOW" ? "34,211,160" : r === "MODERATE" ? "245,158,11" : "239,68,68"},0.1)` : "rgba(255,255,255,0.03)",
                      border: `1px solid ${riskAppetite === r ? colors[r] + "40" : "rgba(255,255,255,0.07)"}`,
                    }}>
                    <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: colors[r] }} />
                    <div className="text-left">
                      <div className="text-xs font-bold" style={{ color: riskAppetite === r ? colors[r] : "#e2e8f0" }}>{r}</div>
                      <div className="text-[10px] text-[#475569]">{descs[r]}</div>
                    </div>
                    {riskAppetite === r && <span className="ml-auto text-xs" style={{ color: colors[r] }}>✓</span>}
                  </motion.button>
                );
              })}
            </div>
          </div>
        </div>

        <motion.button onClick={onGenerate} disabled={loading} whileTap={{ scale: 0.97 }}
          className="w-full mt-6 py-3.5 rounded-xl font-bold text-sm tracking-wider"
          style={{ background: loading ? "rgba(99,102,241,0.15)" : "linear-gradient(135deg, #6366f1, #4f46e5)",
            color: loading ? "#6366f1" : "#fff",
            border: loading ? "1px solid rgba(99,102,241,0.3)" : "none" }}>
          {loading ? (
            <span className="flex items-center justify-center gap-2">
              <motion.span animate={{ rotate: 360 }} transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                className="w-4 h-4 border-2 border-current border-t-transparent rounded-full block" />
              Analysing Opportunities…
            </span>
          ) : "📈 Generate Investment Report"}
        </motion.button>

        {error && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="mt-3 p-3 rounded-lg text-xs"
            style={{ background: "rgba(239,68,68,0.08)", border: "1px solid rgba(239,68,68,0.2)", color: "#f87171" }}>
            {error}
          </motion.div>
        )}
      </div>

      {/* Report Output */}
      {report && <InvestorReportView report={report} />}
    </div>
  );
}

// ── Investor Report View ───────────────────────────────────────
function InvestorReportView({ report }: { report: InvestorReport }) {
  const riskColors: Record<string, string> = { LOW: "#22d3a0", MODERATE: "#f59e0b", HIGH: "#ef4444" };

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
      {/* Summary */}
      <div className="rounded-2xl p-6" style={{ background: "rgba(99,102,241,0.06)", border: "1px solid rgba(99,102,241,0.2)" }}>
        <div className="flex items-center gap-2 mb-3">
          <span className="text-[10px] text-[#6366f1] tracking-widest">AI RECOMMENDATION SUMMARY</span>
          {report.from_cache && <span className="text-[9px] px-2 py-0.5 rounded-full" style={{ background: "rgba(99,102,241,0.2)", color: "#818cf8" }}>CACHED</span>}
        </div>
        <p className="text-sm leading-relaxed" style={{ color: "#cbd5e1" }}>
          {report.recommendation.recommendation_summary}
        </p>
        <div className="mt-3 text-xs text-[#475569]">
          Horizon: <span className="text-[#94a3b8]">{report.recommendation.holding_horizon}</span>
        </div>
      </div>

      {/* Top Picks */}
      <div className="rounded-2xl p-6" style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.07)" }}>
        <div className="text-[10px] text-[#475569] tracking-widest mb-4">TOP PICKS</div>
        <div className="space-y-4">
          {report.recommendation.top_picks.map((pick, i) => (
            <motion.div key={pick.symbol} initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }}
              transition={{ delay: i * 0.1 }} className="rounded-xl p-4"
              style={{ background: "rgba(255,255,255,0.03)", border: "1px solid rgba(255,255,255,0.06)" }}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl flex items-center justify-center text-sm font-black"
                    style={{ background: `rgba(${i === 0 ? "34,211,160" : i === 1 ? "99,102,241" : "245,158,11"},0.15)`,
                      color: i === 0 ? "#22d3a0" : i === 1 ? "#818cf8" : "#f59e0b" }}>
                    {i + 1}
                  </div>
                  <div>
                    <div className="font-bold text-sm" style={{ color: "#e2e8f0" }}>{pick.symbol}</div>
                    <div className="text-[10px] text-[#475569]">{pick.type.replace("_", " ").toUpperCase()}</div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold" style={{ color: "#22d3a0" }}>{pick.expected_return_range}</div>
                  <div className="text-[10px] text-[#475569]">Expected p.a.</div>
                </div>
              </div>

              <p className="text-xs mb-3" style={{ color: "#94a3b8" }}>{pick.rationale}</p>

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-[10px] px-2 py-1 rounded" style={{ background: `${riskColors[pick.risk_rating]}15`, color: riskColors[pick.risk_rating] }}>
                    {pick.risk_rating} RISK
                  </span>
                  {pick.sip_suitable && (
                    <span className="text-[10px] px-2 py-1 rounded" style={{ background: "rgba(99,102,241,0.12)", color: "#818cf8" }}>
                      SIP ✓
                    </span>
                  )}
                </div>
                <div className="text-[10px] text-[#475569]">Allocation: <span style={{ color: "#e2e8f0" }}>{pick.suggested_allocation_pct}%</span></div>
              </div>

              <div className="mt-2">
                <AllocationBar pct={pick.suggested_allocation_pct}
                  color={i === 0 ? "#22d3a0" : i === 1 ? "#6366f1" : "#f59e0b"} />
              </div>
            </motion.div>
          ))}
        </div>
      </div>

      {/* Tips & Notes */}
      <div className="grid sm:grid-cols-2 gap-4">
        <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="text-[10px] text-[#475569] tracking-widest mb-2">💡 DIVERSIFICATION TIP</div>
          <p className="text-xs leading-relaxed" style={{ color: "#94a3b8" }}>{report.recommendation.diversification_tip}</p>
        </div>
        <div className="rounded-2xl p-4" style={{ background: "rgba(255,255,255,0.02)", border: "1px solid rgba(255,255,255,0.06)" }}>
          <div className="text-[10px] text-[#475569] tracking-widest mb-2">🏛️ TAX NOTE (INDIA)</div>
          <p className="text-xs leading-relaxed" style={{ color: "#94a3b8" }}>{report.recommendation.tax_note}</p>
        </div>
      </div>

      <div className="rounded-xl p-3 text-[10px] leading-relaxed" style={{ background: "rgba(245,158,11,0.06)", border: "1px solid rgba(245,158,11,0.15)", color: "#92400e" }}>
        ⚠ {report.recommendation.risk_warning}
      </div>
    </motion.div>
  );
}
