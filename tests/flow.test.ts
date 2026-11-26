import { describe, expect, it } from 'vitest';
import { advance, emptyState, volume, type FlowGrid } from '../src/playground/flow';

/** A slope falling to the east at `angle` degrees for `run` metres, then flat. */
function slope(angle: number, run = 600, width = 160, height = 21): FlowGrid {
  const cell = 10;
  const ground = new Float32Array(width * height);
  const tan = Math.tan((angle * Math.PI) / 180);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) ground[y * width + x] = Math.max(0, run - x * cell) * tan;
  return { width, height, cell, ground };
}
function snowAt(grid: FlowGrid, x0: number, x1: number, depth = 1.5) {
  const state = emptyState(grid);
  for (let y = 6; y < grid.height - 6; y++) for (let x = x0; x < x1; x++) state.depth[y * grid.width + x] = depth;
  return state;
}
/** How far east the snow reaches, in metres. */
const front = (grid: FlowGrid, state: { depth: Float32Array }) => {
  let far = 0;
  for (let i = 0; i < state.depth.length; i++) if (state.depth[i] > 0.05 && i % grid.width > far) far = i % grid.width;
  return far * grid.cell;
};
const centre = (grid: FlowGrid, state: { depth: Float32Array }) => {
  let sum = 0;
  let at = 0;
  for (let i = 0; i < state.depth.length; i++) {
    sum += state.depth[i];
    at += state.depth[i] * (i % grid.width);
  }
  return (at / sum) * grid.cell;
};

describe('toy avalanche', () => {
  it('runs down a steep slope, keeps its snow and comes to rest on the flat', () => {
    const grid = slope(35);
    const state = snowAt(grid, 5, 12);
    const before = volume(grid, state);
    let fastest = 0;
    for (let t = 0; t < 240; t++) fastest = Math.max(fastest, advance(grid, state, { mu: 0.3, xi: 1500 }, 0.5));
    expect(fastest).toBeGreaterThan(10);
    expect(fastest).toBeLessThan(70);
    expect(volume(grid, state)).toBeCloseTo(before, -1);
    expect(front(grid, state)).toBeGreaterThan(640); // out onto the flat beyond the foot of the slope
    expect(front(grid, state)).toBeLessThan(1200);
    expect(advance(grid, state, { mu: 0.3, xi: 1500 }, 0.5)).toBeLessThan(1); // at rest
  });
  it('stays put on ground flatter than its friction angle', () => {
    const grid = slope(10);
    const state = snowAt(grid, 5, 12);
    const start = centre(grid, state);
    for (let t = 0; t < 60; t++) advance(grid, state, { mu: 0.3, xi: 1500 }, 0.5);
    expect(Math.abs(centre(grid, state) - start)).toBeLessThan(15);
  });
  it('runs further with less friction', () => {
    const run = (mu: number) => {
      const grid = slope(32);
      const state = snowAt(grid, 5, 12);
      for (let t = 0; t < 300; t++) advance(grid, state, { mu, xi: 1500 }, 0.5);
      return front(grid, state);
    };
    expect(run(0.2)).toBeGreaterThan(run(0.4) + 30);
  });
});
