import { describe, expect, it } from 'vitest';
import { ahead, orbit, type Place } from '../src/cameraMath';

const RAD = Math.PI / 180;
const M = 40075016.686 / 360;
const pivot: Place = { lng: 8, lat: 46.5, altitude: 2000 };
// Camera 3 km south of the pivot and 3 km above it, looking north: pitch 45.
const eye: Place = { lng: 8, lat: 46.5 - 3000 / M, altitude: 5000 };

function distance(a: Place, b: Place): number {
  return Math.hypot((a.lng - b.lng) * M * Math.cos(b.lat * RAD), (a.lat - b.lat) * M, a.altitude - b.altitude);
}

describe('orbit', () => {
  it('keeps the distance to the pivot', () => {
    for (const [yaw, tilt] of [[30, 0], [0, 20], [-120, -15], [200, 30]]) {
      expect(distance(orbit(eye, pivot, 0, yaw, tilt), pivot)).toBeCloseTo(distance(eye, pivot), 3);
    }
  });
  it('returns to the start after a full turn', () => {
    const back = orbit(eye, pivot, 0, 360, 0);
    expect(back.lng).toBeCloseTo(eye.lng, 9);
    expect(back.lat).toBeCloseTo(eye.lat, 9);
  });
  it('turns clockwise: facing east puts the camera west of the pivot', () => {
    const turned = orbit(eye, pivot, 0, 90, 0);
    expect(turned.lng).toBeLessThan(pivot.lng);
    expect(turned.lat).toBeCloseTo(pivot.lat, 6);
    expect(turned.altitude).toBeCloseTo(eye.altitude, 6);
  });
  it('tilting toward the horizon lowers the camera, tilting back raises it straight above', () => {
    expect(orbit(eye, pivot, 0, 0, 20).altitude).toBeLessThan(eye.altitude);
    const above = orbit(eye, pivot, 0, 0, -45);
    expect(above.lat).toBeCloseTo(pivot.lat, 6);
    expect(above.altitude).toBeCloseTo(pivot.altitude + distance(eye, pivot), 3);
  });
});

describe('ahead', () => {
  it('moves the given distance in the given direction', () => {
    const moved = ahead(eye, 90, 1000);
    expect(distance(moved, eye)).toBeCloseTo(1000, 0);
    expect(moved.lng).toBeGreaterThan(eye.lng);
    expect(moved.lat).toBeCloseTo(eye.lat, 9);
  });
});
