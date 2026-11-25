import { describe, expect, it } from 'vitest';
import { decodeFilter, encodeFilter, gradeRank, isActive, NO_FILTER, passes } from '../src/layers/routeFilter';

describe('gradeRank', () => {
  it('orders grades with their plus and minus', () => {
    const order = ['L', 'WS-', 'WS', 'WS+', 'ZS-', 'ZS', 'S', 'SS', 'AS'].map((g) => gradeRank('alpine', g)!);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(gradeRank('alpine', 'SS')).toBe(4);
    expect(gradeRank('alpine', 'S+')).toBeCloseTo(3.33, 1);
  });
  it('reads the other scales', () => {
    expect(gradeRank('hiking', 'T4+')).toBeCloseTo(3.33, 1);
    expect(gradeRank('snowshoe', 'WT3-')).toBeCloseTo(1.67, 1);
    expect(gradeRank('ferrata', 'K3-4')).toBe(2);
    expect(gradeRank('french', 'PD+')).toBeCloseTo(1.33, 1);
    expect(gradeRank('french', 'TD-')).toBeCloseTo(3.67, 1);
  });
  it('knows what is not a grade', () => {
    expect(gradeRank('hiking', '6b+')).toBeNull();
    expect(gradeRank('alpine', null)).toBeNull();
  });
});

describe('passes', () => {
  const upToWs = { ...NO_FILTER, gradeMax: 1 };
  it('counts plus and minus to their grade', () => {
    expect(passes(upToWs, gradeRank('alpine', 'WS+'), 800)).toBe(true);
    expect(passes(upToWs, gradeRank('alpine', 'ZS-'), 800)).toBe(false);
    expect(passes({ ...NO_FILTER, gradeMin: 2 }, gradeRank('alpine', 'ZS-'), 800)).toBe(true);
    expect(passes({ ...NO_FILTER, gradeMin: 2 }, gradeRank('alpine', 'WS+'), 800)).toBe(false);
  });
  it('limits the ascent', () => {
    const climb = { ...NO_FILTER, upMin: 500, upMax: 1200 };
    expect(passes(climb, null, 900)).toBe(true);
    expect(passes(climb, null, 1500)).toBe(false);
    expect(passes(climb, null, 300)).toBe(false);
  });
  it('hides routes without the value, shows those still being looked up', () => {
    expect(passes(upToWs, null, 800)).toBe(false);
    expect(passes(upToWs, undefined, 800)).toBe(true);
    expect(passes({ ...NO_FILTER, upMax: 1000 }, 1, null)).toBe(false);
    expect(passes({ ...NO_FILTER, upMax: 1000 }, 1, undefined)).toBe(true);
    expect(passes(NO_FILTER, null, null)).toBe(true);
  });
});

describe('address form', () => {
  it('round-trips', () => {
    const f = { gradeMin: 1, gradeMax: 3, upMin: null, upMax: 1500 };
    expect(encodeFilter(f)).toBe('1~3~~1500');
    expect(decodeFilter('1~3~~1500')).toEqual(f);
    expect(isActive(decodeFilter('~~~'))).toBe(false);
  });
});
