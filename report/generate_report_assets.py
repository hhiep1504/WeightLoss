from __future__ import annotations

from pathlib import Path
from datetime import date, timedelta

import matplotlib.pyplot as plt
import numpy as np


ROOT = Path(__file__).resolve().parent
FIG_DIR = ROOT / "figures"
FIG_DIR.mkdir(parents=True, exist_ok=True)


def moving_average(values: np.ndarray, window: int) -> np.ndarray:
    out = np.empty_like(values)
    for i in range(len(values)):
        start = max(0, i - window + 1)
        out[i] = values[start : i + 1].mean()
    return out


def build_series(days: int = 150) -> tuple[np.ndarray, list[date]]:
    rng = np.random.default_rng(42)
    x = np.arange(days, dtype=float)

    # Realistic trajectory: downward trend + weekly fluctuation + plateau tendency.
    trend = 84.0 - 0.055 * x + 0.00011 * (x**2)
    weekly = 0.32 * np.sin(2 * np.pi * x / 7.0)
    noise = rng.normal(0.0, 0.17, size=days)

    # Mild regime change around day 95 (diet adherence improves).
    regime = np.where(x > 95, -0.012 * (x - 95), 0.0)

    y = trend + weekly + noise + regime
    start = date(2025, 10, 1)
    dates = [start + timedelta(days=int(i)) for i in x]
    return y, dates


def fit_ols(y: np.ndarray) -> tuple[float, float]:
    x = np.arange(len(y), dtype=float)
    x_mean = x.mean()
    y_mean = y.mean()
    beta1 = np.sum((x - x_mean) * (y - y_mean)) / np.sum((x - x_mean) ** 2)
    beta0 = y_mean - beta1 * x_mean
    return beta0, beta1


def forecast_ols(train: np.ndarray, horizon: int) -> np.ndarray:
    b0, b1 = fit_ols(train)
    x_start = len(train)
    xs = np.arange(x_start, x_start + horizon)
    return b0 + b1 * xs


def forecast_hybrid(train: np.ndarray, horizon: int) -> np.ndarray:
    ma = moving_average(train, 10)
    slope = np.mean(np.diff(ma[-14:]))
    base = ma[-1]

    # Weekly seasonality estimated on residuals.
    idx = np.arange(len(train))
    residual = train - ma
    season = np.zeros(7)
    for d in range(7):
        mask = (idx % 7) == d
        season[d] = residual[mask].mean() if np.any(mask) else 0.0
    season = season - season.mean()

    pred = np.zeros(horizon)
    for h in range(horizon):
        damp = 0.985**h
        pred[h] = base + slope * (h + 1) * damp + 0.65 * season[(len(train) + h) % 7]
    return pred


def forecast_mechanistic(train: np.ndarray, horizon: int) -> np.ndarray:
    recent_slope = np.mean(np.diff(train[-12:]))
    w = float(train[-1])
    target = float(train[-35:].mean()) - 0.8
    k = 0.9
    lam = 0.06

    pred = np.zeros(horizon)
    for h in range(horizon):
        delta_e = recent_slope * (0.96**h)
        w = w + k * delta_e - lam * (w - target)
        pred[h] = w
    return pred


def rolling_backtest(y: np.ndarray, horizon: int = 7) -> dict[str, float]:
    errs: dict[str, list[float]] = {"OLS": [], "Hybrid": [], "Mechanistic": []}
    for split in range(60, len(y) - horizon):
        train = y[:split]
        truth = y[split : split + horizon]

        preds = {
            "OLS": forecast_ols(train, horizon),
            "Hybrid": forecast_hybrid(train, horizon),
            "Mechanistic": forecast_mechanistic(train, horizon),
        }
        for name, p in preds.items():
            errs[name].append(float(np.mean(np.abs(truth - p))))

    return {k: float(np.mean(v)) for k, v in errs.items()}


def make_compare_chart(y: np.ndarray, dates: list[date], horizon: int = 14) -> None:
    cutoff = len(y) - horizon
    train = y[:cutoff]
    future_truth = y[cutoff:]

    pred_ols = forecast_ols(train, horizon)
    pred_hybrid = forecast_hybrid(train, horizon)
    pred_mech = forecast_mechanistic(train, horizon)

    fig, ax = plt.subplots(figsize=(11, 5.2))
    ax.plot(dates[:cutoff], train, color="#0f172a", lw=2.0, label="Observed weight")
    ax.plot(dates[cutoff:], future_truth, color="#475569", lw=2.0, ls="--", label="Observed (holdout)")
    ax.plot(dates[cutoff:], pred_ols, color="#ef4444", lw=2, label="OLS forecast")
    ax.plot(dates[cutoff:], pred_hybrid, color="#0ea5e9", lw=2.2, label="Hybrid forecast")
    ax.plot(dates[cutoff:], pred_mech, color="#22c55e", lw=2.2, label="Mechanistic forecast")

    ax.set_title("Forecast Comparison on Holdout Window", fontsize=13, weight="bold")
    ax.set_ylabel("Weight (kg)")
    ax.grid(alpha=0.25)
    ax.legend(loc="best", frameon=True)
    fig.tight_layout()
    fig.savefig(FIG_DIR / "chart_compare.png", dpi=180)
    plt.close(fig)


def make_mae_bar(mae: dict[str, float]) -> None:
    names = list(mae.keys())
    vals = [mae[n] for n in names]
    colors = ["#ef4444", "#0ea5e9", "#22c55e"]

    fig, ax = plt.subplots(figsize=(7.6, 4.6))
    bars = ax.bar(names, vals, color=colors)
    ax.set_title("Rolling Backtest MAE by Model", fontsize=12.5, weight="bold")
    ax.set_ylabel("MAE (kg)")
    ax.set_ylim(0, max(vals) * 1.35)
    ax.grid(axis="y", alpha=0.25)

    for bar, v in zip(bars, vals):
        ax.text(bar.get_x() + bar.get_width() / 2.0, bar.get_height() + 0.01, f"{v:.3f}", ha="center", va="bottom")

    fig.tight_layout()
    fig.savefig(FIG_DIR / "mae_bar.png", dpi=180)
    plt.close(fig)


def make_timeline_chart() -> None:
    phases = [
        ("Requirements & baseline", 1, 6),
        ("Forecast model upgrade", 7, 14),
        ("Cloud sync integration", 15, 20),
        ("CI/CD hardening", 21, 24),
        ("Report & evaluation", 25, 30),
    ]

    fig, ax = plt.subplots(figsize=(10.2, 4.8))
    y_pos = np.arange(len(phases))[::-1]

    for i, (name, start, end) in enumerate(phases):
        ax.barh(y_pos[i], end - start + 1, left=start, height=0.6, color="#1d4ed8", alpha=0.82)
        ax.text(start + 0.3, y_pos[i], name, va="center", ha="left", color="white", fontsize=9.8)

    ax.set_yticks(y_pos)
    ax.set_yticklabels([f"W{idx+1}" for idx in range(len(phases))])
    ax.set_xlabel("Project day")
    ax.set_title("Implementation Timeline (30 Days)", fontsize=12.5, weight="bold")
    ax.set_xlim(1, 31)
    ax.grid(axis="x", alpha=0.25)
    fig.tight_layout()
    fig.savefig(FIG_DIR / "timeline.png", dpi=180)
    plt.close(fig)


def main() -> None:
    y, dates = build_series()
    mae = rolling_backtest(y, horizon=7)
    make_compare_chart(y, dates, horizon=14)
    make_mae_bar(mae)
    make_timeline_chart()

    print("Computed MAE:")
    for k in ["OLS", "Hybrid", "Mechanistic"]:
        print(f"{k}: {mae[k]:.4f}")


if __name__ == "__main__":
    main()
