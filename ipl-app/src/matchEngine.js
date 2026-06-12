// ============================================================================
// T20 MATCH ENGINE — one engine, two presentations.
// League games run it muted (result card only); playoffs replay the SAME
// `timeline` over-by-over. Outcomes are driven by the real-stat archetypes in
// players.js: rating, batOrder, finisher, bowlType, bowlPhase, deathSpec.
//
// Pure ES module: no React, no DOM. Imported by the app AND by data/season_test.mjs
// so the engine can be tuned head-less before any UI is wired.
// ============================================================================

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const r2 = (v) => Math.round(v * 100) / 100;

// ── Phase model ─────────────────────────────────────────────────────────────
// 20 overs split into powerplay (1-6), middle (7-15), death (16-20). Base
// per-ball outcome distributions, tuned so a neutral XI posts ~165-175.
const phaseOf = (over) => (over < 6 ? "pp" : over < 15 ? "mid" : "death");

const BASE = {
  pp:    { 0: 0.34, 1: 0.31, 2: 0.075, 3: 0.005, 4: 0.135, 6: 0.05,  W: 0.045 },
  mid:   { 0: 0.34, 1: 0.355, 2: 0.085, 3: 0.005, 4: 0.105, 6: 0.05,  W: 0.045 },
  death: { 0: 0.28, 1: 0.285, 2: 0.085, 3: 0.005, 4: 0.165, 6: 0.115, W: 0.065 },
};

const OUTCOMES = [0, 1, 2, 3, 4, 6, "W"];

// ── Auto-XI selection ───────────────────────────────────────────────────────
// Pick the best legal XI from an 18-25 squad: exactly 1 keeper, ≥5 bowling
// options (specialist bowlers + all-rounders), and at most 4 overseas players
// (the real IPL playing-XI cap — distinct from the 8-in-squad cap). This is
// where hoarding overseas stars in the auction bites: you can only field 4.
const canBowl = (p) => p.role === "Bowler" || p.role === "All-rounder";

export function pickXI(squad) {
  if (squad.length <= 11) return [...squad];

  const byRating = (a, b) => b.rating - a.rating;
  const keepers  = squad.filter((p) => p.wk).sort(byRating);
  const bowlers  = squad.filter((p) => p.role === "Bowler").sort(byRating);
  const allr     = squad.filter((p) => p.role === "All-rounder").sort(byRating);
  const batters  = squad.filter((p) => !p.wk && p.role === "Batter").sort(byRating);

  const xi = [];
  const take = (p) => { if (p && !xi.includes(p)) xi.push(p); };

  // Spine: best keeper, 4 frontline bowlers, 2 all-rounders.
  take(keepers[0]);
  bowlers.slice(0, 4).forEach(take);
  allr.slice(0, 2).forEach(take);

  // Fill remaining slots with the best available across batters → allr → bowlers.
  const pool = [...batters, ...allr.slice(2), ...bowlers.slice(4), ...keepers.slice(1)]
    .sort(byRating);
  for (const p of pool) { if (xi.length >= 11) break; take(p); }

  // Guarantee ≥5 bowling options — swap the weakest pure batter for the best
  // unused bowler/all-rounder if we're short.
  let bowlCount = xi.filter(canBowl).length;
  if (bowlCount < 5) {
    const spareBowl = [...bowlers, ...allr].filter((p) => !xi.includes(p)).sort(byRating);
    const weakBats  = xi.filter((p) => p.role === "Batter" && !p.wk).sort((a, b) => a.rating - b.rating);
    for (const add of spareBowl) {
      if (bowlCount >= 5 || !weakBats.length) break;
      const drop = weakBats.shift();
      xi[xi.indexOf(drop)] = add;
      bowlCount++;
    }
  }

  // Enforce overseas ≤ 4: replace the lowest-rated surplus overseas player with
  // the best available domestic. Prefer a same-role / bowling-preserving sub so
  // we don't break the ≥5-bowling guarantee, but always fall back to the best
  // domestic so the cap is honoured whenever the squad has the depth (it does:
  // ≤8 overseas in an 18+ squad means ≥10 domestic).
  const overseasInXI = () => xi.filter((p) => p.overseas);
  while (overseasInXI().length > 4) {
    const surplus = overseasInXI().sort((a, b) => a.rating - b.rating)[0];
    const dom = squad.filter((p) => !p.overseas && !xi.includes(p)).sort(byRating);
    if (!dom.length) break;   // genuinely no domestic depth — leave as is
    const sub = dom.find((p) => p.role === surplus.role)
      || (canBowl(surplus) ? dom.find((p) => canBowl(p)) : null)
      || (surplus.wk ? dom.find((p) => p.wk) : null)
      || dom[0];
    xi[xi.indexOf(surplus)] = sub;
  }

  return xi.slice(0, 11);
}

// Batting order: openers/top first, middle, finishers, all-rounders, tail.
const batKey = (p) => {
  if (p.wk && p.batOrder === "top") return 0;       // keeper-opener
  if (p.batOrder === "top") return 1;
  if (p.batOrder === "mid" && !p.finisher) return 3;
  if (p.finisher) return 5;
  if (p.role === "All-rounder") return 6;
  return 8;                                          // bowlers / tail
};
export function battingOrder(xi) {
  return [...xi].sort((a, b) => batKey(a) - batKey(b) || b.rating - a.rating);
}

// Bowling plan: 20 overs, max 4 per bowler, allocated by phase suitability.
// Death specialists close, spinners work the middle, the rest open.
function bowlingPlan(xi) {
  const bowlers = xi.filter(canBowl);
  if (!bowlers.length) return [];
  const overs = Array(20).fill(null);
  const used = new Map(bowlers.map((b) => [b.name, 0]));

  const suit = (b, phase) => {
    let s = b.rating;
    if (phase === "death") s += b.deathSpec ? 30 : b.bowlPhase === "death" ? 18 : -8;
    if (phase === "mid")   s += b.bowlType === "spin" ? 16 : 0;
    if (phase === "pp")    s += b.bowlPhase === "pp" ? 14 : b.bowlType === "spin" ? -10 : 4;
    return s;
  };

  let last = null;
  for (let o = 0; o < 20; o++) {
    const phase = phaseOf(o);
    const elig = bowlers
      .filter((b) => used.get(b.name) < 4 && b.name !== last)
      .sort((a, b) => suit(b, phase) - suit(a, phase));
    // Fallbacks keep `pick` defined even for a thin attack (<5 bowlers): first
    // anyone under the 4-over cap, then — as a last resort — the best bowler
    // ignoring the cap, so a short-handed side concedes overs rather than crash.
    const pick = elig[0]
      || bowlers.filter((b) => used.get(b.name) < 4).sort((a, b) => suit(b, phase) - suit(a, phase))[0]
      || [...bowlers].sort((a, b) => suit(b, phase) - suit(a, phase))[0];
    overs[o] = pick;
    used.set(pick.name, used.get(pick.name) + 1);
    last = pick.name;
  }
  return overs;
}

// ── Per-ball outcome ────────────────────────────────────────────────────────
function simulateBall(rng, batter, bowler, phase, chase) {
  const probs = { ...BASE[phase] };

  // Skill edge: better batter than bowler → more boundaries, fewer dots/wickets.
  // Clamped so even an extreme rating gap leaves the weaker side a puncher's
  // chance — cricket always has upsets; a 40-pt mismatch should be ~90%, not 100%.
  const edge = clamp((batter.rating - bowler.rating) / 100, -0.33, 0.33);
  probs[4] *= 1 + edge * 1.5;
  probs[6] *= 1 + edge * 1.9;
  probs.W  *= 1 - edge * 1.2;
  probs[0] *= 1 - edge * 0.5;

  // Archetype bonuses.
  if (phase === "death" && batter.finisher) { probs[6] *= 1.35; probs[4] *= 1.15; probs[1] *= 1.05; }
  if (phase === "pp" && batter.batOrder === "top") { probs[4] *= 1.1; probs.W *= 0.92; }
  if (phase === "death" && bowler.deathSpec) { probs.W *= 1.4; probs[6] *= 0.78; probs[4] *= 0.85; }
  if (phase === "mid" && bowler.bowlType === "spin") { probs.W *= 1.15; probs[0] *= 1.08; probs[6] *= 0.9; }

  // Chase pressure: a climbing required rate forces risk. Wickets rise faster
  // than boundaries, so steep chases tend to collapse — keeps chase win-rate
  // near 50% and makes a defended total feel earned.
  if (chase) {
    const press = clamp((chase.rrr - chase.par) / 6, -0.3, 0.9);
    if (press > 0) { probs[6] *= 1 + press * 0.5; probs[4] *= 1 + press * 0.3; probs.W *= 1 + press * 1.15; probs[0] *= 1 - press * 0.1; }
  }

  // Normalise and sample.
  const total = OUTCOMES.reduce((s, k) => s + probs[k], 0);
  let roll = rng() * total;
  for (const k of OUTCOMES) { roll -= probs[k]; if (roll <= 0) return k; }
  return 0;
}

// ── Innings ─────────────────────────────────────────────────────────────────
function simulateInnings(rng, battingXI, bowlingXI, target) {
  const order = battingOrder(battingXI);
  const plan  = bowlingPlan(bowlingXI);

  const bat = order.map((p) => ({ p, runs: 0, balls: 0, fours: 0, sixes: 0, out: false, how: null }));
  const bowlMap = new Map();
  const bowlCard = (b) => {
    if (!bowlMap.has(b.name)) bowlMap.set(b.name, { p: b, balls: 0, runs: 0, wkts: 0 });
    return bowlMap.get(b.name);
  };

  let score = 0, wkts = 0, strike = 0, nonStrike = 1, nextIn = 2;
  const timeline = [];   // per-over summaries for the over-by-over replay
  let chased = false;

  for (let over = 0; over < 20 && wkts < 10; over++) {
    const bowler = plan[over] || bowlingXI[0];
    const bc = bowlCard(bowler);
    const phase = phaseOf(over);
    const overEvents = [];
    let overRuns = 0, overWkts = 0;

    for (let ball = 0; ball < 6 && wkts < 10; ball++) {
      const striker = bat[strike];
      const ballsLeft = (20 - over) * 6 - ball;
      const chase = target != null
        ? { rrr: ((target - score) / Math.max(1, ballsLeft)) * 6, par: 8.0 }
        : null;

      const o = simulateBall(rng, striker.p, bowler, phase, chase);
      bc.balls++; striker.balls++;

      if (o === "W") {
        striker.out = true; striker.how = bowler.name;
        wkts++; bc.wkts++; overWkts++;
        overEvents.push({ ball: ball + 1, type: "W", batter: striker.p.name });
        if (nextIn < bat.length) { strike = nextIn; nextIn++; }
      } else {
        score += o; overRuns += o; striker.runs += o; bc.runs += o;
        if (o === 4) striker.fours++;
        if (o === 6) striker.sixes++;
        if (o % 2 === 1) [strike, nonStrike] = [nonStrike, strike];
        if (o === 4 || o === 6) overEvents.push({ ball: ball + 1, type: o, batter: striker.p.name });
      }

      if (target != null && score >= target) { chased = true; break; }
    }

    [strike, nonStrike] = [nonStrike, strike];   // change ends after the over
    timeline.push({
      over: over + 1, phase, bowler: bowler.name,
      runs: overRuns, wkts: overWkts, score, wicketsDown: wkts, events: overEvents,
    });
    if (chased) break;
  }

  const totalBalls = bat.reduce((s, b) => s + b.balls, 0);
  return {
    total: score, wkts,
    overs: oversFromBalls(totalBalls),
    balls: totalBalls,
    batting: bat,
    bowling: [...bowlMap.values()],
    timeline,
    chased,
  };
}

const oversFromBalls = (b) => `${Math.floor(b / 6)}.${b % 6}`;

// ── Match ───────────────────────────────────────────────────────────────────
// `rng` is injectable so tests are reproducible; defaults to Math.random.
export function simulateMatch(teamA, teamB, opts = {}) {
  const rng = opts.rng || Math.random;
  const xiA = teamA.xi || pickXI(teamA.squad);
  const xiB = teamB.xi || pickXI(teamB.squad);

  // Toss: random winner bats first (kept simple).
  const aBatsFirst = rng() < 0.5;
  const [first, second]       = aBatsFirst ? [teamA, teamB] : [teamB, teamA];
  const [firstXI, secondXI]   = aBatsFirst ? [xiA, xiB] : [xiB, xiA];

  const inn1 = simulateInnings(rng, firstXI, secondXI, null);
  const inn2 = simulateInnings(rng, secondXI, firstXI, inn1.total + 1);

  let winner, margin, resultText;
  if (inn2.total > inn1.total) {
    winner = second.id; margin = `${10 - inn2.wkts} wkts`;
    resultText = `${second.short} beat ${first.short} by ${10 - inn2.wkts} wickets`;
  } else if (inn1.total > inn2.total) {
    winner = first.id; margin = `${inn1.total - inn2.total} runs`;
    resultText = `${first.short} beat ${second.short} by ${inn1.total - inn2.total} runs`;
  } else {
    winner = rng() < 0.5 ? first.id : second.id;   // super-over coin-flip (rare)
    margin = "Super Over"; resultText = `${winner} win in a Super Over`;
  }

  return {
    firstId: first.id, secondId: second.id,
    innings: [
      { teamId: first.id,  teamShort: first.short,  ...inn1 },
      { teamId: second.id, teamShort: second.short, ...inn2 },
    ],
    winner, margin, resultText,
    // NRR contribution: runs scored / overs faced, vs conceded / overs bowled.
    nrr: {
      [first.id]:  { for: inn1.total, forOv: ballsToOvers(inn1.balls), ag: inn2.total, agOv: ballsToOvers(inn2.balls) },
      [second.id]: { for: inn2.total, forOv: ballsToOvers(inn2.balls), ag: inn1.total, agOv: ballsToOvers(inn1.balls) },
    },
  };
}

// All-out innings count as 20 overs for NRR (standard IPL rule).
function ballsToOvers(balls) {
  return balls >= 120 || balls === 0 ? 20 : balls / 6;
}

// Best batter / bowler of a completed innings, for result cards.
export function innViews(inn) {
  const topBat = [...inn.batting].filter((b) => b.balls > 0).sort((a, b) => b.runs - a.runs)[0];
  const topBowl = [...inn.bowling].sort((a, b) => b.wkts - a.wkts || a.runs - b.runs)[0];
  return { topBat, topBowl };
}

export { ballsToOvers, oversFromBalls };
