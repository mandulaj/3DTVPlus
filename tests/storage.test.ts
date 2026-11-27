import { describe, expect, it } from 'vitest';
import { idbDelete, idbGet, idbGetAll, idbPut } from '../src/storage';

describe('client-side storage (IndexedDB / memory fallback)', () => {
  it('round-trips key-value entries and deletes them cleanly', async () => {
    await idbPut('kv', 'test-key', { hello: 'alps', count: 3 });
    expect(await idbGet('kv', 'test-key')).toEqual({ hello: 'alps', count: 3 });
    await idbDelete('kv', 'test-key');
    expect(await idbGet('kv', 'test-key')).toBeUndefined();
  });

  it('stores and lists customLayers records', async () => {
    await idbPut('customLayers', 'layer-1', { id: 'layer-1', name: 'Strava 2026' });
    const all = await idbGetAll<{ id: string; name: string }>('customLayers');
    expect(all.some((item) => item.id === 'layer-1' && item.name === 'Strava 2026')).toBe(true);
    await idbDelete('customLayers', 'layer-1');
  });
});
