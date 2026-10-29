"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLanguage } from "../context/LanguageContext";
import { API_URL } from "../config";

type Point = [number, number];

interface Camera {
  id: number;
  name: string;
  source: string;
  is_active: boolean;
  status: "connected" | "disconnected" | "connecting";
  roi?: Point[];
  metrics?: {
    frames_processed: number;
    inference_ms: number | null;
    last_frame_at: string | null;
    processing_fps: number;
  };
}

async function responseError(response: Response) {
  const body = await response.json().catch(() => null);
  const detail = body?.detail ?? body?.message;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((entry: { msg?: string }) => entry.msg || "Invalid value").join("; ");
  return `Request failed (${response.status}).`;
}

function CameraPreview({ camera, points, onPoint }: { camera: Camera; points: Point[]; onPoint?: (point: Point) => void }) {
  const imageRef = useRef<HTMLImageElement>(null);
  const [imageSize, setImageSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    // Multipart streams can expose their first frame before emitting a load event.
    const updateSize = () => {
      const image = imageRef.current;
      if (!image?.naturalWidth || !image.naturalHeight) return;
      setImageSize((previous) => previous.width === image.naturalWidth && previous.height === image.naturalHeight ? previous : { width: image.naturalWidth, height: image.naturalHeight });
    };
    const timer = window.setInterval(updateSize, 500);
    return () => window.clearInterval(timer);
  }, []);

  const addPoint = (event: React.MouseEvent<HTMLDivElement>) => {
    const image = imageRef.current;
    if (!onPoint || !image?.naturalWidth || !image.naturalHeight) return;
    const bounds = image.getBoundingClientRect();
    const scale = Math.min(bounds.width / image.naturalWidth, bounds.height / image.naturalHeight);
    const width = image.naturalWidth * scale;
    const height = image.naturalHeight * scale;
    const x = event.clientX - bounds.left - (bounds.width - width) / 2;
    const y = event.clientY - bounds.top - (bounds.height - height) / 2;
    if (x < 0 || y < 0 || x > width || y > height || width === 0 || height === 0) return;
    onPoint([Number((x / width).toFixed(6)), Number((y / height).toFixed(6))]);
  };

  return (
    <div className={`relative w-full h-full bg-black ${onPoint ? "cursor-crosshair" : ""}`} onClick={onPoint ? addPoint : undefined}>
      {/* Native images are required for multipart camera streams. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img ref={imageRef} src={`${API_URL}/video_feed/${camera.id}`} alt={`${camera.name} live preview`} className="w-full h-full object-contain" onLoad={(event) => setImageSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />
      {imageSize.width > 0 && points.length > 0 && (
        <svg aria-hidden="true" className="absolute inset-0 w-full h-full pointer-events-none" viewBox={`0 0 ${imageSize.width} ${imageSize.height}`} preserveAspectRatio="xMidYMid meet">
          {points.length >= 3 ? <polygon points={points.map(([x, y]) => `${x * imageSize.width},${y * imageSize.height}`).join(" ")} fill="rgba(245,158,11,0.16)" stroke="#fbbf24" strokeWidth="2" vectorEffect="non-scaling-stroke" /> : <polyline points={points.map(([x, y]) => `${x * imageSize.width},${y * imageSize.height}`).join(" ")} fill="none" stroke="#fbbf24" strokeWidth="2" vectorEffect="non-scaling-stroke" />}
          {points.map(([x, y], index) => <circle key={index} cx={x * imageSize.width} cy={y * imageSize.height} r={Math.max(imageSize.width, imageSize.height) * 0.006} fill="#fbbf24" />)}
        </svg>
      )}
    </div>
  );
}

function RoiEditor({ camera, onClose, onSaved }: { camera: Camera; onClose: () => void; onSaved: (points: Point[]) => void }) {
  const [points, setPoints] = useState<Point[]>(() => (camera.roi || []).map(([x, y]) => [x, y]));
  const [coordinateX, setCoordinateX] = useState("");
  const [coordinateY, setCoordinateY] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const addPoint = (point: Point) => {
    if (points.length >= 32) {
      setError("A detection region can contain at most 32 corners.");
      return;
    }
    setError("");
    setPoints((previous) => [...previous, point]);
  };

  const addCoordinate = () => {
    const x = Number(coordinateX);
    const y = Number(coordinateY);
    if (!coordinateX.trim() || !coordinateY.trim() || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 1 || y > 1) {
      setError("Enter an X and Y coordinate between 0 and 1.");
      return;
    }
    addPoint([x, y]);
  };

  const save = async () => {
    if (points.length > 0 && (points.length < 3 || points.length > 32)) {
      setError("Choose 3–32 corners, or clear the region to detect in the whole frame.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const response = await fetch(`${API_URL}/cameras/${camera.id}/roi`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      onSaved(points);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Cannot save the detection region. Check the connection.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm p-4 flex items-center justify-center">
      <div role="dialog" aria-modal="true" aria-labelledby="roi-title" className="bg-[#0a0a0a] border border-white/10 rounded-2xl w-full max-w-3xl max-h-[90vh] overflow-y-auto">
        <div className="flex justify-between items-center p-5 border-b border-white/10"><h2 id="roi-title" className="font-bold text-white">Detection region · {camera.name}</h2><button type="button" onClick={onClose} aria-label="Close detection region editor" className="text-gray-400 hover:text-white p-2" disabled={saving}>✕</button></div>
        <div className="p-5 space-y-4">
          <p className="text-sm text-gray-400">Click the preview to draw the region corners in order. Detections are accepted when their center is inside the polygon. Black margins are excluded. Clear the region to use the full frame.</p>
          {error && <p role="alert" className="text-sm bg-red-500/10 text-red-300 rounded p-3">{error}</p>}
          <div className="h-[240px] sm:h-[360px] rounded-xl border border-white/10 overflow-hidden">
            {camera.is_active && camera.status !== "disconnected" ? <CameraPreview camera={camera} points={points} onPoint={saving ? undefined : addPoint} /> : <div className="h-full flex items-center justify-center p-6 text-sm text-gray-500">Preview unavailable. You can enter normalized coordinates below or activate the camera.</div>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm text-gray-300 mr-auto">{points.length ? `${points.length} / 32 corners` : "Full frame"}</span>
            <button type="button" onClick={() => { setPoints((previous) => previous.slice(0, -1)); setError(""); }} disabled={!points.length || saving} className="px-3 py-2 text-xs bg-gray-800 rounded text-white disabled:opacity-40">Undo corner</button>
            <button type="button" onClick={() => { setPoints([]); setError(""); }} disabled={saving} className="px-3 py-2 text-xs bg-gray-800 rounded text-white disabled:opacity-40">Clear region</button>
          </div>
          <details className="rounded border border-white/10 p-3 text-sm text-gray-300">
            <summary className="cursor-pointer">Enter coordinates / view corners</summary>
            <p className="text-xs text-gray-500 mt-3">0,0 is the top-left; 1,1 is the bottom-right. This also works without a preview.</p>
            <div className="flex flex-wrap gap-2 items-end mt-3">
              <label className="text-xs space-y-1">X (0–1)<input aria-label="Corner X coordinate" type="number" min="0" max="1" step="0.01" value={coordinateX} onChange={(event) => setCoordinateX(event.target.value)} className="block bg-black border border-white/10 rounded p-2 w-24 text-white" disabled={saving} /></label>
              <label className="text-xs space-y-1">Y (0–1)<input aria-label="Corner Y coordinate" type="number" min="0" max="1" step="0.01" value={coordinateY} onChange={(event) => setCoordinateY(event.target.value)} className="block bg-black border border-white/10 rounded p-2 w-24 text-white" disabled={saving} /></label>
              <button type="button" onClick={addCoordinate} disabled={saving || points.length >= 32} className="text-xs bg-gray-800 text-white px-3 py-2 rounded disabled:opacity-40">Add corner</button>
            </div>
            {points.length > 0 && <ol className="text-xs text-gray-400 mt-3 grid grid-cols-2 sm:grid-cols-3 gap-1">{points.map(([x, y], index) => <li key={index}>{index + 1}: {x.toFixed(3)}, {y.toFixed(3)}</li>)}</ol>}
          </details>
        </div>
        <div className="p-5 border-t border-white/10 flex justify-end gap-3"><button type="button" onClick={onClose} disabled={saving} className="text-sm px-4 py-2 text-gray-300">Cancel</button><button type="button" onClick={save} disabled={saving} className="text-sm px-4 py-2 bg-amber-500 hover:bg-amber-400 text-black font-medium rounded disabled:opacity-50">{saving ? "Saving…" : "Save region"}</button></div>
      </div>
    </div>
  );
}

const CameraGrid = () => {
  const { t } = useLanguage();
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [isAdding, setIsAdding] = useState(false);
  const [newCamSource, setNewCamSource] = useState("");
  const [newCamName, setNewCamName] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [pollError, setPollError] = useState("");
  const [editingCamera, setEditingCamera] = useState<Camera | null>(null);

  const fetchCameras = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch(`${API_URL}/cameras`, { signal });
      if (!response.ok) throw new Error(await responseError(response));
      const data = await response.json();
      if (signal?.aborted) return;
      setCameras(data.cameras);
      setPollError("");
      setLoading(false);
    } catch (error) {
      if (signal?.aborted) return;
      setPollError(`Cannot load cameras: ${error instanceof Error ? error.message : "Connection failed."}`);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void fetchCameras(controller.signal);
    const interval = window.setInterval(() => void fetchCameras(controller.signal), 3000);
    return () => { controller.abort(); window.clearInterval(interval); };
  }, [fetchCameras]);

  const mutateCamera = async (url: string, options: RequestInit, onSuccess?: () => void) => {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(url, options);
      if (!response.ok) throw new Error(await responseError(response));
      onSuccess?.();
      await fetchCameras();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Camera update failed. Check the connection.");
    } finally {
      setBusy(false);
    }
  };

  const handleAddCamera = async () => {
    if (!newCamSource.trim()) { setError("Enter a camera source."); return; }
    await mutateCamera(`${API_URL}/cameras`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: newCamSource.trim(), name: newCamName.trim() || `Camera ${cameras.length + 1}` }),
    }, () => { setIsAdding(false); setNewCamSource(""); setNewCamName(""); });
  };

  const handleDeleteCamera = async (id: number) => {
    if (!confirm(t.camera.confirmDelete)) return;
    await mutateCamera(`${API_URL}/cameras/${id}`, { method: "DELETE" });
  };

  if (loading) return <div role="status" className="min-h-[300px] flex items-center justify-center text-gray-400 text-sm">Connecting to detection server…</div>;

  return (
    <div className="h-full flex flex-col">
      <div className="flex flex-wrap gap-3 justify-between items-center mb-4 px-2">
        <h2 className="text-white font-bold">{t.camera.activeCameras} ({cameras.filter((camera) => camera.is_active).length}/{cameras.length})</h2>
        <button type="button" onClick={() => { setIsAdding(true); setError(""); }} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 rounded text-xs text-white">+ {t.camera.addCamera}</button>
      </div>
      {(error || pollError) && <p role="alert" className="text-xs bg-red-500/10 text-red-300 p-3 rounded mb-3">{error || pollError}</p>}
      {isAdding && <div className="mb-4 p-4 bg-gray-900 border border-white/10 rounded-xl space-y-3">
        <h3 className="text-sm text-white font-medium">{t.camera.addCamera}</h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2"><input type="text" aria-label={t.camera.cameraName} placeholder={t.camera.cameraName} className="bg-black/20 border border-white/10 rounded px-3 py-2 text-white text-xs outline-none focus:border-blue-500" value={newCamName} onChange={(event) => setNewCamName(event.target.value)} disabled={busy} /><input type="text" aria-label={t.camera.cameraSource} placeholder={t.camera.cameraSource} className="bg-black/20 border border-white/10 rounded px-3 py-2 text-white text-xs outline-none focus:border-blue-500" value={newCamSource} onChange={(event) => setNewCamSource(event.target.value)} disabled={busy} /></div>
        <div className="flex justify-end gap-2"><button type="button" onClick={() => setIsAdding(false)} disabled={busy} className="px-3 py-1 text-gray-400 text-xs">{t.camera.cancel}</button><button type="button" onClick={handleAddCamera} disabled={busy} className="px-3 py-1 bg-green-600 text-white rounded text-xs disabled:opacity-50">{busy ? t.camera.adding : t.settings.save}</button></div>
      </div>}
      {cameras.length === 0 && !pollError && <p className="text-sm text-gray-500 py-10 text-center">No cameras configured. Add a camera to start monitoring.</p>}
      <div className={`grid gap-4 flex-1 overflow-y-auto min-h-0 ${cameras.length <= 1 ? "grid-cols-1" : "grid-cols-1 md:grid-cols-2"}`}>
        {cameras.map((camera) => <div key={camera.id} className="rounded-xl overflow-hidden bg-black border border-gray-800 flex flex-col">
          <div className="flex flex-wrap justify-between items-center gap-2 px-3 py-2 border-b border-white/5">
            <span className="text-xs text-white font-medium flex items-center gap-2"><span className={`w-1.5 h-1.5 rounded-full ${!camera.is_active ? "bg-gray-500" : camera.status === "connected" ? "bg-green-500" : camera.status === "connecting" ? "bg-yellow-500" : "bg-red-500"}`} />{camera.name}<span className="text-gray-500">{!camera.is_active ? "Inactive" : camera.status}</span></span>
            <div className="flex gap-1">
              <button type="button" onClick={() => setEditingCamera(camera)} className="px-2 py-1 bg-amber-500/15 hover:bg-amber-500/25 text-amber-300 rounded text-xs">Region{camera.roi?.length ? " •" : ""}</button>
              <button type="button" onClick={() => void mutateCamera(`${API_URL}/cameras/${camera.id}/toggle?active=${!camera.is_active}`, { method: "POST" })} disabled={busy} aria-label={`${camera.is_active ? "Deactivate" : "Activate"} ${camera.name}`} className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-300 disabled:opacity-50">{camera.is_active ? "Pause" : "Start"}</button>
              {camera.id !== 1 && <button type="button" onClick={() => handleDeleteCamera(camera.id)} disabled={busy} aria-label={`Delete ${camera.name}`} className="px-2 py-1 bg-red-500/15 text-red-300 rounded text-xs disabled:opacity-50">Delete</button>}
            </div>
          </div>
          <div className="h-[200px] md:h-[250px]">
            {!camera.is_active ? <div className="h-full flex items-center justify-center text-gray-500 text-xs">Camera is inactive</div> : camera.status === "disconnected" ? <div className="h-full flex flex-col gap-2 items-center justify-center bg-red-950/20 text-red-400 text-xs"><span>Connection lost</span><span className="text-gray-500">Reconnecting…</span></div> : <CameraPreview camera={camera} points={camera.roi || []} />}
          </div>
          <div className="px-3 py-2 text-[10px] text-gray-400 border-t border-white/5 flex flex-wrap gap-x-3 gap-y-1 font-mono" title={camera.metrics?.last_frame_at ? `Last frame: ${camera.metrics.last_frame_at}` : "No frame processed yet"}>
            {camera.metrics ? <><span>{Number.isFinite(camera.metrics.processing_fps) ? camera.metrics.processing_fps.toFixed(1) : "—"} FPS</span><span>{camera.metrics.inference_ms !== null && Number.isFinite(camera.metrics.inference_ms) ? `${camera.metrics.inference_ms.toFixed(1)} ms inference` : "Inference pending"}</span><span>{camera.metrics.frames_processed} frames</span><span>{camera.roi?.length ? "Region enabled" : "Full frame"}</span></> : <span>Metrics unavailable</span>}
          </div>
        </div>)}
      </div>
      {editingCamera && <RoiEditor key={editingCamera.id} camera={editingCamera} onClose={() => setEditingCamera(null)} onSaved={(points) => { setCameras((previous) => previous.map((camera) => camera.id === editingCamera.id ? { ...camera, roi: points } : camera)); setEditingCamera(null); void fetchCameras(); }} />}
    </div>
  );
};

export default CameraGrid;
