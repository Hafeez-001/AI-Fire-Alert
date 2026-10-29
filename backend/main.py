from fastapi import Depends, FastAPI, File, Form, HTTPException, Query, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool
from typing import List, Optional
from datetime import date
from io import BytesIO, StringIO
from PIL import Image, UnidentifiedImageError
from PIL.Image import open as pillow_open
# Capture Pillow's public decoder before model imports can replace Image.open.
from detection import FireDetector
from camera_manager import CameraManager
from detection_policy import validate_detection_setting, validate_roi
import database
import os
import cv2
import asyncio
import time
import base64
import csv
import math
import numpy as np
import re

app = FastAPI(title="AI Fire Detection System")

# Initialize database
database.init_db()

# Initialize components
detector = FireDetector()
camera_manager = CameraManager(detector)

# CORS Configuration
origins = [
    "http://localhost:3000",
    "http://localhost:8000",
    "http://127.0.0.1:3000",
    "http://127.0.0.1:8000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Mount snapshots directory
if not os.path.exists("snapshots"):
    os.makedirs("snapshots")
app.mount("/snapshots", StaticFiles(directory="snapshots"), name="snapshots")

# Connection Manager for WebSockets
class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections:
            try:
                await connection.send_json(message)
            except Exception:
                # Connection is likely closed, ignore and let cleanup handle it
                pass

manager = ConnectionManager()
main_loop = None

def broadcast_alert(alert_data):
    """Safely broadcast alert data from background thread to WebSocket connections."""
    if main_loop:
        asyncio.run_coroutine_threadsafe(manager.broadcast(alert_data), main_loop)
    else:
        print("[WebSocket] Event loop not ready. Broadcast skipped.")

@app.on_event("startup")
async def startup_event():
    global main_loop
    main_loop = asyncio.get_running_loop()
    # Register the alert callback to bridge camera manager and websocket
    camera_manager.alert_callback = broadcast_alert
    print("FastAPI startup: WebSocket broadcast callback registered.")

@app.on_event("shutdown")
async def shutdown_event():
    global main_loop
    camera_manager.alert_callback = None
    await run_in_threadpool(camera_manager.shutdown)
    main_loop = None

@app.get("/")
def read_root():
    return {"status": "ok", "message": "Fire Detection System API is running"}

def generate_camera_stream(camera_id):
    """Generator for camera stream with CPU protection sleep."""
    while True:
        frame = camera_manager.get_frame(camera_id)
        if frame is not None:
            # Encode frame to JPEG
            ret, buffer = cv2.imencode('.jpg', frame)
            frame_bytes = buffer.tobytes()
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + frame_bytes + b'\r\n')
            time.sleep(0.03) # Cap streaming FPS to ~30 FPS to save CPU/Bandwidth
        else:
            # Yield a placeholder or empty bytes, sleep to prevent CPU spinning
            time.sleep(0.2)
            yield (b'--frame\r\n'
                   b'Content-Type: image/jpeg\r\n\r\n' + b'' + b'\r\n')

@app.get("/video_feed")
def video_feed_default():
    """Default video feed (Kamera 1 - if exists) for backward compatibility."""
    first_active_cam = next(iter(camera_manager.cameras.keys()), 1)
    return StreamingResponse(generate_camera_stream(first_active_cam), 
                             media_type="multipart/x-mixed-replace; boundary=frame")

@app.get("/video_feed/{camera_id}")
def video_feed(camera_id: int):
    """Video feed for specific camera."""
    return StreamingResponse(generate_camera_stream(camera_id), 
                             media_type="multipart/x-mixed-replace; boundary=frame")

class CameraModel(BaseModel):
    source: str
    name: str

@app.get("/cameras")
def get_cameras():
    """Get list of cameras with real-time status details."""
    cameras = []
    for id, cam in list(camera_manager.cameras.items()):
        cameras.append({
            "id": id, 
            "name": cam.name, 
            "source": str(cam.source),
            "is_active": cam.is_active,
            "status": cam.status,
            "roi": getattr(cam, "roi", []),
            "metrics": {
                "frames_processed": getattr(cam, "frames_processed", 0),
                "inference_ms": getattr(cam, "inference_ms", None),
                "last_frame_at": getattr(cam, "last_frame_at", None),
                "processing_fps": getattr(cam, "processing_fps", 0),
            },
        })
    return {"cameras": cameras}

@app.post("/cameras")
def add_new_camera(cam: CameraModel):
    """Add a new camera."""
    new_id = camera_manager.add_camera(cam.source, cam.name)
    return {"status": "ok", "id": new_id, "message": "Camera added"}

@app.delete("/cameras/{camera_id}")
def delete_camera(camera_id: int):
    """Remove a camera."""
    if camera_manager.remove_camera(camera_id):
        return {"status": "ok", "message": "Camera removed"}
    raise HTTPException(status_code=404, detail="Camera not found")

@app.post("/cameras/{camera_id}/toggle")
def toggle_camera(camera_id: int, active: bool):
    """Enable or disable a camera."""
    if camera_manager.toggle_camera(camera_id, active):
        return {"status": "ok", "message": f"Camera {'enabled' if active else 'disabled'}"}
    raise HTTPException(status_code=404, detail="Camera not found")

class CameraROIModel(BaseModel):
    points: List[List[float]]

@app.patch("/cameras/{camera_id}/roi")
def update_camera_roi(camera_id: int, roi: CameraROIModel):
    """Set a normalized polygon, or clear it to analyze the full frame."""
    try:
        points = validate_roi(roi.points)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    if not camera_manager.set_camera_roi(camera_id, points):
        raise HTTPException(status_code=404, detail="Camera not found")
    return {"status": "ok", "roi": points}

@app.get("/model")
def get_model():
    return detector.model_info()

@app.get("/alerts")
def get_alerts():
    # Fetch recent events from database
    events = database.get_recent_events(limit=50)
    
    # Format for frontend
    formatted_alerts = []
    for event in events:
        formatted_alerts.append({
            "id": event["id"],
            "timestamp": event["timestamp"],
            "type": event["type"],
            "confidence": event["confidence"],
            "snapshot": event["snapshot_path"],
            "camera_id": event["camera_id"],
            "camera_name": event["camera_name"],
        })
        
    return {"alerts": formatted_alerts}

@app.get("/stats")
def get_stats():
    """Get daily event statistics."""
    stats = database.get_daily_stats()
    today = date.today().isoformat()
    return {"stats": stats, "today_count": database.count_events(start_date=today, end_date=today)}

def history_filters(
    event_type: Optional[str] = None,
    camera_id: Optional[int] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
    min_confidence: Optional[float] = Query(None, ge=0, le=1),
):
    """Share strict, inclusive date filters between history and CSV exports."""
    event_type = event_type.strip().lower() if event_type else None
    if event_type not in (None, "", "fire", "smoke"):
        raise HTTPException(status_code=422, detail="event_type must be fire or smoke")
    for value in (start_date, end_date):
        if value is not None:
            try:
                if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
                    raise ValueError
                date.fromisoformat(value)
            except ValueError as error:
                raise HTTPException(status_code=422, detail="Dates must use valid YYYY-MM-DD values") from error
    if start_date and end_date and start_date > end_date:
        raise HTTPException(status_code=422, detail="start_date must not be after end_date")
    if min_confidence is not None and not math.isfinite(min_confidence):
        raise HTTPException(status_code=422, detail="min_confidence must be finite")
    return {"event_type": event_type, "camera_id": camera_id, "start_date": start_date,
            "end_date": end_date, "min_confidence": min_confidence}

@app.get("/history")
def get_history(limit: int = Query(50, ge=1, le=100), offset: int = Query(0, ge=0),
                filters: dict = Depends(history_filters)):
    events = database.get_all_events(limit, offset, **filters)
    return {"events": events, "total": database.count_events(**filters), "limit": limit, "offset": offset}

def csv_safe(value):
    """Keep spreadsheet programs from treating stored text as a formula."""
    if isinstance(value, str) and value.lstrip().startswith(("=", "+", "-", "@")):
        return "'" + value
    return value

def history_csv(filters):
    columns = ["id", "timestamp", "type", "confidence", "camera_id", "camera_name", "snapshot_path"]
    buffer = StringIO(newline="")
    writer = csv.writer(buffer)
    writer.writerow(columns)
    yield buffer.getvalue()
    buffer.seek(0)
    buffer.truncate(0)
    for event in database.iter_events(**filters):
        writer.writerow([csv_safe(event[column]) for column in columns])
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)

@app.get("/history/export.csv")
def export_history(filters: dict = Depends(history_filters)):
    return StreamingResponse(history_csv(filters), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": 'attachment; filename="fire-guard-history.csv"'})

MAX_IMAGE_BYTES = 10 * 1024 * 1024
MAX_IMAGE_PIXELS = 16_000_000
SUPPORTED_IMAGE_FORMATS = {"JPEG", "PNG", "WEBP", "BMP"}

def analyze_uploaded_image(payload, confidence, iou):
    # Check dimensions before decoding the full image to bound decoded memory.
    try:
        with pillow_open(BytesIO(payload)) as header:
            if header.format not in SUPPORTED_IMAGE_FORMATS:
                raise HTTPException(status_code=422, detail="Supported image formats are JPEG, PNG, WebP and BMP")
            width, height = header.size
            if width * height > MAX_IMAGE_PIXELS:
                raise HTTPException(status_code=413, detail="Image exceeds 16 megapixels")
    except (UnidentifiedImageError, OSError, ValueError, ImportError) as error:
        raise HTTPException(status_code=422, detail="File is not a valid image") from error
    except Image.DecompressionBombError as error:
        raise HTTPException(status_code=413, detail="Image exceeds 16 megapixels") from error
    try:
        frame = cv2.imdecode(np.frombuffer(payload, dtype=np.uint8), cv2.IMREAD_COLOR)
    except cv2.error as error:
        raise HTTPException(status_code=422, detail="Image could not be decoded") from error
    if frame is None or frame.size == 0:
        raise HTTPException(status_code=422, detail="Image could not be decoded")
    if frame.shape[0] * frame.shape[1] > MAX_IMAGE_PIXELS:
        raise HTTPException(status_code=413, detail="Image exceeds 16 megapixels")
    annotated, detections = detector.process_frame(frame, confidence=confidence, iou=iou)
    success, encoded = cv2.imencode(".jpg", annotated)
    if not success:
        raise HTTPException(status_code=500, detail="Annotated image could not be encoded")
    return {"detections": detections,
            "annotated_image": "data:image/jpeg;base64," + base64.b64encode(encoded).decode("ascii"),
            "classes": detector.model_info()["classes"]}

@app.post("/analyze/image")
async def analyze_image(file: UploadFile = File(...),
                        confidence: Optional[float] = Form(None, ge=0, le=1),
                        iou: Optional[float] = Form(None, ge=0, le=1)):
    """Preview image detections without recording camera alerts or notifications."""
    try:
        for value in (confidence, iou):
            if value is not None and not math.isfinite(value):
                raise HTTPException(status_code=422, detail="Thresholds must be finite")
        payload = bytearray()
        while chunk := await file.read(64 * 1024):
            payload.extend(chunk)
            if len(payload) > MAX_IMAGE_BYTES:
                raise HTTPException(status_code=413, detail="Image upload exceeds 10 MiB")
        if not payload:
            raise HTTPException(status_code=422, detail="Image upload is empty")
        return await run_in_threadpool(analyze_uploaded_image, payload, confidence, iou)
    finally:
        await file.close()

class SettingsModel(BaseModel):
    key: str
    value: str

@app.get("/settings")
def get_settings():
    """Get all settings (masking secrets)."""
    settings = database.get_all_settings()
    # Mask secrets for frontend display
    masked_keys = ["smtp_password", "telegram_bot_token"]
    for key in masked_keys:
        if key in settings and settings[key]:
            settings[key] = "********"
    return {"settings": settings}

@app.post("/settings")
def save_setting(setting: SettingsModel):
    """Save a setting."""
    # Don't save masked values back
    if setting.key in ("smtp_password", "telegram_bot_token") and setting.value == "********":
        return {"status": "skipped", "message": "Masked value ignored"}
    
    try:
        value = validate_detection_setting(setting.key, setting.value)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    database.set_setting(setting.key, value)
    return {"status": "ok", "message": "Setting saved"}

import notification

@app.post("/test-notification")
def test_notification():
    """Trigger a test notification."""
    # Use a placeholder image or None
    notification.trigger_notifications("TEST EVENT", 0.99, None)
    return {"status": "ok", "message": "Test notification triggered"}

# WebSocket Endpoint
@app.websocket("/ws/alerts")
async def websocket_endpoint(websocket: WebSocket):
    """WebSocket connection endpoint for real-time alert push."""
    await manager.connect(websocket)
    try:
        while True:
            # Keep connection open and listen for heartbeat or messages
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
