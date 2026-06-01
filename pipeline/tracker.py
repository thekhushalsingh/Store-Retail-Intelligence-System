from collections import defaultdict
import uuid
import time
import cv2
import numpy as np

class VisitorSessionManager:
    def __init__(self):
        self.active_tracks = {} # track_id -> memory
        self.visitor_registry = [] # list of dicts with {"visitor_id": vid, "hist": hist, "last_seen_time": time}
        self.reentry_threshold = 0.6  # Bhattacharyya distance threshold for color histogram
        
    def _extract_color_hist(self, crop):
        if crop is None or crop.size == 0:
            return None
        hsv = cv2.cvtColor(crop, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [8, 8], [0, 180, 0, 256])
        cv2.normalize(hist, hist, alpha=0, beta=1, norm_type=cv2.NORM_MINMAX)
        return hist.flatten()

    def assign_visitor_id(self, track_id, crop=None, current_time=None):
        """
        Uses simple color histogram to compare embedding feature across cameras and sessions 
        to handle re-entry and cross-camera correlation.
        """
        if current_time is None:
            current_time = time.time()
            
        if track_id not in self.active_tracks:
            hist = self._extract_color_hist(crop)
            assigned_vid = None
            is_reentry = False
            
            if hist is not None:
                best_dist = float('inf')
                best_match = None
                for reg in self.visitor_registry:
                    # Match only if the user hasn't been active in this track
                    dist = cv2.compareHist(hist, reg["hist"], cv2.HISTCMP_BHATTACHARYYA)
                    if dist < best_dist:
                        best_dist = dist
                        best_match = reg
                
                if best_dist < self.reentry_threshold and best_match is not None:
                    # Re-entry detected
                    assigned_vid = best_match["visitor_id"]
                    is_reentry = True
                    # Update registry hist slightly or keep it
                    best_match["hist"] = hist
                    best_match["last_seen_time"] = current_time

            if assigned_vid is None:
                assigned_vid = f"VIS_{uuid.uuid4().hex[:8]}"
                if hist is not None:
                    self.visitor_registry.append({
                        "visitor_id": assigned_vid,
                        "hist": hist,
                        "last_seen_time": current_time
                    })

            self.active_tracks[track_id] = {
                "visitor_id": assigned_vid,
                "first_seen": current_time,
                "last_seen": current_time,
                "zones_state": {}, # zone_id -> {enter_time, last_dwell_emit}
                "seq": 0,
                "is_staff": False,
                "is_reentry": is_reentry
            }
        else:
            self.active_tracks[track_id]["last_seen"] = current_time

        return self.active_tracks[track_id]

    def get_next_seq(self, track_id):
        if track_id in self.active_tracks:
            self.active_tracks[track_id]["seq"] += 1
            return self.active_tracks[track_id]["seq"]
        return 0

    def update_zone(self, track_id, active_zones, current_time):
        """
        active_zones: list of zone_ids the track is currently in
        Returns a list of event tuples: (event_type, zone_id, dwell_duration)
        """
        if track_id not in self.active_tracks:
            return []
        
        events = []
        track_state = self.active_tracks[track_id]
        current_zones = track_state["zones_state"]
        
        # Check for ZONE_ENTER
        for z in active_zones:
            if z not in current_zones:
                current_zones[z] = {
                    "enter_time": current_time,
                    "last_dwell_emit": current_time
                }
                events.append(("ZONE_ENTER", z, 0))
            else:
                # Check for ZONE_DWELL (every 30s)
                time_in_zone = current_time - current_zones[z]["enter_time"]
                time_since_last_emit = current_time - current_zones[z]["last_dwell_emit"]
                
                if time_since_last_emit >= 30.0:
                    current_zones[z]["last_dwell_emit"] = current_time
                    events.append(("ZONE_DWELL", z, int(time_in_zone * 1000)))
        
        # Check for ZONE_EXIT
        zones_to_remove = []
        for z, state in current_zones.items():
            if z not in active_zones:
                dwell = int((current_time - state["enter_time"]) * 1000)
                events.append(("ZONE_EXIT", z, dwell))
                zones_to_remove.append(z)
                
        for z in zones_to_remove:
            del current_zones[z]
            
        return events

    def close_session(self, track_id, current_time):
        events = []
        if track_id in self.active_tracks:
            track_state = self.active_tracks[track_id]
            for z, state in track_state["zones_state"].items():
                dwell = int((current_time - state["enter_time"]) * 1000)
                events.append(("ZONE_EXIT", z, dwell))
            
            vid = track_state["visitor_id"]
            del self.active_tracks[track_id]
            return vid, events
        return None, []

