import uuid
import os
from datetime import datetime, timezone
import httpx
import json

API_URL = os.getenv("API_URL", "http://localhost:3000/api/events/ingest")

def create_event(
    store_id: str,
    camera_id: str,
    visitor_id: str,
    event_type: str,
    zone_id: str = None,
    dwell_ms: int = 0,
    is_staff: bool = False,
    confidence: float = 1.0,
    metadata: dict = None
):
    return {
        "event_id": str(uuid.uuid4()),
        "store_id": store_id,
        "camera_id": camera_id,
        "visitor_id": visitor_id,
        "event_type": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "zone_id": zone_id,
        "dwell_ms": dwell_ms,
        "is_staff": is_staff,
        "confidence": round(confidence, 3),
        "metadata": metadata or {}
    }

def emit_events(events: list):
    if not events: return
    try:
        response = httpx.post(API_URL, json={"events": events}, timeout=5.0)
        response.raise_for_status()
        print(f"Successfully emitted {len(events)} events.")
    except Exception as e:
        print(f"Failed to emit events: {e}")
        # In production: write to local DLQ (Dead Letter Queue) or Redis stream here.
        with open("failed_events.jsonl", "a") as f:
            for ev in events:
                f.write(json.dumps(ev) + "\n")
