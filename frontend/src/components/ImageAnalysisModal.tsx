"use client";

import React, { useEffect, useRef, useState } from "react";
import { API_URL } from "../config";

interface ImageAnalysisModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface AnalysisResult {
  detections: { class: string; confidence: number; bbox: number[] }[];
  annotated_image: string;
  classes: string[];
}

interface ModelInfo {
  classes: string[];
  smoke_supported: boolean;
  model_name: string;
}

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const imageTypes = new Set(["image/jpeg", "image/png", "image/webp", "image/bmp", "image/x-ms-bmp"]);

async function responseError(response: Response) {
  const body = await response.json().catch(() => null);
  const detail = body?.detail ?? body?.message;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((entry: { msg?: string }) => entry.msg || "Invalid value").join("; ");
  return `Image analysis failed (${response.status}).`;
}

export default function ImageAnalysisModal({ isOpen, onClose }: ImageAnalysisModalProps) {
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const [confidence, setConfidence] = useState("");
  const [iou, setIou] = useState("");
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [modelError, setModelError] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const requestRef = useRef<AbortController | null>(null);
  const previewRef = useRef("");

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const loadModel = async () => {
      try {
        const response = await fetch(`${API_URL}/model`, { signal: controller.signal });
        if (!response.ok) throw new Error(await responseError(response));
        const info = await response.json();
        if (controller.signal.aborted) return;
        setModel(info);
        setModelError("");
      } catch (error) {
        if (controller.signal.aborted) return;
        setModel(null);
        setModelError(`Cannot load model capabilities: ${error instanceof Error ? error.message : "Connection failed."}`);
      }
    };
    void loadModel();
    return () => { controller.abort(); requestRef.current?.abort(); };
  }, [isOpen]);

  useEffect(() => () => {
    requestRef.current?.abort();
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
  }, []);

  const selectFile = (event: React.ChangeEvent<HTMLInputElement>) => {
    requestRef.current?.abort();
    setLoading(false);
    setResult(null);
    setError("");
    setFile(null);
    if (previewRef.current) URL.revokeObjectURL(previewRef.current);
    previewRef.current = "";
    setPreviewUrl("");
    const selected = event.target.files?.[0];
    if (!selected) return;
    const supportedExtension = /\.(jpe?g|png|webp|bmp)$/i.test(selected.name);
    if (!imageTypes.has(selected.type) && !((!selected.type || selected.type === "application/octet-stream") && supportedExtension)) {
      setError("Choose a JPEG, PNG, WebP or BMP image.");
      event.target.value = "";
      return;
    }
    if (selected.size === 0 || selected.size > MAX_FILE_BYTES) {
      setError("The image must contain data and be no larger than 10 MiB.");
      event.target.value = "";
      return;
    }
    setFile(selected);
    const url = URL.createObjectURL(selected);
    previewRef.current = url;
    setPreviewUrl(url);
  };

  const analyze = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!file) { setError("Select an image before analyzing."); return; }
    if (file.size === 0 || file.size > MAX_FILE_BYTES) { setError("The image must contain data and be no larger than 10 MiB."); return; }
    for (const [label, value] of [["Confidence", confidence], ["IoU", iou]]) {
      if (value.trim() && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1)) {
        setError(`${label} must be between 0 and 1, or empty to use saved settings.`);
        return;
      }
    }
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    setResult(null);
    const payload = new FormData();
    payload.append("file", file);
    if (confidence.trim()) payload.append("confidence", confidence.trim());
    if (iou.trim()) payload.append("iou", iou.trim());
    try {
      const response = await fetch(`${API_URL}/analyze/image`, { method: "POST", body: payload, signal: controller.signal });
      if (!response.ok) throw new Error(await responseError(response));
      const analysis: AnalysisResult = await response.json();
      if (!controller.signal.aborted) setResult(analysis);
    } catch (error) {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : "Cannot analyze the image. Check the server connection.");
    } finally {
      if (requestRef.current === controller) {
        setLoading(false);
        requestRef.current = null;
      }
    }
  };

  const close = () => {
    requestRef.current?.abort();
    setLoading(false);
    onClose();
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="image-analysis-title" className="bg-[#0a0a0a] border border-white/10 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="p-5 border-b border-white/10 flex items-center justify-between"><h2 id="image-analysis-title" className="text-xl font-bold text-white">Analyze an image</h2><button type="button" onClick={close} aria-label="Close image analysis" className="text-gray-400 hover:text-white p-2">✕</button></div>
        <div className="p-5 overflow-y-auto space-y-4">
          <p className="text-sm text-gray-400">Upload a still image to inspect the model’s detections. This analysis does not create monitoring events or send notifications.</p>
          <div className="text-xs rounded-xl border border-white/10 bg-white/5 p-3 text-gray-300 space-y-1">
            {model ? <><p>Model: <span className="font-mono text-white">{model.model_name}</span> · Classes: {model.classes.join(", ") || "None"}</p>{!model.smoke_supported && <p className="text-amber-300">The loaded model does not detect smoke.</p>}</> : <p>{modelError || "Loading model capabilities…"}</p>}
          </div>
          <form onSubmit={analyze} className="space-y-4">
            <div className="space-y-2"><label htmlFor="analysis-file" className="text-sm text-white">Image file</label><input id="analysis-file" type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/x-ms-bmp,.jpg,.jpeg,.png,.webp,.bmp" onChange={selectFile} disabled={loading} aria-describedby="analysis-file-help" className="block w-full text-sm text-gray-300 file:bg-gray-800 file:text-white file:border-0 file:rounded file:px-3 file:py-2 file:mr-3 file:cursor-pointer" /><p id="analysis-file-help" className="text-xs text-gray-500">JPEG, PNG, WebP or BMP · up to 10 MiB</p></div>
            <div className="flex flex-wrap gap-3 items-end">
              <label htmlFor="analysis-confidence" className="text-xs text-gray-300 space-y-2">Confidence override<input id="analysis-confidence" type="number" min="0" max="1" step="any" value={confidence} onChange={(event) => setConfidence(event.target.value)} placeholder="Saved settings" disabled={loading} className="block w-40 bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-amber-500" /></label>
              <label htmlFor="analysis-iou" className="text-xs text-gray-300 space-y-2">IoU override<input id="analysis-iou" type="number" min="0" max="1" step="any" value={iou} onChange={(event) => setIou(event.target.value)} placeholder="Saved settings" disabled={loading} className="block w-40 bg-black/20 border border-white/10 rounded px-3 py-2 text-sm text-white outline-none focus:border-amber-500" /></label>
              <button type="submit" disabled={!file || loading} className="bg-amber-500 hover:bg-amber-400 px-4 py-2 rounded text-sm font-medium text-black disabled:opacity-50">{loading ? "Analyzing…" : "Analyze image"}</button>
            </div>
            <p className="text-xs text-gray-500">Optional thresholds range from 0 to 1. Leave empty to use saved settings.</p>
          </form>
          {error && <div role="alert" className="bg-red-500/10 text-red-300 rounded p-3 text-sm">{error}</div>}
          {loading && <p role="status" className="text-sm text-amber-300">Analyzing image…</p>}
          {(result?.annotated_image || previewUrl) && <div className="bg-black border border-white/10 rounded-xl overflow-hidden">
            {/* The result and local preview are dynamic data and blob URLs. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={result?.annotated_image || previewUrl} alt={result ? "Analyzed image with detection boxes" : "Selected image preview"} className="w-full max-h-[420px] object-contain" />
          </div>}
          {result && <section aria-labelledby="analysis-result-title" className="space-y-3"><h3 id="analysis-result-title" className="text-sm font-semibold text-white">Detections ({result.detections.length})</h3>{result.detections.length === 0 ? <p role="status" className="text-sm text-gray-400">No detections at the selected thresholds.</p> : <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">{result.detections.map((detection, index) => <li key={index} className="bg-white/5 border border-white/10 rounded p-3 text-sm"><p className="text-white capitalize">{detection.class} <span className="text-amber-400 font-mono ml-2">{(detection.confidence * 100).toFixed(1)}%</span></p><p className="text-xs text-gray-500 mt-1">Box (x₁, y₁, x₂, y₂): {detection.bbox.map((value) => Math.round(value)).join(", ")}</p></li>)}</ul>}</section>}
        </div>
      </div>
    </div>
  );
}
