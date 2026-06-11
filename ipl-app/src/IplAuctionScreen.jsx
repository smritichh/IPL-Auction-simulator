import React, { useState, useEffect, useRef } from "react";
import { Gavel, ChevronRight } from "lucide-react";
import { PLAYERS } from "./players";

const OPEN_TIMER = 7;
const BID_TIMER  = 4.5;
const TICK       = 0.3;
const P_AI       = 0.5;

const TEAMS = [
  { id: "MI",   name: "Mumbai Indians",              short: "MI",   color: "#1B6FCB", text: "#fff",    agg: 1.0  },
  { id: "CSK",  name: "Chennai Super Kings",         short: "CSK",  color: "#F4C430", text: "#10131C", agg: 1.0  },
  { id: "RCB",  name: "Royal Challengers Bengaluru", short: "RCB",  color: "#C8102E", text: "#fff",    agg: 1.12 },
  { id: "KKR",  name: "Kolkata Knight Riders",       short: "KKR",  color: "#6A4C93", text: "#fff",    agg: 0.98 },
  { id: "DC",   name: "Delhi Capitals",              short: "DC",   color: "#2E5EAA", text: "#fff",    agg: 0.92 },
  { id: "SRH",  name: "Sunrisers Hyderabad",         short: "SRH",  color: "#FF7A1A", text: "#10131C", agg: 1.08 },
  { id: "RR",   name: "Rajasthan Royals",            short: "RR",   color: "#E6308A", text: "#fff",    agg: 0.90 },
  { id: "PBKS", name: "Punjab Kings",                short: "PBKS", color: "#D31329", text: "#fff",    agg: 1.10 },
  { id: "GT",   name: "Gujarat Titans",              short: "GT",   color: "#C2A05A", text: "#10131C", agg: 1.0  },
  { id: "LSG",  name: "Lucknow Super Giants",        short: "LSG",  color: "#1FA2C4", text: "#10131C", agg: 1.03 },
];

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
const roleColor = (r) => ({ WK: "#FFB74D", Batter: "#4FC3F7", "All-rounder": "#81C784", Bowler: "#E57373" }[r] ?? "#8A93A8");
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

  // Max price a rival will pay for the lot at index pIdx, given live game state.
  const walkaway = (team, pIdx, g) => {
    const lotsLeft      = PLAYERS.length - pIdx;
    const activeNeeders = needersCount(g);
    return valuation(team, PLAYERS[pIdx], vals[pIdx][team.id], lotsLeft, activeNeeders);
  };

  const initGame = (teamId = "MI") => ({
    userTeamId: teamId,
    phase:      "bidding",
    index:      0,
    asking:     PLAYERS[0].base,
    bid:        null,
    leader:     null,
    timer:      OPEN_TIMER,
    tmax:       OPEN_TIMER,
    userPassed: false,
    teams:      TEAMS.map((t) => ({ ...t, isUser: t.id === teamId, purse: 120, squad: [], bias: makeBias() })),
    ticker:     [{ id: "sys", text: `On the block — ${PLAYERS[0].name}` }],
    soldLog:    [],
    lastSold:   null,
    recentBid:  {},
  });

  const [game, setGame]       = useState(() => initGame("MI"));
  const [started, setStarted] = useState(false); // false = show team picker
  const [squadView, setSquadView] = useState(null); // teamId whose squad modal is open

  // apConfirmRef lets tick() read the latest confirm state without
  // needing to be in its dependency array (avoids restarting the interval).
  const apConfirmRef = useRef(false);

  const resolve = (g) => {
    const p = PLAYERS[g.index];
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
        ticker:   [{ id: g.leader, text: `SOLD — ${p.name} → ${won.short} ${cr(price)}` }, ...g.ticker].slice(0, 12),
      };
    }
    return {
      ...g, phase: "sold",
      lastSold: { player: p, unsold: true },
      ticker:   [{ id: "sys", text: `UNSOLD — ${p.name}` }, ...g.ticker].slice(0, 12),
    };
  };

  const tick = (g) => {
    // Freeze the auction while the autopilot confirm dialog is open so
    // the user doesn't lose lots between clicking the button and confirming.
    if (g.phase !== "bidding" || apConfirmRef.current) return g;
    const p       = PLAYERS[g.index];
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
        // Jump bid: hot/aggressive teams leap ahead to scare you off.
        // Higher probability (40%) than before to create more pressure.
        let newBid = g.asking;
        if (Math.random() < 0.40 && wa >= g.asking + inc(g.asking) * 2) {
          newBid = round2(g.asking + inc(g.asking));
        }
        newBid = round2(Math.min(newBid, wa, actor.purse));
        return {
          ...g,
          leader:    actor.id,
          bid:       newBid,
          asking:    round2(newBid + inc(newBid)),
          timer:     BID_TIMER,
          tmax:      BID_TIMER,
          recentBid: { ...g.recentBid, [actor.id]: { amount: newBid, uid: Date.now() } },
          ticker:    [{ id: actor.id, text: `${actor.short} bids ${cr(newBid)}` }, ...g.ticker].slice(0, 12),
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

  useEffect(() => {
    if (game.phase !== "sold") return;
    const id = setTimeout(() => {
      setGame((g) => {
        const ni = g.index + 1;
        if (ni >= PLAYERS.length) return { ...g, phase: "pickxi" };
        const np = PLAYERS[ni];
        return {
          ...g,
          phase:      "bidding",
          index:      ni,
          asking:     np.base,
          bid:        null,
          leader:     null,
          timer:      OPEN_TIMER,
          tmax:       OPEN_TIMER,
          userPassed: false,
          recentBid:  {},
          lastSold:   null,
          ticker:     [{ id: "sys", text: `On the block — ${np.name}` }, ...g.ticker].slice(0, 12),
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
        timer:     BID_TIMER,
        tmax:      BID_TIMER,
        ticker:    [{ id: g.userTeamId, text: `You bid ${cr(newBid)}` }, ...g.ticker].slice(0, 12),
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
      if (Math.random() < 0.22 && wa >= s.asking + inc(s.asking) * 2) {
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

  // Autopilot: simulate every remaining lot with ALL 10 teams — including the
  // user's — bidding via the same squad-need valuation. No team is guaranteed
  // wins; the budget-pacing + marginal-need engine makes every franchise build
  // a balanced 18-22 squad and spend ~90-100% of its purse (see data/sim_test.mjs).
  const simulateAllRemainingLots = (g) => {
    let state = { ...g };

    // If the current lot is already resolved (sold/unsold), start from next lot
    // so we don't re-resolve the same player.
    const startIdx = state.phase === "sold" ? state.index + 1 : state.index;

    // Nothing left to simulate — go straight to Pick XI
    if (startIdx >= PLAYERS.length) return { ...state, phase: "pickxi" };

    for (let lotIdx = startIdx; lotIdx < PLAYERS.length; lotIdx++) {
      const p             = PLAYERS[lotIdx];
      const lotsLeft      = PLAYERS.length - lotIdx;
      const activeNeeders = needersCount(state);

      let s = {
        ...state,
        phase: "bidding", index: lotIdx,
        asking: p.base, bid: null, leader: null,
        userPassed: false, recentBid: {}, lastSold: null,
        ticker: [{ id: "sys", text: `Auto — ${p.name}` }, ...state.ticker].slice(0, 12),
      };

      const getWA = (t) => valuation(t, p, vals[lotIdx][t.id], lotsLeft, activeNeeders);

      for (let i = 0; i < 400; i++) {
        const cand    = s.teams.filter((t) => t.id !== s.leader && t.squad.length < MAX_SQUAD && t.purse >= s.asking);
        const willing = cand.filter((t) => getWA(t) >= s.asking);
        if (!willing.length) break;
        willing.sort((a, b) => getWA(b) - getWA(a));
        const top    = willing.slice(0, Math.min(3, willing.length));
        const actor  = top[Math.floor(Math.random() * top.length)];
        const wa     = getWA(actor);
        let newBid   = s.asking;
        if (Math.random() < 0.25 && wa >= s.asking + inc(s.asking) * 2)
          newBid = round2(s.asking + inc(s.asking));
        newBid = round2(Math.min(newBid, wa, actor.purse));
        s = { ...s, leader: actor.id, bid: newBid, asking: round2(newBid + inc(newBid)) };
      }

      state = resolve(s);
    }

    return { ...state, phase: "pickxi" };
  };

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

  const lockXI  = (xi) => setGame((g) => ({ ...g, phase: "done", xi }));
  // restart goes back to team picker
  const restart = () => { setStarted(false); showApConfirm(false); };

  const me         = game.teams.find((t) => t.isUser);
  const myTeamDef  = TEAMS.find((t) => t.id === game.userTeamId);
  const p          = PLAYERS[game.index];
  const frac       = game.timer / game.tmax;
  const ringColor  = frac < 0.3 ? "#FF5A5F" : game.leader === game.userTeamId ? "#3DDC97" : "#F5C451";
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
            <div className="hd-stat-val">{game.index + 1} / {PLAYERS.length}</div>
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
        const lotsLeft    = PLAYERS.length - game.index;
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
              <div className="stage-eyebrow">
                <span>LOT {String(game.index + 1).padStart(2, "0")} / {String(PLAYERS.length).padStart(2, "0")}</span>
                <span className="tier-pill">{tierLabel(p.tier)}</span>
              </div>

              <h1 className="stage-name">{p.name}</h1>

              <div className="stage-chips">
                <span className="chip">{p.role}</span>
                <span className="chip">{p.country}{p.overseas ? " · Overseas" : ""}</span>
              </div>

              <div className="stage-main">
                <div className="stage-left">
                  {/* Timer ring */}
                  <div className="ring-wrap">
                    <svg width="92" height="92" viewBox="0 0 92 92">
                      <circle cx="46" cy="46" r={R} stroke="rgba(255,255,255,.08)" strokeWidth="6" fill="none" />
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
                    <div className="bid-base">base {cr(p.base)} · reserve {cr(p.mv * 0.6)}</div>
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
                      {TEAMS.find((t) => t.id === game.lastSold.teamId).name} · {cr(game.lastSold.price)}
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
                  return (
                    <div key={i} className={`tick${i === 0 ? " tick-new" : ""}`}>
                      <span className="tick-dot" style={{ background: tm ? tm.color : "#5b647a" }} />
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
                  <div style={{ fontSize: 12, color: "#8A93A8" }}>{squad.length} players · {cr(ts.purse)} left</div>
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
                        <span className="modal-country" style={{ color: s.overseas ? "#F5C451" : "#6B7488" }}>{s.country}{s.overseas ? " ✈" : ""}</span>
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

function Summary({ me, teams, onRestart }) {
  const spent  = round2(120 - me.purse);
  const sorted = [...teams].sort((a, b) => b.squad.length - a.squad.length);
  return (
    <div className="summary">
      <div className="sum-eye">AUCTION COMPLETE</div>
      <h1 className="sum-title">Your squad is set</h1>
      <div className="sum-stats">
        <div><b>{me.squad.length}</b> players won</div>
        <div><b style={{ color: "#F5C451" }}>{cr(spent)}</b> spent</div>
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
    { id: "wk",       label: "Wicketkeeper",           rec: "need 1",   color: "#FFB74D" },
    { id: "opener",   label: "Openers / Top Order",    rec: "pick 2–3", color: "#4FC3F7" },
    { id: "middle",   label: "Middle Order",           rec: "pick 1–2", color: "#4FC3F7" },
    { id: "finisher", label: "Finishers",              rec: "pick 1–2", color: "#a78bfa" },
    { id: "allround", label: "All-rounders",           rec: "pick 2–3", color: "#81C784" },
    { id: "pace",     label: "Pace Bowlers",           rec: "pick 2–3", color: "#E57373" },
    { id: "spin",     label: "Spin Bowlers",           rec: "pick 1–2", color: "#fb923c" },
    { id: "lower",    label: "Lower Order",            rec: "",         color: "#8A93A8" },
  ];

  // Group squad into sections (only show sections that have players)
  const squadBySec = {};
  squad.forEach((p) => {
    const s = sectionOf(p);
    (squadBySec[s] = squadBySec[s] || []).push(p);
  });

  const roleCounts = { WK: 0, Batter: 0, "All-rounder": 0, Bowler: 0 };
  lineup.forEach((p) => { roleCounts[p.role] = (roleCounts[p.role] || 0) + 1; });

  const canLock = lineup.length === 11;

  // Warn about common XI errors
  const warnings = [];
  if (lineup.length > 0 && roleCounts.WK === 0)   warnings.push("No wicket-keeper");
  if (roleCounts.Bowler < 4)                       warnings.push("Too few bowlers (need ≥ 4)");
  if ((roleCounts.WK + roleCounts.Batter) > 6)    warnings.push("Too many pure batters");

  return (
    <div className="pickxi">
      {/* ── header ── */}
      <div className="pxi-hd">
        <div>
          <div className="pxi-title">Pick Your XI</div>
          <div className="pxi-sub">
            {squad.length} players · {selSet.size}/11 selected · tap a player to add to batting order
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
          {warnings.length > 0 && <div className="pxi-warn">{warnings[0]}</div>}
          <button className="bid-btn pxi-lock" onClick={() => onLock(lineup)} disabled={!canLock}>
            {canLock ? "Lock XI →" : `${lineup.length} / 11 selected`}
          </button>
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
                            style={isSel ? { borderColor: sec.color, boxShadow: `0 0 0 1px ${sec.color}55` } : { borderColor: "rgba(255,255,255,.08)" }}
                            onClick={() => toggle(p)}
                          >
                            {isSel && (
                              <span className="psc-pos" style={{ background: sec.color, color: "#0B1120" }}>#{pos + 1}</span>
                            )}
                            <div className="psc-name">{p.name}</div>
                            <div className="psc-chips">
                              {p.overseas && <span className="psc-os">OS</span>}
                              {p.finisher && <span className="psc-tag" style={{ color: "#a78bfa" }}>FIN</span>}
                              {p.deathSpec && <span className="psc-tag" style={{ color: "#E57373" }}>DEATH</span>}
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

        {/* RIGHT — batting order */}
        <div className="pxi-lineup">
          <div className="pxi-lineup-title">BATTING ORDER</div>

          {/* Role balance bars */}
          <div className="role-bars">
            {[
              ["Batters",      roleCounts.Batter        || 0, 5, "#4FC3F7"],
              ["All-rounders", roleCounts["All-rounder"] || 0, 3, "#81C784"],
              ["WK",           roleCounts.WK             || 0, 2, "#FFB74D"],
              ["Bowlers",      roleCounts.Bowler         || 0, 5, "#E57373"],
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
                <span className="lineup-slot-hint">pick a player from your squad</span>
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
                  <div style={{ fontSize: 12, color: "#8A93A8" }}>{sq.length} players · {cr(ts.purse)} left</div>
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
                        <span className="modal-country" style={{ color: s.overseas ? "#F5C451" : "#6B7488" }}>{s.country}{s.overseas ? " ✈" : ""}</span>
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
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
  color: #EAEEF7;
  background:
    radial-gradient(900px 400px at 30% 0%, rgba(245,196,81,.08), transparent 55%),
    radial-gradient(600px 500px at 100% 0%, rgba(27,111,203,.13), transparent 50%),
    linear-gradient(180deg, #0B1120, #070A14 70%);
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
  border-bottom: 1px solid rgba(255,255,255,.07);
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
.hd-sub    { font-size: 11px; color: #8A93A8; }
.hd-stats  { display: flex; gap: 8px; }
.hd-stat   {
  background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.07);
  border-radius: 10px; padding: 6px 12px;
}
.hd-stat-gold {
  background: linear-gradient(150deg, rgba(245,196,81,.14), rgba(245,196,81,.04));
  border-color: rgba(245,196,81,.3);
}
.hd-stat-lbl { font-size: 9.5px; color: #8A93A8; letter-spacing: .1em; text-transform: uppercase; }
.hd-stat-val { font-weight: 800; font-size: 15px; margin-top: 1px; }
.hd-stat-gold .hd-stat-val { color: #F5C451; }

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
  background: rgba(255,255,255,.03);
  border: 1px solid rgba(255,255,255,.07);
  border-radius: 13px;
  padding: 13px 13px;
  min-height: 400px;
}
.panel-title {
  font-size: 10px; font-weight: 700; letter-spacing: .14em;
  color: #8A93A8; text-transform: uppercase; margin-bottom: 11px;
  display: flex; justify-content: space-between;
}
.panel-title span { color: #F5C451; }
.squad-list { display: flex; flex-direction: column; gap: 8px; }
.squad-item {
  background: rgba(27,111,203,.12); border: 1px solid rgba(27,111,203,.3);
  border-radius: 9px; padding: 8px 10px;
}
.squad-item-name { font-size: 12.5px; font-weight: 700; }
.squad-item-meta { display: flex; justify-content: space-between; margin-top: 3px; }
.squad-role  { font-size: 10.5px; color: #8A93A8; }
.squad-price { font-size: 11px; font-weight: 700; color: #F5C451; }
.empty-hint  { font-size: 12px; color: #6B7488; line-height: 1.5; margin: 0; }

/* ── CENTER ── */
.center { display: flex; flex-direction: column; gap: 12px; }

/* player stage */
.stage {
  position: relative;
  background: linear-gradient(160deg, rgba(255,255,255,.055), rgba(255,255,255,.02));
  border: 1px solid rgba(255,255,255,.1);
  border-radius: 15px;
  padding: 18px 20px;
  overflow: hidden;
  box-shadow: 0 0 50px -20px rgba(245,196,81,.12);
}
.stage::before {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: radial-gradient(500px 180px at 50% 0%, rgba(245,196,81,.09), transparent 65%);
}
.stage-eyebrow {
  display: flex; align-items: center; gap: 10px;
  font-size: 10.5px; letter-spacing: .16em; color: #8A93A8; font-weight: 700;
}
.tier-pill {
  color: #F5C451; border: 1px solid rgba(245,196,81,.4);
  padding: 2px 8px; border-radius: 99px; background: rgba(245,196,81,.08);
  font-size: 10px;
}
.stage-name {
  font-size: clamp(28px, 4vw, 42px); font-weight: 850;
  letter-spacing: -.025em; margin: 8px 0 0; line-height: 1;
}
.stage-chips { display: flex; gap: 7px; margin-top: 9px; flex-wrap: wrap; }
.chip {
  font-size: 11.5px; background: rgba(255,255,255,.06);
  border: 1px solid rgba(255,255,255,.08); padding: 3px 10px;
  border-radius: 99px; color: #C7CEDD;
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
.bid-lbl    { font-size: 10px; letter-spacing: .15em; color: #8A93A8; font-weight: 700; }
.bid-num    { font-size: clamp(26px, 4vw, 44px); font-weight: 850; letter-spacing: -.02em; color: #F5C451; line-height: 1.05; }
.bid-leader { margin-top: 5px; font-size: 12.5px; font-weight: 700; }
.lead-you   { color: #3DDC97; }
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
  background: #1B6FCB; color: #fff; box-shadow: 0 3px 10px -3px rgba(27,111,203,.7);
}
.user-pod-name  { font-size: 14px; font-weight: 800; color: #EAEEF7; line-height: 1.1; }
.user-pod-purse { font-size: 11px; font-weight: 600; color: #7FB0E6; margin-top: 2px; }
.controls   { display: flex; flex-direction: column; gap: 7px; }
.controls .bid-btn { justify-content: center; width: 100%; }
.controls .out-btn { width: 100%; text-align: center; }

/* autopilot */
.ap-wrap { margin-top: 10px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.07); }
.ap-btn {
  width: 100%; background: rgba(255,255,255,.05);
  border: 1px solid rgba(255,255,255,.12); color: #AEB6C7;
  font-size: 11.5px; font-weight: 700; padding: 8px 12px; border-radius: 9px;
  cursor: pointer; letter-spacing: .01em; transition: background .15s, border-color .15s;
}
.ap-btn:hover { background: rgba(255,255,255,.09); border-color: rgba(255,255,255,.22); color: #EAEEF7; }
.ap-confirm { display: flex; flex-direction: column; gap: 8px; }
.ap-confirm-txt { font-size: 11px; color: #AEB6C7; text-align: center; line-height: 1.4; }
.ap-confirm-btns { display: flex; gap: 7px; }
.ap-yes {
  flex: 1; background: linear-gradient(150deg,#4FC3F7,#1e90c7); border: none;
  color: #0B1120; font-weight: 800; font-size: 12px; padding: 8px; border-radius: 8px;
  cursor: pointer; transition: filter .15s;
}
.ap-yes:hover { filter: brightness(1.1); }
.ap-no {
  flex: 1; background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.12);
  color: #AEB6C7; font-size: 12px; font-weight: 600; padding: 8px; border-radius: 8px;
  cursor: pointer;
}
.ap-no:hover { background: rgba(255,255,255,.1); }
.bid-btn {
  border: none; cursor: pointer;
  background: linear-gradient(155deg,#F5C451,#D89B22); color: #1a1304;
  font-weight: 800; font-size: 14px; padding: 11px 20px; border-radius: 10px;
  box-shadow: 0 8px 20px -8px rgba(245,196,81,.65);
  transition: filter .15s, transform .08s;
  display: inline-flex; align-items: center; gap: 6px;
}
.bid-btn:hover:not(:disabled) { filter: brightness(1.07); }
.bid-btn:active:not(:disabled) { transform: scale(.98); }
.bid-btn:disabled { background: rgba(255,255,255,.06); color: #6B7488; box-shadow: none; cursor: not-allowed; }
.out-btn {
  border: 1px solid rgba(255,255,255,.15); background: transparent;
  color: #C7CEDD; cursor: pointer; font-size: 12.5px; font-weight: 600;
  padding: 9px 16px; border-radius: 9px; transition: background .15s;
}
.out-btn:hover { background: rgba(255,255,255,.06); }
.passed-tag  { font-size: 12px; color: #8A93A8; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.09); padding: 9px 14px; border-radius: 9px; text-align: center; }
.leading-tag { font-size: 13px; font-weight: 700; color: #3DDC97; text-align: center; padding: 9px 0; }

/* stamp overlay */
.overlay {
  position: absolute; inset: 0; z-index: 10;
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px;
  background: rgba(7,10,20,.78); backdrop-filter: blur(3px); border-radius: 14px;
}
.stamp {
  display: flex; align-items: center; gap: 9px;
  font-size: 30px; font-weight: 850; letter-spacing: .04em;
  padding: 9px 24px; border-radius: 12px; border: 3px solid;
}
.stamp-sold   { color: #F5C451; border-color: #F5C451; }
.stamp-you    { color: #3DDC97; border-color: #3DDC97; }
.stamp-unsold { color: #FF5A5F; border-color: #FF5A5F; font-size: 22px; }
.stamp-sub    { font-size: 13px; font-weight: 700; color: #C7CEDD; letter-spacing: .04em; }

/* other teams section */
.teams-section {}
.section-label {
  font-size: 10px; font-weight: 700; letter-spacing: .14em;
  color: #8A93A8; text-transform: uppercase; margin-bottom: 9px;
}
.teams-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}

/* team card */
.tc-wrap { position: relative; padding-top: 34px; }
.tc {
  background: rgba(255,255,255,.04); border: 1px solid rgba(255,255,255,.08);
  border-radius: 12px; padding: 12px 14px;
  transition: box-shadow .2s, border-color .2s, background .2s;
}
.tc-lead { background: rgba(255,255,255,.07); }
.tc-head  { display: flex; align-items: center; gap: 11px; }
.tc-badge {
  width: 40px; height: 40px; border-radius: 9px;
  display: grid; place-items: center; font-weight: 800; font-size: 11px;
  flex: none; letter-spacing: .01em;
}
.tc-info  { min-width: 0; flex: 1; }
.tc-name  {
  font-size: 12.5px; font-weight: 700; color: #EAEEF7;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tc-sub   { display: flex; align-items: baseline; gap: 7px; margin-top: 3px; min-width: 0; }
.tc-purse { font-weight: 800; font-size: 13px; flex: none; }
.tc-bought { font-size: 10px; color: #8A93A8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tc-bought em { font-style: normal; font-weight: 700; }

/* bid toast */
.tc-toast {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  font-size: 14px; font-weight: 850; padding: 5px 12px; border-radius: 8px;
  white-space: nowrap; z-index: 5; letter-spacing: .01em; line-height: 1;
  box-shadow: 0 6px 16px rgba(0,0,0,.45), 0 0 0 2px rgba(255,255,255,.14);
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
  background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07);
  border-radius: 13px; padding: 13px 13px;
}
.ticker {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; display: flex; flex-direction: column; gap: 6px;
  max-height: 180px; overflow-y: auto;
}
.tick     { display: flex; align-items: flex-start; gap: 7px; color: #AEB6C7; line-height: 1.4; }
.tick-new { color: #fff; }
.tick-dot { width: 6px; height: 6px; border-radius: 99px; flex: none; margin-top: 4px; }
.sold-list { display: flex; flex-direction: column; gap: 5px; max-height: 200px; overflow-y: auto; }
.sold-row  { display: flex; align-items: center; gap: 6px; font-size: 11.5px; }
.sold-name  { flex: 1; font-weight: 600; color: #EAEEF7; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sold-team  { font-weight: 800; font-size: 10.5px; flex-shrink: 0; }
.sold-price { font-weight: 700; color: #F5C451; font-size: 10.5px; flex-shrink: 0; }

/* summary */
.summary { padding: 24px 4px; }
.sum-eye   { font-size: 10.5px; letter-spacing: .18em; color: #8A93A8; font-weight: 700; }
.sum-title { font-size: 34px; font-weight: 850; margin: 6px 0 0; letter-spacing: -.02em; }
.sum-stats { display: flex; gap: 24px; margin-top: 14px; flex-wrap: wrap; font-size: 13px; color: #AEB6C7; }
.sum-stats b { font-size: 22px; font-weight: 850; color: #fff; display: block; margin-bottom: 2px; }
.squad-chips-row { display: flex; gap: 7px; flex-wrap: wrap; }
.squad-chip {
  font-size: 12px; background: rgba(27,111,203,.14); border: 1px solid rgba(27,111,203,.32);
  color: #dfe7f5; padding: 5px 10px; border-radius: 8px;
}
.squad-chip b { color: #F5C451; font-weight: 700; margin-left: 3px; }
.sum-rivals {
  display: flex; gap: 12px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px;
  border-top: 1px solid rgba(255,255,255,.07); font-size: 12.5px; color: #AEB6C7;
}

/* start overlay */
.start-overlay {
  position: absolute; inset: 0; z-index: 20;
  display: grid; place-items: center;
  background: radial-gradient(600px 400px at 50% 30%, rgba(27,111,203,.16), transparent 60%), rgba(7,10,20,.93);
  border-radius: 16px; padding: 20px;
}
.start-card {
  max-width: 380px; text-align: center;
  background: linear-gradient(160deg, rgba(255,255,255,.07), rgba(255,255,255,.02));
  border: 1px solid rgba(255,255,255,.1); border-radius: 18px; padding: 28px 26px;
}
.start-card-wide { max-width: 480px; }
.start-card h2 { font-size: 26px; font-weight: 850; margin: 0 0 10px; letter-spacing: -.01em; }
.start-card p  { font-size: 13.5px; line-height: 1.6; color: #AEB6C7; margin: 0 0 20px; }
.start-note    { display: block; margin-top: 13px; font-size: 10.5px; color: #6B7488; }

/* team picker grid */
.team-picker {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;
  margin-bottom: 14px;
}
.tp-btn {
  background: rgba(255,255,255,.04);
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
  border-bottom: 1px solid rgba(255,255,255,.07);
}
.pxi-title { font-size: 28px; font-weight: 850; letter-spacing: -.02em; }
.pxi-sub   { font-size: 12.5px; color: #8A93A8; margin-top: 5px; }
.pxi-warn  { font-size: 11px; color: #FF5A5F; font-weight: 700; letter-spacing: .02em; text-align: right; }
.pxi-lock  { font-size: 15px; padding: 11px 22px; }
.pxi-lock:disabled { background: rgba(255,255,255,.06); color: #6B7488; box-shadow: none; cursor: not-allowed; }

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
.pxi-sec-row::-webkit-scrollbar-thumb { background: rgba(255,255,255,.12); border-radius: 99px; }

/* section player card */
.psc {
  position: relative; flex: none; width: 130px;
  background: rgba(255,255,255,.04); border: 1px solid;
  border-radius: 10px; padding: 10px 10px 8px;
  cursor: pointer; transition: background .13s, border-color .13s, box-shadow .13s;
}
.psc:hover { background: rgba(255,255,255,.08); }
.psc-sel   { background: rgba(255,255,255,.07); }
.psc-pos   {
  position: absolute; top: -8px; right: -8px;
  font-size: 9px; font-weight: 850; padding: 2px 6px;
  border-radius: 99px; letter-spacing: .03em;
}
.psc-name  { font-size: 12px; font-weight: 700; color: #EAEEF7; margin-bottom: 5px; line-height: 1.2;
             white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.psc-chips { display: flex; gap: 4px; flex-wrap: wrap; margin-bottom: 6px; min-height: 16px; }
.psc-os    { font-size: 9px; font-weight: 700; color: #8A93A8; background: rgba(255,255,255,.08); padding: 1px 5px; border-radius: 4px; }
.psc-tag   { font-size: 9px; font-weight: 800; letter-spacing: .04em; }
.psc-foot  { display: flex; justify-content: space-between; align-items: baseline; }
.psc-price { font-size: 11px; font-weight: 700; color: #F5C451; }
.psc-rating{ font-size: 10px; color: #6B7488; }

.pxi-filters { display: flex; align-items: center; gap: 7px; margin-bottom: 14px; flex-wrap: wrap; }
.pf-btn {
  border: 1px solid rgba(255,255,255,.12); background: rgba(255,255,255,.04);
  color: #AEB6C7; font-size: 11px; font-weight: 700; letter-spacing: .08em;
  padding: 5px 12px; border-radius: 7px; cursor: pointer; transition: all .15s;
}
.pf-btn:hover  { background: rgba(255,255,255,.08); }
.pf-active     { background: rgba(245,196,81,.14) !important; border-color: rgba(245,196,81,.5) !important; color: #F5C451 !important; }
.pf-count      { font-size: 11px; color: #8A93A8; margin-left: auto; }

.ppool-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(155px, 1fr));
  gap: 10px;
}
.pcard {
  position: relative; background: rgba(255,255,255,.04);
  border: 1px solid rgba(255,255,255,.08); border-radius: 12px;
  padding: 12px; cursor: pointer;
  transition: border-color .15s, box-shadow .15s, background .15s;
}
.pcard:hover { background: rgba(255,255,255,.07); border-color: rgba(255,255,255,.16); }
.pcard-sel   { background: rgba(255,255,255,.07); }
.pcard-pos   {
  position: absolute; top: -8px; right: -8px;
  font-size: 10px; font-weight: 850; padding: 2px 7px;
  border-radius: 99px; letter-spacing: .02em;
}
.pcard-name   { font-size: 13px; font-weight: 700; color: #EAEEF7; margin-bottom: 7px; line-height: 1.2; }
.pcard-row    { display: flex; align-items: center; gap: 6px; margin-bottom: 8px; }
.pcard-role   {
  font-size: 10px; font-weight: 800; letter-spacing: .06em;
  padding: 2px 7px; border-radius: 5px; border: 1px solid;
  background: rgba(0,0,0,.3);
}
.pcard-ov     { font-size: 9.5px; font-weight: 700; color: #8A93A8; background: rgba(255,255,255,.07); padding: 2px 6px; border-radius: 4px; }
.pcard-bottom { display: flex; justify-content: space-between; align-items: baseline; }
.pcard-price  { font-size: 11.5px; font-weight: 700; color: #F5C451; }
.pcard-rating { font-size: 11px; color: #8A93A8; }

/* lineup panel */
.pxi-lineup {
  background: rgba(255,255,255,.03); border: 1px solid rgba(255,255,255,.07);
  border-radius: 14px; padding: 16px; position: sticky; top: 16px;
}
.pxi-lineup-title { font-size: 10px; font-weight: 700; letter-spacing: .14em; color: #8A93A8; margin-bottom: 14px; }

/* role balance bars */
.role-bars  { display: flex; flex-direction: column; gap: 7px; margin-bottom: 16px; padding-bottom: 16px; border-bottom: 1px solid rgba(255,255,255,.06); }
.rb-row     { display: flex; align-items: center; gap: 8px; }
.rb-lbl     { font-size: 10px; color: #8A93A8; width: 70px; flex: none; }
.rb-track   { flex: 1; height: 5px; background: rgba(255,255,255,.07); border-radius: 99px; overflow: hidden; }
.rb-fill    { height: 100%; border-radius: 99px; transition: width .3s; }
.rb-val     { font-size: 11px; font-weight: 800; width: 16px; text-align: right; flex: none; }

/* lineup rows */
.lineup-list { display: flex; flex-direction: column; gap: 4px; }
.lineup-row  { display: flex; align-items: center; gap: 10px; padding: 7px 6px; border-radius: 9px; }
.lineup-row:hover { background: rgba(255,255,255,.04); }
.lineup-num  { font-size: 11px; font-weight: 800; width: 18px; text-align: center; flex: none; }
.lineup-num-empty { color: rgba(255,255,255,.2); }
.lineup-info { flex: 1; min-width: 0; }
.lineup-name { font-size: 12.5px; font-weight: 700; color: #EAEEF7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.lineup-role { font-size: 10px; font-weight: 800; letter-spacing: .04em; }
.lineup-slot { opacity: .4; }
.lineup-slot-hint { font-size: 11px; color: #6B7488; font-style: italic; }
.lineup-arrows { display: flex; flex-direction: column; gap: 2px; flex: none; }
.arr-btn {
  background: rgba(255,255,255,.07); border: none; color: #AEB6C7;
  width: 20px; height: 16px; border-radius: 4px; cursor: pointer; font-size: 8px;
  display: grid; place-items: center; line-height: 1;
  transition: background .12s;
}
.arr-btn:hover:not(:disabled) { background: rgba(255,255,255,.14); }
.arr-btn:disabled { opacity: .25; cursor: default; }

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
  border-top: 1px solid rgba(255,255,255,.07);
}
.rivals-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 8px;
}
.rival-card {
  display: flex; align-items: center; gap: 10px;
  padding: 10px 12px; border-radius: 10px;
  border: 1px solid; background: rgba(255,255,255,.03);
  transition: background .15s;
}
.rival-card:hover { background: rgba(255,255,255,.07); }
.rival-info  { flex: 1; min-width: 0; }
.rival-name  { font-size: 12px; font-weight: 700; color: #EAEEF7; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.rival-meta  { font-size: 11px; color: #6B7488; margin-top: 2px; }
.rival-arrow { font-size: 12px; color: #6B7488; flex: none; }

/* squad-view modal */
.modal-backdrop {
  position: fixed; inset: 0; z-index: 999;
  background: rgba(0,0,0,.65); backdrop-filter: blur(4px);
  display: flex; align-items: center; justify-content: center;
}
.modal-card {
  background: #111827; border: 1px solid rgba(255,255,255,.12);
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
  margin-left: auto; background: rgba(255,255,255,.08); border: none;
  color: #AEB6C7; width: 28px; height: 28px; border-radius: 7px;
  cursor: pointer; font-size: 13px; display: grid; place-items: center;
}
.modal-close:hover { background: rgba(255,255,255,.16); color: #fff; }
.modal-list {
  overflow-y: auto; padding: 8px 12px 14px;
  display: flex; flex-direction: column; gap: 2px;
}
.modal-row {
  display: flex; align-items: center; gap: 10px;
  padding: 7px 8px; border-radius: 8px;
}
.modal-row:hover { background: rgba(255,255,255,.05); }
.modal-role  { font-size: 10px; font-weight: 800; letter-spacing: .06em; width: 30px; flex: none; }
.modal-name  { flex: 1; font-size: 13px; font-weight: 600; color: #EAEEF7; }
.modal-country { font-size: 11px; color: #6B7488; width: 46px; text-align: right; flex: none; }
.modal-price { font-size: 12px; font-weight: 700; color: #F5C451; width: 68px; text-align: right; flex: none; }
`;
