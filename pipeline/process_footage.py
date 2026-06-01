"""
Retail Store Intelligence — Real-Time CCTV Processing Pipeline
==============================================================

Processes actual CCTV footage using YOLOv8 for person detection and
ByteTrack for multi-object tracking. Emits structured events to the
Express API for live dashboard visualization.

Usage:
    python pipeline/process_footage.py "C:/path/to/video.mp4"
    python pipeline/process_footage.py "C:/path/to/folder/" --all
    python pipeline/process_footage.py "C:/path/to/CAM 1.mp4" --store STORE_001 --show

Features:
    - YOLOv8 person detection (class 0)
    - ByteTrack multi-object tracking
    - Adaptive zone detection based on frame geometry
    - Entry/Exit line crossing detection
    - Zone dwell time tracking
    - Staff classification (color histogram heuristic)
    - Visitor re-identification across sessions
    - Real-time event emission to HTTP API
    - Optional live preview window (--show)
"""

import cv2
import numpy as np
import time
import uuid
import json
import sys
import os
import argparse
import glob
from datetime import datetime, timezone
from collections import defaultdict
from pathlib import Path

try:
    import httpx
    import base64
except ImportError:
    httpx = None
    print("[WARN] httpx not installed. Events will be logged to console only.")

try:
    from ultralytics import YOLO
    import supervision as sv
except ImportError:
    print("[ERROR] Missing dependencies. Run: pip install ultralytics supervision opencv-python numpy httpx")
    sys.exit(1)

# ── Configuration ─────────────────────────────────────────

API_URL = os.getenv("API_URL", "http://localhost:3000/api/events/ingest")
DEFAULT_STORE = "STORE_001"
EMIT_BATCH_SIZE = 10          # Send events in batches
CONFIDENCE_THRESHOLD = 0.35   # Min detection confidence
DWELL_EMIT_INTERVAL = 15.0    # Seconds between dwell event emissions
STAFF_COLOR_THRESHOLD = 0.6   # Bhattacharyya distance for staff detection
REENTRY_THRESHOLD = 0.55      # Histogram similarity for re-identification


# ── Event Builder ─────────────────────────────────────────

def create_event(store_id, camera_id, visitor_id, event_type,
                 zone_id=None, dwell_ms=0, is_staff=False,
                 confidence=1.0, metadata=None):
    return {
        "event_id": str(uuid.uuid4()),
        "store_id": store_id,
        "camera_id": camera_id,
        "visitor_id": visitor_id,
        "event_type": event_type,
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "zone_id": zone_id,
        "dwell_ms": int(dwell_ms),
        "is_staff": is_staff,
        "confidence": round(confidence, 3),
        "metadata": metadata or {}
    }


def emit_events(events, silent=False):
    """Send events to the API. Falls back to console logging."""
    if not events:
        return

    if httpx is not None:
        try:
            response = httpx.post(API_URL, json={"events": events}, timeout=5.0)
            if response.status_code == 200:
                if not silent:
                    print(f"  ✓ Emitted {len(events)} events")
            else:
                print(f"  ✗ Ingest failed: {response.status_code}")
        except Exception as e:
            print(f"  ✗ Emit error: {e}")
            # Write to fallback file
            with open("failed_events.jsonl", "a") as f:
                for ev in events:
                    f.write(json.dumps(ev) + "\n")
    else:
        for ev in events:
            print(f"  [EVENT] {ev['event_type']:20s} | {ev['visitor_id']} | zone={ev.get('zone_id', '-')}")

def emit_frame(camera_id, frame_bgr):
    """Encodes a frame to JPEG and sends it to the server."""
    if httpx is None:
        return
    try:
        # Resize to max 640px width to keep payload small
        h, w = frame_bgr.shape[:2]
        if w > 640:
            scale = 640 / w
            frame_bgr = cv2.resize(frame_bgr, (640, int(h * scale)))
            
        _, buffer = cv2.imencode('.jpg', frame_bgr, [cv2.IMWRITE_JPEG_QUALITY, 70])
        jpg_as_text = base64.b64encode(buffer).decode('utf-8')
        
        # We send to the /api/video/frame endpoint
        url = API_URL.replace("/api/events/ingest", "/api/video/frame")
        httpx.post(url, json={"camera_id": camera_id, "frame": jpg_as_text}, timeout=1.0)
    except Exception as e:
        pass # Ignore frame drop errors


# ── Visitor Session Manager ───────────────────────────────

class SessionManager:
    """Tracks active visitors, assigns IDs, detects re-entry via color histograms."""

    def __init__(self):
        self.active_tracks = {}    # track_id -> state dict
        self.visitor_registry = [] # for re-identification
        self.seq_counters = defaultdict(int)

    def _color_histogram(self, crop):
        if crop is None or crop.size == 0:
            return None
        try:
            hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
            hist = cv2.calcHist([hsv], [0, 1], None, [8, 8], [0, 180, 0, 256])
            cv2.normalize(hist, hist, 0, 1, cv2.NORM_MINMAX)
            return hist.flatten()
        except:
            return None

    def _is_staff(self, crop):
        """Heuristic: staff often wear uniform (dominant single color)."""
        if crop is None or crop.size == 0:
            return False
        try:
            hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
            # Check if saturation is low (uniform/dark clothing)
            avg_sat = np.mean(hsv[:, :, 1])
            avg_val = np.mean(hsv[:, :, 2])
            # Staff heuristic: very dark or very uniform clothing
            if avg_sat < 40 and avg_val < 80:
                return True
            return False
        except:
            return False

    def get_or_create(self, track_id, crop, current_time):
        """Assign a visitor ID to a track, with re-identification."""
        if track_id in self.active_tracks:
            self.active_tracks[track_id]["last_seen"] = current_time
            return self.active_tracks[track_id]

        # New track — try to re-identify
        hist = self._color_histogram(crop)
        assigned_vid = None
        is_reentry = False

        if hist is not None:
            best_dist = float('inf')
            best_match = None
            for reg in self.visitor_registry:
                dist = cv2.compareHist(
                    hist.reshape(8, 8).astype(np.float32),
                    reg["hist"].reshape(8, 8).astype(np.float32),
                    cv2.HISTCMP_BHATTACHARYYA
                )
                if dist < best_dist:
                    best_dist = dist
                    best_match = reg

            if best_dist < REENTRY_THRESHOLD and best_match is not None:
                assigned_vid = best_match["visitor_id"]
                is_reentry = True
                best_match["hist"] = hist
                best_match["last_seen"] = current_time

        if assigned_vid is None:
            assigned_vid = f"VIS_{uuid.uuid4().hex[:8]}"
            if hist is not None:
                self.visitor_registry.append({
                    "visitor_id": assigned_vid,
                    "hist": hist,
                    "last_seen": current_time,
                })

        is_staff = self._is_staff(crop)

        self.active_tracks[track_id] = {
            "visitor_id": assigned_vid,
            "first_seen": current_time,
            "last_seen": current_time,
            "is_staff": is_staff,
            "is_reentry": is_reentry,
            "zones": {},          # zone_id -> {"enter_time", "last_dwell_emit"}
            "entered": False,
            "exited": False,
        }
        return self.active_tracks[track_id]

    def next_seq(self, track_id):
        self.seq_counters[track_id] += 1
        return self.seq_counters[track_id]

    def close_track(self, track_id, current_time):
        """Close a track and return pending zone exit events."""
        events = []
        if track_id in self.active_tracks:
            state = self.active_tracks[track_id]
            for z_id, z_state in state["zones"].items():
                dwell = (current_time - z_state["enter_time"]) * 1000
                events.append(("ZONE_EXIT", z_id, int(dwell)))
            del self.active_tracks[track_id]
        return events

    def cleanup_stale(self, current_time, timeout=10.0):
        """Remove tracks not seen for `timeout` seconds."""
        stale = [tid for tid, s in self.active_tracks.items()
                 if current_time - s["last_seen"] > timeout]
        exit_events = {}
        for tid in stale:
            exit_events[tid] = self.close_track(tid, current_time)
        return exit_events


# ── Adaptive Zone Setup ───────────────────────────────────

def create_zones(frame_w, frame_h):
    """
    Create adaptive zones based on frame dimensions.
    Divides the store into logical zones based on typical retail layouts.
    """
    # Entry line: horizontal line at the bottom third
    entry_y = int(frame_h * 0.75)
    entry_line = sv.LineZone(
        start=sv.Point(int(frame_w * 0.1), entry_y),
        end=sv.Point(int(frame_w * 0.9), entry_y)
    )

    # Define store zones as polygons covering different areas
    zones = {}

    # Left zone — "SKINCARE"
    zones["SKINCARE"] = sv.PolygonZone(
        polygon=np.array([
            [0, 0],
            [int(frame_w * 0.33), 0],
            [int(frame_w * 0.33), int(frame_h * 0.65)],
            [0, int(frame_h * 0.65)]
        ], dtype=np.int32)
    )

    # Center zone — "FRAGRANCE"
    zones["FRAGRANCE"] = sv.PolygonZone(
        polygon=np.array([
            [int(frame_w * 0.33), 0],
            [int(frame_w * 0.66), 0],
            [int(frame_w * 0.66), int(frame_h * 0.65)],
            [int(frame_w * 0.33), int(frame_h * 0.65)]
        ], dtype=np.int32)
    )

    # Right zone — "MAKEUP"
    zones["MAKEUP"] = sv.PolygonZone(
        polygon=np.array([
            [int(frame_w * 0.66), 0],
            [frame_w, 0],
            [frame_w, int(frame_h * 0.65)],
            [int(frame_w * 0.66), int(frame_h * 0.65)]
        ], dtype=np.int32)
    )

    # Billing zone — bottom-right corner
    zones["BILLING"] = sv.PolygonZone(
        polygon=np.array([
            [int(frame_w * 0.65), int(frame_h * 0.65)],
            [frame_w, int(frame_h * 0.65)],
            [frame_w, int(frame_h * 0.95)],
            [int(frame_w * 0.65), int(frame_h * 0.95)]
        ], dtype=np.int32)
    )

    return entry_line, zones


# ── Main Pipeline ─────────────────────────────────────────

def process_video(video_path, store_id, camera_id, show_preview=False):
    """Process a single video file through the detection pipeline."""

    print(f"\n{'='*60}")
    print(f"  Processing: {os.path.basename(video_path)}")
    print(f"  Store: {store_id} | Camera: {camera_id}")
    print(f"  API: {API_URL}")
    print(f"{'='*60}\n")

    # Load YOLO model
    print("  Loading YOLOv8 model...")
    model = YOLO("yolov8n.pt")  # nano model for speed
    print("  ✓ Model loaded")

    # Open video
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        print(f"  ✗ Failed to open video: {video_path}")
        return

    frame_w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    frame_h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    total_frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    fps = cap.get(cv2.CAP_PROP_FPS) or 30

    print(f"  Resolution: {frame_w}x{frame_h} | FPS: {fps:.1f} | Frames: {total_frames}")

    # Setup tracker and zones
    tracker = sv.ByteTrack(
        track_activation_threshold=CONFIDENCE_THRESHOLD,
        lost_track_buffer=30,
        minimum_matching_threshold=0.8,
        frame_rate=int(fps)
    )
    entry_line, zones = create_zones(frame_w, frame_h)
    session_mgr = SessionManager()

    # Annotation setup (for streaming/preview)
    box_annotator = sv.BoxAnnotator(thickness=2)
    label_annotator = sv.LabelAnnotator(text_thickness=1, text_scale=0.4)

    # Processing state
    event_buffer = []
    frame_count = 0
    total_events = 0
    total_visitors = set()
    start_time = time.time()
    queue_depth = 0

    print(f"  Processing frames...\n")

    # Process every Nth frame for speed (skip if FPS is high)
    frame_skip = max(1, int(fps / 10))  # Process ~10 frames/sec

    while True:
        ret, frame = cap.read()
        if not ret:
            break

        frame_count += 1
        if frame_count % frame_skip != 0:
            continue

        current_time = time.time()
        
        # We'll need a copy for annotation if we're streaming or showing preview
        annotated = frame.copy()

        # ── Detect persons ──
        results = model(frame, classes=[0], conf=CONFIDENCE_THRESHOLD, verbose=False)

        if len(results) == 0 or results[0].boxes is None:
            continue

        detections = sv.Detections.from_ultralytics(results[0])
        detections = tracker.update_with_detections(detections)

        if detections.tracker_id is None or len(detections.tracker_id) == 0:
            continue

        # ── Check line crossings ──
        crossed_in, crossed_out = entry_line.trigger(detections)

        # ── Check zone occupancy ──
        zone_masks = {}
        for zone_name, zone_poly in zones.items():
            zone_masks[zone_name] = zone_poly.trigger(detections)

        # Count billing zone occupants
        if "BILLING" in zone_masks:
            queue_depth = int(sum(zone_masks["BILLING"]))

        # ── Process each tracked person ──
        for i, track_id in enumerate(detections.tracker_id):
            if track_id is None:
                continue

            xyxy = detections.xyxy[i].astype(int)
            crop = frame[max(0, xyxy[1]):xyxy[3], max(0, xyxy[0]):xyxy[2]]
            conf = float(detections.confidence[i])

            state = session_mgr.get_or_create(track_id, crop, current_time)
            vid = state["visitor_id"]
            is_staff = state["is_staff"]
            total_visitors.add(vid)

            # Entry detection
            if crossed_in[i] and not state.get("entered"):
                state["entered"] = True
                evt_type = "REENTRY" if state["is_reentry"] else "ENTRY"
                event_buffer.append(create_event(
                    store_id, camera_id, vid, evt_type,
                    confidence=conf, is_staff=is_staff,
                    metadata={"session_seq": session_mgr.next_seq(track_id)}
                ))

            # Zone enter/dwell/exit
            active_zones = set()
            for zone_name, mask in zone_masks.items():
                if mask[i]:
                    active_zones.add(zone_name)

            # Check new zone entries
            for z in active_zones:
                if z not in state["zones"]:
                    state["zones"][z] = {
                        "enter_time": current_time,
                        "last_dwell_emit": current_time
                    }
                    event_buffer.append(create_event(
                        store_id, camera_id, vid, "ZONE_ENTER",
                        zone_id=z, confidence=conf, is_staff=is_staff,
                        metadata={"session_seq": session_mgr.next_seq(track_id)}
                    ))

                    # Special: billing queue join
                    if z == "BILLING":
                        event_buffer.append(create_event(
                            store_id, camera_id, vid, "BILLING_QUEUE_JOIN",
                            zone_id="BILLING", confidence=conf, is_staff=is_staff,
                            metadata={
                                "session_seq": session_mgr.next_seq(track_id),
                                "queue_depth": queue_depth
                            }
                        ))
                else:
                    # Periodic dwell emission
                    z_state = state["zones"][z]
                    elapsed = current_time - z_state["last_dwell_emit"]
                    if elapsed >= DWELL_EMIT_INTERVAL:
                        dwell_ms = (current_time - z_state["enter_time"]) * 1000
                        z_state["last_dwell_emit"] = current_time
                        event_buffer.append(create_event(
                            store_id, camera_id, vid, "ZONE_DWELL",
                            zone_id=z, dwell_ms=int(dwell_ms),
                            confidence=conf, is_staff=is_staff,
                            metadata={"session_seq": session_mgr.next_seq(track_id)}
                        ))

            # Zone exits
            exited_zones = [z for z in list(state["zones"].keys()) if z not in active_zones]
            for z in exited_zones:
                dwell_ms = (current_time - state["zones"][z]["enter_time"]) * 1000
                event_buffer.append(create_event(
                    store_id, camera_id, vid, "ZONE_EXIT",
                    zone_id=z, dwell_ms=int(dwell_ms),
                    confidence=conf, is_staff=is_staff,
                    metadata={"session_seq": session_mgr.next_seq(track_id)}
                ))
                del state["zones"][z]

            # Exit detection
            if crossed_out[i] and not state.get("exited"):
                state["exited"] = True
                # Close all remaining zones
                zone_exits = session_mgr.close_track(track_id, current_time)
                for evt_type, z_id, dwell in zone_exits:
                    event_buffer.append(create_event(
                        store_id, camera_id, vid, evt_type,
                        zone_id=z_id, dwell_ms=dwell,
                        confidence=conf, is_staff=is_staff,
                        metadata={"session_seq": session_mgr.next_seq(track_id)}
                    ))
                event_buffer.append(create_event(
                    store_id, camera_id, vid, "EXIT",
                    confidence=conf, is_staff=is_staff,
                    metadata={"session_seq": session_mgr.next_seq(track_id)}
                ))

        # ── Cleanup stale tracks ──
        stale_exits = session_mgr.cleanup_stale(current_time, timeout=5.0)
        for tid, zone_evts in stale_exits.items():
            if tid in session_mgr.seq_counters:
                # This track disappeared — emit exit
                vid = f"VIS_{uuid.uuid4().hex[:8]}"  # best effort
                for evt_type, z_id, dwell in zone_evts:
                    event_buffer.append(create_event(
                        store_id, camera_id, vid, evt_type,
                        zone_id=z_id, dwell_ms=dwell,
                        metadata={"session_seq": 0}
                    ))

        # ── Emit buffered events ──
        if len(event_buffer) >= EMIT_BATCH_SIZE:
            emit_events(event_buffer, silent=True)
            total_events += len(event_buffer)
            event_buffer = []

        # ── Progress ──
        if frame_count % (int(fps) * 5) == 0:  # Print every ~5 seconds of video
            elapsed = time.time() - start_time
            progress = (frame_count / total_frames * 100) if total_frames > 0 else 0
            print(
                f"  [{progress:5.1f}%] "
                f"frame {frame_count}/{total_frames} | "
                f"👤 {len(total_visitors)} visitors | "
                f"📡 {total_events} events | "
                f"⏱️ {elapsed:.0f}s elapsed"
            )

        # ── Annotate & Preview/Stream ──
        
        labels = []
        for i, track_id in enumerate(detections.tracker_id):
            if track_id is not None and track_id in session_mgr.active_tracks:
                s = session_mgr.active_tracks[track_id]
                label = f"{s['visitor_id']}"
                if s["is_staff"]:
                    label += " [STAFF]"
                labels.append(label)
            else:
                labels.append(f"ID:{track_id}")

        annotated = box_annotator.annotate(annotated, detections)
        annotated = label_annotator.annotate(annotated, detections, labels=labels)

        # Draw entry line
        cv2.line(annotated,
                 (int(frame_w * 0.1), int(frame_h * 0.75)),
                 (int(frame_w * 0.9), int(frame_h * 0.75)),
                 (0, 255, 0), 2)
        cv2.putText(annotated, "ENTRY LINE", (int(frame_w * 0.1), int(frame_h * 0.75) - 10),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)

        # Stream frame to dashboard (approx 5-10 FPS)
        if frame_count % (frame_skip * 2) == 0:
            emit_frame(camera_id, annotated)

        # ── Preview Window ──
        if show_preview:
            # Resize for display
            display_w = min(1280, frame_w)
            scale = display_w / frame_w
            display = cv2.resize(annotated, (display_w, int(frame_h * scale)))

            cv2.imshow(f"Pipeline: {camera_id}", display)
            if cv2.waitKey(1) & 0xFF == ord('q'):
                print("\n  ⏹ Preview closed by user")
                break

    # ── Flush remaining events ──
    if event_buffer:
        emit_events(event_buffer, silent=True)
        total_events += len(event_buffer)

    cap.release()
    if show_preview:
        cv2.destroyAllWindows()

    elapsed = time.time() - start_time
    print(f"\n  ✓ Finished: {os.path.basename(video_path)}")
    print(f"    Frames processed: {frame_count}")
    print(f"    Unique visitors:  {len(total_visitors)}")
    print(f"    Events emitted:   {total_events}")
    print(f"    Time elapsed:     {elapsed:.1f}s")
    print(f"    Processing FPS:   {frame_count / elapsed:.1f}")

    return {
        "frames": frame_count,
        "visitors": len(total_visitors),
        "events": total_events,
        "elapsed": elapsed,
    }


# ── Multi-Camera Runner ───────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Process CCTV footage for retail analytics")
    parser.add_argument("path", help="Path to video file or directory")
    parser.add_argument("--store", default=DEFAULT_STORE, help="Store ID")
    parser.add_argument("--show", action="store_true", help="Show live preview window")
    parser.add_argument("--all", action="store_true", help="Process all videos in directory")
    args = parser.parse_args()

    video_path = args.path

    print("\n╔══════════════════════════════════════════════════════════╗")
    print("║   🏬 Retail Intelligence — CCTV Processing Pipeline     ║")
    print("╠══════════════════════════════════════════════════════════╣")
    print(f"║  Store:    {args.store:<46}║")
    print(f"║  API:      {API_URL:<46}║")
    print(f"║  Preview:  {'ON' if args.show else 'OFF':<46}║")
    print("╚══════════════════════════════════════════════════════════╝")

    videos = []

    if os.path.isdir(video_path):
        # Process all video files in directory
        for ext in ["*.mp4", "*.avi", "*.mov", "*.mkv"]:
            videos.extend(glob.glob(os.path.join(video_path, ext)))
        videos.sort()
    elif os.path.isfile(video_path):
        videos = [video_path]
    else:
        print(f"\n  ✗ Path not found: {video_path}")
        sys.exit(1)

    if not videos:
        print(f"\n  ✗ No video files found in: {video_path}")
        sys.exit(1)

    print(f"\n  Found {len(videos)} video(s):")
    for v in videos:
        size_mb = os.path.getsize(v) / (1024 * 1024)
        print(f"    • {os.path.basename(v)} ({size_mb:.1f} MB)")

    # Process each video
    total_stats = {"frames": 0, "visitors": 0, "events": 0, "elapsed": 0}

    for idx, vpath in enumerate(videos):
        cam_name = Path(vpath).stem.replace(" ", "_").upper()
        camera_id = f"CAM_{cam_name}" if not cam_name.startswith("CAM") else cam_name

        stats = process_video(
            vpath,
            store_id=args.store,
            camera_id=camera_id,
            show_preview=args.show,
        )

        if stats:
            for k in total_stats:
                total_stats[k] += stats.get(k, 0)

    # Summary
    print(f"\n{'='*60}")
    print(f"  🏁 ALL CAMERAS PROCESSED")
    print(f"{'='*60}")
    print(f"  Videos:       {len(videos)}")
    print(f"  Total frames: {total_stats['frames']}")
    print(f"  Visitors:     {total_stats['visitors']}")
    print(f"  Events:       {total_stats['events']}")
    print(f"  Total time:   {total_stats['elapsed']:.1f}s")
    print(f"\n  Dashboard: http://localhost:3000")
    print()


if __name__ == "__main__":
    main()
