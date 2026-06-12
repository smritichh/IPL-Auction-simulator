// Head-less harness to tune the match engine before wiring UI.
// Run: node data/season_test.mjs
import { PLAYERS } from "../ipl-app/src/players.js";
import { simulateMatch, pickXI, battingOrder, innViews } from "../ipl-app/src/matchEngine.js";

// Reuse the auction engine to build 10 real squads, then play matches between them.
// Lightweight copy of the auction sim (mirrors sim_test.mjs) just to get squads.
const TEAMS = [
  { id: "MI", short: "MI", agg: 1.0 }, { id: "CSK", short: "CSK", agg: 1.0 }, { id: "RCB", short: "RCB", agg: 1.12 },
  { id: "KKR", short: "KKR", agg: 0.98 }, { id: "DC", short: "DC", agg: 0.92 }, { id: "SRH", short: "SRH", agg: 1.08 },
  { id: "RR", short: "RR", agg: 0.90 }, { id: "PBKS", short: "PBKS", agg: 1.10 }, { id: "GT", short: "GT", agg: 1.0 },
  { id: "LSG", short: "LSG", agg: 1.03 },
];

// Realistic squad allocation: snake-draft by rating but respect the auction's
// real constraints — ≤8 overseas per squad and ≥2 keepers — so XI legality
// reflects what the actual auction produces, not a degenerate draft.
function draftSquads() {
  const teams = TEAMS.map((t) => ({ ...t, squad: [] }));
  const pool = [...PLAYERS].sort((a, b) => b.rating - a.rating);
  const SIZE = 18, OS_MAX = 8, WK_MIN = 2;
  const osCount = (t) => t.squad.filter((p) => p.overseas).length;
  const wkCount = (t) => t.squad.filter((p) => p.wk).length;

  // Distribute keepers round-robin first so every team has 2 (mirrors how the
  // real auction guarantees keeper depth), then snake-draft the rest.
  const allKeepers = pool.filter((p) => p.wk);
  let ki = 0;
  for (let pass = 0; pass < WK_MIN; pass++)
    for (const t of teams) { if (ki < allKeepers.length) t.squad.push(allKeepers[ki++]); }
  const taken = new Set(teams.flatMap((t) => t.squad));

  let dir = 1, idx = 0;
  const advance = () => {
    idx += dir;
    if (idx === teams.length) { idx = teams.length - 1; dir = -1; }
    else if (idx < 0) { idx = 0; dir = 1; }
  };
  for (const p of pool) {
    if (taken.has(p)) continue;
    // Find a team that can legally take this player, starting from the snake cursor.
    for (let tries = 0; tries < teams.length; tries++) {
      const t = teams[idx];
      const ok = t.squad.length < SIZE &&
        (!p.overseas || osCount(t) < OS_MAX);
      if (ok) { t.squad.push(p); advance(); break; }
      advance();
    }
  }
  return teams;
}

const teams = draftSquads();
teams.forEach((t) => { t.xi = pickXI(t.squad); });

// ── 1. XI legality check ──
console.log("=== XI legality (overseas ≤ 4, ≥5 bowling options, 1 keeper) ===");
for (const t of teams) {
  const os = t.xi.filter((p) => p.overseas).length;
  const bowl = t.xi.filter((p) => p.role === "Bowler" || p.role === "All-rounder").length;
  const wk = t.xi.filter((p) => p.wk).length;
  const flag = (os <= 4 && bowl >= 5 && wk >= 1) ? "ok" : "‼";
  console.log(`${t.id.padEnd(4)} OS=${os} bowl=${bowl} wk=${wk} ${flag}  XI: ${battingOrder(t.xi).map((p) => p.name.split(" ").pop()).join(", ")}`);
}

// ── 2. Score distribution over many matches ──
console.log("\n=== score distribution (400 random matches) ===");
let totals = [], wktsArr = [], chaseWins = 0, n = 0;
for (let i = 0; i < 400; i++) {
  const a = teams[Math.floor(Math.random() * 10)];
  let b = teams[Math.floor(Math.random() * 10)];
  while (b.id === a.id) b = teams[Math.floor(Math.random() * 10)];
  const m = simulateMatch(a, b);
  for (const inn of m.innings) { totals.push(inn.total); wktsArr.push(inn.wkts); }
  if (m.winner === m.secondId) chaseWins++;
  n++;
}
const avg = (a) => (a.reduce((s, x) => s + x, 0) / a.length);
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length * p)]; };
console.log(`innings total: avg=${avg(totals).toFixed(1)}  p10=${pct(totals,0.1)}  p50=${pct(totals,0.5)}  p90=${pct(totals,0.9)}  min=${Math.min(...totals)}  max=${Math.max(...totals)}`);
console.log(`wickets/inns: avg=${avg(wktsArr).toFixed(1)}`);
console.log(`chase win %: ${(chaseWins / n * 100).toFixed(0)}% (should be ~50-55, slight chase edge)`);

// ── 3. Does the stronger squad win more? ──
console.log("\n=== strength vs win-rate ===");
const sorted = [...teams].sort((a, b) => avgRating(b) - avgRating(a));
const strong = sorted[0], weak = sorted[9];
let sw = 0;
for (let i = 0; i < 300; i++) if (simulateMatch(strong, weak).winner === strong.id) sw++;
console.log(`best vs worst drafted: ${strong.id} (avgR ${avgRating(strong).toFixed(1)}) vs ${weak.id} (avgR ${avgRating(weak).toFixed(1)}): ${strong.id} win ${(sw/300*100).toFixed(0)}%`);
// Deliberate mismatch: hand-built elite XI vs a weak XI to confirm rating bites.
const eliteSquad = [...PLAYERS].sort((a, b) => b.rating - a.rating).slice(0, 13);
const weakSquad  = [...PLAYERS].filter((p) => !eliteSquad.includes(p)).sort((a, b) => a.rating - b.rating).slice(0, 13);
const elite = { id: "ELITE", short: "ELI", xi: pickXI(eliteSquad) };
const scrub = { id: "SCRUB", short: "SCR", xi: pickXI(weakSquad) };
let ew = 0;
for (let i = 0; i < 300; i++) if (simulateMatch(elite, scrub).winner === "ELITE") ew++;
console.log(`elite XI (avgR ${avgRating(elite).toFixed(1)}) vs scrub XI (avgR ${avgRating(scrub).toFixed(1)}): elite win ${(ew/300*100).toFixed(0)}% (want ~75-88%)`);
function avgRating(t) { return t.xi.reduce((s, p) => s + p.rating, 0) / t.xi.length; }

// ── 4. Sample scorecard ──
console.log("\n=== sample match ===");
const sample = simulateMatch(teams[0], teams[1]);
console.log(sample.resultText);
for (const inn of sample.innings) {
  const { topBat, topBowl } = innViews(inn);
  console.log(`  ${inn.teamShort}: ${inn.total}/${inn.wkts} (${inn.overs})  top bat: ${topBat?.p.name} ${topBat?.runs}(${topBat?.balls})  top bowl: ${topBowl?.p.name} ${topBowl?.wkts}/${topBowl?.runs}`);
}

// ── 5. Bowling figures sanity (no bowler exceeds 4 overs / absurd runs) ──
console.log("\n=== bowling figures sanity (300 matches, legal XIs) ===");
let maxOvers = 0, maxRuns = 0, illegal = 0;
for (let i = 0; i < 300; i++) {
  const a = teams[i % 10], b = teams[(i + 3) % 10];
  const m = simulateMatch(a, b);
  for (const inn of m.innings) for (const bw of inn.bowling) {
    const ov = bw.balls / 6;
    maxOvers = Math.max(maxOvers, ov);
    maxRuns = Math.max(maxRuns, bw.runs);
    if (ov > 4.01) illegal++;
  }
}
console.log(`max overs by any bowler: ${maxOvers.toFixed(1)} (must be ≤4.0)`);
console.log(`max runs conceded by any bowler: ${maxRuns} (T20 sane ≤ ~60)`);
console.log(`illegal >4-over spells: ${illegal} (must be 0 for legal XIs)`);
