from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session
from sqlalchemy import func
from datetime import datetime
import models
from database import get_db

router = APIRouter()

@router.get("/stores/{store_id}/funnel", response_model=models.FunnelResponse)
async def get_funnel(store_id: str, db: Session = Depends(get_db)):
    today = datetime.utcnow().replace(hour=0, minute=0, second=0, microsecond=0)
    
    # Entry count (unique visitors)
    entry_count = db.query(func.count(func.distinct(models.Event.visitor_id)))\
        .filter(models.Event.store_id == store_id, 
                models.Event.timestamp >= today,
                models.Event.is_staff == False)\
        .scalar() or 0
        
    # Zone visit count (unique visitors to any named zone)
    zone_visit_count = db.query(func.count(func.distinct(models.Event.visitor_id)))\
        .filter(models.Event.store_id == store_id, 
                models.Event.timestamp >= today,
                models.Event.is_staff == False,
                models.Event.zone_id.isnot(None),
                models.Event.zone_id != 'BILLING')\
        .scalar() or 0
        
    # Billing queue count
    billing_queue_count = db.query(func.count(func.distinct(models.Event.visitor_id)))\
        .filter(models.Event.store_id == store_id, 
                models.Event.timestamp >= today,
                models.Event.is_staff == False,
                models.Event.event_type == 'BILLING_QUEUE_JOIN')\
        .scalar() or 0
        
    # Purchase count
    purchase_count = db.query(models.Transaction)\
        .filter(models.Transaction.store_id == store_id,
                models.Transaction.timestamp >= today)\
        .count()
        
    entry_to_zone = round((zone_visit_count / entry_count * 100) if entry_count > 0 else 0, 2)
    zone_to_billing = round((billing_queue_count / zone_visit_count * 100) if zone_visit_count > 0 else 0, 2)
    billing_to_purchase = round((purchase_count / billing_queue_count * 100) if billing_queue_count > 0 else 0, 2)
    
    return {
        "entry_count": entry_count,
        "zone_visit_count": zone_visit_count,
        "billing_queue_count": billing_queue_count,
        "purchase_count": purchase_count,
        "drop_off_percentages": {
            "entry_to_zone": entry_to_zone,
            "zone_to_billing": zone_to_billing,
            "billing_to_purchase": billing_to_purchase
        }
    }
