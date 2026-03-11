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

load_dotenv()

from recognizer import extract_embedding, add_embedding, recognize_face, remove_person, list_persons, THRESHOLD
import shutil

ESP32_URL = os.getenv("ESP32_URL", "http://11.12.20.131")
PROFILES_FILE = "face_db/profiles.json"

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
    return ESP32_URL.rstrip("/")


def fetch_esp32_image():
    """Fetch image from ESP32 and return decoded BGR numpy array."""
    try:
        r = _session.get(f"{_esp32_base()}/capture", timeout=_ESP32_TIMEOUT)
        r.raise_for_status()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"ESP32 unreachable: {e}")
    img = np.frombuffer(r.content, np.uint8)
    img = cv2.imdecode(img, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(status_code=502, detail="ESP32 returned invalid image data")
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


# ---------------------------------------------------------------------------
# API – device config (consumed by frontend JS)
# ---------------------------------------------------------------------------

@app.get("/api/config")
def api_config():
    return {"esp32_base": _esp32_base()}


@app.post("/api/flash")
def api_flash():
    """Proxy flash-toggle request to ESP32 so the browser stays same-origin."""
    try:
        r = _session.get(f"{_esp32_base()}/flash", timeout=(4, 8))
        r.raise_for_status()
        return r.json()
    except requests.RequestException as e:
        raise HTTPException(status_code=502, detail=f"ESP32 unreachable: {e}")


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


@app.delete("/api/profiles/{name}")
def api_delete_profile(name: str):
    profiles = load_profiles()
    if name not in profiles:
        raise HTTPException(status_code=404, detail="Profile not found")
    profiles.pop(name, None)
    save_profiles(profiles)
    remove_person(name)
    return {"status": "deleted", "name": name}


# ---------------------------------------------------------------------------
# API – enroll
# ---------------------------------------------------------------------------

@app.get("/api/preview")
def api_preview():
    """Capture from ESP32 and return a base64-encoded JPEG preview."""
    img, raw = fetch_esp32_image()
    encoded = base64.b64encode(raw).decode()
    # detect faces for feedback
    from recognizer import app as face_app
    faces = face_app.get(img)
    return {
        "image": f"data:image/jpeg;base64,{encoded}",
        "faces_detected": len(faces),
    }


@app.post("/api/enroll")
def api_enroll(name: str = Form(...)):
    """Capture from ESP32 and enroll the face under the given name."""
    name = name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="Name cannot be empty")

    img, raw = fetch_esp32_image()
    emb = extract_embedding(img)
    if emb is None:
        return JSONResponse(status_code=422, content={"status": "error", "detail": "No face detected in the captured image"})

    add_embedding(name, emb)

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
    return {"status": "cleared"}


# ---------------------------------------------------------------------------
# API – debug: show raw match scores without making a recognition decision
# ---------------------------------------------------------------------------

@app.get("/api/debug_scores")
def api_debug_scores():
    """Capture, extract embedding, and return raw L2 scores for all enrolled people.
    Useful for tuning the threshold and diagnosing recognition failures."""
    img, raw = fetch_esp32_image()
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
    """Capture from ESP32 and return the recognised person."""
    img, raw = fetch_esp32_image()
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
