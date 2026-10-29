"use client";

import React, { useEffect, useState } from "react";
import { useLanguage } from "../context/LanguageContext";
import { API_URL } from "../config";

interface SettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

interface ModelInfo {
  classes: string[];
  smoke_supported: boolean;
  model_name: string;
}

const defaults = {
  email_enabled: "false",
  smtp_server: "",
  smtp_port: "587",
  smtp_user: "",
  smtp_password: "",
  receiver_email: "",
  telegram_enabled: "false",
  telegram_bot_token: "",
  telegram_chat_id: "",
  ai_confidence_threshold: "0.25",
  ai_fire_confidence_threshold: "",
  ai_smoke_confidence_threshold: "",
  ai_iou_threshold: "0.45",
  ai_persistence_frames: "2",
  ai_cooldown_seconds: "5",
  alarm_sound_enabled: "true",
};

async function responseError(response: Response) {
  const body = await response.json().catch(() => null);
  const detail = body?.detail ?? body?.message;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) return detail.map((entry: { msg?: string }) => entry.msg || "Invalid value").join("; ");
  return `Request failed (${response.status}).`;
}

const inputClass = "w-full bg-black/20 border border-white/10 rounded px-3 py-2 text-white text-sm focus:border-amber-500 outline-none";

const SettingsModal = ({ isOpen, onClose }: SettingsModalProps) => {
  const { t } = useLanguage();
  const [activeTab, setActiveTab] = useState<"email" | "telegram" | "ai">("ai");
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [message, setMessage] = useState<{ text: string; type: "success" | "error" } | null>(null);
  const [settings, setSettings] = useState(defaults);
  const [model, setModel] = useState<ModelInfo | null>(null);
  const [modelError, setModelError] = useState("");

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const load = async () => {
      const results = await Promise.allSettled([
        fetch(`${API_URL}/settings`, { signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error(await responseError(response));
          return response.json();
        }),
        fetch(`${API_URL}/model`, { signal: controller.signal }).then(async (response) => {
          if (!response.ok) throw new Error(await responseError(response));
          return response.json();
        }),
      ]);
      if (controller.signal.aborted) return;
      const [settingsResult, modelResult] = results;
      if (settingsResult.status === "fulfilled") {
        const supportedSettings = Object.fromEntries(Object.keys(defaults).map((key) => [
          key,
          settingsResult.value.settings?.[key] ?? defaults[key as keyof typeof defaults],
        ])) as typeof defaults;
        setSettings(supportedSettings);
        setSettingsLoaded(true);
        setMessage(null);
      } else {
        setSettingsLoaded(false);
        setMessage({ text: `Cannot load settings: ${settingsResult.reason instanceof Error ? settingsResult.reason.message : "Connection failed."}`, type: "error" });
      }
      if (modelResult.status === "fulfilled") {
        setModel(modelResult.value);
        setModelError("");
      } else {
        setModel(null);
        setModelError("Model information is unavailable. Check the server connection.");
      }
      setFetching(false);
    };
    void load();
    return () => controller.abort();
  }, [isOpen, loadAttempt]);

  const handleChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value, type, checked } = event.target;
    setSettings((previous) => ({ ...previous, [name]: type === "checkbox" ? String(checked) : value }));
    if (settingsLoaded) setMessage(null);
  };

  const validate = () => {
    for (const key of ["ai_confidence_threshold", "ai_fire_confidence_threshold", "ai_smoke_confidence_threshold", "ai_iou_threshold"] as const) {
      const value = settings[key].trim();
      if (!value && (key === "ai_fire_confidence_threshold" || key === "ai_smoke_confidence_threshold")) continue;
      if (!value || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1) {
        return "Confidence and IoU values must be between 0 and 1. Class thresholds may be left empty to use the global threshold.";
      }
    }
    const persistence = Number(settings.ai_persistence_frames);
    if (!settings.ai_persistence_frames.trim() || !Number.isInteger(persistence) || persistence < 1 || persistence > 120) {
      return "Verification frame count must be a whole number between 1 and 120.";
    }
    const cooldown = Number(settings.ai_cooldown_seconds);
    if (!settings.ai_cooldown_seconds.trim() || !Number.isFinite(cooldown) || cooldown < 0) {
      return "Alarm cooldown must be zero seconds or greater.";
    }
    return null;
  };

  const handleSave = async () => {
    if (!settingsLoaded) {
      setMessage({ text: "Load settings successfully before saving. Retry the connection below.", type: "error" });
      return;
    }
    const validationError = validate();
    if (validationError) {
      setMessage({ text: validationError, type: "error" });
      return;
    }
    setLoading(true);
    setMessage(null);
    let savedCount = 0;
    try {
      for (const [key, value] of Object.entries(settings)) {
        const response = await fetch(`${API_URL}/settings`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ key, value }),
        });
        if (!response.ok) throw new Error(`${key}: ${await responseError(response)}`);
        savedCount += 1;
      }
      window.dispatchEvent(new Event("settings-updated"));
      setMessage({ text: t.settings.saved, type: "success" });
    } catch (error) {
      if (savedCount > 0) window.dispatchEvent(new Event("settings-updated"));
      const detail = error instanceof Error ? error.message : "Connection failed.";
      setMessage({ text: `Could not save settings. ${detail}${savedCount > 0 ? " Earlier fields were saved; retry after correcting the error." : ""}`, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  const handleTest = async () => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch(`${API_URL}/test-notification`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      setMessage({ text: t.settings.testSent, type: "success" });
    } catch (error) {
      setMessage({ text: `Test failed: ${error instanceof Error ? error.message : "Connection failed."}`, type: "error" });
    } finally {
      setLoading(false);
    }
  };

  if (!isOpen) return null;

  const textField = (key: keyof typeof defaults, label: string, type = "text", placeholder?: string) => (
    <div className="space-y-2">
      <label htmlFor={key} className="text-xs text-gray-400">{label}</label>
      <input id={key} type={type} name={key} value={settings[key]} onChange={handleChange} className={inputClass} placeholder={placeholder} />
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="settings-title" className="bg-[#0a0a0a] border border-white/10 rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col shadow-2xl">
        <div className="p-5 border-b border-white/5 flex items-center justify-between">
          <h2 id="settings-title" className="text-xl font-bold text-white">{t.settings.title}</h2>
          <button type="button" onClick={onClose} aria-label="Close settings" className="text-gray-400 hover:text-white p-2">✕</button>
        </div>
        <div className="flex border-b border-white/5">
          {(["ai", "email", "telegram"] as const).map((tab) => (
            <button key={tab} type="button" onClick={() => setActiveTab(tab)} aria-pressed={activeTab === tab} className={`flex-1 py-3 px-2 text-xs sm:text-sm font-medium transition-colors ${activeTab === tab ? "bg-white/5 text-white border-b-2 border-amber-500" : "text-gray-400 hover:text-white"}`}>
              {tab === "ai" ? "Detection" : tab === "email" ? t.settings.emailTab : t.settings.telegramTab}
            </button>
          ))}
        </div>
        <div className="p-5 space-y-4 overflow-y-auto">
          {message && <div role={message.type === "error" ? "alert" : "status"} className={`p-3 rounded text-sm ${message.type === "success" ? "bg-green-500/10 text-green-400" : "bg-red-500/10 text-red-400"}`}>{message.text}</div>}
          {fetching && <p className="text-sm text-gray-400" role="status">Loading settings…</p>}
          {!fetching && !settingsLoaded && <button type="button" onClick={() => { setFetching(true); setMessage(null); setLoadAttempt((previous) => previous + 1); }} className="text-sm text-white bg-gray-800 hover:bg-gray-700 rounded px-3 py-2">Retry loading settings</button>}
          {activeTab === "email" && (
            <div className="space-y-4">
              <label className="flex items-center gap-3 text-white text-sm"><input type="checkbox" name="email_enabled" checked={settings.email_enabled === "true"} onChange={handleChange} className="accent-amber-500" />{t.settings.enableEmail}</label>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{textField("smtp_server", t.settings.smtpServer, "text", "smtp.gmail.com")}{textField("smtp_port", t.settings.smtpPort, "number", "587")}</div>
              {textField("smtp_user", t.settings.senderEmail, "email")}
              {textField("smtp_password", t.settings.senderPassword, "password")}
              {textField("receiver_email", t.settings.receiverEmail, "email")}
            </div>
          )}
          {activeTab === "telegram" && (
            <div className="space-y-4">
              <label className="flex items-center gap-3 text-white text-sm"><input type="checkbox" name="telegram_enabled" checked={settings.telegram_enabled === "true"} onChange={handleChange} className="accent-blue-500" />{t.settings.enableTelegram}</label>
              <div className="bg-blue-500/10 p-3 rounded text-xs text-blue-300 whitespace-pre-line">{t.settings.telegramHelp}</div>
              {textField("telegram_bot_token", t.settings.botToken, "password")}
              {textField("telegram_chat_id", t.settings.chatId)}
            </div>
          )}
          {activeTab === "ai" && (
            <div className="space-y-5">
              <div className="rounded-xl bg-white/5 border border-white/10 p-3 text-xs text-gray-300 space-y-2">
                {model ? <><p>Model: <span className="font-mono text-white">{model.model_name}</span></p><p>Available classes: {model.classes.join(", ") || "None"}</p>{!model.smoke_supported && <p className="text-amber-300">This model does not detect smoke. A smoke threshold only takes effect when a smoke-capable model is loaded.</p>}</> : <p>{modelError || "Loading model capabilities…"}</p>}
              </div>
              <label className="flex items-center gap-3 text-white text-sm"><input type="checkbox" name="alarm_sound_enabled" checked={settings.alarm_sound_enabled === "true"} onChange={handleChange} className="accent-amber-500" />Enable siren sound alarm</label>
              <div className="space-y-2">
                <label htmlFor="ai_confidence_threshold" className="flex justify-between text-xs text-gray-300"><span>Global confidence threshold</span><span className="font-mono text-amber-400">{Math.round(Number(settings.ai_confidence_threshold) * 100)}%</span></label>
                <input id="ai_confidence_threshold" type="range" name="ai_confidence_threshold" min="0" max="1" step="0.01" value={settings.ai_confidence_threshold} onChange={handleChange} className="w-full accent-amber-500" />
                <p className="text-xs text-gray-500">Lower values detect more candidates; higher values require greater model confidence.</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {(["ai_fire_confidence_threshold", "ai_smoke_confidence_threshold"] as const).map((key) => <div key={key} className="space-y-2"><label htmlFor={key} className="text-xs text-gray-300">{key === "ai_fire_confidence_threshold" ? "Fire" : "Smoke"} confidence override</label><input id={key} name={key} type="number" min="0" max="1" step="0.01" value={settings[key]} onChange={handleChange} placeholder={`Inherit ${settings.ai_confidence_threshold}`} className={inputClass} /><p className="text-xs text-gray-500">Leave empty to use the global threshold.</p></div>)}
                <div className="space-y-2"><label htmlFor="ai_iou_threshold" className="text-xs text-gray-300">IoU threshold</label><input id="ai_iou_threshold" name="ai_iou_threshold" type="number" min="0" max="1" step="0.01" value={settings.ai_iou_threshold} onChange={handleChange} className={inputClass} /><p className="text-xs text-gray-500">Controls suppression of overlapping detection boxes.</p></div>
                <div className="space-y-2"><label htmlFor="ai_persistence_frames" className="text-xs text-gray-300">Verification frame count</label><input id="ai_persistence_frames" name="ai_persistence_frames" type="number" min="1" max="120" step="1" value={settings.ai_persistence_frames} onChange={handleChange} className={inputClass} /><p className="text-xs text-gray-500">Consecutive detected frames required to trigger an alarm (1–120).</p></div>
                <div className="space-y-2"><label htmlFor="ai_cooldown_seconds" className="text-xs text-gray-300">Alarm cooldown (seconds)</label><input id="ai_cooldown_seconds" name="ai_cooldown_seconds" type="number" min="0" step="0.1" value={settings.ai_cooldown_seconds} onChange={handleChange} className={inputClass} /><p className="text-xs text-gray-500">Minimum time between notifications for the same camera.</p></div>
              </div>
            </div>
          )}
        </div>
        <div className="p-5 border-t border-white/5 flex justify-end gap-3 bg-black/20">
          {activeTab !== "ai" && <button type="button" onClick={handleTest} disabled={loading || fetching || !settingsLoaded} className="px-4 py-2 bg-gray-800 hover:bg-gray-700 text-white rounded text-sm disabled:opacity-50">{t.settings.test}</button>}
          <button type="button" onClick={handleSave} disabled={loading || fetching || !settingsLoaded} className="px-4 py-2 bg-white text-black hover:bg-gray-200 rounded text-sm font-medium disabled:opacity-50">{loading ? "Saving…" : t.settings.save}</button>
        </div>
      </div>
    </div>
  );
};

export default SettingsModal;
