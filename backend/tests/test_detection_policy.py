import math
from pathlib import Path
import sys
import threading
import time
from collections import deque
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from detection_policy import (
    DetectionSettings, advance_persistence, point_in_roi,
    validate_detection_setting, validate_roi,
)


def detection(name="Fire", confidence=0.8, bbox=None):
    return {"class": name, "confidence": confidence, "bbox": bbox or [20, 20, 40, 40]}


class PersistenceTests(unittest.TestCase):
    def test_multiple_boxes_advance_only_once_and_choose_highest_confidence(self):
        state = {}
        settings = DetectionSettings(persistence_frames=2)
        boxes = [detection(confidence=0.7), detection(confidence=0.9), detection(" FIRE ", 0.8)]
        self.assertEqual(advance_persistence(state, boxes, settings), {})
        self.assertEqual(state, {"fire": 1})
        confirmed = advance_persistence(state, boxes, settings)
        self.assertEqual(state, {"fire": 2})
        self.assertEqual(list(confirmed), ["fire"])
        self.assertEqual(confirmed["fire"]["confidence"], 0.9)

    def test_high_confidence_does_not_bypass_frame_confirmation(self):
        state = {}
        settings = DetectionSettings(persistence_frames=3)
        for _ in range(2):
            self.assertEqual(advance_persistence(state, [detection(confidence=0.99)], settings), {})
        self.assertIn("fire", advance_persistence(state, [detection(confidence=0.99)], settings))

    def test_missing_frame_and_below_threshold_restart_confirmation(self):
        for missed in ([], [detection(confidence=0.1)]):
            with self.subTest(missed=missed):
                state = {}
                settings = DetectionSettings(persistence_frames=2)
                advance_persistence(state, [detection()], settings)
                self.assertEqual(advance_persistence(state, missed, settings), {})
                self.assertEqual(state, {})
                self.assertEqual(advance_persistence(state, [detection()], settings), {})
                self.assertIn("fire", advance_persistence(state, [detection()], settings))

    def test_classes_are_independent_and_specific_thresholds_apply(self):
        state = {}
        settings = DetectionSettings(confidence=0.6, fire_confidence=0.15, smoke_confidence=0.8)
        frame = [detection("Fire", 0.2), detection("Smoke", 0.7)]
        self.assertEqual(advance_persistence(state, frame, settings), {})
        self.assertEqual(state, {"fire": 1})
        confirmed = advance_persistence(state, frame + [detection("SMOKE", 0.85)], settings)
        self.assertEqual(list(confirmed), ["fire"])
        self.assertEqual(state, {"fire": 2, "smoke": 1})
        confirmed = advance_persistence(state, [detection("Smoke", 0.85)], settings)
        self.assertEqual(list(confirmed), ["smoke"])
        self.assertEqual(state, {"smoke": 2})

    def test_invalid_confidences_do_not_confirm_alerts(self):
        for value in (float("nan"), float("inf"), -0.1, 1.1, None):
            with self.subTest(value=value):
                state = {"fire": 1}
                self.assertEqual(advance_persistence(state, [detection(confidence=value)], DetectionSettings()), {})
                self.assertEqual(state, {})


class RoiTests(unittest.TestCase):
    def setUp(self):
        self.roi = validate_roi([[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]])

    def test_excluded_box_resets_persistence_even_if_confidence_is_high(self):
        state = {}
        settings = DetectionSettings()
        advance_persistence(state, [detection()], settings, self.roi, (100, 100, 3))
        self.assertEqual(state, {"fire": 1})
        outside = detection(confidence=0.99, bbox=[60, 60, 90, 90])
        self.assertEqual(advance_persistence(state, [outside], settings, self.roi, (100, 100, 3)), {})
        self.assertEqual(state, {})
        self.assertEqual(advance_persistence(state, [detection()], settings, self.roi, (100, 100, 3)), {})

    def test_bbox_center_and_frame_dimensions_determine_eligibility(self):
        settings = DetectionSettings(persistence_frames=1)
        crossing = detection(bbox=[40, 40, 80, 80])
        self.assertEqual(advance_persistence({}, [crossing], settings, self.roi, (100, 100, 3)), {})
        # The same pixels in a larger frame put the center inside the normalized polygon.
        self.assertIn("fire", advance_persistence({}, [crossing], settings, self.roi, (200, 200, 3)))

    def test_empty_polygon_monitors_full_frame_and_edge_counts_as_inside(self):
        self.assertTrue(point_in_roi((0.5, 0.25), self.roi))
        self.assertTrue(point_in_roi((0.9, 0.9), []))
        self.assertFalse(point_in_roi((0.9, 0.9), self.roi))
        self.assertIn("fire", advance_persistence({}, [detection(bbox=[70, 70, 90, 90])], DetectionSettings(persistence_frames=1)))

    def test_concave_polygon_uses_actual_outline(self):
        concave = validate_roi([[0, 0], [1, 0], [1, 0.3], [0.3, 0.3], [0.3, 1], [0, 1]])
        self.assertTrue(point_in_roi((0.1, 0.8), concave))
        self.assertFalse(point_in_roi((0.8, 0.8), concave))

    def test_rejects_malformed_degenerate_and_self_intersecting_polygons(self):
        invalid = [
            None, [[0, 0], [1, 1]], [[0, 0], [1, 1], [2, 0]],
            [[0, 0], [0.5, 0.5], [1, 1]],
            [[0, 0], [1, 1], [0, 1], [1, 0]],
            [[0, 0], [1, 0], [1, 1], [0, 0]],
            [[0, 0], [float("nan"), 0], [1, 1]],
            [[0, 0], [True, 0], [1, 1]],
        ]
        for points in invalid:
            with self.subTest(points=points), self.assertRaises(ValueError):
                validate_roi(points)

    def test_accepts_32_points_and_rejects_larger_polygons(self):
        circle = lambda count: [[0.5 + 0.4 * math.cos(index * 2 * math.pi / count), 0.5 + 0.4 * math.sin(index * 2 * math.pi / count)] for index in range(count)]
        self.assertEqual(len(validate_roi(circle(32))), 32)
        with self.assertRaises(ValueError):
            validate_roi(circle(33))


class SettingsTests(unittest.TestCase):
    def test_optional_thresholds_inherit_global_and_inference_uses_lowest_available_class(self):
        settings = DetectionSettings.from_mapping({"ai_confidence_threshold": "0.1", "ai_smoke_confidence_threshold": "0.8"})
        self.assertEqual(settings.threshold_for("Fire"), 0.1)
        self.assertEqual(settings.threshold_for("SMOKE"), 0.8)
        self.assertEqual(settings.inference_confidence(["Fire"]), 0.1)
        self.assertEqual(settings.inference_confidence(["Smoke"]), 0.8)
        self.assertEqual(settings.inference_confidence(["Fire", "Smoke"]), 0.1)

    def test_bad_legacy_settings_fall_back_independently(self):
        settings = DetectionSettings.from_mapping({"ai_confidence_threshold": "oops", "ai_iou_threshold": "nan", "ai_fire_confidence_threshold": "0.12", "ai_persistence_frames": "0"})
        self.assertEqual(settings.confidence, 0.25)
        self.assertEqual(settings.fire_confidence, 0.12)
        self.assertEqual(settings.iou, 0.45)
        self.assertEqual(settings.persistence_frames, 2)

    def test_validation_rejects_invalid_values_without_touching_other_settings(self):
        for key, value in (
            ("ai_confidence_threshold", "inf"), ("ai_iou_threshold", "1.1"),
            ("ai_fire_confidence_threshold", "-1"), ("ai_persistence_frames", "1.5"),
            ("ai_persistence_frames", "0"), ("ai_cooldown_seconds", "-1"),
        ):
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                validate_detection_setting(key, value)
        self.assertEqual(validate_detection_setting("ai_fire_confidence_threshold", ""), "")
        self.assertEqual(validate_detection_setting("ai_cooldown_seconds", "0"), "0.0")
        self.assertEqual(validate_detection_setting("email_enabled", "true"), "true")


class RuntimeIntegrationTests(unittest.TestCase):
    @staticmethod
    def camera():
        return SimpleNamespace(
            id=7, name="Warehouse", roi=[], detection_persistence={}, event_cooldowns={},
            policy_lock=threading.Lock(), frames_processed=0, inference_ms=0,
            last_frame_at=None, processing_fps=0, processed_frame_times=deque(maxlen=30),
            last_inference_error=None,
        )

    def test_camera_alerts_wait_for_distinct_frames_and_respect_cooldown(self):
        import numpy as np
        from camera_manager import CameraManager
        manager = CameraManager.__new__(CameraManager)
        manager._save_event = Mock()
        cam = self.camera()
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        boxes = [detection(confidence=0.8), detection(confidence=0.95)]
        settings = DetectionSettings(persistence_frames=2, cooldown_seconds=10)
        manager._process_detections(cam, boxes, frame, settings=settings)
        manager._save_event.assert_not_called()
        manager._process_detections(cam, boxes, frame, settings=settings)
        manager._save_event.assert_called_once_with(cam, "fire", 0.95, frame)
        manager._process_detections(cam, boxes, frame, settings=settings)
        self.assertEqual(manager._save_event.call_count, 1)

    def test_camera_passes_low_threshold_and_records_completed_processing(self):
        import numpy as np
        from camera_manager import CameraManager
        manager = CameraManager.__new__(CameraManager)
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        manager.detector = Mock()
        manager.detector.model_info.return_value = {"classes": ["fire"]}
        manager.detector.process_frame.return_value = (frame, [])
        manager._get_detection_settings = Mock(return_value=DetectionSettings(confidence=0.1, iou=0.6))
        manager._process_detections = Mock()
        cam = self.camera()
        manager._process_camera_frame(cam, frame)
        manager._process_camera_frame(cam, frame)
        self.assertEqual(manager.detector.process_frame.call_args.kwargs, {"confidence": 0.1, "iou": 0.6})
        self.assertEqual(cam.frames_processed, 2)
        self.assertGreaterEqual(cam.inference_ms, 0)
        self.assertTrue(cam.last_frame_at.endswith("+00:00"))
        self.assertGreater(cam.processing_fps, 0)

    def test_changed_threshold_restarts_confirmation_without_clearing_cooldown(self):
        import numpy as np
        from camera_manager import CameraManager
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        for new_settings in (
            DetectionSettings(confidence=0.9),
            DetectionSettings(fire_confidence=0.9),
        ):
            with self.subTest(settings=new_settings):
                manager = CameraManager.__new__(CameraManager)
                manager._save_event = Mock()
                cam = self.camera()
                cam.event_cooldowns["smoke"] = 123.45
                manager._process_detections(cam, [detection(confidence=0.3)], frame, settings=DetectionSettings())
                self.assertEqual(cam.detection_persistence, {"fire": 1})
                manager._process_detections(cam, [detection(confidence=0.95)], frame, settings=new_settings)
                manager._save_event.assert_not_called()
                self.assertEqual(cam.detection_persistence, {"fire": 1})
                self.assertEqual(cam.event_cooldowns, {"smoke": 123.45})
                manager._process_detections(cam, [detection(confidence=0.95)], frame, settings=new_settings)
                manager._save_event.assert_called_once_with(cam, "fire", 0.95, frame)

    def test_changed_required_frame_count_starts_a_new_sequence(self):
        import numpy as np
        from camera_manager import CameraManager
        manager = CameraManager.__new__(CameraManager)
        manager._save_event = Mock()
        cam = self.camera()
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        original = DetectionSettings(persistence_frames=4)
        changed = DetectionSettings(persistence_frames=3)
        for _ in range(2):
            manager._process_detections(cam, [detection()], frame, settings=original)
        manager._process_detections(cam, [detection()], frame, settings=changed)
        self.assertEqual(cam.detection_persistence, {"fire": 1})
        manager._save_event.assert_not_called()
        manager._process_detections(cam, [detection()], frame, settings=changed)
        manager._save_event.assert_not_called()
        manager._process_detections(cam, [detection()], frame, settings=changed)
        manager._save_event.assert_called_once()

    def test_inference_failure_does_not_stop_detection_loop(self):
        import numpy as np
        from camera_manager import CameraManager
        manager = CameraManager.__new__(CameraManager)
        cam = self.camera()
        frame = np.zeros((100, 100, 3), dtype=np.uint8)
        cam.running = cam.is_active = True
        cam.frame_count = 2
        cam.read = Mock(return_value=(True, frame))
        manager.cameras = {cam.id: cam}
        manager.running = True
        processed = []

        def process(camera, image):
            processed.append(camera.id)
            if len(processed) == 1:
                raise RuntimeError("temporary inference failure")
            manager.running = False

        manager._process_camera_frame = process
        with patch("camera_manager.time.sleep"):
            manager._detection_loop()
        self.assertEqual(processed, [7, 7])

    def test_model_serializes_shared_inference_and_reports_real_classes(self):
        import numpy as np
        from detection import FireDetector
        frame = np.zeros((32, 32, 3), dtype=np.uint8)
        active_calls = []
        maximum = []
        result = SimpleNamespace(
            plot=lambda: frame,
            boxes=[SimpleNamespace(cls=[0], conf=[0.15], xyxy=np.array([[2, 2, 10, 10]]))],
        )

        class Model:
            names = {0: "Fire", 1: "Smoke"}

            def __call__(self, image, **kwargs):
                active_calls.append(1)
                maximum.append(len(active_calls))
                time.sleep(0.01)
                active_calls.pop()
                return [result]

        with patch("detection.YOLO", return_value=Model()):
            detector = FireDetector()
        self.assertEqual(detector.model_info(), {"classes": ["fire", "smoke"], "smoke_supported": True, "model_name": "best.pt"})
        outputs = []
        threads = [threading.Thread(target=lambda: outputs.append(detector.process_frame(frame, confidence=0.1, iou=0.45))) for _ in range(3)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
        self.assertEqual(max(maximum), 1)
        self.assertEqual(len(outputs), 3)
        self.assertTrue(all(output[1][0]["class"] == "fire" for output in outputs))


if __name__ == "__main__":
    unittest.main()
