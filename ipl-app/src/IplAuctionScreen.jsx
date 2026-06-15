import React, { useState, useEffect, useRef } from "react";
import { Gavel, ChevronRight } from "lucide-react";
import { PLAYERS } from "./players";
import { pickXI, battingOrder, simulateMatch, innViews, oversFromBalls } from "./matchEngine";
import { makeSchedule, emptyTable, applyResult, standings, nrrOf } from "./season";

const OPEN_TIMER = 7;
const BID_TIMER  = 4.5;
const TICK       = 0.3;
const P_AI       = 0.5;

// `jump` = how often the franchise jump-bids to scare rivals off (personality).
// RCB/PBKS are theatrical aggressors, DC/RR slow-play, the rest sit between.
const TEAMS = [
  { id: "MI",   name: "Mumbai Indians",              short: "MI",   color: "#1B6FCB", text: "#fff",    agg: 1.0,  jump: 0.30 },
  { id: "CSK",  name: "Chennai Super Kings",         short: "CSK",  color: "#F4C430", text: "#10131C", agg: 1.0,  jump: 0.25 },
  { id: "RCB",  name: "Royal Challengers Bengaluru", short: "RCB",  color: "#C8102E", text: "#fff",    agg: 1.12, jump: 0.52 },
  { id: "KKR",  name: "Kolkata Knight Riders",       short: "KKR",  color: "#6A4C93", text: "#fff",    agg: 0.98, jump: 0.35 },
  { id: "DC",   name: "Delhi Capitals",              short: "DC",   color: "#2E5EAA", text: "#fff",    agg: 0.92, jump: 0.16 },
  { id: "SRH",  name: "Sunrisers Hyderabad",         short: "SRH",  color: "#FF7A1A", text: "#10131C", agg: 1.08, jump: 0.42 },
  { id: "RR",   name: "Rajasthan Royals",            short: "RR",   color: "#E6308A", text: "#fff",    agg: 0.90, jump: 0.16 },
  { id: "PBKS", name: "Punjab Kings",                short: "PBKS", color: "#D31329", text: "#fff",    agg: 1.10, jump: 0.48 },
  { id: "GT",   name: "Gujarat Titans",              short: "GT",   color: "#C2A05A", text: "#10131C", agg: 1.0,  jump: 0.28 },
  { id: "LSG",  name: "Lucknow Super Giants",        short: "LSG",  color: "#1FA2C4", text: "#10131C", agg: 1.03, jump: 0.33 },
];

// Pacing variance: marquee lots are slow theater, accelerated lots move fast.
const openTimer = (p) => ({ Marquee: 10, Star: 8, Established: 7, Emerging: 6, Uncapped: 5 }[p.tier] ?? 7);
const bidTimer  = (p) => (p.tier === "Marquee" ? 5.5 : BID_TIMER);

// Human-readable labels for blueprint slots (need chips + storylines).
const CAT_LABEL = {
  topBat: "top-order bats", midBat: "middle order", finisher: "finishers", wk: "keepers",
  pace: "pace", spin: "spin", deathBowl: "death overs", powerplay: "powerplay bowling",
  allrounder: "all-rounders",
};

// PLAYERS (~190 real IPL players, 5-tier system) is imported from ./players

// ============================================================================
// SQUAD-BUILDING AUCTION ENGINE
// Every team (not just the user) builds a balanced 18-22 squad by valuing each
// player by MARGINAL NEED, not raw rating. A player who fills an unmet slot
// (e.g. a death bowler when you have none) is worth far more to you than a
// redundant one (a second death bowler when you already own Bumrah). Budget
// pacing (avgPerSlot discipline + late-auction urgency) stops teams blowing
// their purse on 5 marquees and guarantees a full squad. Tuned in data/sim_test.mjs.
// ============================================================================
const SQUAD_TARGET = 21;   // each team aims for ~21 (lands 18-21 after competition)
const SQUAD_MIN    = 18;   // below this late in the auction → desperation bidding
const MAX_SQUAD    = 25;
const OVERSEAS_MAX = 8;    // only 8 overseas players allowed per squad
const FLOOR        = 0.4;  // ₹ reserved per still-unfilled slot

// Squad blueprint: how many of each playing "slot" a balanced squad wants.
// A player can fill several slots at once (e.g. a pace death-bowler = pace +
// deathBowl), and contributes to whichever has the biggest unmet need.
const CAT_TARGET = { topBat:3, midBat:3, finisher:2, wk:2, pace:4, spin:3, deathBowl:2, powerplay:3, allrounder:3 };

// Which blueprint slots does this player fill? (derived from real-stat archetypes)
function playerCats(p) {
  const c = [];
  if (p.batOrder === "top") c.push("topBat");
  else if (p.batOrder === "mid") c.push("midBat");
  if (p.finisher) c.push("finisher");
  if (p.wk) c.push("wk");
  if (p.bowlType === "pace") c.push("pace");
  if (p.bowlType === "spin") c.push("spin");
  if (p.deathSpec) c.push("deathBowl");
  if (p.bowlType && (p.bowlPhase === "pp" || p.bowlPhase === "mid")) c.push("powerplay");
  if (p.role === "All-rounder") c.push("allrounder");
  return c;
}
function squadCatCounts(squad) {
  const c = {};
  for (const s of squad) for (const k of playerCats(s)) c[k] = (c[k] || 0) + 1;
  return c;
}
const overseasCount = (squad) => squad.filter((s) => s.overseas).length;

// Marginal need 0.3 .. ~1.6 — how badly THIS team wants THIS player right now.
// Drops sharply once the slots a player fills are already covered (so a 2nd
// Bumrah-type death bowler is cheap to this team but a death-bowler-less team
// still values him highly). `bias` is the team's randomised strategy lean.
function needMult(p, squad, bias) {
  const counts = squadCatCounts(squad);
  let def = playerCats(p).map((k) => {
    const t = CAT_TARGET[k] || 2, have = counts[k] || 0;
    return Math.max(0, (t - have) / t) * (bias?.[k] ?? 1);
  });
  if (!def.length) def = [0.25];
  def.sort((a, b) => b - a);
  const d = Math.min(1.3, def[0] + (def[1] || 0) * 0.35);
  return 0.3 + d * 1.0;
}
const ratingMult = (p) => 0.6 + Math.max(0, Math.min(50, (p.rating || 60) - 45)) / 50 * 2.4; // 0.6..3.0

// Max price `team` will pay for player `p` right now. `v` = team's (noised)
// market value, `lotsLeft` = lots still to come, `activeNeeders` = teams still
// short of a full squad (for competition-aware urgency).
function valuation(team, p, v, lotsLeft, activeNeeders) {
  const n = team.squad.length;
  if (n >= MAX_SQUAD) return 0;
  if (p.overseas && overseasCount(team.squad) >= OVERSEAS_MAX) return 0;
  const slotsNeeded = Math.max(0, SQUAD_TARGET - n);
  // Hoarding falloff: once at/above target, willingness collapses so trailing
  // teams catch up and nobody runs away to 24-25 players.
  const glut = n >= 23 ? 0.12 : n >= SQUAD_TARGET ? 0.4 : 1;
  const effSlots = Math.max(1, slotsNeeded);
  // Floor scales down when the team is already broke — don't reserve more than
  // half of purse-per-slot so a low-budget desperate team can still win cheap lots.
  const effectiveFloor = Math.min(FLOOR, (team.purse / effSlots) * 0.5);
  const reserveOthers = Math.max(0, effSlots - 1) * effectiveFloor;
  const maxAfford = Math.max(0, team.purse - reserveOthers);
  if (maxAfford <= 0) return 0;
  const avgPerSlot = team.purse / effSlots;
  const nm = needMult(p, team.squad, team.bias);
  // Hard keeper guarantee: a team with NO wicketkeeper treats any keeper as a
  // must-buy (there are cheap ones in the pool), so no squad ever ends the
  // auction unable to field a legal XI. Bids strongly, never beyond its purse.
  if (p.wk && !team.squad.some((s) => s.wk)) {
    const want = Math.max(p.base + 0.5, v * nm * 2, avgPerSlot * 1.2);
    return Math.min(want, team.purse);
  }
  // Competition-aware urgency.
  const myShare = lotsLeft / Math.max(1, activeNeeders);
  const pressure = slotsNeeded / Math.max(0.5, myShare);
  const minDeficit = Math.max(0, SQUAD_MIN - n);
  const desperation = minDeficit > 0 ? minDeficit * 0.18 / Math.max(0.4, myShare) : 0;
  // Critical boost: fires ONLY when a team is genuinely broke-per-slot AND below
  // SQUAD_MIN. Guards against the scenario where a user blows budget on 8 stars
  // then loses every ₹0.3 Cr filler to glut teams that have more per-slot money.
  // Does NOT fire at auction start (purse/slot = 120/21 = 5.7 Cr → well above 2.0).
  const brokeAndNeedy = avgPerSlot < 2.0 && minDeficit > 3;
  const criticalBoost = brokeAndNeedy
    ? Math.min(2.0, ((2.0 - avgPerSlot) / 2.0) * 3.0 * Math.min(1, minDeficit / 5))
    : 0;
  const urgency = 1 + Math.max(0, pressure - 1.0) * 1.2 + desperation + criticalBoost;
  const desire = Math.max(p.base, v * nm);
  const disciplineCap = avgPerSlot * ratingMult(p) * urgency;
  // Urgency lifts the willingness floor toward the discipline cap, so a
  // low-aggression / broke team still competes for fillers.
  const floorWill = Math.max(0, urgency - 1) * disciplineCap;
  return Math.min(Math.max(desire, floorWill), disciplineCap, maxAfford, team.purse) * glut;
}

// Per-team randomised strategy lean (regenerated every game → squads differ
// run-to-run). Some teams favour spin, some pace-heavy, some top-order, etc.
function makeBias() {
  const b = {};
  for (const k of Object.keys(CAT_TARGET)) b[k] = 0.8 + Math.random() * 0.5; // 0.8..1.3
  return b;
}

const cr        = (v) => `₹${Number(v).toFixed(2)} Cr`;
const inc       = (p) => (p < 5 ? 0.5 : p < 12 ? 1.0 : 2.0);
const round2    = (v) => Math.round(v * 100) / 100;
const initials  = (n) => n.split(" ").map((w) => w[0]).slice(0, 2).join("");
const roleColor = (r) => ({ WK: "#C8851A", Batter: "#2E86C8", "All-rounder": "#3E9E54", Bowler: "#D04A4A" }[r] ?? "#677087");
const roleShort = (r) => ({ WK: "WK", Batter: "BAT", "All-rounder": "AR", Bowler: "BWL" }[r] ?? r);
// Batting position auto-sort: WK→openers, Batters, ARs, Bowlers
const ROLE_ORDER = { WK: 0, Batter: 1, "All-rounder": 2, Bowler: 3 };
// IPL official tier labels: Marquee / Capped / Uncapped
const tierLabel = (t) => t === "Marquee" ? "MARQUEE" : (t === "Star" || t === "Established") ? "CAPPED" : "UNCAPPED";

// Build a fresh per-team market-value table for every player. Called ONCE PER
// GAME (not once per session) so each new auction has different "hot teams" and
// price noise — otherwise the same franchises chase the same stars every replay
// and squads come out near-identical.
function buildVals() {
  return PLAYERS.map((p) => {
    const row = {};
    // Lower tiers have wider price uncertainty (less of a known quantity),
    // so AI valuations spread further from market value.
    const noise = {
      Marquee:     0.26,
      Star:        0.32,
      Established:  0.38,
      Emerging:    0.46,
      Uncapped:    0.55,
    }[p.tier] ?? 0.40;

    // 2 random rival teams are "hot" on this player — they have elevated
    // demand (franchise philosophy, squad need, fandom, etc.) and will chase
    // above market price. Primary driver of competitive bidding; re-rolled each
    // game so you never face the same demand map twice.
    const shuffled = [...TEAMS].sort(() => Math.random() - 0.5);
    const hotSet   = new Set(shuffled.slice(0, 2).map((t) => t.id));

    TEAMS.forEach((t) => {
      const hunger = hotSet.has(t.id) ? (1.2 + Math.random() * 0.15) : 1.0;
      row[t.id] = round2(p.mv * t.agg * hunger * (1 + (Math.random() * 2 - 1) * noise));
    });
    return row;
  });
}

export default function IplAuctionScreen() {
  // Re-randomised each game (see startNewGame). A ref, not memo/state, because
  // it's read only inside tick()/sim loops and never needs to trigger a render.
  const valsRef = useRef(null);
  if (valsRef.current === null) valsRef.current = buildVals();
  const vals = valsRef.current;

  // How many teams still need players (drives competition-aware urgency).
  const needersCount = (g) => g.teams.filter((t) => t.squad.length < SQUAD_TARGET).length;

  // The auction runs over g.order — an array of PLAYERS indices. Normally
  // 0..N-1, but the unsold re-auction round appends indices at the end, so
  // lots must always be addressed via the order array, never PLAYERS[g.index].
  const lotPlayer = (g, i = g.index) => PLAYERS[g.order[i]];

  // Max price a rival will pay for the current lot, given live game state.
  const walkaway = (team, lotIdx, g) => {
    const pIdx          = g.order[lotIdx];
    const lotsLeft      = g.order.length - lotIdx;
    const activeNeeders = needersCount(g);
    return valuation(team, PLAYERS[pIdx], vals[pIdx][team.id], lotsLeft, activeNeeders);
  };

  const initGame = (teamId = "MI") => ({
    userTeamId:  teamId,
    phase:       "bidding",                         // auction starts immediately on lot 1
    order:       PLAYERS.map((_, i) => i),          // lot sequence (player indices)
    unsold:      [],                                // player indices passed in by all 10 teams
    reauctioned: false,                             // unsold round runs once
    watch:       new Set(),                         // starred player names (fast-forward stops here)
    index:       0,
    asking:      PLAYERS[0].base,
    bid:         null,
    leader:      null,
    timer:       openTimer(PLAYERS[0]),
    tmax:        openTimer(PLAYERS[0]),
    userPassed:  false,
    teams:       TEAMS.map((t) => ({ ...t, isUser: t.id === teamId, purse: 120, squad: [], bias: makeBias() })),
    ticker:      [{ id: "sys", text: `On the block — ${PLAYERS[0].name}` }, { id: "sys", kind: "set", text: PLAYERS[0].set }],
    soldLog:     [],
    lastSold:    null,
    recentBid:   {},
  });

  const [game, setGame]       = useState(() => initGame("MI"));
  const [started, setStarted] = useState(false); // false = show team picker
  const [squadView, setSquadView] = useState(null); // teamId whose squad modal is open

  // apConfirmRef lets tick() read the latest confirm state without
  // needing to be in its dependency array (avoids restarting the interval).
  const apConfirmRef = useRef(false);

  const resolve = (g) => {
    const p = lotPlayer(g);
    if (g.leader) {
      const price = g.bid;
      const won   = TEAMS.find((t) => t.id === g.leader);
      const teams = g.teams.map((t) =>
        t.id === g.leader
          ? { ...t, purse: round2(t.purse - price), squad: [...t.squad, { ...p, price }] }
          : t
      );
      const entry = { player: p, teamId: g.leader, teamColor: won.color, teamShort: won.short, price };
      return {
        ...g, phase: "sold", teams,
        soldLog:  [entry, ...g.soldLog],
        lastSold: { player: p, teamId: g.leader, price, you: g.leader === g.userTeamId },
        ticker:   [{ id: g.leader, kind: "sold", text: `SOLD — ${p.name} → ${won.short} ${cr(price)}` }, ...g.ticker].slice(0, 14),
      };
    }
    return {
      ...g, phase: "sold",
      unsold:   [...g.unsold, g.order[g.index]],   // eligible for the re-auction round
      lastSold: { player: p, unsold: true },
      ticker:   [{ id: "sys", text: `UNSOLD — ${p.name}` }, ...g.ticker].slice(0, 14),
    };
  };

  const tick = (g) => {
    // Freeze the auction while the autopilot confirm dialog is open so
    // the user doesn't lose lots between clicking the button and confirming.
    if (g.phase !== "bidding" || apConfirmRef.current) return g;
    const p       = lotPlayer(g);
    // Rivals push back hard when YOU lead, so you can't snipe a player cheaply.
    const userLeading = g.leader === g.userTeamId;
    // When you're leading, rivals respond almost every tick (95%) —
    // you can't coast to a cheap win just by being the last bidder.
    const pAct = userLeading ? 0.95 : P_AI;
    if (Math.random() < pAct) {
      const cand    = g.teams.filter((t) => !t.isUser && t.id !== g.leader && t.squad.length < MAX_SQUAD && t.purse >= g.asking);
      const willing = cand.filter((t) => walkaway(t, g.index, g) >= g.asking);
      if (willing.length) {
        willing.sort((a, b) => walkaway(b, g.index, g) - walkaway(a, g.index, g));
        const top    = willing.slice(0, Math.min(3, willing.length));
        const actor  = top[Math.floor(Math.random() * top.length)];
        const wa      = walkaway(actor, g.index, g);
        // Jump bid: aggressive franchises (actor.jump) leap ahead to scare rivals off.
        let newBid = g.asking;
        if (Math.random() < actor.jump && wa >= g.asking + inc(g.asking) * 2) {
          newBid = round2(g.asking + inc(g.asking));
        }
        newBid = round2(Math.min(newBid, wa, actor.purse));
        return {
          ...g,
          leader:    actor.id,
          bid:       newBid,
          asking:    round2(newBid + inc(newBid)),
          timer:     bidTimer(p),
          tmax:      bidTimer(p),
          recentBid: { ...g.recentBid, [actor.id]: { amount: newBid, uid: Date.now() } },
          ticker:    [{ id: actor.id, kind: "bid", text: `${actor.short} bids ${cr(newBid)}` }, ...g.ticker].slice(0, 14),
        };
      }
    }
    const nt = round2(g.timer - TICK);
    if (nt > 0) return { ...g, timer: nt };
    return resolve(g);
  };

  useEffect(() => {
    if (!started) return;
    const id = setInterval(() => setGame((g) => tick(g)), TICK * 1000);
    return () => clearInterval(id);
  }, [started]);

  // Rival storyline derived from live engine state — surfaces the 10-team war
  // the user otherwise can't see. Pure templates, no LLM.
  const storyline = (teams) => {
    const cands = [];
    for (const t of teams) {
      const n = t.squad.length;
      if (n > 0 && n < SQUAD_MIN && t.purse / Math.max(1, SQUAD_TARGET - n) < 1.2)
        cands.push(`${t.id} squeezed — ${cr(t.purse)} left for ${SQUAD_TARGET - n} slots`);
      const cc = squadCatCounts(t.squad);
      for (const [k, target] of Object.entries(CAT_TARGET))
        if ((cc[k] || 0) >= target + 1) cands.push(`${t.id} stockpiling ${CAT_LABEL[k]}`);
    }
    const spender = [...teams].sort((a, b) => a.purse - b.purse)[0];
    if (120 - spender.purse > 40) cands.push(`${spender.id} biggest spenders so far — ${cr(round2(120 - spender.purse))} gone`);
    return cands.length ? cands[Math.floor(Math.random() * cands.length)] : null;
  };

  useEffect(() => {
    if (game.phase !== "sold") return;
    const id = setTimeout(() => {
      setGame((g) => {
        let order = g.order, unsold = g.unsold, reauctioned = g.reauctioned;
        const extra = [];
        const ni = g.index + 1;
        if (ni >= order.length) {
          // First pass done — bring unsold players back once (real IPL mechanic).
          if (unsold.length && !reauctioned) {
            order = [...order, ...unsold];
            extra.push({ id: "sys", kind: "set", text: `RE-AUCTION ROUND — ${unsold.length} unsold players return` });
            unsold = []; reauctioned = true;
          } else {
            return { ...g, phase: "pickxi" };
          }
        }
        const np = PLAYERS[order[ni]];
        // Chapter break when the auction moves to a new set.
        if (np.set !== lotPlayer(g).set)
          extra.push({ id: "sys", kind: "set", text: `${np.set}` });
        // Periodic rival storyline keeps the 10-team war visible.
        if (ni % 8 === 0) {
          const s = storyline(g.teams);
          if (s) extra.push({ id: "sys", kind: "story", text: s });
        }
        return {
          ...g,
          order, unsold, reauctioned,
          phase:      "bidding",
          index:      ni,
          asking:     np.base,
          bid:        null,
          leader:     null,
          timer:      openTimer(np),
          tmax:       openTimer(np),
          userPassed: false,
          recentBid:  {},
          lastSold:   null,
          ticker:     [{ id: "sys", text: `On the block — ${np.name}` }, ...extra, ...g.ticker].slice(0, 14),
        };
      });
    }, 2000);
    return () => clearTimeout(id);
  }, [game.phase]);

  const userBid = () =>
    setGame((g) => {
      if (g.phase !== "bidding" || g.leader === g.userTeamId || g.userPassed) return g;
      const me = g.teams.find((t) => t.isUser);
      if (me.purse < g.asking) return g;
      const newBid = g.asking;
      return {
        ...g,
        leader:    g.userTeamId,
        bid:       newBid,
        asking:    round2(newBid + inc(newBid)),
        timer:     bidTimer(lotPlayer(g)),
        tmax:      bidTimer(lotPlayer(g)),
        ticker:    [{ id: g.userTeamId, kind: "bid", text: `You bid ${cr(newBid)}` }, ...g.ticker].slice(0, 14),
      };
    });

  // Run the remaining AI bidding for a player instantly (no timers) and
  // return the final game state. Used so "I'm out" skips straight to the
  // SOLD result without showing the live countdown.
  const simulateRemainingBids = (g) => {
    let s = { ...g };
    for (let i = 0; i < 300; i++) {
      const cand    = s.teams.filter((t) => !t.isUser && t.id !== s.leader && t.squad.length < MAX_SQUAD && t.purse >= s.asking);
      const willing = cand.filter((t) => walkaway(t, s.index, s) >= s.asking);
      if (!willing.length) break;
      willing.sort((a, b) => walkaway(b, s.index, s) - walkaway(a, s.index, s));
      const top    = willing.slice(0, Math.min(3, willing.length));
      const actor  = top[Math.floor(Math.random() * top.length)];
      const wa      = walkaway(actor, s.index, s);
      let newBid    = s.asking;
      if (Math.random() < actor.jump * 0.6 && wa >= s.asking + inc(s.asking) * 2) {
        newBid = round2(s.asking + inc(s.asking));
      }
      newBid = round2(Math.min(newBid, wa, actor.purse));
      s = { ...s, leader: actor.id, bid: newBid, asking: round2(newBid + inc(newBid)) };
    }
    return s;
  };

  const skip = () => setGame((g) => {
    if (g.phase !== "bidding" || g.leader === g.userTeamId) return g;
    const finalState = simulateRemainingBids(g);
    return resolve(finalState);
  });

  // Core fast-sim: resolve lots [startIdx, endIdx) instantly with ALL 10 teams —
  // including the user's — bidding via the same squad-need valuation. Used by
  // both Autopilot (to the end) and fast-forward (to the next starred lot).
  const simulateLots = (g, startIdx, endIdx) => {
    let state = { ...g };
    for (let lotIdx = startIdx; lotIdx < endIdx; lotIdx++) {
      const pIdx          = state.order[lotIdx];
      const p             = PLAYERS[pIdx];
      const lotsLeft      = state.order.length - lotIdx;
      const activeNeeders = needersCount(state);

      let s = {
        ...state,
        phase: "bidding", index: lotIdx,
        asking: p.base, bid: null, leader: null,
        userPassed: false, recentBid: {}, lastSold: null,
      };

      const getWA = (t) => valuation(t, p, vals[pIdx][t.id], lotsLeft, activeNeeders);

      for (let i = 0; i < 400; i++) {
        const cand    = s.teams.filter((t) => t.id !== s.leader && t.squad.length < MAX_SQUAD && t.purse >= s.asking);
        const willing = cand.filter((t) => getWA(t) >= s.asking);
        if (!willing.length) break;
        willing.sort((a, b) => getWA(b) - getWA(a));
        const top    = willing.slice(0, Math.min(3, willing.length));
        const actor  = top[Math.floor(Math.random() * top.length)];
        const wa     = getWA(actor);
        let newBid   = s.asking;
        if (Math.random() < actor.jump * 0.6 && wa >= s.asking + inc(s.asking) * 2)
          newBid = round2(s.asking + inc(s.asking));
        newBid = round2(Math.min(newBid, wa, actor.purse));
        s = { ...s, leader: actor.id, bid: newBid, asking: round2(newBid + inc(newBid)) };
      }

      state = resolve(s);
    }
    return state;
  };

  // Autopilot: fast-sim to the end of the order, run the unsold re-auction
  // round if needed, then go to Pick XI.
  const simulateAllRemainingLots = (g) => {
    let state = { ...g };
    let startIdx = state.phase === "sold" ? state.index + 1 : state.index;
    for (let pass = 0; pass < 2; pass++) {
      state = simulateLots(state, startIdx, state.order.length);
      if (state.unsold.length && !state.reauctioned) {
        state = {
          ...state,
          order: [...state.order, ...state.unsold],
          ticker: [{ id: "sys", kind: "set", text: `RE-AUCTION ROUND — ${state.unsold.length} unsold players return` }, ...state.ticker].slice(0, 14),
          unsold: [], reauctioned: true,
        };
        startIdx = state.index + 1;
      } else break;
    }
    return { ...state, phase: "pickxi" };
  };

  // Index of the next starred lot strictly after the current one (-1 = none).
  const nextWatchedIdx = (g) => {
    for (let i = g.index + 1; i < g.order.length; i++)
      if (g.watch.has(PLAYERS[g.order[i]].name)) return i;
    return -1;
  };

  // Fast-forward: autopilot through lots you don't care about, hand control
  // back when the next starred player comes on the block.
  const fastForward = () => setGame((g) => {
    if (g.phase !== "bidding" && g.phase !== "sold") return g;
    const stop = nextWatchedIdx(g);
    if (stop < 0) return g;
    const startIdx = g.phase === "sold" ? g.index + 1 : g.index;
    const skipped  = stop - startIdx;
    let state = simulateLots(g, startIdx, stop);
    const np = PLAYERS[state.order[stop]];
    return {
      ...state,
      phase:      "bidding",
      index:      stop,
      asking:     np.base,
      bid:        null,
      leader:     null,
      timer:      openTimer(np),
      tmax:       openTimer(np),
      userPassed: false,
      recentBid:  {},
      lastSold:   null,
      ticker: [
        { id: "sys", text: `On the block — ${np.name}` },
        { id: "sys", kind: "story", text: `⏩ fast-forwarded ${skipped} lots to your starred player` },
        ...state.ticker,
      ].slice(0, 14),
    };
  });

  // Index of the first lot belonging to a set after the current one (-1 = current set is last).
  const nextSetIdx = (g) => {
    const curSet = PLAYERS[g.order[g.index]].set;
    for (let i = g.index + 1; i < g.order.length; i++)
      if (PLAYERS[g.order[i]].set !== curSet) return i;
    return -1;
  };

  // Skip the rest of the current set — the AI resolves every remaining lot in it
  // (your team still bids via the same engine) and hands control back at the
  // first lot of the next set. If this is the last set, finish the auction.
  const skipSet = () => setGame((g) => {
    if (g.phase !== "bidding" && g.phase !== "sold") return g;
    const startIdx = g.phase === "sold" ? g.index + 1 : g.index;
    const stop = nextSetIdx(g);
    if (stop < 0) {
      const state = simulateLots(g, startIdx, g.order.length);
      return simulateAllRemainingLots(state);
    }
    const state = simulateLots(g, startIdx, stop);
    const np = PLAYERS[state.order[stop]];
    return {
      ...state,
      phase: "bidding", index: stop,
      asking: np.base, bid: null, leader: null,
      timer: openTimer(np), tmax: openTimer(np),
      userPassed: false, recentBid: {}, lastSold: null,
      ticker: [
        { id: "sys", text: `On the block — ${np.name}` },
        { id: "sys", kind: "set", text: np.set },
        ...state.ticker,
      ].slice(0, 14),
    };
  });

  const [apConfirm, setApConfirm] = useState(false);

  // Keep the ref in sync so tick() can read it without closure staleness
  const showApConfirm = (v) => {
    apConfirmRef.current = v;
    setApConfirm(v);
  };

  const doAutopilot = () => {
    apConfirmRef.current = false;
    setApConfirm(false);
    setGame((g) => simulateAllRemainingLots(g));
  };

  const lockXI  = (xi) => setGame((g) => ({ ...g, phase: "season", xi }));
  // restart goes back to team picker
  const restart = () => { setStarted(false); showApConfirm(false); };

  const me         = game.teams.find((t) => t.isUser);
  const myTeamDef  = TEAMS.find((t) => t.id === game.userTeamId);
  const p          = PLAYERS[game.order[game.index]];
  // Which of MY unfilled blueprint slots does this lot fill? (need chip)
  const myCounts   = squadCatCounts(me.squad);
  const fillsNeeds = playerCats(p)
    .filter((k) => (myCounts[k] || 0) < (CAT_TARGET[k] || 2))
    .map((k) => ({ k, have: myCounts[k] || 0, target: CAT_TARGET[k] || 2 }));
  // Set chapter progress: lots in this set / position within it
  const setLots    = game.order.filter((i) => PLAYERS[i].set === p.set);
  const setPos     = game.order.slice(0, game.index + 1).filter((i) => PLAYERS[i].set === p.set).length;
  const ffStop     = (game.phase === "bidding" || game.phase === "sold") ? nextWatchedIdx(game) : -1;
  // Auctioneer beat: only when someone holds a live bid and the clock runs out
  const goingBeat  = game.phase === "bidding" && game.leader && game.timer <= 3
    ? (game.timer <= 1.5 ? "GOING TWICE…" : "GOING ONCE…") : null;
  const frac       = game.timer / game.tmax;
  const ringColor  = frac < 0.3 ? "#DC3A40" : game.leader === game.userTeamId ? "#12A06A" : "#B5800F";
  const leaderTeam = game.leader ? TEAMS.find((t) => t.id === game.leader) : null;
  const canAfford  = me.purse >= game.asking;
  const R = 40, C = 2 * Math.PI * R;

  return (
    <div className="auc">
      <style>{styles}</style>
      {!started && (
        <StartScreen onStart={(teamId) => {
          valsRef.current = buildVals();   // fresh demand map → different auction every game
          setGame(initGame(teamId));
          setStarted(true);
        }} />
      )}

      {/* ── HEADER ── */}
      <header className="hd">
        <div className="hd-brand">
          <div className="hd-icon"><Gavel size={18} strokeWidth={2.5} /></div>
          <div>
            <div className="hd-title">THE AUCTION</div>
            <div className="hd-sub">Live · 10 franchises</div>
          </div>
        </div>
        <div className="hd-stats">
          <div className="hd-stat">
            <div className="hd-stat-lbl">LOT</div>
            <div className="hd-stat-val">{game.index + 1} / {game.order.length}</div>
          </div>
          <div className="hd-stat hd-stat-gold">
            <div className="hd-stat-lbl">PURSE</div>
            <div className="hd-stat-val">{cr(me.purse)}</div>
          </div>
          <div className="hd-stat">
            <div className="hd-stat-lbl">PLAYERS WON</div>
            <div className="hd-stat-val">{me.squad.length}</div>
          </div>
        </div>
      </header>

      {/* ── BUDGET PACE WARNING ── */}
      {started && game.phase === "bidding" && (() => {
        const slotsLeft   = Math.max(0, SQUAD_TARGET - me.squad.length);
        const lotsLeft    = game.order.length - game.index;
        const pursePerSlot = slotsLeft > 0 ? me.purse / slotsLeft : 999;
        // Warn if purse-per-remaining-slot is below ₹1 Cr AND still more than 3 slots to fill
        const tooThin = slotsLeft >= 4 && pursePerSlot < 1.0;
        // Warn if already below SQUAD_MIN with fewer lots than slots needed
        const cantFill = me.squad.length < SQUAD_MIN && lotsLeft < slotsLeft * 1.5;
        if (!tooThin && !cantFill) return null;
        return (
          <div className="budget-warn">
            ⚠ {tooThin
              ? `₹${pursePerSlot.toFixed(1)} Cr/slot left — ${slotsLeft} spots still to fill. Consider skipping expensive lots.`
              : `Only ${lotsLeft} lots left but you need ${slotsLeft} more players — autopilot now to secure fillers.`
            }
          </div>
        );
      })()}

      {game.phase === "pickxi" ? (
        <PickXIScreen squad={me.squad} onLock={lockXI} teams={game.teams} userTeamId={game.userTeamId} />
      ) : game.phase === "season" ? (
        <SeasonScreen teams={game.teams} userTeamId={game.userTeamId} userXI={game.xi} onRestart={restart} />
      ) : game.phase === "done" ? (
        <Summary me={me} teams={game.teams} onRestart={restart} />
      ) : (
        <div className="body">

          {/* ── LEFT: YOUR SQUAD ── */}
          <div className="squad-panel">
            <div className="panel-title">YOUR SQUAD <span>{me.squad.length}</span></div>
            <div className="squad-list">
              {me.squad.length === 0
                ? <p className="empty-hint">Win a bid to start building your squad.</p>
                : me.squad.map((s, i) => (
                  <div key={i} className="squad-item">
                    <div className="squad-item-name">{s.name}</div>
                    <div className="squad-item-meta">
                      <span className="squad-role">{s.role}</span>
                      <span className="squad-price">{cr(s.price)}</span>
                    </div>
                  </div>
                ))
              }
            </div>
          </div>

          {/* ── CENTER ── */}
          <div className="center">

            {/* PLAYER STAGE */}
            <div className="stage">
              {/* Set chapter strip — where we are in the auction's story */}
              <div className="set-strip">
                <span className="set-strip-name">{p.set}</span>
                <span className="set-strip-pos">{setPos} of {setLots.length} in set</span>
              </div>

              <div className="stage-eyebrow">
                <span>LOT {String(game.index + 1).padStart(2, "0")} / {String(game.order.length).padStart(2, "0")}</span>
                <span className="tier-pill">{tierLabel(p.tier)}</span>
                {game.watch.has(p.name) && <span className="tier-pill star-pill">★ STARRED</span>}
              </div>

              <h1 className="stage-name">{p.name}</h1>

              <div className="stage-chips">
                <span className="chip">{p.role}</span>
                <span className="chip">{p.country}{p.overseas ? " · Overseas" : ""}</span>
                {p.role !== "Bowler" && p.batOrder && <span className="chip chip-arch">{{ top: "TOP ORDER", mid: "MIDDLE ORDER", lower: "LOWER ORDER" }[p.batOrder]}</span>}
                {p.bowlPhase && <span className="chip chip-arch">{{ pp: "POWERPLAY", mid: "MIDDLE OVERS", death: "DEATH OVERS" }[p.bowlPhase]}{p.bowlType ? ` · ${p.bowlType.toUpperCase()}` : ""}</span>}
                {p.finisher && <span className="chip chip-fin">FINISHER</span>}
              </div>

              {/* Real career stats from Cricsheet — bid like you know the player */}
              <div className="stat-strip">
                {p.role !== "Bowler" && p.stat?.sr != null && <div className="stat-cell"><span className="stat-val">{Math.round(p.stat.sr)}</span><span className="stat-lbl">STRIKE RATE</span></div>}
                {p.role !== "Bowler" && p.stat?.avg != null && <div className="stat-cell"><span className="stat-val">{p.stat.avg.toFixed(1)}</span><span className="stat-lbl">AVERAGE</span></div>}
                {p.bowlType && p.stat?.econ != null && <div className="stat-cell"><span className="stat-val">{p.stat.econ.toFixed(2)}</span><span className="stat-lbl">ECONOMY</span></div>}
                {p.bowlType && p.stat?.wkts != null && <div className="stat-cell"><span className="stat-val">{p.stat.wkts}</span><span className="stat-lbl">WICKETS</span></div>}
                <div className="stat-cell"><span className="stat-val stat-gold">{p.rating}</span><span className="stat-lbl">RATING</span></div>
              </div>

              {/* Squad-fit: does this lot fill one of YOUR unmet slots? */}
              {fillsNeeds.length > 0 ? (
                <div className="need-chip need-yes">
                  FILLS YOUR NEED: {fillsNeeds.slice(0, 2).map(({ k, have, target }) => `${CAT_LABEL[k]} (${have}/${target})`).join(" · ")}
                </div>
              ) : (
                <div className="need-chip need-no">Position covered — you're set here</div>
              )}

              <div className="stage-main">
                <div className="stage-left">
                  {/* Timer ring */}
                  <div className="ring-wrap">
                    <svg width="92" height="92" viewBox="0 0 92 92">
                      <circle cx="46" cy="46" r={R} stroke="rgba(20,30,50,.08)" strokeWidth="6" fill="none" />
                      <circle
                        cx="46" cy="46" r={R} stroke={ringColor} strokeWidth="6" fill="none"
                        strokeLinecap="round" strokeDasharray={C}
                        strokeDashoffset={C * (1 - frac)}
                        transform="rotate(-90 46 46)"
                        style={{ transition: "stroke-dashoffset .25s linear, stroke .3s" }}
                      />
                    </svg>
                    <div className="ring-inner">
                      <div className="ring-init">{initials(p.name)}</div>
                      <div className="ring-secs" style={{ color: ringColor }}>{game.timer.toFixed(1)}s</div>
                    </div>
                  </div>

                  {/* Bid info */}
                  <div className="bid-block">
                    <div className="bid-lbl">CURRENT BID</div>
                    <div key={game.bid ?? "open"} className="bid-num pop">
                      {game.bid ? cr(game.bid) : "— opening —"}
                    </div>
                    <div className="bid-leader">
                      {game.leader === game.userTeamId
                        ? <span className="lead-you" style={{ color: myTeamDef.color }}>● YOU'RE LEADING</span>
                        : leaderTeam
                          ? <span style={{ color: leaderTeam.color }}>● {leaderTeam.name} leading</span>
                          : <span className="lead-none">no bids yet</span>
                      }
                    </div>
                    {goingBeat && <div className="going-beat">{goingBeat}</div>}
                    <div className="bid-base">base price {cr(p.base)}</div>
                  </div>
                </div>

                {/* YOUR bidding pod — team identity + controls */}
                <div className="user-pod" style={{ borderColor: `${myTeamDef.color}55` }}>
                  <div className="user-pod-head">
                    <span className="user-pod-badge" style={{ background: myTeamDef.color, color: myTeamDef.text }}>
                      {myTeamDef.short}
                    </span>
                    <div>
                      <div className="user-pod-name">{myTeamDef.name}</div>
                      <div className="user-pod-purse">{cr(me.purse)} left</div>
                    </div>
                  </div>
                  <div className="controls">
                    {game.userPassed ? (
                      <div className="passed-tag">You're out of this bid</div>
                    ) : game.leader === game.userTeamId ? (
                      <div className="leading-tag" style={{ color: myTeamDef.color }}>✓ You're the top bid</div>
                    ) : (
                      <>
                        <button className="bid-btn" onClick={userBid} disabled={!canAfford}>
                          {canAfford ? `Bid ${cr(game.asking)}` : "Not enough purse"}
                        </button>
                        <button className="out-btn" onClick={skip}>Skip →</button>
                      </>
                    )}
                  </div>

                  {/* Skip the rest of this set — autopilot to the next set */}
                  {(game.phase === "bidding" || game.phase === "sold") && (
                    <button className="ff-btn" onClick={skipSet}>
                      ⏩ Skip rest of this set
                    </button>
                  )}

                  {/* Autopilot — let AI finish the auction for MI */}
                  <div className="ap-wrap">
                    {apConfirm ? (
                      <div className="ap-confirm">
                        <span className="ap-confirm-txt">AI fills your squad?</span>
                        <div className="ap-confirm-btns">
                          <button className="ap-yes" onClick={doAutopilot}>Yes, go →</button>
                          <button className="ap-no"  onClick={() => showApConfirm(false)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <button className="ap-btn" onClick={() => showApConfirm(true)}>
                        ⚡ Autopilot — fill my squad
                      </button>
                    )}
                  </div>
                </div>
              </div>

              {/* Sold/Unsold overlay */}
              {game.phase === "sold" && game.lastSold && (
                <div className="overlay">
                  <div className={`stamp slam ${game.lastSold.unsold ? "stamp-unsold" : game.lastSold.you ? "stamp-you" : "stamp-sold"}`}>
                    <Gavel size={20} strokeWidth={2.6} />
                    <span>{game.lastSold.unsold ? "UNSOLD" : game.lastSold.you ? "YOURS!" : "SOLD"}</span>
                  </div>
                  {!game.lastSold.unsold && (
                    <div className="stamp-sub">
                      <b>{game.lastSold.player.name}</b> → {TEAMS.find((t) => t.id === game.lastSold.teamId).name} · {cr(game.lastSold.price)}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* OTHER TEAMS GRID — 3 columns × 3 rows */}
            <div className="teams-section">
              <div className="section-label">OTHER TEAMS</div>
              <div className="teams-grid">
                {TEAMS.filter((t) => t.id !== game.userTeamId).map((td) => {
                  const ts      = game.teams.find((t) => t.id === td.id);
                  const leading = td.id === game.leader;
                  const bidInfo = game.recentBid?.[td.id];
                  return (
                    <div key={td.id} className="tc-wrap">
                      {/* Bid toast above card */}
                      {leading && bidInfo && (
                        <div key={bidInfo.uid} className="tc-toast" style={{ background: td.color, color: td.text, borderTopColor: td.color }}>
                          {cr(bidInfo.amount)}
                        </div>
                      )}
                      <div
                        className={`tc${leading ? " tc-lead" : ""}`}
                        style={{ ...(leading ? { borderColor: td.color, boxShadow: `0 0 0 1px ${td.color}, 0 4px 20px -6px ${td.color}99` } : undefined), cursor: "pointer" }}
                        onClick={() => setSquadView(td.id)}
                        title="Click to see squad"
                      >
                        <div className="tc-head">
                          <span className="tc-badge" style={{ background: td.color, color: td.text }}>{td.short}</span>
                          <div className="tc-info">
                            <div className="tc-name">{td.name}</div>
                            <div className="tc-sub">
                              <span className="tc-purse" style={leading ? { color: td.color } : undefined}>{cr(ts.purse)}</span>
                              <span className="tc-bought">{ts.squad.length} bought ▸</span>
                            </div>
                            <div className="tc-bar">
                              <div className="tc-bar-fill" style={{ width: `${(ts.purse / 120) * 100}%`, background: td.color }} />
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

          </div>
          {/* ── END CENTER ── */}

          {/* ── RIGHT: LIVE FEED + PLAYERS SOLD ── */}
          <div className="right-col">
            <div className="panel">
              <div className="panel-title">LIVE FEED</div>
              <div className="ticker">
                {game.ticker.map((line, i) => {
                  const tm = TEAMS.find((t) => t.id === line.id);
                  const kindCls = line.kind ? ` tick-${line.kind}` : "";
                  return (
                    <div key={i} className={`tick${i === 0 ? " tick-new" : ""}${kindCls}`}>
                      {line.kind !== "set" && <span className="tick-dot" style={{ background: tm ? tm.color : "#5b647a" }} />}
                      <span>{line.text}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="panel">
              <div className="panel-title">PLAYERS SOLD <span>{game.soldLog.length}</span></div>
              {game.soldLog.length === 0
                ? <p className="empty-hint">No sales yet.</p>
                : <div className="sold-list">
                    {game.soldLog.map((e, i) => (
                      <div key={i} className="sold-row">
                        <span className="sold-name">{e.player.name}</span>
                        <span className="sold-team" style={{ color: e.teamColor }}>{e.teamShort}</span>
                        <span className="sold-price">{cr(e.price)}</span>
                      </div>
                    ))}
                  </div>
              }
            </div>
          </div>

        </div>
      )}

      {/* ── SQUAD VIEW MODAL ── */}
      {squadView && (() => {
        const td = TEAMS.find((t) => t.id === squadView);
        const ts = game.teams.find((t) => t.id === squadView);
        const squad = ts ? [...ts.squad].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)) : [];
        return (
          <div className="modal-backdrop" onClick={() => setSquadView(null)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head" style={{ borderColor: td.color }}>
                <span className="tc-badge" style={{ background: td.color, color: td.text, fontSize: 13 }}>{td.short}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{td.name}</div>
                  <div style={{ fontSize: 12, color: "#677087" }}>{squad.length} players · {cr(ts.purse)} left</div>
                </div>
                <button className="modal-close" onClick={() => setSquadView(null)}>✕</button>
              </div>
              {squad.length === 0
                ? <p className="empty-hint" style={{ padding: "16px 20px" }}>No players acquired yet.</p>
                : <div className="modal-list">
                    {squad.map((s, i) => (
                      <div key={i} className="modal-row">
                        <span className="modal-role" style={{ color: roleColor(s.role) }}>{roleShort(s.role)}</span>
                        <span className="modal-name">{s.name}</span>
                        <span className="modal-country" style={{ color: s.overseas ? "#B5800F" : "#6B7488" }}>{s.country}{s.overseas ? " ✈" : ""}</span>
                        <span className="modal-price">{cr(s.price)}</span>
                      </div>
                    ))}
                  </div>
              }
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ── sub-components ── */

function StartScreen({ onStart }) {
  const [picked, setPicked] = React.useState(null);
  const team = picked ? TEAMS.find((t) => t.id === picked) : null;

  return (
    <div className="start-overlay">
      <div className="start-card start-card-wide">
        <div className="hd-icon big"><Gavel size={26} strokeWidth={2.4} /></div>
        <h2>The Auction</h2>
        <p>Pick your franchise — you get ₹120 Cr purse.<br />Nine AI rivals bid against you in real time.</p>

        {/* Team picker grid */}
        <div className="team-picker">
          {TEAMS.map((t) => (
            <button
              key={t.id}
              className={`tp-btn${picked === t.id ? " tp-sel" : ""}`}
              style={picked === t.id
                ? { background: t.color, color: t.text, borderColor: t.color, boxShadow: `0 0 0 3px ${t.color}55, 0 4px 16px -4px ${t.color}88` }
                : { borderColor: `${t.color}44`, color: t.color }
              }
              onClick={() => setPicked(t.id)}
            >
              <span className="tp-short">{t.short}</span>
            </button>
          ))}
        </div>

        {/* Selected team name */}
        <div className="tp-selected-name" style={{ color: team?.color ?? "#6B7488" }}>
          {team ? `Playing as ${team.name}` : "Choose a team above"}
        </div>

        <button
          className="bid-btn"
          onClick={() => picked && onStart(picked)}
          disabled={!picked}
          style={{ marginTop: 4, opacity: picked ? 1 : 0.4, cursor: picked ? "pointer" : "default" }}
        >
          Enter the auction <ChevronRight size={16} />
        </button>
        <span className="start-note">{PLAYERS.length} real IPL players · archetypes from Cricsheet ball-by-ball data.</span>
      </div>
    </div>
  );
}

/* ── Watchlist: star targets before the auction; ⏩ jumps between them ── */
function WatchlistScreen({ teamDef, onBegin }) {
  const [watch, setWatch] = useState(new Set());
  const [query, setQuery] = useState("");

  const toggle = (name) =>
    setWatch((w) => {
      const n = new Set(w);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });

  // Group players by auction set, preserving set order
  const sets = [];
  let cur = null;
  for (const p of PLAYERS) {
    if (!cur || cur.label !== p.set) { cur = { label: p.set, players: [] }; sets.push(cur); }
    cur.players.push(p);
  }
  const q = query.trim().toLowerCase();

  return (
    <div className="wl">
      <div className="wl-hd">
        <div>
          <div className="pxi-title">Star Your Targets</div>
          <div className="pxi-sub">
            Star the players you want to bid on live — during the auction, <b>⏩</b> autopilots
            everything in between (your team still builds its squad) and stops at your next star.
          </div>
        </div>
        <div className="wl-actions">
          <span className="wl-count" style={{ color: teamDef.color }}>★ {watch.size} starred</span>
          <button className="bid-btn" onClick={() => onBegin(watch)}>
            {watch.size ? "Begin auction →" : "Skip — watch every lot →"}
          </button>
        </div>
      </div>

      <input
        className="wl-search"
        placeholder="Search players…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />

      <div className="wl-body">
        {sets.map((s) => {
          const players = q ? s.players.filter((p) => p.name.toLowerCase().includes(q)) : s.players;
          if (!players.length) return null;
          return (
            <div key={s.label} className="wl-set">
              <div className="wl-set-label">{s.label}</div>
              <div className="wl-grid">
                {players.map((p) => {
                  const on = watch.has(p.name);
                  return (
                    <button
                      key={p.name}
                      className={`wl-card${on ? " wl-on" : ""}`}
                      style={on ? { borderColor: teamDef.color, boxShadow: `0 0 0 1px ${teamDef.color}66` } : undefined}
                      onClick={() => toggle(p.name)}
                    >
                      <span className="wl-star" style={{ color: on ? teamDef.color : "#3a4154" }}>★</span>
                      <span className="wl-name">{p.name}</span>
                      <span className="wl-meta">{roleShort(p.role)}{p.overseas ? " · OS" : ""} · ★{p.rating}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* ── Season: league stage → points table → (playoffs handled separately) ── */
const cloneTable = (t) => {
  const n = {};
  for (const k of Object.keys(t)) n[k] = { ...t[k] };
  return n;
};

function SeasonScreen({ teams, userTeamId, userXI, onRestart }) {
  const ids = teams.map((t) => t.id);
  const meta = (id) => TEAMS.find((t) => t.id === id);
  const squadOf = (id) => teams.find((t) => t.id === id).squad;

  // Each team's best XI (user's is the one they locked; AI auto-picks).
  const xis = useRef(null);
  if (!xis.current) {
    xis.current = {};
    for (const id of ids) xis.current[id] = id === userTeamId ? userXI : pickXI(squadOf(id));
  }
  const schedule = useRef(null);
  if (!schedule.current) schedule.current = makeSchedule(ids);

  // Pre-season projection (one fast Monte-Carlo run, cached for the whole season).
  const projection = useRef(null);
  if (!projection.current) {
    const strengths = {};
    for (const id of ids) strengths[id] = xiStrength(xis.current[id]);
    projection.current = projectSeason(ids, strengths, schedule.current, userTeamId, 2000);
  }

  const [day, setDay]         = useState(0);
  const [table, setTable]     = useState(() => emptyTable(ids));
  const [lastRound, setLast]  = useState(null);
  const [pstats, setPstats]   = useState({});   // name → {runs, wkts, team}
  const [view, setView]       = useState("league");  // league | playoffs

  const teamObj = (id) => ({ ...meta(id), squad: squadOf(id), xi: xis.current[id] });

  const playRound = (roundIdx, tbl, stats) => {
    const round = schedule.current[roundIdx];
    const res = round.map((fx) => {
      const m = simulateMatch(teamObj(fx.home), teamObj(fx.away));
      return { ...m, home: fx.home, away: fx.away };
    });
    res.forEach((m) => {
      applyResult(tbl, m);
      for (const inn of m.innings) {
        for (const b of inn.batting) if (b.runs > 0) { const s = stats[b.p.name] || (stats[b.p.name] = { runs: 0, wkts: 0, team: inn.teamId }); s.runs += b.runs; }
        for (const bw of inn.bowling) if (bw.wkts > 0) { const s = stats[bw.p.name] || (stats[bw.p.name] = { runs: 0, wkts: 0, team: m.innings.find((i) => i.teamId !== inn.teamId)?.teamId }); s.wkts += bw.wkts; }
      }
    });
    return res;
  };

  const advance = (toEnd) => {
    const tbl = cloneTable(table), stats = { ...pstats };
    let last = null;
    const end = toEnd ? schedule.current.length : day + 1;
    for (let r = day; r < end; r++) last = playRound(r, tbl, stats);
    setTable(tbl); setPstats(stats); setLast(last); setDay(end);
  };

  const table_ = standings(table);
  const top4 = table_.slice(0, 4).map((r) => r.id);
  const leagueDone = day >= schedule.current.length;

  // Orange/Purple cap leaders
  const orange = Object.entries(pstats).sort((a, b) => b[1].runs - a[1].runs)[0];
  const purple = Object.entries(pstats).sort((a, b) => b[1].wkts - a[1].wkts)[0];

  const userMatch = lastRound?.find((m) => m.home === userTeamId || m.away === userTeamId);

  const userPos = table_.findIndex((r) => r.id === userTeamId) + 1;
  const userQualified = top4.includes(userTeamId);

  if (view === "playoffs")
    return <PlayoffsScreen teams={teams} userTeamId={userTeamId} xis={xis.current}
      seeds={top4} teamObj={teamObj} onRestart={onRestart}
      projection={projection.current} pstats={pstats} userSquad={squadOf(userTeamId)} />;

  // Didn't make the top 4 → season ends here with the user's league finish.
  if (view === "finished")
    return <FinishScreen position={userPos} userTeamId={userTeamId} championId={null} onRestart={onRestart}
      projection={projection.current} pstats={pstats} squad={squadOf(userTeamId)} />;

  return (
    <div className="season">
      <div className="season-hd">
        <div>
          <div className="pxi-title">League Stage</div>
          <div className="pxi-sub">{leagueDone ? (userQualified ? `All 14 rounds done — you finished ${ordinal(userPos)} and made the top 4!` : `All 14 rounds done — you finished ${ordinal(userPos)}, outside the top 4`) : `Match day ${day + 1} of 14 · ${schedule.current.length - day} to play`}</div>
        </div>
        <div className="season-actions">
          {(orange || purple) && (
            <div className="cap-row">
              {orange && <span className="cap cap-orange">🟠 {orange[0].split(" ").pop()} {orange[1].runs}</span>}
              {purple && <span className="cap cap-purple">🟣 {purple[0].split(" ").pop()} {purple[1].wkts}w</span>}
            </div>
          )}
          {!leagueDone ? (
            <div style={{ display: "flex", gap: 8 }}>
              <button className="out-btn" onClick={() => advance(true)}>Sim rest →</button>
              <button className="bid-btn" onClick={() => advance(false)}>Next match day →</button>
            </div>
          ) : userQualified ? (
            <button className="bid-btn" onClick={() => setView("playoffs")}>Enter playoffs →</button>
          ) : (
            <button className="bid-btn" onClick={() => setView("finished")}>See your finish →</button>
          )}
        </div>
      </div>

      <div className="season-body">
        {/* LEFT — latest match day results */}
        <div className="season-results">
          <div className="panel-title">{lastRound ? `MATCH DAY ${day}` : "READY"}</div>
          {!lastRound ? (
            <p className="empty-hint">Play the first match day to begin your season.</p>
          ) : (
            <>
              {userMatch && <ResultCard m={userMatch} meta={meta} highlight userTeamId={userTeamId} />}
              <div className="other-results">
                {lastRound.filter((m) => m !== userMatch).map((m, i) => (
                  <ResultCard key={i} m={m} meta={meta} userTeamId={userTeamId} />
                ))}
              </div>
            </>
          )}
        </div>

        {/* RIGHT — points table */}
        <div className="ptable">
          <div className="panel-title">POINTS TABLE</div>
          <div className="pt-head">
            <span className="pt-pos">#</span><span className="pt-team">TEAM</span>
            <span>P</span><span>W</span><span>L</span><span className="pt-nrr">NRR</span><span className="pt-pts">PTS</span>
          </div>
          {table_.map((row, i) => {
            const td = meta(row.id);
            const q = i < 4, you = row.id === userTeamId;
            return (
              <div key={row.id} className={`pt-row${q ? " pt-q" : ""}${you ? " pt-you" : ""}`}>
                <span className="pt-pos">{i + 1}</span>
                <span className="pt-team"><span className="pt-badge" style={{ background: td.color, color: td.text }}>{td.short}</span></span>
                <span>{row.P}</span><span>{row.W}</span><span>{row.L}</span>
                <span className="pt-nrr">{nrrOf(row) >= 0 ? "+" : ""}{nrrOf(row).toFixed(2)}</span>
                <span className="pt-pts">{row.pts}</span>
              </div>
            );
          })}
          <div className="pt-legend"><span className="pt-q-dot" /> top 4 qualify</div>
        </div>
      </div>
    </div>
  );
}

/* ── Over-by-over viewer: replays a pre-simulated match one over at a time ── */
const ballChip = (o) => {
  if (o === "W") return { t: "W", c: "ob-w" };
  if (o === 4)   return { t: "4", c: "ob-4" };
  if (o === 6)   return { t: "6", c: "ob-6" };
  if (o === 0)   return { t: "•", c: "ob-dot" };
  return { t: String(o), c: "ob-run" };
};

function OverByOver({ match, label, meta, userTeamId, onDone }) {
  const [innIdx, setInn]   = useState(0);
  const [overIdx, setOver] = useState(-1);
  const [stage, setStage]  = useState("play");   // play | break | result

  const inn = match.innings[innIdx];
  const tl  = inn.timeline;
  const cur = overIdx >= 0 ? tl[overIdx] : null;
  const score = cur ? cur.score : 0;
  const wkts  = cur ? cur.wicketsDown : 0;
  const td    = meta(inn.teamId);
  const target = innIdx === 1 ? match.innings[0].total + 1 : null;

  const next = () => {
    if (stage === "result") return onDone();
    if (stage === "break") { setStage("play"); setInn(1); setOver(-1); return; }
    if (overIdx < tl.length - 1) setOver(overIdx + 1);
    else if (innIdx === 0) setStage("break");
    else setStage("result");
  };
  const skip = () => {
    if (innIdx === 0) { setInn(1); setOver(match.innings[1].timeline.length - 1); }
    else setOver(tl.length - 1);
    setStage("result");
  };

  // Result stage — final scorecard summary.
  if (stage === "result") {
    return (
      <div className="ob">
        <div className="ob-eyebrow">{label} · RESULT</div>
        <ResultCard m={match} meta={meta} highlight userTeamId={userTeamId} />
        <button className="bid-btn" style={{ marginTop: 18 }} onClick={onDone}>Continue →</button>
      </div>
    );
  }

  // Innings break.
  if (stage === "break") {
    const first = match.innings[0], chasing = meta(match.innings[1].teamId);
    return (
      <div className="ob">
        <div className="ob-eyebrow">{label} · INNINGS BREAK</div>
        <div className="ob-break">
          <div className="ob-break-score">{meta(first.teamId).short} posted <b>{first.total}/{first.wkts}</b> ({first.overs})</div>
          <div className="ob-break-need">{chasing.name} need <b>{first.total + 1}</b> to win</div>
        </div>
        <button className="bid-btn" onClick={next}>Start the chase →</button>
      </div>
    );
  }

  // Live play.
  const oversDisp = cur ? `${overIdx + 1}.0` : "0.0";
  const need = target != null ? target - score : null;
  const ballsLeft = (20 - (overIdx + 1)) * 6;

  return (
    <div className="ob">
      <div className="ob-eyebrow">{label} · {meta(match.innings[0].teamId).short} v {meta(match.innings[1].teamId).short}</div>

      {/* Scoreboard */}
      <div className="ob-board">
        <div className="ob-team">
          <span className="rcard-badge" style={{ background: td.color, color: td.text }}>{td.short}</span>
          <span className="ob-batting">batting</span>
        </div>
        <div className="ob-score">{score}<span className="ob-wkts">/{wkts}</span></div>
        <div className="ob-overs">{oversDisp} ov</div>
        {target != null && (
          <div className="ob-chase">
            {need > 0
              ? <>need <b>{need}</b> off <b>{ballsLeft}</b></>
              : <b className="ob-won">target reached</b>}
          </div>
        )}
      </div>

      {/* This over */}
      {cur ? (
        <div className="ob-over">
          <div className="ob-over-head">
            <span>Over {cur.over} · {cur.bowler.split(" ").pop()}</span>
            <span className="ob-over-tot">{cur.runs} run{cur.runs !== 1 ? "s" : ""}{cur.wkts ? ` · ${cur.wkts}W` : ""}</span>
          </div>
          <div className="ob-balls">
            {cur.balls.map((b, i) => { const c = ballChip(b); return <span key={i} className={`ob-ball ${c.c}`}>{c.t}</span>; })}
          </div>
          {cur.events.filter((e) => e.type === "W" || e.type === 6).map((e, i) => (
            <div key={i} className={`ob-event ${e.type === "W" ? "ob-event-w" : "ob-event-6"}`}>
              {e.type === "W" ? `WICKET — ${e.batter} out` : `SIX — ${e.batter}`}
            </div>
          ))}
        </div>
      ) : (
        <div className="ob-over ob-start">{td.name} to bat. Click to begin the innings.</div>
      )}

      <div className="ob-controls">
        <button className="out-btn" onClick={skip}>⏩ Skip to result</button>
        <button className="bid-btn" onClick={next}>Next over →</button>
      </div>
    </div>
  );
}

/* ── Final standing helpers + screen ── */
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const pct = (x) => `${Math.round(x * 100)}%`;

// ── Pre-season projection ──────────────────────────────────────────────────
// Fast strength-based Monte-Carlo (NOT ball-by-ball, so thousands of seasons
// run in milliseconds). Calibrated so a ~5-pt XI-rating edge ≈ 72% win prob —
// the same edge the ball-by-ball engine produces (see data/season_test.mjs).
const xiStrength = (xi) => {
  if (!xi || !xi.length) return 60;
  const sorted = [...xi].sort((a, b) => b.rating - a.rating);
  let w = 0, sw = 0;                       // weight the top 7 a touch higher
  sorted.forEach((p, i) => { const wt = i < 7 ? 1.2 : 1; w += p.rating * wt; sw += wt; });
  return w / sw;
};
const winProb = (sA, sB) => 1 / (1 + Math.pow(10, -(sA - sB) / 12));

function projectSeason(ids, strengths, rounds, userId, sims = 2000) {
  const posCount = {};
  let titleCount = 0, top4Count = 0;
  for (let s = 0; s < sims; s++) {
    const pts = {}, nrr = {};
    for (const id of ids) { pts[id] = 0; nrr[id] = 0; }
    for (const round of rounds) for (const fx of round) {
      const homeWin = Math.random() < winProb(strengths[fx.home], strengths[fx.away]);
      const w = homeWin ? fx.home : fx.away, l = homeWin ? fx.away : fx.home;
      pts[w] += 2;
      const m = 0.1 + Math.random() * 0.2;          // noisy NRR so ties break fairly
      nrr[w] += m; nrr[l] -= m;
    }
    const order = [...ids].sort((a, b) => pts[b] - pts[a] || nrr[b] - nrr[a]);
    const leaguePos = order.indexOf(userId) + 1;
    if (leaguePos <= 4) top4Count++;
    const [s1, s2, s3, s4] = order;
    const ko = (a, b) => Math.random() < winProb(strengths[a], strengths[b]) ? [a, b] : [b, a];
    const [q1w, q1l] = ko(s1, s2);     // q1w → Final, q1l → Q2
    const [ew, el]   = ko(s3, s4);     // ew → Q2, el eliminated 4th
    const [q2w, q2l] = ko(q1l, ew);    // q2w → Final, q2l eliminated 3rd
    const [ch, ru]   = ko(q1w, q2w);   // ch = champion, ru = runner-up (2nd)
    let pos;
    if (leaguePos > 4) pos = leaguePos;
    else if (userId === ch) pos = 1;
    else if (userId === ru) pos = 2;
    else if (userId === q2l) pos = 3;
    else if (userId === el) pos = 4;
    else pos = leaguePos;
    posCount[pos] = (posCount[pos] || 0) + 1;
    if (ch === userId) titleCount++;
  }
  let cum = 0, median = 10;
  for (let p = 1; p <= 10; p++) { cum += (posCount[p] || 0) / sims; if (cum >= 0.5) { median = p; break; } }
  return { projPos: median, titleOdds: titleCount / sims, top4Odds: top4Count / sims };
}

// Best / worst auction buy from the user's squad, judged on league output.
const perfLine = (st) => {
  if (!st || (!st.runs && !st.wkts)) return "didn't feature";
  return [st.runs ? `${st.runs} runs` : null, st.wkts ? `${st.wkts} wkts` : null].filter(Boolean).join(" · ");
};
function buyAnalysis(squad, pstats) {
  const rows = (squad || []).map((p) => {
    const st = pstats?.[p.name] || { runs: 0, wkts: 0 };
    const impact = st.runs + st.wkts * 25;
    const price = Math.max(0.2, p.price ?? p.base ?? 0.2);
    return { name: p.name, price, st, vpc: impact / price, impact };
  });
  const played = rows.filter((r) => r.impact > 0);
  const best = played.length ? played.reduce((a, b) => (b.vpc > a.vpc ? b : a)) : null;
  const pricey = rows.filter((r) => r.price >= 3);
  const worst = pricey.length ? pricey.reduce((a, b) => (b.vpc < a.vpc ? b : a)) : null;
  return { best, worst };
}

// ── Shareable result card (canvas → PNG), no deps ──
const rrect = (ctx, x, y, w, h, r) => {
  if (ctx.roundRect) { ctx.beginPath(); ctx.roundRect(x, y, w, h, r); return; }
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
};
function drawShareCard(ctx, W, H, d) {
  const F = "Barlow Condensed, Arial Narrow, sans-serif";
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, "#101A2C"); g.addColorStop(1, "#070A14");
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = d.ut.color; ctx.fillRect(0, 0, W, 16);
  ctx.textAlign = "center";
  ctx.fillStyle = "#7E8AA3"; ctx.font = `600 30px ${F}`;
  ctx.fillText("IPL AUCTION SIM · SEASON REPORT", W / 2, 96);
  // badge
  ctx.fillStyle = d.ut.color; rrect(ctx, W / 2 - 66, 130, 132, 132, 26); ctx.fill();
  ctx.fillStyle = d.ut.text; ctx.font = `800 54px ${F}`; ctx.fillText(d.ut.short, W / 2, 215);
  // headline
  ctx.fillStyle = d.isChamp ? "#F5C451" : "#FFFFFF"; ctx.font = `800 ${d.isChamp ? 120 : 124}px ${F}`;
  ctx.fillText(d.isChamp ? "CHAMPIONS" : `FINISHED ${ordinal(d.position).toUpperCase()}`, W / 2, 400);
  ctx.fillStyle = "#AEB6C7"; ctx.font = `700 42px ${F}`;
  ctx.fillText(d.ut.name.toUpperCase(), W / 2, 460);
  // projected vs actual strip
  ctx.fillStyle = "rgba(255,255,255,.05)"; rrect(ctx, 90, 520, W - 180, 150, 20); ctx.fill();
  ctx.fillStyle = "#7E8AA3"; ctx.font = `700 26px ${F}`; ctx.textAlign = "left";
  ctx.fillText("PROJECTED", 140, 575); ctx.fillText("FINISHED", 140, 640);
  ctx.fillText("TITLE ODDS", W / 2 + 120, 575); ctx.fillText("MADE TOP 4", W / 2 + 120, 640);
  ctx.fillStyle = "#FFFFFF"; ctx.font = `800 40px ${F}`;
  ctx.fillText(ordinal(d.projPos), 360, 578);
  ctx.fillStyle = d.position <= d.projPos ? "#3DDC97" : "#FF8488";
  ctx.fillText(`${ordinal(d.position)}`, 360, 643);
  ctx.fillStyle = "#F5C451"; ctx.fillText(pct(d.titleOdds), W / 2 + 320, 578);
  ctx.fillStyle = "#FFFFFF"; ctx.fillText(pct(d.top4Odds), W / 2 + 320, 643);
  // best / worst buy
  ctx.font = `700 28px ${F}`; ctx.fillStyle = "#7E8AA3";
  ctx.fillText("BEST BUY", 140, 760); ctx.fillText("WORST BUY", 140, 850);
  ctx.fillStyle = "#FFFFFF"; ctx.font = `700 34px ${F}`;
  ctx.fillText(d.best ? `${d.best.name}  —  ${perfLine(d.best.st)}` : "—", 360, 762);
  ctx.fillText(d.worst ? `${d.worst.name}  —  ${perfLine(d.worst.st)}` : "—", 360, 852);
  // footer
  ctx.textAlign = "center"; ctx.fillStyle = "#5B647A"; ctx.font = `600 26px ${F}`;
  ctx.fillText("Built from the auction floor · 258 real players", W / 2, H - 60);
}

// End-of-season screen — always tells the user where they finished, reveals the
// pre-season projection vs the real result, names the best/worst auction buy,
// and exports a shareable image. position 1 = champions … 5-10 = missed top 4.
function FinishScreen({ position, userTeamId, championId, onRestart, projection, pstats, squad }) {
  const meta = (id) => TEAMS.find((t) => t.id === id);
  const ut = meta(userTeamId);
  const champ = championId ? meta(championId) : null;
  const isChamp = position === 1;
  const proj = projection || { projPos: position, titleOdds: 0, top4Odds: 0 };
  const { best, worst } = buyAnalysis(squad, pstats);
  const delta = proj.projPos - position;   // + = finished better than projected
  const verdict = delta > 0 ? { t: `OVERPERFORMED +${delta}`, c: "#12A06A" }
    : delta < 0 ? { t: `UNDERPERFORMED ${delta}`, c: "#DC3A40" }
    : { t: "RIGHT ON PROJECTION", c: "#677087" };
  const blurb = isChamp
    ? "🏆 You built this squad from the auction floor. Champions."
    : position === 2 ? `So close — runners-up.${champ ? ` ${champ.name} took the title.` : ""}`
    : position === 3 ? `Knocked out in Qualifier 2.${champ ? ` ${champ.name} won it.` : ""}`
    : position === 4 ? `Knocked out in the Eliminator.${champ ? ` ${champ.name} won it.` : ""}`
    : "Missed the playoffs — only the top 4 go through.";

  const shareData = { ut, position, isChamp, projPos: proj.projPos, titleOdds: proj.titleOdds, top4Odds: proj.top4Odds, best, worst };
  const saveImage = () => {
    const W = 1080, H = 1080;
    const c = document.createElement("canvas");
    c.width = W; c.height = H;
    drawShareCard(c.getContext("2d"), W, H, shareData);
    c.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = `ipl-auction-${ut.short}-${ordinal(position)}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  };
  const [copied, setCopied] = useState(false);
  const copyText = () => {
    const txt = `🏏 IPL Auction Sim — ${ut.name}\n`
      + `${isChamp ? "CHAMPIONS 🏆" : `Finished ${ordinal(position)}`} (projected ${ordinal(proj.projPos)}) · pre-season title odds ${pct(proj.titleOdds)}\n`
      + (best ? `Best buy: ${best.name} (${perfLine(best.st)})\n` : "")
      + (worst ? `Worst buy: ${worst.name} (${perfLine(worst.st)})` : "");
    const flash = () => { setCopied(true); setTimeout(() => setCopied(false), 1800); };
    const fallback = () => {
      try {
        const ta = document.createElement("textarea");
        ta.value = txt; ta.style.position = "fixed"; ta.style.opacity = "0";
        document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
      } catch { /* clipboard unavailable — nothing else to do */ }
    };
    if (navigator.clipboard?.writeText)
      navigator.clipboard.writeText(txt).then(flash, () => { fallback(); flash(); });
    else { fallback(); flash(); }
  };

  return (
    <div className="champion">
      <div className="champ-badge" style={{ background: ut.color, color: ut.text }}>{ut.short}</div>
      <div className="finish-pos" style={{ color: isChamp ? "#B5800F" : "#677087" }}>
        {isChamp ? "CHAMPIONS · 1ST" : `FINISHED ${ordinal(position).toUpperCase()}`}
      </div>
      <h1 className="champ-name">{ut.name}</h1>
      <div className="champ-sub">{blurb}</div>

      {/* Season report — projection vs reality + value calls */}
      <div className="report">
        <div className="report-row">
          <div className="report-cell"><span className="report-lbl">PROJECTED</span><span className="report-val">{ordinal(proj.projPos)}</span></div>
          <div className="report-cell"><span className="report-lbl">FINISHED</span><span className="report-val" style={{ color: delta >= 0 ? "#12A06A" : "#DC3A40" }}>{ordinal(position)}</span></div>
          <div className="report-cell"><span className="report-lbl">TITLE ODDS</span><span className="report-val" style={{ color: "#B5800F" }}>{pct(proj.titleOdds)}</span></div>
          <div className="report-cell"><span className="report-lbl">TOP 4 ODDS</span><span className="report-val">{pct(proj.top4Odds)}</span></div>
        </div>
        <div className="report-verdict" style={{ color: verdict.c }}>{verdict.t}</div>
        <div className="report-buys">
          <div className="buy"><span className="buy-tag buy-best">BEST BUY</span>{best ? <span className="buy-txt"><b>{best.name}</b> · {perfLine(best.st)} · {cr(best.price)}</span> : <span className="buy-txt">—</span>}</div>
          <div className="buy"><span className="buy-tag buy-worst">WORST BUY</span>{worst ? <span className="buy-txt"><b>{worst.name}</b> · {perfLine(worst.st)} · {cr(worst.price)}</span> : <span className="buy-txt">—</span>}</div>
        </div>
      </div>

      <div className="finish-actions">
        <button className="bid-btn" onClick={saveImage}>📸 Save image</button>
        <button className="auto-btn" onClick={copyText}>{copied ? "Copied ✓" : "Copy result"}</button>
        <button className="out-btn" onClick={onRestart}>Run it back ↻</button>
      </div>
    </div>
  );
}

/* ── Playoffs: Q1 (1v2), Eliminator (3v4), Q2, Final ──
   The user plays only their own knockouts over-by-over; every other tie
   auto-simulates the moment its inputs are known, so a champion is always
   crowned and the user's finishing position is always resolvable. */
function PlayoffsScreen({ teams, userTeamId, xis, seeds, teamObj, onRestart, projection, pstats, userSquad }) {
  const meta = (id) => TEAMS.find((t) => t.id === id);
  const [s1, s2, s3, s4] = seeds;
  const [ties, setTies] = useState({ q1: null, elim: null, q2: null, final: null });
  const [live, setLive] = useState(null);   // { key, label, match } while watching over-by-over

  const simMatch = (aId, bId) => ({ ...simulateMatch(teamObj(aId), teamObj(bId)), home: aId, away: bId });
  const L = (m) => (m.winner === m.firstId ? m.secondId : m.firstId);   // loser id

  // Auto-resolve every tie the user is NOT part of, cascading as winners feed
  // forward. Returns the same state reference when nothing changed so the effect
  // doesn't loop.
  useEffect(() => {
    if (live) return;
    setTies((t) => {
      let n = t, changed = true;
      while (changed) {
        changed = false;
        const cand = [
          ["q1", s1, s2],
          ["elim", s3, s4],
          ["q2", n.q1 ? L(n.q1) : null, n.elim?.winner ?? null],
          ["final", n.q1?.winner ?? null, n.q2?.winner ?? null],
        ];
        for (const [key, a, b] of cand) {
          if (!n[key] && a && b && a !== userTeamId && b !== userTeamId) {
            n = { ...n, [key]: simMatch(a, b) };
            changed = true;
          }
        }
      }
      return n;
    });
  }, [ties, live, s1, s2, s3, s4, userTeamId]);

  const play = (key, label, aId, bId) => setLive({ key, label, match: simMatch(aId, bId) });
  const finishLive = () => { setTies((t) => ({ ...t, [live.key]: live.match })); setLive(null); };

  if (live)
    return <OverByOver match={live.match} label={live.label} meta={meta} userTeamId={userTeamId} onDone={finishLive} />;

  const q1 = ties.q1, elim = ties.elim, q2 = ties.q2, final = ties.final;
  const champion = final?.winner;

  // Once the user's run is over (won it all OR knocked out), show their finish.
  // The effect keeps resolving the rest of the bracket so championId fills in.
  const inTie = (m, id) => m && (m.firstId === id || m.secondId === id);
  let finishPos = null;
  if (champion === userTeamId) finishPos = 1;
  else if (inTie(final, userTeamId)) finishPos = 2;
  else if (inTie(q2, userTeamId) && L(q2) === userTeamId) finishPos = 3;
  else if (inTie(elim, userTeamId) && L(elim) === userTeamId) finishPos = 4;
  if (finishPos != null)
    return <FinishScreen position={finishPos} userTeamId={userTeamId} championId={champion} onRestart={onRestart}
      projection={projection} pstats={pstats} squad={userSquad} />;

  const mine = (a, b) => a === userTeamId || b === userTeamId;
  const q2A = q1 ? L(q1) : null, q2B = elim?.winner ?? null;
  const finalA = q1?.winner ?? null, finalB = q2?.winner ?? null;

  const Tie = ({ label, aId, bId, m, mine: isMine, onPlay, sub }) => (
    <div className="tie">
      <div className="tie-label">{label}{sub && <span className="tie-sub"> · {sub}</span>}</div>
      {!aId || !bId ? (
        <div className="tie-pending">awaiting earlier results</div>
      ) : m ? (
        <>
          <ResultCard m={m} meta={meta} userTeamId={userTeamId} />
          {!isMine && <div className="tie-auto">auto-simulated</div>}
        </>
      ) : isMine ? (
        <div className="tie-matchup">
          <span className="tie-side"><span className="rcard-badge" style={{ background: meta(aId).color, color: meta(aId).text }}>{meta(aId).short}</span></span>
          <span className="tie-v">vs</span>
          <span className="tie-side"><span className="rcard-badge" style={{ background: meta(bId).color, color: meta(bId).text }}>{meta(bId).short}</span></span>
          <button className="bid-btn tie-play" onClick={onPlay}>Play live →</button>
        </div>
      ) : (
        <div className="tie-pending">simulating…</div>
      )}
    </div>
  );

  return (
    <div className="season">
      <div className="season-hd">
        <div>
          <div className="pxi-title">Playoffs</div>
          <div className="pxi-sub">You play your own knockouts live — every other tie auto-simulates.</div>
        </div>
        <button className="out-btn" onClick={onRestart}>New season ↻</button>
      </div>

      <div className="bracket">
        <Tie label="Qualifier 1" sub={`${seeds[0]} (1) v ${seeds[1]} (2)`} aId={s1} bId={s2} m={q1} mine={mine(s1, s2)} onPlay={() => play("q1", "Qualifier 1", s1, s2)} />
        <Tie label="Eliminator" sub={`${seeds[2]} (3) v ${seeds[3]} (4)`} aId={s3} bId={s4} m={elim} mine={mine(s3, s4)} onPlay={() => play("elim", "Eliminator", s3, s4)} />
        <Tie label="Qualifier 2" sub="Q1 loser v Eliminator winner"
          aId={q2A} bId={q2B} m={q2} mine={mine(q2A, q2B)}
          onPlay={() => play("q2", "Qualifier 2", q2A, q2B)} />
        <Tie label="Final" sub="Q1 winner v Q2 winner"
          aId={finalA} bId={finalB} m={final} mine={mine(finalA, finalB)}
          onPlay={() => play("final", "The Final", finalA, finalB)} />
      </div>
    </div>
  );
}

// Compact result card: both scores + the standout performer from each side.
function ResultCard({ m, meta, highlight, userTeamId }) {
  const [a, b] = m.innings;
  const won = m.winner;
  const youWon = m.winner === userTeamId && (m.home === userTeamId || m.away === userTeamId);
  const youLost = (m.home === userTeamId || m.away === userTeamId) && !youWon;
  return (
    <div className={`rcard${highlight ? " rcard-big" : ""}${highlight && youWon ? " rcard-win" : ""}${highlight && youLost ? " rcard-loss" : ""}`}>
      {highlight && <div className="rcard-tag">{youWon ? "YOU WON" : "YOU LOST"}</div>}
      {[a, b].map((inn) => {
        const td = meta(inn.teamId);
        const { topBat, topBowl } = innViews(inn);
        return (
          <div key={inn.teamId} className={`rcard-inn${inn.teamId === won ? " rcard-w" : ""}`}>
            <span className="rcard-badge" style={{ background: td.color, color: td.text }}>{td.short}</span>
            <span className="rcard-score">{inn.total}/{inn.wkts}<span className="rcard-ov"> ({inn.overs})</span></span>
            {highlight && (
              <span className="rcard-stars">
                {topBat && `${topBat.p.name.split(" ").pop()} ${topBat.runs}(${topBat.balls})`}
                {topBowl && topBowl.wkts > 0 && ` · ${topBowl.p.name.split(" ").pop()} ${topBowl.wkts}/${topBowl.runs}`}
              </span>
            )}
          </div>
        );
      })}
      <div className="rcard-result">{m.resultText}</div>
    </div>
  );
}

function Summary({ me, teams, onRestart }) {
  const spent  = round2(120 - me.purse);
  const sorted = [...teams].sort((a, b) => b.squad.length - a.squad.length);
  return (
    <div className="summary">
      <div className="sum-eye">AUCTION COMPLETE</div>
      <h1 className="sum-title">Your squad is set</h1>
      <div className="sum-stats">
        <div><b>{me.squad.length}</b> players won</div>
        <div><b style={{ color: "#B5800F" }}>{cr(spent)}</b> spent</div>
        <div><b>{cr(me.purse)}</b> purse left</div>
      </div>
      <div className="squad-chips-row" style={{ marginTop: 14 }}>
        {me.squad.map((s, i) => (
          <span key={i} className="squad-chip">{s.name} <b>{cr(s.price)}</b></span>
        ))}
        {me.squad.length === 0 && <span className="empty-hint">You didn't win anyone.</span>}
      </div>
      <div className="sum-rivals">
        {sorted.filter((t) => !t.isUser).map((t) => {
          const td = TEAMS.find((td) => td.id === t.id);
          return <span key={t.id}><b style={{ color: td.color }}>{t.id}</b> {t.squad.length}</span>;
        })}
      </div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginTop: 20 }}>
        <button className="bid-btn" onClick={onRestart}>Change team &amp; restart</button>
        <span className="start-note">Next → pick your playing XI</span>
      </div>
    </div>
  );
}

/* ── PickXI Screen ── */
function PickXIScreen({ squad, onLock, teams = [], userTeamId }) {
  const [lineup, setLineup]   = useState([]);
  const [selSet, setSelSet]   = useState(new Set());
  const [viewTeam, setViewTeam] = useState(null); // teamId for rival squad modal
  const [dropActive, setDropActive] = useState(false); // drag-over highlight on the XI panel

  // Auto-pick the best legal XI (same engine the AI teams use), ordered for batting.
  const autoPick = () => {
    const xi = battingOrder(pickXI(squad));
    setLineup(xi);
    setSelSet(new Set(xi.map((p) => p.name)));
  };
  const clearXI = () => { setLineup([]); setSelSet(new Set()); };

  // Drop a dragged squad card into the XI (same effect as tapping it to add).
  const onDropPlayer = (e) => {
    e.preventDefault();
    setDropActive(false);
    const name = e.dataTransfer.getData("text/plain");
    const player = squad.find((s) => s.name === name);
    if (player && !selSet.has(player.name) && selSet.size < 11) toggle(player);
  };

  const toggle = (player) => {
    if (selSet.has(player.name)) {
      setSelSet((s) => { const n = new Set(s); n.delete(player.name); return n; });
      setLineup((l) => l.filter((p) => p.name !== player.name));
    } else {
      if (selSet.size >= 11) return;
      setSelSet((s) => new Set([...s, player.name]));
      setLineup((l) => {
        const next = [...l, player];
        return next.sort((a, b) => {
          const ro = ROLE_ORDER[a.role] - ROLE_ORDER[b.role];
          return ro !== 0 ? ro : b.price - a.price;
        });
      });
    }
  };

  const move = (i, dir) =>
    setLineup((l) => {
      const j = i + dir;
      if (j < 0 || j >= l.length) return l;
      const n = [...l];
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });

  // Assign each player to their primary batting-role section
  const sectionOf = (p) => {
    if (p.wk)                                              return "wk";
    if (p.role === "All-rounder")                          return "allround";
    if (p.role === "Bowler" && p.bowlType === "spin")      return "spin";
    if (p.role === "Bowler")                               return "pace";   // pace or unknown
    // Pure batters: by batting position
    if (p.batOrder === "top")                              return "opener";
    if (p.finisher)                                        return "finisher";
    if (p.batOrder === "mid")                              return "middle";
    return "lower";
  };

  const SECTIONS = [
    { id: "wk",       label: "Wicketkeeper",           rec: "need 1",   color: "#C8851A" },
    { id: "opener",   label: "Openers / Top Order",    rec: "pick 2–3", color: "#2E86C8" },
    { id: "middle",   label: "Middle Order",           rec: "pick 1–2", color: "#2E86C8" },
    { id: "finisher", label: "Finishers",              rec: "pick 1–2", color: "#7E5BE0" },
    { id: "allround", label: "All-rounders",           rec: "pick 2–3", color: "#3E9E54" },
    { id: "pace",     label: "Pace Bowlers",           rec: "pick 2–3", color: "#D04A4A" },
    { id: "spin",     label: "Spin Bowlers",           rec: "pick 1–2", color: "#D9701A" },
    { id: "lower",    label: "Lower Order",            rec: "",         color: "#677087" },
  ];

  // Group squad into sections (only show sections that have players)
  const squadBySec = {};
  squad.forEach((p) => {
    const s = sectionOf(p);
    (squadBySec[s] = squadBySec[s] || []).push(p);
  });

  const roleCounts = { WK: 0, Batter: 0, "All-rounder": 0, Bowler: 0 };
  lineup.forEach((p) => { roleCounts[p.role] = (roleCounts[p.role] || 0) + 1; });
  // Bowling options = specialist bowlers + all-rounders. You need 5 to legally
  // bowl 20 overs (max 4 each), so this is a hard requirement, not a warning.
  const bowlOptions = roleCounts.Bowler + roleCounts["All-rounder"];

  // Only require a keeper in the XI if the squad actually has one — otherwise a
  // keeperless squad would be soft-locked. No specialist keeper → a batter keeps.
  const squadHasKeeper = squad.some((p) => p.wk);

  // Blocking requirements (must satisfy to lock) vs soft warnings.
  const blockers = [];
  if (lineup.length === 11 && roleCounts.WK === 0 && squadHasKeeper) blockers.push("Pick a wicket-keeper");
  if (lineup.length === 11 && bowlOptions < 5)     blockers.push(`Need 5 bowling options (have ${bowlOptions})`);
  const canLock = lineup.length === 11 && !blockers.length;

  // Soft warnings (don't block).
  const warnings = [...blockers];
  if (!blockers.length && !squadHasKeeper && lineup.length === 11) warnings.push("No specialist keeper — a top-order batter will keep");
  else if (!blockers.length && (roleCounts.WK + roleCounts.Batter) > 6) warnings.push("Heavy on pure batters");

  return (
    <div className="pickxi">
      {/* ── header ── */}
      <div className="pxi-hd">
        <div>
          <div className="pxi-title">Pick Your XI</div>
          <div className="pxi-sub">
            {squad.length} players · {selSet.size}/11 selected · drag or tap a player to build your XI — or auto-pick
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 8 }}>
          {warnings.length > 0 && <div className="pxi-warn">{warnings[0]}</div>}
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="auto-btn" onClick={autoPick}>✨ Auto-pick best XI</button>
            {lineup.length > 0 && <button className="out-btn pxi-clear" onClick={clearXI}>Clear</button>}
            <button className="bid-btn pxi-lock" onClick={() => onLock(lineup)} disabled={!canLock}>
              {lineup.length < 11 ? `${lineup.length} / 11 selected` : blockers.length ? "Fix your XI" : "Lock XI →"}
            </button>
          </div>
        </div>
      </div>

      {/* ── body ── */}
      <div className="pxi-body">

        {/* LEFT — squad pool grouped by role section */}
        <div className="pxi-pool">
          {squad.length === 0 ? (
            <p className="empty-hint" style={{ marginTop: 20 }}>You didn't win any players in the auction.</p>
          ) : (
            <div className="pxi-sections">
              {SECTIONS.filter(sec => (squadBySec[sec.id] || []).length > 0).map(sec => {
                const players = squadBySec[sec.id] || [];
                const pickedHere = players.filter(p => selSet.has(p.name)).length;
                return (
                  <div key={sec.id} className="pxi-sec">
                    {/* Section header */}
                    <div className="pxi-sec-hd">
                      <span className="pxi-sec-dot" style={{ background: sec.color }} />
                      <span className="pxi-sec-label" style={{ color: sec.color }}>{sec.label}</span>
                      {sec.rec && <span className="pxi-sec-rec">{sec.rec}</span>}
                      <span className="pxi-sec-count">{pickedHere}/{players.length} picked</span>
                    </div>
                    {/* Horizontal scrollable player row */}
                    <div className="pxi-sec-row">
                      {players.map(p => {
                        const isSel = selSet.has(p.name);
                        const pos   = lineup.findIndex(l => l.name === p.name);
                        return (
                          <div
                            key={p.name}
                            className={`psc${isSel ? " psc-sel" : ""}`}
                            style={isSel ? { borderColor: sec.color, boxShadow: `0 0 0 1px ${sec.color}55` } : { borderColor: "rgba(20,30,50,.1)" }}
                            draggable
                            onDragStart={(e) => e.dataTransfer.setData("text/plain", p.name)}
                            onClick={() => toggle(p)}
                          >
                            {isSel && (
                              <span className="psc-pos" style={{ background: sec.color, color: "#0B1120" }}>#{pos + 1}</span>
                            )}
                            <div className="psc-name">{p.name}</div>
                            <div className="psc-chips">
                              {p.overseas && <span className="psc-os">OS</span>}
                              {p.finisher && <span className="psc-tag" style={{ color: "#7E5BE0" }}>FIN</span>}
                              {p.deathSpec && <span className="psc-tag" style={{ color: "#D04A4A" }}>DEATH</span>}
                            </div>
                            <div className="psc-foot">
                              <span className="psc-price">{cr(p.price)}</span>
                              <span className="psc-rating">★{p.rating}</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* RIGHT — batting order (drop target for dragged cards) */}
        <div
          className={`pxi-lineup${dropActive ? " pxi-lineup-drop" : ""}`}
          onDragOver={(e) => { e.preventDefault(); if (!dropActive) setDropActive(true); }}
          onDragLeave={() => setDropActive(false)}
          onDrop={onDropPlayer}
        >
          <div className="pxi-lineup-title">BATTING ORDER {dropActive && <span className="drop-hint">drop to add ▾</span>}</div>

          {/* Role balance bars */}
          <div className="role-bars">
            {[
              ["Batters",      roleCounts.Batter        || 0, 5, "#2E86C8"],
              ["All-rounders", roleCounts["All-rounder"] || 0, 3, "#3E9E54"],
              ["WK",           roleCounts.WK             || 0, 2, "#C8851A"],
              ["Bowlers",      roleCounts.Bowler         || 0, 5, "#D04A4A"],
            ].map(([lbl, val, max, col]) => (
              <div key={lbl} className="rb-row">
                <span className="rb-lbl">{lbl}</span>
                <div className="rb-track">
                  <div className="rb-fill" style={{ width: `${Math.min(100, (val / max) * 100)}%`, background: col }} />
                </div>
                <span className="rb-val" style={{ color: col }}>{val}</span>
              </div>
            ))}
          </div>

          {/* Lineup list */}
          <div className="lineup-list">
            {lineup.map((p, i) => (
              <div key={p.name} className="lineup-row">
                <span className="lineup-num" style={{ color: roleColor(p.role) }}>{i + 1}</span>
                <div className="lineup-info">
                  <div className="lineup-name">{p.name}</div>
                  <span className="lineup-role" style={{ color: roleColor(p.role) }}>
                    {roleShort(p.role)}
                  </span>
                </div>
                <div className="lineup-arrows">
                  <button className="arr-btn" onClick={() => move(i, -1)} disabled={i === 0}>▲</button>
                  <button className="arr-btn" onClick={() => move(i, 1)}  disabled={i === lineup.length - 1}>▼</button>
                </div>
              </div>
            ))}
            {Array.from({ length: Math.max(0, 11 - lineup.length) }).map((_, i) => (
              <div key={`slot-${i}`} className="lineup-row lineup-slot">
                <span className="lineup-num lineup-num-empty">{lineup.length + i + 1}</span>
                <span className="lineup-slot-hint">drag or tap a player here</span>
              </div>
            ))}
          </div>
        </div>

      </div>

      {/* ── RIVAL TEAMS ROW ── */}
      {teams.filter((t) => t.id !== userTeamId).length > 0 && (
        <div className="pxi-rivals">
          <div className="panel-title" style={{ marginBottom: 10 }}>OTHER TEAMS' SQUADS</div>
          <div className="rivals-grid">
            {teams.filter((t) => t.id !== userTeamId).map((ts) => {
              const td = TEAMS.find((x) => x.id === ts.id);
              return (
                <div
                  key={ts.id}
                  className="rival-card"
                  style={{ borderColor: `${td.color}44`, cursor: "pointer" }}
                  onClick={() => setViewTeam(ts.id)}
                >
                  <span className="tc-badge" style={{ background: td.color, color: td.text, fontSize: 11 }}>{td.short}</span>
                  <div className="rival-info">
                    <div className="rival-name">{td.name}</div>
                    <div className="rival-meta">{ts.squad.length} players · {cr(ts.purse)} left</div>
                  </div>
                  <span className="rival-arrow">▸</span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Squad modal for rival team */}
      {viewTeam && (() => {
        const td = TEAMS.find((t) => t.id === viewTeam);
        const ts = teams.find((t) => t.id === viewTeam);
        const sq = ts ? [...ts.squad].sort((a, b) => (ROLE_ORDER[a.role] ?? 9) - (ROLE_ORDER[b.role] ?? 9)) : [];
        return (
          <div className="modal-backdrop" onClick={() => setViewTeam(null)}>
            <div className="modal-card" onClick={(e) => e.stopPropagation()}>
              <div className="modal-head" style={{ borderColor: td.color }}>
                <span className="tc-badge" style={{ background: td.color, color: td.text, fontSize: 13 }}>{td.short}</span>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 15 }}>{td.name}</div>
                  <div style={{ fontSize: 12, color: "#677087" }}>{sq.length} players · {cr(ts.purse)} left</div>
                </div>
                <button className="modal-close" onClick={() => setViewTeam(null)}>✕</button>
              </div>
              {sq.length === 0
                ? <p className="empty-hint" style={{ padding: "16px 20px" }}>No players acquired.</p>
                : <div className="modal-list">
                    {sq.map((s, i) => (
                      <div key={i} className="modal-row">
                        <span className="modal-role" style={{ color: roleColor(s.role) }}>{roleShort(s.role)}</span>
                        <span className="modal-name">{s.name}</span>
                        <span className="modal-country" style={{ color: s.overseas ? "#B5800F" : "#6B7488" }}>{s.country}{s.overseas ? " ✈" : ""}</span>
                        <span className="modal-price">{cr(s.price)}</span>
                      </div>
                    ))}
                  </div>
              }
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* ── styles ── */
const styles = `
.auc {
  position: relative;
  --display-font: 'Barlow Condensed', 'Arial Narrow', ui-sans-serif, sans-serif;
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  color: #1B2436;
  background:
    radial-gradient(900px 400px at 30% 0%, rgba(245,196,81,.12), transparent 55%),
    radial-gradient(600px 500px at 100% 0%, rgba(27,111,203,.07), transparent 50%),
    linear-gradient(180deg, #EDF0F6, #DEE4EF 70%);
  border-radius: 16px;
  padding: 16px 18px 20px;
  font-variant-numeric: tabular-nums;
  overflow: hidden;
  min-height: 600px;
}
.auc * { box-sizing: border-box; }

/* header */
.hd {
  display: flex; justify-content: space-between; align-items: center;
  gap: 12px; flex-wrap: wrap;
  padding-bottom: 13px; margin-bottom: 14px;
  border-bottom: 1px solid rgba(20,30,50,.07);
}
.hd-brand  { display: flex; align-items: center; gap: 10px; }
.hd-icon   {
  width: 34px; height: 34px; border-radius: 9px;
  display: grid; place-items: center;
  background: linear-gradient(150deg,#F5C451,#C98F1E); color: #1a1304;
  box-shadow: 0 4px 14px -4px rgba(245,196,81,.45);
}
.hd-icon.big { width: 50px; height: 50px; border-radius: 13px; margin: 0 auto 10px; }
.hd-title  { font-weight: 800; letter-spacing: .16em; font-size: 13px; }
.hd-sub    { font-size: 11px; color: #677087; }
.hd-stats  { display: flex; gap: 8px; }
.hd-stat   {
  background: rgba(20,30,50,.04); border: 1px solid rgba(20,30,50,.07);
  border-radius: 10px; padding: 6px 12px;
}
.hd-stat-gold {
  background: linear-gradient(150deg, rgba(245,196,81,.14), rgba(245,196,81,.04));
  border-color: rgba(245,196,81,.3);
}
.hd-stat-lbl { font-size: 9.5px; color: #677087; letter-spacing: .1em; text-transform: uppercase; }
.hd-stat-val { font-weight: 800; font-size: 15px; margin-top: 1px; }
.hd-stat-gold .hd-stat-val { color: #B5800F; }

/* body grid — matches the sketch exactly */
.body {
  display: grid;
  grid-template-columns: 172px 1fr 196px;
  gap: 12px;
  align-items: start;
}
@media (max-width: 860px) { .body { grid-template-columns: 1fr; } }

/* ── LEFT: squad panel ── */
.squad-panel {
  background: #FFFFFF;
  border: 1px solid rgba(20,30,50,.1);
  border-radius: 13px;
  padding: 13px 13px;
  min-height: 400px;
  box-shadow: 0 2px 10px -4px rgba(20,30,50,.12);
}
.panel-title {
  font-size: 10px; font-weight: 700; letter-spacing: .14em;
  color: #677087; text-transform: uppercase; margin-bottom: 11px;
  display: flex; justify-content: space-between;
}
.panel-title span { color: #B5800F; }
.squad-list { display: flex; flex-direction: column; gap: 8px; }
.squad-item {
  background: rgba(27,111,203,.12); border: 1px solid rgba(27,111,203,.3);
  border-radius: 9px; padding: 8px 10px;
}
.squad-item-name { font-size: 12.5px; font-weight: 700; }
.squad-item-meta { display: flex; justify-content: space-between; margin-top: 3px; }
.squad-role  { font-size: 10.5px; color: #677087; }
.squad-price { font-size: 11px; font-weight: 700; color: #B5800F; }
.empty-hint  { font-size: 12px; color: #6B7488; line-height: 1.5; margin: 0; }

/* ── CENTER ── */
.center { display: flex; flex-direction: column; gap: 12px; }

/* player stage */
.stage {
  position: relative;
  background: #FFFFFF;
  border: 1px solid rgba(20,30,50,.1);
  border-radius: 15px;
  padding: 18px 20px;
  overflow: hidden;
  box-shadow: 0 18px 44px -20px rgba(20,30,50,.3), 0 0 60px -22px rgba(245,196,81,.22);
}
.stage::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(500px 180px at 50% 0%, rgba(245,196,81,.09), transparent 65%);
}
.stage-eyebrow {
  display: flex; align-items: center; gap: 10px;
  font-size: 10.5px; letter-spacing: .16em; color: #677087; font-weight: 700;
}
.tier-pill {
  color: #B5800F; border: 1px solid rgba(245,196,81,.4);
  padding: 2px 8px; border-radius: 99px; background: rgba(245,196,81,.08);
  font-size: 10px;
}
.stage-name {
  font-family: var(--display-font);
  font-size: clamp(34px, 4.6vw, 52px); font-weight: 800;
  letter-spacing: .01em; text-transform: uppercase;
  margin: 8px 0 0; line-height: 1;
}
.stage-chips { display: flex; gap: 7px; margin-top: 9px; flex-wrap: wrap; }
.chip {
  font-size: 11.5px; background: rgba(20,30,50,.06);
  border: 1px solid rgba(20,30,50,.08); padding: 3px 10px;
  border-radius: 99px; color: #46526B;
}
.stage-main {
  display: flex; align-items: center; justify-content: space-between; gap: 18px;
  margin-top: 14px; flex-wrap: wrap;
}
.stage-left { display: flex; align-items: center; gap: 20px; flex: 1 1 auto; min-width: 240px; }
.ring-wrap  { position: relative; width: 92px; height: 92px; flex: none; }
.ring-inner {
  position: absolute; inset: 0;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
}
.ring-init  { font-weight: 850; font-size: 19px; }
.ring-secs  { font-size: 10.5px; font-weight: 700; margin-top: 1px; }
.bid-block  { flex: 0 1 auto; min-width: 130px; }
.bid-lbl    { font-size: 10px; letter-spacing: .15em; color: #677087; font-weight: 700; }
.bid-num    { font-family: var(--display-font); font-size: clamp(30px, 4.4vw, 50px); font-weight: 800; letter-spacing: .01em; color: #B5800F; line-height: 1.05; }
.bid-leader { margin-top: 5px; font-size: 12.5px; font-weight: 700; }
.lead-you   { color: #12A06A; }
.lead-none  { color: #6B7488; font-weight: 500; }
.bid-base   { margin-top: 6px; font-size: 10.5px; color: #6B7488; }
/* user bidding pod (right of stage) */
.user-pod {
  flex: 0 0 auto; width: 210px;
  background: linear-gradient(155deg, rgba(27,111,203,.18), rgba(27,111,203,.04));
  border: 1px solid rgba(27,111,203,.42); border-radius: 13px;
  padding: 12px; display: flex; flex-direction: column; gap: 11px;
}
.user-pod-head { display: flex; align-items: center; gap: 10px; }
.user-pod-badge {
  width: 38px; height: 38px; border-radius: 9px; flex: none;
  display: grid; place-items: center; font-weight: 850; font-size: 13px;
  background: #1B6FCB; color: #FFFFFF; box-shadow: 0 3px 10px -3px rgba(27,111,203,.7);
}
.user-pod-name  { font-size: 14px; font-weight: 800; color: #1B2436; line-height: 1.1; }
.user-pod-purse { font-size: 11px; font-weight: 600; color: #2E6FB0; margin-top: 2px; }
.controls   { display: flex; flex-direction: column; gap: 7px; }
.controls .bid-btn { justify-content: center; width: 100%; }
.controls .out-btn { width: 100%; text-align: center; }

/* autopilot */
.ap-wrap { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(20,30,50,.07); }
.ap-btn {
  width: 100%; background: rgba(20,30,50,.05);
  border: 1px solid rgba(20,30,50,.12); color: #55617A;
  font-size: 11.5px; font-weight: 700; padding: 8px 12px; border-radius: 9px;
  cursor: pointer; letter-spacing: .01em; transition: background .15s, border-color .15s;
}
.ap-btn:hover { background: rgba(20,30,50,.09); border-color: rgba(20,30,50,.22); color: #1B2436; }
.ap-confirm { display: flex; flex-direction: column; gap: 8px; }
.ap-confirm-txt { font-size: 11px; color: #55617A; text-align: center; line-height: 1.4; }
.ap-confirm-btns { display: flex; gap: 7px; }
.ap-yes {
  flex: 1; background: linear-gradient(150deg,#2E86C8,#1e90c7); border: none;
  color: #0B1120; font-weight: 800; font-size: 12px; padding: 8px; border-radius: 8px;
  cursor: pointer; transition: filter .15s;
}
.ap-yes:hover { filter: brightness(1.1); }
.ap-no {
  flex: 1; background: rgba(20,30,50,.06); border: 1px solid rgba(20,30,50,.12);
  color: #55617A; font-size: 12px; font-weight: 600; padding: 8px; border-radius: 8px;
  cursor: pointer;
}
.ap-no:hover { background: rgba(20,30,50,.1); }
.bid-btn {
  border: none; cursor: pointer;
  background: linear-gradient(155deg,#F5C451,#D89B22); color: #1a1304;
  font-weight: 800; font-size: 14px; padding: 11px 20px; border-radius: 10px;
  min-height: 44px;
  box-shadow: 0 8px 20px -8px rgba(245,196,81,.65);
  transition: filter .15s, transform .08s;
  display: inline-flex; align-items: center; justify-content: center; gap: 6px;
}
.bid-btn:hover:not(:disabled) { filter: brightness(1.07); }
.bid-btn:active:not(:disabled) { transform: scale(.98); }
.bid-btn:disabled { background: rgba(20,30,50,.06); color: #6B7488; box-shadow: none; cursor: not-allowed; }
.out-btn {
  border: 1px solid rgba(20,30,50,.15); background: transparent;
  color: #46526B; cursor: pointer; font-size: 12.5px; font-weight: 600;
  padding: 9px 16px; border-radius: 9px; transition: background .15s;
  min-height: 44px;
}
.out-btn:hover { background: rgba(20,30,50,.06); }
.passed-tag  { font-size: 12px; color: #677087; background: rgba(20,30,50,.05); border: 1px solid rgba(20,30,50,.09); padding: 9px 14px; border-radius: 9px; text-align: center; }
.leading-tag { font-size: 13px; font-weight: 700; color: #12A06A; text-align: center; padding: 9px 0; }

/* stamp overlay */
.overlay {
  position: absolute; inset: 0; z-index: 10;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  background: rgba(247,249,252,.86); backdrop-filter: blur(3px); border-radius: 14px;
}
.stamp {
  display: flex; align-items: center; gap: 9px;
  font-size: 30px; font-weight: 850; letter-spacing: .04em;
  padding: 9px 24px; border-radius: 12px; border: 3px solid;
}
.stamp-sold   { color: #B5800F; border-color: #B5800F; }
.stamp-you    { color: #12A06A; border-color: #12A06A; }
.stamp-unsold { color: #DC3A40; border-color: #DC3A40; font-size: 22px; }
.stamp-sub    { font-size: 13px; font-weight: 700; color: #46526B; letter-spacing: .04em; }

/* other teams section */
.teams-section {}
.section-label {
  font-size: 10px; font-weight: 700; letter-spacing: .14em;
  color: #677087; text-transform: uppercase; margin-bottom: 9px;
}
.teams-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

/* team card */
.tc-wrap { position: relative; padding-top: 34px; }
.tc {
  background: #FFFFFF; border: 1px solid rgba(20,30,50,.1);
  border-radius: 12px; padding: 12px 14px;
  box-shadow: 0 1px 6px -3px rgba(20,30,50,.12);
  transition: box-shadow .2s, border-color .2s, background .2s;
}
.tc:hover { box-shadow: 0 4px 14px -5px rgba(20,30,50,.2); }
.tc-lead { background: #FFFFFF; }
.tc-head  { display: flex; align-items: center; gap: 11px; }
.tc-badge {
  width: 40px; height: 40px; border-radius: 9px;
  display: grid; place-items: center; font-weight: 800; font-size: 11px;
  flex: none; letter-spacing: .01em;
}
.tc-info  { min-width: 0; flex: 1; }
.tc-name  {
  font-size: 12.5px; font-weight: 700; color: #1B2436;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tc-sub   { display: flex; align-items: baseline; gap: 7px; margin-top: 3px; min-width: 0; }
.tc-purse { font-weight: 800; font-size: 13px; flex: none; }
.tc-bought { font-size: 10px; color: #677087; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-bought em { font-style: normal; font-weight: 700; }

/* bid toast */
.tc-toast {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  font-size: 14px; font-weight: 850; padding: 5px 12px; border-radius: 8px;
  white-space: nowrap; z-index: 5; letter-spacing: .01em; line-height: 1;
  box-shadow: 0 6px 16px rgba(0,0,0,.45), 0 0 0 2px rgba(20,30,50,.14);
  animation: toastIn .25s cubic-bezier(.2,1.4,.4,1), toastPulse 1.1s ease-in-out .25s infinite;
}
.tc-toast::after {
  content: ""; position: absolute; top: 100%; left: 50%; transform: translateX(-50%);
  border: 6px solid transparent; border-top-color: inherit;
  filter: drop-shadow(0 2px 1px rgba(0,0,0,.3));
}

/* ── RIGHT: panels ── */
.right-col { display: flex; flex-direction: column; gap: 12px; }
.panel {
  background: #FFFFFF; border: 1px solid rgba(20,30,50,.1);
  border-radius: 13px; padding: 13px 13px;
  box-shadow: 0 2px 10px -4px rgba(20,30,50,.12);
}
.ticker {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; display: flex; flex-direction: column; gap: 6px;
  max-height: 180px; overflow-y: auto;
}
.tick     { display: flex; align-items: flex-start; gap: 7px; color: #55617A; line-height: 1.4; }
.tick-new { color: #0E1626; }
.tick-dot { width: 6px; height: 6px; border-radius: 99px; flex: none; margin-top: 4px; }
.sold-list { display: flex; flex-direction: column; gap: 5px; max-height: 200px; overflow-y: auto; }
.sold-row  { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.sold-name  { flex: 1; font-weight: 600; color: #1B2436; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sold-team  { font-weight: 800; font-size: 10.5px; flex-shrink: 0; }
.sold-price { font-weight: 700; color: #B5800F; font-size: 10.5px; flex-shrink: 0; }

/* summary */
.summary { padding: 24px 4px; }
.sum-eye   { font-size: 10.5px; letter-spacing: .18em; color: #677087; font-weight: 700; }
.sum-title { font-family: var(--display-font); text-transform: uppercase; font-size: 40px; font-weight: 800; margin: 6px 0 0; letter-spacing: .01em; }
.sum-stats { display: flex; gap: 24px; margin-top: 14px; flex-wrap: wrap; font-size: 13px; color: #55617A; }
.sum-stats b { font-size: 22px; font-weight: 850; color: #0E1626; display: block; margin-bottom: 2px; }
.squad-chips-row { display: flex; gap: 7px; flex-wrap: wrap; }
.squad-chip {
  font-size: 12px; background: rgba(27,111,203,.14); border: 1px solid rgba(27,111,203,.32);
  color: #2A3850; padding: 5px 10px; border-radius: 8px;
}
.squad-chip b { color: #B5800F; font-weight: 700; margin-left: 3px; }
.sum-rivals {
  display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px;
  border-top: 1px solid rgba(20,30,50,.07); font-size: 12.5px; color: #55617A;
}

/* start overlay */
.start-overlay {
  position: absolute; inset: 0; z-index: 20;
  display: grid; place-items: center;
  background: radial-gradient(600px 400px at 50% 30%, rgba(27,111,203,.12), transparent 60%), rgba(244,247,251,.96);
  border-radius: 16px; padding: 20px;
}
.start-card {
  max-width: 380px; text-align: center;
  background: #FFFFFF;
  border: 1px solid rgba(20,30,50,.12); border-radius: 18px; padding: 28px 26px;
  box-shadow: 0 24px 60px -24px rgba(20,30,50,.3);
}
.start-card-wide { max-width: 480px; }
.start-card h2 { font-size: 26px; font-weight: 850; margin: 0 0 10px; letter-spacing: -.01em; }
.start-card p  { font-size: 13.5px; line-height: 1.6; color: #55617A; margin: 0 0 20px; }
.start-note    { display: block; margin-top: 13px; font-size: 10.5px; color: #6B7488; }

/* team picker grid */
.team-picker {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;
  margin-bottom: 14px;
}
.tp-btn {
  background: rgba(20,30,50,.04);
  border: 1.5px solid; border-radius: 10px;
  padding: 10px 4px; cursor: pointer;
  font-weight: 800; font-size: 11px; letter-spacing: .06em;
  transition: transform .12s, box-shadow .12s, background .12s;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
}
.tp-btn:hover { transform: translateY(-2px); }
.tp-btn.tp-sel { transform: translateY(-1px); }
.tp-short { font-size: 12px; font-weight: 850; }
.tp-selected-name {
  font-size: 12px; font-weight: 700; letter-spacing: .05em;
  min-height: 20px; margin-bottom: 14px;
  transition: color .2s;
}

/* animations */
@keyframes popIn  { 0%{transform:scale(.88);opacity:.3} 60%{transform:scale(1.06)} 100%{transform:scale(1);opacity:1} }
@keyframes toastIn { 0%{transform:translateX(-50%) scale(.7);opacity:0} 65%{transform:translateX(-50%) scale(1.1)} 100%{transform:translateX(-50%) scale(1);opacity:1} }
@keyframes toastPulse { 0%,100%{transform:translateX(-50%) scale(1)} 50%{transform:translateX(-50%) scale(1.08)} }
@keyframes slamIn  { 0%{transform:scale(2.2) rotate(-14deg);opacity:0} 55%{transform:scale(.9) rotate(-9deg);opacity:1} 100%{transform:scale(1) rotate(-7deg)} }
.pop  { animation: popIn  .26s ease-out; }
.slam { animation: slamIn .4s  cubic-bezier(.2,1.4,.4,1); }
@media (prefers-reduced-motion:reduce) { .pop,.slam { animation:none; } }

/* ── Pick XI screen ── */
.pickxi {
  padding: 6px 4px 24px;
}
.pxi-hd {
  display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
  padding-bottom: 16px; margin-bottom: 16px;
  border-bottom: 1px solid rgba(20,30,50,.07);
}
.pxi-title { font-family: var(--display-font); text-transform: uppercase; font-size: 32px; font-weight: 800; letter-spacing: .01em; }
.pxi-sub   { font-size: 12.5px; color: #677087; margin-top: 5px; }
.pxi-warn  { font-size: 11px; color: #DC3A40; font-weight: 700; letter-spacing: .02em; text-align: right; }
.pxi-lock  { font-size: 15px; padding: 11px 22px; }
.pxi-lock:disabled { background: rgba(20,30,50,.06); color: #6B7488; box-shadow: none; cursor: not-allowed; }

.pxi-body  { display: grid; grid-template-columns: 1fr 280px; gap: 16px; align-items: start; }
@media (max-width: 860px) { .pxi-body { grid-template-columns: 1fr; } }

/* pool */
.pxi-pool {}
/* pick-xi sections (replaces flat grid + filter tabs) */
.pxi-sections { display: flex; flex-direction: column; gap: 18px; }
.pxi-sec {}
.pxi-sec-hd {
  display: flex; align-items: center; gap: 8px;
  margin-bottom: 8px;
}
.pxi-sec-dot   { width: 7px; height: 7px; border-radius: 50%; flex: none; }
.pxi-sec-label { font-size: 11px; font-weight: 800; letter-spacing: .08em; }
.pxi-sec-rec   { font-size: 10px; color: #6B7488; margin-left: 2px; }
.pxi-sec-count { margin-left: auto; font-size: 10px; font-weight: 700; color: #6B7488; }
.pxi-sec-row   {
  display: flex; gap: 8px;
  overflow-x: auto; padding-bottom: 4px;
}
.pxi-sec-row::-webkit-scrollbar { height: 3px; }
.pxi-sec-row::-webkit-scrollbar-track { background: transparent; }
.pxi-sec-row::-webkit-scrollbar-thumb { background: rgba(20,30,50,.12); border-radius: 99px; }

/* section player card */
.psc {
  position: relative; flex: none; width: 130px;
  background: #FFFFFF; border: 1px solid;
  border-radius: 10px; padding: 10px 10px 8px;
  cursor: grab; transition: background .13s, border-color .13s, box-shadow .13s;
  box-shadow: 0 1px 5px -3px rgba(20,30,50,.12);
}
.psc:hover { box-shadow: 0 4px 12px -5px rgba(20,30,50,.2); }
.psc-sel   { background: rgba(20,30,50,.07); }
.psc-pos   {
  position: absolute; top: -8px; right: -8px;
  font-size: 9px; font-weight: 850; padding: 2px 6px;
  border-radius: 99px; letter-spacing: .03em;
}
.psc-name  { font-size: 12px; font-weight: 700; color: #1B2436; margin-bottom: 5px; line-height: 1.2;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.psc-chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; min-height: 16px; }
.psc-os    { font-size: 9px; font-weight: 700; color: #677087; background: rgba(20,30,50,.08); padding: 1px 5px; border-radius: 4px; }
.psc-tag   { font-size: 9px; font-weight: 800; letter-spacing: .04em; }
.psc-foot  { display: flex; justify-content: space-between; align-items: baseline; }
.psc-price { font-size: 11px; font-weight: 700; color: #B5800F; }
.psc-rating{ font-size: 10px; color: #6B7488; }

.pxi-filters { display: flex; align-items: center; gap: 7px; margin-bottom: 14px; flex-wrap: wrap; }
.pf-btn {
  border: 1px solid rgba(20,30,50,.12); background: rgba(20,30,50,.04);
  color: #55617A; font-size: 11px; font-weight: 700; letter-spacing: .08em;
  padding: 5px 12px; border-radius: 7px; cursor: pointer; transition: all .15s;
}
.pf-btn:hover  { background: rgba(20,30,50,.08); }
.pf-active     { background: rgba(245,196,81,.14) !important; border-color: rgba(245,196,81,.5) !important; color: #B5800F !important; }
.pf-count      { font-size: 11px; color: #677087; margin-left: auto; }

.ppool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(155px, 1fr));
  gap: 10px;
}
.pcard {
  position: relative; background: rgba(20,30,50,.04);
  border: 1px solid rgba(20,30,50,.08); border-radius: 12px;
  padding: 12px; cursor: pointer;
  transition: border-color .15s, box-shadow .15s, background .15s;
}
.pcard:hover { background: rgba(20,30,50,.07); border-color: rgba(20,30,50,.16); }
.pcard-sel   { background: rgba(20,30,50,.07); }
.pcard-pos   {
  position: absolute; top: -8px; right: -8px;
  font-size: 10px; font-weight: 850; padding: 2px 7px;
  border-radius: 99px; letter-spacing: .02em;
}
.pcard-name   { font-size: 13px; font-weight: 700; color: #1B2436; margin-bottom: 7px; line-height: 1.2; }
.pcard-row    { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.pcard-role   {
  font-size: 10px; font-weight: 800; letter-spacing: .06em;
  padding: 2px 7px; border-radius: 5px; border: 1px solid;
  background: rgba(0,0,0,.3);
}
.pcard-ov     { font-size: 9.5px; font-weight: 700; color: #677087; background: rgba(20,30,50,.07); padding: 2px 6px; border-radius: 4px; }
.pcard-bottom { display: flex; justify-content: space-between; align-items: baseline; }
.pcard-price  { font-size: 11.5px; font-weight: 700; color: #B5800F; }
.pcard-rating { font-size: 11px; color: #677087; }

/* lineup panel */
.pxi-lineup {
  background: #FFFFFF; border: 1px solid rgba(20,30,50,.1);
  border-radius: 14px; padding: 16px; position: sticky; top: 16px;
  box-shadow: 0 2px 12px -5px rgba(20,30,50,.14);
}
.pxi-lineup-title { font-size: 10px; font-weight: 700; letter-spacing: .14em; color: #677087; margin-bottom: 14px; }

/* role balance bars */
.role-bars  { display: flex; flex-direction: column; gap: 7px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(20,30,50,.06); }
.rb-row     { display: flex; align-items: center; gap: 8px; }
.rb-lbl     { font-size: 10px; color: #677087; width: 70px; flex: none; }
.rb-track   { flex: 1; height: 5px; background: rgba(20,30,50,.07); border-radius: 99px; overflow: hidden; }
.rb-fill    { height: 100%; border-radius: 99px; transition: width .3s; }
.rb-val     { font-size: 11px; font-weight: 800; width: 16px; text-align: right; flex: none; }

/* lineup rows */
.lineup-list { display: flex; flex-direction: column; gap: 4px; }
.lineup-row  { display: flex; align-items: center; gap: 10px; padding: 7px 6px; border-radius: 9px; }
.lineup-row:hover { background: rgba(20,30,50,.04); }
.lineup-num  { font-size: 11px; font-weight: 800; width: 18px; text-align: center; flex: none; }
.lineup-num-empty { color: rgba(20,30,50,.2); }
.lineup-info { flex: 1; min-width: 0; }
.lineup-name { font-size: 12.5px; font-weight: 700; color: #1B2436; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lineup-role { font-size: 10px; font-weight: 800; letter-spacing: .04em; }
.lineup-slot { opacity: .4; }
.lineup-slot-hint { font-size: 11px; color: #6B7488; font-style: italic; }
.lineup-arrows { display: flex; flex-direction: column; gap: 2px; flex: none; }
.arr-btn {
  background: rgba(20,30,50,.07); border: none; color: #55617A;
  width: 20px; height: 16px; border-radius: 4px; cursor: pointer; font-size: 8px;
  display: grid; place-items: center; line-height: 1;
  transition: background .12s;
}
.arr-btn:hover:not(:disabled) { background: rgba(20,30,50,.14); }
.arr-btn:disabled { opacity: .25; cursor: default; }

/* ── auction theater additions ── */
/* set chapter strip */
.set-strip {
  display: flex; align-items: center; justify-content: space-between;
  margin: -4px 0 10px; padding: 6px 12px;
  background: rgba(245,196,81,.07); border: 1px solid rgba(245,196,81,.18);
  border-radius: 8px;
}
.set-strip-name { font-size: 11px; font-weight: 800; letter-spacing: .12em; color: #B5800F; }
.set-strip-pos  { font-size: 10.5px; color: #677087; }

.star-pill { background: rgba(245,196,81,.15) !important; color: #B5800F !important; border-color: rgba(245,196,81,.4) !important; }
.chip-arch { color: #3D6FB0; }
.chip-fin  { color: #7E5BE0; border-color: rgba(167,139,250,.35); }

/* real-stat strip */
.stat-strip {
  display: flex; gap: 18px; margin: 10px 0 8px;
  padding: 10px 14px; background: rgba(20,30,50,.03);
  border: 1px solid rgba(20,30,50,.07); border-radius: 10px;
  width: fit-content;
}
.stat-cell { display: flex; flex-direction: column; gap: 1px; }
.stat-val  { font-size: 18px; font-weight: 800; color: #1B2436; font-family: var(--display-font); letter-spacing: .02em; }
.stat-gold { color: #B5800F; }
.stat-lbl  { font-size: 8.5px; font-weight: 700; letter-spacing: .1em; color: #6B7488; }

/* squad-need chip */
.need-chip {
  display: inline-block; margin-bottom: 8px;
  font-size: 11px; font-weight: 700; letter-spacing: .04em;
  padding: 5px 11px; border-radius: 7px; border: 1px solid;
}
.need-yes { color: #12A06A; background: rgba(61,220,151,.08); border-color: rgba(61,220,151,.3); }
.need-no  { color: #6B7488; background: rgba(20,30,50,.03); border-color: rgba(20,30,50,.08); }

/* auctioneer beat */
.going-beat {
  margin-top: 4px; font-size: 13px; font-weight: 900; letter-spacing: .22em;
  color: #DC3A40; animation: beat-pulse .5s ease-in-out infinite alternate;
}
@keyframes beat-pulse { from { opacity: .55; } to { opacity: 1; } }

/* fast-forward button */
.ff-btn {
  width: 100%; margin-top: 8px; min-height: 38px;
  background: rgba(245,196,81,.1); border: 1px solid rgba(245,196,81,.35);
  color: #B5800F; font-size: 12px; font-weight: 700;
  border-radius: 9px; cursor: pointer; padding: 8px 10px;
  transition: background .15s;
}
.ff-btn:hover { background: rgba(245,196,81,.18); }

/* purse depletion bar on team cards */
.tc-bar {
  margin-top: 5px; height: 3px; border-radius: 99px;
  background: rgba(20,30,50,.07); overflow: hidden;
}
.tc-bar-fill { height: 100%; border-radius: 99px; transition: width .4s; }

/* feed entry kinds */
.tick-sold  { color: #B5800F; font-weight: 700; }
.tick-story { color: #3D6FB0; font-style: italic; }
.tick-set   {
  color: #B5800F; font-weight: 800; font-size: 10.5px; letter-spacing: .1em;
  border-top: 1px solid rgba(245,196,81,.25); border-bottom: 1px solid rgba(245,196,81,.25);
  padding: 5px 0; margin: 2px 0;
}

/* ── watchlist screen ── */
.wl { padding: 4px 2px; }
.wl-hd {
  display: flex; justify-content: space-between; align-items: flex-start;
  gap: 16px; margin-bottom: 14px;
}
.wl-hd .pxi-sub { max-width: 560px; line-height: 1.5; }
.wl-actions { display: flex; align-items: center; gap: 14px; flex: none; }
.wl-count { font-size: 13px; font-weight: 800; }
.wl-search {
  width: 100%; margin-bottom: 14px; padding: 10px 14px;
  background: rgba(20,30,50,.05); border: 1px solid rgba(20,30,50,.1);
  border-radius: 10px; color: #1B2436; font-size: 13px; outline: none;
}
.wl-search:focus { border-color: rgba(245,196,81,.4); }
.wl-body { max-height: 60vh; overflow-y: auto; display: flex; flex-direction: column; gap: 16px; padding-right: 6px; }
.wl-set-label {
  font-size: 10px; font-weight: 800; letter-spacing: .12em; color: #B5800F;
  margin-bottom: 7px; padding-bottom: 4px; border-bottom: 1px solid rgba(245,196,81,.15);
}
.wl-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 6px; }
.wl-card {
  display: flex; align-items: center; gap: 8px; text-align: left;
  background: rgba(20,30,50,.03); border: 1px solid rgba(20,30,50,.08);
  border-radius: 9px; padding: 8px 10px; cursor: pointer;
  transition: background .12s, border-color .12s;
}
.wl-card:hover { background: rgba(20,30,50,.07); }
.wl-on { background: rgba(20,30,50,.06); }
.wl-star { font-size: 14px; flex: none; }
.wl-name { font-size: 12px; font-weight: 700; color: #1B2436; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.wl-meta { font-size: 9.5px; color: #6B7488; flex: none; }

/* ── season / league ── */
.season { padding: 4px 2px; }
.season-hd { display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; margin-bottom: 16px; flex-wrap: wrap; }
.season-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.cap-row { display: flex; gap: 8px; }
.cap { font-size: 11px; font-weight: 700; padding: 3px 9px; border-radius: 99px; }
.cap-orange { background: rgba(245,140,30,.14); color: #C2660C; }
.cap-purple { background: rgba(167,139,250,.14); color: #6D4FCF; }

.season-body { display: grid; grid-template-columns: 1fr 360px; gap: 16px; align-items: start; }
@media (max-width: 880px) { .season-body { grid-template-columns: 1fr; } }
.season-results { display: flex; flex-direction: column; gap: 10px; }
.other-results { display: flex; flex-direction: column; gap: 6px; margin-top: 4px; }

/* result card */
.rcard { background: #FFFFFF; border: 1px solid rgba(20,30,50,.1); border-radius: 10px; padding: 9px 12px; box-shadow: 0 1px 6px -3px rgba(20,30,50,.1); }
.rcard-big { padding: 14px 16px; border-width: 1px; }
.rcard-win  { border-color: rgba(61,220,151,.4); background: rgba(61,220,151,.06); }
.rcard-loss { border-color: rgba(255,90,95,.35); background: rgba(255,90,95,.05); }
.rcard-tag { font-size: 10px; font-weight: 800; letter-spacing: .14em; color: #677087; margin-bottom: 8px; }
.rcard-win .rcard-tag { color: #12A06A; }
.rcard-loss .rcard-tag { color: #D64349; }
.rcard-inn { display: flex; align-items: center; gap: 10px; padding: 3px 0; }
.rcard-w .rcard-score { color: #0E1626; font-weight: 800; }
.rcard-badge { font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 5px; flex: none; min-width: 34px; text-align: center; }
.rcard-score { font-family: var(--display-font); font-size: 17px; font-weight: 700; color: #46526B; letter-spacing: .02em; }
.rcard-ov { font-size: 11px; color: #6B7488; font-family: ui-sans-serif, system-ui; }
.rcard-stars { font-size: 11px; color: #677087; margin-left: auto; }
.rcard-result { font-size: 11.5px; color: #3D6FB0; margin-top: 7px; padding-top: 7px; border-top: 1px solid rgba(20,30,50,.06); }
.rcard:not(.rcard-big) .rcard-result { font-size: 10.5px; margin-top: 4px; padding-top: 4px; }

/* points table */
.ptable { background: #FFFFFF; border: 1px solid rgba(20,30,50,.1); border-radius: 12px; padding: 12px 14px; box-shadow: 0 2px 10px -4px rgba(20,30,50,.12); }
.pt-head, .pt-row { display: grid; grid-template-columns: 22px 1fr 22px 22px 22px 52px 32px; align-items: center; gap: 4px; font-size: 12px; }
.pt-head { font-size: 9.5px; font-weight: 700; letter-spacing: .06em; color: #6B7488; padding: 4px 0 7px; border-bottom: 1px solid rgba(20,30,50,.08); }
.pt-row { padding: 6px 0; border-bottom: 1px solid rgba(20,30,50,.04); }
.pt-pos { color: #6B7488; text-align: center; }
.pt-q .pt-pos { color: #12A06A; font-weight: 800; }
.pt-you { background: rgba(245,196,81,.06); border-radius: 6px; }
.pt-badge { font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 5px; }
.pt-nrr { text-align: right; color: #677087; font-size: 11px; }
.pt-pts { text-align: right; font-weight: 800; color: #1B2436; }
.pt-q .pt-pts { color: #12A06A; }
.pt-legend { font-size: 10px; color: #6B7488; margin-top: 8px; display: flex; align-items: center; gap: 6px; }
.pt-q-dot { width: 7px; height: 7px; border-radius: 50%; background: #12A06A; }

/* playoffs bracket */
.bracket { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; }
@media (max-width: 720px) { .bracket { grid-template-columns: 1fr; } }
.tie { background: #FFFFFF; border: 1px solid rgba(20,30,50,.1); border-radius: 12px; padding: 14px; box-shadow: 0 2px 10px -4px rgba(20,30,50,.12); }
.tie-label { font-size: 12px; font-weight: 800; letter-spacing: .08em; color: #B5800F; margin-bottom: 10px; }
.tie-sub { color: #6B7488; font-weight: 600; letter-spacing: 0; }
.tie-pending { font-size: 12px; color: #6B7488; font-style: italic; padding: 8px 0; }
.tie-matchup { display: flex; align-items: center; gap: 12px; }
.tie-v { font-size: 12px; color: #6B7488; }
.tie-play { margin-left: auto; font-size: 12px; padding: 8px 14px; }

/* over-by-over viewer */
.ob { max-width: 620px; margin: 0 auto; padding: 8px 2px; }
.ob-eyebrow { font-size: 11px; font-weight: 800; letter-spacing: .14em; color: #677087; margin-bottom: 14px; text-align: center; }
.ob-board {
  display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 14px;
  background: #FFFFFF; border: 1px solid rgba(20,30,50,.1);
  border-radius: 14px; padding: 16px 20px; margin-bottom: 14px;
  box-shadow: 0 2px 10px -4px rgba(20,30,50,.12);
}
.ob-team { display: flex; align-items: center; gap: 8px; }
.ob-batting { font-size: 11px; color: #6B7488; }
.ob-score { font-family: var(--display-font); font-size: 44px; font-weight: 800; color: #1B2436; line-height: 1; }
.ob-wkts { color: #677087; font-size: 30px; }
.ob-overs { font-size: 13px; color: #677087; font-weight: 600; }
.ob-chase { grid-column: 1 / -1; font-size: 13px; color: #3D6FB0; padding-top: 6px; border-top: 1px solid rgba(20,30,50,.07); }
.ob-chase b { color: #B5800F; }
.ob-won { color: #12A06A; }

.ob-over { background: #FFFFFF; border: 1px solid rgba(20,30,50,.1); border-radius: 12px; padding: 14px 16px; min-height: 90px; box-shadow: 0 1px 6px -3px rgba(20,30,50,.1); }
.ob-start { color: #6B7488; font-style: italic; display: flex; align-items: center; }
.ob-over-head { display: flex; justify-content: space-between; font-size: 12px; color: #677087; margin-bottom: 10px; }
.ob-over-tot { font-weight: 700; color: #46526B; }
.ob-balls { display: flex; gap: 6px; flex-wrap: wrap; }
.ob-ball { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; font-size: 13px; font-weight: 800; font-family: var(--display-font); }
.ob-dot { background: rgba(20,30,50,.06); color: #6B7488; }
.ob-run { background: rgba(20,30,50,.1); color: #46526B; }
.ob-4   { background: rgba(79,195,247,.18); color: #2E86C8; }
.ob-6   { background: rgba(245,196,81,.2); color: #B5800F; }
.ob-w   { background: rgba(255,90,95,.22); color: #D64349; }
.ob-event { margin-top: 9px; font-size: 12px; font-weight: 800; letter-spacing: .04em; }
.ob-event-w { color: #D64349; }
.ob-event-6 { color: #B5800F; }
.ob-controls { display: flex; justify-content: space-between; gap: 10px; margin-top: 16px; }
.ob-break { background: #FFFFFF; border: 1px solid rgba(20,30,50,.1); border-radius: 14px; padding: 22px; text-align: center; margin-bottom: 16px; box-shadow: 0 2px 10px -4px rgba(20,30,50,.12); }
.ob-break-score { font-size: 15px; color: #46526B; }
.ob-break-need { font-size: 14px; color: #3D6FB0; margin-top: 8px; }
.ob-break-score b, .ob-break-need b { font-family: var(--display-font); font-size: 20px; color: #0E1626; }

/* champion screen */
.champion { text-align: center; padding: 40px 20px; }
.champ-badge { display: inline-grid; place-items: center; width: 80px; height: 80px; border-radius: 18px; font-size: 26px; font-weight: 800; font-family: var(--display-font); margin-bottom: 16px; }
.champ-name { font-family: var(--display-font); text-transform: uppercase; font-size: 44px; font-weight: 800; letter-spacing: .01em; margin: 0; }
.champ-sub { font-size: 14px; color: #3D6FB0; margin-top: 8px; }
.finish-pos { font-family: var(--display-font); font-size: 22px; font-weight: 800; letter-spacing: .16em; text-transform: uppercase; margin-bottom: 4px; }
.tie-auto { font-size: 10px; color: #677087; font-style: italic; margin-top: 6px; letter-spacing: .04em; }

/* season report (FinishScreen) */
.report {
  max-width: 560px; margin: 22px auto 0; text-align: left;
  background: #FFFFFF; border: 1px solid rgba(20,30,50,.1); border-radius: 14px;
  padding: 18px 20px; box-shadow: 0 2px 12px -5px rgba(20,30,50,.14);
}
.report-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
.report-cell { display: flex; flex-direction: column; gap: 3px; }
.report-lbl { font-size: 9px; font-weight: 700; letter-spacing: .1em; color: #677087; }
.report-val { font-family: var(--display-font); font-size: 26px; font-weight: 800; color: #1B2436; line-height: 1; }
.report-verdict { margin-top: 14px; font-size: 12px; font-weight: 800; letter-spacing: .12em; text-align: center; }
.report-buys { margin-top: 14px; padding-top: 14px; border-top: 1px solid rgba(20,30,50,.08); display: flex; flex-direction: column; gap: 9px; }
.buy { display: flex; align-items: center; gap: 10px; font-size: 12.5px; color: #46526B; }
.buy-tag { font-size: 8.5px; font-weight: 800; letter-spacing: .06em; padding: 4px 7px; border-radius: 5px; flex: none; width: 74px; text-align: center; }
.buy-best { background: rgba(18,160,106,.12); color: #12A06A; }
.buy-worst { background: rgba(220,58,64,.1); color: #DC3A40; }
.buy-txt { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.buy-txt b { color: #1B2436; }
.finish-actions { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; margin-top: 20px; }

/* budget pace warning banner */
.budget-warn {
  margin: 0 0 10px;
  padding: 9px 14px;
  background: rgba(245,158,11,.12);
  border: 1px solid rgba(245,158,11,.35);
  border-radius: 10px;
  font-size: 12px;
  font-weight: 600;
  color: #fbbf24;
  line-height: 1.4;
}

/* rival teams row on Pick XI page */
.pxi-rivals {
  margin-top: 22px; padding-top: 18px;
  border-top: 1px solid rgba(20,30,50,.07);
}
.rivals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}
.rival-card {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid; background: rgba(20,30,50,.03);
  transition: background .15s;
}
.rival-card:hover { background: rgba(20,30,50,.07); }
.rival-info  { flex: 1; min-width: 0; }
.rival-name  { font-size: 12px; font-weight: 700; color: #1B2436; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rival-meta  { font-size: 11px; color: #6B7488; margin-top: 2px; }
.rival-arrow { font-size: 12px; color: #6B7488; flex: none; }

/* squad-view modal */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 999;
  background: rgba(15,22,38,.5); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
}
.modal-card {
  background: #FFFFFF; border: 1px solid rgba(20,30,50,.14);
  border-radius: 16px; width: 380px; max-width: 96vw;
  max-height: 80vh; display: flex; flex-direction: column;
  overflow: hidden; box-shadow: 0 24px 60px -12px rgba(0,0,0,.7);
}
.modal-head {
  display: flex; align-items: center; gap: 12px;
  padding: 16px 18px; border-bottom: 2px solid;
  flex: none;
}
.modal-close {
  margin-left: auto; background: rgba(20,30,50,.08); border: none;
  color: #55617A; width: 28px; height: 28px; border-radius: 7px;
  cursor: pointer; font-size: 13px; display: grid; place-items: center;
}
.modal-close:hover { background: rgba(20,30,50,.16); color: #0E1626; }
.modal-list {
  overflow-y: auto; padding: 8px 12px 14px;
  display: flex; flex-direction: column; gap: 2px;
}
.modal-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 8px; border-radius: 8px;
}
.modal-row:hover { background: rgba(20,30,50,.05); }
.modal-role  { font-size: 10px; font-weight: 800; letter-spacing: .06em; width: 30px; flex: none; }
.modal-name  { flex: 1; font-size: 13px; font-weight: 600; color: #1B2436; }
.modal-country { font-size: 11px; color: #6B7488; width: 46px; text-align: right; flex: none; }
.modal-price { font-size: 12px; font-weight: 700; color: #B5800F; width: 68px; text-align: right; flex: none; }

/* drag-and-drop + auto-pick (Pick XI) */
.auto-btn {
  border: 1px solid rgba(20,30,50,.16); background: #fff;
  color: #2E86C8; font-size: 12.5px; font-weight: 800; letter-spacing: .01em;
  padding: 11px 16px; border-radius: 10px; cursor: pointer; min-height: 44px;
  transition: background .15s, border-color .15s;
}
.auto-btn:hover { background: rgba(46,134,200,.09); border-color: rgba(46,134,200,.5); }
.pxi-clear { min-height: 44px; }
.psc { cursor: grab; }
.psc:active { cursor: grabbing; }
.pxi-lineup-drop { border-color: #2E86C8 !important; box-shadow: 0 0 0 2px rgba(46,134,200,.3); }
.drop-hint { color: #2E86C8; font-weight: 800; font-size: 10px; letter-spacing: .04em; margin-left: 6px; }
`;
