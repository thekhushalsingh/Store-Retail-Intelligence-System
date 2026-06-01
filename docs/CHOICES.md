# Architectural Decision Records (ADRs)

This document records every significant architectural and technology decision made during the design and implementation of the Retail Store Intelligence System, including the options considered, the rationale for each choice, and the trade-offs accepted.

---

## ADR-001 — Object Detection Model

**Status:** Accepted  
**Date:** 2026-04

### Context
The pipeline needs to detect people in retail CCTV footage in real-time (or near-real-time). The model must run efficiently on commodity hardware and integrate cleanly with a tracking + zone-polygon system.

### Options Considered

| Model | Pros | Cons |
|---|---|---|
| **YOLOv8** | Best ecosystem, Ultralytics+Supervision native support, extensive retail use cases, `yolov8n.pt` is only 6.2 MB | Slightly less accurate than RT-DETR on some benchmarks |
| **YOLOv9** | Improved accuracy over v8 | Less mature tooling, fewer integration examples |
| **RT-DETR** | Transformer-based, competitive SOTA accuracy | Supervision integration requires manual wrappers; heavier inference footprint |
| **Detectron2** | Very accurate, Meta-backed | Overkill for a single-class problem; large install, slow on CPU |

### Decision
**YOLOv8 nano (`yolov8n.pt`)** via Ultralytics.

### Rationale
- Ultralytics provides a single-line `YOLO("yolov8n.pt")` API.
- The `supervision` library provides first-class `sv.Detections.from_ultralytics()` — zero adapter code.
- The nano model (~6.2 MB) achieves ~10 FPS on CPU for 1080p frames with `frame_skip`, which is sufficient for retail dwell-time analytics (we do not need every frame).
- Class filtering `classes=[0]` (person only) reduces false positives from products and shelving.
- The nano model is included in the repo root, removing any setup friction.

### Trade-offs Accepted
- Nano accuracy is lower than YOLOv8x or RT-DETR. For retail dwell analytics, minor missed detections are acceptable — the tracker recovers continuity across short detection gaps.

---

## ADR-002 — Multi-Object Tracking Algorithm

**Status:** Accepted  
**Date:** 2026-04

### Context
Once people are detected per-frame, they must be consistently tracked across frames with stable IDs to compute dwell time and zone transitions.

### Options Considered

| Tracker | Approach | Key Strength | Key Weakness |
|---|---|---|---|
| **ByteTrack** | Motion-based, uses low-confidence detections | Handles occlusions well; low-confidence detections re-associate partially occluded people | No appearance features |
| **DeepSORT** | Motion + appearance (deep features) | Good re-ID across long gaps | Slower, requires feature extractor (OSNet/ResNet); over-kills for short-range tracking |
| **OC-SORT** | Observation-centric | Robust to non-linear motion | Less adoption in Supervision ecosystem |
| **StrongSORT** | DeepSORT improvements | Better accuracy | Even heavier than DeepSORT |

### Decision
**ByteTrack** via `sv.ByteTrack`.

### Rationale
- Retail CCTV footage has **constant partial occlusions** — shoppers are obscured by shelving units, product displays, and other customers. ByteTrack's use of low-confidence detections (below `track_activation_threshold`) during occlusion significantly reduces ID switches in these conditions.
- Supervision integrates ByteTrack natively: `tracker.update_with_detections(detections)` — no boilerplate.
- ByteTrack is significantly faster than DeepSORT/StrongSORT as it requires no deep appearance feature extraction.
- Configuration: `lost_track_buffer=30` frames, `minimum_matching_threshold=0.8`.

### Trade-offs Accepted
- No appearance-based re-identification **across the tracker** (for short gaps). Visitor re-identification across sessions is handled separately at the application layer by `SessionManager` using color histograms (see ADR-004).

---

## ADR-003 — Zone Definition Strategy

**Status:** Accepted  
**Date:** 2026-04

### Options Considered

| Approach | Description | Pros | Cons |
|---|---|---|---|
| **`store_layout.json` with hand-drawn polygons** | Pre-annotated polygon coordinates per camera | Precise, real-world calibrated | Requires per-store manual calibration tool; coordinate systems differ per camera |
| **Adaptive geometric zones** | Zones computed as percentage fractions of frame dimensions at runtime | Zero setup — works on any resolution/camera immediately | Less precise; assumes standard camera placement |
| **Homography-mapped floor plan** | Camera image warped to real-world coordinates | Most accurate spatial representation | Requires camera calibration matrices per camera, high complexity |

### Decision
**Adaptive geometric zones** based on frame width/height percentages.

### Rationale
- With 5 different cameras at different resolutions and orientations, hand-labelling polygon coordinates for each would require a separate calibration UI or manual measurement per camera.
- The adaptive approach works immediately on any MP4 — the pipeline computes zones at the start of each video using `frame_w` and `frame_h`.
- Retail stores have a relatively predictable layout split (left = skincare/beauty, center = fragrance, right = makeup, bottom-right = billing) that maps well to horizontal thirds.
- Supervision's `sv.PolygonZone` handles the pixel-level containment test efficiently via NumPy mask operations.

### Zone Layout

```
┌────────────────┬───────────────┬────────────────┐
│   SKINCARE     │   FRAGRANCE   │     MAKEUP     │  0–65% height
│  (0–33% wide)  │ (33–66% wide) │  (66–100% wide)│
├────────────────┴───────────────┤                │
│                                │    BILLING     │  65–95% height
│       (entry corridor)         │  (65–100% wide)│
└────────────────────────────────┴────────────────┘
                                 ← Entry Line at 75% height →
```

### Trade-offs Accepted
- Zone boundaries are approximations. For a production deployment serving a specific store, hand-calibrated polygons from a layout editor would replace these.

---

## ADR-004 — Visitor Re-Identification

**Status:** Accepted  
**Date:** 2026-04

### Context
When the same physical person leaves the tracker's buffer (e.g., walks off-camera and returns) they get a new `track_id`. For accurate session analytics we need to detect re-entries and assign the same `visitor_id`.

### Options Considered

| Approach | Accuracy | Complexity | Speed |
|---|---|---|---|
| **OSNet / Torchreid** (deep re-ID) | High | High — requires a separate model, ~50 MB | Slow on CPU |
| **Color histogram (HSV)** | Medium | Low — pure NumPy/OpenCV | Fast (~0.5 ms per crop) |
| **Person height/width ratio** | Low | Very low | Instant |
| **No re-ID** | N/A | None | N/A |

### Decision
**Color histogram (HSV, 8×8 bins) with Bhattacharyya distance.**

### Rationale
- Retail re-ID windows are short (same session, typically < 5 minutes). Deep re-ID models are beneficial for cross-day or cross-camera re-ID — overkill here.
- HSV histograms capture clothing color distribution, which is stable within a session.
- `cv2.compareHist` with `HISTCMP_BHATTACHARYYA` is a single C-extension call — negligible overhead.
- A distance threshold of `0.55` was tuned empirically: low enough to avoid false positive matches between different people, high enough to match the same person under varying lighting.

### Staff Detection
A secondary heuristic classifies staff using the same HSV crop: if `avg_saturation < 40` AND `avg_value < 80`, the person is flagged as staff (dark, desaturated uniform). Staff events are filtered from customer KPIs.

### Trade-offs Accepted
- Color-based re-ID will fail if two visitors wear very similar clothing. Accepted as a known limitation for MVP — deep re-ID can replace this in a future iteration.

---

## ADR-005 — Event Schema Design

**Status:** Accepted  
**Date:** 2026-04

### Options Considered

| Schema Design | Pros | Cons |
|---|---|---|
| **One table per event type** (ENTRY_EVENTS, ZONE_EVENTS, etc.) | Type-safe columns per event | Schema migrations required for every new event type; cross-type queries are complex JOINs |
| **Single events table with JSONB metadata** | Flexible, single ingest path, easy funnel queries across all types | Metadata values are not indexed by default (requires GIN index) |
| **EAV (Entity-Attribute-Value)** | Schema-free | Horrible query performance; no type safety |
| **Columnar (TimescaleDB)** | Excellent time-series performance | Additional infrastructure dependency |

### Decision
**Single unified `events` table with a `JSONB metadata` column.**

```sql
CREATE TABLE events (
    event_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    store_id    TEXT NOT NULL,
    camera_id   TEXT,
    visitor_id  TEXT NOT NULL,
    event_type  TEXT NOT NULL,         -- ENTRY, EXIT, ZONE_ENTER, etc.
    timestamp   TIMESTAMPTZ NOT NULL,
    zone_id     TEXT,
    dwell_ms    INTEGER DEFAULT 0,
    is_staff    BOOLEAN DEFAULT FALSE,
    confidence  FLOAT,
    metadata    JSONB DEFAULT '{}'
);
```

### Rationale
- All event types share `store_id`, `visitor_id`, `event_type`, `timestamp`, `zone_id`, `dwell_ms` — a shared schema covers ~90% of fields.
- `JSONB metadata` absorbs event-specific fields (`queue_depth`, `session_seq`, `purchased`, `transaction`) **without schema migrations**.
- `event_id` as UUID primary key ensures **idempotent ingestion** — `db.merge()` on re-delivery of the same event is a no-op.
- Funnel queries are trivial: `WHERE event_type IN ('ENTRY', 'ZONE_ENTER', 'BILLING_QUEUE_JOIN')` across one table.
- PostgreSQL's `JSONB` supports GIN indexes on `metadata` keys for production query performance.

### Trade-offs Accepted
- `metadata` values are untyped in SQL. Validation is enforced in the Pydantic layer (`EventSchema`) before DB write, not at the DB level.

---

## ADR-006 — API Layer: Express (Dev) vs FastAPI (Prod)

**Status:** Accepted  
**Date:** 2026-04

### Context
The system needs two API modes: a zero-dependency development mode and a production-grade persistent backend.

### Options Considered

| Option | Language | DB Required | Real-time |
|---|---|---|---|
| **Express.js + in-memory** | TypeScript | No | WebSocket (ws) |
| **FastAPI + PostgreSQL + Redis** | Python | Yes | No native WS (polling) |
| **Express.js + PostgreSQL** | TypeScript | Yes | WebSocket |
| **SQLite + Express** | TypeScript | File-based | WebSocket |

### Decisions
1. **Development:** Express.js (`server.ts`) with in-memory `EventRow[]` store (cap: 50,000 events).
2. **Production:** FastAPI (`/app`) with PostgreSQL + Redis.

### Rationale — Development Mode
- Eliminates all setup friction. `npm install && npm run dev` is the entire setup.
- The same Node.js process serves Express API + Vite (SPA middleware) + WebSocket on a single port (3000) — one command, one process.
- In-memory store handles full-day analytics loads easily (50k events ≈ ~8 hours of a busy store).
- The 50k event cap trims from the front on overflow, preventing OOM on long-running sessions.

### Rationale — Production Mode (FastAPI)
- **SQLite was rejected** because it uses write-locking that blocks under concurrent batch inserts (500 events/batch). PostgreSQL handles concurrent COPY/INSERT efficiently.
- **FastAPI** was chosen over Flask for native `async def` endpoints — essential for I/O-bound event ingestion at scale.
- **Redis Streams** provide a write buffer: ingest endpoint ACKs immediately, a background consumer commits to PostgreSQL. This decouples ingest latency from DB write latency.
- **Pydantic v2** enforces strict schema validation on every ingest batch before DB write.
- `structlog` provides structured JSON logging for production observability.

### Trade-offs Accepted
- The development in-memory store loses all data on server restart. This is acceptable for development — the pipeline can simply be re-run.
- The two backends (Express/FastAPI) are not automatically synchronized. Running both simultaneously is possible (different ports) but not the intended pattern.

---

## ADR-007 — Anomaly Detection Strategy

**Status:** Accepted  
**Date:** 2026-04

### Context
The system should proactively surface operational problems (long queues, abandoned carts) to store managers in real-time.

### Options Considered

| Approach | Accuracy | Explainability | Latency |
|---|---|---|---|
| **ML — Isolation Forest** | High for novel anomalies | Low — black box | High — requires training data |
| **ML — LSTM autoencoder** | High for sequential anomalies | Very low | Very high |
| **Statistical Process Control (SPC)** | Medium — assumes normality | High | Low |
| **Rolling-window heuristics** | Medium — rule-based | Very high | Very low |

### Decision
**Rolling-window heuristics** for the MVP.

### Rules Implemented

#### QUEUE_SPIKE (CRITICAL)
```
IF current_queue_depth > max(3, rolling_average_depth × 2)
THEN alert("Open additional registers")
```
Evaluated over the last 30 minutes of `BILLING_QUEUE_JOIN` events.

#### HIGH_ABANDONMENT (WARN)
```
IF billing_joins > 3 AND (abandons / joins) > 0.40
THEN alert("Investigate wait times")
```
Evaluated over the last 30 minutes.

#### DEAD_ZONE (WARN) — FastAPI backend only
```
IF zone had visits today BUT zero events in last 30 minutes
THEN alert("Check camera feed or display at {zone}")
```

### Rationale
- Heuristics are immediately explainable to store managers — the `suggested_action` field contains a human-readable recommendation.
- No training data is needed — the system works on day one.
- Rolling-window anomalies are the right fit for retail: the anomaly is resolved when the condition is no longer true (queue clears, abandonment drops).
- Evaluated at ~20% of ingest calls in the in-memory server (probabilistic sampling) to avoid adding latency to the ingest hot path.

### Trade-offs Accepted
- Heuristics will miss novel anomaly patterns (e.g., unusual visitor movement paths). Isolation Forest or LSTM-based detection is the recommended next step once 30+ days of event data are available for training.

---

## ADR-008 — Real-Time Communication: WebSocket vs SSE vs Polling

**Status:** Accepted  
**Date:** 2026-04

### Options Considered

| Method | Bidirectional | Browser Support | Overhead |
|---|---|---|---|
| **WebSocket** | Yes | Universal | Low once connected |
| **Server-Sent Events (SSE)** | No (server→client only) | Universal | Very low |
| **Long Polling** | No | Universal | High (reconnects) |
| **HTTP Polling (5s interval)** | No | Universal | Medium |

### Decision
**WebSocket (primary) + HTTP Polling (fallback/initial load).**

### Rationale
- The dashboard needs server-push for live event feeds and video frames — polling would introduce visible lag (1–5 seconds).
- `ws` (Node.js) is the lightest WebSocket implementation available — a single dependency, zero abstraction overhead.
- The server broadcasts to all connected clients on every ingest call — zero per-client state, O(1) message fan-out.
- HTTP polling every 5 seconds serves as: (a) initial data load on page open, (b) fallback if WebSocket drops, (c) metrics refresh independent of event stream.
- Auto-reconnect is implemented on the client (`setTimeout(connect, 3000)` on `ws.onclose`).

### Video Frame Streaming
Annotated JPEG frames are base64-encoded and sent as WebSocket messages (`{ type: "video_frame", data: "<base64>" }`). The dashboard renders them to a `<canvas>` element via an offscreen `Image` object. This approach avoids RTSP/HLS infrastructure while providing a "live camera" UX.

---

## ADR-009 — Frontend Framework and Build Tooling

**Status:** Accepted  
**Date:** 2026-04

### Decision
**React 19 + Vite 6 + TailwindCSS v4 + TypeScript 5.8**

### Rationale

| Choice | Reason |
|---|---|
| **React 19** | Concurrent rendering, stable `useCallback`/`useEffect` primitives, large ecosystem |
| **Vite** | Sub-second HMR, native ESM, integrates as Vite middleware inside Express (`createViteServer`) |
| **TailwindCSS v4** | Utility classes for layout; custom CSS variables for the design system (dark mode colors, glassmorphism) |
| **Recharts** | Declarative bar charts with responsive containers; first-class React integration |
| **Motion (Framer Motion)** | `AnimatePresence` for live event feed enter/exit animations; `motion.div` for KPI counter pulses |
| **TypeScript** | Strict typing on `EventRow`, `Metrics`, `FunnelData` interfaces prevents runtime shape mismatches |

### Vite + Express Integration
Vite runs as middleware inside the Express HTTP server in development:
```typescript
const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
app.use(vite.middlewares);
```
This means a single port (3000) serves the API, WebSocket, and the React SPA — no CORS configuration needed.

In production, `vite build` outputs to `dist/` and Express serves it statically. The server itself is bundled by `esbuild` into `dist/server.cjs`.

---

## ADR-010 — Dead Letter Queue for Failed Events

**Status:** Accepted  
**Date:** 2026-04

### Decision
**Local `failed_events.jsonl` file as DLQ** in development. Redis Streams recommended for production.

### Rationale
- The Python pipeline emits events in batches of 10 via `httpx`. If the HTTP POST fails (server down, timeout > 5s), events are appended as JSON Lines to `failed_events.jsonl`.
- This ensures **no data loss** during server restarts or network blips during a pipeline run.
- JSONL format allows the file to be replayed by `cat failed_events.jsonl | jq '...' | xargs curl ...` for recovery.
- In production, Redis Streams would replace the file DLQ, with a consumer group reading and committing to PostgreSQL with at-least-once delivery guarantees.
