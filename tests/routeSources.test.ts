import { describe, expect, it } from 'vitest';
import { byId } from '../src/layers/catalog';
import { PRESETS } from '../src/layers/presets';
import { networkGrade, ROUTE_SOURCES } from '../src/layers/routeSources';
import { SAC_DISCIPLINES } from '../src/layers/sac';
// @ts-expect-error plain JavaScript module without type declarations
import { fromAustriaLambert, fromLambert93, fromLv95 } from '../scripts/projections.mjs';

describe('networkGrade', () => {
  it('reads Skitourenguru difficulty numbers as SAC ski grades', () => {
    expect(networkGrade(1)?.label).toBe('L');
    expect(networkGrade(3)?.label).toBe('WS-');
    expect(networkGrade(4)?.label).toBe('WS');
    expect(networkGrade(5)?.label).toBe('WS+');
    expect(networkGrade(7)?.label).toBe('ZS');
    expect(networkGrade(9)?.label).toBe('S-');
    expect(networkGrade(13)?.label).toBe('SS');
    expect(networkGrade(4)?.rank).toBe(1);
    expect(networkGrade(0)).toBeNull();
    expect(networkGrade(null)).toBeNull();
  });
});

describe('presets', () => {
  it('refer only to layers, routes and SAC kinds that exist', () => {
    const routes = new Set(ROUTE_SOURCES.map((spec) => spec.id));
    for (const preset of PRESETS) {
      expect(byId.has(preset.base), `${preset.id}: base ${preset.base}`).toBe(true);
      for (const overlay of preset.overlays) expect(byId.has(overlay.id), `${preset.id}: overlay ${overlay.id}`).toBe(true);
      for (const id of preset.routes ?? []) expect(routes.has(id), `${preset.id}: routes ${id}`).toBe(true);
      for (const id of preset.sac ?? []) expect(id in SAC_DISCIPLINES, `${preset.id}: SAC ${id}`).toBe(true);
    }
  });
});

describe('projections of the data scripts', () => {
  const near = (got: number[], want: number[], digits: number) => {
    expect(got[0]).toBeCloseTo(want[0], digits);
    expect(got[1]).toBeCloseTo(want[1], digits);
  };
  it('Swiss LV95: the old Bern observatory', () => near(fromLv95(2600000, 1200000), [7.438632, 46.951083], 4));
  it('Lambert-93: its origin and its false easting', () => {
    near(fromLambert93(700000, 6600000), [3, 46.5], 5);
    // One degree east along the 46.5 parallel stays near that latitude.
    const [lng, lat] = fromLambert93(776700, 6601000);
    expect(lng).toBeCloseTo(4, 1);
    expect(lat).toBeCloseTo(46.5, 1);
  });
  it('Austrian Lambert: the origin, moved about 100 m by the datum shift', () => {
    const [lng, lat] = fromAustriaLambert(400000, 400000);
    expect(Math.abs(lng - (13 + 1 / 3)) * 75000).toBeLessThan(150); // metres east-west
    expect(Math.abs(lat - 47.5) * 111000).toBeLessThan(150);
    expect(Math.abs(lng - (13 + 1 / 3)) * 75000 + Math.abs(lat - 47.5) * 111000).toBeGreaterThan(20); // and not unshifted
  });
});
