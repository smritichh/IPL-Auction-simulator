#!/usr/bin/env python3
"""
Process Cricsheet IPL ball-by-ball JSON into per-player aggregate stats.

Outputs data/player_stats.json keyed by Cricsheet delivery name
(e.g. "V Kohli", "JJ Bumrah"). Captures everything the auction/match engine needs:
  batting: innings, runs, balls, dismissals, strike rate, avg batting position
  bowling: balls, runs conceded, wickets, economy, phase split (pp/mid/death)
  keeping: stumpings (proxy for wicketkeeper)
  recency: matches in the last ~3 seasons, last season seen
  recent form: bat_recent / bowl_recent — the SAME metrics restricted to the
               latest 2 seasons in the data, so enrich.py can weight current
               form above the career aggregate when deriving ratings.
"""
import json, os, glob
from collections import defaultdict

JSON_DIR = os.path.join(os.path.dirname(__file__), "cricsheet", "json")

# Phase boundaries by over index (0-based): PP overs 1-6, middle 7-15, death 16-20
def phase(over_idx):
    if over_idx <= 5:   return "pp"
    if over_idx <= 14:  return "mid"
    return "death"

bat = defaultdict(lambda: {"inns":0,"runs":0,"balls":0,"outs":0,"fours":0,"sixes":0,"pos_sum":0,"pos_n":0})
bowl = defaultdict(lambda: {"balls":0,"runs":0,"wkts":0,
                            "pp_balls":0,"pp_runs":0,"pp_wkts":0,
                            "mid_balls":0,"mid_runs":0,"mid_wkts":0,
                            "death_balls":0,"death_runs":0,"death_wkts":0})
keep = defaultdict(lambda: {"stumpings":0,"catches":0})
recent = defaultdict(int)   # name -> matches since 2023
seasons_seen = defaultdict(set)

# Per-(name, year) minimal buckets. Lets us aggregate the "recent" window (the
# latest 2 seasons) after the single pass, without re-reading every match file.
bat_y  = defaultdict(lambda: {"runs":0,"balls":0,"outs":0})
bowl_y = defaultdict(lambda: {"balls":0,"runs":0,"wkts":0})

BOWLER_WICKETS = {"bowled","caught","lbw","stumped","caught and bowled","hit wicket"}

files = [f for f in glob.glob(os.path.join(JSON_DIR, "*.json")) if not f.endswith("README.txt")]
print(f"processing {len(files)} matches...")

for fi, path in enumerate(files):
    with open(path) as fh:
        try: g = json.load(fh)
        except Exception: continue
    info = g.get("info", {})
    dates = info.get("dates", [])
    year = int(dates[0][:4]) if dates else 0
    is_recent = year >= 2023
    match_players = set()

    for inn in g.get("innings", []):
        # batting position: order of first appearance in this innings
        seen_order = []
        seen_set = set()
        for ov in inn.get("overs", []):
            over_idx = ov.get("over", 0)
            ph = phase(over_idx)
            for d in ov.get("deliveries", []):
                bat_name = d.get("batter")
                bowl_name = d.get("bowler")
                ns = d.get("non_striker")
                # establish batting order
                for nm in (bat_name, ns):
                    if nm and nm not in seen_set:
                        seen_set.add(nm); seen_order.append(nm)
                runs = d.get("runs", {})
                rb = runs.get("batter", 0)
                extras = d.get("extras", {})
                # a "ball faced" = legal delivery (no wide). no-ball still faced.
                is_wide = "wides" in extras
                # batting accrual (career + this year)
                b = bat[bat_name]
                b["runs"] += rb
                if not is_wide:
                    b["balls"] += 1
                if rb == 4: b["fours"] += 1
                if rb == 6: b["sixes"] += 1
                by = bat_y[(bat_name, year)]
                by["runs"] += rb
                if not is_wide: by["balls"] += 1
                # bowling accrual (bowler concedes batter runs + wides + noballs)
                bw = bowl[bowl_name]
                conceded = rb + extras.get("wides",0) + extras.get("noballs",0)
                legal = 0 if ("wides" in extras or "noballs" in extras) else 1
                bw["balls"] += legal
                bw["runs"] += conceded
                bw[ph+"_balls"] += legal
                bw[ph+"_runs"] += conceded
                bwy = bowl_y[(bowl_name, year)]
                bwy["balls"] += legal
                bwy["runs"] += conceded
                # wickets
                for w in d.get("wickets", []):
                    kind = w.get("kind","")
                    out_player = w.get("player_out")
                    if out_player:
                        bat[out_player]["outs"] += 1
                        bat_y[(out_player, year)]["outs"] += 1
                    if kind in BOWLER_WICKETS:
                        bw["wkts"] += 1
                        bw[ph+"_wkts"] += 1
                        bwy["wkts"] += 1
                    # keeper detection
                    for fld in w.get("fielders", []):
                        fn = fld.get("name")
                        if not fn: continue
                        if kind == "stumped":
                            keep[fn]["stumpings"] += 1
                        elif kind == "caught":
                            keep[fn]["catches"] += 1
                if bat_name: match_players.add(bat_name)
                if bowl_name: match_players.add(bowl_name)
        # record innings + batting position
        for i, nm in enumerate(seen_order):
            bat[nm]["inns"] += 1
            bat[nm]["pos_sum"] += (i + 1)
            bat[nm]["pos_n"] += 1

    for nm in match_players:
        seasons_seen[nm].add(year)
        if is_recent:
            recent[nm] += 1

# recent window = the latest 2 seasons present in the data
all_years = {y for (_, y) in bat_y} | {y for (_, y) in bowl_y}
all_years.discard(0)
max_year = max(all_years) if all_years else 0
RECENT_YEARS = {max_year, max_year - 1}
print(f"recent window = {sorted(RECENT_YEARS)}")

# assemble
out = {}
names = set(bat) | set(bowl) | set(keep)
for nm in names:
    b = bat.get(nm); bw = bowl.get(nm); kp = keep.get(nm, {"stumpings":0,"catches":0})
    rec = {}
    if b and b["balls"] > 0:
        rec["bat"] = {
            "inns": b["inns"], "runs": b["runs"], "balls": b["balls"], "outs": b["outs"],
            "sr": round(100*b["runs"]/b["balls"],1),
            "avg": round(b["runs"]/b["outs"],1) if b["outs"] else None,
            "fours": b["fours"], "sixes": b["sixes"],
            "boundary_pct": round(100*(b["fours"]+b["sixes"])/b["balls"],1),
            "pos": round(b["pos_sum"]/b["pos_n"],1) if b["pos_n"] else None,
        }
    if bw and bw["balls"] > 0:
        ov = bw["balls"]/6
        rec["bowl"] = {
            "balls": bw["balls"], "runs": bw["runs"], "wkts": bw["wkts"],
            "econ": round(bw["runs"]/ov,2) if ov else None,
            "pp": {"balls":bw["pp_balls"],"runs":bw["pp_runs"],"wkts":bw["pp_wkts"]},
            "mid": {"balls":bw["mid_balls"],"runs":bw["mid_runs"],"wkts":bw["mid_wkts"]},
            "death": {"balls":bw["death_balls"],"runs":bw["death_runs"],"wkts":bw["death_wkts"]},
        }
    # recent-form splits (latest 2 seasons only)
    rb_ = {"runs":0,"balls":0,"outs":0}
    for y in RECENT_YEARS:
        d = bat_y.get((nm, y))
        if d:
            rb_["runs"] += d["runs"]; rb_["balls"] += d["balls"]; rb_["outs"] += d["outs"]
    if rb_["balls"] > 0:
        rec["bat_recent"] = {
            "balls": rb_["balls"],
            "sr": round(100*rb_["runs"]/rb_["balls"],1),
            "avg": round(rb_["runs"]/rb_["outs"],1) if rb_["outs"] else None,
        }
    rw_ = {"balls":0,"runs":0,"wkts":0}
    for y in RECENT_YEARS:
        d = bowl_y.get((nm, y))
        if d:
            rw_["balls"] += d["balls"]; rw_["runs"] += d["runs"]; rw_["wkts"] += d["wkts"]
    if rw_["balls"] > 0:
        rec["bowl_recent"] = {
            "balls": rw_["balls"], "wkts": rw_["wkts"],
            "econ": round(rw_["runs"]/(rw_["balls"]/6),2),
        }
    rec["stumpings"] = kp["stumpings"]
    rec["catches"] = kp["catches"]
    rec["recent_matches"] = recent.get(nm, 0)
    rec["last_season"] = max(seasons_seen.get(nm, {0}))
    rec["recent_from"] = min(RECENT_YEARS)
    out[nm] = rec

with open(os.path.join(os.path.dirname(__file__), "player_stats.json"), "w") as fh:
    json.dump(out, fh, indent=0)
print(f"wrote {len(out)} players to player_stats.json")
