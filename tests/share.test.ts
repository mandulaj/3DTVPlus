import { describe, expect, it } from 'vitest';
import { decodeShare, decodeTrack, encodeShare, encodeTrack } from '../src/share';
import { distanceToLine, metres, windingTrack } from './helpers';

describe('track packing', () => {
  it('round-trips a track within its stated tolerance', async () => {
    const track = windingTrack(10);
    const packed = await encodeTrack(track);
    const back = await decodeTrack(packed.text);
    expect(back.length).toBe(packed.points);
    expect(metres(track[0], back[0])).toBeLessThan(2);
    expect(metres(track[track.length - 1], back[back.length - 1])).toBeLessThan(2);
    const worst = Math.max(...track.filter((_, i) => i % 5 === 0).map((p) => distanceToLine(p, back)));
    expect(worst).toBeLessThan(packed.tolerance + 2); // + rounding to 1e-5 degrees
  });

  it('keeps a day tour small', async () => {
    expect((await encodeTrack(windingTrack(10))).text.length).toBeLessThan(700);
  });

  it('coarsens a very long track to fit the budget', async () => {
    const packed = await encodeTrack(windingTrack(300), 3000);
    expect(packed.text.length).toBeLessThanOrEqual(3000);
    expect(packed.tolerance).toBeGreaterThan(4);
  });

  it('uses only characters that are safe in an address', async () => {
    expect((await encodeTrack(windingTrack(5))).text).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('rejects text that is not a track', async () => {
    await expect(decodeTrack('AAAA')).rejects.toThrow();
    await expect(decodeTrack('_w')).rejects.toThrow(/newer version/); // version byte 255
  });
});

describe('whole-view packing', () => {
  const hash = 'map=13.2/46.086/7.245&base=ch-map-winter&ov=ch-slope30~25%2Cch-skitouren~100&slf=hs%2Cb';

  it('round-trips view, name and track', async () => {
    const track = windingTrack(8);
    const packed = await encodeShare({ hash, name: 'Daboné – Les Charrières', coords: track });
    const back = await decodeShare(packed.text);
    expect(back.hash).toBe(hash);
    expect(back.name).toBe('Daboné – Les Charrières');
    expect(back.coords).not.toBeNull();
    expect(metres(track[0], back.coords![0])).toBeLessThan(2);
  });

  it('works without a track', async () => {
    const back = await decodeShare((await encodeShare({ hash, name: '', coords: null })).text);
    expect(back.hash).toBe(hash);
    expect(back.coords).toBeNull();
  });

  it('refuses a plain track text', async () => {
    await expect(decodeShare((await encodeTrack(windingTrack(2))).text)).rejects.toThrow();
  });
});
