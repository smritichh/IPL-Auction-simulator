// ============================================================================
// MATCH DIAGNOSTICS — turn a simulated match into a plain-English "what went
// wrong" read for the user's team. Pure: depends only on the object that
// simulateMatch() returns (innings[].batting / bowling / timeline + winner),
// plus the home/away ids that playRound() attaches.
// ============================================================================

const lastName = (n) => n.split(" ").pop();

// Per-phase runs/wickets/balls for one innings, read off its over timeline.
function phaseSplit(inn) {
  const z = () => ({ runs: 0, wkts: 0, balls: 0 });
  const out = { pp: z(), mid: z(), death: z() };
  for (const ov of inn.timeline) {
    const ph = out[ov.phase] || out.mid;
    ph.runs += ov.runs;
    ph.wkts += ov.wkts;
    ph.balls += ov.balls ? ov.balls.length : 6;
  }
  return out;
}

const oversOf = (balls) => Math.max(1, Math.round(balls / 6));

// Returns null if the user wasn't in this match; otherwise a structured read.
// `lost` flags whether it's a loss (callers typically only surface losses).
export function analyzeMatch(match, userTeamId) {
  const inUser = match.home === userTeamId || match.away === userTeamId;
  if (!inUser) return null;

  const batInn  = match.innings.find((i) => i.teamId === userTeamId);
  const bowlInn = match.innings.find((i) => i.teamId !== userTeamId);
  if (!batInn || !bowlInn) return null;

  const lost   = match.winner !== userTeamId;
  const chased = batInn.teamId === match.secondId;   // user batted second
  const bat  = phaseSplit(batInn);
  const bowl = phaseSplit(bowlInn);

  const factors = [];   // { sev, label, detail }
  const add = (sev, label, detail) => factors.push({ sev, label, detail });

  // ── Batting failings ──
  const order   = batInn.batting.filter((b) => b.balls > 0 || b.out);
  const top3    = order.slice(0, 3);
  const top3Runs = top3.reduce((s, b) => s + b.runs, 0);
  const top3Out  = top3.filter((b) => b.out).length;
  if (top3Out >= 2 && top3Runs < 50)
    add(1.4 + (50 - top3Runs) / 40, "Top-order collapse",
      `Your top three managed just ${top3Runs} between them.`);

  if (bat.pp.wkts >= 3)
    add(1.3 + bat.pp.wkts * 0.15, "Powerplay wreck",
      `Lost ${bat.pp.wkts} wickets inside the powerplay for ${bat.pp.runs}.`);

  // Under-powered death — only meaningful batting first with wickets in hand.
  if (!chased && bat.death.balls >= 18 && bat.death.runs < 50 && batInn.wkts < 9)
    add(1.1 + (50 - bat.death.runs) / 50, "No death surge",
      `Only ${bat.death.runs} off the last ${oversOf(bat.death.balls)} overs with wickets in hand.`);

  // A star with the bat who failed.
  const starFail = batInn.batting
    .filter((b) => b.p.rating >= 80 && (b.out || b.balls >= 6) && b.runs < 16)
    .sort((a, b) => a.runs - b.runs)[0];
  if (starFail)
    add(1.15, "Star let-down",
      `${lastName(starFail.p.name)} (rated ${starFail.p.rating}) fell for ${starFail.runs}(${starFail.balls}).`);

  // ── Bowling / defending failings ──
  if (bowl.death.balls >= 18 && bowl.death.runs >= 55)
    add(1.2 + (bowl.death.runs - 55) / 30, "Death bowling leaked",
      `Conceded ${bowl.death.runs} in the final ${oversOf(bowl.death.balls)} overs.`);

  if (bowl.pp.wkts === 0 && bowl.pp.runs >= 55)
    add(1.0, "No early breakthroughs",
      `They raced to ${bowl.pp.runs}/0 through the powerplay.`);

  // A bowler who got carted (≥2 overs, ≥11 an over).
  const leaked = bowlInn.bowling
    .filter((b) => b.balls >= 12)
    .map((b) => ({ b, econ: (b.runs / b.balls) * 6 }))
    .sort((a, b) => b.econ - a.econ)[0];
  if (leaked && leaked.econ >= 11)
    add(0.9, "Got carted",
      `${lastName(leaked.b.p.name)} went for ${leaked.b.runs} off ${oversOf(leaked.b.balls)} (${leaked.econ.toFixed(1)}/over).`);

  // ── Headline + one-line context ──
  factors.sort((a, b) => b.sev - a.sev);
  const headline = factors[0] ? factors[0].label : (lost ? "Came up short" : "Match won");

  let context;
  if (batInn.total === bowlInn.total) {
    // Scores level — the match (and this loss) was decided by the Super Over.
    context = `Scores finished level on ${batInn.total} — you lost the Super Over.`;
  } else if (chased) {
    const shortBy = bowlInn.total - batInn.total;   // target-1 minus what you made
    context = `Chasing ${bowlInn.total}, you reached ${batInn.total}/${batInn.wkts} — ${shortBy} run${shortBy === 1 ? "" : "s"} short.`;
  } else {
    context = `You posted ${batInn.total}/${batInn.wkts}, and ${bowlInn.teamShort} chased it down.`;
  }

  return {
    lost,
    chased,
    headline,
    context,
    factors: factors.slice(0, 3),
    bat,
    bowl,
    batLine:  `${batInn.total}/${batInn.wkts}`,
    bowlLine: `${bowlInn.total}/${bowlInn.wkts}`,
  };
}
