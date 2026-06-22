import { useState } from "react";
import IplAuctionScreen from "./IplAuctionScreen";
import { AccountBar, LoginPage, useAuth } from "./account";
import { MultiplayerEntry } from "./Lobby";
import { authEnabled } from "./supabase";

function App() {
  const { user, ready } = useAuth();
  const [guest, setGuest] = useState(false);
  const [mode, setMode]   = useState(null);   // null = menu · "solo" · "mp"

  // Login gate — only when Supabase is configured. A signed-in user clears the
  // gate automatically (useAuth flips on the session); guests opt past it. With
  // no Supabase configured the app stays a pure guest experience.
  if (authEnabled) {
    if (!ready) return null;                                  // brief: checking session
    if (!user && !guest) return <LoginPage onGuest={() => setGuest(true)} />;
  }

  // Mode select. Solo is the original single-player flow; mp opens the lobby.
  if (mode === null) {
    return (
      <>
        <ModeSelect onSolo={() => setMode("solo")} onMp={() => setMode("mp")} />
        <AccountBar />
      </>
    );
  }
  if (mode === "mp") {
    return (
      <>
        <MultiplayerEntry name={user?.user_metadata?.name} onExit={() => setMode(null)} />
        <AccountBar />
      </>
    );
  }
  return (
    <>
      <IplAuctionScreen />
      <AccountBar />
    </>
  );
}

function ModeSelect({ onSolo, onMp }) {
  return (
    <div className="lp-wrap">
      <div className="lp-card">
        <div className="lp-brand">THE AUCTION</div>
        <h1 className="lp-title">Choose how to play</h1>
        <p className="lp-sub">Bid against 9 AI franchises solo, or run a live auction with friends (AI fills the rest).</p>
        <button className="acct-primary" onClick={onSolo}>Play solo vs AI</button>
        <div className="lp-or"><span>or</span></div>
        <button className="lp-guest" onClick={onMp}>Play with friends</button>
      </div>
    </div>
  );
}

export default App;
