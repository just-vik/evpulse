import polyline from '@mapbox/polyline';

export function decodePolylineToCoords(
  encoded: string | null | undefined,
): { latitude: number; longitude: number }[] {
  if (!encoded) return [];
  try {
    const decoded = polyline.decode(encoded);
    return decoded.map(([lat, lng]: [number, number]) => ({
      latitude: lat,
      longitude: lng,
    }));
  } catch {
    return [];
  }
}
