// Shift+drag: turn the camera in place (look up, down and around) instead of MapLibre's box zoom.
// The normal rotate gesture orbits around the point at the screen centre, which from inside a
// valley swings the camera into the opposite slope; here the camera stays where it is.
import type * as maplibregl from 'maplibre-gl';

const RAD = Math.PI / 180;
const EARTH_CIRCUMFERENCE = 40075016.686;
const METRES_PER_DEGREE = EARTH_CIRCUMFERENCE / 360;
const DEGREES_PER_PIXEL = 0.12;
// 90 would be level with the horizon. Beyond it MapLibre requests thousands of tiles and stalls.
const LOOK_MAX_PITCH = 89;

interface Camera {
  position: maplibregl.LngLat;
  altitude: number;
}

export interface LookAround {
  /** Turn the camera in place to this bearing and pitch (pitch is capped just below the horizon). */
  turnTo(bearing: number, pitch: number): void;
}

export function enableLookAround(map: maplibregl.Map): LookAround {
  map.boxZoom.disable();
  const canvas = map.getCanvasContainer();
  const groundMaxPitch = map.getMaxPitch();
  let start: (Camera & { x: number; y: number; bearing: number; pitch: number }) | null = null;
  let free = false; // view centre detached from the ground

  /** Where the camera is: behind the view centre, along the view direction. */
  function camera(): Camera {
    const centre = map.getCenter();
    const pitch = map.getPitch() * RAD;
    const bearing = map.getBearing() * RAD;
    const metresPerPixel = (EARTH_CIRCUMFERENCE * Math.cos(centre.lat * RAD)) / (512 * 2 ** map.getZoom());
    const distance = (map.getCanvas().clientHeight / 2 / Math.tan((map.getVerticalFieldOfView() * RAD) / 2)) * metresPerPixel;
    const back = distance * Math.sin(pitch);
    const position = centre.wrap();
    position.lat -= (back * Math.cos(bearing)) / METRES_PER_DEGREE;
    position.lng -= (back * Math.sin(bearing)) / (METRES_PER_DEGREE * Math.cos(centre.lat * RAD));
    return { position, altitude: map.getCenterElevation() + distance * Math.cos(pitch) };
  }

  canvas.addEventListener(
    'mousedown',
    (event) => {
      if (!event.shiftKey || event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation(); // keep MapLibre's own drag handlers out
      map.stop();
      start = { ...camera(), x: event.clientX, y: event.clientY, bearing: map.getBearing(), pitch: map.getPitch() };
      release();
      canvas.style.cursor = 'move';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, { once: true });
    },
    true,
  );

  /** The view centre may now leave the ground (looking at a summit or the sky). */
  function release(): void {
    free = true;
    map.setCenterClampedToGround(false);
    map.setMaxPitch(LOOK_MAX_PITCH);
  }

  function onMove(event: MouseEvent): void {
    if (!start) return;
    // The scene follows the cursor: drag down to look up, drag right to look left.
    const pitch = Math.min(LOOK_MAX_PITCH, Math.max(0, start.pitch + (event.clientY - start.y) * DEGREES_PER_PIXEL));
    const bearing = start.bearing - (event.clientX - start.x) * DEGREES_PER_PIXEL;
    map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation(start.position, start.altitude, bearing, pitch));
  }

  function onUp(): void {
    start = null;
    canvas.style.cursor = '';
    window.removeEventListener('mousemove', onMove);
    anchor();
  }

  /**
   * Back to ordinary navigation: put the view centre on the terrain the camera is looking at,
   * without moving the camera. Not possible while the screen centre shows sky.
   */
  function anchor(): void {
    if (!free || start || map.getPitch() > groundMaxPitch) return;
    const { clientWidth: width, clientHeight: height } = map.getCanvas();
    const centre = { x: width / 2, y: height / 2 };
    try {
      const terrain = map.terrain as unknown as { pointCoordinate?: (p: { x: number; y: number }) => unknown } | null;
      if (terrain?.pointCoordinate && terrain.pointCoordinate(centre) == null) return; // sky
    } catch {
      return;
    }
    const eye = camera();
    const ground = map.unproject([centre.x, centre.y]);
    const north = (ground.lat - eye.position.lat) * METRES_PER_DEGREE;
    const east = (ground.lng - eye.position.lng) * METRES_PER_DEGREE * Math.cos(ground.lat * RAD);
    const distance = Math.hypot(north, east);
    const pitch = map.getPitch() * RAD;
    const elevation = eye.altitude - distance / Math.tan(Math.max(pitch, 0.01));
    if (!Number.isFinite(elevation) || distance <= 0) return;
    free = false; // first: jumpTo fires moveend, which calls back into this function
    map.jumpTo(map.calculateCameraOptionsFromTo(eye.position, eye.altitude, ground, elevation));
    map.setCenterClampedToGround(true);
    map.setMaxPitch(groundMaxPitch);
  }

  // While looking at the sky the view stays free; settle as soon as terrain is centred again.
  map.on('moveend', anchor);

  return {
    turnTo(bearing, pitch) {
      map.stop();
      const eye = camera();
      release();
      map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation(eye.position, eye.altitude, bearing, Math.min(LOOK_MAX_PITCH, Math.max(0, pitch))));
    },
  };
}
