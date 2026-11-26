// Helpers for the data scripts: the map projections the route data comes in, turned back into
// longitude and latitude (WGS84), and reading line geometry from databases.
// Small and self-contained on purpose: no projection library is needed for a few fixed systems.

const RAD = Math.PI / 180;

/** Swiss LV95 (EPSG:2056): swisstopo's approximate formulas, good to about a metre. */
export function fromLv95(east, north) {
  const y = (east - 2600000) / 1e6;
  const x = (north - 1200000) / 1e6;
  const lng = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
  return [(lng * 100) / 36, (lat * 100) / 36];
}

/** Inverse Lambert conformal conic with two standard parallels on an ellipsoid. Angles in degrees. */
function lambert({ a, f, lat0, lon0, lat1, lat2, x0, y0 }) {
  const e = Math.sqrt(f * (2 - f));
  const m = (lat) => Math.cos(lat) / Math.sqrt(1 - (e * Math.sin(lat)) ** 2);
  const t = (lat) => Math.tan(Math.PI / 4 - lat / 2) / ((1 - e * Math.sin(lat)) / (1 + e * Math.sin(lat))) ** (e / 2);
  const [p0, p1, p2] = [lat0, lat1, lat2].map((v) => v * RAD);
  const n = (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2)));
  const F = m(p1) / (n * t(p1) ** n);
  const r0 = a * F * t(p0) ** n;
  return (x, y) => {
    const dx = x - x0;
    const dy = r0 - (y - y0);
    const r = Math.sign(n) * Math.hypot(dx, dy);
    const tt = (r / (a * F)) ** (1 / n);
    const lon = Math.atan2(dx, dy) / n + lon0 * RAD;
    let lat = Math.PI / 2 - 2 * Math.atan(tt);
    for (let i = 0; i < 8; i++) lat = Math.PI / 2 - 2 * Math.atan(tt * ((1 - e * Math.sin(lat)) / (1 + e * Math.sin(lat))) ** (e / 2));
    return [lon, lat]; // radians, on the projection's own ellipsoid
  };
}

/** French Lambert-93 (EPSG:2154). Its datum (RGF93) is WGS84 for our purposes. */
const lambert93 = lambert({ a: 6378137, f: 1 / 298.257222101, lat0: 46.5, lon0: 3, lat1: 49, lat2: 44, x0: 700000, y0: 6600000 });
export function fromLambert93(x, y) {
  const [lon, lat] = lambert93(x, y);
  return [lon / RAD, lat / RAD];
}

/** Austrian Lambert (EPSG:31287): on the Bessel ellipsoid in the MGI datum, which lies some 100 m off WGS84. */
const BESSEL = { a: 6377397.155, f: 1 / 299.1528128 };
const austria = lambert({ ...BESSEL, lat0: 47.5, lon0: 13 + 1 / 3, lat1: 49, lat2: 46, x0: 400000, y0: 400000 });
// MGI to WGS84: shift in metres, rotation in arc seconds, scale in parts per million (EPSG:1618).
const SHIFT = { dx: 577.326, dy: 90.129, dz: 463.919, rx: 5.137, ry: 1.474, rz: 5.297, s: 2.4232 };
export function fromAustriaLambert(x, y) {
  const [lon, lat] = austria(x, y);
  // To Earth-centred coordinates on Bessel (height 0: the few hundred metres do not matter here)…
  const e2 = BESSEL.f * (2 - BESSEL.f);
  const N = BESSEL.a / Math.sqrt(1 - e2 * Math.sin(lat) ** 2);
  const X = N * Math.cos(lat) * Math.cos(lon);
  const Y = N * Math.cos(lat) * Math.sin(lon);
  const Z = N * (1 - e2) * Math.sin(lat);
  // …shifted, turned and scaled into WGS84…
  const arc = Math.PI / 648000;
  const [rx, ry, rz] = [SHIFT.rx * arc, SHIFT.ry * arc, SHIFT.rz * arc];
  const k = 1 + SHIFT.s * 1e-6;
  const X2 = SHIFT.dx + k * (X - rz * Y + ry * Z);
  const Y2 = SHIFT.dy + k * (rz * X + Y - rx * Z);
  const Z2 = SHIFT.dz + k * (-ry * X + rx * Y + Z);
  // …and back to longitude and latitude on the WGS84 ellipsoid.
  const a = 6378137;
  const f = 1 / 298.257223563;
  const w2 = f * (2 - f);
  const p = Math.hypot(X2, Y2);
  let phi = Math.atan2(Z2, p * (1 - w2));
  for (let i = 0; i < 6; i++) {
    const n = a / Math.sqrt(1 - w2 * Math.sin(phi) ** 2);
    phi = Math.atan2(Z2 + w2 * n * Math.sin(phi), p);
  }
  return [Math.atan2(Y2, X2) / RAD, phi / RAD];
}

/** Lines of a well-known-binary geometry (line or multi-line, with or without heights). */
export function wkbLines(buffer, at = { offset: 0 }) {
  const little = buffer.readUInt8(at.offset) === 1;
  const u32 = () => { const v = little ? buffer.readUInt32LE(at.offset) : buffer.readUInt32BE(at.offset); at.offset += 4; return v; };
  const f64 = () => { const v = little ? buffer.readDoubleLE(at.offset) : buffer.readDoubleBE(at.offset); at.offset += 8; return v; };
  at.offset += 1;
  const code = u32();
  const hasZ = Boolean(code & 0x80000000) || Math.floor((code & 0xffff) / 1000) === 1;
  const type = (code & 0xffff) % 1000;
  if (type === 2) {
    const count = u32();
    const line = [];
    for (let i = 0; i < count; i++) {
      const x = f64(), y = f64();
      if (hasZ) f64();
      line.push([x, y]);
    }
    return [line];
  }
  if (type === 5) {
    const count = u32();
    const lines = [];
    for (let i = 0; i < count; i++) lines.push(...wkbLines(buffer, at));
    return lines;
  }
  return [];
}

