# Email-OTP Login + Saved History (Supabase)

Optional login for the IPL Auction Simulator. Players can enter an email, get a
one-time code, log in, and have each finished season saved to a personal history.
Guests play exactly as before — login only unlocks saving.

The whole thing is **client-side only**: the Vite SPA talks straight to Supabase
(auth + Postgres) with the public anon key. No server, no serverless functions.
Per-user data is protected by Postgres row-level security (RLS).

---

## How it behaves

- The app opens on a **full-screen login page**: enter **name + email** →
  **"Email me a link"**, or **"Continue as guest"**. Either way you land on
  team-select. A **"Log in"** chip also sits in the top-right (same flow in a
  modal) for guests who decide to log in later.
- **Magic-link sign-in** (not a typed code): clicking the link in the email
  returns to the app and supabase-js completes the session. We use the link
  because free-tier Supabase only sends its default sign-in-link template — the
  OTP-code template is locked behind custom SMTP. The name typed at login is
  stored in `user_metadata.name` (stashed in `localStorage` so it survives the
  link opening a fresh tab) and shown, with a first-letter avatar, in the chip.
- Logged-in users see their **name** + a menu (**My seasons**, **Log out**).
- When a season finishes while logged in, it **auto-saves** to history. Guests see
  a "Log in to save this season" nudge on the finish screen; logging in then saves
  it automatically.
- If Supabase env vars aren't set, the login UI hides itself and the app runs as a
  pure guest experience (`authEnabled === false`).

---

## Files

| File | Role |
|---|---|
| `ipl-app/src/supabase.js` | Creates the Supabase client from Vite env vars. Exposes `authEnabled` (false when keys are missing → guest-only). |
| `ipl-app/src/account.jsx` | Everything auth/history: `useAuth()` hook, `saveSeason()`, the `<AccountBar/>` (login chip + menu), the login modal (email → code), the history modal, and `openLogin()`. Self-contained styles. |
| `ipl-app/src/App.jsx` | Mounts `<AccountBar/>` next to `<IplAuctionScreen/>`. |
| `ipl-app/src/IplAuctionScreen.jsx` | `FinishScreen` imports `useAuth`/`saveSeason`/`openLogin` and auto-saves the finished season; shows save status / login nudge. |
| `supabase/schema.sql` | The `seasons` table + RLS policies. Run once in the Supabase SQL editor. |
| `ipl-app/.env.example` | Names of the two env vars (placeholder values). |

Dependency added: `@supabase/supabase-js` (in `ipl-app/package.json`).

---

## Supabase setup (one time)

1. **Create a project** at https://supabase.com → New project.
2. **Create the table**: SQL Editor → New query → paste `supabase/schema.sql` → Run.
3. **Allow the redirect**: Authentication → **URL Configuration** → set **Site URL**
   to the deployed URL and add both the deployed URL and `http://localhost:5173/**`
   to **Redirect URLs**. The magic link must return to an allow-listed URL.
4. **Get the keys**: Project Settings → API → copy the **Project URL** and the
   **anon public** key.

> Sign-in uses the **magic link** (the email's default sign-in link), not a typed
> code, because free-tier Supabase locks the OTP-code email template behind custom
> SMTP. If you later add custom SMTP (e.g. Resend), you can edit the Magic Link
> template to include `{{ .Token }}` and switch the UI back to a 6-digit code.

### The schema (`supabase/schema.sql`)

```sql
create table if not exists public.seasons (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references auth.users (id) on delete cascade,
  created_at    timestamptz not null default now(),
  team          text not null,        -- franchise id, e.g. "MI"
  team_name     text,
  final_pos     int  not null,        -- actual finish (1..10)
  projected_pos int,
  title_odds    numeric,              -- 0..1
  is_champion   boolean default false,
  champion      text,
  best_buy      text,
  worst_buy     text,
  squad         jsonb
);

alter table public.seasons enable row level security;
create policy "seasons: select own" on public.seasons for select using (auth.uid() = user_id);
create policy "seasons: insert own" on public.seasons for insert with check (auth.uid() = user_id);
create policy "seasons: delete own" on public.seasons for delete using (auth.uid() = user_id);
create index if not exists seasons_user_created_idx on public.seasons (user_id, created_at desc);
```

---

## Environment variables

Vite exposes only `VITE_`-prefixed vars to the browser.

**Local** — `ipl-app/.env.local` (gitignored via `*.local`):

```
VITE_SUPABASE_URL=https://YOUR-PROJECT-ref.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ... (anon public key)
```

**Production (Vercel)** — set the same two vars in
Project → Settings → Environment Variables (Production + Preview + Development),
then redeploy.

> The **anon key is safe to ship in the browser** — it's the public key, and RLS
> restricts every row to its owner. **Never** put the `service_role` key (or any
> other secret, e.g. an OpenAI key) in the client or in git.

---

## Auth flow (supabase-js v2)

```js
// send the magic link (emailRedirectTo must be an allow-listed Redirect URL;
// data.name seeds user_metadata.name on first sign-up)
await supabase.auth.signInWithOtp({
  email,
  options: { shouldCreateUser: true, emailRedirectTo: window.location.origin, data: { name } },
});
// clicking the link returns here; supabase-js (detectSessionInUrl, default on)
// completes the session — no verify step in the app
supabase.auth.getSession();
supabase.auth.onAuthStateChange((_event, session) => { /* user = session?.user */ });
supabase.auth.signOut();
```

Saving a season:

```js
const { data: { user } } = await supabase.auth.getUser();
await supabase.from("seasons").insert({ user_id: user.id, /* ...result fields */ });
```

Reading history:

```js
await supabase.from("seasons").select("*").order("created_at", { ascending: false });
```

---

## Notes / gotchas

- Free-tier Supabase email is rate-limited (a few per hour) via shared SMTP — fine
  for personal use. For real volume, configure custom SMTP (e.g. Resend).
- The Supabase SDK adds ~200 KB to the bundle (≈371 → ≈585 KB raw, ≈99 → ≈154 KB
  gzip). Lazy-loading `account.jsx`/`supabase.js` via `React.lazy` + dynamic import
  keeps the initial load lean if that matters.
- The login chip is `position: fixed; top-right`. On the auction screen the
  top-right also holds the LOT/PURSE/PLAYERS stats — check for overlap and nudge
  the offset if needed.
