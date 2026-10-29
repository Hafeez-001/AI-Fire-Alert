"use client";

import React, { useEffect, useId, useRef, useState } from 'react';
import { useLanguage } from '../context/LanguageContext';
import { API_URL } from '../config';

interface HistoryEvent {
  id: number;
  timestamp: string;
  type: string;
  confidence: number;
  snapshot_path: string | null;
  camera_id: number | null;
  camera_name: string | null;
}

interface Camera {
  id: number;
  name: string;
}

interface Filters {
  event_type: string;
  camera_id: string;
  start_date: string;
  end_date: string;
  min_confidence: string;
}

interface HistoryModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const PAGE_SIZE = 25;
const EMPTY_FILTERS: Filters = {
  event_type: '', camera_id: '', start_date: '', end_date: '', min_confidence: '',
};
const inputClass = 'w-full rounded-lg border border-white/10 bg-[#151515] px-3 py-2 text-sm text-white focus:border-blue-400 focus:outline-none [color-scheme:dark]';
const buttonClass = 'rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-200 hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';

const HistoryModal = ({ isOpen, onClose }: HistoryModalProps) => {
  const { t } = useLanguage();
  const titleId = useId();
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [retry, setRetry] = useState(0);
  const [selectedEvent, setSelectedEvent] = useState<HistoryEvent | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const exportController = useRef<AbortController | null>(null);

  const filterError = filters.start_date && filters.end_date && filters.start_date > filters.end_date
    ? 'The end date must be on or after the start date.'
    : filters.min_confidence !== '' && (!Number.isFinite(Number(filters.min_confidence)) || Number(filters.min_confidence) < 0 || Number(filters.min_confidence) > 100)
      ? 'Minimum confidence must be between 0 and 100%.'
      : null;
  const params = new URLSearchParams();
  for (const key of ['event_type', 'camera_id', 'start_date', 'end_date'] as const) {
    if (filters[key]) params.set(key, filters[key]);
  }
  if (filters.min_confidence !== '') params.set('min_confidence', String(Number(filters.min_confidence) / 100));
  const filterQuery = params.toString();

  useEffect(() => {
    if (!isOpen || filterError) return;
    const controller = new AbortController();
    const fetchHistory = async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${API_URL}/history?${filterQuery}&limit=${PAGE_SIZE}&offset=${offset}`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Could not load event history (HTTP ${response.status}).`);
        const data = await response.json();
        if (controller.signal.aborted) return;
        setEvents(data.events);
        setTotal(data.total);
      } catch (failure) {
        if (controller.signal.aborted) return;
        setError(failure instanceof Error ? failure.message : 'Could not load event history.');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    };
    void fetchHistory();
    return () => controller.abort();
  }, [isOpen, filterQuery, offset, filterError, retry]);

  useEffect(() => {
    if (!isOpen) return;
    const controller = new AbortController();
    const fetchCameras = async () => {
      try {
        const response = await fetch(`${API_URL}/cameras`, { signal: controller.signal });
        if (!response.ok) throw new Error(`Could not load camera filters (HTTP ${response.status}).`);
        const data = await response.json();
        if (controller.signal.aborted) return;
        setCameras(data.cameras);
        setCameraError(null);
      } catch (failure) {
        if (!controller.signal.aborted) setCameraError(failure instanceof Error ? failure.message : 'Could not load camera filters.');
      }
    };
    void fetchCameras();
    return () => controller.abort();
  }, [isOpen, retry]);

  useEffect(() => {
    if (!isOpen) return;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelAnimationFrame(frame);
      exportController.current?.abort();
      previousFocus?.focus();
    };
  }, [isOpen]);

  const updateFilters = (updates: Partial<Filters>) => {
    exportController.current?.abort();
    setExportError(null);
    setSelectedEvent(null);
    setOffset(0);
    setFilters(current => ({ ...current, ...updates }));
  };

  const changePage = (nextOffset: number) => {
    setSelectedEvent(null);
    setOffset(nextOffset);
  };

  const exportHistory = async () => {
    const controller = new AbortController();
    exportController.current = controller;
    setExporting(true);
    setExportError(null);
    try {
      const response = await fetch(`${API_URL}/history/export.csv?${filterQuery}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`Could not export event history (HTTP ${response.status}).`);
      const blob = await response.blob();
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'fire-guard-history.csv';
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Give the browser time to start reading the download before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (failure) {
      if (!controller.signal.aborted) setExportError(failure instanceof Error ? failure.message : 'Could not export event history.');
    } finally {
      if (exportController.current === controller) {
        exportController.current = null;
        setExporting(false);
      }
    }
  };

  const handleKeyboard = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
    }
    if (event.key !== 'Tab') return;
    const controls = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex="0"]');
    if (!controls?.length) return;
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-2 backdrop-blur-sm sm:p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={handleKeyboard} className="flex h-[90dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-white/10 bg-[#0a0a0a] shadow-2xl shadow-red-900/10">
        <div className="flex shrink-0 items-center justify-between border-b border-white/5 p-4 sm:p-6">
          <h2 id={titleId} className="text-xl font-bold tracking-tight text-white sm:text-2xl">{t.history.title}</h2>
          <button ref={closeRef} onClick={onClose} aria-label="Close event history" className="rounded-full p-2 text-gray-400 transition-colors hover:bg-white/5 hover:text-white">
            <svg aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="m18 6-12 12M6 6l12 12" /></svg>
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-3 border-b border-white/5 p-4 sm:px-6">
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
              <label className="space-y-1 text-xs text-gray-400">Event type
                <select value={filters.event_type} onChange={event => updateFilters({ event_type: event.target.value })} className={inputClass}>
                  <option value="">All types</option><option value="fire">Fire</option><option value="smoke">Smoke</option>
                </select>
              </label>
              <label className="space-y-1 text-xs text-gray-400">Camera
                <select value={filters.camera_id} onChange={event => updateFilters({ camera_id: event.target.value })} className={inputClass}>
                  <option value="">All cameras</option>
                  {cameras.map(camera => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-xs text-gray-400">From date
                <input type="date" value={filters.start_date} onChange={event => updateFilters({ start_date: event.target.value })} className={inputClass} />
              </label>
              <label className="space-y-1 text-xs text-gray-400">Through date
                <input type="date" value={filters.end_date} min={filters.start_date || undefined} onChange={event => updateFilters({ end_date: event.target.value })} className={inputClass} />
              </label>
              <label className="col-span-2 space-y-1 text-xs text-gray-400 lg:col-span-1">Minimum confidence (%)
                <input type="number" min="0" max="100" step="1" placeholder="Any confidence" value={filters.min_confidence} onChange={event => updateFilters({ min_confidence: event.target.value })} className={inputClass} />
              </label>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-gray-500">Dates include the full selected day. CSV includes every matching event.</p>
              <div className="flex gap-2">
                <button onClick={() => updateFilters(EMPTY_FILTERS)} className={buttonClass}>Reset filters</button>
                <button onClick={() => void exportHistory()} disabled={exporting || Boolean(filterError)} className={buttonClass}>{exporting ? 'Exporting…' : 'Export CSV'}</button>
              </div>
            </div>
            {filterError && <p role="alert" className="text-sm text-amber-400">{filterError}</p>}
            {cameraError && <p role="alert" className="text-sm text-amber-400">{cameraError} Event history is still available.</p>}
            {exportError && <p role="alert" className="text-sm text-red-400">{exportError}</p>}
          </div>

          <div className="flex flex-col gap-4 p-4 sm:p-6 lg:flex-row lg:gap-6">
            <div className="min-w-0 flex-1 space-y-4">
              <div aria-busy={loading} className="min-h-48 overflow-x-auto">
                {filterError ? (
                  <p className="py-16 text-center text-sm text-gray-500">Update the filters to load matching events.</p>
                ) : loading ? (
                  <p role="status" className="py-16 text-center text-gray-500">{t.common.loading}</p>
                ) : error ? (
                  <div role="alert" className="space-y-3 py-12 text-center"><p className="text-sm text-red-400">{error}</p><button onClick={() => setRetry(current => current + 1)} className={buttonClass}>Retry</button></div>
                ) : events.length === 0 ? (
                  <p role="status" className="py-16 text-center text-gray-500">{t.history.noEvents}</p>
                ) : (
                  <table className="w-full text-left text-sm text-gray-400">
                    <caption className="sr-only">Matching detection events</caption>
                    <thead className="bg-white/5 text-xs font-semibold uppercase text-gray-300">
                      <tr><th scope="col" className="px-3 py-3">{t.history.time}</th><th scope="col" className="px-3 py-3">Camera</th><th scope="col" className="px-3 py-3">{t.history.type}</th><th scope="col" className="px-3 py-3">{t.history.confidence}</th><th scope="col" className="px-3 py-3 text-right">{t.history.action}</th></tr>
                    </thead>
                    <tbody className="divide-y divide-white/5">
                      {events.map(event => (
                        <tr key={event.id} className={selectedEvent?.id === event.id ? 'bg-blue-500/10' : 'hover:bg-white/5'}>
                          <td className="whitespace-nowrap px-3 py-3 font-mono text-xs text-white/80">{event.timestamp}</td>
                          <td className="px-3 py-3">{event.camera_name || (event.camera_id !== null ? `Camera #${event.camera_id}` : 'Unknown camera')}</td>
                          <td className="px-3 py-3"><span className={`rounded border px-2 py-1 text-xs font-medium ${event.type === 'fire' ? 'border-red-500/20 bg-red-500/10 text-red-400' : 'border-orange-500/20 bg-orange-500/10 text-orange-400'}`}>{event.type.toUpperCase()}</span></td>
                          <td className="px-3 py-3 text-white">{(event.confidence * 100).toFixed(1)}%</td>
                          <td className="px-3 py-3 text-right">{event.snapshot_path ? <button onClick={() => setSelectedEvent(event)} aria-label={`View snapshot for ${event.camera_name || 'camera'}, ${event.timestamp}`} aria-pressed={selectedEvent?.id === event.id} className="whitespace-nowrap rounded px-2 py-1 text-xs text-blue-400 hover:bg-blue-500/10 hover:text-blue-300">{t.history.viewSnapshot}</button> : <span className="text-xs text-gray-600">No snapshot</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-white/5 pt-3">
                <p aria-live="polite" className="text-xs text-gray-400">{!loading && !error && !filterError ? `${total === 0 || events.length === 0 ? 0 : offset + 1}–${Math.min(offset + events.length, total)} of ${total} events` : 'Event history'}</p>
                <div className="flex gap-2"><button onClick={() => changePage(Math.max(0, offset - PAGE_SIZE))} disabled={loading || Boolean(error || filterError) || offset === 0} className={buttonClass}>Previous</button><button onClick={() => changePage(offset + PAGE_SIZE)} disabled={loading || Boolean(error || filterError) || offset + PAGE_SIZE >= total} className={buttonClass}>Next</button></div>
              </div>
            </div>

            <div className="flex w-full shrink-0 flex-col items-center justify-center rounded-xl border border-white/5 bg-black/20 p-4 text-center lg:w-1/3 lg:self-start">
              {selectedEvent?.snapshot_path ? (
                <div className="w-full space-y-4">
                  <div className="overflow-hidden rounded-lg border border-white/10">
                    {/* Event images are served by the configured backend at runtime. */}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={`${API_URL}${selectedEvent.snapshot_path}`} alt={`Detection snapshot from ${selectedEvent.camera_name || 'unknown camera'} at ${selectedEvent.timestamp}`} className="max-h-[40vh] w-full object-contain" />
                  </div>
                  <div className="space-y-1 text-left"><p className="text-xs uppercase tracking-wider text-gray-500">{t.history.selectedRecord}</p><p className="text-sm text-white">{selectedEvent.camera_name || 'Unknown camera'}</p><p className="break-all font-mono text-xs text-gray-400">{selectedEvent.timestamp}</p></div>
                  <button onClick={() => setSelectedEvent(null)} className={buttonClass}>Close preview</button>
                </div>
              ) : (
                <p className="py-8 text-sm text-gray-600">{t.history.clickToView}</p>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HistoryModal;
