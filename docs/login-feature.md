# Email-OTP Login + Saved History (Supabase)

Optional login for the IPL Auction Simulator. Players can enter an email, get a
one-time code, log in, and have each finished season saved to a personal history.
Guests play exactly as before — login only unlocks saving.

The whole thing is **client-side only**: the Vite SPA talks straight to Supabase
(auth + Postgres) with the public anon key. No server, no serverless functions.
Per-user data is protected by Postgres row-level security (RLS).

---

## How it behaves

- A **"Log in"** chip sits in the top-right corner.
- Click it → modal: enter email → **"Send code"** → enter the 6-digit code from
  the email → logged in.
- Logged-in users see their email + a menu (**My seasons**, **Log out**).
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
3. **Make the OTP email send a code**: Authentication → Emails → **Magic Link**
   template → include `{{ .Token }}` (e.g. `Your login code: {{ .Token }}`).
   Without this the email only has a magic *link*, not a 6-digit code.
4. **Get the keys**: Project Settings → API → copy the **Project URL** and the
   **anon public** key.

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
// send the code
await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
// verify it
await supabase.auth.verifyOtp({ email, token: code, type: "email" });
// session
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
