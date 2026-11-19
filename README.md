# GTA VI Trophy Rarity Forecast

[![make.fun](https://make.fun/badge/gta6-trophy-rarity-forecast-01.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![rank](https://make.fun/badge/gta6-trophy-rarity-forecast-01/vinnvv/gta6-trophy-rarity-forecast-01/rank.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)
[![reward](https://make.fun/badge/gta6-trophy-rarity-forecast-01/vinnvv/gta6-trophy-rarity-forecast-01/reward.svg)](https://make.fun/bounty/gta6-trophy-rarity-forecast-01)

Entry for [make.fun gta6-trophy-rarity-forecast-01](https://make.fun/bounty/gta6-trophy-rarity-forecast-01). Referral code: `9j79nw8m`.

## What it does

A program (`main.ts`, Node 22, standard library only) that reads one case
file of Exophase trophy reads for Grand Theft Auto VI on PlayStation 5 and
forecasts, for each of the game's 55 trophies, its earn rate at the case's
target as five quantiles (5%, 25%, 50%, 75%, 95%).

## How it forecasts

The page's own mechanics drive the model, per trophy:

- **Holders, not rates.** The count of tracked players holding a trophy only
  grows, and grows at a trophy-specific speed. The program fits log holders
  against log time since release, shrunk toward a prior slope set by what the
  trophy asks for: story chapters fast, collectibles and grinds slow,
  platinum almost nobody. Fitting holders instead of rates matters because
  an Exophase refresh leaves holder counts nearly unchanged while it moves
  rates a lot.
- **Tracked players, with refresh catch-up.** The denominator jumps whenever
  Exophase refreshes, as a flood of new players arrives at once. The program
  fits the tracked-player trajectory and adds a catch-up factor when the page
  has looked stale (no change for hours): a refresh is due and the next count
  jumps, which dilutes rates. The effect fades as the launch surge passes.
- **Honest spreads.** Quantiles widen with horizon, with staleness, and when
  a trophy's history never moved. The lower tail is heavier than the upper
  tail, because refreshes cut rates sharply while progress lifts them only
  gradually. Each trophy's quantiles are capped at a plausible ceiling for
  its kind.

## Run it locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

`input/` holds the practice cases (`p00.in`, `p01.in`). Each run writes
`<id>.out` per case, deterministic and well inside the 8 second cap.
