from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime, timedelta
from database import get_db
import models

router = APIRouter()

@router.get("/stores/{store_id}/anomalies", response_model=list[models.AnomalyResponse])
async def get_anomalies(store_id: str, db: Session = Depends(get_db)):
    now = datetime.utcnow()
    thirty_mins_ago = now - timedelta(minutes=30)
    
    anomalies = []
    
    # 1. Dead zone
    today_zones = db.query(func.distinct(models.Event.zone_id))\
        .filter(models.Event.store_id == store_id,
                models.Event.timestamp >= now.replace(hour=0, minute=0, second=0, microsecond=0))\
        .all()
        
    for (z,) in today_zones:
        if not z: continue
        recent_visits = db.query(models.Event)\
            .filter(models.Event.store_id == store_id,
                    models.Event.zone_id == z,
                    models.Event.timestamp >= thirty_mins_ago)\
            .count()
            
        if recent_visits == 0:
            anomalies.append({
                "type": "DEAD_ZONE", 
                "severity": "WARN", 
                "timestamp": now, 
                "suggested_action": f"Check camera feed or display at {z}"
            })
            
    # 2. Queue spike
    recent_queue_events = db.query(models.Event)\
        .filter(models.Event.store_id == store_id,
                models.Event.event_type == 'BILLING_QUEUE_JOIN',
                models.Event.timestamp >= thirty_mins_ago)\
        .all()
        
    if recent_queue_events:
        recent_depths = [e.metadata_col.get('queue_depth', 0) for e in recent_queue_events if e.metadata_col]
        if recent_depths:
            avg_depth = sum(recent_depths) / len(recent_depths)
            current_depth = recent_depths[-1]
            if current_depth > max(2, avg_depth * 2):
                anomalies.append({
                    "type": "QUEUE_SPIKE", 
                    "severity": "CRITICAL", 
                    "timestamp": now, 
                    "suggested_action": "Open Register"
                })
                
    return anomalies
