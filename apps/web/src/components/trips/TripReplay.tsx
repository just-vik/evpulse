'use client';

import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { motion, AnimatePresence } from 'framer-motion';
import { Play, Pause, RotateCcw, X } from 'lucide-react';
import { apiClient } from '@/lib/api';
import { useAuthStore } from '@/stores/authStore';
import 'maplibre-gl/dist/maplibre-gl.css';

type TripPoint = {
  t: string;
  lat: number;
  lng: number;
  spd: number | null;
  pwr: number | null;
  soc: number | null;
};

type POIType = 'slow' | 'regen' | 'boost';
interface POI { idx: number; type: POIType; lat: number; lng: number }

const DARK_STYLE = {
  version: 8 as const,
  sources: {
    carto: {
      type: 'raster' as const,
      tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}@2x.png'],
      tileSize: 256,
      attribution: '© OpenStreetMap © CARTO',
    },
  },
  layers: [{ id: 'base', type: 'raster' as const, source: 'carto' }],
};

function lerp(a: number, b: number, t: number) { return a + (b - a) * t; }

function calcBearing(from: TripPoint, to: TripPoint): number {
  const toRad = (d: number) => d * Math.PI / 180;
  const dLng = toRad(to.lng - from.lng);
  const lat1 = toRad(from.lat), lat2 = toRad(to.lat);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function detectPOIs(points: TripPoint[]): POI[] {
  const pois: POI[] = [];
  const n = points.length;
  let i = 0;
  while (i < n) {
    const p = points[i];
    if (i > 5 && (p.spd ?? 999) < 10) {
      let j = i;
      while (j < n && (points[j].spd ?? 999) < 10) j++;
      if (j - i >= 3) pois.push({ idx: Math.floor((i + j) / 2), type: 'slow', lat: p.lat, lng: p.lng });
      i = j;
      continue;
    }
    if ((p.pwr ?? 0) < -8) {
      let j = i;
      while (j < n && (points[j].pwr ?? 0) < -8) j++;
      if (j - i >= 4) pois.push({ idx: Math.floor((i + j) / 2), type: 'regen', lat: p.lat, lng: p.lng });
      i = j;
      continue;
    }
    if ((p.pwr ?? 0) > 50) {
      let j = i;
      while (j < n && (points[j].pwr ?? 0) > 50) j++;
      if (j - i >= 3) pois.push({ idx: Math.floor((i + j) / 2), type: 'boost', lat: p.lat, lng: p.lng });
      i = j;
      continue;
    }
    i++;
  }
  return pois;
}

const POI_CONFIG: Record<POIType, { emoji: string; color: string }> = {
  slow:  { emoji: '🐢', color: '#f59e0b' },
  regen: { emoji: '⚡', color: '#34d399' },
  boost: { emoji: '🚀', color: '#818cf8' },
};

interface Props {
  tripId: string;
  onClose: () => void;
}

export function TripReplay({ tripId, onClose }: Props) {
  const { accessToken } = useAuthStore();

  const { data, isLoading, error } = useQuery({
    queryKey: ['trip-points', tripId],
    queryFn: () => apiClient.getTripPoints(tripId, accessToken ?? ''),
    staleTime: 30 * 60_000,
    enabled: !!tripId && !!accessToken,
  });

  const points: TripPoint[] = data?.points ?? [];
  const total = Math.max(1, points.length - 1);

  const pois = useMemo(() => detectPOIs(points), [points]);

  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);
  const playRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPlay = useCallback(() => {
    if (playRef.current) { clearInterval(playRef.current); playRef.current = null; }
    setPlaying(false);
  }, []);

  const startPlay = useCallback(() => {
    if (frame >= total) setFrame(0);
    setPlaying(true);
    playRef.current = setInterval(() => {
      setFrame(prev => {
        if (prev >= total) { stopPlay(); return total; }
        return prev + 1;
      });
    }, 80);
  }, [frame, total, stopPlay]);

  useEffect(() => () => stopPlay(), [stopPlay]);
  useEffect(() => { if (frame >= total && playing) stopPlay(); }, [frame, total, playing, stopPlay]);

  // ── Map ────────────────────────────────────────────────────────────────────
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const markerRef = useRef<any>(null);
  const markerElRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!mapContainerRef.current || points.length < 2) return;
    let cancelled = false;

    (async () => {
      try {
        const maplibregl = (await import('maplibre-gl')).default;
        if (cancelled || mapRef.current) return;

        const coords: [number, number][] = points.map(p => [p.lng, p.lat]);
        const lngs = coords.map(c => c[0]);
        const lats = coords.map(c => c[1]);
        const bounds: [[number, number], [number, number]] = [
          [Math.min(...lngs) - 0.002, Math.min(...lats) - 0.002],
          [Math.max(...lngs) + 0.002, Math.max(...lats) + 0.002],
        ];

        const map = new maplibregl.Map({
          container: mapContainerRef.current!,
          style: DARK_STYLE,
          bounds,
          fitBoundsOptions: { padding: 32 },
          attributionControl: false,
        });
        mapRef.current = map;

        map.on('load', () => {
          if (cancelled) return;

          map.addSource('route', {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: {} },
          });
          map.addLayer({ id: 'route-line', type: 'line', source: 'route',
            paint: { 'line-color': '#38bdf8', 'line-width': 3, 'line-opacity': 0.45 } });

          map.addSource('progress', {
            type: 'geojson',
            data: { type: 'Feature', geometry: { type: 'LineString', coordinates: [] }, properties: {} },
          });
          map.addLayer({ id: 'progress-line', type: 'line', source: 'progress',
            paint: { 'line-color': '#38bdf8', 'line-width': 4 } });

          // Directional car marker (arrow pointing forward)
          const el = document.createElement('div') as HTMLDivElement;
          el.innerHTML = `<svg width="18" height="22" viewBox="0 0 18 22" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M9 0L18 18L9 14L0 18Z" fill="#38bdf8" stroke="white" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>`;
          el.style.cssText = 'width:18px;height:22px;transform-origin:9px 11px;filter:drop-shadow(0 0 5px rgba(56,189,248,0.7));';
          markerElRef.current = el;

          const marker = new maplibregl.Marker({ element: el, anchor: 'center' })
            .setLngLat(coords[0])
            .addTo(map);
          markerRef.current = marker;

          // POI markers
          pois.forEach(poi => {
            const cfg = POI_CONFIG[poi.type];
            const poiEl = document.createElement('div');
            poiEl.innerHTML = `<span style="font-size:13px;line-height:1">${cfg.emoji}</span>`;
            poiEl.style.cssText = [
              'width:22px;height:22px;border-radius:50%;',
              `background:${cfg.color}22;border:1px solid ${cfg.color}55;`,
              'display:flex;align-items:center;justify-content:center;',
              'cursor:default;user-select:none;',
            ].join('');

            new maplibregl.Marker({ element: poiEl, anchor: 'center' })
              .setLngLat([poi.lng, poi.lat])
              .addTo(map);
          });
        });
      } catch { /* maplibre unavailable */ }
    })();

    return () => {
      cancelled = true;
      mapRef.current?.remove();
      mapRef.current = null;
      markerRef.current = null;
      markerElRef.current = null;
    };
  }, [points.length, pois]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Sync frame → map marker + progress line ───────────────────────────────
  useEffect(() => {
    if (!mapRef.current || points.length < 2) return;
    const map = mapRef.current;
    if (!map.isStyleLoaded()) return;

    const p = points[frame];
    markerRef.current?.setLngLat([p.lng, p.lat]);

    // Rotate marker to face direction of travel
    if (markerElRef.current && frame > 0) {
      const hdg = calcBearing(points[frame - 1], points[frame]);
      markerElRef.current.style.transform = `rotate(${hdg}deg)`;
    }

    const progressCoords = points.slice(0, frame + 1).map(pt => [pt.lng, pt.lat] as [number, number]);
    const src = map.getSource('progress') as any;
    src?.setData({ type: 'Feature', geometry: { type: 'LineString', coordinates: progressCoords }, properties: {} });
  }, [frame, points]);

  // ── Current point stats ────────────────────────────────────────────────────
  const cur = points[frame];
  const elapsed = cur && data?.startTime
    ? Math.round((new Date(cur.t).getTime() - new Date(data.startTime).getTime()) / 1000)
    : 0;
  const elapsedStr = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;

  // Active POI near current frame (within ±5 frames)
  const activePOI = pois.find(p => Math.abs(p.idx - frame) <= 5);

  // ── Mini chart data ────────────────────────────────────────────────────────
  const chartData = useMemo(() => points.map((p, i) => ({
    i,
    spd: p.spd ?? 0,
    pwr: p.pwr ?? 0,
    soc: p.soc ?? 0,
  })), [points]);

  if (isLoading) {
    return (
      <div className="spatial-card rounded-2xl p-4 space-y-3">
        <div className="h-[280px] rounded-xl bg-[var(--s-2)] animate-pulse" />
        <div className="h-4 rounded bg-[var(--s-2)] animate-pulse" />
      </div>
    );
  }

  if (error || points.length < 2) {
    return (
      <div className="spatial-card rounded-2xl p-4 flex items-center justify-between">
        <p className="text-sm text-[var(--s-text-muted)]">
          {points.length < 2 ? 'No GPS data available for this trip.' : 'Failed to load trip points.'}
        </p>
        <button onClick={onClose} className="text-[var(--s-text-muted)] hover:text-[var(--s-text)]">
          <X size={16} />
        </button>
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 4 }}
      className="spatial-card rounded-2xl overflow-hidden"
    >
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-1">
        <div className="flex items-center gap-2">
          <p className="text-xs font-semibold uppercase tracking-widest text-[var(--s-text-muted)]">
            Trip Replay
          </p>
          <AnimatePresence>
            {activePOI && (
              <motion.span
                key={activePOI.idx}
                initial={{ opacity: 0, scale: 0.7 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.7 }}
                className="text-[11px] px-1.5 py-0.5 rounded-full font-medium"
                style={{
                  background: `${POI_CONFIG[activePOI.type].color}22`,
                  color: POI_CONFIG[activePOI.type].color,
                  border: `1px solid ${POI_CONFIG[activePOI.type].color}44`,
                }}
              >
                {POI_CONFIG[activePOI.type].emoji}&nbsp;
                {activePOI.type === 'slow' ? 'Traffic' : activePOI.type === 'regen' ? 'Regen zone' : 'Acceleration'}
              </motion.span>
            )}
          </AnimatePresence>
        </div>
        <button onClick={onClose} className="w-6 h-6 flex items-center justify-center rounded-lg text-[var(--s-text-muted)] hover:text-[var(--s-text)] hover:bg-[var(--s-2)] transition">
          <X size={14} />
        </button>
      </div>

      {/* Map */}
      <div ref={mapContainerRef} style={{ height: 280 }} className="w-full" />

      {/* Stats bar */}
      <div className="flex items-center gap-4 px-4 py-2 border-t border-[var(--s-border-sub)] text-xs text-[var(--s-text-muted)]">
        <span className="tabular-nums font-medium text-[var(--s-text)]">{elapsedStr}</span>
        {cur?.spd != null && (
          <span className="tabular-nums">{Math.round(cur.spd)} <span className="text-[var(--s-text-muted)]">km/h</span></span>
        )}
        {cur?.pwr != null && (
          <span className={`tabular-nums ${cur.pwr < 0 ? 'text-[var(--c-success)]' : ''}`}>
            {cur.pwr > 0 ? '+' : ''}{cur.pwr.toFixed(1)} <span className="text-[var(--s-text-muted)]">kW</span>
          </span>
        )}
        {cur?.soc != null && (
          <span className="tabular-nums">{Math.round(cur.soc)}<span className="text-[var(--s-text-muted)]">%</span></span>
        )}
        {pois.length > 0 && (
          <span className="ml-auto text-[var(--s-text-muted)]">
            {pois.filter(p => p.type === 'slow').length > 0 && `🐢×${pois.filter(p => p.type === 'slow').length} `}
            {pois.filter(p => p.type === 'regen').length > 0 && `⚡×${pois.filter(p => p.type === 'regen').length} `}
            {pois.filter(p => p.type === 'boost').length > 0 && `🚀×${pois.filter(p => p.type === 'boost').length}`}
          </span>
        )}
      </div>

      {/* Scrubber */}
      <div className="px-4 pb-1">
        <input
          type="range"
          min={0}
          max={total}
          value={frame}
          onChange={e => { stopPlay(); setFrame(Number(e.target.value)); }}
          className="w-full h-1.5 rounded-full cursor-pointer"
          style={{ accentColor: 'var(--a-500)' }}
        />
      </div>

      {/* Mini chart (speed + power + SOC) */}
      {chartData.length > 1 && (
        <MiniChart data={chartData} frame={frame} total={total} />
      )}

      {/* Controls */}
      <div className="flex items-center justify-center gap-3 pb-3 pt-1">
        <button
          onClick={() => { stopPlay(); setFrame(0); }}
          className="w-8 h-8 flex items-center justify-center rounded-lg text-[var(--s-text-muted)] hover:text-[var(--s-text)] hover:bg-[var(--s-2)] transition"
        >
          <RotateCcw size={14} />
        </button>
        <button
          onClick={playing ? stopPlay : startPlay}
          className="w-10 h-10 flex items-center justify-center rounded-xl bg-[var(--a-tint)] text-[var(--a-400)] hover:bg-[color-mix(in_oklch,var(--a-500)_20%,transparent)] transition"
        >
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
      </div>
    </motion.div>
  );
}

// ── Canvas mini-chart (speed + power + SOC) ───────────────────────────────────
function MiniChart({ data, frame, total }: {
  data: { i: number; spd: number; pwr: number; soc: number }[];
  frame: number;
  total: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const w = canvas.width;
    const h = canvas.height;
    ctx.clearRect(0, 0, w, h);

    const maxSpd = Math.max(...data.map(d => d.spd), 1);
    const minPwr = Math.min(...data.map(d => d.pwr), 0);
    const maxPwr = Math.max(...data.map(d => d.pwr), 1);
    const minSoc = Math.min(...data.map(d => d.soc)) - 1;
    const maxSoc = Math.max(...data.map(d => d.soc)) + 1;

    const xOf = (i: number) => (i / total) * w;
    const ySpd = (v: number) => h * 0.9 - (v / maxSpd) * h * 0.38;
    const yPwr = (v: number) => h * 0.9 - ((v - minPwr) / (maxPwr - minPwr || 1)) * h * 0.38;
    const ySoc = (v: number) => h * 0.9 - ((v - minSoc) / (maxSoc - minSoc || 1)) * h * 0.38;

    const drawLine = (vals: number[], yFn: (v: number) => number, color: string) => {
      ctx.beginPath();
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.lineJoin = 'round';
      vals.forEach((v, i) => {
        i === 0 ? ctx.moveTo(xOf(i), yFn(v)) : ctx.lineTo(xOf(i), yFn(v));
      });
      ctx.stroke();
    };

    drawLine(data.map(d => d.spd), ySpd, 'rgba(56,189,248,0.7)');
    drawLine(data.map(d => d.pwr), yPwr, 'rgba(245,158,11,0.6)');
    drawLine(data.map(d => d.soc), ySoc, 'rgba(52,211,153,0.55)');

    // Playhead
    const px = xOf(frame);
    ctx.beginPath();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
    ctx.setLineDash([]);

    // Legend dots at right edge
    const legends = [
      { color: 'rgba(56,189,248,0.9)', label: 'spd' },
      { color: 'rgba(245,158,11,0.9)', label: 'pwr' },
      { color: 'rgba(52,211,153,0.9)', label: 'soc' },
    ];
    ctx.font = '9px system-ui';
    legends.forEach((l, i) => {
      const y = 8 + i * 13;
      ctx.fillStyle = l.color;
      ctx.fillRect(4, y - 3, 6, 2);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillText(l.label, 13, y);
    });
  }, [data, frame, total]);

  return (
    <canvas
      ref={canvasRef}
      width={600}
      height={52}
      className="w-full px-0"
      style={{ height: 52, display: 'block' }}
    />
  );
}
