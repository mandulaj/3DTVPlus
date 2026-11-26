// Declarative catalogue of open map layers. All endpoints are keyless and
// CORS-enabled unless `needsProxy` is set.

export type LayerParam =
  | { kind: 'date'; daysAgo: number }
  | { kind: 'select'; options: { value: string; label: string }[]; default: string };

/** Providers whose data needs a personal API key (entered under Settings, kept in the browser). */
export const KEY_PROVIDERS = {
  mapy: { name: 'Mapy.com', help: 'Free key from developer.mapy.com' },
  windy: { name: 'Windy webcams', help: 'Free Webcams API key from api.windy.com (webcams with preview pictures)' },
} as const;
export type KeyProvider = keyof typeof KEY_PROVIDERS;

export interface LayerDef {
  id: string;
  name: string;
  group: string;
  role: 'base' | 'overlay';
  /** raster: XYZ tiles; style: external MapLibre vector style merged into the map */
  kind: 'raster' | 'style';
  /** XYZ template. May contain {param} (see `param`). */
  tiles?: string;
  /** Resolve the template at runtime (e.g. RainViewer needs a lookup first). */
  resolveTiles?: () => Promise<string>;
  styleUrl?: string;
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  attribution: string;
  opacity?: number;
  param?: LayerParam;
  /** Needs the user's own API key for this provider: `{key}` in the template is replaced by it. */
  needsKey?: KeyProvider;
  /** Server sends no CORS headers: only works via dev server or a CORS proxy. */
  needsProxy?: boolean;
  note?: string;
}

const SWISSTOPO = '© <a href="https://www.swisstopo.admin.ch" target="_blank">swisstopo</a>';
const OSM = '© <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a> contributors';

const swiss = (layer: string, ext: 'jpeg' | 'png', time = 'current') =>
  `https://wmts.geo.admin.ch/1.0.0/${layer}/default/${time}/3857/{z}/{x}/{y}.${ext}`;

const MAPY = '<a href="https://mapy.com" target="_blank">Mapy.com</a> © <a href="https://api.mapy.com/copyright" target="_blank">Seznam.cz a.s. and others</a>';
const mapy = (mapset: string) => `https://api.mapy.com/v1/maptiles/${mapset}/256/{z}/{x}/{y}?apikey={key}`;

const ign = (layer: string, format: string) =>
  'https://data.geopf.fr/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&STYLE=normal&TILEMATRIXSET=PM' +
  `&LAYER=${layer}&FORMAT=${format}&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}`;

const basemapAt = (layer: string, style: string, ext: string) =>
  `https://mapsneu.wien.gv.at/basemap/${layer}/${style}/google3857/{z}/{y}/{x}.${ext}`;

const slfMap = (layer: string) =>
  `https://map.slf.ch/mapcache/wmts/1.0.0/${layer}/default/GoogleMapsCompatible/{z}/{y}/{x}.png`;

// SWISSIMAGE time travel: years with at least some coverage (1928 was never flown).
const photoYears: { value: string; label: string }[] = [];
for (let y = 2025; y >= 1926; y--) if (y !== 1928) photoYears.push({ value: String(y), label: String(y) });

const zeitreihenYears: { value: string; label: string }[] = [];
for (let y = 2021; y >= 1844; y--) zeitreihenYears.push({ value: `${y}1231`, label: String(y) });

function base(def: Omit<LayerDef, 'role' | 'kind'> & { kind?: LayerDef['kind'] }): LayerDef {
  return { kind: 'raster', ...def, role: 'base' };
}
function overlay(def: Omit<LayerDef, 'role' | 'kind'>): LayerDef {
  return { kind: 'raster', ...def, role: 'overlay' };
}

export const CATALOG: LayerDef[] = [
  // ───────────── Base maps ─────────────
  base({ id: 'ch-map', group: 'Switzerland', name: 'swisstopo national map', tiles: swiss('ch.swisstopo.pixelkarte-farbe', 'jpeg'), maxzoom: 19, attribution: SWISSTOPO }),
  base({ id: 'ch-map-winter', group: 'Switzerland', name: 'swisstopo national map (winter)', tiles: swiss('ch.swisstopo.pixelkarte-farbe-winter', 'jpeg'), maxzoom: 19, attribution: SWISSTOPO }),
  base({ id: 'ch-map-grey', group: 'Switzerland', name: 'swisstopo national map (grey)', tiles: swiss('ch.swisstopo.pixelkarte-grau', 'jpeg'), maxzoom: 19, attribution: SWISSTOPO }),
  base({ id: 'ch-ortho', group: 'Switzerland', name: 'SWISSIMAGE aerial (10 cm)', tiles: swiss('ch.swisstopo.swissimage', 'jpeg'), maxzoom: 20, attribution: SWISSTOPO }),
  base({ id: 'ch-vt-light', group: 'Switzerland', name: 'swisstopo light base map (vector)', kind: 'style', styleUrl: 'https://vectortiles.geo.admin.ch/styles/ch.swisstopo.leichte-basiskarte.vt/style.json', attribution: SWISSTOPO }),
  base({ id: 'ch-vt-base', group: 'Switzerland', name: 'swisstopo base map (vector)', kind: 'style', styleUrl: 'https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/style.json', attribution: SWISSTOPO }),
  base({ id: 'ch-vt-winter', group: 'Switzerland', name: 'swisstopo winter base map (vector)', kind: 'style', styleUrl: 'https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap-winter.vt/style.json', attribution: SWISSTOPO }),

  base({ id: 'opentopo', group: 'OpenStreetMap', name: 'OpenTopoMap', tiles: 'https://tile.opentopomap.org/{z}/{x}/{y}.png', maxzoom: 17, attribution: `${OSM}, SRTM | style © <a href="https://opentopomap.org" target="_blank">OpenTopoMap</a> (CC-BY-SA)` }),
  base({ id: 'osm', group: 'OpenStreetMap', name: 'OSM standard', tiles: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxzoom: 19, attribution: OSM }),
  base({ id: 'cyclosm', group: 'OpenStreetMap', name: 'CyclOSM', tiles: 'https://a.tile-cyclosm.openstreetmap.fr/cyclosm/{z}/{x}/{y}.png', maxzoom: 19, attribution: `${OSM} | CyclOSM` }),
  base({ id: 'osm-hot', group: 'OpenStreetMap', name: 'Humanitarian', tiles: 'https://a.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png', maxzoom: 19, attribution: `${OSM} | HOT` }),
  base({ id: 'ofm-liberty', group: 'OpenStreetMap', name: 'OpenFreeMap Liberty (vector)', kind: 'style', styleUrl: 'https://tiles.openfreemap.org/styles/liberty', attribution: `<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © OpenMapTiles, ${OSM}` }),
  base({ id: 'ofm-positron', group: 'OpenStreetMap', name: 'OpenFreeMap Positron (vector)', kind: 'style', styleUrl: 'https://tiles.openfreemap.org/styles/positron', attribution: `<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © OpenMapTiles, ${OSM}` }),

  base({ id: 'mapy-outdoor', group: 'Mapy.com (API key)', name: 'Mapy.com outdoor', tiles: mapy('outdoor'), tileSize: 256, maxzoom: 19, attribution: MAPY, needsKey: 'mapy' }),
  base({ id: 'mapy-winter', group: 'Mapy.com (API key)', name: 'Mapy.com winter', tiles: mapy('winter'), tileSize: 256, maxzoom: 19, attribution: MAPY, needsKey: 'mapy' }),

  base({ id: 'esri-imagery', group: 'Satellite', name: 'Esri World Imagery', tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxzoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
  base({ id: 's2cloudless', group: 'Satellite', name: 'Sentinel-2 cloudless 2024 (EOX)', tiles: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/{z}/{y}/{x}.jpg', maxzoom: 15, attribution: '<a href="https://s2maps.eu" target="_blank">Sentinel-2 cloudless</a> by EOX IT Services GmbH (contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0' }),
  base({
    id: 'gibs-hls', group: 'Satellite', name: 'Satellite by date, incl. winter (NASA HLS, 30 m)',
    tiles: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/HLS_S30_Nadir_BRDF_Adjusted_Reflectance/default/{param}/GoogleMapsCompatible_Level12/{z}/{y}/{x}.png',
    maxzoom: 12, param: { kind: 'date', daysAgo: 6 }, attribution: 'NASA EOSDIS GIBS, HLS',
    note: 'One satellite pass per day: only a strip of the map is covered on any given date. Try neighbouring dates.',
  }),
  base({ id: 'gibs-truecolor', group: 'Satellite', name: 'NASA MODIS true colour (daily)', tiles: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/{param}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg', maxzoom: 9, param: { kind: 'date', daysAgo: 1 }, attribution: 'NASA EOSDIS GIBS' }),

  base({ id: 'at-map', group: 'Neighbours', name: 'Austria basemap.at', tiles: basemapAt('geolandbasemap', 'normal', 'png'), maxzoom: 19, attribution: '<a href="https://basemap.at" target="_blank">basemap.at</a>' }),
  base({ id: 'at-ortho', group: 'Neighbours', name: 'Austria aerial', tiles: basemapAt('bmaporthofoto30cm', 'normal', 'jpeg'), maxzoom: 19, attribution: '<a href="https://basemap.at" target="_blank">basemap.at</a>' }),
  base({ id: 'fr-plan', group: 'Neighbours', name: 'France IGN Plan', tiles: ign('GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2', 'image/png'), maxzoom: 19, attribution: '© IGN-F/Géoportail' }),
  base({ id: 'fr-ortho', group: 'Neighbours', name: 'France IGN aerial', tiles: ign('ORTHOIMAGERY.ORTHOPHOTOS', 'image/jpeg'), maxzoom: 19, attribution: '© IGN-F/Géoportail' }),
  base({ id: 'de-topplus', group: 'Neighbours', name: 'Germany TopPlusOpen', tiles: 'https://sgx.geodatenzentrum.de/wmts_topplus_open/tile/1.0.0/web/default/WEBMERCATOR/{z}/{y}/{x}.png', maxzoom: 18, attribution: '© <a href="https://www.bkg.bund.de" target="_blank">BKG</a>' }),
  base({ id: 'it-bz-ortho', group: 'Neighbours', name: 'South Tyrol aerial 2023', tiles: 'https://geoservices.buergernetz.bz.it/mapproxy/root/wmts/p_bz-Orthoimagery:Aerial-2023-RGB/EPSG_3857/{z}/{x}/{y}.png', maxzoom: 20, attribution: '© Autonome Provinz Bozen' }),
  base({ id: 'no-topo', group: 'Neighbours', name: 'Norway Kartverket topo', tiles: 'https://cache.kartverket.no/v1/wmts/1.0.0/topo/default/webmercator/{z}/{y}/{x}.png', maxzoom: 18, attribution: '© <a href="https://www.kartverket.no" target="_blank">Kartverket</a>' }),

  // ───────────── Overlays ─────────────
  overlay({ id: 'ch-hiking', group: 'Routes (CH)', name: 'Hiking trails', tiles: swiss('ch.swisstopo.swisstlm3d-wanderwege', 'png'), maxzoom: 18, attribution: SWISSTOPO }),
  overlay({ id: 'ch-skitouren', group: 'Routes (CH)', name: 'Ski touring routes', tiles: swiss('ch.swisstopo-karto.skitouren', 'png'), maxzoom: 17, attribution: SWISSTOPO }),
  overlay({ id: 'ch-snowshoe', group: 'Routes (CH)', name: 'Snowshoe routes', tiles: swiss('ch.swisstopo-karto.schneeschuhrouten', 'png'), maxzoom: 17, attribution: SWISSTOPO }),
  overlay({ id: 'ch-wanderland', group: 'Routes (CH)', name: 'Hiking in Switzerland', tiles: swiss('ch.astra.wanderland', 'png'), maxzoom: 18, attribution: '© ASTRA / SchweizMobil' }),
  overlay({ id: 'ch-veloland', group: 'Routes (CH)', name: 'Cycling in Switzerland', tiles: swiss('ch.astra.veloland', 'png'), maxzoom: 18, attribution: '© ASTRA / SchweizMobil' }),
  overlay({ id: 'ch-mtbland', group: 'Routes (CH)', name: 'Mountain biking in Switzerland', tiles: swiss('ch.astra.mountainbikeland', 'png'), maxzoom: 18, attribution: '© ASTRA / SchweizMobil' }),
  overlay({ id: 'ch-winter-huts', group: 'Routes (CH)', name: 'Winter accommodation', tiles: swiss('ch.swisstopo.unterkuenfte-winter', 'png'), maxzoom: 18, attribution: SWISSTOPO }),
  overlay({ id: 'ch-winter-lifts', group: 'Routes (CH)', name: 'Lifts in winter', tiles: swiss('ch.swisstopo.bahnen-winter', 'png'), maxzoom: 18, attribution: SWISSTOPO }),

  overlay({ id: 'ch-slope30', group: 'Avalanche terrain', name: 'Slope > 30° (swisstopo)', tiles: swiss('ch.swisstopo.hangneigung-ueber_30', 'png'), maxzoom: 17, opacity: 0.6, attribution: SWISSTOPO }),
  overlay({ id: 'ch-slope-classes', group: 'Avalanche terrain', name: 'Slope classes (swisstopo)', tiles: swiss('ch.swisstopo-karto.hangneigung', 'png'), maxzoom: 17, opacity: 0.6, attribution: SWISSTOPO }),
  overlay({ id: 'ch-protect-forest', group: 'Avalanche terrain', name: 'Avalanche protection forest', tiles: swiss('ch.bafu.silvaprotect-lawinen', 'png'), maxzoom: 18, opacity: 0.6, attribution: '© BAFU' }),
  overlay({ id: 'slf-cat', group: 'Avalanche terrain', name: 'Classified avalanche terrain CAT (SLF)', tiles: slfMap('ch.slf.global-terrainclassification-cat'), maxzoom: 16, opacity: 0.6, needsProxy: true, attribution: '© <a href="https://www.slf.ch" target="_blank">WSL-SLF</a> (unofficial use)' }),
  overlay({ id: 'slf-ath', group: 'Avalanche terrain', name: 'Avalanche terrain hazard ATH (SLF)', tiles: slfMap('ch.slf.global-terrainclassification-ath'), maxzoom: 16, opacity: 0.6, needsProxy: true, attribution: '© <a href="https://www.slf.ch" target="_blank">WSL-SLF</a> (unofficial use)' }),
  overlay({ id: 'slf-slope', group: 'Avalanche terrain', name: 'Slope angle (SLF, global)', tiles: slfMap('ch.slf.globalslope'), maxzoom: 16, opacity: 0.6, needsProxy: true, attribution: '© <a href="https://www.slf.ch" target="_blank">WSL-SLF</a> (unofficial use)' }),
  overlay({ id: 'fr-slopes', group: 'Avalanche terrain', name: 'Mountain slopes (France IGN)', tiles: ign('GEOGRAPHICALGRIDSYSTEMS.SLOPES.MOUNTAIN', 'image/png'), maxzoom: 17, opacity: 0.6, attribution: '© IGN-F/Géoportail' }),

  overlay({ id: 'ch-wildlife', group: 'Protected areas (CH)', name: 'Wildlife quiet zones', tiles: swiss('ch.bafu.wrz-wildruhezonen_portal', 'png'), maxzoom: 18, opacity: 0.7, attribution: '© BAFU' }),
  overlay({ id: 'ch-huntingban', group: 'Protected areas (CH)', name: 'Hunting ban areas', tiles: swiss('ch.bafu.wrz-jagdbanngebiete_select', 'png'), maxzoom: 18, opacity: 0.7, attribution: '© BAFU' }),

  overlay({ id: 'ch-geology', group: 'Thematic (CH)', name: 'Geology (GeoCover)', tiles: swiss('ch.swisstopo.geologie-geocover', 'png'), maxzoom: 16, opacity: 0.7, attribution: SWISSTOPO }),
  overlay({
    id: 'ch-photos', group: 'Thematic (CH)', name: 'Historic aerial photos (year)',
    // "blankless" (map.ts) drops the empty white tiles served where a year has no photos, so the map shows through.
    tiles: `blankless://${swiss('ch.swisstopo.swissimage-product', 'jpeg', '{param}').replace('https://', '')}`,
    maxzoom: 19, param: { kind: 'select', options: photoYears, default: '1946' }, attribution: SWISSTOPO,
    note: 'Each year covers only the parts of Switzerland flown that year; the map shows through elsewhere.',
  }),
  overlay({ id: 'ch-historic', group: 'Thematic (CH)', name: 'Historic maps (journey through time)', tiles: swiss('ch.swisstopo.zeitreihen', 'png', '{param}'), maxzoom: 18, param: { kind: 'select', options: zeitreihenYears, default: '19001231' }, attribution: SWISSTOPO }),
  overlay({ id: 'ch-icao', group: 'Thematic (CH)', name: 'ICAO aeronautical chart', tiles: swiss('ch.bazl.luftfahrtkarten-icao', 'png'), maxzoom: 12, attribution: '© BAZL / swisstopo' }),
  overlay({ id: 'ch-boundaries', group: 'Thematic (CH)', name: 'Municipal boundaries', tiles: swiss('ch.swisstopo.swissboundaries3d-gemeinde-flaeche.fill', 'png'), maxzoom: 18, attribution: SWISSTOPO }),

  overlay({ id: 'osm-pistes', group: 'OpenStreetMap overlays', name: 'Ski pistes (OpenSnowMap)', tiles: 'https://tiles.opensnowmap.org/pistes/{z}/{x}/{y}.png', maxzoom: 18, attribution: `${OSM} | <a href="https://www.opensnowmap.org" target="_blank">OpenSnowMap</a>` }),
  overlay({ id: 'wmt-hiking', group: 'OpenStreetMap overlays', name: 'Hiking routes (Waymarked Trails)', tiles: 'https://tile.waymarkedtrails.org/hiking/{z}/{x}/{y}.png', maxzoom: 18, attribution: `${OSM} | <a href="https://waymarkedtrails.org" target="_blank">Waymarked Trails</a>` }),
  overlay({ id: 'wmt-cycling', group: 'OpenStreetMap overlays', name: 'Cycling routes (Waymarked Trails)', tiles: 'https://tile.waymarkedtrails.org/cycling/{z}/{x}/{y}.png', maxzoom: 18, attribution: `${OSM} | Waymarked Trails` }),
  overlay({ id: 'wmt-mtb', group: 'OpenStreetMap overlays', name: 'MTB routes (Waymarked Trails)', tiles: 'https://tile.waymarkedtrails.org/mtb/{z}/{x}/{y}.png', maxzoom: 18, attribution: `${OSM} | Waymarked Trails` }),
  overlay({ id: 'wmt-slopes', group: 'OpenStreetMap overlays', name: 'Winter sport slopes (Waymarked Trails)', tiles: 'https://tile.waymarkedtrails.org/slopes/{z}/{x}/{y}.png', maxzoom: 18, attribution: `${OSM} | Waymarked Trails` }),
  overlay({ id: 'openrailway', group: 'OpenStreetMap overlays', name: 'Railways (OpenRailwayMap)', tiles: 'https://tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png', maxzoom: 19, attribution: `${OSM} | <a href="https://www.openrailwaymap.org" target="_blank">OpenRailwayMap</a> (CC-BY-SA)` }),

  overlay({ id: 'gibs-snow', group: 'Snow & weather (global)', name: 'MODIS snow cover NDSI (daily)', tiles: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_NDSI_Snow_Cover/default/{param}/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png', maxzoom: 8, opacity: 0.7, param: { kind: 'date', daysAgo: 1 }, attribution: 'NASA EOSDIS GIBS' }),
  overlay({
    id: 'rainviewer', group: 'Snow & weather (global)', name: 'Precipitation radar (RainViewer)', maxzoom: 7, opacity: 0.7,
    attribution: '<a href="https://www.rainviewer.com" target="_blank">RainViewer</a>',
    resolveTiles: async () => {
      const info = await (await fetch('https://api.rainviewer.com/public/weather-maps.json')).json();
      const latest = info.radar.past[info.radar.past.length - 1];
      return `${info.host}${latest.path}/256/{z}/{x}/{y}/2/1_1.png`;
    },
  }),
];

export const DEFAULT_BASE = 'ch-map';
export const byId = new Map(CATALOG.map((l) => [l.id, l]));

export function defaultParam(def: LayerDef): string | undefined {
  if (!def.param) return undefined;
  if (def.param.kind === 'select') return def.param.default;
  const d = new Date(Date.now() - def.param.daysAgo * 86400_000);
  return d.toISOString().slice(0, 10);
}
