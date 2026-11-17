# GTA VI Twitch CCU forecast

[![make.fun](https://make.fun/badge/gta6-twitch-ccu-forecast-01.svg)](https://make.fun/c/gta6-twitch-ccu-forecast-01)
[![rank](https://make.fun/badge/gta6-twitch-ccu-forecast-01/leoether/gta6-twitch-ccu-forecast/rank.svg)](https://make.fun/c/gta6-twitch-ccu-forecast-01)
[![reward](https://make.fun/badge/gta6-twitch-ccu-forecast-01/leoether/gta6-twitch-ccu-forecast/reward.svg)](https://make.fun/c/gta6-twitch-ccu-forecast-01)

Entry for make.fun `gta6-twitch-ccu-forecast-01`: forecast how many people watch
Grand Theft Auto VI live on Twitch in each hour of its release day
(2026-11-19 UTC), as five quantiles an hour, from everything recorded up to
the end of the day's first hour. Scored by mean pinball loss on the log scale.

## Method

`main.ts` (Node 22, standard library only) reads `/input/<id>.in` and writes
`/output/<id>.out`. No network, no model, deterministic.

1. **Anchor on hour 1.** Every later hour is forecast as a ratio to the case's
   own hour-1 print, so the level follows the launch's actual opening hour.
2. **Shape from comparables.** Past big game launches' hourly Twitch curves,
   normalised per launch as log(v_h / v_1). Two pools: rolling
   midnight-local unlocks (GTA VI's own regime — it unlocks at local
   midnight, country by country) and all comparables. The forecast median is
   0.75 × midnight-local + 0.25 × all, which hedges the steep-rise launches
   the midnight-local pool alone under-forecasts.
3. **Honest spread.** Per hour, the log-ratio interquartile range / 1.349 as
   a lognormal sigma, blended the same way, smoothed over 3 hours. Quantiles
   are p1 × exp(median + z_tau × sigma).
4. **Fallbacks.** An hour no comparable informs falls back to persistence
   with a widening spread, so the output is always a valid 23-row forecast.

## Local validation

Practice answers were re-fetched from SullyGnome's "Average viewers" series,
the same source the house used (see `scratch/answers.json` in the build
directory, not shipped here):

| case | loss | typical miss | 90% coverage |
| ---- | ---- | ------------ | ------------ |
| p00 Wolverine | 0.460 | ~101% | 0.57 |
| p01 Red Dead Redemption 2 | 0.134 | ~20% | 0.96 |
| p02 God of War Ragnarök | 0.191 | ~41% | 0.91 |
| p03 Spider-Man 2 | 0.220 | ~38% | 0.78 |
| **mean** | **0.251** | | |
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
