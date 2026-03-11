import numpy as np
import faiss
import os
import pickle

from insightface.app import FaceAnalysis

DB_PATH = "face_db/embeddings.pkl"

# ArcFace squared-L2 threshold on UNIT-NORMALISED embeddings.
# Squared-L2 = 2*(1 - cosine_sim), so range is [0, 4].
# cosine_sim > 0.35 for same person  →  squared-L2 < 1.30
THRESHOLD = 1.30
_TOP_K = 5


def _normalise(vec: np.ndarray) -> np.ndarray:
    """L2-normalise a 1-D vector to the unit sphere."""
    norm = np.linalg.norm(vec)
    if norm < 1e-10:
        return vec
    return (vec / norm).astype(np.float32)

app = FaceAnalysis(name="buffalo_l", providers=["CUDAExecutionProvider", "CPUExecutionProvider"])
app.prepare(ctx_id=0, det_size=(320, 320))

# In-memory store
embeddings: list = []
labels: list = []
index = faiss.IndexFlatL2(512)


def _load():
    global embeddings, labels, index
    if os.path.exists(DB_PATH):
        with open(DB_PATH, "rb") as f:
            data = pickle.load(f)
        embeddings = data.get("embeddings", [])
        labels = data.get("labels", [])
        index = faiss.IndexFlatL2(512)
        if embeddings:
            index.add(np.array(embeddings, dtype=np.float32))


def _save():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    with open(DB_PATH, "wb") as f:
        pickle.dump({"embeddings": embeddings, "labels": labels}, f)


# Load existing DB on module import
_load()


def extract_embedding(img):
    faces = app.get(img)
    if not faces:
        return None
    return _normalise(faces[0].embedding)


def add_embedding(name: str, embedding: np.ndarray):
    emb = _normalise(embedding)
    embeddings.append(emb)
    labels.append(name)
    index.add(np.array([emb], dtype=np.float32))
    _save()


def recognize_face(embedding: np.ndarray):
    if index.ntotal == 0:
        return "unknown", 2.0, {}

    emb = _normalise(embedding)
    k = min(_TOP_K, index.ntotal)
    D, I = index.search(np.array([emb], dtype=np.float32), k)

    # Collect all neighbors within threshold and vote by label
    votes: dict = {}
    best_score_per_label: dict = {}
    for dist, idx in zip(D[0], I[0]):
        if dist < THRESHOLD:
            lbl = labels[idx]
            votes[lbl] = votes.get(lbl, 0) + 1
            if lbl not in best_score_per_label or dist < best_score_per_label[lbl]:
                best_score_per_label[lbl] = float(dist)

    if not votes:
        # Nothing within threshold – return closest distance for diagnostics
        return "unknown", float(D[0][0]), {labels[I[0][0]]: float(D[0][0])}

    # Pick label with most votes; break ties by lowest L2 score
    winner = max(votes, key=lambda l: (votes[l], -best_score_per_label[l]))
    return winner, best_score_per_label[winner], best_score_per_label


def remove_person(name: str):
    global embeddings, labels, index
    paired = [(e, l) for e, l in zip(embeddings, labels) if l != name]
    if paired:
        embeddings, labels = map(list, zip(*paired))
    else:
        embeddings, labels = [], []
    index = faiss.IndexFlatL2(512)
    if embeddings:
        index.add(np.array(embeddings, dtype=np.float32))
    _save()


def list_persons() -> list:
    return sorted(set(labels))
