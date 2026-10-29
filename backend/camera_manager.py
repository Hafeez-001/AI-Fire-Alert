import cv2
import threading
import time
import os
import re
import uuid
from collections import deque
from datetime import datetime, timezone
import notification

from detection_policy import DetectionSettings, advance_persistence, validate_roi

# Ensure snapshots directory exists
SNAPSHOT_DIR = "snapshots"
if not os.path.exists(SNAPSHOT_DIR):
    os.makedirs(SNAPSHOT_DIR)

class Camera:
    def __init__(self, id, source, name="Camera", is_active=True, roi=None):
        self.id = id
        self.source = source
        self.name = name
        self.is_active = is_active
        self.lock = threading.Lock()
        self.running = True
        self.last_frame = None
        self.last_annotated_frame = None
        self.detection_persistence = {}
        self.detection_settings = None
        self.policy_lock = threading.Lock()
        self.roi = validate_roi(roi or [])
        self.event_cooldowns = {}
        self.frame_count = 0
        self.frames_processed = 0
        self.inference_ms = 0.0
        self.last_frame_at = None
        self.processing_fps = 0.0
        self.processed_frame_times = deque(maxlen=30)
        self.last_inference_error = None
        
        self.status = "connecting"  # connecting, connected, disconnected
        self.consecutive_failures = 0
        self.cap = None
        self.last_reconnect_attempt = 0
        
        # Start connection in a separate thread to avoid blocking startup
        threading.Thread(target=self._connect, daemon=True).start()

    def _connect(self):
        with self.lock:
            if not self.running or not self.is_active:
                self.status = "disconnected"
                return
            self.status = "connecting"
            if self.cap is not None:
                self.cap.release()
            
            # Check if source is integer (webcam index)
            try:
                src = int(self.source)
            except (TypeError, ValueError):
                src = self.source
                
            self.cap = cv2.VideoCapture(src)
            if self.cap.isOpened():
                self.status = "connected"
                self.consecutive_failures = 0
                print(f"[Camera {self.id}] Successfully connected to: {self.source}")
            else:
                self.status = "disconnected"
                print(f"[Camera {self.id}] Failed to connect to: {self.source}")

    def trigger_reconnect(self):
        """Attempts to reconnect if currently disconnected and cooldown has passed."""
        current_time = time.time()
        if (self.status == "disconnected" and 
            self.is_active and 
            self.running and 
            current_time - self.last_reconnect_attempt > 10):
            
            self.last_reconnect_attempt = current_time
            print(f"[Camera {self.id}] Asynchronously reconnecting...")
            threading.Thread(target=self._connect, daemon=True).start()

    def read(self):
        if not self.is_active or not self.running:
            return False, None
            
        with self.lock:
            if self.status != "connected" or self.cap is None or not self.cap.isOpened():
                return False, None
                
            success, frame = self.cap.read()
            if success:
                self.last_frame = frame
                self.consecutive_failures = 0
                return True, frame
            else:
                self.consecutive_failures += 1
                if self.consecutive_failures >= 5:
                    self.status = "disconnected"
                    print(f"[Camera {self.id}] Lost connection (5 consecutive failures)")
                return False, None

    def release(self):
        self.running = False
        with self.policy_lock:
            self.detection_persistence.clear()
        with self.lock:
            self.status = "disconnected"
            if self.cap is not None:
                self.cap.release()

class CameraManager:
    def __init__(self, detector):
        self.cameras = {}
        self.detector = detector
        self.running = True
        self.alert_callback = None
        
        # Load persisted cameras from database
        self.load_cameras_from_db()
        
        # Start background detection thread
        self.thread = threading.Thread(target=self._detection_loop, daemon=True)
        self.thread.start()

    def load_cameras_from_db(self):
        """Load all cameras from the database."""
        try:
            import database
            db_cams = database.get_all_db_cameras()
            for db_cam in db_cams:
                cam_id = db_cam["id"]
                name = db_cam["name"]
                source = db_cam["source"]
                is_active = db_cam["is_active"] == 1
                roi = validate_roi(db_cam.get("roi", []))
                
                if cam_id in self.cameras:
                    self.cameras[cam_id].name = name
                    self.cameras[cam_id].source = source
                    self.cameras[cam_id].is_active = is_active
                    self.cameras[cam_id].roi = roi
                else:
                    cam = Camera(cam_id, source, name, is_active, roi=roi)
                    self.cameras[cam_id] = cam
            print(f"Loaded {len(db_cams)} cameras from database.")
        except Exception as e:
            print(f"Error loading cameras from database: {e}")

    def add_camera(self, source, name="Camera"):
        """Add a new camera source to database and memory."""
        import database
        cam_id = database.add_db_camera(name, source, 1)
        cam = Camera(cam_id, source, name, True)
        self.cameras[cam_id] = cam
        return cam_id

    def remove_camera(self, camera_id):
        """Remove a camera."""
        import database
        if camera_id in self.cameras:
            self.cameras[camera_id].release()
            del self.cameras[camera_id]
            database.delete_db_camera(camera_id)
            return True
        return False

    def toggle_camera(self, camera_id, is_active):
        """Enable or disable a camera."""
        import database
        if camera_id in self.cameras:
            self.cameras[camera_id].is_active = is_active
            database.set_db_camera_status(camera_id, is_active)
            if not is_active:
                self.cameras[camera_id].release()
            else:
                self.cameras[camera_id].running = True
                self.cameras[camera_id].status = "connecting"
                threading.Thread(target=self.cameras[camera_id]._connect, daemon=True).start()
            return True
        return False

    def set_camera_roi(self, camera_id, points):
        """Persist a monitoring polygon and start a new confirmation sequence."""
        import database
        roi = validate_roi(points)
        cam = self.cameras.get(camera_id)
        if cam is None:
            return False
        with cam.policy_lock:
            if not database.set_db_camera_roi(camera_id, roi):
                return False
            cam.roi = roi
            cam.detection_persistence.clear()
        return True

    def shutdown(self):
        """Stop background processing and close all camera devices."""
        self.running = False
        for cam in list(self.cameras.values()):
            cam.release()
        if self.thread is not threading.current_thread():
            self.thread.join(timeout=3)

    def get_frame(self, camera_id):
        """Get the latest annotated frame for a camera."""
        if camera_id in self.cameras:
            cam = self.cameras[camera_id]
            if cam.last_annotated_frame is not None:
                return cam.last_annotated_frame
            elif cam.last_frame is not None:
                return cam.last_frame
        return None

    def _detection_loop(self):
        """Background loop to process frames from all cameras."""
        while self.running:
            for cam_id in list(self.cameras.keys()):
                cam = self.cameras.get(cam_id)
                if not cam or not cam.running or not cam.is_active:
                    continue

                try:
                    success, frame = cam.read()
                    if not success:
                        with cam.policy_lock:
                            cam.detection_persistence.clear()
                        cam.trigger_reconnect()
                        continue
                    cam.frame_count += 1
                    # Only inference frames contribute to alert persistence.
                    if cam.frame_count % 3 == 0:
                        self._process_camera_frame(cam, frame)
                except Exception as exc:
                    # A failing camera, model or event must not stop the other cameras.
                    with cam.policy_lock:
                        cam.detection_persistence.clear()
                    error = str(exc)
                    if cam.last_inference_error != error:
                        print(f"[Camera {cam.id}] Processing error: {error}")
                    cam.last_inference_error = error
            
            time.sleep(0.01)

    @staticmethod
    def _get_detection_settings():
        import database
        try:
            return DetectionSettings.from_mapping(database.get_all_settings())
        except Exception:
            return DetectionSettings()

    def _process_camera_frame(self, cam, frame):
        settings = self._get_detection_settings()
        confidence = settings.inference_confidence(self.detector.model_info()["classes"])
        started = time.perf_counter()
        try:
            annotated_frame, detections = self.detector.process_frame(
                frame, confidence=confidence, iou=settings.iou,
            )
        finally:
            cam.inference_ms = round((time.perf_counter() - started) * 1000, 2)
        cam.last_inference_error = None
        cam.last_annotated_frame = annotated_frame
        cam.frames_processed += 1
        cam.last_frame_at = datetime.now(timezone.utc).isoformat()
        cam.processed_frame_times.append(time.perf_counter())
        if len(cam.processed_frame_times) > 1:
            elapsed = cam.processed_frame_times[-1] - cam.processed_frame_times[0]
            cam.processing_fps = round((len(cam.processed_frame_times) - 1) / elapsed, 2) if elapsed > 0 else 0.0
        self._process_detections(cam, detections, annotated_frame, settings=settings)

    def _process_detections(self, cam, detections, annotated_frame, settings=None):
        settings = settings or self._get_detection_settings()
        with cam.policy_lock:
            # Confirmation frames must all satisfy the same detection policy.
            if getattr(cam, "detection_settings", None) != settings:
                cam.detection_persistence.clear()
                cam.detection_settings = settings
            confirmed = advance_persistence(
                cam.detection_persistence, detections, settings,
                roi=cam.roi, frame_shape=annotated_frame.shape,
            )
            current_time = time.monotonic()
            for cls_name, detection in confirmed.items():
                last_time = cam.event_cooldowns.get(cls_name)
                if last_time is None or current_time - last_time >= settings.cooldown_seconds:
                    self._save_event(cam, cls_name, detection["confidence"], annotated_frame)
                    cam.event_cooldowns[cls_name] = current_time

    def _save_event(self, cam, cls_name, conf, frame):
        # Save Snapshot
        timestamp_str = time.strftime("%Y%m%d_%H%M%S")
        safe_class = re.sub(r"[^a-z0-9_-]", "_", cls_name.lower())
        filename = f"event_{timestamp_str}_{cam.id}_{safe_class}_{uuid.uuid4().hex[:8]}.jpg"
        filepath = os.path.join(SNAPSHOT_DIR, filename)
        
        if not cv2.imwrite(filepath, frame):
            raise OSError("Could not save the event snapshot")
        
        # Database
        snapshot_url = f"/snapshots/{filename}"
        import database
        event_id, timestamp = database.add_event(
            cls_name, conf, snapshot_url, camera_id=cam.id, camera_name=cam.name,
        )
        
        print(f"[Cam {cam.id}] Detected {cls_name} ({conf:.2f})")
        
        # Trigger WebSocket callback if registered
        if self.alert_callback:
            try:
                self.alert_callback({
                    "id": event_id,
                    "timestamp": timestamp,
                    "type": cls_name,
                    "confidence": conf,
                    "snapshot": snapshot_url,
                    "camera_id": cam.id,
                    "camera_name": cam.name
                })
            except Exception as e:
                print(f"Error in alert callback: {e}")
        
        # Notifications
        threading.Thread(target=notification.trigger_notifications, 
                       args=(cls_name, conf, filepath), daemon=True).start()
