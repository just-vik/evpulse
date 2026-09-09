'use client'

import React, { useEffect, useRef, useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import 'maplibre-gl/dist/maplibre-gl.css'
import { registerPmtilesProtocol, buildDarkStyle } from '@/lib/basemap'

// Decode Google-encoded polyline → [lat, lng] pairs
function decodePolyline(encoded: string): [number, number][] {
  const coords: [number, number][] = []
  let index = 0, lat = 0, lng = 0
  while (index < encoded.length) {
    let b, shift = 0, result = 0
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lat += result & 1 ? ~(result >> 1) : result >> 1
    shift = 0; result = 0
    do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5 } while (b >= 0x20)
    lng += result & 1 ? ~(result >> 1) : result >> 1
    coords.push([lat / 1e5, lng / 1e5])
  }
  return coords
}

interface Props {
  polyline: string
  repairReason?: string
  height?: number
}

export default function TripMapGL({ polyline, repairReason, height = 160 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const { i18n } = useTranslation()

  // Decode once per polyline change — avoids re-parsing on every parent render.
  const lnglats = useMemo<[number, number][]>(() => {
    const coords = decodePolyline(polyline)
    return coords.map(([lat, lng]) => [lng, lat])
  }, [polyline])

  useEffect(() => {
    if (!containerRef.current) return
    if (lnglats.length === 0) return

    const singlePoint = lnglats.length === 1
    const isReconstructed = repairReason?.includes('reconstructed_from_gps_teleport') ?? false
    let cancelled = false

    ;(async () => {
      try {
        const maplibregl = (await import('maplibre-gl')).default
        await registerPmtilesProtocol(maplibregl)

        if (cancelled || !containerRef.current) return

        const map = new maplibregl.Map({
          container: containerRef.current,
          style:     buildDarkStyle(i18n.language) as any,
          interactive:        true,
          attributionControl: false,
          logoPosition:       'bottom-right',
        })

        if (singlePoint) {
          map.setCenter(lnglats[0])
          map.setZoom(13)
        } else {
          const lngs = lnglats.map(c => c[0])
          const lats = lnglats.map(c => c[1])
          const bounds: [[number, number], [number, number]] = [
            [Math.min(...lngs), Math.min(...lats)],
            [Math.max(...lngs), Math.max(...lats)],
          ]
          map.fitBounds(bounds, { padding: 36, animate: false, maxZoom: 15 })
        }

        map.on('load', () => {
          if (cancelled) return

          if (!singlePoint) {
            // Route line — dashed amber for reconstructed, solid blue for real GPS
            const lineColor = isReconstructed ? '#f59e0b' : '#3b82f6'
            const haloColor = isReconstructed ? '#92400e' : '#1d4ed8'

            map.addSource('route', {
              type: 'geojson',
              data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: lnglats } },
            })
            map.addLayer({
              id: 'route-halo',
              type: 'line',
              source: 'route',
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: { 'line-color': haloColor, 'line-width': 6, 'line-opacity': 0.3 },
            })
            map.addLayer({
              id: 'route-line',
              type: 'line',
              source: 'route',
              layout: { 'line-join': 'round', 'line-cap': 'round' },
              paint: {
                'line-color': lineColor,
                'line-width': 3,
                ...(isReconstructed ? { 'line-dasharray': [3, 2] } : {}),
              },
            })
          }

          // Start dot (green) — or single-point location dot (amber)
          map.addSource('start-pt', {
            type: 'geojson',
            data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: lnglats[0] } },
          })
          map.addLayer({
            id: 'start-dot',
            type: 'circle',
            source: 'start-pt',
            paint: {
              'circle-radius': 7,
              'circle-color': singlePoint ? '#f59e0b' : '#22c55e',
              'circle-stroke-color': '#fff',
              'circle-stroke-width': 1.5,
            },
          })

          if (!singlePoint) {
            // End dot (red)
            map.addSource('end-pt', {
              type: 'geojson',
              data: { type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: lnglats[lnglats.length - 1] } },
            })
            map.addLayer({
              id: 'end-dot',
              type: 'circle',
              source: 'end-pt',
              paint: { 'circle-radius': 6, 'circle-color': '#ef4444', 'circle-stroke-color': '#fff', 'circle-stroke-width': 1.5 },
            })
          }
        })

        mapRef.current = map
      } catch (e) {
        // maplibre not available — component renders nothing
      }
    })()

    return () => {
      cancelled = true
      mapRef.current?.remove()
      mapRef.current = null
    }
  }, [lnglats, repairReason, i18n.language])

  if (lnglats.length === 0) {
    return (
      <div
        style={{ width: '100%', height, borderRadius: 8 }}
        className="bg-slate-900/60 flex items-center justify-center"
      >
        <span className="text-xs text-slate-500">No route data</span>
      </div>
    )
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height, borderRadius: 8, overflow: 'hidden' }}
      className="bg-slate-900"
    />
  )
}
