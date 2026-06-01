# 🏬 Retail Store Intelligence System

A full-stack, real-time retail analytics platform that processes live CCTV footage using computer vision, tracks visitor journeys across store zones, detects anomalies, and streams everything to a live analytics dashboard — all with zero database dependency in development mode.

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Tech Stack](#tech-stack)
4. [Project Structure](#project-structure)
5. [How It Works](#how-it-works)
6. [Event Schema](#event-schema)
7. [API Reference](#api-reference)
8. [Computer Vision Pipeline](#computer-vision-pipeline)
9. [Dashboard](#dashboard)
10. [Event Simulator](#event-simulator)
11. [Data Sources](#data-sources)
12. [Anomaly Detection](#anomaly-detection)
13. [Running the Project](#running-the-project)
14. [Configuration](#configuration)
15. [Architectural Decisions](#architectural-decisions)

---

## Overview

The Retail Store Intelligence System is a production-grade platform designed for brick-and-mortar retail analytics. It ingests raw CCTV footage, runs **YOLOv8** person detection and **ByteTrack** multi-object tracking to identify individual visitor journeys, and emits structured events in real-time to an Express.js server that powers a live React dashboard.

**Key capabilities:**
- 🎥 Real-time CCTV footage processing (multi-camera support)
- 👤 Visitor tracking and re-identification across zones
- 📍 Polygon-based zone detection (Skincare, Fragrance, Makeup, Billing)
- 🧾 Entry/exit line crossing detection
- ⏱️ Dwell time tracking per zone per visitor
- 💳 Billing queue depth monitoring
- 🚨 Automated anomaly detection (queue spikes, high abandonment)
- 📊 Live dashboard with KPIs, heatmaps, funnels, and sales analytics
- 📡 WebSocket-based real-time streaming to browser clients
- 🛒 Sales analytics from real POS transaction CSV data
- 🤖 Event simulator for development and testing

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CCTV Cameras (MP4)                          │
│          CAM 1 · CAM 2 · CAM 3 · CAM 4 · CAM 5                    │
└──────────────────────────┬──────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  Python CV Pipeline  (process_footage.py)           │
│                                                                     │
│  ┌────────────┐   ┌──────────────┐   ┌───────────────────────────┐ │
│  │  YOLOv8n   │──▶│  ByteTrack   │──▶│  SessionManager           │ │
│  │  (detect)  │   │  (track IDs) │   │  (visitor re-ID, dwell)   │ │
│  └────────────┘   └──────────────┘   └───────────────────────────┘ │
│                                                 │                   │
│  ┌─────────────────────────────────────────┐   │                   │
│  │  Supervision PolygonZones + LineZone     │◀──┘                   │
│  │  SKINCARE · FRAGRANCE · MAKEUP · BILLING │                       │
│  └──────────────────┬──────────────────────┘                       │
│                     │ Batch events (httpx POST)                     │
└─────────────────────┼───────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────────────────┐
│               Express.js + Vite Server  (server.ts)                 │
│                        http://localhost:3000                        │
│                                                                     │
│  POST /api/events/ingest  ──▶  In-Memory Store (50k event cap)      │
│                                      │                              │
│                           ┌──────────┴──────────┐                  │
│                           │    WebSocket Server   │                  │
│                           │   ws://localhost:3000/ws│               │
│                           └──────────┬──────────┘                  │
│                                      │ broadcast()                  │
└──────────────────────────────────────┼──────────────────────────────┘
                                       │
                                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│               React Dashboard  (src/App.tsx)                        │
│                                                                     │
│  KPI Cards · Zone Heatmap · Purchase Funnel · Live Event Feed      │
│  Anomaly Alerts · Dwell Time Breakdown · Sales Analytics (CSV)     │
│  Live Camera Feed (base64 JPEG streaming via WebSocket)            │
└─────────────────────────────────────────────────────────────────────┘
```

The system also ships with a **FastAPI backend** (`/app`) intended for production deployments with PostgreSQL and Redis, and a **TypeScript event simulator** (`pipeline/simulator.ts`) for development testing without CCTV footage.

---

## Tech Stack

### Frontend
| Technology | Version | Purpose |
|---|---|---|
| React | 19.0.1 | UI framework |
| TypeScript | ~5.8.2 | Type safety |
| Vite | 6.2.3 | Build tool + dev server |
| TailwindCSS v4 | 4.1.14 | Utility-first styling |
| Recharts | 3.8.1 | Bar charts (heatmap, sales) |
| Motion (Framer) | 12.23.24 | Animations, AnimatePresence |
| Lucide React | 0.546.0 | Icon library |

### Backend (Node.js Server)
| Technology | Version | Purpose |
|---|---|---|
| Express.js | 4.21.2 | HTTP server + REST API |
| ws (WebSocket) | 8.21.0 | Real-time event broadcasting |
| Vite (middleware) | 6.2.3 | Dev-mode SPA serving |
| tsx | 4.21.0 | TypeScript execution (dev) |
| csv-parse | 6.2.1 | CSV analytics ingestion |
| dotenv | 17.2.3 | Environment config |
| esbuild | 0.25.0 | Production server bundler |

### Computer Vision Pipeline (Python)
| Technology | Version | Purpose |
|---|---|---|
| YOLOv8 (Ultralytics) | 8.1.24 | Person detection (class 0) |
| Supervision | 0.18.0 | ByteTrack, PolygonZone, LineZone, annotators |
| ByteTrack | via Supervision | Multi-object tracking |
| OpenCV (cv2) | 4.9.0.80 | Video decode, frame processing, HSV histograms |
| PyTorch | 2.2.1 | YOLOv8 model backend |
| httpx | 0.27.0 | Async event emission to API |
| NumPy | 1.26.4 | Frame array operations |

### Production Backend (FastAPI — `/app`)
| Technology | Purpose |
|---|---|
| FastAPI | Async Python REST API |
| SQLAlchemy | ORM for PostgreSQL |
| PostgreSQL | Persistent event storage |
| Redis | Stream buffering for high ingest volume |
| Pydantic v2 | Request/response validation |

### Infrastructure
| Technology | Purpose |
|---|---|
| Docker + Docker Compose | Multi-service orchestration |
| Neon PostgreSQL | Serverless Postgres (cloud, via `.env`) |

---

## Project Structure

```
.
├── src/                         # React frontend source
│   ├── App.tsx                  # Main dashboard component (805 lines)
│   ├── index.css                # Design tokens, animations, glass UI
│   └── main.tsx                 # React entry point
│
├── pipeline/                    # Computer vision + simulation
│   ├── process_footage.py       # Main CCTV processing pipeline (665 lines)
│   ├── detect.py                # YOLOv8 detection helpers
│   ├── tracker.py               # ByteTrack wrapper
│   ├── emit.py                  # Event creation + HTTP emission
│   ├── simulator.ts             # TypeScript event simulator (351 lines)
│   ├── requirements.txt         # Python dependencies
│   └── run.sh                   # Shell runner for single video
│
├── app/                         # FastAPI production backend
│   ├── main.py                  # App factory, CORS, router registration
│   ├── models.py                # SQLAlchemy + Pydantic models
│   ├── database.py              # DB engine/session setup
│   ├── ingestion.py             # POST /events/ingest router
│   ├── metrics.py               # GET /stores/{id}/metrics
│   ├── funnel.py                # GET /stores/{id}/funnel
│   ├── anomalies.py             # GET /stores/{id}/anomalies
│   ├── health.py                # GET /health
│   └── requirements.txt        # Python dependencies (FastAPI)
│
├── server.ts                    # Express + WebSocket + Vite unified server
├── CCTV Footage/                # Raw MP4 videos + CSV sales data
│   ├── CAM 1.mp4  (~172 MB)
│   ├── CAM 2.mp4  (~155 MB)
│   ├── CAM 3.mp4  (~182 MB)
│   ├── CAM 4.mp4  (~70 MB)
│   ├── CAM 5.mp4  (~70 MB)
│   └── Brigade_Bangalore_10_April_26.csv   # Real POS transaction data
│
├── docs/
│   └── CHOICES.md               # Architectural decision records (ADRs)
│
├── index.html                   # HTML entry point
├── vite.config.ts               # Vite + TailwindCSS + React config
├── tsconfig.json                # TypeScript config (ES2022, bundler)
├── package.json                 # npm scripts and dependencies
├── docker-compose.yml           # PostgreSQL + Redis + API + Dashboard
├── create_schema.ts             # DB schema bootstrapper
├── seed_db.ts                   # DB seed script
├── yolov8n.pt                   # YOLOv8 nano model weights (~6.2 MB)
├── failed_events.jsonl          # Dead-letter queue for failed API emissions
└── .env                         # Environment variables (DB URL, Redis)
```

---

## How It Works

### End-to-End Data Flow

#### 1. CCTV Footage Ingestion
The Python pipeline (`pipeline/process_footage.py`) opens MP4 video files using OpenCV and processes them at ~10 frames/second (skipping frames based on video FPS). For each processed frame:

#### 2. Person Detection
YOLOv8 nano (`yolov8n.pt`) runs inference on the frame, filtering only `class=0` (person) detections with a confidence threshold of ≥ 0.35.

#### 3. Multi-Object Tracking
Detections are passed to **ByteTrack** (via Supervision) which assigns persistent `track_id`s across frames. ByteTrack is preferred over DeepSORT for its superior performance with partial occlusions common in retail billing queues.

#### 4. Session Management & Re-Identification
Each new `track_id` is processed by `SessionManager`:
- **Color histograms** (HSV, 8×8 bins) of the person crop are computed.
- If a new track's histogram is within **Bhattacharyya distance < 0.55** of an existing visitor's histogram, it is classified as a **REENTRY** (same person returned).
- **Staff detection** uses a heuristic: very dark (avg saturation < 40) AND dim (avg value < 80) clothing is flagged as staff uniform.
- Each visitor is assigned a unique `VIS_<8hex>` ID.

#### 5. Zone Detection
Adaptive polygon zones are created based on frame resolution:
- **SKINCARE** — left third of the frame (0–33% width, top 65% height)
- **FRAGRANCE** — center third (33–66% width, top 65% height)
- **MAKEUP** — right third (66–100% width, top 65% height)
- **BILLING** — bottom-right quadrant (65–100% width, 65–95% height)
- **Entry line** — horizontal line at 75% of frame height

`sv.PolygonZone.trigger()` and `sv.LineZone.trigger()` compute per-frame zone membership for each tracked detection.

#### 6. Event Emission
Events are batched (default: 10 events per batch) and POSTed via `httpx` to `POST /api/events/ingest`. On failure, events fall back to `failed_events.jsonl` (dead-letter queue).

Annotated frames (with bounding boxes, visitor IDs, entry line) are encoded as JPEG at 70% quality and POSTed to `POST /api/video/frame` for live camera streaming.

#### 7. Server Processing
The Express server (`server.ts`) receives events and:
1. Stores them in an in-memory `EventRow[]` array (capped at 50,000 events).
2. Broadcasts a lightweight summary to all WebSocket clients.
3. Randomly (~20% of ingest calls) runs anomaly detection against recent memory.
4. Returns `{ status: "success", processed: N }`.

#### 8. Dashboard Updates
The React frontend connects via WebSocket (`ws://localhost:3000/ws`) and:
- Receives `{ type: "events", data: [...] }` → updates the live event feed.
- Receives `{ type: "metrics", data: {...} }` → updates KPI cards.
- Receives `{ type: "anomalies", data: [...] }` → shows alert banners.
- Receives `{ type: "video_frame", data: "<base64>" }` → renders to `<canvas>`.
- Also polls REST endpoints every 5 seconds as a fallback.

---

## Event Schema

Every event (from the pipeline or simulator) conforms to this schema:

```json
{
  "event_id":   "uuid-v4",
  "store_id":   "STORE_001",
  "camera_id":  "CAM_1",
  "visitor_id": "VIS_a1b2c3d4",
  "event_type": "ZONE_ENTER",
  "timestamp":  "2026-04-10T08:23:11.456Z",
  "zone_id":    "SKINCARE",
  "dwell_ms":   45200,
  "is_staff":   false,
  "confidence": 0.912,
  "metadata": {
    "session_seq": 3,
    "queue_depth": 2,
    "purchased": true,
    "transaction": { "invoice_number": "...", "total_amount": 1240.00 }
  }
}
```

### Event Types

| Event Type | Trigger | Zone Required |
|---|---|---|
| `ENTRY` | Visitor crosses entry line inward | No |
| `REENTRY` | Re-identified visitor crosses entry line | No |
| `EXIT` | Visitor crosses entry line outward | No |
| `ZONE_ENTER` | Visitor enters a polygon zone | Yes |
| `ZONE_DWELL` | Visitor still in zone after `DWELL_EMIT_INTERVAL` (15s) | Yes |
| `ZONE_EXIT` | Visitor leaves a polygon zone | Yes |
| `BILLING_QUEUE_JOIN` | Visitor enters BILLING zone | Yes (`BILLING`) |
| `BILLING_QUEUE_ABANDON` | Visitor leaves billing without purchase | Yes (`BILLING`) |

---

## API Reference

All endpoints are served by `server.ts` on `http://localhost:3000`.

### `POST /api/events/ingest`
Ingests a batch of events into the in-memory store and broadcasts via WebSocket.

**Request:**
```json
{ "events": [ <EventSchema>, ... ] }
```
**Response:**
```json
{ "status": "success", "processed": 10 }
```

---

### `POST /api/video/frame`
Receives a base64-encoded JPEG frame and broadcasts it to dashboard clients.

**Request:**
```json
{ "camera_id": "CAM_1", "frame": "<base64-jpeg>" }
```

---

### `GET /api/stores/:id/metrics`
Returns aggregated KPI metrics for today's events.

**Response:**
```json
{
  "unique_visitors": 142,
  "conversion_rate": 38.5,
  "queue_depth": 3,
  "abandonment_rate": 12.0,
  "avg_dwell_zone": {
    "SKINCARE": "4.20",
    "FRAGRANCE": "2.85",
    "MAKEUP": "3.10",
    "BILLING": "6.40"
  }
}
```

---

### `GET /api/stores/:id/funnel`
Returns the visitor conversion funnel for today.

**Response:**
```json
{
  "entry_count": 142,
  "zone_visit_count": 118,
  "billing_queue_count": 67,
  "purchase_count": 48
}
```

---

### `GET /api/stores/:id/heatmap`
Returns zone-level visit counts and heat scores (0–100).

**Response:**
```json
{
  "zones": [
    { "zone_id": "SKINCARE", "visit_count": 74, "avg_dwell": 252000, "heat_score": 100 },
    { "zone_id": "FRAGRANCE", "visit_count": 51, "avg_dwell": 171000, "heat_score": 69 }
  ]
}
```

---

### `GET /api/stores/:id/anomalies`
Returns the last 10 anomalies detected today.

**Response:**
```json
[
  {
    "store_id": "STORE_001",
    "type": "QUEUE_SPIKE",
    "severity": "CRITICAL",
    "timestamp": "2026-04-10T10:44:22Z",
    "suggested_action": "Queue depth 8 exceeds 2x average (3.2). Open additional registers."
  }
]
```

---

### `GET /api/stores/:id/analytics`
Returns parsed sales analytics from the Brigade Bangalore POS CSV.

**Response:**
```json
{
  "topBrands": [{ "name": "BrandX", "value": 48200 }, ...],
  "categories": [{ "name": "SKINCARE", "value": 120500 }, ...],
  "topSalespersons": [{ "name": "Priya", "value": 38000 }, ...]
}
```

---

### `GET /api/health`
Returns server health and memory usage stats.

**Response:**
```json
{
  "status": "ok",
  "db": "in-memory",
  "events_in_memory": 12480,
  "ws_clients": 2,
  "uptime": 4821.3
}
```

---

## Computer Vision Pipeline

### Usage

Process a single video:
```bash
python pipeline/process_footage.py "CCTV Footage/CAM 1.mp4"
```

Process all cameras in a folder:
```bash
python pipeline/process_footage.py "CCTV Footage" --all
```

Process with live preview window:
```bash
python pipeline/process_footage.py "CCTV Footage/CAM 1.mp4" --show
```

Use a custom store ID:
```bash
python pipeline/process_footage.py "CCTV Footage" --all --store STORE_002
```

### Key Configuration Parameters

| Parameter | Default | Description |
|---|---|---|
| `CONFIDENCE_THRESHOLD` | 0.35 | Minimum YOLOv8 detection confidence |
| `DWELL_EMIT_INTERVAL` | 15.0s | How often to emit `ZONE_DWELL` for a visitor |
| `STAFF_COLOR_THRESHOLD` | 0.6 | Bhattacharyya distance for staff re-ID |
| `REENTRY_THRESHOLD` | 0.55 | Histogram similarity for visitor re-ID |
| `EMIT_BATCH_SIZE` | 10 | Events per HTTP POST batch |
| `frame_skip` | `fps / 10` | Process ~10 frames/second regardless of source FPS |

### Model
- **YOLOv8 nano** (`yolov8n.pt`, ~6.2 MB) — optimized for real-time inference speed over raw accuracy.
- Model weights are included in the repository root.
- Install Python dependencies: `pip install -r pipeline/requirements.txt`

---

## Dashboard

The React dashboard (`src/App.tsx`) is a single-page application providing:

### KPI Cards (top row)
- **Unique Visitors** — distinct `visitor_id`s with `ENTRY`/`REENTRY` today (excluding staff)
- **Conversion Rate** — `transactions / unique_visitors × 100`
- **Queue Depth** — live count from the most recent `BILLING_QUEUE_JOIN.metadata.queue_depth`
- **Abandonment Rate** — `BILLING_QUEUE_ABANDON / BILLING_QUEUE_JOIN × 100`

### Zone Activity Heatmap
Bar chart showing visit counts per zone, colored by zone type (pink=Skincare, purple=Fragrance, orange=Makeup, amber=Billing). Bar opacity is dynamically scaled by heat score.

### Purchase Funnel
Animated progress bars showing:
`Entry → Zone Visit → Billing Queue → Purchase`
Each stage shows absolute count and percentage of entry count.

### Live Camera Feed
A `<canvas>` element that renders base64 JPEG frames streamed from the Python pipeline via WebSocket. Falls back to a "No Video Signal" placeholder.

### Live Event Feed
Animated list (using `AnimatePresence`) showing the last 25 events with emoji icons, color-coded event types, zone badges, visitor IDs, and timestamps.

### Anomaly Alerts
Color-coded alert cards (red=CRITICAL, amber=WARN) with anomaly type, timestamp, and suggested remediation action.

### Dwell Time Breakdown
Per-zone average dwell time in minutes, displayed as colored tiles with heat intensity proportional to the maximum dwell.

### Sales Analytics (CSV Data)
- **Top Brands by GMV** — horizontal bar chart (₹ values)
- **Category Breakdown** — vertical bar chart by department

### Design System
The UI uses a custom dark design system defined in `src/index.css`:
- Background: `#08090b` (near black)
- Cards: `#161a22` with `inset` glow
- Colors: Emerald, Cyan, Amber, Rose, Violet with corresponding glow variables
- Typography: `Inter` (sans) + `JetBrains Mono` (mono)
- Animations: `pulse-glow`, `shimmer`, `slide-in-right`, `slide-in-up`, `bar-grow`
- Glass cards with `backdrop-filter: blur(20px)` and subtle borders

---

## Event Simulator

For development without CCTV footage, the TypeScript simulator generates statistically realistic visitor journeys:

```bash
npm run simulate
# or
npx tsx pipeline/simulator.ts --rate 5 --store STORE_001
```

**Simulation model:**
- Visitor arrivals follow a **Poisson process** (configurable `--rate`)
- Each visitor is assigned 1–3 random zones to browse (shuffled from `SKINCARE, FRAGRANCE, MAKEUP, ELECTRONICS, GROCERY`)
- Zone dwell times follow an **exponential distribution** (mean ~8s in sim time)
- 65% of non-staff visitors proceed to `BILLING_QUEUE_JOIN`
- 75% of billing visitors complete purchase; 25% `BILLING_QUEUE_ABANDON`
- 5% of arrivals are flagged as staff; 10% are REENTRY events
- Real transaction data from the POS CSV is cycled through and attached to purchase events

The simulator emits events every 2 seconds and logs a real-time summary to stdout.

---

## Data Sources

### CCTV Footage
Five MP4 video files from a real retail store (Brigade Road, Bangalore):
| File | Size |
|---|---|
| CAM 1.mp4 | ~172 MB |
| CAM 2.mp4 | ~155 MB |
| CAM 3.mp4 | ~182 MB |
| CAM 4.mp4 | ~70 MB |
| CAM 5.mp4 | ~70 MB |

### POS Transaction Data
`Brigade_Bangalore_10_April_26.csv` — real sales data from April 10, 2026 including:
- `invoice_number` — unique transaction identifier
- `brand_name` — brand of the purchased item
- `dep_name` — department/category
- `salesperson_name` — staff member who made the sale
- `total_amount` — transaction value in ₹

This CSV is parsed at server startup and served via `/api/stores/:id/analytics`.

---

## Anomaly Detection

The server detects anomalies in-memory (~20% of ingest calls to avoid overhead):

### `QUEUE_SPIKE` (CRITICAL)
Triggered when the current billing queue depth exceeds **2× the rolling average** AND exceeds an absolute threshold of 3.
> *"Queue depth 8 exceeds 2x average (3.2). Open additional registers."*

### `HIGH_ABANDONMENT` (WARN)
Triggered when there are more than 3 billing queue joins in the last 30 minutes AND the abandonment rate exceeds 40%.
> *"52% abandonment rate. Investigate wait times."*

Anomalies are stored in `memStore.anomalies` and broadcast to WebSocket clients immediately upon detection.

---

## Running the Project

### Prerequisites
- Node.js 18+
- Python 3.10+
- npm

### Quick Start (Development — No DB Required)

**1. Install Node.js dependencies:**
```bash
npm install
```

**2. Install Python dependencies:**
```bash
pip install -r pipeline/requirements.txt
```

**3. Start the server (Express + Vite + WebSocket):**
```bash
npm run dev
```
> Opens at `http://localhost:3000`

**4a. Run the CCTV pipeline (real footage):**
```bash
python pipeline/process_footage.py "CCTV Footage" --all
```

**4b. OR run the event simulator (no video needed):**
```bash
npm run simulate
```

---

### Production Build

```bash
npm run build          # Vite build + esbuild server bundle
npm start              # node dist/server.cjs
```

---

### Docker (Full Stack with PostgreSQL + Redis)

```bash
docker compose up -d
```

This starts:
- `db` — PostgreSQL 15 on port 5432
- `redis` — Redis 7 on port 6379
- `api` — FastAPI backend on port 8000
- `dashboard` — React + Express on port 3000

---

## Configuration

### Environment Variables (`.env`)

| Variable | Description |
|---|---|
| `DATABASE_URL` | PostgreSQL connection string (used by FastAPI backend + `create_schema.ts`) |
| `REDIS_URL` | Redis connection string (used by FastAPI backend) |
| `VITE_API_URL` | API base URL for Vite dev proxy |
| `API_URL` | Override for the Python pipeline's event ingest endpoint (default: `http://localhost:3000/api/events/ingest`) |
| `NODE_ENV` | Set to `production` to serve from `dist/` instead of Vite middleware |
| `DISABLE_HMR` | Set to `true` to disable Vite HMR (used in AI agent environments) |

---

## Architectural Decisions

### 1. Detection Model — YOLOv8 + Supervision
**Considered:** YOLOv8, YOLOv9, RT-DETR

YOLOv8 was chosen for its mature ecosystem via Ultralytics and Supervision. Supervision provides native `PolygonZone` and `LineZone` primitives that directly map to retail layout requirements. **ByteTrack** was preferred over DeepSORT due to better performance with partial occlusions common in retail environments (shoppers obscured by shelving and queues).

### 2. Event Schema — Single Table with JSONB Metadata
**Considered:** Relational broad tables vs Single Event Table with JSONB

A single unified `events` table with a `JSONB metadata` column was chosen. Time-series event data is highly immutable. Using UUID `event_id` ensures idempotent ingestion. JSONB allows arbitrary payload extensions (e.g. `queue_depth`, transaction data) without schema migrations.

### 3. API Architecture — Express (dev) / FastAPI (prod)
**Considered:** SQLite vs PostgreSQL + Redis

- **Development:** Node.js Express with an in-memory store. No database setup required. The server works immediately after `npm install`.
- **Production:** FastAPI + PostgreSQL + Redis. PostgreSQL handles JSONB natively and concurrent inserts at scale. SQLite locks during high concurrent writes (500 event batches). Redis Streams provide buffering at high ingest volumes. FastAPI was chosen for native async support matching the I/O-heavy event ingestion pattern.

### 4. In-Memory Store Cap
Events are capped at 50,000 in memory (trimmed from the front). This ensures the server remains stable for long-running pipeline sessions without memory pressure.

### 5. Frame Streaming via WebSocket
Annotated frames are JPEG-encoded at 70% quality, resized to max 640px width, and sent as base64 strings over WebSocket. This avoids any need for RTSP/HLS infrastructure while still providing a live "camera feed" experience in the dashboard.

## Screenshot
![Dashboard](screenshot/1.png)
![--](screenshot/2.png)
![--](screenshot/3.png)
