import { useState, useEffect, useMemo, useRef } from "react";
import { Gavel, Wallet, Trophy, Layers, ChevronRight } from "lucide-react";

/* ------------------------------------------------------------------ *
 *  IPL AUCTION — playable v1 slice (single-player vs AI)
 *  - You bid for Mumbai Indians; 9 AI teams bid against you.
 *  - AI walk-away price = valuation x need x budget-health (capped by purse).
 *  - Reserve floor (60% of market value) keeps stars from going cheap.
 *  All values are placeholder so the LOOP can be felt before real ratings exist.
 * ------------------------------------------------------------------ */

const OPEN_TIMER = 7;     // seconds when a fresh lot opens
const BID_TIMER = 4.5;    // seconds put back on the clock after each bid
const TICK = 0.3;         // engine tick (300ms)
const P_AI = 0.5;         // chance a willing AI acts on a given tick

const TEAMS = [
  { id: "MI",   name: "Mumbai Indians",            short: "MI",   color: "#1B6FCB", text: "#fff", isUser: true,  agg: 1.0 },
  { id: "CSK",  name: "Chennai Super Kings",       short: "CSK",  color: "#F4C430", text: "#10131C", agg: 1.0 },
  { id: "RCB",  name: "Royal Challengers Bengaluru", short: "RCB", color: "#C8102E", text: "#fff", agg: 1.12 },
  { id: "KKR",  name: "Kolkata Knight Riders",     short: "KKR",  color: "#6A4C93", text: "#fff", agg: 0.98 },
  { id: "DC",   name: "Delhi Capitals",            short: "DC",   color: "#2E5EAA", text: "#fff", agg: 0.92 },
  { id: "SRH",  name: "Sunrisers Hyderabad",       short: "SRH",  color: "#FF7A1A", text: "#10131C", agg: 1.08 },
  { id: "RR",   name: "Rajasthan Royals",          short: "RR",   color: "#E6308A", text: "#fff", agg: 0.90 },
  { id: "PBKS", name: "Punjab Kings",              short: "PBKS", color: "#D31329", text: "#fff", agg: 1.10 },
  { id: "GT",   name: "Gujarat Titans",            short: "GT",   color: "#C2A05A", text: "#10131C", agg: 1.0 },
  { id: "LSG",  name: "Lucknow Super Giants",      short: "LSG",  color: "#1FA2C4", text: "#10131C", agg: 1.03 },
];

const PLAYERS = [
  { name: "Virat Kohli",      role: "Batter",       country: "IND", overseas: false, base: 2.0, mv: 18, tier: "Marquee" },
  { name: "Jasprit Bumrah",   role: "Bowler",       country: "IND", overseas: false, base: 2.0, mv: 17, tier: "Marquee" },
  { name: "Hardik Pandya",    role: "All-rounder",  country: "IND", overseas: false, base: 2.0, mv: 15, tier: "Marquee" },
  { name: "Rashid Khan",      role: "Bowler",       country: "AFG", overseas: true,  base: 2.0, mv: 16, tier: "Marquee" },
  { name: "Rohit Sharma",     role: "Batter",       country: "IND", overseas: false, base: 2.0, mv: 14, tier: "Marquee" },
  { name: "Suryakumar Yadav", role: "Batter",       country: "IND", overseas: false, base: 2.0, mv: 13, tier: "Marquee" },
  { name: "Tristan Stubbs",   role: "Batter",       country: "RSA", overseas: true,  base: 1.0, mv: 8,  tier: "Star" },
];

const NEED_TARGET = { Batter: 2, "All-rounder": 1, Bowler: 2 };

const cr = (v) => `₹${Number(v).toFixed(2)} Cr`;
const inc = (p) => (p < 5 ? 0.5 : p < 12 ? 1.0 : 2.0);
const round2 = (v) => Math.round(v * 100) / 100;
const initials = (n) => n.split(" ").map((w) => w[0]).slice(0, 2).join("");

export default function IplAuctionScreen() {
  // Stable per (player,team) valuations: market value x personality x small noise.
  const vals = useMemo(() => {
    return PLAYERS.map((p) => {
      const row = {};
      const noise = p.tier === "Marquee" ? 0.06 : 0.18; // stars vary little -> they stay expensive
      TEAMS.forEach((t) => {
        if (t.isUser) return;
        row[t.id] = round2(p.mv * t.agg * (1 + (Math.random() * 2 - 1) * noise));
      });
      return row;
    });
  }, []);

  const walkaway = (team, pIdx) => {
    const p = PLAYERS[pIdx];
    const v = vals[pIdx][team.id];
    const counts = {};
    team.squad.forEach((s) => (counts[s.role] = (counts[s.role] || 0) + 1));
    const tgt = NEED_TARGET[p.role] ?? 1;
    const need = (counts[p.role] || 0) < tgt ? 1.15 : 0.85;
    const health = Math.min(1, Math.max(0.55, team.purse / 40));
    return Math.min(team.purse, v * need * health);
  };

  const initGame = () => ({
    phase: "bidding",
    index: 0,
    asking: PLAYERS[0].base,
    bid: null,
    leader: null,
    timer: OPEN_TIMER,
    tmax: OPEN_TIMER,
    teams: TEAMS.map((t) => ({ ...t, purse: 120, squad: [] })),
    ticker: [{ id: "sys", text: `On the block — ${PLAYERS[0].name}` }],
    lastSold: null,
  });

  const [game, setGame] = useState(initGame);
  const [started, setStarted] = useState(false);

  const resolve = (g) => {
    const p = PLAYERS[g.index];
    if (g.leader) {
      const price = g.bid;
      const won = TEAMS.find((t) => t.id === g.leader);
      const teams = g.teams.map((t) =>
        t.id === g.leader
          ? { ...t, purse: round2(t.purse - price), squad: [...t.squad, { ...p, price }] }
          : t
      );
      return {
        ...g, phase: "sold", teams,
        lastSold: { player: p, teamId: g.leader, price, you: g.leader === "MI" },
        ticker: [{ id: g.leader, text: `SOLD — ${p.name} → ${won.short} ${cr(price)}` }, ...g.ticker].slice(0, 9),
      };
    }
    return {
      ...g, phase: "sold", lastSold: { player: p, unsold: true },
      ticker: [{ id: "sys", text: `UNSOLD — ${p.name}` }, ...g.ticker].slice(0, 9),
    };
  };

  const tick = (g) => {
    if (g.phase !== "bidding") return g;
    const p = PLAYERS[g.index];
    const reserve = p.mv * 0.6;

    if (Math.random() < P_AI) {
      const cand = g.teams.filter(
        (t) => !t.isUser && t.id !== g.leader && t.squad.length < 25 && t.purse >= g.asking
      );
      const willing = cand.filter((t) => walkaway(t, g.index) >= g.asking || g.asking <= reserve);
      if (willing.length) {
        willing.sort((a, b) => walkaway(b, g.index) - walkaway(a, g.index));
        const top = willing.slice(0, Math.min(3, willing.length));
        const actor = top[Math.floor(Math.random() * top.length)];
        const newBid = g.asking;
        return {
          ...g, leader: actor.id, bid: newBid, asking: round2(newBid + inc(newBid)),
          timer: BID_TIMER, tmax: BID_TIMER,
          ticker: [{ id: actor.id, text: `${actor.short} bids ${cr(newBid)}` }, ...g.ticker].slice(0, 9),
        };
      }
    }

    const nt = round2(g.timer - TICK);
    if (nt > 0) return { ...g, timer: nt };
    return resolve(g);
  };

  // Engine loop
  useEffect(() => {
    if (!started) return;
    const id = setInterval(() => setGame((g) => tick(g)), TICK * 1000);
    return () => clearInterval(id);
  }, [started]);

  // After a SOLD beat, advance to the next lot
  useEffect(() => {
    if (game.phase !== "sold") return;
    const id = setTimeout(() => {
      setGame((g) => {
        const ni = g.index + 1;
        if (ni >= PLAYERS.length) return { ...g, phase: "done" };
        const np = PLAYERS[ni];
        return {
          ...g, phase: "bidding", index: ni, asking: np.base, bid: null, leader: null,
          timer: OPEN_TIMER, tmax: OPEN_TIMER, lastSold: null,
          ticker: [{ id: "sys", text: `On the block — ${np.name}` }, ...g.ticker].slice(0, 9),
        };
      });
    }, 2000);
    return () => clearTimeout(id);
  }, [game.phase]);

  const userBid = () =>
    setGame((g) => {
      if (g.phase !== "bidding" || g.leader === "MI") return g;
      const me = g.teams.find((t) => t.isUser);
      if (me.purse < g.asking) return g;
      const newBid = g.asking;
      return {
        ...g, leader: "MI", bid: newBid, asking: round2(newBid + inc(newBid)),
        timer: BID_TIMER, tmax: BID_TIMER,
        ticker: [{ id: "MI", text: `You bid ${cr(newBid)}` }, ...g.ticker].slice(0, 9),
      };
    });

  const skip = () => setGame((g) => (g.phase === "bidding" ? resolve(g) : g));
  const restart = () => { setGame(initGame()); setStarted(true); };

  const me = game.teams.find((t) => t.isUser);
  const p = PLAYERS[game.index];
  const reserve = p ? p.mv * 0.6 : 0;
  const frac = game.timer / game.tmax;
  const ringColor = frac < 0.3 ? "#FF5A5F" : game.leader === "MI" ? "#3DDC97" : "#F5C451";
  const leaderTeam = game.leader ? TEAMS.find((t) => t.id === game.leader) : null;
  const canAfford = me.purse >= game.asking;
  const R = 52, C = 2 * Math.PI * R;

  return (
    <div className="auc">
      <style>{styles}</style>

      {!started && <StartScreen onStart={() => setStarted(true)} />}

      {/* HEADER */}
      <header className="auc-head">
        <div className="brand">
          <div className="brand-ico"><Gavel size={20} strokeWidth={2.4} /></div>
          <div>
            <div className="brand-name">THE AUCTION</div>
            <div className="brand-sub">Bidding for Mumbai Indians</div>
          </div>
        </div>
        <div className="stats">
          <Stat icon={<Wallet size={15} />} label="Purse left" value={cr(me.purse)} hero />
          <Stat icon={<Trophy size={15} />} label="Players won" value={`${me.squad.length}`} />
          <Stat icon={<Layers size={15} />} label="Lot" value={`${game.index + 1} / ${PLAYERS.length}`} />
        </div>
      </header>

      <div className="auc-body">
        {/* STAGE */}
        <section className="stage">
          {game.phase === "done" ? (
            <Summary me={me} teams={game.teams} onRestart={restart} />
          ) : (
            <div className="lot">
              <div className="lot-eyebrow">
                <span>LOT {String(game.index + 1).padStart(2, "0")} / {String(PLAYERS.length).padStart(2, "0")}</span>
                <span className="tier-pill">{p.tier.toUpperCase()}</span>
              </div>

              <h1 className="lot-name">{p.name}</h1>
              <div className="lot-meta">
                <span className="chip">{p.role}</span>
                <span className="chip">{p.country}{p.overseas ? " · Overseas" : ""}</span>
              </div>

              <div className="lot-floor">
                {/* TIMER RING */}
                <div className="ring-wrap">
                  <svg width="124" height="124" viewBox="0 0 124 124">
                    <circle cx="62" cy="62" r={R} stroke="rgba(255,255,255,.08)" strokeWidth="7" fill="none" />
                    <circle
                      cx="62" cy="62" r={R} stroke={ringColor} strokeWidth="7" fill="none"
                      strokeLinecap="round" strokeDasharray={C}
                      strokeDashoffset={C * (1 - frac)}
                      transform="rotate(-90 62 62)"
                      style={{ transition: "stroke-dashoffset .25s linear, stroke .3s" }}
                    />
                  </svg>
                  <div className="ring-center">
                    <div className="ring-mono">{initials(p.name)}</div>
                    <div className="ring-secs" style={{ color: ringColor }}>{game.timer.toFixed(1)}s</div>
                  </div>
                </div>

                {/* MONEY */}
                <div className="money">
                  <div className="money-label">CURRENT BID</div>
                  <div key={game.bid ?? "open"} className="money-fig pop">
                    {game.bid ? cr(game.bid) : "— opening —"}
                  </div>
                  <div className="money-leader">
                    {game.leader === "MI" ? (
                      <span className="lead lead-you">● YOU'RE LEADING</span>
                    ) : leaderTeam ? (
                      <span className="lead" style={{ color: leaderTeam.color }}>● {leaderTeam.short} leading</span>
                    ) : (
                      <span className="lead lead-muted">no bids yet</span>
                    )}
                  </div>
                  <div className="money-foot">
                    base {cr(p.base)} · reserve {cr(reserve)}
                  </div>
                </div>
              </div>

              {/* CONTROLS */}
              <div className="controls">
                <button className="bid-btn" onClick={userBid} disabled={game.leader === "MI" || !canAfford}>
                  {game.leader === "MI" ? "You're top bid" : !canAfford ? "Not enough purse" : `Bid ${cr(game.asking)}`}
                </button>
                <button className="skip-btn" onClick={skip}>Skip lot</button>
              </div>

              {/* SOLD / UNSOLD STAMP */}
              {game.phase === "sold" && game.lastSold && (
                <div className="overlay">
                  <div className={`stamp slam ${game.lastSold.unsold ? "stamp-unsold" : game.lastSold.you ? "stamp-you" : "stamp-sold"}`}>
                    <Gavel size={26} strokeWidth={2.6} />
                    <span>{game.lastSold.unsold ? "UNSOLD" : game.lastSold.you ? "YOURS" : "SOLD"}</span>
                  </div>
                  {!game.lastSold.unsold && (
                    <div className="stamp-line">
                      {TEAMS.find((t) => t.id === game.lastSold.teamId).short} · {cr(game.lastSold.price)}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* YOUR SQUAD */}
          <div className="squad">
            <div className="squad-head">YOUR SQUAD <span>{me.squad.length} bought</span></div>
            <div className="squad-row">
              {me.squad.length === 0 && <span className="squad-empty">No players yet — win a bid to start building.</span>}
              {me.squad.map((s, i) => (
                <span key={i} className="squad-chip">{s.name} <b>{cr(s.price)}</b></span>
              ))}
            </div>
          </div>
        </section>

        {/* SIDE: RIVALS + TICKER */}
        <aside className="side">
          <div className="side-title">RIVAL TEAMS · 9 bidding</div>
          <div className="rivals">
            {game.teams.filter((t) => !t.isUser).map((t) => {
              const leading = t.id === game.leader;
              return (
                <div
                  key={leading ? `${t.id}-${game.bid}` : t.id}
                  className={`rival ${leading ? "rival-lead pop" : ""}`}
                  style={leading ? { borderColor: t.color, boxShadow: `0 0 0 1px ${t.color}, 0 6px 24px -8px ${t.color}` } : undefined}
                >
                  <span className="rival-dot" style={{ background: t.color, color: t.text }}>{t.short}</span>
                  <div className="rival-info">
                    <div className="rival-purse">{cr(t.purse)}</div>
                    <div className="rival-sub">{t.squad.length} bought {leading && <em style={{ color: t.color }}>· LEADING</em>}</div>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="side-title">LIVE TICKER</div>
          <div className="ticker">
            {game.ticker.map((line, i) => {
              const tm = TEAMS.find((t) => t.id === line.id);
              return (
                <div key={i} className={`tick ${i === 0 ? "tick-new" : ""}`}>
                  <span className="tick-dot" style={{ background: tm ? tm.color : "#5b647a" }} />
                  <span>{line.text}</span>
                </div>
              );
            })}
          </div>
        </aside>
      </div>
    </div>
  );
}

/* ---------- small components ---------- */

function Stat({ icon, label, value, hero }) {
  return (
    <div className={`stat ${hero ? "stat-hero" : ""}`}>
      <div className="stat-label">{icon}{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

function StartScreen({ onStart }) {
  return (
    <div className="start">
      <div className="start-card">
        <div className="brand-ico big"><Gavel size={26} strokeWidth={2.4} /></div>
        <h2>The Auction</h2>
        <p>You're bidding for <b>Mumbai Indians</b> with a ₹120 Cr purse. Nine AI franchises bid against you in real time. Win the players you want — but don't let a star slip away.</p>
        <button className="bid-btn" onClick={onStart}>Enter the auction <ChevronRight size={18} /></button>
        <span className="start-note">Placeholder players & values — this is the loop, not the final data.</span>
      </div>
    </div>
  );
}

function Summary({ me, teams, onRestart }) {
  const spent = round2(120 - me.purse);
  const sorted = [...teams].sort((a, b) => b.squad.length - a.squad.length);
  return (
    <div className="lot summary">
      <div className="lot-eyebrow"><span>AUCTION COMPLETE</span></div>
      <h1 className="lot-name">Your squad is set</h1>
      <div className="sum-stats">
        <div><span>{me.squad.length}</span>players won</div>
        <div><span>{cr(spent)}</span>spent</div>
        <div><span>{cr(me.purse)}</span>purse left</div>
      </div>
      <div className="squad-row" style={{ marginTop: 14 }}>
        {me.squad.map((s, i) => (<span key={i} className="squad-chip">{s.name} <b>{cr(s.price)}</b></span>))}
        {me.squad.length === 0 && <span className="squad-empty">You didn't win anyone this round.</span>}
      </div>
      <div className="sum-rivals">
        {sorted.filter((t) => !t.isUser).map((t) => (
          <span key={t.id} className="sum-rival"><b style={{ color: t.color }}>{t.short}</b> {t.squad.length}</span>
        ))}
      </div>
      <div className="controls" style={{ marginTop: 18 }}>
        <button className="bid-btn" onClick={onRestart}>Run another auction</button>
        <span className="next-hint">Next in the real flow → pick your playing XI</span>
      </div>
    </div>
  );
}

/* ---------- styles ---------- */
const styles = `
.auc{position:relative;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;
  color:#EAEEF7;background:
    radial-gradient(900px 420px at 28% -8%, rgba(245,196,81,.10), transparent 60%),
    radial-gradient(700px 500px at 100% 0%, rgba(27,111,203,.16), transparent 55%),
    linear-gradient(180deg,#0B1020,#070A14 70%);
  border-radius:16px;padding:18px;min-height:600px;overflow:hidden;
  font-variant-numeric:tabular-nums;}
.auc *{box-sizing:border-box}

.auc-head{display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;
  padding-bottom:14px;border-bottom:1px solid rgba(255,255,255,.07)}
.brand{display:flex;align-items:center;gap:11px}
.brand-ico{width:38px;height:38px;border-radius:10px;display:grid;place-items:center;
  background:linear-gradient(160deg,#F5C451,#C98F1E);color:#1a1304;
  box-shadow:0 4px 16px -4px rgba(245,196,81,.5)}
.brand-ico.big{width:54px;height:54px;border-radius:14px;margin:0 auto}
.brand-name{font-weight:800;letter-spacing:.16em;font-size:15px}
.brand-sub{font-size:12px;color:#8A93A8;letter-spacing:.02em}
.stats{display:flex;gap:10px;flex-wrap:wrap}
.stat{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:11px;
  padding:8px 13px;min-width:96px}
.stat-hero{background:linear-gradient(160deg,rgba(245,196,81,.16),rgba(245,196,81,.04));
  border-color:rgba(245,196,81,.35)}
.stat-label{display:flex;align-items:center;gap:5px;font-size:10.5px;color:#8A93A8;
  letter-spacing:.08em;text-transform:uppercase;margin-bottom:3px}
.stat-value{font-weight:800;font-size:17px}
.stat-hero .stat-value{color:#F5C451}

.auc-body{display:grid;grid-template-columns:1fr 312px;gap:16px;margin-top:16px}
@media (max-width:820px){.auc-body{grid-template-columns:1fr}}

.stage{display:flex;flex-direction:column;gap:14px}
.lot{position:relative;background:linear-gradient(170deg,rgba(255,255,255,.05),rgba(255,255,255,.02));
  border:1px solid rgba(255,255,255,.09);border-radius:16px;padding:22px 24px;overflow:hidden}
.lot::before{content:"";position:absolute;inset:0;background:
  radial-gradient(420px 180px at 18% 0%,rgba(245,196,81,.10),transparent 70%);pointer-events:none}
.lot-eyebrow{display:flex;align-items:center;gap:12px;font-size:11px;letter-spacing:.16em;
  color:#8A93A8;font-weight:700}
.tier-pill{color:#F5C451;border:1px solid rgba(245,196,81,.4);padding:2px 9px;border-radius:99px;
  background:rgba(245,196,81,.08)}
.lot-name{font-size:clamp(30px,5vw,46px);font-weight:850;letter-spacing:-.02em;margin:8px 0 0;line-height:1}
.lot-meta{display:flex;gap:8px;margin-top:11px}
.chip{font-size:12px;background:rgba(255,255,255,.06);border:1px solid rgba(255,255,255,.08);
  padding:4px 11px;border-radius:99px;color:#C7CEDD}

.lot-floor{display:flex;align-items:center;gap:26px;margin-top:20px;flex-wrap:wrap}
.ring-wrap{position:relative;width:124px;height:124px;flex:none}
.ring-center{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center}
.ring-mono{font-weight:850;font-size:26px;letter-spacing:.02em}
.ring-secs{font-size:12px;font-weight:700;margin-top:2px;font-variant-numeric:tabular-nums}
.money{flex:1;min-width:200px}
.money-label{font-size:11px;letter-spacing:.16em;color:#8A93A8;font-weight:700}
.money-fig{font-size:clamp(34px,6vw,54px);font-weight:850;letter-spacing:-.02em;color:#F5C451;line-height:1.05}
.money-leader{margin-top:6px;font-size:13px;font-weight:700}
.lead{letter-spacing:.02em}
.lead-you{color:#3DDC97}
.lead-muted{color:#6B7488;font-weight:600}
.money-foot{margin-top:9px;font-size:11.5px;color:#6B7488;letter-spacing:.03em}

.controls{display:flex;align-items:center;gap:12px;margin-top:22px;flex-wrap:wrap}
.bid-btn{display:inline-flex;align-items:center;gap:7px;border:none;cursor:pointer;
  background:linear-gradient(160deg,#F5C451,#D89B22);color:#1a1304;font-weight:800;font-size:15px;
  padding:13px 24px;border-radius:12px;letter-spacing:.01em;
  box-shadow:0 10px 26px -10px rgba(245,196,81,.7);transition:transform .08s,filter .2s}
.bid-btn:hover:not(:disabled){filter:brightness(1.06)}
.bid-btn:active:not(:disabled){transform:translateY(1px) scale(.99)}
.bid-btn:disabled{background:rgba(255,255,255,.07);color:#6B7488;box-shadow:none;cursor:not-allowed}
.skip-btn{background:transparent;border:1px solid rgba(255,255,255,.16);color:#C7CEDD;cursor:pointer;
  font-weight:600;font-size:13px;padding:12px 18px;border-radius:11px;transition:background .2s}
.skip-btn:hover{background:rgba(255,255,255,.06)}

.overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;
  gap:10px;background:rgba(7,10,20,.72);backdrop-filter:blur(2px)}
.stamp{display:flex;align-items:center;gap:10px;font-size:38px;font-weight:850;letter-spacing:.04em;
  padding:10px 26px;border-radius:14px;border:3px solid}
.stamp-sold{color:#F5C451;border-color:#F5C451}
.stamp-you{color:#3DDC97;border-color:#3DDC97}
.stamp-unsold{color:#FF5A5F;border-color:#FF5A5F;font-size:30px}
.stamp-line{font-size:16px;font-weight:700;color:#C7CEDD;letter-spacing:.04em}

.squad{background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.07);border-radius:14px;padding:14px 16px}
.squad-head{font-size:11px;letter-spacing:.14em;color:#8A93A8;font-weight:700;display:flex;
  justify-content:space-between;margin-bottom:10px}
.squad-head span{color:#F5C451}
.squad-row{display:flex;gap:8px;flex-wrap:wrap}
.squad-empty{font-size:13px;color:#6B7488}
.squad-chip{font-size:12.5px;background:rgba(27,111,203,.16);border:1px solid rgba(27,111,203,.4);
  color:#dfe7f5;padding:6px 11px;border-radius:9px}
.squad-chip b{color:#F5C451;font-weight:700;margin-left:3px}

.side{display:flex;flex-direction:column;gap:10px}
.side-title{font-size:10.5px;letter-spacing:.15em;color:#8A93A8;font-weight:700;margin-top:4px}
.rivals{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
@media (max-width:820px){.rivals{grid-template-columns:repeat(3,1fr)}}
@media (max-width:480px){.rivals{grid-template-columns:repeat(2,1fr)}}
.rival{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);
  border:1px solid rgba(255,255,255,.08);border-radius:11px;padding:8px;transition:box-shadow .25s,border-color .25s}
.rival-dot{width:32px;height:32px;border-radius:8px;display:grid;place-items:center;
  font-weight:800;font-size:10.5px;flex:none}
.rival-info{min-width:0}
.rival-purse{font-weight:800;font-size:13px}
.rival-sub{font-size:10.5px;color:#8A93A8;white-space:nowrap}
.rival-sub em{font-style:normal;font-weight:700}

.ticker{background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.07);border-radius:12px;
  padding:10px 12px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;
  display:flex;flex-direction:column;gap:7px;min-height:150px}
.tick{display:flex;align-items:center;gap:8px;color:#AEB6C7}
.tick-new{color:#fff}
.tick-dot{width:7px;height:7px;border-radius:99px;flex:none}

.start{position:absolute;inset:0;z-index:20;display:grid;place-items:center;
  background:radial-gradient(700px 400px at 50% 30%,rgba(27,111,203,.18),transparent 60%),rgba(7,10,20,.92);
  border-radius:16px;padding:20px}
.start-card{max-width:420px;text-align:center;background:linear-gradient(170deg,rgba(255,255,255,.06),rgba(255,255,255,.02));
  border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:30px 28px}
.start-card h2{font-size:30px;font-weight:850;margin:14px 0 8px;letter-spacing:-.01em}
.start-card p{font-size:14px;line-height:1.55;color:#AEB6C7;margin:0 0 20px}
.start-card .bid-btn{margin:0 auto}
.start-note{display:block;margin-top:14px;font-size:11px;color:#6B7488}

.summary{text-align:left}
.sum-stats{display:flex;gap:26px;margin-top:18px;flex-wrap:wrap}
.sum-stats div{font-size:12px;color:#8A93A8;letter-spacing:.04em}
.sum-stats span{display:block;font-size:28px;font-weight:850;color:#fff;margin-bottom:2px}
.sum-stats div:nth-child(2) span{color:#F5C451}
.sum-rivals{display:flex;gap:14px;flex-wrap:wrap;margin-top:18px;padding-top:14px;
  border-top:1px solid rgba(255,255,255,.07);font-size:13px;color:#AEB6C7}
.next-hint{font-size:12px;color:#6B7488}

@keyframes popIn{0%{transform:scale(.9);opacity:.4}60%{transform:scale(1.04)}100%{transform:scale(1);opacity:1}}
.pop{animation:popIn .26s ease-out}
@keyframes slamIn{0%{transform:scale(2) rotate(-14deg);opacity:0}55%{transform:scale(.92) rotate(-9deg);opacity:1}100%{transform:scale(1) rotate(-7deg)}}
.slam{animation:slamIn .4s cubic-bezier(.2,1.4,.4,1)}
@media (prefers-reduced-motion:reduce){.pop,.slam{animation:none}}
`;
