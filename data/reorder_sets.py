#!/usr/bin/env python3
"""
Reorder players_base.json to match the official IPL auction set sequence.

Confirmed from IPL 2025 mega auction (Wikipedia):
  Set 1  M1  — marquee (top ~6 by mv)
  Set 2  M2  — marquee (remaining)
  Set 3  BA1 — capped batters         (higher base first)
  Set 4  AL1 — capped all-rounders
  Set 5  WK1 — capped wicket-keepers
  Set 6  FA1 — capped fast bowlers
  Set 7  SP1 — capped spin bowlers
  Set 8  UBA1— uncapped batters
  Set 9  UAL1— uncapped all-rounders
  Set 10 UWK1— uncapped wicket-keepers
  Set 11 UFA1— uncapped fast bowlers
  Set 12 USP1— uncapped spin bowlers
  Set 13 BA2 — capped batters (second round)
  Set 14 AL2 — capped all-rounders (second round)
  Set 15 WK2 — capped wicket-keepers (second round)
  Set 16 FA2 — capped fast bowlers (second round)
  Set 17 SP2 — capped spin bowlers (second round)
  Accelerated — remaining players (franchise preference order)

Within each set: descending base price, then descending mv (higher value = goes first,
consistent with real 2025 auction where ₹200L base players led each set).
"""
import json, os, re

HERE = os.path.dirname(__file__)
BASE_JSON   = os.path.join(HERE, "players_base.json")
PLAYERS_JS  = os.path.join(HERE, "..", "ipl-app", "src", "players.js")

# Load base data
base = json.load(open(BASE_JSON))
# name -> [name, role, country, base_price, mv, tier, comment]

# Load enriched data to get bowlType (pace/spin) for each player
# Parse players.js for the enriched fields
enriched = {}
for line in open(PLAYERS_JS):
    m = re.search(r'name:\s*"([^"]+)".*?bowlType:\s*([^,]+).*?wk:\s*(true|false)', line)
    if m:
        name   = m.group(1)
        bt_raw = m.group(2).strip()
        wk     = m.group(3) == "true"
        bowl_type = None if bt_raw in ("null","undefined","") else bt_raw.strip('"')
        enriched[name] = {"bowlType": bowl_type, "wk": wk}

# ── Set assignment ────────────────────────────────────────────────────────────
CAPPED_TIERS   = {"Marquee", "Star", "Established"}
UNCAPPED_TIERS = {"Emerging", "Uncapped"}

SET_ORDER = [
    "M1",   # Set 1  — marquee top half
    "M2",   # Set 2  — marquee bottom half
    "BA1",  # Set 3  — capped batters
    "AL1",  # Set 4  — capped all-rounders
    "WK1",  # Set 5  — capped wicket-keepers
    "FA1",  # Set 6  — capped fast bowlers
    "SP1",  # Set 7  — capped spin bowlers
    "UBA1", # Set 8  — uncapped batters
    "UAL1", # Set 9  — uncapped all-rounders
    "UWK1", # Set 10 — uncapped wicket-keepers
    "UFA1", # Set 11 — uncapped fast bowlers
    "USP1", # Set 12 — uncapped spin bowlers
    "BA2",  # Set 13 — capped batters round 2
    "AL2",  # Set 14 — capped all-rounders round 2
    "WK2",  # Set 15 — capped wicket-keepers round 2
    "FA2",  # Set 16 — capped fast bowlers round 2
    "SP2",  # Set 17 — capped spin bowlers round 2
    "ACC",  # Accelerated / remainder
]
SET_LABEL = {
    "M1":"SET 1 — MARQUEE (M1)", "M2":"SET 2 — MARQUEE (M2)",
    "BA1":"SET 3 — CAPPED BATTERS (BA1)", "AL1":"SET 4 — CAPPED ALL-ROUNDERS (AL1)",
    "WK1":"SET 5 — CAPPED WICKETKEEPERS (WK1)", "FA1":"SET 6 — CAPPED FAST BOWLERS (FA1)",
    "SP1":"SET 7 — CAPPED SPIN BOWLERS (SP1)",
    "UBA1":"SET 8 — UNCAPPED BATTERS (UBA1)", "UAL1":"SET 9 — UNCAPPED ALL-ROUNDERS (UAL1)",
    "UWK1":"SET 10 — UNCAPPED WICKETKEEPERS (UWK1)", "UFA1":"SET 11 — UNCAPPED FAST BOWLERS (UFA1)",
    "USP1":"SET 12 — UNCAPPED SPIN BOWLERS (USP1)",
    "BA2":"SET 13 — CAPPED BATTERS ROUND 2 (BA2)", "AL2":"SET 14 — CAPPED ALL-ROUNDERS ROUND 2 (AL2)",
    "WK2":"SET 15 — CAPPED WICKETKEEPERS ROUND 2 (WK2)", "FA2":"SET 16 — CAPPED FAST BOWLERS ROUND 2 (FA2)",
    "SP2":"SET 17 — CAPPED SPIN BOWLERS ROUND 2 (SP2)",
    "ACC":"ACCELERATED ROUND",
}

def assign_set(name, role, tier, base_price, mv):
    enc = enriched.get(name, {})
    is_wk        = enc.get("wk", False) or role == "WK"
    bowl_type    = enc.get("bowlType")   # "pace" | "spin" | None
    is_capped    = tier in CAPPED_TIERS
    is_uncapped  = tier in UNCAPPED_TIERS
    is_marquee   = (tier == "Marquee")

    if is_marquee:
        return None  # handled separately after sorting all marquees

    if is_capped:
        if is_wk:                              return "WK1"
        if role == "Batter":                   return "BA1"
        if role == "All-rounder":              return "AL1"
        if role == "Bowler" and bowl_type == "spin": return "SP1"
        if role == "Bowler":                   return "FA1"  # pace or unknown
        return "BA1"  # fallback

    if is_uncapped:
        if is_wk:                              return "UWK1"
        if role == "Batter":                   return "UBA1"
        if role == "All-rounder":              return "UAL1"
        if role == "Bowler" and bowl_type == "spin": return "USP1"
        if role == "Bowler":                   return "UFA1"
        return "UBA1"

    return "ACC"

# ── Bucket all players ────────────────────────────────────────────────────────
buckets = {s: [] for s in SET_ORDER}

# First separate marquees and sort by mv desc
marquees = [(e[0],e[1],e[2],float(e[3]),float(e[4]),e[5],e[6] if len(e)>6 else None)
            for e in base if e[5] == "Marquee"]
marquees.sort(key=lambda x: -x[4])  # sort by mv descending

# Split marquees: top ~half go M1, rest M2 (real auction had 6+6 or 6+rest split)
# We'll do half/half for a balanced dramatic opener
half = max(1, len(marquees)//2)
for i,m in enumerate(marquees):
    s = "M1" if i < half else "M2"
    buckets[s].append(m)

# Non-marquees
non_marquees = [(e[0],e[1],e[2],float(e[3]),float(e[4]),e[5],e[6] if len(e)>6 else None)
                for e in base if e[5] != "Marquee"]

# First pass: assign to BA1/AL1/WK1/FA1/SP1 or uncapped equivalents
first_assigns = {}
for p in non_marquees:
    name,role,country,bp,mv,tier,cmt = p
    s = assign_set(name, role, tier, bp, mv)
    first_assigns[name] = s

# Detect overcrowded capped sets → overflow to BA2/AL2/WK2/FA2/SP2
# In the real auction each set is kept to ~6-10 players for pacing.
# Distribute evenly: first 8 per set go to BA1 etc., rest to BA2 etc.
MAX_SET_SIZE = 8
overflow_map = {"BA1":"BA2","AL1":"AL2","WK1":"WK2","FA1":"FA2","SP1":"SP2"}
set_counts = {s:0 for s in SET_ORDER}

def add_to_bucket(player, set_key):
    buckets[set_key].append(player)
    set_counts[set_key] += 1

for p in non_marquees:
    name,role,country,bp,mv,tier,cmt = p
    s = first_assigns[name]
    overflow = overflow_map.get(s)
    # If primary capped set is full AND overflow exists AND player is capped → send to overflow
    if overflow and set_counts[s] >= MAX_SET_SIZE:
        add_to_bucket(p, overflow)
    else:
        add_to_bucket(p, s)

# ── Sort within each bucket ───────────────────────────────────────────────────
# Descending base price, then descending mv (matches real auction: ₹200L first)
for s in SET_ORDER:
    buckets[s].sort(key=lambda x: (-x[3], -x[4]))

# ── Reassemble and write ──────────────────────────────────────────────────────
out = []
prev_set = None
for s in SET_ORDER:
    players = buckets[s]
    if not players:
        continue
    for i, (name,role,country,bp,mv,tier,cmt) in enumerate(players):
        label = SET_LABEL[s] if i == 0 else None  # set header only on first player
        out.append([name, role, country, bp, mv, tier, label])

with open(BASE_JSON, "w") as f:
    json.dump(out, f, indent=2, ensure_ascii=False)

print(f"Reordered {len(out)} players into {len([s for s in SET_ORDER if buckets[s]])} sets")
for s in SET_ORDER:
    if buckets[s]:
        print(f"  {SET_LABEL[s]}: {len(buckets[s])} players  (base ₹{buckets[s][0][3]:.0f}L–₹{buckets[s][-1][3]:.0f}L)")
