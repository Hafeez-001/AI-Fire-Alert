import os
from pathlib import Path
import threading

from ultralytics import YOLO

from detection_policy import DetectionSettings, validate_detection_setting

class FireDetector:
    def __init__(self, model_path=None):
        path = Path(model_path or os.environ.get("FIRE_MODEL_PATH") or Path(__file__).with_name("best.pt"))
        if not path.is_file():
            raise FileNotFoundError(f"Detection model not found: {path}")
        self.model = YOLO(str(path))
        self.model_name = path.name
        self.lock = threading.Lock()
        print(f"Model loaded. Classes: {self.model.names}")

    def model_info(self):
        names = self.model.names
        classes = names.values() if isinstance(names, dict) else names
        normalized = list(dict.fromkeys(str(name).strip().lower() for name in classes))
        return {
            "classes": normalized,
            "smoke_supported": "smoke" in normalized,
            "model_name": self.model_name,
        }

    def process_frame(self, frame, confidence=None, iou=None):
        """Run serialized inference with dynamic thresholds and normalized class names."""
        if confidence is None or iou is None:
            import database
            settings = DetectionSettings.from_mapping(database.get_all_settings())
            if confidence is None:
                confidence = settings.inference_confidence(self.model_info()["classes"])
            if iou is None:
                iou = settings.iou
        confidence = float(validate_detection_setting("ai_confidence_threshold", confidence))
        iou = float(validate_detection_setting("ai_iou_threshold", iou))
        # Cameras and uploaded images share a model and its mutable predictor.
        with self.lock:
            results = self.model(frame, conf=confidence, iou=iou, verbose=False)
            annotated_frame = results[0].plot()
            detections = []
            for result in results:
                for box in result.boxes:
                    class_id = int(box.cls[0])
                    detections.append({
                        "class": str(self.model.names[class_id]).strip().lower(),
                        "confidence": float(box.conf[0]),
                        "bbox": box.xyxy[0].tolist(),
                    })
        return annotated_frame, detections
