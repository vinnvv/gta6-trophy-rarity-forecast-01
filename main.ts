// GTA VI trophy rarity forecaster (gta6-trophy-rarity-forecast-01).
//
// For every PS5 trophy, forecasts its Exophase earn rate at the case's target
// as five quantiles (5/25/50/75/95%). The case file carries the house's
// recording of the Exophase trophy page up to the checkpoint: every read's
// players-tracked count and every trophy's rate.
//
// Model, per trophy, in two parts that the page's own mechanics suggest:
//   * holders E(t): the count of tracked players holding the trophy. It only
//     grows, and grows at a trophy-specific speed. Fit log E against
//     log(1 + hours since release), shrunk toward a prior slope set by what
//     the trophy asks for (story chapters fast, collectibles and grinds slow,
//     platinum almost nobody). The fit is done on holder counts, not rates,
//     because a refresh leaves holder counts nearly unchanged while it moves
//     rates a lot.
//   * tracked players N(t): the denominator. It jumps whenever Exophase
//     refreshes, because a flood of new players arrives at once. Fit log N
//     against log(1 + hours since release), and add a catch-up factor when
//     the page has looked stale (N unchanged for hours): a refresh is due
//     and the next read will count many more players, which dilutes rates.
// The median rate is E(target) / N(target). Spreads are honest about the
// jump risk: a base random-walk term, plus extra width when the page is
// stale or the history shows no movement, and a heavier lower tail than
// upper tail, because refreshes cut rates sharply while progress lifts
// them only gradually.
//
// Node 22, standard library only, no network, deterministic.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const IN_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const QUANTILE_LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const NORMAL_Q = [-1.645, -0.674, 0, 0.674, 1.645];

type TrophyRow = {
  id: number;
  name: string;
  description: string;
  tier: string;
  points: number;
  secret: boolean;
};

type ReadRow = {
  at: string;
  players_tracked: number;
  rates: Array<number | null>;
};

type CaseFile = {
  id: string;
  at: string;
  horizon_minutes: number;
  target: string;
  levels: number[];
  game: { name: string; release_date: string };
  trophies: TrophyRow[];
  history: ReadRow[];
};

type GrowthClass = {
  holderSlope: number;
  ceilingPct: number;
  label: string;
};

function pctClamped(x: number): number {
  if (!Number.isFinite(x)) return 0.01;
  return Math.min(99.99, Math.max(0.01, x));
}

function toLogit(pct: number): number {
  const p = pctClamped(pct) / 100;
  return Math.log(p / (1 - p));
}

function fromLogit(l: number): number {
  return pctClamped(100 / (1 + Math.exp(-l)));
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/** Least-squares slope of y on x; returns slope and residual SD. */
function linFit(xs: number[], ys: number[]): { slope: number; residSd: number } {
  const n = xs.length;
  if (n < 2) return { slope: 0, residSd: 0 };
  const mx = mean(xs);
  const my = mean(ys);
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) * (xs[i] - mx);
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (sxx <= 0) return { slope: 0, residSd: 0 };
  const slope = sxy / sxx;
  const intercept = my - slope * mx;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const r = ys[i] - (intercept + slope * xs[i]);
    ss += r * r;
  }
  return { slope, residSd: Math.sqrt(ss / Math.max(1, n - 2)) };
}

/** What a trophy asks the player to do, from its tier and description. */
function classify(t: TrophyRow): GrowthClass {
  const d = `${t.name} ${t.description}`.toLowerCase();
  if (t.tier === 'platinum') return { holderSlope: 0.15, ceilingPct: 0.5, label: 'platinum' };
  const chapter = /chapter\s+(\d+)/.exec(d);
  if (chapter) {
    const ch = parseInt(chapter[1], 10);
    if (ch <= 2) return { holderSlope: 1.6, ceilingPct: 75, label: 'story-early' };
    return { holderSlope: 1.2, ceilingPct: 50, label: 'story-mid' };
  }
  if (/final mission/.test(d) && !/for\s+\w+/.test(d)) {
    return { holderSlope: 0.7, ceilingPct: 35, label: 'story-late' };
  }
  if (/100%\s*completion/.test(d)) return { holderSlope: 0.25, ceilingPct: 3, label: 'completion' };
  if (/final mission for|mission strands|strangers/.test(d)) {
    return { holderSlope: 0.9, ceilingPct: 40, label: 'side-story' };
  }
  if (/collect|card set|100 locations|every spot|discover 100|purchase all|register 10/.test(d)) {
    return { holderSlope: 0.35, ceilingPct: 8, label: 'collectible' };
  }
  if (/250 stunts|50 challenges|win 20|gold medal in all|earn \$|spend \$|rob \d|bank vaults/.test(d)) {
    return { holderSlope: 0.4, ceilingPct: 10, label: 'grind' };
  }
  return { holderSlope: 0.8, ceilingPct: 30, label: 'activity' };
}

function forecastCase(c: CaseFile): Array<{ id: number; q: number[] }> {
  if (c.levels.length !== QUANTILE_LEVELS.length) {
    throw new Error(`${c.id}: levels ${JSON.stringify(c.levels)}`);
  }
  if (c.history.length === 0) throw new Error(`${c.id}: no history`);

  const releaseMs = Date.parse(`${c.game.release_date}T00:00:00Z`);
  const hoursSince = (iso: string): number =>
    Math.max(-0.9, (Date.parse(iso) - releaseMs) / 3600000);
  const checkpointH = hoursSince(c.at);
  const targetH = hoursSince(c.target);
  const horizonDays = Math.max(0.01, c.horizon_minutes / 1440);

  const reads = c.history;
  const lastRead = reads[reads.length - 1];
  const lastN = lastRead.players_tracked;

  // Tracked-players trajectory: log N against log(1 + hours since release).
  const nXs: number[] = [];
  const nYs: number[] = [];
  let lastNChangeH = hoursSince(reads[0].at);
  let prevN = -1;
  for (const r of reads) {
    const h = hoursSince(r.at);
    nXs.push(Math.log1p(Math.max(0, h)));
    nYs.push(Math.log(Math.max(1, r.players_tracked)));
    if (prevN >= 0 && r.players_tracked !== prevN) lastNChangeH = h;
    prevN = r.players_tracked;
  }
  const distinctN = new Set(reads.map((r) => r.players_tracked)).size;
  const nFit = linFit(nXs, nYs);
  const kN = distinctN >= 2
    ? Math.min(2.0, Math.max(0.3, nFit.slope))
    : 1.1;
  // The page goes stale between refreshes: if N has not moved for hours, a
  // refresh is due and the next count jumps. Early after release the jump is
  // several-fold (launch night: 638 tracked players, then 3,868 at the first
  // refresh), so expect a large part of it now; the effect fades as the
  // launch surge passes and reads come every few minutes.
  const staleHours = Math.max(0, checkpointH - lastNChangeH);
  const earlyFade = 1 / (1 + checkpointH / 24);
  const catchUp =
    staleHours > 1
      ? 1 + (Math.min(4.0, 1 + staleHours / 2) - 1) * earlyFade
      : 1;
  const nTarget =
    lastN *
    Math.pow((1 + Math.max(0, targetH)) / (1 + Math.max(0, checkpointH)), kN) *
    catchUp;

  return c.trophies.map((t, i) => {
    const cls = classify(t);
    const lastRate = lastRead.rates[i] ?? 0;
    const lastRateClamped = pctClamped(lastRate);

    // Holder-count series for this trophy, from rates times players tracked.
    const eXs: number[] = [];
    const eYs: number[] = [];
    let informative = 0;
    let prevE = -1;
    for (const r of reads) {
      const rate = r.rates[i];
      if (rate === null || rate === undefined) continue;
      const holders = Math.max(0.5, (pctClamped(rate) / 100) * r.players_tracked);
      eXs.push(Math.log1p(Math.max(0, hoursSince(r.at))));
      eYs.push(Math.log(holders));
      if (prevE >= 0 && Math.abs(Math.log(holders) - Math.log(prevE)) > 0.05) informative++;
      prevE = holders;
    }
    const eFit = linFit(eXs, eYs);
    const weight = informative / (informative + 4);
    let slope = weight * eFit.slope + (1 - weight) * cls.holderSlope;
    slope = Math.min(2.5, Math.max(-0.5, slope));

    const lastHolders = Math.max(0.5, (lastRateClamped / 100) * lastN);
    const eTarget =
      lastHolders *
      Math.pow((1 + Math.max(0, targetH)) / (1 + Math.max(0, checkpointH)), slope);
    let medianPct = (100 * eTarget) / nTarget;
    medianPct = Math.min(cls.ceilingPct, Math.max(0.01, medianPct));
    // A trophy everyone already holds stays held: after the launch-night
    // refresh brought in six times the players, it still read 100%.
    if (lastRate >= 99.5) medianPct = 99.99;
    if (t.tier === 'platinum') medianPct = Math.min(medianPct, 1.0);

    // Spread in logit units: random-walk base, wider when the page is stale
    // or the trophy's history never moved, plus fit residual where it exists.
    let sigma = 0.5 * Math.sqrt(horizonDays);
    if (staleHours > 1) sigma += 0.9;
    if (informative === 0) sigma += 0.5;
    if (eFit.residSd > 0) sigma += 0.25 * eFit.residSd;
    sigma = Math.min(1.6, Math.max(0.35, sigma));
    // The 100% trophy barely moves; the platinum barely moves either.
    if (lastRate >= 99.5) sigma *= 0.25;
    if (t.tier === 'platinum') sigma *= 0.7;

    const medLogit = toLogit(medianPct);
    const qs = NORMAL_Q.map((z) => {
      const side = z < 0 ? sigma * 1.5 : sigma * 0.85;
      let v = round4(fromLogit(medLogit + z * side));
      // No quantile runs past what the trophy can plausibly reach, except
      // the trophy everyone already holds.
      if (lastRate < 99.5) v = Math.min(v, cls.ceilingPct);
      return v;
    });
    // Enforce non-decreasing (rounding at the 0.01/99.99 clamps can tie).
    for (let j = 1; j < qs.length; j++) {
      if (qs[j] < qs[j - 1]) qs[j] = qs[j - 1];
    }
    return { id: t.id, q: qs };
  });
}

mkdirSync(OUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const files = readdirSync(IN_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of files) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(IN_DIR, file), 'utf8')) as CaseFile;
  const trophies = forecastCase(c);
  writeFileSync(join(OUT_DIR, `${id}.out`), `${JSON.stringify({ trophies })}\n`);
}
