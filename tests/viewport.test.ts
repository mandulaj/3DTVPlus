import { describe, expect, it } from 'vitest';
import { clampBounds } from '../src/viewport';

describe('clampBounds', () => {
  it('clips horizon-exploded 3D bounds around the map centre', () => {
    // Simulated steep 3D tilt looking north from Valais: bounds reach 500+ km north.
    const raw = { west: 2.0, south: 45.8, east: 14.0, north: 52.0 };
    const center = { lng: 7.5, lat: 46.2 };
    const clipped = clampBounds(raw, center, 13, 60);
    expect(clipped.north).toBeLessThan(46.35);
    expect(clipped.west).toBeGreaterThan(7.3);
    expect(clipped.east).toBeLessThan(7.7);
    expect(clipped.south).toBeGreaterThanOrEqual(raw.south);
  });

  it('never expands bounds beyond the raw viewport', () => {
    const raw = { west: 7.49, south: 46.19, east: 7.51, north: 46.21 };
    const clipped = clampBounds(raw, { lng: 7.5, lat: 46.2 }, 11, 60);
    expect(clipped).toEqual(raw);
  });
});
