// Multiplayer auction (Stage 2a): host-authoritative, Supabase Realtime Broadcast.
//
// The HOST's browser is the single source of truth: it owns the lot order, the
// asking price, the countdown, and resolution (SOLD/UNSOLD). Every client —
// including the host — renders purely from the broadcast events, so all screens
// match. Players send BID intents; the host validates with a bidSeq
// compare-and-swap (stale/duplicate bids are dropped) and rebroadcasts STATE.
//
// Stage 2a scope: human-vs-human bidding + synced timer + standings. AI bidding
// for the unclaimed franchises lands in Stage 2b (they sit out for now).
import { useState, useEffect, useRef, useCallback } from "react";
import { PLAYERS } from "./players";
import { TEAMS } from "./teams";
import { EVENTS } from "./multiplayer";

const cr  = (v) => `₹${Number(v).toFixed(2)} Cr`;
const OPEN_MS = 7000, BID_MS = 4500;
const PURSE0  = 120;                 // ₹120 Cr per franchise
const inc = (asking) => (asking < 1 ? 0.2 : 0.25);   // IPL increments (approx)

// Lot order: marquee/stars first (tier rank, then rating) — authentic-ish.
const TIER_RANK = { Marquee: 0, Uncapped: 2 };   // everything else ranks 1
function buildOrder() {
  return PLAYERS.map((_, i) => i).sort((a, b) => {
    const pa = PLAYERS[a], pb = PLAYERS[b];
    const ta = TIER_RANK[pa.tier] ?? 1, tb = TIER_RANK[pb.tier] ?? 1;
    return ta - tb || pb.rating - pa.rating;
  });
}
const freshTeams = () => Object.fromEntries(TEAMS.map((t) => [t.id, { purse: PURSE0, squad: 0 }]));

export function MultiplayerAuction({ room, self, members }) {
  const { send, onEvent } = room;
  const isHost = self.isHost;
  const myTeam = self.teamId;

  // ── shared, broadcast-driven view state (every client) ──
  const [lot, setLot]     = useState(null);  // { lotIndex, total, playerIdx, asking, leaderId, bidSeq }
  const [teams, setTeams] = useState(freshTeams);
  const [flash, setFlash] = useState(null);  // { winnerId, price } | { unsold:true }
  const [done, setDone]   = useState(false);
  const [remain, setRemain] = useState(0);   // ms left on the local countdown

  // local countdown: each client counts down from when it received the event
  const deadlineRef = useRef(0);
  useEffect(() => {
    const id = setInterval(() => setRemain(Math.max(0, deadlineRef.current - Date.now())), 100);
    return () => clearInterval(id);
  }, []);
  const startLocalClock = (durationMs) => { deadlineRef.current = Date.now() + durationMs; setRemain(durationMs); };

  // ── shared event handlers (all clients, incl. host via broadcast self:true) ──
  useEffect(() => {
    onEvent(EVENTS.LOT_OPEN, (p) => {
      setFlash(null); setDone(false);
      setLot({ lotIndex: p.lotIndex, total: p.total, playerIdx: p.playerIdx, asking: p.asking, leaderId: p.leaderId, bidSeq: p.bidSeq });
      if (p.teams) setTeams(p.teams);
      startLocalClock(p.duration);
    });
    onEvent(EVENTS.STATE, (p) => {
      setLot((l) => (l && l.lotIndex === p.lotIndex ? { ...l, asking: p.asking, leaderId: p.leaderId, bidSeq: p.bidSeq } : l));
      startLocalClock(p.duration);
    });
    onEvent(EVENTS.SOLD, (p) => { if (p.teams) setTeams(p.teams); setFlash({ winnerId: p.winnerId, price: p.price }); });
    onEvent(EVENTS.UNSOLD, () => setFlash({ unsold: true }));
    onEvent(EVENTS.AUCTION_DONE, (p) => { if (p.teams) setTeams(p.teams); setDone(true); setLot(null); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── HOST authority loop ──
  const A = useRef(null);   // authoritative state, host only
  useEffect(() => {
    if (!isHost) return;
    // map claimed franchises → their owner; everything else is AI (sits out in 2a)
    const human = {};
    for (const m of members) if (m.teamId) human[m.teamId] = m.playerId;

    A.current = {
      order: buildOrder(), index: 0,
      asking: 0, leaderId: null, bidSeq: 0, resolved: false,
      teams: freshTeams(), human, timer: null,
    };

    const openLot = (i) => {
      const a = A.current; const p = PLAYERS[a.order[i]];
      a.index = i; a.asking = p.base; a.leaderId = null; a.bidSeq = 0; a.resolved = false;
      send(EVENTS.LOT_OPEN, { lotIndex: i, total: a.order.length, playerIdx: a.order[i],
        asking: p.base, leaderId: null, bidSeq: 0, duration: OPEN_MS, teams: a.teams });
      arm(OPEN_MS);
    };
    const arm = (ms) => { clearTimeout(A.current.timer); A.current.timer = setTimeout(resolve, ms); };
    const resolve = () => {
      const a = A.current; a.resolved = true;
      if (a.leaderId) {
        a.teams[a.leaderId] = { purse: +(a.teams[a.leaderId].purse - a.asking).toFixed(2), squad: a.teams[a.leaderId].squad + 1 };
        send(EVENTS.SOLD, { lotIndex: a.index, winnerId: a.leaderId, price: a.asking, teams: a.teams });
      } else {
        send(EVENTS.UNSOLD, { lotIndex: a.index });
      }
      setTimeout(() => {
        if (a.index + 1 < a.order.length) openLot(a.index + 1);
        else send(EVENTS.AUCTION_DONE, { teams: a.teams });
      }, 1400);
    };

    const off = onEvent(EVENTS.BID_INTENT, (p) => {
      const a = A.current;
      if (!a || a.resolved || p.lotIndex !== a.index || p.bidSeq !== a.bidSeq) return;  // stale → drop (CAS)
      if (!a.human[p.teamId] || p.teamId === a.leaderId) return;                        // not a human team / already leading
      const next = a.leaderId ? +(a.asking + inc(a.asking)).toFixed(2) : a.asking;      // first bid = base
      if (a.teams[p.teamId].purse < next) return;                                        // can't afford
      a.asking = next; a.leaderId = p.teamId; a.bidSeq += 1;
      send(EVENTS.STATE, { lotIndex: a.index, asking: a.asking, leaderId: a.leaderId, bidSeq: a.bidSeq, duration: BID_MS });
      arm(BID_MS);
    });

    const kick = setTimeout(() => openLot(0), 600);   // small beat after Start
    return () => { clearTimeout(kick); clearTimeout(A.current?.timer); off?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost]);

  // ── my bid action ──
  const nameOf = useCallback((teamId) => {
    const m = members.find((x) => x.teamId === teamId);
    const t = TEAMS.find((x) => x.id === teamId);
    return m ? m.name : t ? `${t.short} (AI)` : teamId;
  }, [members]);

  const placeBid = () => {
    if (!lot || !myTeam) return;
    send(EVENTS.BID_INTENT, { lotIndex: lot.lotIndex, bidSeq: lot.bidSeq, teamId: myTeam });
  };

  if (done) {
    const standings = TEAMS.map((t) => ({ ...t, ...teams[t.id] })).sort((a, b) => b.squad - a.squad || a.purse - b.purse);
    return (
      <div className="lp-wrap"><div className="lp-card mpa-done">
        <div className="lp-brand">AUCTION COMPLETE</div>
        <h1 className="lp-title">Squads locked</h1>
        <div className="mpa-stand">
          {standings.map((t) => (
            <div key={t.id} className="mpa-srow">
              <span className="mpa-steam" style={{ color: t.color }}>{t.short}</span>
              <span className="mpa-sname">{nameOf(t.id)}</span>
              <span className="mpa-snum">{t.squad} players · {cr(t.purse)} left</span>
            </div>
          ))}
        </div>
        <p className="lp-note">Pick XI &amp; the season run as a synced handoff in the next stage.</p>
        <style>{MPA_CSS}</style>
      </div></div>
    );
  }

  if (!lot) {
    return <div className="lp-wrap"><div className="lp-card"><h1 className="lp-title">Starting the auction…</h1><style>{MPA_CSS}</style></div></div>;
  }

  const p = PLAYERS[lot.playerIdx];
  const t = lot.leaderId ? TEAMS.find((x) => x.id === lot.leaderId) : null;
  const next = lot.leaderId ? +(lot.asking + inc(lot.asking)).toFixed(2) : lot.asking;
  const myPurse = myTeam ? teams[myTeam]?.purse ?? 0 : 0;
  const iLead   = lot.leaderId === myTeam;
  const canBid  = myTeam && !iLead && myPurse >= next && remain > 0 && !flash;
  const secs    = (remain / 1000).toFixed(1);
  const pct     = Math.min(100, (remain / (lot.leaderId ? BID_MS : OPEN_MS)) * 100);

  return (
    <div className="lp-wrap"><div className="lp-card mpa-card">
      <div className="mpa-top">
        <span className="mpa-lotn">LOT {lot.lotIndex + 1} / {lot.total}</span>
        {myTeam && <span className="mpa-purse">{TEAMS.find((x) => x.id === myTeam)?.short}: {cr(myPurse)}</span>}
      </div>

      <div className="mpa-player">
        <div className="mpa-pname">{p.name}</div>
        <div className="mpa-pmeta">{p.role} · {p.country}{p.overseas ? " · overseas" : ""} · rating {p.rating}</div>
        <div className="mpa-base">base {cr(p.base)}</div>
      </div>

      <div className="mpa-bid">
        <div className="mpa-asklbl">{lot.leaderId ? "current bid" : "opening"}</div>
        <div className="mpa-ask">{cr(lot.asking)}</div>
        <div className="mpa-leader" style={t ? { color: t.color } : undefined}>
          {flash?.winnerId ? `SOLD to ${nameOf(flash.winnerId)} · ${cr(flash.price)}`
            : flash?.unsold ? "UNSOLD"
            : lot.leaderId ? `${nameOf(lot.leaderId)} leads` : "no bids yet"}
        </div>
      </div>

      <div className="mpa-timer"><div className="mpa-timerbar" style={{ width: `${pct}%`, background: remain < 1500 ? "#DC3A40" : "#B5800F" }} /></div>
      <div className="mpa-secs">{flash ? "·" : `${secs}s`}</div>

      <button className="acct-primary mpa-bidbtn" disabled={!canBid} onClick={placeBid}>
        {iLead ? "You're leading" : !myTeam ? "Spectating" : myPurse < next ? "Can't afford" : `Bid ${cr(next)}`}
      </button>

      <div className="mpa-strip">
        {TEAMS.map((tm) => (
          <span key={tm.id} className={`mpa-chip${lot.leaderId === tm.id ? " lead" : ""}`}
            style={{ borderColor: `${tm.color}66`, color: tm.color }}>
            {tm.short} {teams[tm.id]?.squad ?? 0}
          </span>
        ))}
      </div>
      <style>{MPA_CSS}</style>
    </div></div>
  );
}

const MPA_CSS = `
.mpa-card { max-width: 440px; text-align: center; }
.mpa-top { display:flex; justify-content:space-between; align-items:center; margin-bottom:14px; font-size:12px; font-weight:700; }
.mpa-lotn { color:#9AA3B2; letter-spacing:.08em; }
.mpa-purse { color:#B5800F; font-family:'Barlow Condensed',sans-serif; font-size:15px; }
.mpa-player { margin-bottom:14px; }
.mpa-pname { font-family:'Barlow Condensed',sans-serif; font-size:34px; font-weight:800; color:#1B2436; line-height:1.05; }
.mpa-pmeta { font-size:12px; color:#6B7488; margin-top:4px; }
.mpa-base { font-size:12px; color:#9AA3B2; margin-top:2px; }
.mpa-bid { background:#F7F8FB; border-radius:13px; padding:14px; margin-bottom:12px; }
.mpa-asklbl { font-size:10px; text-transform:uppercase; letter-spacing:.12em; color:#9AA3B2; }
.mpa-ask { font-family:'Barlow Condensed',sans-serif; font-size:42px; font-weight:800; color:#B5800F; line-height:1.05; }
.mpa-leader { font-size:13px; font-weight:700; margin-top:2px; min-height:18px; color:#46526B; }
.mpa-timer { height:6px; background:rgba(20,30,50,.08); border-radius:99px; overflow:hidden; }
.mpa-timerbar { height:100%; transition:width .1s linear; }
.mpa-secs { font-size:12px; color:#9AA3B2; margin:4px 0 12px; font-variant-numeric:tabular-nums; }
.mpa-bidbtn { font-size:16px; }
.mpa-strip { display:flex; flex-wrap:wrap; gap:6px; justify-content:center; margin-top:16px; }
.mpa-chip { font-size:11px; font-weight:800; border:1.5px solid; border-radius:99px; padding:3px 9px; font-family:'Barlow Condensed',sans-serif; letter-spacing:.03em; }
.mpa-chip.lead { background:rgba(181,128,15,.1); }
.mpa-done { max-width:440px; }
.mpa-stand { display:flex; flex-direction:column; gap:6px; margin:10px 0 4px; }
.mpa-srow { display:flex; align-items:center; gap:10px; border:1px solid rgba(20,30,50,.1); border-radius:9px; padding:8px 12px; }
.mpa-steam { font-family:'Barlow Condensed',sans-serif; font-weight:800; font-size:15px; min-width:42px; text-align:left; }
.mpa-sname { flex:1; text-align:left; font-size:13px; font-weight:700; color:#1B2436; }
.mpa-snum { font-size:11.5px; color:#6B7488; }
`;
