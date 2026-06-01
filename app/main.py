from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from database import engine
import models

# Import routers
from ingestion import router as ingestion_router
from metrics import router as metrics_router
from funnel import router as funnel_router
from anomalies import router as anomalies_router
from health import router as health_router

models.Base.metadata.create_all(bind=engine)

app = FastAPI(title="Store Intelligence API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(ingestion_router)
app.include_router(metrics_router)
app.include_router(funnel_router)
app.include_router(anomalies_router)
app.include_router(health_router)

