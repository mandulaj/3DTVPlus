import { describe, expect, it } from 'vitest';
import { cellName, cellsInView } from '../src/layers/camptocampCells';

describe('cellName', () => {
  it('names a cell by its south-west corner', () => {
    expect(cellName(8.42, 46.78)).toBe('8.0_46.5');
    expect(cellName(8.5, 47.0)).toBe('8.5_47.0');
    expect(cellName(7.999, 46.499)).toBe('7.5_46.0');
    expect(cellName(-0.2, 45.1)).toBe('-0.5_45.0');
  });
});

describe('cellsInView', () => {
  const stored = new Set(['7.5_46.0', '8.0_46.0', '8.0_46.5', '8.5_46.5', '9.0_46.5']);
  it('lists only stored cells the view touches', () => {
    expect(cellsInView({ west: 8.1, south: 46.6, east: 8.4, north: 46.9 }, stored, 12)).toEqual(['8.0_46.5']);
    expect(cellsInView({ west: 8.3, south: 46.4, east: 8.7, north: 46.7 }, stored, 12).sort()).toEqual(['8.0_46.0', '8.0_46.5', '8.5_46.5']);
    expect(cellsInView({ west: 5, south: 44, east: 5.4, north: 44.4 }, stored, 12)).toEqual([]);
  });
  it('keeps the cells nearest the centre when there are too many', () => {
    const near = cellsInView({ west: 7.6, south: 46.1, east: 9.4, north: 46.9 }, stored, 2);
    expect(near).toHaveLength(2);
    expect(near).toContain('8.0_46.5');
    expect(near).not.toContain('9.0_46.5');
  });
});
