// Camera geometry that does not need the map: turning the camera around a fixed point on the ground.

const RAD = Math.PI / 180;
const METRES_PER_DEGREE = 40075016.686 / 360;

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
