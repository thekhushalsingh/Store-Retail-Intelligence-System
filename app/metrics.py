from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime
import models
from database import get_db
from pydantic import BaseModel
from typing import List, Dict, Any

router = APIRouter()

def get_today_metrics(db: Session, store_id: str):
    today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    
    # Unique visitors
    unique_visitors = db.query(func.count(func.distinct(models.Event.visitor_id)))\
        .filter(models.Event.store_id == store_id, 
                models.Event.timestamp >= today,
                models.Event.is_staff == False)\
        .scalar() or 0
        
    # Queue depth (from most recent BILLING_QUEUE_JOIN metadata)
    recent_queue_event = db.query(models.Event)\
        .filter(models.Event.store_id == store_id,
                models.Event.event_type == 'BILLING_QUEUE_JOIN',
                models.Event.timestamp >= today)\
        .order_by(models.Event.timestamp.desc())\
        .first()
        
    queue_depth = 0
    if recent_queue_event and recent_queue_event.metadata_col:
        queue_depth = recent_queue_event.metadata_col.get('queue_depth', 0)
        
    # Avg dwell per zone
    dwell_results = db.query(
        models.Event.zone_id,
        func.avg(models.Event.dwell_ms)
    ).filter(
        models.Event.store_id == store_id,
        models.Event.timestamp >= today,
        models.Event.is_staff == False,
        models.Event.zone_id.isnot(None),
        models.Event.dwell_ms > 0
    ).group_by(models.Event.zone_id).all()
    
    avg_dwell_zone = {z: round(float(d) / 60000.0, 2) for z, d in dwell_results if z}

    # Abandonment rate
    billing_joins = db.query(func.count(func.distinct(models.Event.visitor_id)))\
        .filter(models.Event.store_id == store_id,
                models.Event.timestamp >= today,
                models.Event.is_staff == False,
                models.Event.event_type == 'BILLING_QUEUE_JOIN')\
        .scalar() or 0
        
    billing_abandons = db.query(func.count(func.distinct(models.Event.visitor_id)))\
        .filter(models.Event.store_id == store_id,
                models.Event.timestamp >= today,
                models.Event.is_staff == False,
                models.Event.event_type == 'BILLING_QUEUE_ABANDON')\
        .scalar() or 0
        
    abandonment_rate = 0.0
    if billing_joins > 0:
        abandonment_rate = round(float(billing_abandons) / billing_joins * 100, 2)
        
    # Conversion rate logic
    tx_count = db.query(models.Transaction)\
        .filter(models.Transaction.store_id == store_id,
                models.Transaction.timestamp >= today)\
        .count()
        
    conversion_rate = 0.0
    if unique_visitors > 0:
        conversion_rate = min(100.0, round(float(tx_count) / unique_visitors * 100, 2))
        
    return {
        "unique_visitors": unique_visitors,
        "conversion_rate": conversion_rate,
        "avg_dwell_zone": avg_dwell_zone,
        "queue_depth": queue_depth,
        "abandonment_rate": abandonment_rate
    }

@router.get("/stores/{store_id}/metrics", response_model=models.MetricsResponse)
async def get_metrics(store_id: str, db: Session = Depends(get_db)):
    metrics = get_today_metrics(db, store_id)
    return metrics

@router.get("/stores/{store_id}/heatmap")
async def get_heatmap(store_id: str, db: Session = Depends(get_db)):
    today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    
    # Sessions count today
    session_count = db.query(func.count(func.distinct(models.Event.visitor_id)))\
        .filter(models.Event.store_id == store_id, 
                models.Event.timestamp >= today,
                models.Event.is_staff == False)\
        .scalar() or 0
        
    data_confidence = session_count >= 20
    
    # Zone visit frequency + avg dwell
    zone_stats = db.query(
        models.Event.zone_id,
        func.count(func.distinct(models.Event.visitor_id)).label('visits'),
        func.avg(models.Event.dwell_ms).label('avg_dwell')
    ).filter(
        models.Event.store_id == store_id,
        models.Event.timestamp >= today,
        models.Event.is_staff == False,
        models.Event.zone_id.isnot(None),
        models.Event.dwell_ms > 0
    ).group_by(models.Event.zone_id).all()
    
    max_visits = max([s.visits for s in zone_stats]) if zone_stats else 1
    
    results = []
    for z in zone_stats:
        if z.zone_id:
            score = int((z.visits / max_visits) * 100)
            results.append({
                "zone_id": z.zone_id,
                "visit_count": z.visits,
                "avg_dwell": int(z.avg_dwell or 0),
                "heat_score": score
            })
            
    return {
        "data_confidence": data_confidence,
        "zones": results
    }
