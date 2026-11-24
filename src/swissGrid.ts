// Swiss LV95 ↔ WGS84, swisstopo's approximate formulas (about 1 m).
export function toLv95(lng: number, lat: number): [number, number] {
  const p = (lat * 3600 - 169028.66) / 10000;
  const l = (lng * 3600 - 26782.5) / 10000;
  return [
    2600072.37 + 211455.93 * l - 10938.51 * l * p - 0.36 * l * p * p - 44.54 * l ** 3,
    1200147.07 + 308807.95 * p + 3745.25 * l * l + 76.63 * p * p - 194.56 * l * l * p + 119.79 * p ** 3,
  ];
}
export function toWgs84(east: number, north: number): [number, number] {
  const y = (east - 2600000) / 1e6;
  const x = (north - 1200000) / 1e6;
  const lng = 2.6779094 + 4.728982 * y + 0.791484 * y * x + 0.1306 * y * x * x - 0.0436 * y ** 3;
  const lat = 16.9023892 + 3.238272 * x - 0.270978 * y * y - 0.002528 * x * x - 0.0447 * y * y * x - 0.014 * x ** 3;
  return [(lng * 100) / 36, (lat * 100) / 36];
}
