// Shift+drag or middle-button drag: turn the camera in place (look up, down and around) instead of
// MapLibre's box zoom. Ctrl+middle-button drag swings the camera around the point under the cursor;
// Shift+wheel moves it forward and back; a double middle click puts north up again.
// The normal rotate gesture orbits around the point at the screen centre, which from inside a
// valley swings the camera into the opposite slope; here the camera stays where it is.
//
// MapLibre describes a view by the point at the screen centre plus zoom, bearing and pitch. To turn
// the camera in place that centre point has to leave the ground. Zoom and pan need the centre on the ground again: with the centre floating
// far above terrain MapLibre picks tiles for the wrong distance and requests thousands of them.
import * as maplibregl from 'maplibre-gl';
import { ahead, orbit, type Place } from './cameraMath';

const RAD = Math.PI / 180;
const EARTH_CIRCUMFERENCE = 40075016.686;
const METRES_PER_DEGREE = EARTH_CIRCUMFERENCE / 360;
const DEGREES_PER_PIXEL = 0.12;
// 90 would be level with the horizon. Beyond it MapLibre requests thousands of tiles and stalls,
// and from a high viewpoint the picture already breaks up around 88.
const LOOK_MAX_PITCH = 86;
const MIN_HEIGHT = 30; // metres the camera stays above the ground when it is moved or swung around
const DOUBLE_CLICK_MS = 350;
const RESET_PITCH = 45;
const MIN_ZOOM = 11; // further out the map is a globe and the flat-earth geometry used here no longer holds

export interface LookAround {
  /** Turn the camera in place to this bearing and pitch (pitch is capped just below the horizon). */
  turnTo(bearing: number, pitch: number): void;
  /** Where the camera currently is. */
  position(): { lngLat: maplibregl.LngLat; altitude: number };
  /** Put the camera at a point in space (e.g. just above a summit) and look along `bearing`. */
  standAt(lngLat: maplibregl.LngLatLike, altitude: number, bearing: number, pitch: number): void;
  /** Fly the camera to a point in space, facing the direction of travel, and end looking at `pitch`. */
  flyTo(lngLat: maplibregl.LngLatLike, altitude: number, pitch: number): void;
  /** Switch look mode (plain drag turns the camera) on or off, as its button does. */
  toggleLookMode(): void;
}

interface Eye {
  position: maplibregl.LngLat;
  altitude: number;
}

export function enableLookAround(map: maplibregl.Map): LookAround {
  map.boxZoom.disable();
  const canvas = map.getCanvasContainer();
  const groundMaxPitch = map.getMaxPitch();
  let drag: { x: number; y: number; bearing: number; pitch: number; mode: 'look' | 'orbit' | 'plain'; middle: boolean; pivot?: Place; from?: Place } | null = null;
  let lastMiddleClick = { x: 0, y: 0, time: -Infinity };
  let glideTimer: number | undefined;
  // Camera position while the view centre is detached from the ground. It is worked out once, from
  // an ordinary view (centre on the ground, a few km away) where the simple geometry below is
  // accurate, and stays valid because every other gesture first returns to an ordinary view.
  let eye: Eye | null = null;
  let turning = false;
  let lookMode = false; // plain drag turns the camera (touch screens have no Shift key)
  let flightToken = 0; // a flight in progress stops when this changes

  function focalLength(): number {
    return map.getCanvas().clientHeight / 2 / Math.tan((map.getVerticalFieldOfView() * RAD) / 2);
  }

  /** Where the camera is: behind the view centre, along the view direction. */
  function locateEye(): Eye {
    const centre = map.getCenter();
    const pitch = map.getPitch() * RAD;
    const bearing = map.getBearing() * RAD;
    const distance = (focalLength() * EARTH_CIRCUMFERENCE * Math.cos(centre.lat * RAD)) / (512 * 2 ** map.getZoom());
    const back = distance * Math.sin(pitch);
    const position = centre.wrap();
    position.lat -= (back * Math.cos(bearing)) / METRES_PER_DEGREE;
    position.lng -= (back * Math.sin(bearing)) / (METRES_PER_DEGREE * Math.cos(centre.lat * RAD));
    return { position, altitude: map.getCenterElevation() + distance * Math.cos(pitch) };
  }

  /** Detach the view centre from the ground: it may now sit on a summit or in the sky. */
  function release(): Eye {
    if (!eye) {
      eye = locateEye();
      map.setCenterClampedToGround(false);
      map.setMaxPitch(LOOK_MAX_PITCH);
    }
    return eye;
  }

  function turn(from: Eye, bearing: number, pitch: number): void {
    turning = true;
    map.jumpTo(map.calculateCameraOptionsFromCameraLngLatAltRotation(from.position, from.altitude, bearing, Math.min(LOOK_MAX_PITCH, Math.max(0, pitch))));
    turning = false;
  }

  /**
   * Back to ordinary navigation: put the view centre on the terrain the camera is looking at,
   * keeping the camera where it is. If the screen centre shows sky that is impossible; with
   * `force` the camera is first tilted down to the normal limit.
   */
  function anchor(force = false): void {
    if (!eye || drag) return;
    flightToken++;
    const { clientWidth: width, clientHeight: height } = map.getCanvas();
    const middle = { x: width / 2, y: height / 2 };
    let onTerrain = map.getPitch() <= groundMaxPitch;
    try {
      const terrain = map.terrain as unknown as { pointCoordinate?: (p: { x: number; y: number }) => unknown } | null;
      if (onTerrain && terrain?.pointCoordinate) onTerrain = terrain.pointCoordinate(middle) != null;
    } catch {
      onTerrain = false; // internal API: fall back to the forced path
    }
    if (!onTerrain && !force) return;

    const from = eye;
    eye = null; // first: the calls below fire move events, which call back into this function
    let target: maplibregl.CameraOptions | null = null;
    if (onTerrain) {
      const ground = map.unproject([middle.x, middle.y]);
      const east = (ground.lng - from.position.lng) * METRES_PER_DEGREE * Math.cos(ground.lat * RAD);
      const north = (ground.lat - from.position.lat) * METRES_PER_DEGREE;
      const distance = Math.hypot(east, north) / Math.max(Math.sin(map.getPitch() * RAD), 0.05);
      const zoom = Math.log2((focalLength() * EARTH_CIRCUMFERENCE * Math.cos(ground.lat * RAD)) / (512 * distance));
      if (Number.isFinite(zoom)) target = { center: ground, zoom: Math.min(map.getMaxZoom(), Math.max(map.getMinZoom(), zoom)) };
    } else {
      // Looking above the terrain: tilt down, then let MapLibre find the ground (the view may shift a little).
      turn(from, map.getBearing(), Math.min(map.getPitch(), groundMaxPitch - 8));
    }
    turning = true;
    map.setCenterClampedToGround(true);
    map.setMaxPitch(groundMaxPitch);
    if (target) map.jumpTo(target);
    turning = false;
  }

  /** Height of the ground at a place, or null where the terrain is not loaded. */
  function groundAt(at: { lng: number; lat: number }): number | null {
    const height = map.queryTerrainElevation([at.lng, at.lat]);
    return height == null || !Number.isFinite(height) ? null : height;
  }

  const placeOf = (at: Eye): Place => ({ lng: at.position.lng, lat: at.position.lat, altitude: at.altitude });
  const eyeOf = (place: Place): Eye => ({ position: new maplibregl.LngLat(place.lng, place.lat), altitude: place.altitude });

  /** The ground under a screen point (the screen centre if that point shows sky), to swing the camera around. */
  function pivotAt(x: number, y: number): Place {
    const box = map.getCanvas().getBoundingClientRect();
    const point = { x: x - box.left, y: y - box.top };
    // A screen point showing sky has no ground under it: the place found for it does not project back to it.
    const found = map.unproject([point.x, point.y]);
    const back = map.project(found);
    const onTerrain = Math.hypot(back.x - point.x, back.y - point.y) < 3;
    const at = onTerrain ? found : map.getCenter();
    return { lng: at.lng, lat: at.lat, altitude: (onTerrain ? groundAt(at) : null) ?? map.getCenterElevation() };
  }

  canvas.addEventListener(
    'mousedown',
    (event) => {
      const middle = event.button === 1;
      const pivoting = middle && (event.ctrlKey || event.metaKey);
      if (!middle && !((event.shiftKey || lookMode) && event.button === 0)) return;
      event.preventDefault(); // also: no autoscroll on the middle button
      event.stopPropagation(); // keep MapLibre's own drag handlers out
      map.stop();
      flightToken++; // taking over from a flight in progress
      clearTimeout(glideTimer);
      const start = { x: event.clientX, y: event.clientY, middle };
      if (map.getZoom() < MIN_ZOOM) {
        // On the globe there is no standing in a valley: the middle button just turns and tilts the view.
        if (!middle) return;
        drag = { ...start, bearing: map.getBearing(), pitch: map.getPitch(), mode: 'plain' };
      } else if (pivoting) {
        anchor(true); // an ordinary view first: the point under the cursor is found from it
        const pivot = pivotAt(event.clientX, event.clientY);
        const from = placeOf(locateEye());
        release();
        drag = { ...start, bearing: map.getBearing(), pitch: map.getPitch(), mode: 'orbit', pivot, from };
      } else {
        release();
        drag = { ...start, bearing: map.getBearing(), pitch: map.getPitch(), mode: 'look' };
      }
      canvas.style.cursor = drag.mode === 'look' ? 'move' : 'grabbing';
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp, { once: true });
    },
    true,
  );
  canvas.addEventListener('auxclick', (event) => event.preventDefault()); // no paste on middle click

  function onMove(event: MouseEvent): void {
    if (!drag) return;
    const dx = (event.clientX - drag.x) * DEGREES_PER_PIXEL;
    const dy = (event.clientY - drag.y) * DEGREES_PER_PIXEL;
    if (drag.mode === 'look') {
      // The scene follows the cursor: drag down to look up, drag right to look left.
      if (eye) turn(eye, drag.bearing - dx, drag.pitch + dy);
      return;
    }
    // Turning around a point: drag sideways to go round it, up to come down toward the horizon.
    const pitch = Math.min(groundMaxPitch, Math.max(0, drag.pitch - dy));
    if (drag.mode === 'plain') {
      map.jumpTo({ bearing: drag.bearing + dx, pitch });
      return;
    }
    const to = orbit(drag.from!, drag.pivot!, drag.bearing, dx, pitch - drag.pitch);
    const ground = groundAt(to);
    if (ground != null && to.altitude < ground + MIN_HEIGHT) return; // would go into the mountain
    eye = eyeOf(to);
    turn(eye, drag.bearing + dx, pitch);
  }

  function onUp(event: MouseEvent): void {
    const ended = drag;
    drag = null;
    canvas.style.cursor = '';
    window.removeEventListener('mousemove', onMove);
    anchor(ended?.mode === 'orbit');
    if (!ended?.middle || Math.hypot(event.clientX - ended.x, event.clientY - ended.y) > 4) return;
    // A middle click without dragging; two in a row put north up again.
    const now = performance.now();
    if (now - lastMiddleClick.time < DOUBLE_CLICK_MS && Math.hypot(event.clientX - lastMiddleClick.x, event.clientY - lastMiddleClick.y) < 6) {
      lastMiddleClick.time = -Infinity;
      anchor(true);
      map.easeTo({ bearing: 0, pitch: Math.min(RESET_PITCH, groundMaxPitch), duration: 600 });
    } else {
      lastMiddleClick = { x: event.clientX, y: event.clientY, time: now };
    }
  }

  // Shift+wheel: move the camera forward or back over the terrain, keeping its direction and its
  // height above the ground (the plain wheel zooms toward the point under the cursor instead).
  canvas.addEventListener(
    'wheel',
    (event) => {
      if (!event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || drag || map.getZoom() < MIN_ZOOM) return;
      event.preventDefault();
      event.stopImmediatePropagation(); // not a zoom, and the view must not be settled between notches
      map.stop();
      flightToken++;
      const from = release();
      const bearing = map.getBearing();
      const pitch = map.getPitch();
      const delta = event.deltaY || event.deltaX; // with Shift held, browsers report the wheel as sideways
      const ground = groundAt(from.position);
      const height = ground == null ? null : Math.max(MIN_HEIGHT, from.altitude - ground);
      // A step in proportion to how far away the scenery in view is.
      const reach = (height ?? 500) / Math.max(Math.cos(pitch * RAD), 0.15);
      const to = ahead(placeOf(from), bearing, -Math.sign(delta) * Math.min(1, Math.abs(delta) / 100) * reach * 0.1);
      const groundThere = groundAt(to);
      if (height != null && groundThere != null) to.altitude = groundThere + height;
      eye = eyeOf(to);
      turn(eye, bearing, pitch);
      clearTimeout(glideTimer);
      glideTimer = window.setTimeout(() => anchor(true), 250);
    },
    { capture: true, passive: false },
  );

  // Touch has no Shift key: with look mode on (the eye button), one finger turns the camera.
  canvas.addEventListener(
    'touchstart',
    (event) => {
      if (!lookMode || event.touches.length !== 1 || map.getZoom() < MIN_ZOOM) return;
      event.preventDefault();
      event.stopPropagation();
      map.stop();
      flightToken++;
      release();
      const touch = event.touches[0];
      drag = { x: touch.clientX, y: touch.clientY, bearing: map.getBearing(), pitch: map.getPitch(), mode: 'look', middle: false };
      const move = (e: TouchEvent) => {
        if (!drag || !eye || !e.touches.length) return;
        e.preventDefault();
        turn(eye, drag.bearing - (e.touches[0].clientX - drag.x) * DEGREES_PER_PIXEL, drag.pitch + (e.touches[0].clientY - drag.y) * DEGREES_PER_PIXEL);
      };
      const end = () => {
        window.removeEventListener('touchmove', move);
        window.removeEventListener('touchend', end);
        window.removeEventListener('touchcancel', end);
        drag = null;
        anchor();
      };
      window.addEventListener('touchmove', move, { passive: false });
      window.addEventListener('touchend', end);
      window.addEventListener('touchcancel', end);
    },
    { capture: true, passive: false },
  );

  // A button for it, with the other map controls.
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'look-mode';
  button.title = 'Look around: drag turns the camera in place (same as Shift+drag or dragging with the middle button). Key: L';
  button.textContent = '👁';
  const toggleLookMode = () => {
    lookMode = !lookMode;
    button.classList.toggle('on', lookMode);
    if (!lookMode) anchor(true);
  };
  button.addEventListener('click', toggleLookMode);
  const group = document.createElement('div');
  group.className = 'maplibregl-ctrl maplibregl-ctrl-group';
  group.append(button);
  map.addControl({ onAdd: () => group, onRemove: () => group.remove() }, 'top-right');

  // Any ordinary gesture needs the centre on the ground first (capture: before MapLibre handles it).
  const settle = (event: Event) => {
    const looking = lookMode && (event.type === 'touchstart' || (event instanceof MouseEvent && event.button === 0));
    if (eye && !drag && !looking && !(event instanceof MouseEvent && event.shiftKey && event.button === 0)) {
      clearTimeout(glideTimer);
      anchor(true);
    }
  };
  for (const type of ['wheel', 'mousedown', 'touchstart', 'dblclick']) canvas.addEventListener(type, settle, true);
  map.getContainer().addEventListener('keydown', settle, true);
  // Buttons (zoom, compass, geolocate) and programmatic moves: settle as soon as one starts.
  map.on('movestart', () => {
    if (eye && !drag && !turning) anchor(true);
  });

  return {
    toggleLookMode,
    position() {
      const at = eye ?? locateEye();
      return { lngLat: at.position, altitude: at.altitude };
    },
    standAt(lngLat, altitude, bearing, pitch) {
      map.stop();
      release();
      eye = { position: maplibregl.LngLat.convert(lngLat), altitude };
      turn(eye, bearing, pitch);
    },
    flyTo(lngLat, altitude, pitch) {
      map.stop();
      const from = eye ?? locateEye();
      const to = maplibregl.LngLat.convert(lngLat);
      release();
      const startBearing = map.getBearing();
      const startPitch = map.getPitch();
      const east = (to.lng - from.position.lng) * Math.cos(from.position.lat * RAD) * METRES_PER_DEGREE;
      const north = (to.lat - from.position.lat) * METRES_PER_DEGREE;
      const ground = Math.hypot(east, north);
      // Face the destination, turning the short way round. Arriving from very close, keep the heading.
      const heading = ground > 200 ? (Math.atan2(east, north) / RAD + 360) % 360 : startBearing;
      const turnBy = ((heading - startBearing + 540) % 360) - 180;
      // Arc over the terrain in between rather than through it.
      const lift = Math.min(1500, ground * 0.12);
      const duration = Math.min(6000, 1800 + Math.sqrt(ground) * 18);
      const began = performance.now();
      const flight = ++flightToken;
      const frame = (now: number) => {
        if (flight !== flightToken || !eye) return; // interrupted by the user
        const t = Math.min(1, (now - began) / duration);
        const k = t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2; // ease in and out
        const swing = Math.min(1, t / 0.35);
        eye = {
          position: new maplibregl.LngLat(from.position.lng + (to.lng - from.position.lng) * k, from.position.lat + (to.lat - from.position.lat) * k),
          altitude: from.altitude + (altitude - from.altitude) * k + lift * Math.sin(Math.PI * k),
        };
        turn(eye, startBearing + turnBy * swing * swing * (3 - 2 * swing), startPitch + (pitch - startPitch) * k);
        if (t < 1) requestAnimationFrame(frame);
      };
      requestAnimationFrame(frame);
    },
    turnTo(bearing, pitch) {
      if (map.getZoom() < MIN_ZOOM) {
        map.easeTo({ bearing, pitch: Math.min(pitch, groundMaxPitch) });
        return;
      }
      map.stop();
      turn(release(), bearing, pitch);
      anchor();
    },
  };
}
