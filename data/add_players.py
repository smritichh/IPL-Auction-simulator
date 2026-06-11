#!/usr/bin/env python3
"""Add a batch of new players to players_base.json (idempotent — skips names
that already exist). Run once: python3 data/add_players.py

After running, re-run the pipeline:
  python3 data/enrich.py          # generate players.js (incl. new players)
  python3 data/reorder_sets.py    # reorder base into official set order
  python3 data/enrich.py          # regenerate players.js in set order
"""
import json, os
from collections import Counter

HERE = os.path.dirname(__file__)
BASE = os.path.join(HERE, "players_base.json")

# [name, role, country, base_price, mv, tier]  (set-comment slot filled by reorder)
NEW = [
    # ── Big-name capped internationals that were missing ──
    ["Mitchell Starc",       "Bowler",      "AUS", 2.0, 12.0, "Star"],
    ["Josh Hazlewood",       "Bowler",      "AUS", 1.5,  9.0, "Star"],
    ["Tim Southee",          "Bowler",      "NZ",  1.0,  5.0, "Established"],
    ["Jason Holder",         "All-rounder", "WI",  1.5,  7.0, "Established"],
    ["Sikandar Raza",        "All-rounder", "ZIM", 1.0,  5.0, "Established"],
    ["David Willey",         "All-rounder", "ENG", 1.0,  5.0, "Established"],
    ["Michael Bracewell",    "All-rounder", "NZ",  1.0,  5.0, "Established"],
    ["Roston Chase",         "All-rounder", "WI",  0.75, 4.0, "Established"],
    ["Keshav Maharaj",       "Bowler",      "RSA", 0.75, 4.0, "Established"],
    ["Akeal Hosein",         "Bowler",      "WI",  0.75, 4.0, "Established"],
    ["Shamar Joseph",        "Bowler",      "WI",  0.75, 4.0, "Established"],
    ["Chris Jordan",         "Bowler",      "ENG", 0.75, 4.0, "Established"],
    ["Saqib Mahmood",        "Bowler",      "ENG", 0.5,  3.0, "Established"],
    ["Nathan Coulter-Nile",  "Bowler",      "AUS", 0.5,  3.0, "Established"],
    ["Wayne Parnell",        "Bowler",      "RSA", 0.5,  3.0, "Established"],
    ["Sean Abbott",          "All-rounder", "AUS", 0.5,  3.0, "Established"],
    ["Daniel Sams",          "All-rounder", "AUS", 0.5,  3.0, "Established"],
    ["Tim Seifert",          "WK",          "NZ",  0.75, 4.0, "Established"],
    ["Sam Billings",         "WK",          "ENG", 0.5,  3.0, "Established"],
    ["Reeza Hendricks",      "Batter",      "RSA", 0.75, 4.0, "Established"],
    ["Brandon King",         "Batter",      "WI",  0.75, 4.0, "Established"],
    ["Ben Duckett",          "Batter",      "ENG", 0.75, 4.0, "Established"],
    ["Donovan Ferreira",     "WK",          "RSA", 0.5,  3.0, "Emerging"],

    # ── Capped / experienced Indians that were missing ──
    ["Umran Malik",          "Bowler",      "IND", 1.0,  6.0, "Established"],
    ["Jaydev Unadkat",       "Bowler",      "IND", 0.75, 4.0, "Established"],
    ["Umesh Yadav",          "Bowler",      "IND", 0.75, 4.0, "Established"],
    ["Shivam Mavi",          "Bowler",      "IND", 0.5,  3.0, "Emerging"],
    ["Navdeep Saini",        "Bowler",      "IND", 0.5,  3.0, "Established"],
    ["Piyush Chawla",        "Bowler",      "IND", 0.5,  3.0, "Established"],
    ["Amit Mishra",          "Bowler",      "IND", 0.5,  3.0, "Established"],
    ["Murugan Ashwin",       "Bowler",      "IND", 0.5,  3.0, "Established"],
    ["Karn Sharma",          "Bowler",      "IND", 0.5,  3.0, "Emerging"],
    ["Sai Kishore",          "Bowler",      "IND", 0.75, 4.0, "Established"],
    ["Mayank Markande",      "Bowler",      "IND", 0.5,  3.0, "Emerging"],
    ["Rahul Tripathi",       "Batter",      "IND", 0.75, 5.0, "Established"],
    ["KS Bharat",            "WK",          "IND", 0.5,  3.0, "Established"],
    ["Shahrukh Khan",        "All-rounder", "IND", 0.75, 4.0, "Emerging"],

    # ── Vaibhav Suryavanshi + emerging domestic talents ──
    ["Vaibhav Suryavanshi",  "Batter",      "IND", 0.3,  3.0, "Emerging"],
    ["Aniket Verma",         "Batter",      "IND", 0.3,  2.0, "Uncapped"],
    ["Shaik Rasheed",        "Batter",      "IND", 0.3,  1.5, "Uncapped"],
    ["Ricky Bhui",           "Batter",      "IND", 0.3,  1.5, "Uncapped"],
    ["Sachin Baby",          "Batter",      "IND", 0.3,  1.5, "Uncapped"],
    ["Himmat Singh",         "Batter",      "IND", 0.3,  1.5, "Uncapped"],
    ["Harnoor Singh",        "Batter",      "IND", 0.3,  1.5, "Uncapped"],
    ["Swastik Chikara",      "Batter",      "IND", 0.3,  1.5, "Uncapped"],
    ["Abdul Bazith",         "Batter",      "IND", 0.3,  1.5, "Uncapped"],
    ["Upendra Yadav",        "WK",          "IND", 0.3,  1.5, "Uncapped"],
    ["Luvnith Sisodia",      "WK",          "IND", 0.3,  1.5, "Uncapped"],

    # ── Domestic all-rounders ──
    ["Anukul Roy",           "All-rounder", "IND", 0.3,  2.0, "Uncapped"],
    ["Jalaj Saxena",         "All-rounder", "IND", 0.3,  2.0, "Uncapped"],
    ["Jayant Yadav",         "All-rounder", "IND", 0.3,  2.0, "Uncapped"],
    ["Saurabh Kumar",        "All-rounder", "IND", 0.3,  1.5, "Uncapped"],
    ["Lalit Yadav",          "All-rounder", "IND", 0.3,  2.0, "Uncapped"],
    ["Suryansh Shedge",      "All-rounder", "IND", 0.3,  1.5, "Uncapped"],
    ["Prerak Mankad",        "All-rounder", "IND", 0.3,  1.5, "Uncapped"],
    ["Mohit Rathee",         "All-rounder", "IND", 0.3,  1.5, "Uncapped"],

    # ── Domestic bowlers (pace) ──
    ["Chetan Sakariya",      "Bowler",      "IND", 0.3,  2.0, "Uncapped"],
    ["Basil Thampi",         "Bowler",      "IND", 0.3,  2.0, "Uncapped"],
    ["Anshul Kamboj",        "Bowler",      "IND", 0.5,  3.0, "Emerging"],
    ["Vaibhav Arora",        "Bowler",      "IND", 0.5,  3.0, "Emerging"],
    ["Sandeep Warrier",      "Bowler",      "IND", 0.3,  1.5, "Uncapped"],
    ["Akash Vasisht",        "Bowler",      "IND", 0.3,  1.5, "Uncapped"],

    # ── Domestic bowlers (spin) ──
    ["Shreyas Gopal",        "Bowler",      "IND", 0.3,  2.0, "Uncapped"],
    ["KC Cariappa",          "Bowler",      "IND", 0.3,  1.5, "Uncapped"],
    ["Manimaran Siddharth",  "Bowler",      "IND", 0.3,  2.0, "Uncapped"],
    ["Vignesh Puthur",       "Bowler",      "IND", 0.3,  2.0, "Uncapped"],
]

base = json.load(open(BASE))
existing = {e[0] for e in base}

added = 0
for p in NEW:
    if p[0] in existing:
        print("skip (exists):", p[0])
        continue
    base.append(p)        # 6-field row; reorder_sets.py adds the set-comment slot
    existing.add(p[0])
    added += 1

json.dump(base, open(BASE, "w"), indent=2, ensure_ascii=False)

print(f"\nAdded {added} new players. Total now: {len(base)}")
print("by tier:", dict(Counter(e[5] for e in base)))
print("by role:", dict(Counter(e[1] for e in base)))
print("overseas:", sum(1 for e in base if e[2] != "IND"))
