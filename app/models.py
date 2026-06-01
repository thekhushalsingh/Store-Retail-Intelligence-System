import uuid
from sqlalchemy import Column, String, Integer, Float, Boolean, DateTime
from sqlalchemy.dialects.postgresql import UUID, JSONB
from database import Base
from datetime import datetime
from typing import Optional, Dict, Any, List
from pydantic import BaseModel, ConfigDict, Field

# ---------------------------------------------------------
# SQLAlchemy Models
# ---------------------------------------------------------

class Store(Base):
    __tablename__ = "stores"
    id = Column(String, primary_key=True, index=True)
    name = Column(String)

class Event(Base):
    __tablename__ = "events"
    event_id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    store_id = Column(String, index=True)
    camera_id = Column(String)
    visitor_id = Column(String, index=True)
    event_type = Column(String, index=True)
    timestamp = Column(DateTime(timezone=True), index=True)
    zone_id = Column(String, nullable=True)
    dwell_ms = Column(Integer, default=0)
    is_staff = Column(Boolean, default=False)
    confidence = Column(Float)
    metadata_col = Column("metadata", JSONB, default=dict)

class Transaction(Base):
    __tablename__ = "transactions"
    transaction_id = Column(String, primary_key=True)
    store_id = Column(String, index=True)
    timestamp = Column(DateTime(timezone=True), index=True)
    basket_value = Column(Float)

class Anomaly(Base):
    __tablename__ = "anomalies"
    id = Column(Integer, primary_key=True, autoincrement=True)
    store_id = Column(String, index=True)
    type = Column(String)
    severity = Column(String)
    timestamp = Column(DateTime(timezone=True))
    suggested_action = Column(String)

# ---------------------------------------------------------
# Pydantic Schemas
# ---------------------------------------------------------

class EventMetadata(BaseModel):
    queue_depth: Optional[int] = None
    sku_zone: Optional[str] = None
    session_seq: Optional[int] = None

class EventSchema(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    event_id: uuid.UUID
    store_id: str
    camera_id: str
    visitor_id: str
    event_type: str
    timestamp: datetime
    zone_id: Optional[str] = None
    dwell_ms: int = 0
    is_staff: bool = False
    confidence: float
    metadata: Optional[Dict[str, Any]] = Field(default_factory=dict)

class BatchIngestRequest(BaseModel):
    events: List[EventSchema] = Field(..., max_length=500)

class IngestResponse(BaseModel):
    status: str
    processed: int
    errors: List[dict] = []

class AnomalyResponse(BaseModel):
    type: str
    severity: str
    timestamp: datetime
    suggested_action: str

class MetricsResponse(BaseModel):
    unique_visitors: int
    conversion_rate: float
    avg_dwell_zone: Dict[str, float]
    queue_depth: int
    abandonment_rate: float

class FunnelResponse(BaseModel):
    entry_count: int
    zone_visit_count: int
    billing_queue_count: int
    purchase_count: int
    drop_off_percentages: Dict[str, float]

