# IPL Auction Simulation — Project Brief

## What we're building

A website that gives users the experience of a real IPL auction — tense, live, against AI rivals — followed by a season simulation that pays off their auction decisions with a final ranking.

---

## Core user flow

1. **Landing** → user enters the site
2. **Team select** → picks one IPL franchise to bid on behalf of (e.g. Mumbai Indians)
3. **Auction** → bids on players in tier order; 9 AI teams bid against them in real time
4. **Squad review** → sees their 18–25 player squad; can skip/auto-fill if they don't want to bid on everyone
5. **Pick XI** → selects playing 11 (+ Impact Player slot); "auto-pick best XI" button available
6. **Projected rank** → shown immediately after XI is picked, based on pre-run simulation
7. **Season broadcast** → 14 league matches play out as fast result cards; points table updates round by round; user's game is highlighted
8. **Playoffs** → top 4 enter IPL-authentic format: Qualifier 1 → Eliminator → Qualifier 2 → Final; playoffs get slower, more dramatic treatment
9. **Final result** → actual rank vs projected rank; shareable summary card

---

## Auction mechanics (IPL rules)

- **Purse:** ₹120 crore per team
- **Squad size:** 18–25 players, max 8 overseas
- **Base prices:** ₹30L (lowest) to ₹2 Cr (highest); players enter at reserve, not zero
- **Bid increments:** +₹20L up to ₹1 Cr; +₹25L beyond; not free-form
- **Tier/set order:** Marquee players first (when all teams have full purses), then capped batters, all-rounders, wicketkeepers, fast bowlers, spinners, then uncapped equivalents
- **Skip option:** user can skip a set/lot (authentic — real auctions have accelerated rounds)
- **RTM:** skip for v1; add later

---

## AI bidding logic

Each of the 9 rival teams is a robot manager with four things:

### 1. Walk-away price (the core decision rule)
```
walk-away = base_valuation × need_multiplier × budget_health
           (capped by remaining purse)
```
- **Base valuation** — what the player is worth on talent alone (from ratings). Low randomness for marquee stars so they don't get undervalued; more noise for ordinary players.
- **Need multiplier** — stretches value upward if the team lacks that role (e.g. no bowler yet → 1.15–1.3×); shrinks it if the role is already filled (0.7–0.85×).
- **Budget health** — shrinks value if the team is low on cash and still needs many players (prevents early overspending that leaves gaps).

The AI keeps bidding while `current_price < walk-away`; folds the moment price exceeds it.

### 2. Shopping list
Tracks what roles are still needed and updates the need multiplier accordingly after every purchase.

### 3. Hard constraints
- Cannot exceed ₹120 Cr total
- Must finish with ≥ 18 players
- Cannot sign > 8 overseas
- These protect the AI from painting itself into a corner

### 4. Personality (one per team)
Each team has an aggression factor (e.g. RCB = 1.12, Rajasthan = 0.90) that scales base valuations. Makes teams feel like distinct opponents you learn to read.

---

## Star player price protection

**Problem:** without guards, AI could occasionally win Kohli or Bumrah for ₹5 Cr.

**Two-layer fix:**

**Layer 1 — natural competition (primary fix)**
- Stars are auctioned first, when all teams have full purses → maximum appetite
- Marquee players have low valuation noise → every team independently sees them as highly valuable → multiple teams naturally drive the price up
- Enough teams flagged as "interested" in each marquee name so no star goes uncontested

**Layer 2 — reserve floor (safety net)**
- Each player has a hidden floor = 60–70% of market value
- If live bidding doesn't reach it, a quiet underbidder keeps the price honest, OR the player goes unsold and re-enters the pool later (authentic — real auctions have unsold players returning)
- Floor is set at 60–70%, not higher, so genuine bargains are still possible (landing Kohli at ₹14 Cr instead of ₹18 Cr should feel achievable)

---

## Player rating system

### Scope
Full T20 career — not IPL only. Covers: international T20Is, IPL, BBL, PSL, CPL, SA20, The Hundred, Indian domestic (SMAT), other leagues.

**Why:** IPL-only data gives thin samples for young domestic players and overseas players with few IPL appearances. Full T20 career gives stable, fair ratings.

### Tournament quality weights
| Competition | Weight |
|---|---|
| IPL + International T20Is | 1.0 (full) |
| BBL, PSL, CPL, SA20, The Hundred | ~0.85 |
| Indian domestic (SMAT) + equivalents | ~0.65 |
| Minor/associate leagues | ~0.45 |

### Recency weighting
Last 2–3 seasons count more than older data. Reflects current form, not past prime.

### Role-specific stats used
- **Batters:** strike rate, average, boundary %, phase weighting (powerplay / middle / death specialist)
- **Bowlers:** economy, bowling strike rate, wickets, death-over economy
- **All-rounders:** weighted blend of both
- **Keepers:** batting stats + dismissals modifier

### Output
Each player gets a 0–100 batting rating and/or bowling rating. These feed directly into the simulation.

### Fallback
Players with very little T20 data get a sensible baseline for their role so the system never breaks on unknowns.

### Data source
**Cricsheet** — free, structured ball-by-ball data for most major T20 leagues and internationals. One consistent source avoids stitching together scattered stats.

---

## Simulation engine (4 layers)

### Layer 1 — Player ratings (stats → numbers)
Convert each player's weighted career stats into clean 0–100 ratings per role (see above). This is the raw material.

### Layer 2 — Team strength from the XI
- Aggregate playing XI ratings into a **batting strength** and **bowling strength**
- Order-weight the batting (top-order matters more than No. 9)
- Apply balance penalties: thin bowling options, no specialist keeper, underloaded overseas slots all reduce team strength
- Output: two numbers — "this team bats at 84, bowls at 79"

### Layer 3 — One match result
- Compare Team A's batting strength vs Team B's bowling strength → expected score
- Do the same in reverse
- Add randomness (so upsets happen, weaker team doesn't always lose)
- Higher "score" wins the match
- *League matches:* fast, strength-differential. *Playoffs/Final:* slower, innings-level detail for drama.

### Layer 4 — Full season (the "sims")
- Run all 14 league matches + playoffs using Layer 3 → one complete season = **one sim**
- Run ~1,000 sims total
- Output a **rank distribution**: "MI finishes 1st in 18% of sims, top-4 in 62%, median rank 3"
- This is richer than a single rank guess and directly reflects the uncertainty real teams face

### The two ranks (key UX distinction)
| | What it is | When shown |
|---|---|---|
| **Projected rank** | median/modal result across 1,000 sims | immediately after XI is picked |
| **Actual rank** | result of the one season the user watches play out | end of season broadcast |

The gap between them IS the drama. Projected 3rd but sneaked into the final → memorable. Projected champions but choked to 6th → also memorable.

### Live feedback during auction
A "projected squad strength" needle updates in real time as the user wins players — every bid has a visible consequence. This ties the auction and simulation into one continuous feedback loop rather than two separate screens.

---

## Season format (authentic IPL)

- **14 league games** per team (not a full round-robin)
- **Top 4** enter playoffs
- Playoff format:
  - Qualifier 1: 1st vs 2nd → winner goes straight to Final
  - Eliminator: 3rd vs 4th → loser eliminated
  - Qualifier 2: Q1 loser vs Eliminator winner → winner goes to Final
  - **Final**

The "you can lose Q1 and still reach the Final" quirk is worth modelling — it's part of what makes IPL playoffs distinctive.

---

## V1 scope decisions

| Decision | Choice | Reasoning |
|---|---|---|
| Player vs multiplayer | **Single player vs AI** | Multiplayer needs websockets, lobbies, server authority — 5–10× the engineering. Prove the loop first. |
| XI selection | **Pick once for the season** (with auto-pick option) | Picking before every match is realistic but tedious for v1 |
| RTM cards | **Skip** | Only matters with retentions; clean pool is simpler and more fun |
| Match fidelity | **Fast for league, detailed for playoffs** | Balances pacing vs drama |

---

## Inspirations

- **38-0.app** (football simulation)
- **82-0.com** (basketball simulation)

Both use: constrained draft + strength-rating simulation. The IPL version is richer because the constraint is live competition for a shared budget against 9 AI teams — not a randomizer. The auction IS the game; the season sim is the payoff.

Key differentiator: the live auction experience + the projected-vs-actual rank reveal. Not just a sim with a draft bolted on.

---

## Build order

1. ✅ **Auction screen** — playable prototype built (placeholder players/values, real AI bidding logic)
2. **Pick XI screen** — select playing 11 from won squad
3. **Rating formula** — wire in real player ratings from Cricsheet data
4. **Season broadcast** — match result cards, live points table
5. **Playoff sequence** — Q1, Eliminator, Q2, Final with drama
6. **Result / share screen** — projected vs actual rank, shareable card
