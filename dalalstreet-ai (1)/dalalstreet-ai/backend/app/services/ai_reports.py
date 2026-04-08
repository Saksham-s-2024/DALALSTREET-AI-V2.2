import asyncio
import logging
from typing import Any

import numpy as np
from sklearn.neural_network import MLPRegressor
from sklearn.preprocessing import StandardScaler

from app.services.market_data import fetch_quote, fetch_historical_ohlc
from app.services.report_cache import (
    ReportMode,
    acquire_report_lock,
    get_cached_report,
    release_report_lock,
    set_cached_report,
)

logger = logging.getLogger(__name__)

WINDOW = 60
N_FEATURES = 15
N_PRED_SESSIONS = 5

MLP_HIDDEN = (128, 64, 32)


def _ema(series: np.ndarray, span: int) -> np.ndarray:
    alpha = 2.0 / (span + 1)
    out = np.zeros_like(series, dtype=float)
    out[0] = series[0]
    for i in range(1, len(series)):
        out[i] = alpha * series[i] + (1 - alpha) * out[i - 1]
    return out


def _calc_rsi(closes: np.ndarray, period: int = 14) -> np.ndarray:
    n = len(closes)
    rsi = np.full(n, 50.0)
    for i in range(period, n):
        window = closes[i - period : i + 1]
        deltas = np.diff(window)
        gains = np.where(deltas > 0, deltas, 0.0)
        losses = np.where(deltas < 0, -deltas, 0.0)
        ag = np.mean(gains)
        al = np.mean(losses)
        if al == 0:
            rsi[i] = 100.0
        else:
            rs = ag / al
            rsi[i] = 100.0 - (100.0 / (1.0 + rs))
    return rsi


def _rolling_sma(arr: np.ndarray, w: int) -> np.ndarray:
    n = len(arr)
    out = np.zeros(n)
    for i in range(n):
        lo = max(0, i - w + 1)
        out[i] = np.mean(arr[lo : i + 1])
    return out


def _rolling_vwap(
    high: np.ndarray, low: np.ndarray, close: np.ndarray, vol: np.ndarray
) -> np.ndarray:
    typical = (high + low + close) / 3.0
    cum_tp_vol = np.cumsum(typical * vol)
    cum_vol = np.cumsum(vol)
    cum_vol = np.where(cum_vol == 0, 1.0, cum_vol)
    return cum_tp_vol / cum_vol


def _feature_matrix(candles: list[dict]) -> np.ndarray | None:
    """One row per candle, 15 features (RSI, MACD, Bollinger, VWAP, momentum, volume, price ratios)."""
    n = len(candles)
    if n < 55:
        return None

    high = np.array([c["high"] for c in candles], dtype=float)
    low = np.array([c["low"] for c in candles], dtype=float)
    close = np.array([c["close"] for c in candles], dtype=float)
    vol = np.array([float(c.get("volume", 0)) for c in candles], dtype=float)

    rsi = _calc_rsi(close, 14)
    ema12 = _ema(close, 12)
    ema26 = _ema(close, 26)
    macd_line = ema12 - ema26
    signal_line = _ema(macd_line, 9)
    macd_hist = macd_line - signal_line

    sma20 = _rolling_sma(close, 20)
    std20 = np.zeros(n)
    for i in range(n):
        lo = max(0, i - 19)
        std20[i] = float(np.std(close[lo : i + 1])) if i - lo + 1 >= 2 else 0.0
    bb_upper = sma20 + 2 * std20
    bb_lower = sma20 - 2 * std20
    bb_mid = sma20
    bb_range = bb_upper - bb_lower
    bb_pctb = np.where(bb_range > 1e-12, (close - bb_lower) / bb_range, 0.5)
    bb_width = np.where(bb_mid > 1e-12, bb_range / bb_mid, 0.0)

    vwap = _rolling_vwap(high, low, close, vol)
    vwap_dev = np.where(close > 1e-12, (close - vwap) / close, 0.0)

    mom10 = np.zeros(n)
    for i in range(n):
        j = i - 10
        if j >= 0 and close[j] > 1e-12:
            mom10[i] = (close[i] - close[j]) / close[j]

    vol_sma20 = _rolling_sma(vol, 20)
    vol_ratio = np.where(vol_sma20 > 1e-9, vol / vol_sma20, 1.0)

    sma50 = _rolling_sma(close, 50)
    close_sma20 = np.where(sma20 > 1e-12, close / sma20 - 1.0, 0.0)
    close_sma50 = np.where(sma50 > 1e-12, close / sma50 - 1.0, 0.0)

    hl_range = np.where(close > 1e-12, (high - low) / close, 0.0)
    ret_1 = np.zeros(n)
    ret_1[1:] = np.where(close[:-1] > 1e-12, (close[1:] - close[:-1]) / close[:-1], 0.0)

    sma_spread = np.where(sma50 > 1e-12, sma20 / sma50 - 1.0, 0.0)

    stoch_k = np.full(n, 50.0)
    for i in range(13, n):
        lo14 = np.min(low[i - 13 : i + 1])
        hi14 = np.max(high[i - 13 : i + 1])
        span = hi14 - lo14
        if span > 1e-12:
            stoch_k[i] = 100.0 * (close[i] - lo14) / span

    f1 = rsi / 100.0
    f2 = np.where(close > 1e-12, macd_line / close, 0.0)
    f3 = np.where(close > 1e-12, signal_line / close, 0.0)
    f4 = np.where(close > 1e-12, macd_hist / close, 0.0)
    f5 = np.clip(bb_pctb, 0.0, 1.0)
    f6 = bb_width
    f7 = vwap_dev
    f8 = mom10
    f9 = np.clip(vol_ratio, 0.0, 5.0)
    f10 = close_sma20
    f11 = close_sma50
    f12 = hl_range
    f13 = ret_1
    f14 = sma_spread
    f15 = stoch_k / 100.0

    feat = np.column_stack(
        [f1, f2, f3, f4, f5, f6, f7, f8, f9, f10, f11, f12, f13, f14, f15]
    )
    return np.nan_to_num(feat, nan=0.0, posinf=0.0, neginf=0.0)


def _build_xy(
    feat: np.ndarray, close: np.ndarray
) -> tuple[np.ndarray, np.ndarray] | tuple[None, None]:
    n = len(close)
    xs, ys = [], []
    for i in range(WINDOW, n - N_PRED_SESSIONS):
        x = feat[i - WINDOW : i].reshape(-1)
        y = np.array([close[i + k] / close[i] for k in range(1, N_PRED_SESSIONS + 1)])
        xs.append(x)
        ys.append(y)
    if len(xs) < 8:
        return None, None
    return np.vstack(xs), np.vstack(ys)


def _train_and_predict(
    candles: list[dict],
) -> tuple[np.ndarray | None, dict[str, Any]]:
    """
    MLPRegressor (128→64→32, tanh) on flattened 60×15 inputs; predicts next 5 close ratios vs last window close.
    Returns (pred_ratios shape (5,), diagnostics).
    """
    diag: dict[str, Any] = {"trained_samples": 0, "used_mlp": False}
    feat = _feature_matrix(candles)
    if feat is None:
        return None, diag

    close = np.array([c["close"] for c in candles], dtype=float)
    xy = _build_xy(feat, close)
    if xy[0] is None:
        return None, diag

    X, y = xy
    diag["trained_samples"] = X.shape[0]

    sx = StandardScaler()
    sy = StandardScaler()
    Xs = sx.fit_transform(X)
    ys = sy.fit_transform(y)

    mlp = MLPRegressor(
        hidden_layer_sizes=MLP_HIDDEN,
        activation="tanh",
        max_iter=600,
        random_state=42,
        early_stopping=True,
        validation_fraction=0.12,
        n_iter_no_change=24,
    )
    mlp.fit(Xs, ys)
    diag["used_mlp"] = True

    last_x = feat[-WINDOW:].reshape(1, -1)
    last_xs = sx.transform(last_x)
    pred_s = mlp.predict(last_xs)
    pred_y = sy.inverse_transform(pred_s)[0]
    return pred_y, diag


def _rule_based_assessment(
    quote: dict[str, Any],
    tech: dict[str, Any],
    pred_ratios: np.ndarray | None,
    last_close: float,
) -> dict[str, Any]:
    """
    BUY / SELL / HOLD / AVOID with entry, stop-loss, target from model path + indicators.
    """
    ltp = float(quote.get("ltp", last_close))
    rsi = float(tech.get("rsi_14", 50))
    chg = float(quote.get("change_pct", 0))

    if pred_ratios is not None and len(pred_ratios) == N_PRED_SESSIONS:
        targets = np.array([last_close * float(r) for r in pred_ratios])
        median_move = float(np.median((targets - ltp) / max(ltp, 1e-9)) * 100)
        upside = float((np.max(targets) - ltp) / max(ltp, 1e-9) * 100)
        downside = float((ltp - np.min(targets)) / max(ltp, 1e-9) * 100)
    else:
        targets = np.array([ltp * 1.01, ltp * 1.02, ltp, ltp * 0.99, ltp * 0.98])
        median_move = chg
        upside = 1.5
        downside = 1.5

    score = 0
    signals: list[str] = []
    warnings: list[str] = []

    if rsi < 32:
        score += 25
        signals.append("RSI suggests oversold bounce risk/reward")
    elif rsi > 68:
        score -= 22
        signals.append("RSI elevated — pullback risk")
    else:
        signals.append("RSI in neutral zone")

    if pred_ratios is not None:
        if median_move > 0.4:
            score += 20
            signals.append(f"MLP median path: ~{median_move:+.2f}% over next sessions")
        elif median_move < -0.4:
            score -= 18
            signals.append(f"MLP median path: ~{median_move:+.2f}% over next sessions")

    if upside > downside + 0.3:
        score += 15
    elif downside > upside + 0.3:
        score -= 15

    if chg > 1.2:
        score -= 8
        warnings.append("Strong intraday move — slippage / reversal risk")
    elif chg < -1.2:
        score += 5
        warnings.append("Sharp dip — confirm volume before averaging")

    bias = "NEUTRAL"
    if score >= 12:
        bias = "BULLISH"
    elif score <= -12:
        bias = "BEARISH"

    risk_score = int(np.clip(50 - score, 0, 100))
    if risk_score < 28:
        risk_level = "LOW"
    elif risk_score < 48:
        risk_level = "MEDIUM"
    elif risk_score < 68:
        risk_level = "HIGH"
    else:
        risk_level = "EXTREME"

    if score >= 22 and risk_level in ("LOW", "MEDIUM"):
        decision = "BUY"
        entry = round(ltp, 2)
        target = round(float(np.max(targets)), 2)
        stop = round(ltp * (1 - min(0.025, max(0.008, downside / 150))), 2)
        conf = int(np.clip(52 + score, 0, 92))
    elif score <= -22 and risk_level in ("HIGH", "EXTREME", "MEDIUM"):
        decision = "SELL"
        entry = round(ltp, 2)
        target = round(float(np.min(targets)), 2)
        stop = round(ltp * (1 + min(0.03, max(0.01, upside / 120))), 2)
        conf = int(np.clip(52 - score, 0, 90))
    elif risk_level == "EXTREME" or abs(median_move) < 0.15:
        decision = "AVOID"
        entry = None
        target = None
        stop = None
        conf = int(np.clip(40 + abs(int(score)), 0, 75))
    else:
        decision = "HOLD"
        entry = round(ltp, 2)
        target = round(float(np.median(targets)), 2)
        stop = round(ltp * (1 - 0.015), 2)
        conf = int(np.clip(45 + abs(int(score)) // 2, 0, 80))

    summary = (
        f"MLPRegressor path ({N_PRED_SESSIONS} sessions) vs last close ₹{last_close:.2f}: "
        f"median implied move ~{median_move:+.2f}%. "
        f"Rule engine bias {bias} with RSI {rsi:.1f}."
    )

    return {
        "risk_level": risk_level,
        "risk_score": risk_score,
        "decision": decision,
        "confidence_pct": conf,
        "entry_price": entry,
        "stop_loss": stop,
        "target_price": target,
        "holding_period": "intraday" if decision != "AVOID" else "avoid",
        "summary": summary,
        "key_signals": signals[:5],
        "warnings": warnings[:4] if warnings else ["No critical warnings"],
        "technical_bias": bias,
        "predicted_prices_next_sessions": [round(float(x), 2) for x in targets],
    }


def _build_technical_summary(quote: dict, candles: list[dict]) -> dict[str, Any]:
    closes = [c["close"] for c in candles]
    if not closes:
        return {}
    rsi_val = float(_calc_rsi(np.array(closes, dtype=float), 14)[-1])
    return {
        "ltp": quote["ltp"],
        "change_pct": quote["change_pct"],
        "volume": quote["volume"],
        "rsi_14": round(rsi_val, 2),
        "vwap": _calc_vwap(candles[-78:]),
        "bollinger": _calc_bollinger(closes),
        "high_52w": round(max(c["high"] for c in candles[-252:]) if candles else quote["high"], 2),
        "low_52w": round(min(c["low"] for c in candles[-252:]) if candles else quote["low"], 2),
    }


def _calc_vwap(candles: list[dict]) -> float:
    if not candles:
        return 0.0
    total_vol = sum(c["volume"] for c in candles)
    if total_vol == 0:
        return 0.0
    return round(
        sum(((c["high"] + c["low"] + c["close"]) / 3) * c["volume"] for c in candles) / total_vol,
        2,
    )


def _calc_bollinger(closes: list[float], period: int = 20) -> dict[str, float]:
    if len(closes) < period:
        mid = closes[-1] if closes else 0
        return {"upper": mid, "mid": mid, "lower": mid}
    window = closes[-period:]
    mean = sum(window) / period
    std = (sum((x - mean) ** 2 for x in window) / period) ** 0.5
    return {
        "upper": round(mean + 2 * std, 2),
        "mid": round(mean, 2),
        "lower": round(mean - 2 * std, 2),
    }


def _investor_heuristic_bundle(
    assets_data: dict[str, Any],
    asset_type: str,
    risk_appetite: str,
) -> dict[str, Any]:
    """Rule-based long-horizon view without LLM."""
    ranked = sorted(
        assets_data.items(),
        key=lambda kv: kv[1].get("score", 0),
        reverse=True,
    )
    picks = []
    for sym, data in ranked[:5]:
        r = data.get("return_1y_pct", 0)
        v = data.get("volatility_pct", 0)
        score = data.get("score", 0)
        if score > 15 and r > 5:
            rr = "MODERATE" if v < 25 else "HIGH"
            picks.append({
                "symbol": sym,
                "type": asset_type,
                "rationale": f"Strong 1y momentum ({r:.1f}%) with model score {score:.0f}.",
                "risk_rating": rr,
                "expected_return_range": "10–16% p.a. (illustrative)" if rr == "MODERATE" else "12–22% p.a. (illustrative)",
                "suggested_allocation_pct": min(35, 15 + int(score)),
                "sip_suitable": True,
            })
        elif score > 0:
            picks.append({
                "symbol": sym,
                "type": asset_type,
                "rationale": f"Balanced history: {r:.1f}% return, vol ~{v:.1f}%.",
                "risk_rating": "MODERATE",
                "expected_return_range": "8–14% p.a. (illustrative)",
                "suggested_allocation_pct": 12,
                "sip_suitable": True,
            })

    if not picks:
        picks = [
            {
                "symbol": ranked[0][0],
                "type": asset_type,
                "rationale": "Limited edge in current window — consider index funds.",
                "risk_rating": "MODERATE",
                "expected_return_range": "Aligned with broad market",
                "suggested_allocation_pct": 10,
                "sip_suitable": True,
            }
        ]

    return {
        "recommendation_summary": (
            f"Profile: {asset_type}, risk {risk_appetite}. "
            "Rankings use the same MLP-style window model (daily bars) plus simple momentum/vol filters — not personalized advice."
        ),
        "top_picks": picks,
        "diversification_tip": "Split across 3–5 names or add a Nifty/Sensex index fund to reduce single-stock risk.",
        "risk_warning": "Investments are subject to market risk; past performance does not guarantee future results.",
        "holding_horizon": "3–5 years for equity SIPs; review annually.",
        "tax_note": "LTCG above ₹1 lakh on listed equity taxed at 10%; STCG at 15% (rates as per common IT rules — verify with a CA).",
    }


# ── Trader Mode Report ─────────────────────────────────────────
async def generate_trader_report(symbol: str, timestamp: str) -> dict[str, Any]:
    """
    Intraday risk assessment: MLPRegressor on 60×15 features → next 5 sessions → rule-based levels.
    Uses Redis cache + distributed lock to prevent duplicate generation.
    """
    cached = await get_cached_report(ReportMode.TRADER, symbol, timestamp[:16])
    if cached:
        return {**cached, "from_cache": True}

    lock_acquired = await acquire_report_lock(ReportMode.TRADER, symbol, timestamp[:16])
    if not lock_acquired:
        for _ in range(10):
            await asyncio.sleep(1)
            cached = await get_cached_report(ReportMode.TRADER, symbol, timestamp[:16])
            if cached:
                return {**cached, "from_cache": True}
        return {"error": "Report generation in progress, please retry in a moment.", "from_cache": False}

    try:
        quote = await fetch_quote(symbol)
        candles = await fetch_historical_ohlc(symbol, interval="1minute", days=5)
        tech = _build_technical_summary(quote, candles)
        last_close = float(candles[-1]["close"]) if candles else float(quote["ltp"])

        loop = asyncio.get_event_loop()
        pred_ratios, diag = await loop.run_in_executor(None, lambda: _train_and_predict(candles))
        assessment = _rule_based_assessment(quote, tech, pred_ratios, last_close)
        assessment["model_diagnostics"] = diag

        report = {
            "symbol": symbol,
            "timestamp": timestamp,
            "mode": "trader",
            "technical": tech,
            "assessment": assessment,
            "data_source": "mock" if quote.get("is_mock") else "yfinance",
            "from_cache": False,
        }

        await set_cached_report(ReportMode.TRADER, symbol, report, timestamp[:16])
        return report

    except Exception as exc:
        logger.error("Trader report generation error: %s", exc)
        return {"error": str(exc), "from_cache": False}
    finally:
        await release_report_lock(ReportMode.TRADER, symbol, timestamp[:16])


# ── Investor Mode Report ───────────────────────────────────────
async def generate_investor_report(
    asset_type: str,
    risk_appetite: str,
    symbols: list[str],
) -> dict[str, Any]:
    """
    Long-term view: daily MLP path + heuristic ranking per symbol (no external LLM).
    """
    cache_key = f"{asset_type}:{risk_appetite}"
    cached = await get_cached_report(ReportMode.INVESTOR, cache_key)
    if cached:
        return {**cached, "from_cache": True}

    lock_acquired = await acquire_report_lock(ReportMode.INVESTOR, cache_key)
    if not lock_acquired:
        for _ in range(10):
            await asyncio.sleep(1)
            cached = await get_cached_report(ReportMode.INVESTOR, cache_key)
            if cached:
                return {**cached, "from_cache": True}
        return {"error": "Report generation in progress, please retry in a moment.", "from_cache": False}

    try:
        if not symbols:
            return {"error": "No symbols provided", "from_cache": False}

        assets_data: dict[str, Any] = {}
        for sym in symbols[:5]:
            quote = await fetch_quote(sym)
            candles = await fetch_historical_ohlc(sym, interval="day", days=365)
            closes = np.array([c["close"] for c in candles], dtype=float)

            ret_1y = round(((closes[-1] - closes[0]) / closes[0]) * 100, 2) if len(closes) > 1 else 0
            if len(closes) > 20:
                daily_rets = [(closes[i] - closes[i - 1]) / closes[i - 1] for i in range(1, len(closes))]
                vol = round((sum(r**2 for r in daily_rets) / len(daily_rets)) ** 0.5 * 100, 2)
            else:
                vol = 0

            loop = asyncio.get_event_loop()
            pred_ratios, diag = await loop.run_in_executor(None, lambda c=candles: _train_and_predict(c))
            momentum_score = 0.0
            if pred_ratios is not None and len(closes):
                momentum_score = float(np.mean(pred_ratios) - 1.0) * 100

            rsi_last = float(_calc_rsi(closes, 14)[-1]) if len(closes) else 50
            score = momentum_score + (ret_1y * 0.15) - (vol * 0.08)
            if rsi_last < 35:
                score += 5
            elif rsi_last > 70:
                score -= 4
            if risk_appetite.upper() == "LOW" and vol > 35:
                score -= 10
            if risk_appetite.upper() == "HIGH" and ret_1y > 15:
                score += 6

            assets_data[sym] = {
                "ltp": quote["ltp"],
                "change_pct": quote["change_pct"],
                "return_1y_pct": ret_1y,
                "volatility_pct": vol,
                "rsi": round(rsi_last, 2),
                "mlp_median_path_pct": round(momentum_score, 3),
                "score": round(score, 2),
                "model_diagnostics": diag,
            }

        recommendation = _investor_heuristic_bundle(assets_data, asset_type, risk_appetite)

        report = {
            "mode": "investor",
            "asset_type": asset_type,
            "risk_appetite": risk_appetite,
            "assets_analysed": assets_data,
            "recommendation": recommendation,
            "from_cache": False,
        }

        await set_cached_report(ReportMode.INVESTOR, cache_key, report, ttl=3600)
        return report

    except Exception as exc:
        logger.error("Investor report error: %s", exc)
        return {"error": str(exc), "from_cache": False}
    finally:
        await release_report_lock(ReportMode.INVESTOR, cache_key)
