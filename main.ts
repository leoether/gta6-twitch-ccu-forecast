// GTA VI launch-day Twitch viewer forecast — make.fun gta6-twitch-ccu-forecast-01.
//
// v3: LOESS forecaster. Reads one case per run (/input/<id>.in, or
// $MAKEFUN_INPUT_DIR) and writes /output/<id>.out (or $MAKEFUN_OUTPUT_DIR):
// for each of hours 2..24 of the release day, five quantiles of Twitch's
// concurrent viewers in the "Grand Theft Auto VI" category, scored by
// pinball loss on the log scale.
//
// Method (no network, no model, deterministic — pure functions of the case):
//
//   1. Anchor on the case's own hour-1 print p1. Every later hour is
//      forecast as a ratio to p1, so the level follows the launch's actual
//      opening hour while the shape comes from history.
//   2. Shape from the case's comparables: past big game launches' hourly
//      Twitch curves, normalised per launch as log(v_h / v_1). The key
//      structure v2 missed: how much a launch rises after hour 1 depends
//      strongly on how big hour 1 already is. Small hour-1 launches
//      (pre-launch trickle at 00:00Z, or small regional openings) rise
//      10-2000x; the biggest midnight-local openings (Elden Ring, Cyberpunk
//      2077) barely rise at all (peak 1.0-1.3x). A plain median over the
//      pool mixes those regimes and lands in between — wrong for both.
//      So per hour we fit log(v_h / v_1) against log(v_1) with a local
//      linear (LOESS) fit, Gaussian kernel bandwidth 2.5 in log-viewers,
//      evaluated at the target's own log(p1). Two pools, as in v2:
//        A — rolling midnight-local unlocks (the unlock text says
//            "midnight local", not early-access-contaminated, not weak tier).
//            This is GTA VI's own regime: it unlocks at local midnight,
//            country by country, so hour 1 is already a real opening hour.
//        B — every comparable with a usable hour 1.
//      Pool A is the honest analogue; pool B hedges the steep-rise launches
//      that pool A alone under-forecasts. Median and spread blend
//      0.75 * A + 0.25 * B, then a 3-hour running median smooth.
//   3. Spread from the same fit: the weighted interquartile range of the
//      LOESS residuals (actual log-ratio minus the fit at that launch's own
//      log(v_1)), weights from the same kernel at log(p1), / 1.349 as a
//      lognormal sigma, scaled by 0.8 (practice calibration: the raw IQR
//      spread is slightly too wide once the median is right). Quantiles are
//      p1 * exp(median_h + z_tau * sigma_h) with the standard normal z at
//      0.05/0.25/0.5/0.75/0.95.
//   4. The fitted median log-ratio is clamped to [-1.5, 2.5]: GTA VI's
//      hour 1 may exceed every comparable's, and a local-linear fit must
//      not extrapolate the (negative) size slope into an absurd collapse.
//      If a pool has no data for an hour, the other pool fills in; if
//      neither does, the hour falls back to persistence (the house
//      baseline's widening spread), so the output is always valid.
//
// Local validation (practice answers re-fetched from SullyGnome's "Average
// viewers" series, the same source the house used; see v1 scratch/
// answers.json — Wolverine, RDR2, GoW Ragnarok, Spider-Man 2):
//   house baseline practice loss ~0.387; v2 (pool medians) ~0.251;
//   v3 (this entry) ~0.146 (p00 0.155, p01 0.114, p02 0.110, p03 0.205).
//   Big console launches like the target (p01/p02) score ~0.11.
//   Tried and rejected on the same practice set: plain v1-kernel medians
//   (0.206), empirical quantiles (0.295), LOO per-hour bias correction
//   (worse), asymmetric sigmas (worse), history-diurnal blending (worse),
//   console-only weighting (worse), quadratic LOESS (see scratch).
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
/** LOESS kernel bandwidth, in log-viewer units (log(v_1) distance). */
const LOESS_BW = 2.5;
/** Calibration scale on the IQR-based sigma (practice-tuned). */
const SIGMA_SCALE = 0.8;
/** Clamp on the fitted median log-ratio (guards far extrapolation). */
const MED_MIN = -1.5;
const MED_MAX = 2.5;
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

/** Weighted quantile (weights need not sum to 1). */
function weightedQuantile(values: number[], weights: number[], q: number): number {
  const order = values.map((v, i) => [v, weights[i]] as const).sort((a, b) => a[0] - b[0]);
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return order.length > 0 ? order[0][0] : 0;
  let acc = 0;
  for (const [v, w] of order) {
    acc += w;
    if (acc >= total * q) return v;
  }
  return order[order.length - 1][0];
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

/**
 * Local-linear (LOESS) fit of y on x with a Gaussian kernel of bandwidth
 * `bw`, evaluated at x0. Falls back to the weighted mean when the local
 * slope is unidentified (near-zero spread in x).
 */
function loessPredict(xs: number[], ys: number[], x0: number, bw: number): number {
  const ws = xs.map((x) => Math.exp(-(((x - x0) / bw) ** 2)));
  const sw = ws.reduce((a, b) => a + b, 0);
  if (sw <= 0) return median(ys);
  const xm = ws.reduce((a, w, i) => a + w * xs[i], 0) / sw;
  const ym = ws.reduce((a, w, i) => a + w * ys[i], 0) / sw;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += ws[i] * (xs[i] - xm) * (ys[i] - ym);
    den += ws[i] * (xs[i] - xm) ** 2;
  }
  const slope = den > 1e-9 ? num / den : 0;
  return ym + slope * (x0 - xm);
}

/**
 * Per-hour LOESS median and IQR-based sigma of log(v_h / v_1) over a pool
 * of series, evaluated at the target's log hour-1 size.
 */
function poolCurves(
  pool: Map<number, number>[],
  logP1: number,
): { med: Map<number, number>; sd: Map<number, number> } {
  const med = new Map<number, number>();
  const sd = new Map<number, number>();
  for (let h = 2; h <= 24; h++) {
    const xs: number[] = [];
    const ys: number[] = [];
    for (const series of pool) {
      const v1 = series.get(1);
      const vh = series.get(h);
      if (v1 !== undefined && vh !== undefined) {
        xs.push(Math.log(v1));
        ys.push(Math.log(vh / v1));
      }
    }
    if (xs.length < 4) continue;
    const fit = loessPredict(xs, ys, logP1, LOESS_BW);
    med.set(h, Math.max(MED_MIN, Math.min(MED_MAX, fit)));
    // Residuals around the fit at each launch's own size, kernel-weighted
    // toward the target's size: their spread is the honest uncertainty.
    const res: number[] = [];
    const resW: number[] = [];
    for (let i = 0; i < xs.length; i++) {
      res.push(ys[i] - loessPredict(xs, ys, xs[i], LOESS_BW));
      resW.push(Math.exp(-(((xs[i] - logP1) / LOESS_BW) ** 2)));
    }
    const q25 = weightedQuantile(res, resW, 0.25);
    const q75 = weightedQuantile(res, resW, 0.75);
    sd.set(h, Math.max(0.05, ((q75 - q25) / 1.349) * SIGMA_SCALE));
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
function hourQuantiles(p1: number, levels: number[], medLog: number, sdLog: number): number[] {
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
  const logP1 = Math.log(p1);

  const series = (c.comparables ?? []).map(releaseDay).filter((s) => s.has(1));
  const localPool = (c.comparables ?? [])
    .filter(isMidnightLocal)
    .map(releaseDay)
    .filter((s) => s.has(1));
  const local = poolCurves(localPool.length > 0 ? localPool : series, logP1);
  const all = poolCurves(series, logP1);
  const med = smoothCurve(blendCurves(local.med, all.med, LOCAL_WEIGHT));
  const sd = smoothCurve(blendCurves(local.sd, all.sd, LOCAL_WEIGHT));

  const hours = c.forecast.map(({ hour }) => {
    const m = med.get(hour);
    const s = sd.get(hour);
    const q =
      m !== undefined && s !== undefined
        ? hourQuantiles(p1, levels, m, s)
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
