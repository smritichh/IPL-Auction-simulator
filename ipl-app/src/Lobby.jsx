// Multiplayer lobby (Stage 1): create or join a room by code, see who's here,
// claim a distinct franchise, and ready up. Built on the Realtime presence in
// multiplayer.js — no host authority needed for the lobby itself. The auction
// handoff (host "Start") is wired in a later stage; here it's gated on everyone
// being ready with a distinct team.
import { useState } from "react";
import { TEAMS } from "./teams";
import { useRoom, genRoomCode, normalizeCode } from "./multiplayer";

// ── entry: choose create vs join, collect name + code, then mount the room ──
export function MultiplayerEntry({ name: initialName, onExit }) {
  const [name, setName]   = useState(initialName || "");
  const [code, setCode]   = useState(null);     // active room code (null until created/joined)
  const [isHost, setHost] = useState(false);
  const [joinCode, setJoinCode] = useState("");

  if (code) {
    return <Lobby code={code} name={name.trim() || "Player"} isHost={isHost} onLeave={() => setCode(null)} />;
  }

  const create = () => { if (!name.trim()) return; setHost(true); setCode(genRoomCode()); };
  const join   = () => {
    const c = normalizeCode(joinCode);
    if (!name.trim() || c.length < 5) return;
    setHost(false); setCode(c);
  };

  return (
    <div className="lp-wrap">
      <div className="lp-card">
        <div className="lp-brand">THE AUCTION</div>
        <h1 className="lp-title">Play with friends</h1>
        <p className="lp-sub">Create a room and share the code, or join a friend’s room. AI fills the empty franchises.</p>

        <input className="acct-field" type="text" placeholder="Your name" value={name}
          onChange={(e) => setName(e.target.value)} maxLength={20} autoFocus />

        <button className="acct-primary" disabled={!name.trim()} onClick={create}>Create a room</button>

        <div className="lp-or"><span>or join</span></div>
        <input className="acct-field" type="text" placeholder="Enter code (e.g. 7KQ2P)"
          value={joinCode} onChange={(e) => setJoinCode(normalizeCode(e.target.value))}
          onKeyDown={(e) => e.key === "Enter" && join()} style={{ textTransform: "uppercase", letterSpacing: "2px" }} />
        <button className="lp-guest" disabled={!name.trim() || normalizeCode(joinCode).length < 5} onClick={join}>
          Join room
        </button>

        <p className="lp-note"><button className="acct-back" onClick={onExit}>← Back</button></p>
        <style>{LOBBY_CSS}</style>
      </div>
    </div>
  );
}

// ── the room itself ──
function Lobby({ code, name, isHost, onLeave }) {
  const { status, members, self, claimTeam, setReady } = useRoom({ code, name, isHost });
  const [copied, setCopied] = useState(false);

  // team → the member who claimed it (for the grid + collision detection)
  const claimedBy = {};
  for (const m of members) if (m.teamId) claimedBy[m.teamId] = m;

  const humans      = members.length;
  const everyoneReady = humans >= 2 && members.every((m) => m.ready && m.teamId);
  const myTeam      = self.teamId;

  const copyCode = () => {
    try { navigator.clipboard?.writeText(code); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* ignore */ }
  };

  const pickTeam = (teamId) => {
    const owner = claimedBy[teamId];
    if (owner && owner.playerId !== self.playerId) return; // taken by someone else
    claimTeam(myTeam === teamId ? null : teamId);          // toggle off if re-tapping mine
  };

  return (
    <div className="lp-wrap">
      <div className="lp-card lobby-card">
        <div className="lp-brand">ROOM</div>
        <button className="room-code" onClick={copyCode} title="Copy code">
          {code} <span className="room-copy">{copied ? "copied!" : "tap to copy"}</span>
        </button>
        <p className="lp-sub">
          {status === "disabled" ? "Multiplayer needs Supabase configured."
            : status === "error" ? "Connection problem — check your network."
            : `${humans} player${humans === 1 ? "" : "s"} in the room${humans < 2 ? " · waiting for a friend to join…" : ""}`}
        </p>

        {/* roster */}
        <div className="roster">
          {members.map((m) => {
            const t = TEAMS.find((x) => x.id === m.teamId);
            return (
              <div key={m.playerId} className="roster-row">
                <span className="roster-name">{m.name}{m.playerId === self.playerId ? " (you)" : ""}</span>
                <span className="roster-team" style={t ? { color: t.color } : undefined}>{t ? t.short : "no team"}</span>
                <span className={`roster-ready${m.ready ? " on" : ""}`}>{m.ready ? "ready" : "…"}</span>
              </div>
            );
          })}
        </div>

        {/* team claim grid */}
        <div className="lobby-label">Claim your franchise</div>
        <div className="team-picker">
          {TEAMS.map((t) => {
            const owner = claimedBy[t.id];
            const mine  = owner?.playerId === self.playerId;
            const taken = owner && !mine;
            return (
              <button key={t.id}
                className={`tp-btn${mine ? " tp-sel" : ""}`}
                disabled={taken}
                title={taken ? `Taken by ${owner.name}` : t.name}
                style={mine
                  ? { background: t.color, color: t.text, borderColor: t.color }
                  : { borderColor: `${t.color}44`, color: taken ? "#B7BECB" : t.color, opacity: taken ? 0.45 : 1 }}
                onClick={() => pickTeam(t.id)}>
                <span className="tp-short">{t.short}</span>
              </button>
            );
          })}
        </div>

        <button className="acct-primary" disabled={!myTeam} onClick={() => setReady(!self.ready)}
          style={{ background: self.ready ? "#12A06A" : undefined }}>
          {self.ready ? "✓ Ready — tap to unready" : myTeam ? "Ready up" : "Claim a team first"}
        </button>

        {isHost && (
          <button className="lp-guest" disabled={!everyoneReady}
            style={{ marginTop: 8, borderColor: everyoneReady ? "#B5800F" : undefined, color: everyoneReady ? "#B5800F" : undefined }}
            onClick={() => alert("Auction start is wired in the next stage.")}>
            {everyoneReady ? "Start the auction →" : "Waiting for all players to ready up"}
          </button>
        )}
        {!isHost && everyoneReady && <p className="lp-note">Waiting for the host to start…</p>}

        <p className="lp-note"><button className="acct-back" onClick={onLeave}>← Leave room</button></p>
        <style>{LOBBY_CSS}</style>
      </div>
    </div>
  );
}

const LOBBY_CSS = `
.lobby-card { max-width: 440px; }
.room-code { display:inline-flex; align-items:baseline; gap:10px; background:none; border:none; cursor:pointer;
  font-family:'Barlow Condensed', ui-sans-serif, sans-serif; font-size:40px; font-weight:800; letter-spacing:.14em; color:#1B2436; margin:0 0 2px; }
.room-copy { font-family:ui-sans-serif, system-ui; font-size:11px; font-weight:600; letter-spacing:.04em; color:#B5800F; }
.roster { display:flex; flex-direction:column; gap:6px; margin:6px 0 18px; }
.roster-row { display:flex; align-items:center; gap:10px; border:1px solid rgba(20,30,50,.1); border-radius:9px; padding:8px 12px; }
.roster-name { flex:1; text-align:left; font-size:13.5px; font-weight:700; color:#1B2436; }
.roster-team { font-family:'Barlow Condensed', ui-sans-serif, sans-serif; font-weight:800; font-size:14px; letter-spacing:.04em; }
.roster-ready { font-size:11px; font-weight:700; color:#9AA3B2; min-width:42px; text-align:right; }
.roster-ready.on { color:#12A06A; }
.lobby-label { font-size:11px; text-transform:uppercase; letter-spacing:.1em; color:#9AA3B2; margin:4px 0 10px; font-weight:700; }
.team-picker { display:grid; grid-template-columns:repeat(5,1fr); gap:8px; margin-bottom:16px; }
.tp-btn { border:1.5px solid; background:#fff; border-radius:11px; padding:11px 0; cursor:pointer; font-weight:800; transition:transform .06s; }
.tp-btn:disabled { cursor:not-allowed; }
.tp-btn:not(:disabled):active { transform:scale(.96); }
.tp-short { font-family:'Barlow Condensed', ui-sans-serif, sans-serif; font-size:15px; letter-spacing:.03em; }
`;
