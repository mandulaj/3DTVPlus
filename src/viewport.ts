// Horizon-clipped 3D ground bounding box: prevents steep camera pitches (60–89°) from projecting
// screen corners hundreds of kilometres onto the horizon and triggering cell/API fetch storms.
import type * as maplibregl from 'maplibre-gl';

export interface Bounds {
  west: number;
  south: number;
  east: number;
  north: number;
}

const KM_PER_LAT = 111.32;

/** Clamps `bounds` to a sensible ground radius around `center` based on zoom level. */
export function clampBounds(bounds: Bounds, center: { lng: number; lat: number }, zoom: number, maxRadiusKm = 60): Bounds {
  // At z=10 ~40 km radius, z=12 ~16 km, z=14 ~6 km; capped at maxRadiusKm when zoomed out.
  const zoomRadiusKm = Math.min(maxRadiusKm, Math.max(4, 160 / 2 ** Math.max(0, zoom - 9)));
  const dLat = zoomRadiusKm / KM_PER_LAT;
  const cosLat = Math.max(0.1, Math.cos((center.lat * Math.PI) / 180));
  const dLng = zoomRadiusKm / (KM_PER_LAT * cosLat);
  return {
    west: Math.max(bounds.west, center.lng - dLng),
    south: Math.max(bounds.south, center.lat - dLat),
    east: Math.min(bounds.east, center.lng + dLng),
    north: Math.min(bounds.north, center.lat + dLat),
  };
}

/** Returns the map's visible bounds, clipped against 3D horizon explosion when tilted. */
export function groundBounds(map: maplibregl.Map, maxRadiusKm = 60): Bounds {
  const b = map.getBounds();
  const raw: Bounds = { west: b.getWest(), south: b.getSouth(), east: b.getEast(), north: b.getNorth() };
  if (map.getPitch() < 35) return raw;
  return clampBounds(raw, map.getCenter(), map.getZoom(), maxRadiusKm);
}
