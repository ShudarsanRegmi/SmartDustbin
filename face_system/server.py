from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.requests import Request
import cv2
import numpy as np
import requests
import base64
import os
import json
import time
import random
import math
from typing import Optional
from datetime import date, timedelta
from urllib.parse import quote_plus
from dotenv import load_dotenv

load_dotenv(override=True)

from recognizer import extract_embedding, add_embedding, recognize_face, remove_person, list_persons, THRESHOLD
from database import record_pipeline_event, list_pipeline_events, summarize_pipeline_events
import shutil

# Defaults only — actual values always come from .env via os.getenv() at call time
_DEFAULT_ESP32_URL      = "http://11.12.20.131"
_DEFAULT_PLATE_CAM_URL  = "http://11.12.20.132"
PROFILES_FILE  = "face_db/profiles.json"
PHOTOS_DIR     = "face_db/photos"
PLATE_EVENTS_FILE = "face_db/plate_events.json"
PIPELINE_PLATES_DIR = "face_db/pipeline_plates"

app = FastAPI(title="ESP32 Face Recognition")
app.mount("/static", StaticFiles(directory="static"), name="static")
templates = Jinja2Templates(directory="templates")


def load_profiles() -> dict:
    if os.path.exists(PROFILES_FILE):
        with open(PROFILES_FILE) as f:
            return json.load(f)
    return {}


def save_profiles(profiles: dict):
    os.makedirs(os.path.dirname(PROFILES_FILE), exist_ok=True)
    with open(PROFILES_FILE, "w") as f:
        json.dump(profiles, f)


# Persistent HTTP session to the ESP32 — reuses the TCP connection
_session = requests.Session()
_session.headers["Connection"] = "keep-alive"
# (connect_timeout, read_timeout) — give the device 25 s to send the JPEG
_ESP32_TIMEOUT = (4, 25)


def _esp32_base():
    load_dotenv(override=True)
    return os.getenv("ESP32_URL", _DEFAULT_ESP32_URL).rstrip("/")


def _plate_base():
    load_dotenv(override=True)
    return os.getenv("PLATE_CAM_URL", _DEFAULT_PLATE_CAM_URL).rstrip("/")


def _fetch_image(url: str):
    """Fetch a JPEG from an arbitrary URL using the shared session."""
    try:
        r = _session.get(url, timeout=_ESP32_TIMEOUT)
        r.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Camera unreachable: {e}")
    img = np.frombuffer(r.content, np.uint8)
    img = cv2.imdecode(img, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=502, detail="Camera returned invalid image data")
    return img, r.content


# ---------------------------------------------------------------------------
# Pages
# ---------------------------------------------------------------------------

@app.get("/", response_class=HTMLResponse)
def index(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})


@app.get("/enroll", response_class=HTMLResponse)
def enroll_page(request: Request):
    return templates.TemplateResponse("enroll.html", {"request": request})


@app.get("/identify", response_class=HTMLResponse)
def identify_page(request: Request):
    return templates.TemplateResponse("identify.html", {"request": request})


@app.get("/plate", response_class=HTMLResponse)
def plate_page(request: Request):
    return templates.TemplateResponse("plate.html", {"request": request})


@app.get("/pipeline", response_class=HTMLResponse)
def pipeline_page(request: Request):
    return templates.TemplateResponse("pipeline.html", {"request": request})


@app.get("/dream-dashboard", response_class=HTMLResponse)
def dream_dashboard_page(request: Request):
    return templates.TemplateResponse("dream_dashboard.html", {"request": request})


@app.get("/dream-dashboard/student/{student_name}", response_class=HTMLResponse)
def dream_student_page(request: Request, student_name: str):
    return templates.TemplateResponse("dream_student.html", {
        "request": request,
        "student_name": student_name,
    })


_DREAM_PEOPLE = [
    "Aarav", "Isha", "Kabir", "Riya", "Vihaan", "Anaya",
    "Arjun", "Meera", "Saanvi", "Dev", "Nikhil", "Tara",
]
_DREAM_HOSTELS = ["Aster", "Nova", "Orion", "Lotus"]
_DREAM_AVATARS = {
    "Aarav": "https://randomuser.me/api/portraits/men/11.jpg",
    "Isha": "https://randomuser.me/api/portraits/women/22.jpg",
    "Kabir": "https://randomuser.me/api/portraits/men/33.jpg",
    "Riya": "https://randomuser.me/api/portraits/women/44.jpg",
    "Vihaan": "https://randomuser.me/api/portraits/men/55.jpg",
    "Anaya": "https://randomuser.me/api/portraits/women/66.jpg",
    "Arjun": "https://randomuser.me/api/portraits/men/77.jpg",
    "Meera": "https://randomuser.me/api/portraits/women/18.jpg",
    "Saanvi": "https://randomuser.me/api/portraits/women/29.jpg",
    "Dev": "https://randomuser.me/api/portraits/men/41.jpg",
    "Nikhil": "https://randomuser.me/api/portraits/men/53.jpg",
    "Tara": "https://randomuser.me/api/portraits/women/64.jpg",
}


def _parse_iso_day(value: Optional[str], fallback: date) -> date:
    if not value:
        return fallback
    try:
        return date.fromisoformat(value)
    except ValueError:
        return fallback


def _dream_seed_data() -> tuple:
    """Create deterministic mock events and profile metadata for demo analytics."""
    rng = random.Random(20260325)
    today = date.today()
    start_day = today - timedelta(days=364)

    tendency = {
        "Aarav": 0.58, "Isha": 0.34, "Kabir": 0.62, "Riya": 0.39,
        "Vihaan": 0.67, "Anaya": 0.27, "Arjun": 0.48, "Meera": 0.22,
        "Saanvi": 0.44, "Dev": 0.56, "Nikhil": 0.31, "Tara": 0.18,
    }
    hostel_of = {name: _DREAM_HOSTELS[i % len(_DREAM_HOSTELS)] for i, name in enumerate(_DREAM_PEOPLE)}
    person_weights = [1.0 + tendency[p] for p in _DREAM_PEOPLE]
    credit_delta = {"1": -3, "2": -1, "3": 1, "4": 3}

    profiles = {}
    for name in _DREAM_PEOPLE:
        profiles[name] = {
            "name": name,
            "avatar": _DREAM_AVATARS[name],
            "hostel": hostel_of[name],
            "green_credits": 120,
            "events_total": 0,
            "waste_sum": 0.0,
            "cat": {"1": 0, "2": 0, "3": 0, "4": 0},
        }

    events = []
    event_id = 1
    for idx in range(365):
        day = start_day + timedelta(days=idx)
        seasonal = 9.5 * math.sin(idx / 14.0)
        weekday_factor = -5.0 if day.weekday() >= 5 else 4.0
        mean_events = max(20, int(62 + seasonal + weekday_factor + rng.randint(-7, 7)))
        count = max(16, int(rng.gauss(mean_events, 5.5)))

        for j in range(count):
            person = rng.choices(_DREAM_PEOPLE, weights=person_weights, k=1)[0]
            t = tendency[person]
            p1 = min(0.60, 0.14 + 0.58 * t)
            p2 = min(0.45, 0.22 + 0.29 * t)
            p4 = max(0.06, 0.34 - 0.34 * t)
            p3 = max(0.04, 1.0 - (p1 + p2 + p4))
            norm = p1 + p2 + p3 + p4
            category = str(rng.choices([1, 2, 3, 4], weights=[p1 / norm, p2 / norm, p3 / norm, p4 / norm], k=1)[0])
            waste_value = 5 - int(category)

            profile = profiles[person]
            profile["events_total"] += 1
            profile["waste_sum"] += waste_value
            profile["cat"][category] += 1
            profile["green_credits"] += credit_delta[category]

            events.append({
                "id": f"dr-{event_id}",
                "date": day.isoformat(),
                "person": person,
                "hostel": profile["hostel"],
                "category": category,
                "waste_value": waste_value,
                "green_credit_delta": credit_delta[category],
                "plate_photo": f"https://picsum.photos/seed/plate-{day.isoformat()}-{j}/320/220",
            })
            event_id += 1

    for p in profiles.values():
        p["green_credits"] = max(15, min(280, p["green_credits"]))

    return profiles, events


def _dream_aggregate(profiles: dict, events: list, start_day: date, end_day: date) -> dict:
    filtered = [e for e in events if start_day <= date.fromisoformat(e["date"]) <= end_day]
    if not filtered:
        return {
            "kpis": {
                "total_events": 0,
                "active_profiles": len(profiles),
                "avg_daily_events": 0,
                "overall_avg_waste": 0,
                "month_change_pct": 0,
            },
            "daily": [],
            "monthly": [],
            "weekday": [],
            "profiles": [],
            "hostels": [],
            "leaderboards": {"top_wasters": [], "least_wasters": []},
            "current_category_distribution": {"1": 0, "2": 0, "3": 0, "4": 0},
            "insights": ["No events found in selected date range."],
        }

    daily_map = {}
    monthly_map = {}
    weekday_map = {k: {"events": 0, "waste_sum": 0.0} for k in ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]}
    profile_agg = {}
    hostel_agg = {}

    for e in filtered:
        d = e["date"]
        m = d[:7]
        wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"][date.fromisoformat(d).weekday()]
        c = e["category"]
        person = e["person"]
        hostel = e["hostel"]

        day_entry = daily_map.setdefault(d, {"date": d, "events": 0, "waste_sum": 0.0, "cat": {"1": 0, "2": 0, "3": 0, "4": 0}})
        day_entry["events"] += 1
        day_entry["waste_sum"] += e["waste_value"]
        day_entry["cat"][c] += 1

        month_entry = monthly_map.setdefault(m, {"month": m, "label": date.fromisoformat(d).strftime("%b %Y"), "events": 0, "waste_sum": 0.0})
        month_entry["events"] += 1
        month_entry["waste_sum"] += e["waste_value"]

        weekday_map[wd]["events"] += 1
        weekday_map[wd]["waste_sum"] += e["waste_value"]

        pa = profile_agg.setdefault(person, {
            "name": person,
            "avatar": profiles[person]["avatar"],
            "hostel": profiles[person]["hostel"],
            "green_credits": profiles[person]["green_credits"],
            "events": 0,
            "waste_sum": 0.0,
            "cat": {"1": 0, "2": 0, "3": 0, "4": 0},
        })
        pa["events"] += 1
        pa["waste_sum"] += e["waste_value"]
        pa["cat"][c] += 1

        ha = hostel_agg.setdefault(hostel, {
            "hostel": hostel,
            "events": 0,
            "waste_sum": 0.0,
            "green_credits_avg": 0.0,
            "profiles": set(),
        })
        ha["events"] += 1
        ha["waste_sum"] += e["waste_value"]
        ha["profiles"].add(person)

    daily = []
    for d in sorted(daily_map.keys()):
        row = daily_map[d]
        daily.append({
            "date": d,
            "label": date.fromisoformat(d).strftime("%d %b"),
            "events": row["events"],
            "avg_waste": round(row["waste_sum"] / max(1, row["events"]), 3),
            "cat": row["cat"],
        })

    monthly = []
    for m in sorted(monthly_map.keys()):
        row = monthly_map[m]
        monthly.append({
            "month": m,
            "label": row["label"],
            "events": row["events"],
            "avg_waste": round(row["waste_sum"] / max(1, row["events"]), 3),
        })

    profiles_rows = []
    for person, p in profile_agg.items():
        avg = p["waste_sum"] / max(1, p["events"])
        profiles_rows.append({
            "name": person,
            "avatar": p["avatar"],
            "hostel": p["hostel"],
            "green_credits": p["green_credits"],
            "events": p["events"],
            "avg_waste": round(avg, 3),
            "risk_score": round((avg / 4.0) * 100, 1),
            "cat": p["cat"],
            "detail_url": f"/dream-dashboard/student/{quote_plus(person)}",
        })

    hostels_rows = []
    for hostel, h in hostel_agg.items():
        members = sorted(list(h["profiles"]))
        green_avg = sum(profiles[m]["green_credits"] for m in members) / max(1, len(members))
        hostels_rows.append({
            "hostel": hostel,
            "events": h["events"],
            "avg_waste": round(h["waste_sum"] / max(1, h["events"]), 3),
            "green_credits_avg": round(green_avg, 1),
            "profiles": len(members),
        })

    total_events = len(filtered)
    overall_avg_waste = round(sum(e["waste_value"] for e in filtered) / total_events, 3)
    day_count = max(1, (end_day - start_day).days + 1)
    avg_daily_events = round(total_events / day_count, 1)
    month_change = 0.0
    if len(monthly) >= 2 and monthly[-2]["avg_waste"] > 0:
        month_change = round(((monthly[-1]["avg_waste"] - monthly[-2]["avg_waste"]) / monthly[-2]["avg_waste"]) * 100, 1)

    top_wasters = sorted(profiles_rows, key=lambda x: (-x["avg_waste"], -x["events"]))[:5]
    least_wasters = sorted(profiles_rows, key=lambda x: (x["avg_waste"], -x["events"]))[:5]

    weekday = []
    for key in ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]:
        v = weekday_map[key]
        weekday.append({
            "weekday": key,
            "events": v["events"],
            "avg_waste": round(v["waste_sum"] / max(1, v["events"]), 3),
        })

    cat_dist = {"1": 0, "2": 0, "3": 0, "4": 0}
    for e in filtered:
        cat_dist[e["category"]] += 1

    top_hostel = max(hostels_rows, key=lambda h: h["avg_waste"]) if hostels_rows else None
    best_hostel = min(hostels_rows, key=lambda h: h["avg_waste"]) if hostels_rows else None
    insights = [
        f"{top_wasters[0]['name']} currently has the highest waste index in selected range.",
        f"{least_wasters[0]['name']} is the most efficient profile in selected range.",
        f"{top_hostel['hostel']} hostel has highest average waste ({top_hostel['avg_waste']}) in this period." if top_hostel else "No hostel insights for this range.",
        f"{best_hostel['hostel']} hostel has best waste discipline ({best_hostel['avg_waste']})." if best_hostel else "No hostel insights for this range.",
    ]

    return {
        "kpis": {
            "total_events": total_events,
            "active_profiles": len(profiles_rows),
            "avg_daily_events": avg_daily_events,
            "overall_avg_waste": overall_avg_waste,
            "month_change_pct": month_change,
        },
        "daily": daily,
        "daily_last_30": daily[-30:],
        "monthly": monthly,
        "monthly_last_12": monthly[-12:],
        "weekday": weekday,
        "profiles": sorted(profiles_rows, key=lambda x: (-x["risk_score"], -x["events"])),
        "hostels": sorted(hostels_rows, key=lambda x: x["hostel"]),
        "leaderboards": {
            "top_wasters": top_wasters,
            "least_wasters": least_wasters,
        },
        "current_category_distribution": cat_dist,
        "insights": insights,
    }


@app.get("/api/dream/analytics")
def api_dream_analytics(start_date: Optional[str] = None, end_date: Optional[str] = None):
    profiles, events = _dream_seed_data()
    first_day = date.fromisoformat(events[0]["date"])
    last_day = date.fromisoformat(events[-1]["date"])

    default_start = last_day - timedelta(days=89)
    start = _parse_iso_day(start_date, default_start)
    end = _parse_iso_day(end_date, last_day)
    if start > end:
        start, end = end, start

    payload = _dream_aggregate(profiles, events, start, end)
    payload["range"] = {
        "start": start.isoformat(),
        "end": end.isoformat(),
        "min": first_day.isoformat(),
        "max": last_day.isoformat(),
    }
    return payload


@app.get("/api/dream/student/{student_name}")
def api_dream_student(student_name: str, start_date: Optional[str] = None, end_date: Optional[str] = None):
    profiles, events = _dream_seed_data()
    canonical = None
    for name in profiles.keys():
        if name.lower() == student_name.lower():
            canonical = name
            break
    if not canonical:
        raise HTTPException(status_code=404, detail="Student not found")

    person_events = [e for e in events if e["person"] == canonical]
    first_day = date.fromisoformat(events[0]["date"])
    last_day = date.fromisoformat(events[-1]["date"])
    start = _parse_iso_day(start_date, first_day)
    end = _parse_iso_day(end_date, last_day)
    if start > end:
        start, end = end, start

    filtered = [e for e in person_events if start <= date.fromisoformat(e["date"]) <= end]
    cat = {"1": 0, "2": 0, "3": 0, "4": 0}
    daily_map = {}
    for e in filtered:
        cat[e["category"]] += 1
        d = daily_map.setdefault(e["date"], {"date": e["date"], "events": 0, "waste_sum": 0.0})
        d["events"] += 1
        d["waste_sum"] += e["waste_value"]

    daily = []
    for d in sorted(daily_map.keys()):
        v = daily_map[d]
        daily.append({
            "date": d,
            "label": date.fromisoformat(d).strftime("%d %b"),
            "events": v["events"],
            "avg_waste": round(v["waste_sum"] / max(1, v["events"]), 3),
        })

    avg_waste = round(sum(e["waste_value"] for e in filtered) / max(1, len(filtered)), 3)
    profile = profiles[canonical]
    payload = {
        "profile": {
            "name": canonical,
            "avatar": profile["avatar"],
            "hostel": profile["hostel"],
            "green_credits": profile["green_credits"],
            "all_time_events": profile["events_total"],
            "all_time_avg_waste": round(profile["waste_sum"] / max(1, profile["events_total"]), 3),
        },
        "range": {
            "start": start.isoformat(),
            "end": end.isoformat(),
            "min": first_day.isoformat(),
            "max": last_day.isoformat(),
        },
        "summary": {
            "events": len(filtered),
            "avg_waste": avg_waste,
            "risk_score": round((avg_waste / 4.0) * 100, 1),
            "cat": cat,
        },
        "daily": daily[-60:],
        "plate_records": list(reversed(filtered[-120:])),
    }
    return payload


# ---------------------------------------------------------------------------
# API – device config (consumed by frontend JS)
# ---------------------------------------------------------------------------

@app.get("/api/config")
def api_config():
    return {
        "esp32_base": _esp32_base(),
        "plate_base": _plate_base(),
    }


@app.post("/api/flash")
def api_flash():
    """Proxy flash-toggle for face cam."""
    try:
        r = _session.get(f"{_esp32_base()}/flash", timeout=(4, 8))
        r.raise_for_status()
        return r.json()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"ESP32 unreachable: {e}")


@app.post("/api/plate/flash")
def api_plate_flash():
    """Proxy flash-toggle for plate cam."""
    try:
        r = _session.get(f"{_plate_base()}/flash", timeout=(4, 8))
        r.raise_for_status()
        return r.json()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Plate cam unreachable: {e}")


# ---------------------------------------------------------------------------
# API – profiles
# ---------------------------------------------------------------------------

@app.get("/api/profiles")
def api_list_profiles():
    profiles = load_profiles()
    persons = list_persons()
    # merge: show db-registered names and photo counts
    result = []
    for name in persons:
        result.append({
            "name": name,
            "photos": profiles.get(name, {}).get("count", 0),
            "enrolled_at": profiles.get(name, {}).get("enrolled_at", ""),
        })
    return {"profiles": result}


@app.get("/api/profiles/{name}/photos")
def api_list_photos(name: str):
    person_dir = os.path.join(PHOTOS_DIR, name)
    if not os.path.isdir(person_dir):
        return {"photos": []}
    files = sorted(f for f in os.listdir(person_dir) if f.endswith(".jpg"))
    return {"photos": [f"/api/profiles/{name}/photos/{f}" for f in files]}


@app.get("/api/profiles/{name}/photos/{filename}")
def api_get_photo(name: str, filename: str):
    # Prevent path traversal
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    path = os.path.join(PHOTOS_DIR, name, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Photo not found")
    from fastapi.responses import FileResponse
    return FileResponse(path, media_type="image/jpeg")


@app.delete("/api/profiles/{name}")
def api_delete_profile(name: str):
    profiles = load_profiles()
    if name not in profiles:
        raise HTTPException(status_code=404, detail="Profile not found")
    profiles.pop(name, None)
    save_profiles(profiles)
    remove_person(name)
    # Remove stored photos
    person_dir = os.path.join(PHOTOS_DIR, name)
    if os.path.isdir(person_dir):
        shutil.rmtree(person_dir)
    return {"status": "deleted", "name": name}


# ---------------------------------------------------------------------------
# API – enroll
# ---------------------------------------------------------------------------

@app.get("/api/preview")
def api_preview():
    img, raw = _fetch_image(f"{_esp32_base()}/capture")
    encoded = base64.b64encode(raw).decode()
    from recognizer import app as face_app
    faces = face_app.get(img)
    return {"image": f"data:image/jpeg;base64,{encoded}", "faces_detected": len(faces)}


@app.post("/api/enroll")
def api_enroll(name: str = Form(...)):
    """Capture from ESP32 and enroll the face under the given name."""
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")

    img, raw = _fetch_image(f"{_esp32_base()}/capture")
    emb = extract_embedding(img)
    if emb is None:
        return JSONResponse(status_code=422, content={"status": "error", "detail": "No face detected in the captured image"})

    add_embedding(name, emb)

    # Persist the captured JPEG for later viewing
    person_dir = os.path.join(PHOTOS_DIR, name)
    os.makedirs(person_dir, exist_ok=True)
    photo_filename = f"{time.strftime('%Y%m%d_%H%M%S')}_{int(time.time()*1000)%1000:03d}.jpg"
    with open(os.path.join(person_dir, photo_filename), "wb") as f:
        f.write(raw)

    profiles = load_profiles()
    entry = profiles.get(name, {"count": 0, "enrolled_at": ""})
    entry["count"] += 1
    entry["enrolled_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    profiles[name] = entry
    save_profiles(profiles)

    encoded = base64.b64encode(raw).decode()
    return {
        "status": "enrolled",
        "name": name,
        "total_photos": entry["count"],
        "image": f"data:image/jpeg;base64,{encoded}",
    }


@app.delete("/api/clear_db")
def api_clear_db():
    """Wipe all stored embeddings and profiles. Required after normalisation fix."""
    from recognizer import embeddings, labels, index
    import faiss as _faiss
    embeddings.clear()
    labels.clear()
    # rebuild index in-place
    new_index = _faiss.IndexFlatL2(512)
    import recognizer as _rec
    _rec.index = new_index
    if os.path.exists("face_db/embeddings.pkl"):
        os.remove("face_db/embeddings.pkl")
    if os.path.exists(PROFILES_FILE):
        os.remove(PROFILES_FILE)
    if os.path.isdir(PHOTOS_DIR):
        shutil.rmtree(PHOTOS_DIR)
    return {"status": "cleared"}


# ---------------------------------------------------------------------------
# API – debug: show raw match scores without making a recognition decision
# ---------------------------------------------------------------------------

@app.get("/api/debug_scores")
def api_debug_scores():
    img, raw = _fetch_image(f"{_esp32_base()}/capture")
    emb = extract_embedding(img)
    encoded = base64.b64encode(raw).decode()

    if emb is None:
        return {"status": "no_face", "image": f"data:image/jpeg;base64,{encoded}"}

    _name, _score, all_scores = recognize_face(emb)
    return {
        "threshold": THRESHOLD,
        "scores": {k: round(v, 4) for k, v in all_scores.items()},
        "would_match": _name if _name != "unknown" else None,
        "image": f"data:image/jpeg;base64,{encoded}",
    }


# ---------------------------------------------------------------------------
# API – identify
# ---------------------------------------------------------------------------

@app.get("/api/identify")
def api_identify():
    img, raw = _fetch_image(f"{_esp32_base()}/capture")
    emb = extract_embedding(img)
    encoded = base64.b64encode(raw).decode()

    if emb is None:
        return {
            "status": "no_face",
            "person": None,
            "confidence": None,
            "image": f"data:image/jpeg;base64,{encoded}",
        }

    name, score, all_scores = recognize_face(emb)
    # Confidence: 100% at L2=0, 0% at L2=THRESHOLD
    if name == "unknown":
        confidence = None
    else:
        confidence = round(max(0.0, (THRESHOLD - score) / THRESHOLD) * 100, 1)

    return {
        "status": "recognized" if name != "unknown" else "unknown",
        "person": name if name != "unknown" else None,
        "score": round(float(score), 4),
        "confidence": confidence,
        "image": f"data:image/jpeg;base64,{encoded}",
    }


def _send_servo_state(state: str):
    """Send logical servo state to ESP32 endpoint."""
    try:
        r = _session.get(f"{_esp32_base()}/servo", params={"state": state}, timeout=(4, 8))
        r.raise_for_status()
        return True, r.text
    except requests.RequestException as e:
        return False, str(e)


def _run_reversed_servo_cycle(duration_seconds: int = 4) -> dict:
    """
    Hardware logic is reversed:
    - state=off means physical ON
    - state=on means physical OFF
    """
    activate_state = "off"
    deactivate_state = "on"

    ok_on, detail_on = _send_servo_state(activate_state)
    if not ok_on:
        return {
            "status": "error",
            "activate_state": activate_state,
            "deactivate_state": deactivate_state,
            "detail": f"Servo activate failed: {detail_on}",
        }

    time.sleep(duration_seconds)

    ok_off, detail_off = _send_servo_state(deactivate_state)
    if not ok_off:
        return {
            "status": "error",
            "activate_state": activate_state,
            "deactivate_state": deactivate_state,
            "detail": f"Servo deactivate failed: {detail_off}",
        }

    return {
        "status": "cycled",
        "activate_state": activate_state,
        "deactivate_state": deactivate_state,
        "duration_seconds": duration_seconds,
    }


# ---------------------------------------------------------------------------
# Pipeline – API
# ---------------------------------------------------------------------------

@app.post("/api/pipeline/start")
def api_pipeline_start():
    """Capture face and identify person as the first step in the pipeline."""
    img, raw = _fetch_image(f"{_esp32_base()}/capture")
    emb = extract_embedding(img)
    encoded = base64.b64encode(raw).decode()

    if emb is None:
        return {
            "status": "no_face",
            "person": None,
            "score": None,
            "confidence": None,
            "message": "No face detected. Please face the camera and try again.",
            "image": f"data:image/jpeg;base64,{encoded}",
        }

    name, score, _all_scores = recognize_face(emb)
    if name == "unknown":
        return {
            "status": "unknown",
            "person": None,
            "score": round(float(score), 4),
            "confidence": None,
            "message": "Face not recognized. Please enroll first.",
            "image": f"data:image/jpeg;base64,{encoded}",
        }

    confidence = round(max(0.0, (THRESHOLD - score) / THRESHOLD) * 100, 1)
    return {
        "status": "recognized",
        "person": name,
        "score": round(float(score), 4),
        "confidence": confidence,
        "message": f"Face recognized: {name}",
        "image": f"data:image/jpeg;base64,{encoded}",
    }


@app.post("/api/pipeline/upload_plate")
def api_pipeline_upload_plate(
    plate_photo: UploadFile = File(...),
    person: str = Form(...),
    face_score: Optional[float] = Form(default=None),
):
    """
    Upload a plate photo, classify waste (temporary random class 1-4),
    store event for analytics, and run servo for 4 seconds using reversed logic.
    """
    person = person.strip()
    if not person:
        raise HTTPException(status_code=400, detail="Face must be recognized first. Please run start pipeline.")

    raw = plate_photo.file.read()
    if not raw:
        raise HTTPException(status_code=400, detail="Uploaded plate photo is empty.")

    img = np.frombuffer(raw, np.uint8)
    img = cv2.imdecode(img, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=400, detail="Invalid image file uploaded.")

    ts = time.strftime("%Y%m%d_%H%M%S")
    ms = int(time.time() * 1000) % 1000
    filename = f"{ts}_{ms:03d}.jpg"
    os.makedirs(PIPELINE_PLATES_DIR, exist_ok=True)
    filepath = os.path.join(PIPELINE_PLATES_DIR, filename)
    with open(filepath, "wb") as fh:
        fh.write(raw)

    waste_category = random.randint(1, 4)
    servo = _run_reversed_servo_cycle(duration_seconds=4)

    event = record_pipeline_event({
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "person": person,
        "face_score": round(float(face_score), 4) if face_score is not None else None,
        "plate_photo": f"/api/pipeline/plate_photo/{filename}",
        "waste_category": waste_category,
        "servo": servo,
    })

    return {
        "status": "completed",
        "event": event,
        "message": "Pipeline completed and saved for analytics.",
    }


@app.get("/api/pipeline/plate_photo/{filename}")
def api_pipeline_plate_photo(filename: str):
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    from fastapi.responses import FileResponse
    path = os.path.join(PIPELINE_PLATES_DIR, filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Photo not found")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/api/pipeline/events")
def api_pipeline_events(limit: int = 50):
    return {"events": list_pipeline_events(limit=limit)}


@app.get("/api/pipeline/summary")
def api_pipeline_summary():
    return summarize_pipeline_events()


# ---------------------------------------------------------------------------
# Plate cam – events helpers
# ---------------------------------------------------------------------------

def _load_plate_events() -> list:
    if os.path.exists(PLATE_EVENTS_FILE):
        with open(PLATE_EVENTS_FILE) as f:
            return json.load(f)
    return []


def _save_plate_events(events: list):
    os.makedirs(os.path.dirname(PLATE_EVENTS_FILE), exist_ok=True)
    with open(PLATE_EVENTS_FILE, "w") as f:
        json.dump(events, f)


# ---------------------------------------------------------------------------
# Plate cam – API
# ---------------------------------------------------------------------------

@app.get("/api/plate/preview")
def api_plate_preview():
    """Snapshot from plate cam for preview (no event recorded)."""
    _img, raw = _fetch_image(f"{_plate_base()}/capture")
    encoded = base64.b64encode(raw).decode()
    return {"image": f"data:image/jpeg;base64,{encoded}"}


@app.post("/api/plate/capture")
def api_plate_capture(person: str = Form(default="")):
    """
    Capture a plate photo, save it, and record a waste event.
    Optionally link it to an already-identified person name.
    """
    _img, raw = _fetch_image(f"{_plate_base()}/capture")

    ts       = time.strftime("%Y%m%d_%H%M%S")
    ms       = int(time.time() * 1000) % 1000
    filename = f"{ts}_{ms:03d}.jpg"
    plate_dir = os.path.join("face_db", "plate_photos")
    os.makedirs(plate_dir, exist_ok=True)
    filepath = os.path.join(plate_dir, filename)
    with open(filepath, "wb") as fh:
        fh.write(raw)

    event_id = f"{ts}_{ms:03d}"
    event = {
        "id":        event_id,
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "person":    person.strip() or None,
        "photo":     f"/api/plate/photos/{filename}",
        "notes":     "",
    }

    events = _load_plate_events()
    events.insert(0, event)          # newest first
    events = events[:500]            # keep last 500 events
    _save_plate_events(events)

    encoded = base64.b64encode(raw).decode()
    return {
        "status":  "captured",
        "event":   event,
        "image":   f"data:image/jpeg;base64,{encoded}",
    }


@app.get("/api/plate/photos/{filename}")
def api_plate_photo(filename: str):
    if "/" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename")
    from fastapi.responses import FileResponse
    path = os.path.join("face_db", "plate_photos", filename)
    if not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="Photo not found")
    return FileResponse(path, media_type="image/jpeg")


@app.get("/api/plate/events")
def api_plate_events(limit: int = 50):
    events = _load_plate_events()
    return {"events": events[:limit]}


@app.delete("/api/plate/events/{event_id}")
def api_delete_plate_event(event_id: str):
    events = _load_plate_events()
    events = [e for e in events if e["id"] != event_id]
    _save_plate_events(events)
    return {"status": "deleted"}

