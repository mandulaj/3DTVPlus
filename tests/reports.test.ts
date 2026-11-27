import { describe, expect, it } from 'vitest';
import { ageColour, ageInDays, REPORT_AGES } from '../src/layers/gipfelbuch';
import { routeLine } from '../src/routePreview';

describe('condition report age', () => {
  const now = new Date(2026, 10, 27, 15, 30);
  it('counts whole calendar days', () => {
    expect(ageInDays('2026-11-27', now)).toBe(0);
    expect(ageInDays('2026-11-26', now)).toBe(1);
    expect(ageInDays('2026-10-28', now)).toBe(30);
    expect(ageInDays('2026-11-29', now)).toBe(0); // a date ahead of today is treated as today
  });
  it('gives fresher reports their own colour', () => {
    expect(ageColour(0)).toBe(REPORT_AGES[0].colour);
    expect(ageColour(1)).toBe(REPORT_AGES[0].colour);
    expect(ageColour(3)).toBe(REPORT_AGES[1].colour);
    expect(ageColour(7)).toBe(REPORT_AGES[2].colour);
    expect(ageColour(400)).toBe(REPORT_AGES[REPORT_AGES.length - 1].colour);
  });
});

describe('routeLine', () => {
  const heights = (low: number) => async (points: [number, number][]) => points.map((p) => (p[1] - low) * 10000);
  it('joins pieces, keeps the longest path and runs uphill', async () => {
    const line = await routeLine(
      [
        [[8, 46.02], [8, 46.01]], // upper piece, stored downhill
        [[8, 46.0], [8, 46.01]],
        [[9, 46.0], [9, 46.001]], // a separate short variant
      ],
      heights(46),
    );
    expect(line).toEqual([[8, 46.0], [8, 46.01], [8, 46.02]]);
  });
  it('turns a downhill line around', async () => {
    const line = await routeLine([[[8, 46.02], [8, 46.01], [8, 46.0]]], heights(46));
    expect(line![0]).toEqual([8, 46.0]);
  });
  it('gives nothing for no lines', async () => {
    expect(await routeLine([], heights(46))).toBeNull();
  });
});
