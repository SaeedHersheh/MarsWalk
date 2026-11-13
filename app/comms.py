"""Radio messages between the walker, the relay orbiters, the pod and Earth mission control.

The walker app decides WHEN a message can leave (only while a relay orbiter is overhead and the link is open).
This module carries it from there:

  walker -> Earth : light delay (real, from JPL Horizons, compressed by the demo speed)
  walker -> pod   : about a second (the pod is on the same ground)
  Earth  -> walker: light delay to the orbiter, then it WAITS at the orbiter until the walker's next pass
  pod    -> walker: no light delay, still waits for a pass

Content (audio or text) is withheld from the receiver until it has really arrived.
Everything is in memory: this is a demo link, not a mailbox.
"""
import base64
import threading
import time
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel

import fetch_passes

router = APIRouter(prefix="/api/comms")
LOCK = threading.Lock()
MSGS = []                      # oldest first
AUDIO = {}                     # id -> (mime, bytes)
CFG = {"override_min": None, "speed": 120.0, "real_min": None, "real_at": 0.0}
NEXT_ID = [1]
RELAY_S = 1.5                  # seconds for the hop through the orbiter itself
FALLBACK_MIN = 12.5            # average Earth-Mars one-way light time, if Horizons cannot be reached
MAX_AUDIO = 1_500_000
KEEP = 120
ROLES = ("astronaut", "earth", "pod")


def real_light_min():
    """One-way Mars -> Earth light time in minutes, from Horizons, refreshed hourly."""
    if CFG["real_min"] is None or time.time() - CFG["real_at"] > 3600:
        CFG["real_at"] = time.time()                       # do not hammer Horizons if it is down
        try:
            t = datetime.now(timezone.utc).replace(second=0, microsecond=0)
            rows = fetch_passes.horizons("399", t, t + timedelta(minutes=2), "1 m", "21")
            if rows:
                CFG["real_min"] = float(rows[0][1][-1])
        except Exception as e:                              # noqa: BLE001
            print("light-time fetch failed:", e)
    return CFG["real_min"]


def effective_min():
    return CFG["override_min"] or real_light_min() or FALLBACK_MIN


def config():
    real = real_light_min()
    return {"real_min": real, "fallback_min": FALLBACK_MIN, "override_min": CFG["override_min"],
            "effective_min": effective_min(), "speed": CFG["speed"], "now": time.time(),
            "source": "JPL Horizons" if real else "average (Horizons unreachable)"}


class Cfg(BaseModel):
    override_min: float | None = None
    speed: float | None = None
    set_override: bool = False


class Send(BaseModel):
    sender: str
    to: str
    kind: str = "text"            # text | voice
    text: str = ""
    audio_b64: str | None = None
    mime: str = "audio/webm"
    via: str | None = None        # which orbiter carried it up
    speed: float | None = None
    secs: float | None = None


def _status(m):
    now = time.time()
    if m["to"] == "astronaut":
        return "delivered" if m["delivered"] else ("at_orbiter" if now >= m["arrive"] else "in_flight")
    return "arrived" if now >= m["arrive"] else "in_flight"


def _view(m, role):
    """What `role` may see of a message: metadata always, content only once it has really arrived."""
    st = _status(m)
    mine = m["sender"] == role
    can_read = mine or (m["to"] == role and st in ("arrived", "delivered"))
    v = {k: m[k] for k in ("id", "sender", "to", "kind", "via", "sent", "arrive", "light_min", "speed", "secs", "delivered")}
    v.update(status=st, mine=mine, has_audio=bool(m["has_audio"]) and can_read)
    if can_read:
        v["text"] = m["text"]
    return v


@router.get("/config")
def get_config():
    return config()


@router.post("/config")
def set_config(c: Cfg):
    if c.set_override:
        CFG["override_min"] = c.override_min if c.override_min and c.override_min > 0 else None
    if c.speed:
        CFG["speed"] = max(1.0, min(5000.0, c.speed))
    return config()


@router.post("/send")
def send(q: Send):
    if q.sender not in ROLES or q.to not in ROLES or q.sender == q.to:
        raise HTTPException(400, "bad sender or destination")
    if (q.sender == "astronaut") == (q.to == "astronaut"):
        raise HTTPException(400, "messages go between the astronaut and the pod or Earth")
    audio = None
    if q.audio_b64:
        try:
            audio = base64.b64decode(q.audio_b64, validate=False)
        except Exception:                                   # noqa: BLE001
            raise HTTPException(400, "audio is not valid base64")
        if len(audio) > MAX_AUDIO:
            raise HTTPException(413, "voice message too long")
    if not audio and not q.text.strip():
        raise HTTPException(400, "empty message")
    speed = max(1.0, min(5000.0, q.speed or CFG["speed"]))
    if q.sender == "astronaut" and q.speed:
        CFG["speed"] = speed
    now = time.time()
    light_min = effective_min()
    delay = (light_min * 60 / speed if "earth" in (q.sender, q.to) else 0.0) + RELAY_S
    with LOCK:
        mid = NEXT_ID[0]
        NEXT_ID[0] += 1
        m = {"id": mid, "sender": q.sender, "to": q.to, "kind": "voice" if audio else "text", "text": q.text.strip()[:600],
             "has_audio": bool(audio), "mime": q.mime, "via": q.via, "sent": now, "arrive": now + delay,
             "light_min": light_min if "earth" in (q.sender, q.to) else 0.0, "speed": speed, "secs": q.secs, "delivered": False}
        MSGS.append(m)
        if audio:
            AUDIO[mid] = (q.mime, audio)
        while len(MSGS) > KEEP:
            AUDIO.pop(MSGS.pop(0)["id"], None)
    return _view(m, q.sender)


@router.get("/inbox")
def inbox(role: str, after: int = 0, speed: float | None = None):
    """Every message to or from `role` newer than `after`, in flight or not."""
    if role not in ROLES:
        raise HTTPException(400, "unknown role")
    if role == "astronaut" and speed:
        CFG["speed"] = max(1.0, min(5000.0, speed))
    with LOCK:
        out = [_view(m, role) for m in MSGS if m["id"] > after and role in (m["sender"], m["to"])]
    return {"now": time.time(), "messages": out, "config": config()}


@router.post("/deliver/{mid}")
def deliver(mid: int):
    """The walker calls this when a relay orbiter is overhead and a waiting message can come down."""
    with LOCK:
        m = next((x for x in MSGS if x["id"] == mid), None)
        if not m or m["to"] != "astronaut":
            raise HTTPException(404, "no such message")
        if time.time() < m["arrive"]:
            raise HTTPException(409, "still in flight")
        m["delivered"] = True
    return _view(m, "astronaut")


@router.get("/audio/{mid}")
def audio(mid: int, role: str):
    with LOCK:
        m = next((x for x in MSGS if x["id"] == mid), None)
        if not m or mid not in AUDIO:
            raise HTTPException(404, "no audio")
        if _view(m, role).get("has_audio") is not True:
            raise HTTPException(403, "not delivered yet")
        mime, data = AUDIO[mid]
    return Response(data, media_type=mime, headers={"Cache-Control": "no-store"})


@router.post("/clear")
def clear():
    with LOCK:
        MSGS.clear()
        AUDIO.clear()
    return {"ok": True}
