#!/usr/bin/env python3
"""Export players_base.json to CSV for Excel review.
Run: python3 data/export_players_csv.py
Output: data/players_export.csv
"""
import json, csv, os, re

HERE = os.path.dirname(__file__)

# Also read enriched data from players.js for extra fields
PLAYERS_JS = os.path.join(HERE, "..", "ipl-app", "src", "players.js")

enriched = {}
for line in open(PLAYERS_JS):
    m = re.search(
        r'name:\s*"([^"]+)".*?role:\s*"([^"]+)".*?country:\s*"([^"]+)".*?'
        r'overseas:\s*(true|false).*?base:\s*([\d.]+).*?mv:\s*([\d.]+).*?'
        r'tier:\s*"([^"]+)".*?rating:\s*(\d+).*?batOrder:\s*"([^"]+)".*?'
        r'bowlType:\s*([^,]+).*?bowlPhase:\s*([^,]+).*?'
        r'deathSpec:\s*(true|false).*?wk:\s*(true|false).*?finisher:\s*(true|false)',
        line
    )
    if m:
        name = m.group(1)
        tier_raw = m.group(7)
        # Map to IPL official labels
        if tier_raw == "Marquee":
            ipl_label = "Marquee"
        elif tier_raw in ("Star", "Established"):
            ipl_label = "Capped"
        else:
            ipl_label = "Uncapped"

        def clean(v): return None if v.strip() in ("null","undefined","") else v.strip().strip('"')

        enriched[name] = {
            "role":       m.group(2),
            "country":    m.group(3),
            "overseas":   m.group(4) == "true",
            "base":       float(m.group(5)),
            "mv":         float(m.group(6)),
            "tier_raw":   tier_raw,
            "ipl_tier":   ipl_label,
            "rating":     int(m.group(8)),
            "batOrder":   m.group(9),
            "bowlType":   clean(m.group(10)),
            "bowlPhase":  clean(m.group(11)),
            "deathSpec":  m.group(12) == "true",
            "wk":         m.group(13) == "true",
            "finisher":   m.group(14) == "true",
        }

print(f"Parsed {len(enriched)} enriched players from players.js")

OUT_CSV = os.path.join(HERE, "players_export.csv")
FIELDS = [
    "name", "ipl_tier", "role", "country", "overseas",
    "base_price_cr", "market_value_cr", "rating",
    "bat_order", "bowl_type", "bowl_phase", "death_specialist",
    "wicketkeeper", "finisher",
]

with open(OUT_CSV, "w", newline="", encoding="utf-8") as f:
    w = csv.DictWriter(f, fieldnames=FIELDS)
    w.writeheader()
    for name, d in enriched.items():
        w.writerow({
            "name":              name,
            "ipl_tier":          d["ipl_tier"],
            "role":              d["role"],
            "country":           d["country"],
            "overseas":          "Yes" if d["overseas"] else "No",
            "base_price_cr":     d["base"],
            "market_value_cr":   d["mv"],
            "rating":            d["rating"],
            "bat_order":         d["batOrder"],
            "bowl_type":         d["bowlType"] or "-",
            "bowl_phase":        d["bowlPhase"] or "-",
            "death_specialist":  "Yes" if d["deathSpec"] else "No",
            "wicketkeeper":      "Yes" if d["wk"] else "No",
            "finisher":          "Yes" if d["finisher"] else "No",
        })

print(f"Written {len(enriched)} rows → {OUT_CSV}")
print("Open in Excel via File → Open or double-click the .csv file.")
