# IPL Auction Simulator — project guide

A single-player IPL cricket **auction + season simulator**. You bid against 9 AI
franchises to build a squad, pick your XI, then play a full season (league →
playoffs) and get a shareable result. Inspired by 38-0.app (football) and
82-0.com (basketball): the live auction *is* the game, the season sim is the payoff.

## Run it

```bash
cd ipl-app
npm install        # first time
npm run dev        # Vite dev server (has been run on port 5174)
npm run build      # production build — ALWAYS run this to sanity-check after edits
npm run lint
```

The whole game is client-side React. No backend, no env vars, no database.

## Where the code lives

The app is in **`ipl-app/`** (Vite + React 19). Everything else at the repo root
is supporting material.

- `ipl-app/src/IplAuctionScreen.jsx` — **the entire app in one file**: all game
  state, the inline auction bidding engine, every screen (team pick → auction →
  Pick XI → season → playoffs → finish), and **all CSS as one `const styles`
  template literal** rendered via `<style>{styles}</style>`. ~2600 lines. This is
  the file you edit for almost everything.
- `ipl-app/src/matchEngine.js` — pure ES module. `pickXI` (overseas ≤4 in XI,
  ≥5 bowling options, 1 keeper), `battingOrder`, phase-based ball-by-ball T20
  `simulateMatch` (returns full scorecard + per-over/per-ball `timeline`),
  `innViews`, and `teamStrength(xi)` → `{batting, bowling, overall}` (0–100, with
  balance penalties; `overall` is the projection's strength input).
- `ipl-app/src/matchDiagnostics.js` — pure ES module. `analyzeMatch(match, userId)`
  turns the phase-tagged timeline into a plain-English "what went wrong" read
  (top-order collapse, death-bowling leak, star let-down…) for the post-loss card.
- `ipl-app/src/season.js` — pure ES module. 14-game schedule (circle method),
  points table + NRR, standings.
- `ipl-app/src/players.js` — **GENERATED, never hand-edit.** 258 real IPL players
  with archetypes + ratings. Produced by the data pipeline below.
- `ipl-app/src/{App.jsx,main.jsx,index.css}` — thin wrappers. `index.css` sets the
  light page background; the app is full-bleed (`.auc { min-height: 100vh }`).

⚠️ **`/IplAuctionScreen.jsx` at the repo root is a STALE duplicate** (old copy).
The live file is `ipl-app/src/IplAuctionScreen.jsx`. Don't edit the root one.

## Data pipeline (Python, in `data/`)

Ratings/archetypes come from real Cricsheet ball-by-ball data. To change ratings
you edit the pipeline and re-run it — never edit `players.js` directly.

```
data/cricsheet/json/*.json         raw Cricsheet matches (2008–2026)
  → data/process_cricsheet.py      → data/player_stats.json
       (per-player career stats + bat_recent/bowl_recent = latest 2 seasons)
  → data/enrich.py                 reads players_base.json + player_stats.json
       + name_map.json             → ipl-app/src/players.js   (the generated pool)
```

Regenerate after a pipeline change:
```bash
cd data
python3 process_cricsheet.py    # ~1.5s, rebuilds player_stats.json
python3 enrich.py               # rewrites ../ipl-app/src/players.js
```
Other scripts: `reorder_sets.py` (assigns the 17 IPL auction sets + accelerated
round), `export_players_csv.py` (→ players_export.csv for vetting), `add_players.py`,
`match_players.py`.

**Ratings model** (in `enrich.py`): a per-tier anchor (Marquee 87 … Uncapped 51)
± a data-driven adjustment from batting SR/avg and bowling econ/wkts, **blended
60% recent form (last 2 seasons) / 40% career** when there's a ≥120-ball recent
sample, minus a stale-player penalty. Tiers are curated manually in `players_base.json`.

## Test harnesses (run with Node, no UI)

```bash
node data/sim_test.mjs       # auction valuation: squads fill 18–24, ~spend purse,
                             # every team gets a keeper, star price SPREAD check
node data/season_test.mjs    # match engine: XI legality, score dist (avg ~165),
                             # chase win ~53%, stronger squad wins ~72%
```
Both **mirror** the engines in the app. `sim_test.mjs` has its **own copy** of the
auction `valuation()` function — if you change valuation in `IplAuctionScreen.jsx`,
mirror it in `sim_test.mjs` too (and vice-versa), or the test drifts from reality.

## How the auction valuation works (the tuned core)

Inline `valuation(team, p, v, lotsLeft, activeNeeders)` in `IplAuctionScreen.jsx`.
A team's max bid = squad-need × rating × budget-discipline, with these guards:
- **Keeper guarantee** — a keeperless team's keeper appetite ramps up late so every
  squad lands a keeper (cheap ones exist), without overpaying early.
- **Star bidding wars** — players rated 80+ have their ceiling lean toward their
  per-game, hunger-noised market value (`demandCap`), so marquee names vary in
  price game-to-game instead of a flat number. Sub-80 players use the flat cap.
- **criticalBoost / glut falloff** — broke-but-needy teams outbid hoarders on cheap
  fillers; teams at/above target stop running away to 25 players.

## Conventions / gotchas

- **Always `npm run build`** after editing the JSX (it's one big file; a stray tag
  breaks the build — that's your fast check). Verify in the browser when feasible.
- CSS lives in the `const styles` string at the bottom of `IplAuctionScreen.jsx`.
  Light theme: dark ink on white cards, gold `#B5800F` accents, team brand colours.
- The auction runs over `game.order` (an array of player indices), so unsold
  re-auction can append to it. Address lots via `lotPlayer(g, i)`, never `PLAYERS[i]`.
- Pick XI hard-requires 1 keeper and ≥5 bowling options — **unless the squad
  genuinely can't field them** (no keeper → a batter keeps; <5 bowling options in
  the whole squad → the block relaxes to a warning, never a soft-lock). The auction
  valuation has matching keeper- and bowling-guarantee ramps so this is rare.
- `.claude/settings.local.json` is intentionally **untracked** (local tooling state).

## Current state

Full loop is playable, committed on `main`, **pushed to GitHub
(`smritichh/IPL-Auction-simulator`) and auto-deployed on Vercel** (root dir
`ipl-app`): team pick → auction → Pick XI (drag-drop + auto-pick, with a live
BAT/BOWL/OVERALL strength readout) → 14-game league → playoffs (only your own
knockouts play over-by-over; others auto-sim) → **finish screen** (final position,
projected-vs-actual, title odds, best/worst buy, shareable PNG). Light full-bleed theme.

The league screen has a **persistent team strip** (your strength + a live probable
finish re-projected each match-day) and, **after a loss**, a "what went wrong"
analysis card with an **"Adjust your XI"** button — a mid-season re-pick that swaps
your XI for the remaining matches (`updateXI` in `SeasonScreen`; the season is
simulated lazily so only future rounds use the new XI). Pre-match win/preview
interstitials were deliberately skipped in favour of the always-on strip.

The original product brief is in `ipl-auction-sim-brief.md`.
