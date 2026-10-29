"""Validation and frame-based alert policy, independent of the inference runtime."""

from dataclasses import dataclass
import math


CONFIDENCE_KEYS = {
    "ai_confidence_threshold", "ai_fire_confidence_threshold",
    "ai_smoke_confidence_threshold", "ai_iou_threshold",
}
OPTIONAL_CONFIDENCE_KEYS = {"ai_fire_confidence_threshold", "ai_smoke_confidence_threshold"}


def _finite_number(value):
    if isinstance(value, bool):
        raise ValueError("A finite number is required")
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ValueError("A finite number is required") from exc
    if not math.isfinite(number):
        raise ValueError("A finite number is required")
    return number


def validate_detection_setting(key, value):
    """Return a canonical setting value, rejecting invalid detection settings."""
    if key in OPTIONAL_CONFIDENCE_KEYS and value == "":
        return ""
    if key in CONFIDENCE_KEYS:
        number = _finite_number(value)
        if not 0 <= number <= 1:
            raise ValueError(f"{key} must be between 0 and 1")
        return str(number)
    if key == "ai_persistence_frames":
        number = _finite_number(value)
        if not number.is_integer() or number < 1:
            raise ValueError("ai_persistence_frames must be an integer of at least 1")
        return str(int(number))
    if key == "ai_cooldown_seconds":
        number = _finite_number(value)
        if number < 0:
            raise ValueError("ai_cooldown_seconds must be at least 0")
        return str(number)
    return str(value)


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _on_segment(point, start, end):
    return (
        abs(_cross(start, end, point)) <= 1e-12
        and min(start[0], end[0]) - 1e-12 <= point[0] <= max(start[0], end[0]) + 1e-12
        and min(start[1], end[1]) - 1e-12 <= point[1] <= max(start[1], end[1]) + 1e-12
    )


def _segments_intersect(a, b, c, d):
    first, second = _cross(a, b, c), _cross(a, b, d)
    third, fourth = _cross(c, d, a), _cross(c, d, b)
    if first * second < 0 and third * fourth < 0:
        return True
    return any(
        _on_segment(point, start, end)
        for point, start, end in ((c, a, b), (d, a, b), (a, c, d), (b, c, d))
    )


def validate_roi(points):
    """Validate a simple normalized polygon; an empty polygon monitors the full frame."""
    if not isinstance(points, (list, tuple)):
        raise ValueError("ROI must be a list of [x, y] points")
    if not points:
        return []
    if not 3 <= len(points) <= 32:
        raise ValueError("ROI must contain between 3 and 32 points")
    normalized = []
    for point in points:
        if not isinstance(point, (list, tuple)) or len(point) != 2:
            raise ValueError("Each ROI point must contain x and y")
        x, y = (_finite_number(coordinate) for coordinate in point)
        if not (0 <= x <= 1 and 0 <= y <= 1):
            raise ValueError("ROI coordinates must be between 0 and 1")
        normalized.append([x, y])
    if len({tuple(point) for point in normalized}) != len(normalized):
        raise ValueError("ROI points must be distinct")
    count = len(normalized)
    for first in range(count):
        for second in range(first + 1, count):
            if second == first + 1 or (first == 0 and second == count - 1):
                continue
            if _segments_intersect(
                normalized[first], normalized[(first + 1) % count],
                normalized[second], normalized[(second + 1) % count],
            ):
                raise ValueError("ROI edges must not intersect")
    area = sum(
        normalized[index][0] * normalized[(index + 1) % count][1]
        - normalized[(index + 1) % count][0] * normalized[index][1]
        for index in range(count)
    )
    if abs(area) <= 1e-12:
        raise ValueError("ROI must have a nonzero area")
    return normalized


def point_in_roi(point, roi):
    """Use a ray crossing test, including polygon edges in the monitored area."""
    if not roi:
        return True
    x, y = point
    inside = False
    for index, start in enumerate(roi):
        end = roi[(index + 1) % len(roi)]
        if _on_segment(point, start, end):
            return True
        if (start[1] > y) != (end[1] > y):
            crossing_x = start[0] + (y - start[1]) * (end[0] - start[0]) / (end[1] - start[1])
            if x < crossing_x:
                inside = not inside
    return inside


@dataclass(frozen=True)
class DetectionSettings:
    confidence: float = 0.25
    fire_confidence: float | None = None
    smoke_confidence: float | None = None
    iou: float = 0.45
    persistence_frames: int = 2
    cooldown_seconds: float = 5.0

    @classmethod
    def from_mapping(cls, values):
        """Old or damaged persisted settings fall back individually to safe defaults."""
        fields = {
            "ai_confidence_threshold": ("confidence", 0.25),
            "ai_fire_confidence_threshold": ("fire_confidence", None),
            "ai_smoke_confidence_threshold": ("smoke_confidence", None),
            "ai_iou_threshold": ("iou", 0.45),
            "ai_persistence_frames": ("persistence_frames", 2),
            "ai_cooldown_seconds": ("cooldown_seconds", 5.0),
        }
        parsed = {}
        for key, (field, default) in fields.items():
            raw = values.get(key, "" if default is None else default)
            try:
                validated = validate_detection_setting(key, raw)
                parsed[field] = (
                    None if validated == ""
                    else int(validated) if field == "persistence_frames"
                    else float(validated)
                )
            except ValueError:
                parsed[field] = default
        return cls(**parsed)

    def threshold_for(self, class_name):
        name = str(class_name).strip().lower()
        specific = {"fire": self.fire_confidence, "smoke": self.smoke_confidence}.get(name)
        return self.confidence if specific is None else specific

    def inference_confidence(self, classes=None):
        names = list(classes) if classes else ["fire", "smoke"]
        return min(self.threshold_for(name) for name in names)


def advance_persistence(state, detections, settings, roi=(), frame_shape=None):
    """Advance once per class per processed frame and return confirmed best detections."""
    eligible = {}
    for detection in detections:
        name = str(detection.get("class", "")).strip().lower()
        try:
            confidence = _finite_number(detection.get("confidence"))
        except ValueError:
            continue
        if not name or not 0 <= confidence <= 1 or confidence < settings.threshold_for(name):
            continue
        if roi:
            bbox = detection.get("bbox")
            if frame_shape is None or len(frame_shape) < 2 or not frame_shape[0] or not frame_shape[1]:
                continue
            if not isinstance(bbox, (list, tuple)) or len(bbox) != 4:
                continue
            try:
                left, top, right, bottom = (_finite_number(value) for value in bbox)
            except ValueError:
                continue
            if left > right or top > bottom:
                continue
            center = ((left + right) / (2 * frame_shape[1]), (top + bottom) / (2 * frame_shape[0]))
            if not point_in_roi(center, roi):
                continue
        previous = eligible.get(name)
        if previous is None or confidence > previous["confidence"]:
            eligible[name] = {**detection, "class": name, "confidence": confidence}
    for missing in set(state) - set(eligible):
        del state[missing]
    confirmed = {}
    for name, detection in eligible.items():
        state[name] = state.get(name, 0) + 1
        if state[name] >= settings.persistence_frames:
            confirmed[name] = detection
    return confirmed
