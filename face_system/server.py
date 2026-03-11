from fastapi import FastAPI, Form, HTTPException
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
from dotenv import load_dotenv

load_dotenv(override=True)

from recognizer import extract_embedding, add_embedding, recognize_face, remove_person, list_persons, THRESHOLD
import shutil

# Defaults only — actual values always come from .env via os.getenv() at call time
_DEFAULT_ESP32_URL      = "http://11.12.20.131"
_DEFAULT_PLATE_CAM_URL  = "http://11.12.20.132"
PROFILES_FILE  = "face_db/profiles.json"
PHOTOS_DIR     = "face_db/photos"
PLATE_EVENTS_FILE = "face_db/plate_events.json"

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

