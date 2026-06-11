#!/usr/bin/env python3
"""Enrich players.js with real-stat-derived archetypes -> writes new players.js."""
import json, os, re

HERE = os.path.dirname(__file__)
BASE_JSON  = os.path.join(HERE, "players_base.json")
OUT_JS     = os.path.join(HERE, "..", "ipl-app", "src", "players.js")

stats   = json.load(open(os.path.join(HERE, "player_stats.json")))
namemap = json.load(open(os.path.join(HERE, "name_map.json")))

# Cricsheet has no bowler-type field, so spin bowlers are curated (cricket knowledge).
# Everyone else who bowls a meaningful amount is classified pace.
SPINNERS = {
 "Rashid Khan","Yuzvendra Chahal","Kuldeep Yadav","Varun Chakravarthy","Ravi Bishnoi",
 "Wanindu Hasaranga","Maheesh Theekshana","Adam Zampa","Tabraiz Shamsi","Noor Ahmad",
 "Sunil Narine","Ravindra Jadeja","Axar Patel","Washington Sundar","Mitchell Santner",
 "Moeen Ali","Shakib Al Hasan","Dunith Wellalage","Kumar Kartikeya","Suyash Sharma",
 "Manav Suthar","Shahbaz Ahmed","Vipraj Nigam","Swapnil Singh","Allah Ghazanfar",
 "Rachin Ravindra","Riyan Parag","Mahipal Lomror","Glenn Maxwell","Nishant Sindhu",
 "Karn Sharma","Sai Kishore","Mayank Markande",
 # newly added spin bowlers / spin all-rounders
 "Keshav Maharaj","Akeal Hosein","Michael Bracewell","Roston Chase","Sikandar Raza",
 "Piyush Chawla","Amit Mishra","Murugan Ashwin","Shreyas Gopal","KC Cariappa",
 "Manimaran Siddharth","Vignesh Puthur","Jayant Yadav","Saurabh Kumar","Anukul Roy",
 "Jalaj Saxena",
}
# Pure batters / keepers who don't bowl at all
NONBOWLERS = {
 "Virat Kohli","Rohit Sharma","Suryakumar Yadav","Rishabh Pant","Shubman Gill","KL Rahul",
 "Yashasvi Jaiswal","Ruturaj Gaikwad","Faf du Plessis","David Warner","Jos Buttler",
 "Quinton de Kock","Shreyas Iyer","Devon Conway","Phil Salt","Tristan Stubbs",
 "Heinrich Klaasen","Nicholas Pooran","Travis Head","Sanju Samson","Jonny Bairstow",
 "Kane Williamson","Steve Smith","Ajinkya Rahane","Shikhar Dhawan","Manish Pandey",
 "Rinku Singh","Tilak Varma","Sai Sudharsan","Rajat Patidar","Devdutt Padikkal",
 "Prithvi Shaw","Rahmanullah Gurbaz","Rovman Powell","Shimron Hetmyer","Ishan Kishan",
 "Jitesh Sharma","Dhruv Jurel","David Miller","Aiden Markram","Matthew Wade",
 "Finn Allen","Jake Fraser-McGurk","Tim David","Jason Roy","Ibrahim Zadran",
 "Kusal Mendis","Litton Das","Shai Hope","Abhishek Porel",
}

def clip(x, lo, hi): return max(lo, min(hi, x))

def derive(name, role, tier):
    s = stats.get(namemap.get(name)) if name in namemap else None
    bat = s.get("bat") if s else None
    bw  = s.get("bowl") if s else None

    # ---- batting order ----
    batOrder = None
    if bat and bat.get("pos") and bat.get("inns",0) >= 8:
        p = bat["pos"]
        batOrder = "top" if p <= 3.0 else ("mid" if p <= 5.7 else "lower")
    if batOrder is None:
        # fallback from role
        batOrder = {"Batter":"top","WK":"top","All-rounder":"mid","Bowler":"lower"}[role]

    # ---- bowling type + phase ----
    bowlType, bowlPhase, deathSpec = None, None, False
    real_bowler = bw and bw.get("balls",0) >= 60
    if name in NONBOWLERS:
        real_bowler = False
    if real_bowler:
        bowlType = "spin" if name in SPINNERS else "pace"
        ph = {"pp":bw["pp"]["balls"], "mid":bw["mid"]["balls"], "death":bw["death"]["balls"]}
        total = sum(ph.values()) or 1
        bowlPhase = max(ph, key=ph.get)
        deathSpec = (ph["death"]/total) >= 0.38
        if deathSpec: bowlPhase = "death"
    elif role in ("Bowler","All-rounder"):
        # no/low data: curate from tier knowledge
        bowlType = "spin" if name in SPINNERS else "pace"
        bowlPhase = "death" if role=="Bowler" and tier in ("Uncapped","Emerging") else "mid" if bowlType=="spin" else "pp"

    # ---- wicketkeeper ----
    wk = (role == "WK") or (s and s.get("stumpings",0) >= 5)

    # ---- finisher (lower/mid order power hitter) ----
    finisher = False
    if bat and bat.get("sr") and bat.get("balls",0) >= 150:
        if batOrder in ("mid","lower") and bat["sr"] >= 142 and bat.get("boundary_pct",0) >= 15:
            finisher = True
    if role == "Bowler":
        finisher = False

    # ---- data-driven rating 45-95 ----
    anchor = {"Marquee":87,"Star":79,"Established":69,"Emerging":60,"Uncapped":51}[tier]
    adj = 0.0
    if bat and bat.get("balls",0) >= 200 and batOrder in ("top","mid"):
        sr = bat.get("sr",0); avg = bat.get("avg") or 20
        adj = max(adj, clip((sr-128)/30,-1.2,1.2)*4 + clip((avg-28)/16,-1.2,1.2)*4)
    if bw and bw.get("balls",0) >= 300:
        econ = bw.get("econ",9); wpm = bw["wkts"]/max(1,bw["balls"]/24)
        adj = max(adj, clip((8.4-econ)/2.2,-1.2,1.2)*4 + clip((wpm-1)/0.8,-1.2,1.2)*4)
    # recency: drop rating for players who haven't featured recently
    if s and s.get("recent_matches",0) == 0 and s.get("last_season",0) < 2023:
        adj -= 8
    rating = round(clip(anchor + adj, 45, 95))

    sample = {"bat_balls": (bat.get("balls",0) if bat else 0),
              "bowl_balls": (bw.get("balls",0) if bw else 0)}
    realstat = {}
    if bat: realstat["sr"] = bat.get("sr"); realstat["avg"] = bat.get("avg"); realstat["pos"] = bat.get("pos")
    if bw:  realstat["econ"] = bw.get("econ"); realstat["wkts"] = bw.get("wkts")
    return dict(batOrder=batOrder, bowlType=bowlType, bowlPhase=bowlPhase,
                deathSpec=deathSpec, wk=wk, finisher=finisher, rating=rating,
                stat=realstat)

# read base data (idempotent source: input != output)
base = json.load(open(BASE_JSON))
rows = []
for entry in base:
    name, role, country, base_price, mv, tier = entry[0], entry[1], entry[2], float(entry[3]), float(entry[4]), entry[5]
    comment = entry[6] if len(entry) > 6 else None
    cmt = f"// {comment}" if comment else None
    d = derive(name, role, tier)
    rows.append((cmt, name, role, country, base_price, mv, tier, d))

print(f"parsed {len(rows)} players")
# coverage summary
no_bat = sum(1 for r in rows if not r[7]["stat"].get("sr"))
print("players with no batting stat:", no_bat)

# emit new players.js
def esc(s): return s.replace('"','\\"')
out = []
out.append("""// ============================================================================
// IPL PLAYER POOL — real-stat-enriched archetypes (source: Cricsheet ball-by-ball).
// Generated by data/enrich.py — DO NOT hand-edit; edit the pipeline instead.
//
// Schema: { name, role, country, overseas, base, mv, tier, rating,
//           batOrder, bowlType, bowlPhase, deathSpec, wk, finisher, stat }
//   batOrder  ∈ top | mid | lower            (where they bat)
//   bowlType  ∈ pace | spin | null           (how they bowl)
//   bowlPhase ∈ pp | mid | death | null      (when they bowl)
//   deathSpec =  true if a death-overs specialist
//   wk        =  wicketkeeper (1 compulsory per XI)
//   finisher  =  lower/middle-order power hitter
//   rating    =  0-100 data-driven overall (drives bidding tie-breaks + future match sim)
//   stat      =  real career numbers {sr, avg, pos, econ, wkts} for reference
// ============================================================================

export const PLAYERS = [""")
for (cmt, name, role, country, base, mv, tier, d) in rows:
    if cmt:
        out.append("  " + cmt)
    st = d["stat"]
    stbits = ", ".join(f'{k}: {json.dumps(v)}' for k,v in st.items() if v is not None)
    out.append(
        f'  {{ name: "{esc(name)}", role: "{role}", country: "{country}", '
        f'overseas: {str(country!="IND").lower()}, base: {base}, mv: {mv}, tier: "{tier}", '
        f'rating: {d["rating"]}, batOrder: "{d["batOrder"]}", '
        f'bowlType: {json.dumps(d["bowlType"])}, bowlPhase: {json.dumps(d["bowlPhase"])}, '
        f'deathSpec: {str(d["deathSpec"]).lower()}, wk: {str(bool(d["wk"])).lower()}, '
        f'finisher: {str(d["finisher"]).lower()}, stat: {{{stbits}}} }},'
    )
out.append("];\n\nexport default PLAYERS;")
open(OUT_JS,"w").write("\n".join(out)+"\n")
print("wrote", OUT_JS)
