// Optional email-OTP login + saved season history, layered on top of the
// otherwise-stateless game. Everything talks directly to Supabase from the
// browser (anon key + row-level security) — no server code. If Supabase isn't
// configured (authEnabled === false), the whole module renders nothing and the
// app stays a pure guest experience.
import React, { useState, useEffect, useRef } from "react";
import { Gavel } from "lucide-react";
import { supabase, authEnabled } from "./supabase";

// ── tiny formatters (kept local so this module is self-contained) ──
const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
const pct = (x) => `${Math.round((x || 0) * 100)}%`;
const fmtDate = (iso) => {
  try { return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }); }
  catch { return ""; }
};

// ── module-level bridge so any screen (e.g. the finish card) can open the login
//    modal without prop-threading through the whole app ──
let _openLogin = () => {};
export const openLogin = () => _openLogin();

// ── auth state hook ──
export function useAuth() {
  const [user, setUser]   = useState(null);
  const [ready, setReady] = useState(!authEnabled);   // no Supabase → instantly "ready" as guest
  useEffect(() => {
    if (!supabase) return;
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (!active) return;
      setUser(data.session?.user ?? null);
      setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      setUser(session?.user ?? null);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);
  return { user, ready };
}

// ── persistence ──
export async function saveSeason(result) {
  if (!supabase) return { skipped: "no-config" };
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return { skipped: "guest" };
  const { error } = await supabase.from("seasons").insert({ user_id: user.id, ...result });
  return { error };
}

async function fetchHistory() {
  if (!supabase) return { rows: [] };
  const { data, error } = await supabase
    .from("seasons").select("*").order("created_at", { ascending: false }).limit(100);
  return { rows: data || [], error };
}

// localStorage key for the name typed at login. The magic-link click may land
// in a different tab than the one that sent it, so we stash the name and apply
// it once a session exists (see AccountBar) instead of relying on React state.
const PENDING_NAME_KEY = "ipl_pending_name";

// ── shared email → magic-link flow (used by both the modal and the full login
//    page) so the Supabase calls live in exactly one place. Free-tier Supabase
//    only sends a sign-in link (the OTP-code template is locked behind custom
//    SMTP), so we use the link: send → user clicks it → supabase-js detects the
//    session from the redirect URL and onAuthStateChange flips the app to
//    logged-in. ──
function useMagicLink() {
  const [step, setStep]   = useState("email");   // email | sent
  const [name, setName]   = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy]   = useState(false);
  const [msg, setMsg]     = useState(null);      // { text, err }

  const send = async () => {
    const e = email.trim();
    if (!e) return;
    setBusy(true); setMsg(null);
    if (name.trim()) { try { localStorage.setItem(PENDING_NAME_KEY, name.trim()); } catch { /* ignore */ } }
    // `data` sets user_metadata.name on account creation; emailRedirectTo brings
    // the click back to this app, where supabase-js completes the sign-in.
    const { error } = await supabase.auth.signInWithOtp({
      email: e,
      options: {
        shouldCreateUser: true,
        emailRedirectTo: window.location.origin,
        data: { name: name.trim() },
      },
    });
    setBusy(false);
    if (error) { setMsg({ text: error.message, err: true }); return; }
    setStep("sent");
  };

  const back = () => { setStep("email"); setMsg(null); };

  return { step, name, setName, email, setEmail, busy, msg, send, back };
}

// ── login modal: email → 6-digit code → signed in ──
function LoginModal({ onClose }) {
  const { step, name, setName, email, setEmail, busy, msg, send, back } = useMagicLink();

  return (
    <div className="acct-ov" onClick={onClose}>
      <div className="acct-modal" onClick={(e) => e.stopPropagation()}>
        <button className="acct-x" onClick={onClose}>×</button>
        <h2>{step === "email" ? "Log in" : "Check your email"}</h2>
        <p className="sub">
          {step === "email"
            ? "We’ll email you a sign-in link — no password. Logging in lets you save your seasons."
            : `We sent a sign-in link to ${email}. Open it (same device) to finish logging in — you can close this once you do.`}
        </p>

        {step === "email" ? (
          <>
            <input className="acct-field" type="text" autoFocus
              placeholder="Your name" value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && name.trim() && email.trim() && send()} />
            <input className="acct-field" type="email" inputMode="email"
              placeholder="you@email.com" value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && name.trim() && email.trim() && send()} />
            <button className="acct-primary" disabled={busy || !name.trim() || !email.trim()} onClick={send}>
              {busy ? "Sending…" : "Email me a link"}
            </button>
          </>
        ) : (
          <button className="acct-back" onClick={back}>← Use a different email</button>
        )}
        {msg && <div className={`acct-msg${msg.err ? " err" : ""}`}>{msg.text}</div>}
      </div>
    </div>
  );
}

// ── history modal ──
function HistoryModal({ onClose }) {
  const [rows, setRows] = useState(null);
  const [err, setErr]   = useState(null);
  useEffect(() => {
    fetchHistory().then(({ rows, error }) => { setRows(rows); if (error) setErr(error.message); });
  }, []);

  return (
    <div className="acct-ov" onClick={onClose}>
      <div className="acct-modal" onClick={(e) => e.stopPropagation()}>
        <button className="acct-x" onClick={onClose}>×</button>
        <h2>Your seasons</h2>
        <p className="sub">Every season you’ve finished while logged in.</p>
        {rows === null && !err && <div className="hist-empty">Loading…</div>}
        {err && <div className="hist-empty">Couldn’t load history.<br /><span style={{ fontSize: 11 }}>{err}</span></div>}
        {rows && rows.length === 0 && !err && (
          <div className="hist-empty">No saved seasons yet — finish a season while logged in.</div>
        )}
        {rows && rows.length > 0 && (
          <div className="hist-list">
            {rows.map((r) => (
              <div key={r.id} className="hist-row">
                <div className="hist-top">
                  <span className="hist-team">
                    {r.team_name || r.team}
                    {r.is_champion && <span className="hist-champ"> · 🏆 Champions</span>}
                  </span>
                  <span className="hist-date">{fmtDate(r.created_at)}</span>
                </div>
                <div className="hist-line">
                  Finished <b>{ordinal(r.final_pos)}</b>
                  {r.projected_pos ? <> · projected {ordinal(r.projected_pos)}</> : null}
                  {r.title_odds != null ? <> · title odds {pct(r.title_odds)}</> : null}
                </div>
                {(r.best_buy || r.worst_buy) && (
                  <div className="hist-line">
                    {r.best_buy && <>Best buy: <b>{r.best_buy}</b></>}
                    {r.best_buy && r.worst_buy && " · "}
                    {r.worst_buy && <>Worst: <b>{r.worst_buy}</b></>}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ── full-screen login gate: shown before the game when auth is configured.
//    Logging in unlocks saved seasons; "Continue as guest" plays without it.
//    On a successful login, onAuthStateChange flips the app past this page,
//    so this component just unmounts — no explicit hand-off needed. ──
export function LoginPage({ onGuest }) {
  const { step, name, setName, email, setEmail, busy, msg, send, back } = useMagicLink();

  return (
    <div className="lp-wrap">
      <div className="lp-card">
        <div className="lp-icon"><Gavel size={28} strokeWidth={2.4} /></div>
        <div className="lp-brand">THE AUCTION</div>
        <h1 className="lp-title">{step === "email" ? "Log in" : "Check your email"}</h1>
        <p className="lp-sub">
          {step === "email"
            ? "We’ll email you a sign-in link — no password. Logging in saves every season you finish to your history."
            : `We sent a sign-in link to ${email}. Open it on this device to finish logging in — you can close that email tab once you’re back here.`}
        </p>

        {step === "email" ? (
          <>
            <input className="acct-field" type="text" autoFocus
              placeholder="Your name" value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && name.trim() && email.trim() && send()} />
            <input className="acct-field" type="email" inputMode="email"
              placeholder="you@email.com" value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !busy && name.trim() && email.trim() && send()} />
            <button className="acct-primary" disabled={busy || !name.trim() || !email.trim()} onClick={send}>
              {busy ? "Sending…" : "Email me a link"}
            </button>
          </>
        ) : (
          <button className="acct-back" onClick={back}>← Use a different email</button>
        )}
        {msg && <div className={`acct-msg${msg.err ? " err" : ""}`}>{msg.text}</div>}

        <div className="lp-or"><span>or</span></div>
        <button className="lp-guest" onClick={onGuest}>Continue as guest</button>
        <p className="lp-note">Guests play the full game — login just saves your finished seasons.</p>
      </div>
      <style>{ACCT_CSS}</style>
    </div>
  );
}

// ── persistent account control (fixed top-right) ──
export function AccountBar() {
  const { user, ready } = useAuth();
  const [login, setLogin] = useState(false);
  const [hist, setHist]   = useState(false);
  const [menu, setMenu]   = useState(false);

  useEffect(() => { _openLogin = () => setLogin(true); return () => { _openLogin = () => {}; }; }, []);

  // Apply the name stashed at login once a session exists (the magic-link click
  // may have landed in a fresh tab without the login form's React state).
  useEffect(() => {
    if (!user) return;
    let pending = null;
    try { pending = localStorage.getItem(PENDING_NAME_KEY); } catch { /* ignore */ }
    if (!pending) return;
    if (user.user_metadata?.name) {
      try { localStorage.removeItem(PENDING_NAME_KEY); } catch { /* ignore */ }
      return;
    }
    supabase.auth.updateUser({ data: { name: pending } })
      .finally(() => { try { localStorage.removeItem(PENDING_NAME_KEY); } catch { /* ignore */ } });
  }, [user]);

  if (!authEnabled || !ready) return null;

  // Prefer the name the user gave at login; fall back to their email.
  const displayName = user?.user_metadata?.name?.trim() || user?.email;

  return (
    <div className="acct">
      {!user ? (
        <button className="acct-login" onClick={() => setLogin(true)}>Log in</button>
      ) : (
        <div className="acct-user">
          <button className="acct-chip" onClick={() => setMenu((m) => !m)}>
            <span className="acct-dot">{(displayName || "?")[0].toUpperCase()}</span>
            <span className="acct-email">{displayName}</span>
          </button>
          {menu && (
            <div className="acct-menu">
              <button onClick={() => { setHist(true); setMenu(false); }}>My seasons</button>
              <button onClick={async () => { setMenu(false); await supabase.auth.signOut(); }}>Log out</button>
            </div>
          )}
        </div>
      )}
      {login && <LoginModal onClose={() => setLogin(false)} />}
      {hist && <HistoryModal onClose={() => setHist(false)} />}
      <style>{ACCT_CSS}</style>
    </div>
  );
}

const ACCT_CSS = `
.acct { position: fixed; top: 10px; right: 14px; z-index: 2000; font-family: ui-sans-serif, system-ui, sans-serif; }
.acct-login { background:#fff; border:1px solid rgba(20,30,50,.15); color:#1B2436; font-weight:700; font-size:12px; padding:6px 13px; border-radius:99px; cursor:pointer; box-shadow:0 2px 10px -4px rgba(20,30,50,.25); }
.acct-login:hover { border-color:#B5800F; color:#B5800F; }
.acct-user { position: relative; }
.acct-chip { display:flex; align-items:center; gap:7px; background:#fff; border:1px solid rgba(20,30,50,.15); border-radius:99px; padding:4px 11px 4px 4px; cursor:pointer; box-shadow:0 2px 10px -4px rgba(20,30,50,.25); }
.acct-dot { width:24px; height:24px; border-radius:50%; background:#B5800F; color:#fff; font-weight:800; font-size:12px; display:flex; align-items:center; justify-content:center; flex:none; }
.acct-email { font-size:12px; color:#46526B; max-width:150px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.acct-menu { position:absolute; top:calc(100% + 6px); right:0; background:#fff; border:1px solid rgba(20,30,50,.12); border-radius:10px; box-shadow:0 8px 24px -8px rgba(20,30,50,.25); overflow:hidden; min-width:150px; }
.acct-menu button { display:block; width:100%; text-align:left; background:none; border:none; padding:9px 14px; font-size:12.5px; color:#1B2436; cursor:pointer; }
.acct-menu button:hover { background:rgba(181,128,15,.08); color:#B5800F; }
.acct-ov { position:fixed; inset:0; background:rgba(15,22,38,.45); z-index:3000; display:flex; align-items:center; justify-content:center; padding:16px; }
.acct-modal { position:relative; background:#fff; border-radius:16px; padding:24px; width:100%; max-width:380px; box-shadow:0 20px 60px -20px rgba(0,0,0,.45); }
.acct-modal h2 { font-family:'Barlow Condensed', ui-sans-serif, sans-serif; font-size:25px; font-weight:800; margin:0 0 4px; color:#1B2436; }
.acct-modal p.sub { font-size:13px; color:#6B7488; margin:0 0 18px; line-height:1.45; }
.acct-field { width:100%; box-sizing:border-box; border:1px solid rgba(20,30,50,.18); border-radius:9px; padding:11px 13px; font-size:15px; margin-bottom:10px; }
.acct-field:focus { outline:none; border-color:#B5800F; box-shadow:0 0 0 3px rgba(181,128,15,.12); }
.acct-primary { width:100%; background:#B5800F; color:#fff; border:none; border-radius:9px; padding:12px; font-size:14px; font-weight:700; cursor:pointer; }
.acct-primary:hover:not(:disabled) { background:#9c6d0c; }
.acct-primary:disabled { opacity:.5; cursor:default; }
.acct-msg { font-size:12px; margin-top:11px; color:#46526B; }
.acct-msg.err { color:#DC3A40; }
.acct-x { position:absolute; top:14px; right:16px; background:none; border:none; font-size:22px; line-height:1; color:#9AA3B2; cursor:pointer; }
.acct-x:hover { color:#46526B; }
.acct-back { background:none; border:none; color:#6B7488; font-size:12px; cursor:pointer; padding:0; margin-top:13px; }
.acct-back:hover { color:#B5800F; }
.hist-list { display:flex; flex-direction:column; gap:8px; max-height:58vh; overflow:auto; margin-top:4px; }
.hist-row { border:1px solid rgba(20,30,50,.1); border-radius:10px; padding:10px 12px; }
.hist-top { display:flex; justify-content:space-between; align-items:baseline; gap:8px; }
.hist-team { font-weight:800; color:#1B2436; font-size:14px; }
.hist-date { font-size:11px; color:#9AA3B2; flex:none; }
.hist-line { font-size:12px; color:#46526B; margin-top:3px; }
.hist-champ { color:#B5800F; }
.hist-empty { font-size:13px; color:#6B7488; text-align:center; padding:22px 0; line-height:1.5; }

/* ── full-screen login gate ── */
.lp-wrap { position:fixed; inset:0; z-index:2500; display:flex; align-items:center; justify-content:center; padding:20px;
  background:radial-gradient(120% 120% at 50% 0%, #F4F6FB 0%, #E8ECF3 60%, #DDE3EE 100%); }
.lp-card { background:#fff; border-radius:20px; padding:34px 30px 26px; width:100%; max-width:400px; text-align:center;
  box-shadow:0 24px 70px -24px rgba(20,30,50,.35); }
.lp-icon { width:54px; height:54px; border-radius:14px; margin:0 auto 14px; display:grid; place-items:center;
  background:linear-gradient(150deg,#F5C451,#C98F1E); color:#1a1304; box-shadow:0 6px 18px -5px rgba(245,196,81,.5); }
.lp-brand { font-family:'Barlow Condensed', ui-sans-serif, sans-serif; font-weight:800; letter-spacing:.18em; font-size:13px; color:#677087; }
.lp-title { font-family:'Barlow Condensed', ui-sans-serif, sans-serif; font-size:32px; font-weight:800; margin:2px 0 6px; color:#1B2436; }
.lp-sub { font-size:13px; color:#6B7488; margin:0 0 18px; line-height:1.5; }
.lp-or { display:flex; align-items:center; gap:10px; margin:18px 0 14px; color:#9AA3B2; font-size:11px; text-transform:uppercase; letter-spacing:.1em; }
.lp-or::before, .lp-or::after { content:""; flex:1; height:1px; background:rgba(20,30,50,.1); }
.lp-guest { width:100%; background:#fff; color:#1B2436; border:1px solid rgba(20,30,50,.18); border-radius:9px; padding:12px;
  font-size:14px; font-weight:700; cursor:pointer; }
.lp-guest:hover { border-color:#B5800F; color:#B5800F; }
.lp-note { font-size:11.5px; color:#9AA3B2; margin:14px 0 0; line-height:1.5; }
`;
