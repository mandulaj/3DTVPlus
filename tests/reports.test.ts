import { describe, expect, it } from 'vitest';
import { ageInDays, pinColour, pinForeground, REPORT_THEMES, reportLegend, reportTheme, verdictInfo } from '../src/layers/gipfelbuch';
import { routeLine } from '../src/routePreview';

describe('condition report styling and age', () => {
  const now = new Date(2026, 10, 27, 15, 30);
  it('counts whole calendar days', () => {
    expect(ageInDays('2026-11-27', now)).toBe(0);
    expect(ageInDays('2026-11-26', now)).toBe(1);
    expect(ageInDays('2026-10-28', now)).toBe(30);
    expect(ageInDays('2026-11-29', now)).toBe(0); // a date ahead of today is treated as today
  });
  it('groups tour symbols into snow, hiking and climbing themes', () => {
    expect(reportTheme('ski')).toBe('snow');
    expect(reportTheme('schneeschuh')).toBe('snow');
    expect(reportTheme('eisklettern')).toBe('snow');
    expect(reportTheme('alpwanderung')).toBe('hiking');
    expect(reportTheme('bike')).toBe('hiking');
    expect(reportTheme('klettertour')).toBe('climbing');
    expect(reportTheme('klettersteig')).toBe('climbing');
    expect(reportTheme('hochtour')).toBe('climbing');
    expect(reportTheme('ohne')).toBe('climbing');
  });
  it('fades each activity theme from vivid when recent to very light when old', () => {
    expect(pinColour('ski', 0)).toBe(REPORT_THEMES.snow.colours[0]);
    expect(pinColour('ski', 1)).toBe(REPORT_THEMES.snow.colours[0]);
    expect(pinColour('ski', 3)).toBe(REPORT_THEMES.snow.colours[1]);
    expect(pinColour('ski', 7)).toBe(REPORT_THEMES.snow.colours[2]);
    expect(pinColour('ski', 14)).toBe(REPORT_THEMES.snow.colours[3]);
    expect(pinColour('ski', 30)).toBe(REPORT_THEMES.snow.colours[4]);

    // Different activities stay visually distinct at the same age
    expect(pinColour('alpwanderung', 0)).toBe(REPORT_THEMES.hiking.colours[0]);
    expect(pinColour('klettertour', 0)).toBe(REPORT_THEMES.climbing.colours[0]);
    expect(new Set([pinColour('ski', 0), pinColour('alpwanderung', 0), pinColour('klettertour', 0)]).size).toBe(3);

    // Foreground switches from white on vivid pins to dark slate on pale pins
    expect(pinForeground(0)).toBe('#ffffff');
    expect(pinForeground(3)).toBe('#ffffff');
    expect(pinForeground(4)).toBe('#1e293b');
    expect(pinForeground(25)).toBe('#1e293b');
  });
  it('maps condition verdicts to traffic-light indicator colours', () => {
    expect(verdictInfo('ausgezeichnet')).toEqual({ label: 'excellent', colour: '#16a34a' });
    expect(verdictInfo('gut')).toEqual({ label: 'good', colour: '#84cc16' });
    expect(verdictInfo('machbar')).toEqual({ label: 'doable', colour: '#eab308' });
    expect(verdictInfo('schlecht')).toEqual({ label: 'poor', colour: '#ef4444' });
    expect(verdictInfo(undefined)).toBeNull();
    expect(verdictInfo('')).toBeNull();
    expect(verdictInfo('unbekannt')).toBeNull();
  });
  it('builds a structured legend for the unified legend window', () => {
    const legend = reportLegend();
    expect(legend.title).toBe('Condition reports');
    expect(legend.rows).toHaveLength(2);
    expect(legend.rows![0].entries.map((e) => e.label)).toEqual(['Snow', 'Hiking', 'Climbing']);
    expect(legend.rows![1].entries.map((e) => e.label)).toEqual(['excellent', 'good', 'doable', 'poor']);
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
