import numpy as np
import faiss
import os
import pickle

from insightface.app import FaceAnalysis

DB_PATH = "face_db/embeddings.pkl"

app = FaceAnalysis()
app.prepare(ctx_id=0)

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
    return faces[0].embedding.astype(np.float32)


def add_embedding(name: str, embedding: np.ndarray):
    embeddings.append(embedding.astype(np.float32))
    labels.append(name)
    index.add(np.array([embedding], dtype=np.float32))
    _save()


def recognize_face(embedding: np.ndarray):
    if index.ntotal == 0:
        return "unknown", 1.0
    D, I = index.search(np.array([embedding], dtype=np.float32), 1)
    idx = int(I[0][0])
    score = float(D[0][0])
    label = labels[idx]
    threshold = 1.0
    if score < threshold:
        return label, score
    return "unknown", score


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
