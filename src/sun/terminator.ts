// Day/night boundary for the globe view.
import type { Feature, Polygon } from 'geojson';

const RAD = Math.PI / 180;

/** Point on Earth where the sun is at the zenith. */
export function subsolarPoint(date: Date): { lng: number; lat: number } {
  const d = date.getTime() / 86400000 + 2440587.5 - 2451545; // days since J2000
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI; // ecliptic longitude
  const e = RAD * 23.4397;
  const dec = Math.asin(Math.sin(L) * Math.sin(e));
  const ra = Math.atan2(Math.sin(L) * Math.cos(e), Math.cos(L));
  const sidereal = RAD * (280.16 + 360.9856235 * d);
  let lng = ((ra - sidereal) / RAD) % 360;
  if (lng > 180) lng -= 360;
  if (lng < -180) lng += 360;
  return { lng, lat: dec / RAD };
}

/** Polygon covering the night side of the Earth. */
export function nightPolygon(date: Date): Feature<Polygon> {
  const sun = subsolarPoint(date);
  let dec = sun.lat * RAD;
  if (Math.abs(dec) < 1e-4) dec = dec < 0 ? -1e-4 : 1e-4; // avoid the equinox singularity
  const ring: [number, number][] = [];
  for (let lng = -180; lng <= 180; lng += 2) {
    const hourAngle = (lng - sun.lng) * RAD;
    ring.push([lng, Math.atan(-Math.cos(hourAngle) / Math.tan(dec)) / RAD]);
  }
  // Night lies toward the pole facing away from the sun.
  const pole = dec > 0 ? -90 : 90;
  ring.push([180, pole], [-180, pole], ring[0]);
  return { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } };
}
