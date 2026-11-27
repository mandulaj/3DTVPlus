import { describe, expect, it } from 'vitest';
import { parseTrack, readTrack } from '../src/trackFiles';

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer;
const points = Array.from({ length: 30 }, (_, i) => [7.05 + i * 0.001, 46.08 + i * 0.0006] as [number, number]);

describe('GPX', () => {
  const trkpts = points.map(([x, y]) => `<trkpt lat="${y}" lon="${x}"><ele>900</ele></trkpt>`).join('');
  const gpx = (body: string) => `<?xml version="1.0"?><gpx xmlns="http://www.topografix.com/GPX/1/1">${body}</gpx>`;

  it('reads a track, one line per segment', () => {
    const segments = parseTrack('tour.gpx', bytes(gpx(`<trk><trkseg>${trkpts}</trkseg><trkseg>${trkpts}</trkseg></trk>`)));
    expect(segments).toHaveLength(2);
    expect(segments[0]).toHaveLength(30);
    expect(segments[0][3][0]).toBeCloseTo(points[3][0], 6);
    expect(segments[0][3][1]).toBeCloseTo(points[3][1], 6);
  });

  it('falls back to a planned route, then to waypoints', () => {
    const rte = points.map(([x, y]) => `<rtept lat="${y}" lon="${x}"/>`).join('');
    expect(parseTrack('plan.gpx', bytes(gpx(`<rte>${rte}</rte>`)))[0]).toHaveLength(30);
    const wpt = points.slice(0, 5).map(([x, y]) => `<wpt lat="${y}" lon="${x}"/>`).join('');
    expect(parseTrack('points.gpx', bytes(gpx(wpt)))[0]).toHaveLength(5);
  });

  it('skips points with impossible coordinates', () => {
    const bad = `<trkpt lat="146" lon="7"/><trkpt lat="abc" lon="7"/>`;
    expect(parseTrack('t.gpx', bytes(gpx(`<trk><trkseg>${bad}${trkpts}</trkseg></trk>`)))[0]).toHaveLength(30);
  });

  it('returns nothing for a file without points and throws on broken XML', () => {
    expect(parseTrack('empty.gpx', bytes(gpx('')))).toEqual([]);
    expect(() => parseTrack('broken.gpx', bytes('<gpx><trk>'))).toThrow();
  });
});

describe('TCX', () => {
  it('reads track points with positions and ignores those without', () => {
    const body = points
      .map(([x, y]) => `<Trackpoint><Time>2026-01-01T00:00:00Z</Time><Position><LatitudeDegrees>${y}</LatitudeDegrees><LongitudeDegrees>${x}</LongitudeDegrees></Position></Trackpoint>`)
      .join('');
    const tcx = `<?xml version="1.0"?><TrainingCenterDatabase xmlns="http://www.garmin.com/xmlschemas/TrainingCenterDatabase/v2"><Activities><Activity><Lap><Track><Trackpoint><Time>x</Time></Trackpoint>${body}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`;
    const segments = parseTrack('ride.tcx', bytes(tcx));
    expect(segments).toHaveLength(1);
    expect(segments[0]).toHaveLength(30);
    expect(segments[0][0][0]).toBeCloseTo(points[0][0], 6);
  });
});

describe('FIT', () => {
  const SEMICIRCLE = 180 / 2 ** 31;
  const int32 = (value: number, little: boolean) => {
    const view = new DataView(new ArrayBuffer(4));
    view.setInt32(0, value, little);
    return [...new Uint8Array(view.buffer)];
  };
  /** A FIT file with a "record" message per point: timestamp, latitude, longitude and one developer field. */
  function fit(little: boolean, options: { compressed?: boolean; invalid?: boolean; headerSize?: number } = {}): ArrayBuffer {
    const u16 = (v: number, le: boolean) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
    const data: number[] = [];
    data.push(0x40, 0, 0, ...u16(0, true), 1, 0, 4, 134); // definition, local 0: file_id, one 4-byte field
    data.push(0x00, 1, 2, 3, 4);
    // definition, local 1: record (global 20) with a developer field
    data.push(0x60 | 1, 0, little ? 0 : 1, ...u16(20, little), 3, 253, 4, 134, 0, 4, 133, 1, 4, 133, 1, 0, 2, 0);
    points.forEach(([x, y], i) => {
      const header = options.compressed && i % 2 ? 0x80 | (1 << 5) | (i & 31) : 0x01;
      data.push(header, 0, 0, 0, i, ...int32(Math.round(y / SEMICIRCLE), little), ...int32(Math.round(x / SEMICIRCLE), little), 9, 9);
    });
    if (options.invalid) data.push(0x01, 0, 0, 0, 0, ...int32(0x7fffffff, little), ...int32(0x7fffffff, little), 0, 0);
    const headerSize = options.headerSize ?? 14;
    const header = [headerSize, 0x20, 0, 0, data.length & 255, (data.length >> 8) & 255, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0].slice(0, headerSize);
    return Uint8Array.from([...header, ...data, 0, 0]).buffer;
  }

  it('reads positions from little- and big-endian files', () => {
    for (const little of [true, false]) {
      const [track] = parseTrack('watch.fit', fit(little));
      expect(track).toHaveLength(30);
      expect(track[7][0]).toBeCloseTo(points[7][0], 5);
      expect(track[7][1]).toBeCloseTo(points[7][1], 5);
    }
  });

  it('handles compressed-timestamp records, 12-byte headers and invalid positions', () => {
    expect(parseTrack('a.fit', fit(true, { compressed: true }))[0]).toHaveLength(30);
    expect(parseTrack('b.fit', fit(true, { headerSize: 12 }))[0]).toHaveLength(30);
    expect(parseTrack('c.fit', fit(false, { invalid: true }))[0]).toHaveLength(30);
  });

  it('rejects a file that is not FIT', () => {
    expect(() => parseTrack('x.fit', new Uint8Array(40).buffer)).toThrow(/not a FIT file/);
  });
});

describe('file type', () => {
  it('goes by content when the name has no useful extension', () => {
    const gpx = `<?xml version="1.0"?><gpx>${points.map(([x, y]) => `<trkpt lat="${y}" lon="${x}"/>`).join('')}</gpx>`;
    expect(parseTrack('download?id=7', bytes(gpx))[0]).toHaveLength(30);
    expect(() => parseTrack('notes.txt', bytes('hello'))).toThrow(/unsupported/);
  });
});

describe('recorded heights and times', () => {
  it('reads them from GPX and reports none when the file has none', () => {
    const start = Date.UTC(2026, 1, 14, 8, 0, 0);
    const body = points.map(([x, y], i) => `<trkpt lat="${y}" lon="${x}"><ele>${1500 + i * 2.5}</ele><time>${new Date(start + i * 5000).toISOString()}</time></trkpt>`).join('');
    const withData = readTrack('a.gpx', bytes(`<gpx xmlns="http://www.topografix.com/GPX/1/1"><trk><trkseg>${body}</trkseg></trk></gpx>`));
    expect(withData.ele).toHaveLength(30);
    expect(withData.ele![4]).toBeCloseTo(1510, 5);
    expect(withData.time![4]).toBe(start + 20000);
    const bare = readTrack('b.gpx', bytes(`<gpx>${points.map(([x, y]) => `<trkpt lat="${y}" lon="${x}"/>`).join('')}</gpx>`));
    expect(bare.ele).toBeNull();
    expect(bare.time).toBeNull();
  });

  it('reads them from TCX', () => {
    const body = points
      .map(([x, y], i) => `<Trackpoint><Time>2026-02-14T08:00:${String(i).padStart(2, '0')}Z</Time><Position><LatitudeDegrees>${y}</LatitudeDegrees><LongitudeDegrees>${x}</LongitudeDegrees></Position><AltitudeMeters>${800 + i}</AltitudeMeters></Trackpoint>`)
      .join('');
    const tcx = readTrack('r.tcx', bytes(`<TrainingCenterDatabase><Activities><Activity><Lap><Track>${body}</Track></Lap></Activity></Activities></TrainingCenterDatabase>`));
    expect(tcx.ele![10]).toBe(810);
    expect(tcx.time![10]! - tcx.time![0]!).toBe(10000);
  });

  it('reads time and altitude from FIT, including compressed timestamps', () => {
    const FIT_EPOCH = 631065600;
    const fitStart = 1_140_000_000; // seconds on the FIT clock
    const data: number[] = [];
    const u32 = (v: number) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    const SEMI = 180 / 2 ** 31;
    // definition local 0: record, little endian: timestamp, lat, lon, altitude (uint16)
    data.push(0x40, 0, 0, 20, 0, 4, 253, 4, 134, 0, 4, 133, 1, 4, 133, 2, 2, 132);
    // definition local 1: record without a timestamp field (time comes from the compressed header)
    data.push(0x41, 0, 0, 20, 0, 3, 0, 4, 133, 1, 4, 133, 2, 2, 132);
    points.slice(0, 6).forEach(([x, y], i) => {
      const position = [...u32(Math.round(y / SEMI)), ...u32(Math.round(x / SEMI))];
      const altitude = (1200 + i * 10 + 500) * 5;
      if (i < 3) data.push(0x00, ...u32(fitStart + i * 4), ...position, altitude & 255, altitude >> 8);
      else data.push(0x80 | (1 << 5) | ((fitStart + i * 4) & 31), ...position, altitude & 255, altitude >> 8);
    });
    const file = Uint8Array.from([14, 0x20, 0, 0, data.length & 255, data.length >> 8, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0, ...data, 0, 0]).buffer;
    const fit = readTrack('w.fit', file);
    expect(fit.segments[0]).toHaveLength(6);
    expect(fit.ele).toEqual([1200, 1210, 1220, 1230, 1240, 1250]);
    expect(fit.time!.map((t) => t! / 1000 - FIT_EPOCH - fitStart)).toEqual([0, 4, 8, 12, 16, 20]);
  });

  it('rejects a truncated FIT definition header cleanly', () => {
    // Valid 14-byte FIT header claiming 4 bytes of data, containing a truncated definition message (0x40).
    const truncated = Uint8Array.from([14, 0x20, 0, 0, 4, 0, 0, 0, 0x2e, 0x46, 0x49, 0x54, 0, 0, 0x40, 0, 0, 0]).buffer;
    expect(() => readTrack('broken.fit', truncated)).toThrow('damaged FIT file');
  });
});
