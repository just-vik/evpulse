// Self-hosted, no-API-key dark basemap for trip maps (web).
//
// Replaces the previous `a.basemaps.cartocdn.com/dark_all` raster CDN, which
// started requiring an API key and was rendering "API KEY REQUIRED"
// watermark tiles in production. This reads vector tiles directly from a
// locally-hosted PMTiles archive (regional OSM extract, built once via the
// `pmtiles` CLI against Protomaps' public daily build — see
// docs/ for the exact extract command) over HTTP range requests — no
// tile server process, no third-party account, no per-request cost.
//
// The archive must be reachable at PMTILES_URL (same-origin static file,
// range-request-capable — Next.js's own `public/` serving supports this).

import type { StyleSpecification } from 'maplibre-gl';
import { layers, DARK } from '@protomaps/basemaps';

const PMTILES_URL = '/maps/region.pmtiles';
const SOURCE_NAME = 'protomaps';

let protocolRegistered = false;

/** Registers the pmtiles:// URL scheme with MapLibre. Idempotent — safe to
 *  call from every map-mounting component; only wires the protocol once. */
export async function registerPmtilesProtocol(maplibregl: any) {
  if (protocolRegistered) return;
  const { Protocol } = await import('pmtiles');
  const protocol = new Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);
  protocolRegistered = true;
}

/** Builds the dark MapLibre style for trip maps. `lang` selects the label
 *  language (falls back to each place's local name when untranslated). */
export function buildDarkStyle(lang: string): StyleSpecification {
  return {
    version: 8,
    // Same-origin — self-hosted, downloaded once from protomaps/basemaps-assets
    // (apps/web/public/fonts, public/sprites), never fetched from a third party
    // at runtime.
    glyphs: '/fonts/{fontstack}/{range}.pbf',
    sprite: '/sprites/dark',
    sources: {
      [SOURCE_NAME]: {
        type: 'vector',
        url: `pmtiles://${PMTILES_URL}`,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      },
    },
    layers: layers(SOURCE_NAME, DARK, { lang }),
  } as StyleSpecification;
}
