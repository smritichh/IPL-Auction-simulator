// ============================================================================
// SEASON LOGIC — schedule generation + points table + NRR. Pure, no React.
// ============================================================================

// 14-game schedule for 10 teams via the circle method: a single round-robin
// (9 rounds, everyone plays everyone once) plus the reversed fixtures of the
// first 5 rounds (home/away flipped) → each team plays exactly 14, mirroring
// the real IPL "play all once, play 5 of them twice" structure.
export function makeSchedule(ids) {
  const list = [...ids];
  const rounds = [];
  for (let r = 0; r < ids.length - 1; r++) {
    const round = [];
    for (let i = 0; i < list.length / 2; i++)
      round.push({ home: list[i], away: list[list.length - 1 - i] });
    rounds.push(round);
    list.splice(1, 0, list.pop());            // rotate, keeping list[0] fixed
  }
  const extra = rounds.slice(0, 5).map((rd) => rd.map((m) => ({ home: m.away, away: m.home })));
  return [...rounds, ...extra];               // 9 + 5 = 14 rounds
}

export function emptyTable(ids) {
  const t = {};
  for (const id of ids) t[id] = { id, P: 0, W: 0, L: 0, pts: 0, rf: 0, of: 0, ra: 0, oa: 0 };
  return t;
}

// Fold one finished match into the table (W/L points + NRR running totals).
export function applyResult(table, match) {
  const a = match.nrr[match.firstId], b = match.nrr[match.secondId];
  const upd = (id, nr, won) => {
    const row = table[id];
    row.P += 1; row.pts += won ? 2 : 0; won ? (row.W += 1) : (row.L += 1);
    row.rf += nr.for; row.of += nr.forOv;     // forOv is already decimal overs
    row.ra += nr.ag;  row.oa += nr.agOv;
  };
  upd(match.firstId,  a, match.winner === match.firstId);
  upd(match.secondId, b, match.winner === match.secondId);
}

export const nrrOf = (row) =>
  (row.of > 0 ? row.rf / row.of : 0) - (row.oa > 0 ? row.ra / row.oa : 0);

// Standings: points first, then net run rate (standard IPL tie-break).
export function standings(table) {
  return Object.values(table).sort((x, y) => y.pts - x.pts || nrrOf(y) - nrrOf(x));
}
