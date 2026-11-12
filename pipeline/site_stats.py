"""Compare relay coverage at candidate sites over several days (JPL Horizons).

Answers: which site sees orbiters most often, and how long is the worst silence?
Does not touch the database. Writes data/site_stats.json.

Run:  .venv/Scripts/python pipeline/site_stats.py [days]
"""
import json, os, sys
from datetime import datetime, timedelta, timezone
import fetch_passes as fp

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITES = [   # rough picks, east longitude
    {"name": "Jezero", "lon_e": 77.45, "lat": 18.44, "elev_km": -2.4},
    {"name": "Utopia Planitia", "lon_e": 134.0, "lat": 48.0, "elev_km": -4.2},
    {"name": "Hellas floor", "lon_e": 70.0, "lat": -42.0, "elev_km": -7.0},
]
GOOD_EL = 40.0


def main():
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 7
    start = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    stop = start + timedelta(days=days)
    print(f"{start:%Y-%m-%d %H:%M} -> {stop:%Y-%m-%d %H:%M} UTC ({days} days), pass = above {fp.MIN_EL:.0f} deg, good = peak >= {GOOD_EL:.0f} deg\n")
    out = []
    for site in SITES:
        fp.SITE = site
        allp, per, missing = [], {}, []
        for name, sc in fp.ORBITERS.items():
            rows = fp.horizons(sc, start, stop, "1 m", "4,20")
            if not rows:
                missing.append(name); continue
            if rows[-1][0] < stop - timedelta(hours=1):
                missing.append(f"{name} (data ends {rows[-1][0]:%d %b %H:%M})")
            ps = fp.find_passes(rows)
            per[name] = ps; allp += [(p["start"], p["end"] + timedelta(minutes=1), p["max_el"], name) for p in ps]
        allp.sort()
        # merge overlapping passes -> covered intervals -> silent gaps
        merged = []
        for a, b, *_ in allp:
            if merged and a <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], b)
            else:
                merged.append([a, b])
        edges = [start] + [t for iv in merged for t in iv] + [stop]
        gaps = [(edges[i + 1] - edges[i]).total_seconds() / 3600 for i in range(0, len(edges), 2)]
        cover = sum((b - a).total_seconds() for a, b in merged) / 3600
        overlap = sum((b - a).total_seconds() for a, b, *_ in allp) / 3600 - cover
        # per-day counts
        daily_good, daily_all, daily_gap = [], [], []
        for d in range(days):
            a, b = start + timedelta(days=d), start + timedelta(days=d + 1)
            dp = [p for p in allp if a <= p[0] < b]
            daily_all.append(len(dp)); daily_good.append(sum(p[2] >= GOOD_EL for p in dp))
        res = {
            "site": site, "days": days,
            "passes_per_day": sum(daily_all) / days, "good_per_day": sum(daily_good) / days,
            "good_min_day": min(daily_good), "good_max_day": max(daily_good),
            "coverage_h_per_day": cover / days, "two_orbiters_h_per_day": overlap / days,
            "worst_gap_h": max(gaps), "median_gap_h": sorted(gaps)[len(gaps) // 2],
            "by_orbiter": {n: {"passes_per_day": len(ps) / days,
                               "good_per_day": sum(p["max_el"] >= GOOD_EL for p in ps) / days,
                               "min_per_day": sum((p["end"] - p["start"]).total_seconds() / 60 + 1 for p in ps) / days}
                           for n, ps in per.items()},
            "missing": missing,
        }
        out.append(res)
        print(f"{site['name']}  ({site['lon_e']}E, {site['lat']}N, {site['elev_km']} km)")
        print(f"  passes/day {res['passes_per_day']:.1f}   good/day {res['good_per_day']:.1f} (range {res['good_min_day']}-{res['good_max_day']})"
              f"   coverage {res['coverage_h_per_day']:.2f} h/day   two at once {res['two_orbiters_h_per_day']*60:.0f} min/day")
        print(f"  worst gap {res['worst_gap_h']:.1f} h   median gap {res['median_gap_h']:.1f} h")
        for n, o in res["by_orbiter"].items():
            print(f"    {n:13s} {o['passes_per_day']:.1f} passes/day, {o['good_per_day']:.1f} good, {o['min_per_day']:.0f} min/day")
        if missing:
            print("  INCOMPLETE:", ", ".join(missing))
        print()
    json.dump({"start": start.isoformat(), "days": days, "sites": out}, open(os.path.join(ROOT, "data", "site_stats.json"), "w"), indent=1)


if __name__ == "__main__":
    main()
