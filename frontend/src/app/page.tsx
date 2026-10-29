"use client";

import CameraGrid from "@/components/CameraGrid";
import AlertPanel, { Alert } from "@/components/AlertPanel";
import StatsChart from "@/components/StatsChart";
import HistoryModal from "@/components/HistoryModal";
import SettingsModal from "@/components/SettingsModal";
import ImageAnalysisModal from "@/components/ImageAnalysisModal";
import { useEffect, useState } from "react";
import { useLanguage } from "@/context/LanguageContext";
import { API_URL, WS_URL } from "@/config";

const sameAlert = (first: Alert, second: Alert) => {
  if (first.id != null && second.id != null) return first.id === second.id;
  return first.timestamp === second.timestamp && first.type === second.type &&
    (first.camera_id ?? null) === (second.camera_id ?? null);
};

export default function Home() {
  const { t } = useLanguage();
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isAnalysisOpen, setIsAnalysisOpen] = useState(false);
  const [dailyCount, setDailyCount] = useState<number | null>(null);
  const [liveAlert, setLiveAlert] = useState<Alert | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchDailyCount = async () => {
      try {
        const response = await fetch(`${API_URL}/stats`);
        if (!response.ok) throw new Error("Statistics unavailable");
        const data = await response.json();
        if (!cancelled && typeof data.today_count === "number") setDailyCount(data.today_count);
      } catch {
        if (!cancelled) setDailyCount(null);
      }
    };
    void fetchDailyCount();
    // 1. Initial HTTP fetch for recent alerts
    const fetchAlerts = async () => {
      try {
        const res = await fetch(`${API_URL}/alerts`);
        if (!res.ok) throw new Error("Backend unavailable");
        const data = await res.json();
        if (cancelled) return;
        // Preserve live events received while the initial history request was pending.
        setAlerts(current => [
          ...current,
          ...data.alerts.filter((historical: Alert) => !current.some(alert => sameAlert(alert, historical))),
        ]);
        setError(false);
      } catch {
        if (cancelled) return;
        console.warn("Backend connection failed, trying WebSocket...");
        setError(true);
      }
    };
    fetchAlerts();

    // 2. Establish WebSocket connection for real-time updates
    let ws: WebSocket | null = null;
    let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;

    const connectWebSocket = () => {
      if (cancelled) return;
      ws = new WebSocket(`${WS_URL}/ws/alerts`);

      ws.onopen = () => {
        console.log("[WebSocket] Connected to FastAPI backend!");
        setError(false);
      };

      ws.onmessage = (event) => {
        try {
          const newAlert: Alert = JSON.parse(event.data);
          if (typeof newAlert.type !== "string" || typeof newAlert.confidence !== "number") return;
          setLiveAlert(newAlert);
          void fetchDailyCount();
          setAlerts(prevAlerts => {
            // Avoid duplicate additions in state
            if (prevAlerts.some(alert => sameAlert(alert, newAlert))) {
              return prevAlerts;
            }
            return [newAlert, ...prevAlerts];
          });
        } catch (e) {
          console.error("[WebSocket] Error parsing message:", e);
        }
      };

      ws.onerror = (err) => {
        console.warn("[WebSocket] Error:", err);
      };

      ws.onclose = () => {
        if (cancelled) return;
        setError(true);
        console.log("[WebSocket] Disconnected. Reconnecting in 3s...");
        reconnectTimeout = setTimeout(connectWebSocket, 3000);
      };
    };

    connectWebSocket();

    return () => {
      cancelled = true;
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
    };
  }, []);

  return (
    <main className="min-h-screen bg-[#050505] text-white p-4 md:p-6 lg:p-8 font-sans selection:bg-red-500/30">
      <HistoryModal isOpen={isHistoryOpen} onClose={() => setIsHistoryOpen(false)} />
      {isSettingsOpen && <SettingsModal isOpen onClose={() => setIsSettingsOpen(false)} />}
      <ImageAnalysisModal isOpen={isAnalysisOpen} onClose={() => setIsAnalysisOpen(false)} />
      
      {/* Navbar / Header */}
      <header className="mb-8 flex flex-wrap gap-4 items-center justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tighter bg-gradient-to-r from-white to-gray-500 bg-clip-text text-transparent">
            {t.header.title}
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            {t.header.subtitle}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setIsAnalysisOpen(true)}
            className="px-3 py-2 bg-blue-500/10 hover:bg-blue-500/20 rounded-lg border border-blue-500/20 text-sm font-medium"
          >
            Analyze Image
          </button>
          <button 
             onClick={() => setIsSettingsOpen(true)}
             className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg border border-white/5 transition-colors text-sm font-medium"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>
            {t.header.settings}
          </button>
          
          <button 
             onClick={() => setIsHistoryOpen(true)}
             className="flex items-center gap-2 px-4 py-2 bg-white/5 hover:bg-white/10 rounded-lg border border-white/5 transition-colors text-sm font-medium"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18"/><path d="M18.7 8l-5.1 5.2-2.8-2.7L7 14.3"/></svg>
            {t.header.history}
          </button>

          <div className={`hidden md:flex items-center gap-2 px-3 py-1 rounded-full border ${error ? "bg-amber-500/10 border-amber-500/20" : "bg-green-500/10 border-green-500/20"}`}>
            <div className={`w-2 h-2 rounded-full animate-pulse ${error ? "bg-amber-500" : "bg-green-500"}`} />
            <span className={`text-xs font-semibold ${error ? "text-amber-400" : "text-green-400"}`}>{error ? "Backend Disconnected" : t.header.systemActive}</span>
          </div>
        </div>
      </header>

      {/* Main Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 lg:h-[calc(100vh-140px)] lg:overflow-hidden">
        {/* Video Feed Section - Takes 2/3 width */}
        <div className="lg:col-span-2 min-h-[360px] lg:h-full flex flex-col gap-6 overflow-hidden">
          <div className="flex-1 rounded-2xl overflow-hidden bg-black border border-gray-800 relative p-2">
            <CameraGrid />
          </div>
          
           {/* Bottom Stats Area (Under Video) */}
           <div className="h-48 rounded-2xl bg-gray-900/50 border border-white/5 overflow-hidden hidden lg:block">
              <StatsChart />
           </div>
        </div>

        {/* Sidebar / Alerts - Takes 1/3 width */}
        <div className="min-h-[360px] lg:h-full flex flex-col gap-6 overflow-hidden">
          <div className="flex-1 min-h-0 bg-gray-900/50 backdrop-blur-xl border border-white/5 rounded-2xl overflow-hidden">
            <AlertPanel alerts={alerts} error={error} liveAlert={liveAlert} />
          </div>
          
          {/* Daily Count Widget */}
          <div className="h-32 shrink-0 rounded-2xl bg-gray-900/50 border border-white/5 p-4 flex flex-col justify-center items-center relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-br from-red-500/10 to-transparent opacity-0 group-hover:opacity-100 transition-opacity" />
            <span className="text-4xl font-bold text-white mb-2 relative z-10">{dailyCount ?? "—"}</span>
            <span className="text-xs text-gray-500 uppercase tracking-widest relative z-10">
              {t.stats.dailyCount}
            </span>
          </div>
        </div>
      </div>
    </main>
  );
};
