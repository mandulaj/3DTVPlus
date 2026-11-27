// Camera geometry that does not need the map: turning the camera around a fixed point on the ground.

const RAD = Math.PI / 180;
const EARTH_CIRCUMFERENCE = 40075016.686;
const METRES_PER_DEGREE = EARTH_CIRCUMFERENCE / 360;
const EARTH_FOV = 35;

export interface Place {
  lng: number;
  lat: number;
  altitude: number;
}

/**
 * Swings a camera around `pivot` as one rigid body: `yaw` degrees clockwise (seen from above)
 * about the vertical through the pivot, then `tilt` degrees about the camera's own left-right
 * axis (positive lowers the camera toward the horizon). The camera's bearing grows by `yaw` and
 * its pitch by `tilt`; the pivot keeps its distance and its place on the screen.
 */
export function orbit(eye: Place, pivot: Place, bearing: number, yaw: number, tilt: number): Place {
  const scale = METRES_PER_DEGREE * Math.cos(pivot.lat * RAD);
  // Camera relative to the pivot, in metres east, north and up.
  let east = (eye.lng - pivot.lng) * scale;
  let north = (eye.lat - pivot.lat) * METRES_PER_DEGREE;
  let up = eye.altitude - pivot.altitude;

  const a = yaw * RAD;
  [east, north] = [east * Math.cos(a) + north * Math.sin(a), -east * Math.sin(a) + north * Math.cos(a)];

  // Split the horizontal part into "along the view" and "across it"; only the first tilts.
  const heading = (bearing + yaw) * RAD;
  const forward = east * Math.sin(heading) + north * Math.cos(heading);
  const across = east * Math.cos(heading) - north * Math.sin(heading);
  const t = tilt * RAD;
  const tilted = forward * Math.cos(t) - up * Math.sin(t);
  up = forward * Math.sin(t) + up * Math.cos(t);
  east = tilted * Math.sin(heading) + across * Math.cos(heading);
  north = tilted * Math.cos(heading) - across * Math.sin(heading);

  return { lng: pivot.lng + east / scale, lat: pivot.lat + north / METRES_PER_DEGREE, altitude: pivot.altitude + up };
}

/** A point `metres` away from `from` in direction `bearing` (degrees clockwise from north), same height. */
export function ahead(from: Place, bearing: number, metres: number): Place {
  return {
    lng: from.lng + (metres * Math.sin(bearing * RAD)) / (METRES_PER_DEGREE * Math.cos(from.lat * RAD)),
    lat: from.lat + (metres * Math.cos(bearing * RAD)) / METRES_PER_DEGREE,
    altitude: from.altitude,
  };
}

export interface EarthView {
  lat: number;
  lng: number;
  /** Target terrain elevation in real (un-exaggerated) metres above sea level. */
  altitude: number;
  zoom: number;
  bearing: number;
  pitch: number;
  viewportHeight: number;
  /** Vertical field of view in degrees (MapLibre default ~36.87°). */
  fov: number;
}

/** Google Maps directions URL plotting `(lat, lng)` as the destination. */
export function googleMapsDirectionsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps/dir/?api=1&destination=${lat.toFixed(6)},${lng.toFixed(6)}`;
}

/** Google Earth Web URL matched to a MapLibre 3D camera view. */
export function googleEarthUrl(view: EarthView): string {
  const fov = Math.max(5, Math.min(120, view.fov || EARTH_FOV));
  const focalLength = Math.max(1, view.viewportHeight) / 2 / Math.tan((fov * RAD) / 2);
  const maplibreDistance = (focalLength * EARTH_CIRCUMFERENCE * Math.cos(view.lat * RAD)) / (512 * 2 ** view.zoom);
  // Adjust slant distance so Google Earth's 35° vertical FOV matches MapLibre's vertical framing.
  const distance = Math.max(10, (maplibreDistance * Math.tan((fov * RAD) / 2)) / Math.tan((EARTH_FOV * RAD) / 2));
  const altitude = Number.isFinite(view.altitude) ? view.altitude : 0;
  const heading = ((view.bearing % 360) + 360) % 360;
  const tilt = Math.min(89, Math.max(0, view.pitch));
  return `https://earth.google.com/web/@${view.lat.toFixed(6)},${view.lng.toFixed(6)},${altitude.toFixed(1)}a,${distance.toFixed(1)}d,${EARTH_FOV}y,${heading.toFixed(2)}h,${tilt.toFixed(2)}t,0r`;
}
