"""Copy every site's on-disk passes_cache.json into Postgres (for sites fetched while the database was asleep)."""
import glob, json, os, sys
from datetime import datetime, timezone
import psycopg

sys.path.insert(0, os.path.dirname(__file__))
import fetch_passes

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ts = lambda x: datetime.fromtimestamp(x, timezone.utc)

with psycopg.connect(fetch_passes.db_url(), connect_timeout=10) as con:
    con.execute(fetch_passes.SCHEMA)
    for d in sorted(glob.glob(os.path.join(ROOT, "data", "sites", "*"))):
        mp, pp = os.path.join(d, "meta.json"), os.path.join(d, "passes_cache.json")
        if not (os.path.exists(mp) and os.path.exists(pp)):
            continue
        name = (json.load(open(mp)).get("site") or {}).get("name")
        f = json.load(open(pp))
        if not name or not f["passes"]:
            print("skip", os.path.basename(d)); continue
        with con.cursor() as cur:
            cur.executemany(
                """insert into passes (site, orbiter, start_utc, end_utc, max_el, samples) values (%s,%s,%s,%s,%s,%s)
                   on conflict (site, orbiter, start_utc) do update set end_utc=excluded.end_utc, max_el=excluded.max_el, samples=excluded.samples""",
                [(name, p["orbiter"], ts(p["start"]), ts(p["end"] - 60), p["max_el"], json.dumps(p["samples"])) for p in f["passes"]])
            cur.executemany(
                "insert into sun (site, t, az, el) values (%s,%s,%s,%s) on conflict (site, t) do update set az=excluded.az, el=excluded.el",
                [(name, ts(t), az, el) for t, az, el in f["sun"]])
        print(f"{name}: {len(f['passes'])} passes, {len(f['sun'])} sun rows")
    con.commit()
    for r in con.execute("select site, count(*) from passes group by 1 order by 1").fetchall():
        print(r)
