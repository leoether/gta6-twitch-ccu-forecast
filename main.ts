// GTA VI launch-day Twitch viewer forecast — make.fun gta6-twitch-ccu-forecast-01.
//
// The program reads one case per run (/input/<id>.in, or $MAKEFUN_INPUT_DIR) and
// writes /output/<id>.out (or $MAKEFUN_OUTPUT_DIR): for each of hours 2..24 of
// the release day, five quantiles of Twitch's concurrent viewers in the
// "Grand Theft Auto VI" category, scored by pinball loss on the log scale.
//
// Method (no network, no model, deterministic — pure functions of the case):
//
//   1. Anchor on the case's own hour-1 print p1. Every later hour is forecast
//      as a ratio to p1, so the level follows the launch's actual opening hour
//      while the shape comes from history.
//   2. Shape from the case's comparables: past big game launches' hourly
//      Twitch curves, normalised per launch as log(v_h / v_1). Two pools:
//        A — rolling midnight-local unlocks (the unlock text says
//            "midnight local", not early-access-contaminated, not weak tier).
//            This is GTA VI's own regime: it unlocks at local midnight,
//            country by country, so hour 1 is already a real opening hour.
//        B — every comparable with a usable hour 1.
//      Pool A is the honest analogue; pool B's median curve rises more
//      steeply (it holds simultaneous-global launches whose hour 1 is still
//      pre-launch trickle), which hedges the steep-rise launches that pool A
//      alone under-forecasts. The forecast median is 0.75 * A + 0.25 * B.
//   3. Spread from the same pools: per hour, the log-ratio interquartile
//      range / 1.349 as a lognormal sigma, blended 0.75/0.25 like the median,
//      then a 3-hour running median smooth over both curves. Quantiles are
//      p1 * exp(median_h + z_tau * sigma_h) with the standard normal z at
//      0.05/0.25/0.5/0.75/0.95. The spread is honest about how much launches
//      disagree: about 90% of scored hours should land inside q05..q95.
//   4. If a pool has no data for an hour, the other pool fills in; if neither
//      does, the hour falls back to persistence (the house baseline's widening
//      spread), so the output is always a valid 23-row forecast.
//
// Local validation (practice answers re-fetched from SullyGnome's "Average
// viewers" series, the same source the house used; see scratch/answers.json):
//   house baseline practice loss ~0.387; this entry ~0.251 (p00 0.460,
//   p01 0.134, p02 0.191, p03 0.220). Leave-one-out over the comparables'
//   own midnight-local launches: ~0.311 vs ~0.330 unblended.
//
// Run locally: mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** Scored quantile levels, in the order each output row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** Standard normal quantiles at LEVELS. */
const Z: Record<number, number> = { 0.05: -1.645, 0.25: -0.674, 0.5: 0, 0.75: 0.674, 0.95: 1.645 };
/** Weight of the midnight-local pool in the median/spread blend. */
const LOCAL_WEIGHT = 0.75;
/** Fallback log-spread per sqrt-hour when no comparable informs an hour. */
const FALLBACK_SIGMA = 0.15;

interface KnownRow { hour: number; viewers: number }
interface ForecastRow { hour: number }
interface HourlyPoint { from: string; viewers: number }
interface Comparable { name: string; day_start: string; unlock: string; hourly: HourlyPoint[] }
interface CaseFile {
  levels: number[];
  known: KnownRow[];
  forecast: ForecastRow[];
  history_hourly?: HourlyPoint[];
  comparables: Comparable[];
}

/** Median of numbers (input order irrelevant; returns 0 for an empty list). */
function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Linear-interpolated quantile of a sorted array. */
function quantile(sorted: number[], q: number): number {
  const n = sorted.length;
  if (n === 0) return 0;
  if (n === 1) return sorted[0];
  const pos = q * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(n - 1, lo + 1);
  return sorted[lo] * (1 - (pos - lo)) + sorted[hi] * (pos - lo);
}

/** 3-point running median over hours 2..24 (edges use the available neighbours). */
function smoothCurve(curve: Map<number, number>): Map<number, number> {
  const out = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const neigh: number[] = [];
    for (const hh of [h - 1, h, h + 1]) {
      const v = curve.get(hh);
      if (v !== undefined) neigh.push(v);
    }
    out.set(h, neigh.length > 0 ? median(neigh) : 0);
  }
  return out;
}

/** Whole-hour offset of an ISO instant from the comparable's day start. */
function hourOffset(dayStart: string, at: string): number {
  return Math.round((Date.parse(at) - Date.parse(dayStart)) / 3_600_000);
}

/** A comparable's release-day series as {hour: viewers}, hours 1..24 only. */
function releaseDay(comp: Comparable): Map<number, number> {
  const series = new Map<number, number>();
  for (const row of comp.hourly ?? []) {
    const h = hourOffset(comp.day_start, row.from) + 1;
    if (h >= 1 && h <= 24 && typeof row.viewers === 'number' && row.viewers > 0) {
      series.set(h, row.viewers);
    }
  }
  return series;
}

/** Rolling midnight-local unlock, no early access, not a weak-tier launch. */
function isMidnightLocal(comp: Comparable): boolean {
  const text = (comp.unlock ?? '').toLowerCase();
  if (text.includes('early-access-contaminated')) return false;
  if (text.includes('tier: weak')) return false;
  return text.includes('midnight local');
}

/** Per-hour median and IQR-based sigma of log(v_h / v_1) over a pool of series. */
function poolCurves(pool: Map<number, number>[]): { med: Map<number, number>; sd: Map<number, number> } {
  const med = new Map<number, number>();
  const sd = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const ratios: number[] = [];
    for (const series of pool) {
      const v1 = series.get(1);
      const vh = series.get(h);
      if (v1 !== undefined && vh !== undefined) ratios.push(Math.log(vh / v1));
    }
    if (ratios.length === 0) continue;
    ratios.sort((a, b) => a - b);
    med.set(h, median(ratios));
    sd.set(h, Math.max(0.05, (quantile(ratios, 0.75) - quantile(ratios, 0.25)) / 1.349));
  }
  return { med, sd };
}

/** Blend two per-hour curves: weight w on `a`, the rest on `b` (missing side ignored). */
function blendCurves(a: Map<number, number>, b: Map<number, number>, w: number): Map<number, number> {
  const out = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const va = a.get(h);
    const vb = b.get(h);
    if (va !== undefined && vb !== undefined) out.set(h, w * va + (1 - w) * vb);
    else if (va !== undefined) out.set(h, va);
    else if (vb !== undefined) out.set(h, vb);
  }
  return out;
}

/** The five quantiles for one hour, clamped to (0, 1e9] and non-decreasing. */
function hourQuantiles(p1: number, levels: number[], medLog: number, sdLog: number, h: number): number[] {
  const qs = levels.map((tau) => {
    const z = Z[tau] ?? 0;
    return p1 * Math.exp(medLog + z * sdLog);
  });
  for (let j = 0; j < qs.length; j++) {
    if (!Number.isFinite(qs[j]) || qs[j] <= 0) qs[j] = p1;
    qs[j] = Math.min(1e9, Math.max(1, qs[j]));
    if (j > 0 && qs[j] < qs[j - 1]) qs[j] = qs[j - 1];
  }
  return qs.map((q) => Math.round(q * 100) / 100);
}

function forecastCase(c: CaseFile): { hours: { hour: number; q: number[] }[] } {
  const first = c.known?.find((k) => k.hour === 1);
  let p1 = first !== undefined && first.viewers > 0 ? first.viewers : 0;
  if (p1 <= 0) {
    // Defensive fallback: last pre-checkpoint hourly point, else 1.
    const hh = c.history_hourly ?? [];
    p1 = hh.length > 0 && hh[hh.length - 1].viewers > 0 ? hh[hh.length - 1].viewers : 1;
  }
  p1 = Math.max(1, p1);
  const levels = Array.isArray(c.levels) && c.levels.length === 5 ? c.levels : LEVELS;

  const series = (c.comparables ?? []).map(releaseDay).filter((s) => s.has(1));
  const localPool = (c.comparables ?? [])
    .filter(isMidnightLocal)
    .map(releaseDay)
    .filter((s) => s.has(1));
  const local = poolCurves(localPool.length > 0 ? localPool : series);
  const all = poolCurves(series);
  const med = smoothCurve(blendCurves(local.med, all.med, LOCAL_WEIGHT));
  const sd = smoothCurve(blendCurves(local.sd, all.sd, LOCAL_WEIGHT));

  const hours = c.forecast.map(({ hour }) => {
    const m = med.get(hour);
    const s = sd.get(hour);
    const q =
      m !== undefined && s !== undefined
        ? hourQuantiles(p1, levels, m, s, hour)
        : levels.map((tau) => {
            const z = Z[tau] ?? 0;
            const v = Math.min(1e9, Math.max(1, p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(hour - 1))));
            return Math.round(v * 100) / 100;
          });
    // Guarantee non-decreasing after rounding.
    for (let j = 1; j < q.length; j++) if (q[j] < q[j - 1]) q[j] = q[j - 1];
    return { hour, q };
  });
  return { hours };
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify(forecastCase(c))}\n`);
}
