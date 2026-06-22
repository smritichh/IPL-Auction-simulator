import { useState } from "react";
import IplAuctionScreen from "./IplAuctionScreen";
import { AccountBar, LoginPage, useAuth } from "./account";
import { authEnabled } from "./supabase";

function App() {
  const { user, ready } = useAuth();
  const [guest, setGuest] = useState(false);

  // Login gate — only when Supabase is configured. A signed-in user clears the
  // gate automatically (useAuth flips on the session); guests opt past it. With
  // no Supabase configured the app stays a pure guest experience.
  if (authEnabled) {
    if (!ready) return null;                                  // brief: checking session
    if (!user && !guest) return <LoginPage onGuest={() => setGuest(true)} />;
  }

  return (
    <>
      <IplAuctionScreen />
      <AccountBar />
    </>
  );
}

export default App
