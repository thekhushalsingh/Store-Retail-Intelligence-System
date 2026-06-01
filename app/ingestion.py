from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
import structlog
import models
from database import get_db

logger = structlog.get_logger()
router = APIRouter()

def ingest_events(db: Session, events):
    processed = 0
    errors = []
    for ev in events:
        try:
            db_event = models.Event(
                event_id=ev.event_id,
                store_id=ev.store_id,
                camera_id=ev.camera_id,
                visitor_id=ev.visitor_id,
                event_type=ev.event_type,
                timestamp=ev.timestamp,
                zone_id=ev.zone_id,
                dwell_ms=ev.dwell_ms,
                is_staff=ev.is_staff,
                confidence=ev.confidence,
                metadata_col=ev.metadata
            )
            db.merge(db_event) # Merge handles idempotency by event_id
            processed += 1
        except Exception as e:
            errors.append({"event_id": str(ev.event_id), "error": str(e)})
    
    db.commit()
    return processed, errors

@router.post("/events/ingest", response_model=models.IngestResponse)
async def ingest_events_endpoint(request: models.BatchIngestRequest, db: Session = Depends(get_db)):
    logger.info("ingest_batch_started", count=len(request.events))
    processed, errors = ingest_events(db, request.events)
    status = "partial" if errors else "success"
    if processed == 0 and errors:
        status = "failed"
    logger.info("ingest_batch_completed", processed=processed, errors=len(errors))
    return {"status": status, "processed": processed, "errors": errors}
