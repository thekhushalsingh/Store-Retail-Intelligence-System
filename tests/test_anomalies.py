# PROMPT: Test anomalies endpoint logic
# CHANGES MADE: Added TestClient tests
import sys
import os
sys.path.append(os.path.abspath(os.path.join(os.path.dirname(__file__), '../app')))

from fastapi.testclient import TestClient
from main import app

client = TestClient(app)

def test_get_anomalies():
    response = client.get("/stores/STORE_001/anomalies")
    assert response.status_code == 200
    data = response.json()
    assert isinstance(data, list)
    if len(data) > 0:
        assert "type" in data[0]
