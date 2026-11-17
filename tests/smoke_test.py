"""Smoke test for a running Marswalk server: every page loads, every site answers, every layer renders, routes plan on foot and by rover.

Run:  .venv/Scripts/python tests/smoke_test.py [http://127.0.0.1:8077]
"""
import json, sys, time, urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8077").rstrip("/")
LAYERS = ["elevation", "slope", "radiation", "comms", "sun", "heat", "cost"]   # the habitat radio layer is drawn in the browser
fails, oks = [], 0


def get(path, body=None, timeout=120):
    req = urllib.request.Request(BASE + path, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"} if body is not None else {})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.status, r.read()


def check(name, fn):
    global oks
    t = time.time()
    try:
        msg = fn() or ""
        oks += 1
        print(f"  ok   {name} ({time.time() - t:.1f}s) {msg}")
    except Exception as e:
        fails.append((name, str(e)))
        print(f"  FAIL {name}: {e}")


print("pages")
for page in ["home.html", "globe.html", "index.html?site=jezero", "how.html", "tour.html", "tour.html?short=1", "control.html", "slides.html", "report.html"]:
    check(page, lambda p=page: (lambda s: None if s[0] == 200 and len(s[1]) > 200 else (_ for _ in ()).throw(RuntimeError(f"status {s[0]}, {len(s[1])} bytes")))(get("/" + p)))

print("sites")
st, raw = get("/api/sites")
sites = json.loads(raw)
ids = [s["id"] for s in (sites if isinstance(sites, list) else sites.get("sites", []))]
print(f"  {len(ids)} sites")
test_ids = ["jezero"] + (["gale"] if "gale" in ids else []) + [i for i in ids if i not in ("jezero", "gale")][:3] + (["n00p91_w112p77"] if "n00p91_w112p77" in ids and "n00p91_w112p77" not in ids[:3] else [])

for sid in test_ids:
    meta = {}

    def m(sid=sid):
        meta.update(json.loads(get(f"/api/meta?site={sid}")[1]))
        assert meta["W"] > 0 and meta["H"] > 0 and meta["width_m"] > 0, "bad size"
        return f"{meta['W']}x{meta['H']} cells, {meta['width_m'] / 1000:.0f}x{meta['height_m'] / 1000:.0f} km"
    check(f"{sid} meta", m)
    if not meta:
        continue
    for L in LAYERS:
        if L == "heat" and (meta.get("kind") == "region" or not meta.get("heat")):
            continue
        check(f"{sid} layer {L}", lambda L=L, sid=sid: (lambda s: None if s[1][:4] == b"\x89PNG" else (_ for _ in ()).throw(RuntimeError("not a PNG")))(get(f"/api/layer/{L}.png?site={sid}&t={int(time.time())}")))
    for L, on in (meta.get("layers_extra") or {}).items():
        if on:
            check(f"{sid} layer {L}", lambda L=L, sid=sid: (lambda s: None if s[1][1:4] == b"PNG" else (_ for _ in ()).throw(RuntimeError("not a PNG")))(get(f"/api/layer/{L}.png?site={sid}")))
    if sid in ("jezero", "gale"):
        def sci(sid=sid):
            j = json.loads(get(f"/api/science?site={sid}&vehicle=foot")[1])
            assert j["objectives"] and all(o["stops"] for o in j["objectives"]), "no science goals"
            return ", ".join(f"{o['id']} ({len(o['stops'])})" for o in j["objectives"])
        check(f"{sid} science goals", sci)
    check(f"{sid} passes", lambda sid=sid: f"{len(json.loads(get(f'/api/passes?site={sid}&hours=48')[1]).get('passes', []))} passes")
    check(f"{sid} next", lambda sid=sid: (json.loads(get(f"/api/next?site={sid}&hours=24")[1]), None)[1])
    hab = meta.get("habitat") or [meta["width_m"] / 2, meta["height_m"] / 2]
    stop = [hab[0] + 1500, hab[1] + 1200]
    for veh in ["foot", "rover"]:
        def r(veh=veh, sid=sid):
            j = json.loads(get("/api/route", {"site": sid, "stops": [hab, stop], "weights": {"slope": 1, "radiation": 0.3, "comms": 0.3, "shadow": 0.2, "cold": 0.2},
                                              "max_slope": 18, "round_trip": True, "vehicle": veh})[1])
            assert j["distance_m"] > 0 and len(j["x"]) > 2, "empty route"
            return f"{j['distance_m'] / 1000:.2f} km, {j['time_s'] / 3600:.1f} h, {len(j['contacts'])} passes"
        check(f"{sid} route {veh}", r)

def load_test():
    hab = json.loads(get("/api/meta?site=jezero")[1])["habitat"]; body = {"site": "jezero", "stops": [hab, [hab[0] + 1500, hab[1] + 1200]], "vehicle": "foot", "round_trip": True}
    a = json.loads(get("/api/route", {**body, "load_kg": 0})[1]); b = json.loads(get("/api/route", {**body, "load_kg": 40})[1])
    assert b["time_s"] > a["time_s"] * 1.2, "load does not slow the walk"
    return f"{a['time_s'] / 3600:.2f} h -> {b['time_s'] / 3600:.2f} h with 40 kg"
check("carried load slows the walk", load_test)
check("space weather (NASA DONKI)", lambda: (lambda j: j["status"] + ": " + j["summary"][:70] if j["status"] in ("quiet", "watch", "storm", "unknown") else (_ for _ in ()).throw(RuntimeError("bad status")))(json.loads(get("/api/spaceweather")[1])))

print("comms")
check("comms config", lambda: f"{json.loads(get('/api/comms/config')[1])['effective_min']:.1f} light-min")
check("comms send and inbox", lambda: (get("/api/comms/send", {"sender": "astronaut", "to": "pod", "kind": "text", "text": "smoke test", "speed": 1}), time.sleep(2.5),
                                       None if any(m.get("text") == "smoke test" for m in json.loads(get("/api/comms/inbox?role=pod")[1])["messages"]) else (_ for _ in ()).throw(RuntimeError("message not delivered")))[1])
get("/api/comms/clear", {})

print(f"\n{oks} passed, {len(fails)} failed")
for n, e in fails:
    print(f"  FAIL {n}: {e}")
sys.exit(1 if fails else 0)
