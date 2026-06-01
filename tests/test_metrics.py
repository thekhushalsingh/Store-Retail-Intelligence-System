# PROMPT: Test metrics and funnel calculation correctness
# CHANGES MADE: Refactored to test against API endpoints
import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../app')))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_get_metrics():
    response = client.get("/stores/STORE_001/metrics")
    assert response.status_code == 200
    data = response.json()
    assert "unique_visitors" in data
    assert "conversion_rate" in data

def test_get_funnel():
    response = client.get("/stores/STORE_001/funnel")
    assert response.status_code == 200
    data = response.json()
    assert data["entry_count"] >= data["zone_visit_count"]
