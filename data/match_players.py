#!/usr/bin/env python3
"""Match our 192 players.js names to Cricsheet stat names; report coverage."""
import json, os, re

HERE = os.path.dirname(__file__)
PLAYERS_JS = os.path.join(HERE, "..", "ipl-app", "src", "players.js")
STATS = os.path.join(HERE, "player_stats.json")

# Manual aliases: our name -> exact Cricsheet stat key (for tricky/ambiguous ones)
ALIAS = {
    "Suryakumar Yadav": "SA Yadav",
    "KL Rahul": "KL Rahul",
    "Sai Sudharsan": "B Sai Sudharsan",
    "Mohammed Siraj": "Mohammed Siraj",
    "Mohammed Shami": "Mohammed Shami",
    "T Natarajan": "T Natarajan",
    "Naveen-ul-Haq": "Naveen-ul-Haq",
    "Rahmanullah Gurbaz": "Rahmanullah Gurbaz",
    "Mukesh Kumar": "Mukesh Kumar",
    "Wanindu Hasaranga": "PWH de Silva",
    "Varun Chakravarthy": "CV Varun",
    "Allah Ghazanfar": "AM Ghazanfar",
    "Sediqullah Atal": "Sediqullah Atal",
}

with open(STATS) as f:
    stats = json.load(f)

# index cricsheet names by surname
def split_cs(name):
    parts = name.split(" ", 1)
    if len(parts) == 1:
        return "", parts[0]
    return parts[0], parts[1]

by_surname = {}
for cs in stats:
    init, sur = split_cs(cs)
    by_surname.setdefault(sur.lower(), []).append(cs)

# parse our player names
names = []
with open(PLAYERS_JS) as f:
    for line in f:
        mm = re.search(r'm\("([^"]+)"', line)
        if mm:
            names.append(mm.group(1))

def match(our):
    if our in ALIAS:
        a = ALIAS[our]
        return a if (a is None or a in stats) else None
    if our in stats:
        return our
    toks = our.split()
    first_init = toks[0][0]
    surname = toks[-1].lower()
    cands = by_surname.get(surname, [])
    # also try 2-word surname (e.g., "de Kock")
    if len(toks) >= 2:
        sur2 = " ".join(toks[-2:]).lower()
        cands = cands + by_surname.get(sur2, [])
    # filter by first initial
    f1 = [c for c in cands if split_cs(c)[0][:1].upper() == first_init.upper()]
    pool = f1 if f1 else cands
    if not pool:
        return None
    # prefer most recent/active
    pool.sort(key=lambda c: stats[c].get("recent_matches",0), reverse=True)
    return pool[0]

matched, unmatched = {}, []
for nm in names:
    res = match(nm)
    if res:
        matched[nm] = res
    else:
        unmatched.append(nm)

print(f"matched {len(matched)}/{len(names)}  unmatched {len(unmatched)}")
print("\n=== UNMATCHED ===")
for u in unmatched:
    print(" ", u)
# spot check
print("\n=== SPOT CHECK ===")
for nm in ["Virat Kohli","Jasprit Bumrah","Suryakumar Yadav","KL Rahul","Travis Head","Matheesha Pathirana","Rashid Khan","Heinrich Klaasen"]:
    r = matched.get(nm)
    pos = stats[r]["bat"].get("pos") if r and "bat" in stats[r] else None
    print(f"  {nm:24s} -> {r}   pos={pos}")

with open(os.path.join(HERE,"name_map.json"),"w") as f:
    json.dump(matched, f, indent=0)
