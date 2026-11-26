// Runs the terrain check off the main thread.
import { check, type Conditions, type Grid } from './terrainCheck';

export interface CheckRequest {
  grid: Grid;
  conditions: Conditions;
  mask?: Uint8Array;
}

self.onmessage = (event: MessageEvent<CheckRequest>) => {
  const { grid, conditions, mask } = event.data;
  const result = check(grid, conditions, mask);
  (self as DedicatedWorkerGlobalScope).postMessage(result, [result.risk.buffer, result.steepness.buffer, result.slope.buffer]);
};
