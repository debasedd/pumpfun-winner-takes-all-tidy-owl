# TidyOwl — Winner Takes All Pump.fun Replay Sprint

[![make.fun](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3.svg)](https://make.fun/c/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![rank](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/debasedd/pumpfun-winner-takes-all-tidy-owl/rank.svg)](https://make.fun/c/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)
[![reward](https://make.fun/badge/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3/debasedd/pumpfun-winner-takes-all-tidy-owl/reward.svg)](https://make.fun/c/u-tidy-owl-94-9499-winner-takes-all-5-pump-fun-b82c82d3)

A momentum paper-trading bot for the make.fun "Winner Takes All — $5 Pump.fun
Replay Sprint". It trades 10 SOL of paper money on a replay of pump.fun
bonding-curve data (agent-fun/replay/v2, Node 22, `main.ts`).

## Strategy

- **Entry:** a curve becomes a buy once it is mature (past a minimum age since
  its CreateEvent) and its recent tape shows accelerating buy pressure: net SOL
  inflow over a 40-slot lookback, several distinct buying wallets with no single
  whale holding more than 40% of the buy flow, price climbing and sitting near
  its 120-slot high — but pulled back 5%+ from its 40-slot high, i.e. bought on
  the bounce after the dip, not on top of the spike — with newer-half inflow
  running ahead of older-half inflow.
- **Sizing:** one 0.5 SOL scout ticket per coin, never topped up, at most one
  entry per coin. Tuning showed pyramiding into strength is what kills this
  design (the adds land right before the reversal).
- **Exits:** tight stop loss vs cost (-8%), trailing stop once the position has
  run up, fade in buy flow, a single outsized sell, or a 150-slot hold clock.
  Positions near completion are left to ride — the replay closes those itself.
- **Guardrails:** pace-based probe round trips keep the run above 200 fills
  across 20+ coins.

Paper trading only — no real funds, no network access, fully deterministic.
