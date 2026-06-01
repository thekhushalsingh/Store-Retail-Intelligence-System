# System Design Document

**Project:** Retail Store Intelligence System  
**Version:** 1.0  
**Store:** Brigade Road, Bangalore

---

## Table of Contents

1. [Problem Statement](#1-problem-statement)
2. [Goals and Non-Goals](#2-goals-and-non-goals)
3. [System Architecture](#3-system-architecture)
4. [Component Design](#4-component-design)
5. [Database Design](#5-database-design)
6. [Event Model](#6-event-model)
7. [Analytics Engine Design](#7-analytics-engine-design)
8. [Real-Time Streaming Design](#8-real-time-streaming-design)
9. [Anomaly Detection Design](#9-anomaly-detection-design)
10. [Scalability Considerations](#10-scalability-considerations)
11. [Data Flow Diagrams](#11-data-flow-diagrams)
12. [Security Considerations](#12-security-considerations)
13. [Failure Modes and Mitigations](#13-failure-modes-and-mitigations)

---

## 1. Problem Statement

Brick-and-mortar retail stores operate largely blind — they have no equivalent of web analytics. A website operator knows exactly which pages users visit, how long they stay, where they drop off, and what drives conversions. A physical store manager has only point-of-sale transaction data and gut instinct.

This system bridges that gap by treating the store like a web application: every visitor becomes a session, every zone is a page, and every checkout is a conversion event. Raw CCTV footage is the data source; structured analytics events are the output.

**Core question the system answers:** *What is happening inside this store right now, and what should the manager do about it?*

---

## 2. Goals and Non-Goals

### Goals
- Process CCTV footage in real-time (or from recorded MP4) using computer vision.
- Track individual visitors across store zones with stable, persistent IDs.
- Detect and quantify: entry, zone dwell time, billing queue depth, purchase conversions, and exits.
- Surface operational anomalies (queue spikes, high abandonment) with actionable recommendations.
- Provide a live web dashboard with zero-latency event streaming.
- Operate fully in-memory for development with no external database dependency.
- Scale to production with PostgreSQL + Redis via the FastAPI backend.

### Non-Goals
- Facial recognition or biometric identification of any kind.
- Cross-store visitor tracking.
- Inventory management or product-level analytics (beyond POS data).
- Mobile app (web dashboard only).
- RTSP/live camera streaming (MP4 files are the input source).

---

## 3. System Architecture

The system is composed of four independently deployable layers:

```
┌───────────────────────────────────────────────────────────────────────────────┐
│  Layer 1: Capture                                                             │
│  MP4 video files from 5 CCTV cameras (Brigade Road, Bangalore)               │
│  CAM 1 (~172 MB) · CAM 2 (~155 MB) · CAM 3 (~182 MB) · CAM 4–5 (~70 MB ea) │
└──────────────────────────────────┬────────────────────────────────────────────┘
                                   │ frame by frame (OpenCV)
                                   ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  Layer 2: Computer Vision Pipeline  (pipeline/process_footage.py)            │
│                                                                               │
│  ┌───────────┐     ┌─────────────┐     ┌──────────────────────────────────┐  │
│  │ YOLOv8n   │────▶│  ByteTrack  │────▶│        SessionManager            │  │
│  │ (detect   │     │  (track_ids │     │  • visitor_id assignment         │  │
│  │  persons) │     │  per frame) │     │  • HSV histogram re-identification│  │
│  └───────────┘     └─────────────┘     │  • staff detection heuristic     │  │
│                                        │  • dwell time accumulation       │  │
│  ┌─────────────────────────┐           └──────────────────────────────────┘  │
│  │  Supervision Zones      │                          │                       │
│  │  PolygonZone (×4)       │◀─────────────────────────┘                       │
│  │  LineZone  (entry line) │                                                  │
│  └────────────┬────────────┘                                                  │
│               │  batch of structured events (httpx POST)                      │
│               │  annotated JPEG frames (base64 POST)                          │
└───────────────┼───────────────────────────────────────────────────────────────┘
                │
                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  Layer 3: API + Event Store  (server.ts — Express.js)                         │
│                                                                               │
│  POST /api/events/ingest  ──▶  In-Memory EventRow[]  (cap: 50,000)           │
│  POST /api/video/frame    ──▶  WebSocket broadcast                            │
│  GET  /api/stores/:id/*   ──▶  Computed from memory (metrics/funnel/heatmap) │
│                                                                               │
│  WebSocketServer @ /ws                                                        │
│  └─ broadcast({ type: "events" | "metrics" | "anomalies" | "video_frame" })  │
│                                                                               │
│  [Production alt: FastAPI /app + PostgreSQL + Redis Streams]                  │
└───────────────────────────────────────────────────────────────────────────────┘
                │
                │ WebSocket (primary) + HTTP poll every 5s (fallback)
                ▼
┌───────────────────────────────────────────────────────────────────────────────┐
│  Layer 4: Dashboard  (src/App.tsx — React 19 + Vite)                         │
│                                                                               │
│  KPI Cards · Zone Heatmap · Purchase Funnel · Live Camera Feed               │
│  Live Event Feed · Anomaly Alerts · Dwell Breakdown · Sales Analytics        │
└───────────────────────────────────────────────────────────────────────────────┘
```

### Deployment Modes

| Mode | Command | Database | Use Case |
|---|---|---|---|
| **Development** | `npm run dev` | In-memory | Local testing, demo |
| **Simulation** | `npm run simulate` | In-memory | Testing without CCTV footage |
| **CCTV Processing** | `python pipeline/process_footage.py` | In-memory | Full pipeline run |
| **Production** | `docker compose up -d` | PostgreSQL + Redis | Live store deployment |

---

## 4. Component Design

### 4.1 Computer Vision Pipeline (`process_footage.py`)

The pipeline processes video files sequentially (or in parallel if called with multiple processes). For each video:

**Frame Sampling:** Processes `fps / 10` frames per second regardless of source FPS (e.g., a 30 FPS video processes every 3rd frame). This keeps CPU load constant across different camera configurations.

**Detection:** `model(frame, classes=[0], conf=0.35, verbose=False)` — YOLO inference returns bounding boxes, confidence scores, and class IDs. Only class 0 (person) is retained.

**Tracking:** `tracker.update_with_detections(detections)` — ByteTrack assigns persistent `tracker_id` integers across frames. IDs are stable as long as the person remains visible (with up to `lost_track_buffer=30` frame gaps).

**Session Management:**
```
new track_id seen
    → compute HSV histogram of person crop
    → compare against visitor_registry (Bhattacharyya distance)
    → if distance < 0.55: REENTRY (same visitor_id)
    → else: NEW visitor (assign VIS_<8hex>)
    → store in active_tracks[track_id]
```

**Zone Processing:** Per frame, each detected person's bounding box is tested against all 4 polygon zones using `PolygonZone.trigger()`. The entry line is tested with `LineZone.trigger()` returning (crossed_in, crossed_out) boolean arrays.

**Event Generation Logic:**
```
for each tracked person:
    if crossed_in and not state.entered:
        emit ENTRY or REENTRY

    for each zone:
        if in_zone and zone not in state.zones:
            emit ZONE_ENTER
            if zone == BILLING: emit BILLING_QUEUE_JOIN
        elif in_zone and elapsed > 15s since last dwell:
            emit ZONE_DWELL
        elif not in_zone and zone in state.zones:
            emit ZONE_EXIT

    if crossed_out and not state.exited:
        emit EXIT
```

**Frame Annotation and Streaming:** Every 2 processed frames, the annotated frame (bounding boxes + labels + entry line drawn with `cv2.rectangle`, `cv2.line`, `sv.BoxAnnotator`) is JPEG-encoded at 70% quality, resized to max 640px width, and POSTed to `/api/video/frame`.

### 4.2 SessionManager (`process_footage.py`)

Maintains two data structures:

```python
active_tracks: dict[track_id, {
    "visitor_id": str,        # VIS_<8hex>
    "first_seen": float,      # time.time()
    "last_seen": float,
    "is_staff": bool,
    "is_reentry": bool,
    "zones": dict[zone_id, {  # zones currently occupied
        "enter_time": float,
        "last_dwell_emit": float
    }],
    "entered": bool,
    "exited": bool,
}]

visitor_registry: list[{
    "visitor_id": str,
    "hist": ndarray,          # flattened 8×8 HSV histogram
    "last_seen": float,
}]
```

Stale tracks (not seen for > 5 seconds) are cleaned up on every frame tick, emitting `ZONE_EXIT` events for any open zones.

### 4.3 Express Server (`server.ts`)

Single-file server implementing:

- **In-memory store:** `memStore.events: EventRow[]` (capped at 50k), `memStore.anomalies`, `memStore.transactions`.
- **Computed analytics:** `memMetrics()`, `memFunnel()`, `memHeatmap()`, `detectAnomaliesFromMem()` — pure in-memory aggregations using `Array.filter/reduce/Set`.
- **CSV loader:** `loadCsvData()` parses `Brigade_Bangalore_10_April_26.csv` at startup using `csv-parse/sync`, aggregating by brand, department, and salesperson.
- **WebSocket server:** `ws.WebSocketServer` on the same HTTP server as Express, path `/ws`. Maintains a `Set<WebSocket>` of connected clients. `broadcast(data)` iterates the set, skipping non-OPEN connections.
- **Vite middleware:** In dev mode, `createViteServer({ middlewareMode: true })` is mounted after all API routes. This means `localhost:3000` serves both the REST API and the React SPA from one port.

### 4.4 FastAPI Backend (`/app`)

Production-grade Python backend with five routers:

| Router | File | Key Endpoints |
|---|---|---|
| Ingestion | `ingestion.py` | `POST /events/ingest` — `db.merge()` for idempotency |
| Metrics | `metrics.py` | `GET /stores/{id}/metrics` — SQL aggregations |
| Funnel | `funnel.py` | `GET /stores/{id}/funnel` — 4-stage conversion query |
| Anomalies | `anomalies.py` | `GET /stores/{id}/anomalies` — rolling 30-min window |
| Health | `health.py` | `GET /health` — DB ping + uptime |

The ingestion router uses `db.merge(db_event)` (SQLAlchemy upsert) keyed on `event_id` (UUID), making all ingest operations **idempotent** — safe for at-least-once delivery from the pipeline.

### 4.5 Event Simulator (`pipeline/simulator.ts`)

Generates statistically realistic visitor journeys without requiring CCTV footage. Uses:
- **Poisson arrivals:** `poissonDelay(rate)` using exponential inter-arrival times (`-ln(1-U) / λ`).
- **Exponential dwell:** `expRandom(mean)` for zone dwell times.
- **State machine per visitor:** `entered → browsing → billing → exiting`.
- **Real transaction data:** Cycles through parsed invoice records from the POS CSV, attaching them to purchase events.

---

## 5. Database Design

### Production Schema (PostgreSQL)

#### `stores`
| Column | Type | Description |
|---|---|---|
| `id` | TEXT PK | Store identifier (e.g., `STORE_001`) |
| `name` | TEXT | Human-readable store name |

#### `events`
The central table. Designed for append-only time-series writes.

| Column | Type | Index | Description |
|---|---|---|---|
| `event_id` | UUID PK | Primary | UUID v4, ensures idempotency |
| `store_id` | TEXT | B-Tree | Links to `stores.id` |
| `camera_id` | TEXT | — | Source camera identifier |
| `visitor_id` | TEXT | B-Tree | Assigned by SessionManager |
| `event_type` | TEXT | B-Tree | ENTRY, EXIT, ZONE_ENTER, etc. |
| `timestamp` | TIMESTAMPTZ | B-Tree | Event UTC timestamp |
| `zone_id` | TEXT | — | Store zone name (nullable) |
| `dwell_ms` | INTEGER | — | Milliseconds spent in zone |
| `is_staff` | BOOLEAN | — | Staff detection flag |
| `confidence` | FLOAT | — | YOLOv8 detection confidence |
| `metadata` | JSONB | GIN (recommended) | Arbitrary event-specific fields |

#### `transactions`
| Column | Type | Description |
|---|---|---|
| `transaction_id` | TEXT PK | Invoice number or synthetic ID |
| `store_id` | TEXT | Store reference |
| `timestamp` | TIMESTAMPTZ | Transaction time |
| `basket_value` | FLOAT | Total amount in ₹ |

#### `anomalies`
| Column | Type | Description |
|---|---|---|
| `id` | SERIAL PK | Auto-increment |
| `store_id` | TEXT | Store reference |
| `type` | TEXT | QUEUE_SPIKE, HIGH_ABANDONMENT, DEAD_ZONE |
| `severity` | TEXT | CRITICAL or WARN |
| `timestamp` | TIMESTAMPTZ | When anomaly was detected |
| `suggested_action` | TEXT | Human-readable recommendation |

### Key Query Patterns

**Today's unique visitors (excludes staff):**
```sql
SELECT COUNT(DISTINCT visitor_id)
FROM events
WHERE store_id = $1
  AND timestamp >= CURRENT_DATE
  AND is_staff = FALSE;
```

**Average dwell per zone:**
```sql
SELECT zone_id, AVG(dwell_ms) / 60000.0 AS avg_minutes
FROM events
WHERE store_id = $1
  AND timestamp >= CURRENT_DATE
  AND dwell_ms > 0
  AND zone_id IS NOT NULL
GROUP BY zone_id;
```

**Purchase funnel:**
```sql
-- Entry count
SELECT COUNT(DISTINCT visitor_id) FROM events WHERE store_id=$1 AND ...

-- Zone visits
SELECT COUNT(DISTINCT visitor_id) FROM events WHERE store_id=$1 AND zone_id != 'BILLING' AND ...

-- Billing joins
SELECT COUNT(DISTINCT visitor_id) FROM events WHERE store_id=$1 AND event_type='BILLING_QUEUE_JOIN' AND ...

-- Purchases
SELECT COUNT(*) FROM transactions WHERE store_id=$1 AND timestamp >= CURRENT_DATE;
```

---

## 6. Event Model

### Event Lifecycle for a Single Visitor

```
ENTRY ──▶ ZONE_ENTER (SKINCARE) ──▶ ZONE_DWELL ──▶ ZONE_EXIT (SKINCARE)
       ──▶ ZONE_ENTER (FRAGRANCE) ──▶ ZONE_EXIT (FRAGRANCE)
       ──▶ BILLING_QUEUE_JOIN
       ──▶ ZONE_EXIT (BILLING, purchased=true)
       ──▶ EXIT
```

### Event Type Reference

| Event | Trigger Condition | zone_id | dwell_ms |
|---|---|---|---|
| `ENTRY` | Crossed entry LineZone inward (first time) | null | 0 |
| `REENTRY` | Re-identified visitor crossed entry inward | null | 0 |
| `EXIT` | Crossed entry LineZone outward | null | 0 |
| `ZONE_ENTER` | Entered a PolygonZone | zone name | 0 |
| `ZONE_DWELL` | Still in zone after 15s since last dwell emit | zone name | ms so far |
| `ZONE_EXIT` | Left a PolygonZone | zone name | total ms |
| `BILLING_QUEUE_JOIN` | Entered BILLING zone (emitted alongside ZONE_ENTER) | BILLING | 0 |
| `BILLING_QUEUE_ABANDON` | Left BILLING without `purchased=true` flag | BILLING | ms waited |

### Metadata Field Reference

| Field | Event Type | Type | Description |
|---|---|---|---|
| `session_seq` | All | int | Monotonically increasing counter per visitor per session |
| `queue_depth` | BILLING_QUEUE_JOIN | int | Number of people in billing zone at that moment |
| `purchased` | ZONE_EXIT (BILLING) | bool | True if visitor completed a transaction |
| `transaction` | ZONE_EXIT (BILLING, purchased=true) | object | Full invoice data from POS CSV |
| `transaction.invoice_number` | — | string | Invoice ID |
| `transaction.total_amount` | — | float | Basket value in ₹ |

---

## 7. Analytics Engine Design

### Metrics Computation

All analytics are computed on-the-fly from raw events — there are no pre-aggregated summary tables in the current implementation. This is intentional: the event store is the source of truth and aggregations are fast on the working set size.

**Unique Visitors:** `Set(events.map(e => e.visitor_id)).size` for non-staff events today.

**Conversion Rate:** `transactions_today / unique_visitors_today × 100`. Capped at 100%.

**Queue Depth:** The `queue_depth` value from the metadata of the most recent `BILLING_QUEUE_JOIN` event.

**Abandonment Rate:** `BILLING_QUEUE_ABANDON count / BILLING_QUEUE_JOIN count × 100` for today.

**Avg Dwell per Zone:** For each `zone_id`, average of all non-zero `dwell_ms` values, converted to minutes (`/ 60000`).

**Heatmap Heat Score:** `(zone_visit_count / max_zone_visit_count) × 100` — a 0–100 relative score normalized against the busiest zone.

**Funnel Drop-off:**
- Entry → Zone: `zone_visit_count / entry_count`
- Zone → Billing: `billing_queue_count / zone_visit_count`
- Billing → Purchase: `purchase_count / billing_queue_count`

### CSV Sales Analytics

At server startup, the POS CSV (`Brigade_Bangalore_10_April_26.csv`) is parsed and grouped by:
- `brand_name` → summed `total_amount` → sorted descending (top 10 brands by GMV)
- `dep_name` → summed `total_amount` → department breakdown
- `salesperson_name` → summed `total_amount` → top 10 performers

These are static (loaded once) and served from `/api/stores/:id/analytics`.

---

## 8. Real-Time Streaming Design

### WebSocket Protocol

The server broadcasts JSON messages on all events via `broadcast(data)`:

```typescript
// New events ingested
{ type: "events", data: EventSummary[] }

// Metrics update (triggered by GET /metrics call)
{ type: "metrics", data: MetricsResponse }

// Anomaly detected
{ type: "anomalies", data: AnomalyResponse[] }

// Video frame from CCTV pipeline
{ type: "video_frame", camera_id: string, data: string }  // base64 JPEG
```

### Client Connection Lifecycle
```
Browser opens
  → new WebSocket("ws://localhost:3000/ws")
  → server adds to wsClients Set
  → server sends { type: "connected" }
  → client receives events/frames in real-time

Browser closes / network drop
  → ws.onclose fires
  → client schedules reconnect after 3000ms
  → server removes from wsClients Set

Reconnect
  → new WebSocket(...)
  → same flow as above
```

### Video Frame Pipeline
```
Python (pipeline/process_footage.py)
  → cv2.imencode('.jpg', frame, [JPEG_QUALITY=70])
  → base64.b64encode(buffer)
  → httpx.post("/api/video/frame", {"camera_id": ..., "frame": b64_string})

Express server
  → receives POST /api/video/frame
  → broadcast({ type: "video_frame", camera_id, data: frame })

React dashboard
  → ws.onmessage (type=video_frame)
  → offscreenImg.src = "data:image/jpeg;base64," + msg.data
  → offscreenImg.onload → ctx.drawImage(offscreenImg, 0, 0, ...)
  → canvas renders at native resolution
```

Frame rate is intentionally throttled: only every 2nd processed frame is sent (`frame_count % (frame_skip * 2) == 0`), yielding ~5 frames/second to the dashboard.

---

## 9. Anomaly Detection Design

### Detection Window
All anomaly rules operate on events from the **last 30 minutes** (`Date.now() - 30 * 60 * 1000`).

### Sampling Strategy
In the in-memory server, anomaly detection runs on ~20% of ingest calls (`Math.random() < 0.2`). This prevents the detection logic from adding latency to the ingest hot path while still detecting anomalies within seconds of their onset.

### Rule: QUEUE_SPIKE
```
Input: recent BILLING_QUEUE_JOIN events (last 30 min)
Trigger: latest queue_depth > max(3, avg_queue_depth × 2)
Severity: CRITICAL
Action: "Queue depth {N} exceeds 2x average ({avg}). Open additional registers."
```

The `max(3, ...)` guard prevents false positives when the baseline is very low (e.g., average queue of 1 should not trigger at depth 3).

### Rule: HIGH_ABANDONMENT
```
Input: recent BILLING_QUEUE_JOIN and BILLING_QUEUE_ABANDON events
Trigger: joins > 3 AND (abandons / joins) > 0.40
Severity: WARN
Action: "{N}% abandonment rate. Investigate wait times."
```

### Rule: DEAD_ZONE (FastAPI backend)
```
Input: zones with events today, checked for recent activity
Trigger: zone had visits today BUT zero events in last 30 minutes
Severity: WARN
Action: "Check camera feed or display at {zone_name}"
```

### Future Anomaly Rules (Roadmap)
- **LOW_CONVERSION:** Conversion rate drops below store's 30-day baseline.
- **STAFF_OVERRUN:** Staff-to-visitor ratio exceeds threshold (too many staff relative to visitors).
- **ZONE_SATURATION:** Zone occupancy exceeds capacity estimate (too crowded).
- **OFF_HOURS_MOTION:** Motion detected outside operating hours.

---

## 10. Scalability Considerations

### In-Memory Server Limits

| Metric | Limit | Notes |
|---|---|---|
| Events in memory | 50,000 | ~8 hours for a busy store at ~2 events/visitor/zone |
| WebSocket clients | Unbounded (practical: ~50) | Fan-out is O(n_clients) per ingest |
| Event ingest rate | ~1,000 events/sec | Limited by JavaScript single-thread |
| Video frames | ~5 fps | Base64 encoding is the bottleneck |

### Production Scaling Path

**Ingest scaling:** FastAPI endpoint ACKs immediately, writes to **Redis Stream** (`XADD`). A background consumer (`XREAD`) commits to PostgreSQL in batches. Decouples write latency from DB latency.

**Query scaling:** PostgreSQL with appropriate indexes:
- `(store_id, timestamp)` — covers all today-filtered queries
- `(store_id, event_type, timestamp)` — covers funnel queries
- `GIN(metadata)` — covers `metadata->>'queue_depth'` queries

**Dashboard scaling:** WebSocket broadcasts can be moved to a **Redis Pub/Sub** channel, allowing multiple server instances to fan-out to their own connected clients.

**Pipeline scaling:** Each camera can run `process_footage.py` in a separate process. The HTTP ingest endpoint is stateless and safe for concurrent writes.

---

## 11. Data Flow Diagrams

### Happy Path: Visitor Makes a Purchase

```
Camera frame (at T+0s)
  ↓ OpenCV decode
  ↓ YOLOv8 detect (person bbox, conf=0.87)
  ↓ ByteTrack assign track_id=42
  ↓ SessionManager.get_or_create(42) → VIS_a1b2c3d4
  ↓ LineZone.trigger → crossed_in=True
  ↓ create_event("STORE_001", "CAM_1", "VIS_a1b2c3d4", "ENTRY")

Camera frame (at T+30s)
  ↓ track_id=42 still present
  ↓ PolygonZone[SKINCARE].trigger → True
  ↓ "SKINCARE" not in state.zones
  ↓ create_event(..., "ZONE_ENTER", zone_id="SKINCARE")

Camera frame (at T+45s)
  ↓ PolygonZone[SKINCARE] → True, elapsed > 15s since ZONE_ENTER
  ↓ create_event(..., "ZONE_DWELL", zone_id="SKINCARE", dwell_ms=15000)

Camera frame (at T+2m)
  ↓ track_id=42 no longer in SKINCARE
  ↓ create_event(..., "ZONE_EXIT", zone_id="SKINCARE", dwell_ms=90000)
  ↓ track_id=42 now in BILLING
  ↓ create_event(..., "ZONE_ENTER", zone_id="BILLING")
  ↓ create_event(..., "BILLING_QUEUE_JOIN", zone_id="BILLING", metadata.queue_depth=3)

Buffer reaches 10 events → httpx.post("/api/events/ingest", {events: [...]})

Server receives:
  → memStore.events.push(...10 events)
  → broadcast({type:"events", data: summary})
  → Dashboard live event feed updates

Camera frame (at T+8m)
  ↓ track_id=42 exits BILLING zone
  ↓ create_event(..., "ZONE_EXIT", zone_id="BILLING", dwell_ms=360000, metadata.purchased=True)
  ↓ Server: creates Transaction record (basket_value from CSV)

Camera frame (at T+9m)
  ↓ LineZone.trigger → crossed_out=True
  ↓ create_event(..., "EXIT")
```

---

## 12. Security Considerations

### Current State (Development)
- No authentication on any API endpoint.
- CORS is open (`allow_origins=["*"]`) on the FastAPI backend.
- Database credentials are stored in `.env` (gitignored in production).
- Base64 video frames transmitted over unencrypted WebSocket.

### Production Hardening Required
- **API Authentication:** Bearer token or API key for `/api/events/ingest` (pipeline → server).
- **Dashboard Auth:** OAuth2 / SSO for store manager access.
- **HTTPS/WSS:** TLS termination at a reverse proxy (nginx/Caddy) — all traffic encrypted in transit.
- **CORS:** Restrict `allow_origins` to the dashboard domain only.
- **Rate Limiting:** Limit `/api/events/ingest` to prevent DDoS — e.g., 100 req/s per API key.
- **PII Policy:** `visitor_id` is a random hex string — no biometric data is stored. Video frames transmitted to the dashboard are transient (not persisted server-side).

---

## 13. Failure Modes and Mitigations

| Failure | Impact | Mitigation |
|---|---|---|
| **Server down** during pipeline run | Events lost | `failed_events.jsonl` dead-letter queue captures all failed batches; can be replayed |
| **API timeout** (> 5s) | Batch of 10 events dropped to DLQ | httpx timeout=5s; exponential backoff retry is a recommended next step |
| **Camera feed ends** (end of MP4) | Pipeline exits normally | `cap.read()` returns `ret=False`; flush remaining event buffer; print summary |
| **Track ID switches** (occlusion) | Visitor appears as new visitor | ByteTrack `lost_track_buffer=30` frames mitigates short gaps; HSV re-ID catches longer gaps |
| **Memory cap reached** (50k events) | Oldest events trimmed | `memStore.events.slice(-MAX_MEM_EVENTS)` — today's data is always recent; old data trims naturally |
| **WebSocket disconnect** | Dashboard goes stale | Client auto-reconnects after 3s; HTTP polling every 5s provides fallback data |
| **YOLOv8 model not found** | Pipeline exits with ImportError | `yolov8n.pt` is committed to repo root; `YOLO("yolov8n.pt")` downloads if missing via Ultralytics |
| **Vite port conflict** | Dev server fails to start | Single port 3000 for all traffic; check `netstat -an | grep 3000` |
| **PostgreSQL unreachable** | FastAPI backend fails to start | Health check in `docker-compose.yml` ensures DB is ready before API starts |
