import csv
from concurrent.futures import ThreadPoolExecutor
import importlib.util
from io import BytesIO, StringIO
import os
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch

import cv2
import numpy as np
from PIL import Image
from fastapi.testclient import TestClient

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))
import database


class FakeDetector:
    def __init__(self):
        self.calls = []

    def model_info(self):
        return {"classes": ["fire"], "smoke_supported": False, "model_name": "best.pt"}

    def process_frame(self, frame, confidence=None, iou=None):
        self.calls.append((confidence, iou))
        return frame.copy(), [{"class": "fire", "confidence": 0.91, "bbox": [1, 2, 10, 11]}]


class FakeCameraManager:
    def __init__(self, detector):
        self.cameras = {1: SimpleNamespace(id=1, name="Camera 1", source="0", is_active=True,
                                          status="connected", roi=[], frames_processed=12,
                                          inference_ms=25.5, processing_fps=3.0, last_frame_at=None)}
        self.alert_callback = None
        self.stopped = False

    def set_camera_roi(self, camera_id, points):
        if camera_id not in self.cameras:
            return False
        self.cameras[camera_id].roi = points
        return database.set_db_camera_roi(camera_id, points)

    def shutdown(self):
        self.stopped = True


class LegacyMigrationTests(unittest.TestCase):
    def test_legacy_events_and_cameras_survive_repeatable_migration(self):
        with tempfile.TemporaryDirectory() as directory:
            db_path = str(Path(directory) / "legacy.db")
            with sqlite3.connect(db_path) as conn:
                conn.executescript("""
                    CREATE TABLE events (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
                        type TEXT NOT NULL, confidence REAL NOT NULL, snapshot_path TEXT);
                    INSERT INTO events VALUES (7, '2026-10-10 12:30:00', 'Fire', .88, '/snapshots/old.jpg');
                    CREATE TABLE cameras (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
                        source TEXT NOT NULL, is_active INTEGER DEFAULT 1, created_at TEXT NOT NULL);
                    INSERT INTO cameras VALUES (3, 'Warehouse', 'rtsp://example/camera', 0, '2026-01-01');
                """)
            with patch.object(database, "DB_NAME", db_path):
                database.init_db()
                database.init_db()
                event = database.get_all_events(event_type="fire")[0]
                self.assertEqual(event["id"], 7)
                self.assertEqual(event["type"], "fire")
                self.assertEqual(event["snapshot_path"], "/snapshots/old.jpg")
                self.assertIsNone(event["camera_id"])
                camera = database.get_all_db_cameras()[0]
                self.assertEqual((camera["id"], camera["name"], camera["is_active"], camera["roi"]),
                                 (3, "Warehouse", 0, []))
                database.add_event("Smoke", .92, camera_id=3, camera_name="Warehouse")
                database.delete_db_camera(3)
                self.assertEqual(database.get_all_events()[0]["camera_name"], "Warehouse")


class APIFeatureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.directory = tempfile.TemporaryDirectory()
        cls.old_cwd = os.getcwd()
        cls.old_database = database.DB_NAME
        os.chdir(cls.directory.name)
        Path("backend").mkdir()
        Path("backend/best.pt").symlink_to(BACKEND / "best.pt")
        database.DB_NAME = str(Path(cls.directory.name) / "api.db")
        detection = ModuleType("detection")
        detection.FireDetector = FakeDetector
        camera = ModuleType("camera_manager")
        camera.CameraManager = FakeCameraManager
        spec = importlib.util.spec_from_file_location("feature_api_under_test", BACKEND / "main.py")
        cls.api = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = cls.api
        with patch.dict(sys.modules, {"detection": detection, "camera_manager": camera}):
            spec.loader.exec_module(cls.api)
        cls.client_context = TestClient(cls.api.app)
        cls.client = cls.client_context.__enter__()

    @classmethod
    def tearDownClass(cls):
        cls.client_context.__exit__(None, None, None)
        database.DB_NAME = cls.old_database
        os.chdir(cls.old_cwd)
        cls.directory.cleanup()
        sys.modules.pop("feature_api_under_test", None)

    def setUp(self):
        with sqlite3.connect(database.DB_NAME) as conn:
            conn.execute("DELETE FROM events")
            conn.execute("DELETE FROM settings")
        database.init_db()
        database.set_db_camera_roi(1, [])
        self.api.camera_manager.cameras[1].roi = []
        self.api.detector.calls.clear()

    def seed_event(self, event_type, confidence, timestamp, camera_id=None, camera_name=None):
        event_id, _ = database.add_event(event_type, confidence, "/snapshots/example.jpg",
                                         camera_id=camera_id, camera_name=camera_name)
        with sqlite3.connect(database.DB_NAME) as conn:
            conn.execute("UPDATE events SET timestamp = ? WHERE id = ?", (timestamp, event_id))
        return event_id

    def test_history_filters_pagination_and_inclusive_dates(self):
        self.seed_event("fire", .99, "2026-10-09 23:59:59", 1, "Camera 1")
        first = self.seed_event("Fire", .8, "2026-10-10 00:00:00", 1, "Camera 1")
        last = self.seed_event("fire", .95, "2026-10-10 23:59:59", 1, "Camera 1")
        self.seed_event("smoke", .98, "2026-10-10 14:00:00", 2, "Camera 2")
        self.seed_event("fire", .3, "2026-10-10 12:00:00", 1, "Camera 1")
        # Simulate a historical row whose class was stored with title case.
        with sqlite3.connect(database.DB_NAME) as conn:
            conn.execute("UPDATE events SET type = 'Fire' WHERE id = ?", (first,))
        filters = {"event_type": "fire", "camera_id": 1, "min_confidence": .7,
                   "start_date": "2026-10-10", "end_date": "2026-10-10", "limit": 1}
        response = self.client.get("/history", params=filters)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual((body["total"], body["limit"], body["offset"]), (2, 1, 0))
        self.assertEqual(body["events"][0]["id"], last)
        filters["offset"] = 1
        body = self.client.get("/history", params=filters).json()
        self.assertEqual(body["events"][0]["id"], first)
        self.assertEqual(body["events"][0]["type"], "fire")
        self.assertEqual(body["events"][0]["camera_name"], "Camera 1")

    def test_invalid_history_filters_are_rejected(self):
        for query in ({"limit": 0}, {"limit": 101}, {"offset": -1}, {"event_type": "person"},
                      {"start_date": "2026-2-01"}, {"end_date": "2026-02-30"},
                      {"start_date": "2026-10-11", "end_date": "2026-10-10"},
                      {"min_confidence": "nan"}, {"min_confidence": 1.1}):
            with self.subTest(query=query):
                self.assertEqual(self.client.get("/history", params=query).status_code, 422)

    def test_csv_exports_all_matches_and_neutralizes_formulas(self):
        for index in range(105):
            self.seed_event("Fire", .88, "2026-10-10 23:59:59", 1, " \t=HYPERLINK(\"bad\")")
        self.seed_event("smoke", .9, "2026-10-10 20:00:00", 2, "Other")
        response = self.client.get("/history/export.csv", params={"event_type": "fire", "camera_id": 1})
        self.assertEqual(response.status_code, 200)
        self.assertIn("fire-guard-history.csv", response.headers["content-disposition"])
        rows = list(csv.DictReader(StringIO(response.text)))
        self.assertEqual(len(rows), 105)
        self.assertEqual(rows[0]["type"], "fire")
        self.assertTrue(rows[0]["camera_name"].startswith("'"))
        self.assertEqual(self.client.get("/history/export.csv", params={"start_date": "invalid"}).status_code, 422)

    def test_alert_provenance_and_daily_stats(self):
        today = self.api.date.today().isoformat()
        self.seed_event("Fire", .9, today + " 08:00:00", 1, "Original name")
        self.seed_event("fire", .7, "2000-01-01 00:00:00")
        alert = self.client.get("/alerts").json()["alerts"][1]
        self.assertEqual((alert["type"], alert["camera_id"], alert["camera_name"]),
                         ("fire", 1, "Original name"))
        stats = self.client.get("/stats").json()
        self.assertIsInstance(stats["stats"], list)
        self.assertEqual(stats["today_count"], 1)

    def test_export_iterator_can_move_between_streaming_workers(self):
        self.seed_event("fire", .9, "2026-10-10 00:00:00")
        self.seed_event("smoke", .8, "2026-10-10 00:00:01")
        events = database.iter_events(batch_size=1)
        # ASGI streaming advances a synchronous iterator in a worker pool.
        with ThreadPoolExecutor(max_workers=1) as first, ThreadPoolExecutor(max_workers=1) as second:
            self.assertEqual(first.submit(next, events).result()["type"], "smoke")
            self.assertEqual(second.submit(next, events).result()["type"], "fire")
            first.submit(events.close).result()

    def test_open_export_does_not_block_new_camera_events(self):
        with sqlite3.connect(database.DB_NAME) as conn:
            conn.executemany("INSERT INTO events (timestamp, type, confidence) VALUES (?, ?, ?)",
                             [("2026-10-10 00:00:00", "fire", .9)] * 250)
        events = database.iter_events(batch_size=200)
        first_event = next(events)
        executor = ThreadPoolExecutor(max_workers=1)
        try:
            # The cursor still holds a read snapshot with rows left to fetch.
            # A live camera must be able to commit before the export completes.
            pending = executor.submit(database.add_event, "smoke", .85, camera_id=1, camera_name="Live camera")
            new_id, _ = pending.result(timeout=2)
            self.assertGreater(new_id, first_event["id"])
            self.assertEqual(len(list(events)) + 1, 250)
            self.assertEqual(database.count_events(), 251)
        finally:
            events.close()
            executor.shutdown(wait=True)

    def test_roi_is_persisted_cleared_and_validated(self):
        points = [[.1, .1], [.9, .1], [.5, .9]]
        response = self.client.patch("/cameras/1/roi", json={"points": points})
        self.assertEqual(response.status_code, 200)
        camera = self.client.get("/cameras").json()["cameras"][0]
        self.assertEqual(camera["roi"], points)
        self.assertEqual(camera["metrics"]["frames_processed"], 12)
        self.assertEqual(database.get_all_db_cameras()[0]["roi"], points)
        self.assertEqual(self.client.patch("/cameras/999/roi", json={"points": points}).status_code, 404)
        for invalid in ([[0, 0], [1, 1]], [[0, 0], [1, 1], [0, 1], [1, 0]],
                        [[0, 0], [2, 0], [1, 1]], [[0, 0], [0, 0], [1, 1]]):
            self.assertEqual(self.client.patch("/cameras/1/roi", json={"points": invalid}).status_code, 422)
        self.assertEqual(self.client.patch("/cameras/1/roi", json={"points": []}).status_code, 200)
        self.assertEqual(database.get_all_db_cameras()[0]["roi"], [])

    def test_detection_settings_validate_and_optional_thresholds_reset(self):
        cases = (("ai_confidence_threshold", "1.1"), ("ai_iou_threshold", "nan"),
                 ("ai_persistence_frames", "0"), ("ai_persistence_frames", "2.5"),
                 ("ai_cooldown_seconds", "-1"), ("ai_fire_confidence_threshold", "inf"))
        for key, value in cases:
            with self.subTest(key=key, value=value):
                self.assertEqual(self.client.post("/settings", json={"key": key, "value": value}).status_code, 422)
        for value in ("0.7", ""):
            self.assertEqual(self.client.post("/settings", json={"key": "ai_fire_confidence_threshold",
                                                                  "value": value}).status_code, 200)
            self.assertEqual(database.get_setting("ai_fire_confidence_threshold"), value)
        self.client.post("/settings", json={"key": "smtp_password", "value": "secret"})
        self.assertEqual(self.client.get("/settings").json()["settings"]["smtp_password"], "********")
        self.client.post("/settings", json={"key": "smtp_password", "value": "********"})
        self.assertEqual(database.get_setting("smtp_password"), "secret")

    def test_image_analysis_returns_preview_without_events(self):
        success, encoded = cv2.imencode(".png", np.zeros((24, 32, 3), dtype=np.uint8))
        self.assertTrue(success)
        response = self.client.post("/analyze/image", files={"file": ("test.png", encoded.tobytes(), "image/png")},
                                    data={"confidence": ".7", "iou": ".5"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["detections"][0]["class"], "fire")
        self.assertEqual(body["classes"], ["fire"])
        self.assertTrue(body["annotated_image"].startswith("data:image/jpeg;base64,"))
        self.assertEqual(self.api.detector.calls, [(.7, .5)])
        self.assertEqual(database.count_events(), 0)
        self.assertEqual(self.client.get("/model").json()["smoke_supported"], False)

    def test_image_analysis_rejects_invalid_oversized_images_and_thresholds(self):
        for contents in (b"", b"this is not an image"):
            self.assertEqual(self.client.post("/analyze/image", files={"file": ("bad.jpg", contents)}).status_code, 422)
        self.assertEqual(self.client.post("/analyze/image", files={"file": ("large.jpg", b"x" * (10 * 1024 * 1024 + 1))}).status_code, 413)
        payload = BytesIO()
        Image.new("L", (4001, 4000)).save(payload, format="PNG")
        self.assertEqual(self.client.post("/analyze/image", files={"file": ("huge.png", payload.getvalue())}).status_code, 413)
        success, encoded = cv2.imencode(".png", np.zeros((4, 4, 3), dtype=np.uint8))
        for value in ("nan", "-1", "1.1"):
            self.assertEqual(self.client.post("/analyze/image", files={"file": ("test.png", encoded.tobytes())},
                                               data={"confidence": value}).status_code, 422)
        self.assertEqual(self.api.detector.calls, [])

    def test_image_validation_ignores_later_model_decoder_patches(self):
        success, encoded = cv2.imencode(".png", np.zeros((4, 4, 3), dtype=np.uint8))
        self.assertTrue(success)
        # Model libraries may replace Image.open with a fallback that imports
        # optional codecs for corrupt input. Validation must use its own opener.
        with patch.object(Image, "open", side_effect=ModuleNotFoundError("No module named 'pi_heif'")) as patched:
            invalid = self.client.post("/analyze/image", files={"file": ("bad.png", b"not a png")})
            valid = self.client.post("/analyze/image", files={"file": ("valid.png", encoded.tobytes())})
        self.assertEqual(invalid.status_code, 422)
        self.assertEqual(valid.status_code, 200)
        patched.assert_not_called()

    def test_missing_optional_decoder_and_unsupported_gif_are_rejected(self):
        # Also handle callers that imported a patched decoder before the API.
        with patch.object(self.api, "pillow_open", side_effect=ModuleNotFoundError("No optional decoder")):
            response = self.client.post("/analyze/image", files={"file": ("bad.png", b"not a png")})
        self.assertEqual(response.status_code, 422)
        payload = BytesIO()
        Image.new("RGB", (4, 4)).save(payload, format="GIF")
        response = self.client.post("/analyze/image", files={"file": ("renamed.png", payload.getvalue(), "image/png")})
        self.assertEqual(response.status_code, 422)
        self.assertIn("Supported image formats", response.json()["detail"])
        self.assertEqual(self.api.detector.calls, [])


if __name__ == "__main__":
    unittest.main()
