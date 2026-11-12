"""Step 2 of the pipeline (the "cron job"): relay-orbiter passes + Sun position
for the site, from JPL Horizons, into Postgres.

Run:  .venv/Scripts/python pipeline/fetch_passes.py [hours_ahead]
Schedule it daily; it is safe to re-run (upserts).
"""
import json, os, sys
from datetime import datetime, timedelta, timezone
import requests
import psycopg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE = {"name": "jezero", "lon_e": 77.4508, "lat": 18.4447, "elev_km": -2.5}
ORBITERS = {"MRO": "-74", "Mars Odyssey": "-53", "TGO": "-143", "Mars Express": "-41"}
MIN_EL = 10.0            # a pass counts when the orbiter is above this
API = "https://ssd.jpl.nasa.gov/api/horizons.api"

SCHEMA = """
create table if not exists passes (
  id serial primary key,
  site text not null, orbiter text not null,
  start_utc timestamptz not null, end_utc timestamptz not null,
  max_el real not null,
  samples jsonb not null,           -- [[unix_s, az_deg, el_deg, range_km, range_rate_km_s], ...] 1/min
  unique (site, orbiter, start_utc)
);
create table if not exists sun (
  site text not null, t timestamptz not null, az real not null, el real not null,
  primary key (site, t)
);
create index if not exists passes_site_end on passes (site, end_utc);
"""


def db_url():
    if os.environ.get("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    for line in open(os.path.join(ROOT, ".env")):
        if line.startswith("DATABASE_URL="):
            return line.split("=", 1)[1].strip()
    raise SystemExit("no DATABASE_URL")


def horizons(command, start, stop, step, quantities, site=None):
    # Horizons wants Mars EAST longitude as NEGATIVE in SITE_COORD.
    site = site or SITE
    # It also rejects positive values, so east longitude goes to 0..360 first (133.8 W = 226.2 E = -226.2).
    site = f"{-(site['lon_e'] % 360)},{site['lat']},{site['elev_km']}"
    p = {"format": "text", "COMMAND": f"'{command}'", "EPHEM_TYPE": "'OBSERVER'",
         "CENTER": "'coord@499'", "COORD_TYPE": "'GEODETIC'", "SITE_COORD": f"'{site}'",
         "START_TIME": f"'{start:%Y-%m-%d %H:%M}'", "STOP_TIME": f"'{stop:%Y-%m-%d %H:%M}'",
         "STEP_SIZE": f"'{step}'", "QUANTITIES": f"'{quantities}'", "CSV_FORMAT": "'YES'",
         "RANGE_UNITS": "'KM'"}
    txt = requests.get(API, params=p, timeout=120).text
    if "$$SOE" not in txt:
        print("  Horizons error:", txt[-400:].strip().replace("\n", " | "))   # the error is at the END
        return []
    rows = []
    for line in txt.split("$$SOE")[1].split("$$EOE")[0].strip().splitlines():
        parts = [x.strip() for x in line.split(",")]
        nums = []
        for x in parts[1:]:
            try:
                nums.append(float(x))
            except ValueError:
                pass
        t = datetime.strptime(parts[0], "%Y-%b-%d %H:%M").replace(tzinfo=timezone.utc)
        rows.append((t, nums))
    return rows


def find_passes(rows):
    """rows: (t, [az, el, range_km, range_rate]). Group the above-horizon arcs, keep those reaching MIN_EL."""
    out, cur = [], []
    for t, n in rows + [(None, [0, -90, 0, 0])]:
        az, el, rng, rdot = n[-4:]
        if el > 0 and t is not None:
            cur.append((t, az, el, rng, rdot))
            continue
        if cur:
            good = [s for s in cur if s[2] >= MIN_EL]
            if good:
                out.append({"start": good[0][0], "end": good[-1][0], "max_el": max(s[2] for s in cur),
                            "samples": [[int(s[0].timestamp()), round(s[1], 2), round(s[2], 2),
                                         round(s[3], 1), round(s[4], 4)] for s in cur]})
            cur = []
    return out


def fetch(site=None, hours=72):
    """Horizons only, no database: passes of every relay orbiter + the Sun, for one site."""
    site = site or SITE
    start = datetime.now(timezone.utc).replace(second=0, microsecond=0) - timedelta(hours=2)
    stop = start + timedelta(hours=hours + 2)
    print(f"site {site['name']}  {start:%Y-%m-%d %H:%M} -> {stop:%Y-%m-%d %H:%M} UTC")
    out = {"passes": [], "sun": []}
    for name, sc in ORBITERS.items():
        ps = find_passes(horizons(sc, start, stop, "1 m", "4,20", site))
        for p in ps:
            p["orbiter"] = name
        out["passes"] += ps
        mins = sum((p["end"] - p["start"]).total_seconds() / 60 + 1 for p in ps)
        print(f"  {name:13s} {len(ps):3d} passes, {mins:5.0f} min above {MIN_EL:.0f} deg, "
              f"best {max([p['max_el'] for p in ps], default=0):.0f} deg")
    out["sun"] = [(t, n[-2], n[-1]) for t, n in horizons("10", start, stop, "5 m", "4", site)]
    print(f"  Sun           {len(out['sun'])} samples, max elevation {max([s[2] for s in out['sun']], default=0):.0f} deg")
    return out


def store(data, site=None):
    """Upsert one fetch() result into Postgres."""
    site = site or SITE
    with psycopg.connect(db_url(), connect_timeout=5) as con:
        con.execute(SCHEMA)
        with con.cursor() as cur:
            cur.executemany(
                """insert into passes (site, orbiter, start_utc, end_utc, max_el, samples)
                   values (%s,%s,%s,%s,%s,%s)
                   on conflict (site, orbiter, start_utc) do update
                   set end_utc=excluded.end_utc, max_el=excluded.max_el, samples=excluded.samples""",
                [(site["name"], p["orbiter"], p["start"], p["end"], p["max_el"], json.dumps(p["samples"]))
                 for p in data["passes"]])
            cur.executemany(
                "insert into sun (site, t, az, el) values (%s,%s,%s,%s) on conflict (site, t) do update set az=excluded.az, el=excluded.el",
                [(site["name"], t, az, el) for t, az, el in data["sun"]])
        con.commit()
        n = con.execute("select count(*) from passes where site=%s", (site["name"],)).fetchone()[0]
        print("passes in DB:", n)


def main(hours=72, site=None):
    data = fetch(site, hours)
    store(data, site)
    return data


if __name__ == "__main__":
    main(int(sys.argv[1]) if len(sys.argv) > 1 else 72)
