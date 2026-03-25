import json
import os
import time
from typing import Any, Dict, List


PIPELINE_EVENTS_FILE = "face_db/pipeline_events.json"
MAX_PIPELINE_EVENTS = 1000


def _load_json(path: str, default: Any):
	if os.path.exists(path):
		with open(path) as f:
			return json.load(f)
	return default


def _save_json(path: str, data: Any):
	os.makedirs(os.path.dirname(path), exist_ok=True)
	with open(path, "w") as f:
		json.dump(data, f)


def list_pipeline_events(limit: int = 50) -> List[Dict[str, Any]]:
	events = _load_json(PIPELINE_EVENTS_FILE, [])
	return events[: max(0, limit)]


def record_pipeline_event(event: Dict[str, Any]) -> Dict[str, Any]:
	events = _load_json(PIPELINE_EVENTS_FILE, [])

	if "id" not in event:
		ts = time.strftime("%Y%m%d_%H%M%S")
		ms = int(time.time() * 1000) % 1000
		event["id"] = f"{ts}_{ms:03d}"

	events.insert(0, event)
	events = events[:MAX_PIPELINE_EVENTS]
	_save_json(PIPELINE_EVENTS_FILE, events)
	return event


def summarize_pipeline_events() -> Dict[str, Any]:
	events = _load_json(PIPELINE_EVENTS_FILE, [])
	category_counts = {"1": 0, "2": 0, "3": 0, "4": 0}
	person_counts: Dict[str, int] = {}

	for event in events:
		category = str(event.get("waste_category", ""))
		if category in category_counts:
			category_counts[category] += 1

		person = event.get("person") or "Unknown"
		person_counts[person] = person_counts.get(person, 0) + 1

	return {
		"total_events": len(events),
		"category_counts": category_counts,
		"person_counts": person_counts,
	}
