import cv2
from ultralytics import YOLO
import supervision as sv
import numpy as np
from emit import create_event, emit_events
from tracker import VisitorSessionManager
import argparse
import time
import sys

def classify_staff(crop):
    """
    Mock classification for staff uniform.
    Checks if average color is blue (assuming blue uniform for staff).
    """
    if crop is None or crop.size == 0:
        return False
    avg_color_per_row = np.average(crop, axis=0)
    avg_color = np.average(avg_color_per_row, axis=0)
    # Ex: B > 100, R < 50, G < 50
    if len(avg_color) == 3 and avg_color[0] > 100 and avg_color[1] < 80 and avg_color[2] < 80:
        return True
    return False

def run_pipeline(video_path: str, store_id="STORE_001", camera_id="CAM_MAIN"):
    model = YOLO("yolov8n.pt") # Using nano for dev speed, YOLOv8s/m in prod
    tracker = sv.ByteTrack()
    
    # Store Layout / Polygon setup (Would be loaded from store_layout.json in PROD)
    entry_line = sv.LineZone(start=sv.Point(100, 500), end=sv.Point(900, 500))
    billing_zone = sv.PolygonZone(polygon=sv.Point.from_coordinates([[200, 200], [400, 200], [400, 400], [200, 400]]))
    
    session_manager = VisitorSessionManager()
    
    for result in model.track(source=video_path, stream=True, classes=[0]): 
        frame = result.orig_img
        current_time = time.time()
        
        detections = sv.Detections.from_ultralytics(result)
        detections = tracker.update_with_detections(detections)
        
        events_to_emit = []
        
        crossed_in, crossed_out = entry_line.trigger(detections)
        zone_mask = billing_zone.trigger(detections)
        queue_count = sum(zone_mask)
        
        for i, track_id in enumerate(detections.tracker_id):
            xyxy = detections.xyxy[i].astype(int)
            crop = frame[max(0, xyxy[1]):xyxy[3], max(0, xyxy[0]):xyxy[2]]
            
            track_state = session_manager.assign_visitor_id(track_id, crop=crop, current_time=current_time)
            visitor_id = track_state["visitor_id"]
            
            # Staff Classification
            is_staff = track_state.get("is_staff", False)
            if not is_staff and classify_staff(crop):
                 session_manager.active_tracks[track_id]["is_staff"] = True
                 is_staff = True

            conf = float(detections.confidence[i])
            active_zones = []
            
            # 1. Entry / Exit triggers
            if crossed_in[i]:
                seq = session_manager.get_next_seq(track_id)
                # If Re-entry, we emit REENTRY
                evt_type = "REENTRY" if track_state.get("is_reentry") else "ENTRY"
                events_to_emit.append(create_event(
                    store_id, camera_id, visitor_id, evt_type, 
                    confidence=conf, is_staff=is_staff, metadata={"session_seq": seq}
                ))
            
            # 2. Zone Checking
            if zone_mask[i]:
                active_zones.append("BILLING")
                
            zone_events = session_manager.update_zone(track_id, active_zones, current_time)
            for evt in zone_events:
                e_type, z_id, dwell = evt
                seq = session_manager.get_next_seq(track_id)
                meta = {"session_seq": seq}
                
                # Special BILLING Zone behavior
                if z_id == "BILLING":
                    if e_type == "ZONE_ENTER":
                        events_to_emit.append(create_event(store_id, camera_id, visitor_id, "BILLING_QUEUE_JOIN", zone_id=z_id, dwell_ms=dwell, confidence=conf, is_staff=is_staff, metadata={"session_seq": session_manager.get_next_seq(track_id), "queue_depth": queue_count}))
                    elif e_type == "ZONE_EXIT":
                        events_to_emit.append(create_event(store_id, camera_id, visitor_id, "BILLING_QUEUE_ABANDON", zone_id=z_id, dwell_ms=dwell, confidence=conf, is_staff=is_staff, metadata={"session_seq": session_manager.get_next_seq(track_id)}))
                
                events_to_emit.append(create_event(store_id, camera_id, visitor_id, e_type, zone_id=z_id, dwell_ms=dwell, confidence=conf, is_staff=is_staff, metadata=meta))

            # 3. Exit Trigger
            if crossed_out[i]:
                seq = session_manager.get_next_seq(track_id)
                events_to_emit.append(create_event(
                    store_id, camera_id, visitor_id, "EXIT", 
                    confidence=conf, is_staff=is_staff, metadata={"session_seq": seq}
                ))
                _, exit_events = session_manager.close_session(track_id, current_time)
                for evt in exit_events:
                    e_type, z_id, dwell = evt
                    events_to_emit.append(create_event(store_id, camera_id, visitor_id, e_type, zone_id=z_id, dwell_ms=dwell, confidence=conf, is_staff=is_staff, metadata={"session_seq": session_manager.get_next_seq(track_id)}))
                
        emit_events(events_to_emit)
        
    cv2.destroyAllWindows()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("video_path")
    args = parser.parse_args()
    print(f"Starting pipeline on {args.video_path}")
    run_pipeline(args.video_path)
    print("Pipeline finished.")
