# GTA VI Twitch CCU forecast

[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/c/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/leoether/gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/c/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/leoether/gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/c/gta6-twitch-ccu-forecast-01)

Entry for make.fun `gta6-twitch-ccu-forecast-01`: forecast how many people watch
Grand Theft Auto VI live on Twitch in each hour of its release day
(2026-11-19 UTC), as five quantiles an hour, from everything recorded up to
the end of the day's first hour. Scored by mean pinball loss on the log scale.

## Method (v3 — LOESS forecaster)

`main.ts` (Node 22, standard library only) reads `/input/<id>.in` and writes
`/output/<id>.out`. No network, no model, deterministic.

1. **Anchor on hour 1.** Every later hour is forecast as a ratio to the case's
   own hour-1 print, so the level follows the launch's actual opening hour.
2. **Shape from comparables, conditional on size.** Past big game launches'
   hourly Twitch curves, normalised per launch as log(v_h / v_1). How much a
   launch rises after hour 1 depends strongly on how big hour 1 already is:
   small hour-1 launches rise 10–2000×, the biggest midnight-local openings
   (Elden Ring, Cyberpunk 2077) barely rise at all (peak 1.0–1.3×). A plain
   pool median mixes those regimes and lands in between — wrong for both. So
   per hour we fit log(v_h / v_1) against log(v_1) with a local-linear
   (LOESS) fit, Gaussian kernel bandwidth 2.5 in log-viewers, evaluated at
   the target's own log(p1). Two pools: rolling midnight-local unlocks (GTA
   VI's own regime) and all comparables, blended 0.75 / 0.25, then a 3-hour
   running-median smooth over both curves.
3. **Honest spread.** Per hour, the weighted interquartile range of the
   LOESS residuals (actual log-ratio minus the fit at that launch's own
   size), weights from the same kernel at log(p1), / 1.349 as a lognormal
   sigma, scaled by 0.8 (practice calibration). Quantiles are
   p1 × exp(median + z_tau × sigma).
4. **Extrapolation guard.** The fitted median log-ratio is clamped to
   [-1.5, 2.5]: GTA VI's hour 1 may exceed every comparable's, and a
   local-linear fit must not extrapolate the (negative) size slope into an
   absurd collapse.
5. **Fallbacks.** An hour no comparable informs falls back to persistence
   with a widening spread, so the output is always a valid 23-row forecast.

## Local validation

Practice answers were re-fetched from SullyGnome's "Average viewers" series,
the same source the house used (see `scratch/answers.json` in the build
directory, not shipped here):

| case | loss | typical miss | 90% coverage |
| ---- | ---- | ------------ | ------------ |
| p00 Wolverine | 0.156 | ~30% | 0.96 |
| p01 Red Dead Redemption 2 | 0.114 | ~19% | 0.96 |
| p02 God of War Ragnarök | 0.111 | ~19% | 0.91 |
| p03 Spider-Man 2 | 0.205 | ~35% | 0.74 |
| **mean (v3)** | **0.147** | | |
| v2 (pool medians) | 0.251 | | |
| house baseline | 0.387 | 82.8% | 0.78 |

Leave-one-out over the comparables' own midnight-local launches: ~0.311
(vs ~0.330 unblended). The practice is graded on past launches anyone can
look up and pays nothing, so it is no guide to the final — but the entry
beats the house baseline on it with a clear margin.

## Run locally

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

## License

MIT — see `LICENSE`.
