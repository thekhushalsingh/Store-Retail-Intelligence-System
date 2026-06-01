from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session
from sqlalchemy import text, func
import structlog
from database import get_db, redis_client
from datetime import datetime, timedelta
import models

logger = structlog.get_logger()
router = APIRouter()

@router.get("/health")
async def health_check(db: Session = Depends(get_db)):
    try:
        db.execute(text("SELECT 1"))
        redis_client.ping()
        
        now = datetime.utcnow()
        
        # Check last event timestamp per store
        last_events = db.query(
            models.Event.store_id, 
            func.max(models.Event.timestamp).label('last_ts')
        ).group_by(models.Event.store_id).all()
        
        feed_status = {}
        for store_id, last_ts in last_events:
            if not last_ts.tzinfo:
                last_ts = last_ts.replace(tzinfo=None)
                
            lag = (now - last_ts).total_seconds()
            if lag > 600:
                feed_status[store_id] = {"status": "STALE_FEED", "last_event": last_ts.isoformat(), "lag_seconds": lag}
            else:
                feed_status[store_id] = {"status": "OK", "last_event": last_ts.isoformat(), "lag_seconds": lag}

        return {
            "status": "ok", 
            "db": "connected", 
            "redis": "connected",
            "feeds": feed_status
        }
    except Exception as e:
        logger.error("health_check_failed", error=str(e))
        raise HTTPException(status_code=503, detail="Service Unavailable")
