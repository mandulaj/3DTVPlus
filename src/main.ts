import './ui/style.css';
import * as maplibregl from 'maplibre-gl';
import { createMap, readHash, watchVectorSource, writeHash } from './map';
import { enableKeys } from './keys';
import { enableLookAround } from './lookAround';
import { enableTrackDrop } from './tracks';
import { PeakLabels } from './peaks';
import { Planner } from './planner';
import { enableContextMenu } from './contextMenu';
import { enableSearch } from './search';
import { Weather } from './weather';
import { decodeShare, decodeTrack, encodeShare, encodeTrack, type SharedView } from './share';
import { parseTrack } from './trackFiles';
import { DEFAULT_BASE, byId } from './layers/catalog';
import { LayerManager } from './layers/manager';
import { SNOW_PRODUCTS, STATION_TYPES, SlfLayers, type SnowProduct, type StationType } from './layers/slf';
import { SunController } from './sun/sun';
import { Panel, type SlfState, type TerrainState } from './ui/panel';
import { SunControls } from './ui/sunControls';
import { h, toast } from './ui/dom';
import { unofficial } from './unofficial';
import { enableRouteInfo } from './layers/routes';
import { Skitourenguru } from './layers/skitourenguru';
import { SAC_DISCIPLINES, SacRoutes, type SacDiscipline } from './layers/sac';

// A shared link carries everything in one compressed parameter: unfold it into the ordinary
// address before anything reads the address.
let sharedView: SharedView | null = null;
let sharedError = '';
{
  const packed = new URLSearchParams(location.hash.replace(/^#/, '')).get('s');
  if (packed) {
    try {
      sharedView = await decodeShare(packed);
      history.replaceState(history.state, '', `#${sharedView.hash}`);
    } catch (error) {
      sharedError = (error as Error).message;
      history.replaceState(history.state, '', '#');
    }
  }
}

const map = createMap('map');
watchVectorSource(map);
const look = enableLookAround(map);
enableKeys(map, look);
const layers = new LayerManager(map);
const slf = new SlfLayers(map);
const guru = new Skitourenguru(map, slf.popup);
guru.onError = toast;
enableRouteInfo(map, layers, slf.popup);
const sac = new SacRoutes(map, slf.popup);
sac.onError = toast;
const sun = new SunController(map);
sun.turnTo = look.turnTo;
layers.onError = toast;
slf.onError = toast;

// ── state restored from the URL hash ──
const hash = readHash();

const slfState: SlfState = { snow: '', snowDate: '', snowOpacity: 0.75, bulletin: false, bulletinOpacity: 0.3, stations: '', avalanches: false, guru: false };
for (const part of (hash.get('slf') ?? '').split(',').filter(Boolean)) {
  const [key, value] = part.split('~');
  if (key === 'b') slfState.bulletin = true;
  else if (key === 'a') slfState.avalanches = true;
  else if (key === 'g') slfState.guru = true;
  else if (key === 's' && value in STATION_TYPES) slfState.stations = value as StationType;
  else if (key in SNOW_PRODUCTS) {
    slfState.snow = key as SnowProduct;
    slfState.snowDate = value ?? '';
  }
}

const terrain: TerrainState = { exaggeration: 1, hillshade: 0.35, colorRelief: false, colorReliefOpacity: 0.5, water: true, peaks: false };
const [exaggeration, hillshade, relief, water, peakLabels, reliefOpacity] = (hash.get('terrain') ?? '').split('~');
if (Number(exaggeration) >= 1 && Number(exaggeration) <= 3) terrain.exaggeration = Number(exaggeration);
if (hillshade !== undefined && hillshade !== '' && Number(hillshade) >= 0 && Number(hillshade) <= 1) terrain.hillshade = Number(hillshade);
terrain.colorRelief = relief === '1';
terrain.water = water !== '0';
terrain.peaks = peakLabels === '1';
if (Number(reliefOpacity) >= 0.1 && Number(reliefOpacity) <= 1) terrain.colorReliefOpacity = Number(reliefOpacity);

const sunTime = hash.get('sun') ? new Date(hash.get('sun')!) : null;
if (sunTime && !Number.isNaN(sunTime.getTime())) sun.time = sunTime;

function saveState(): void {
  const slfParts = [
    slfState.snow && (slfState.snowDate ? `${slfState.snow}~${slfState.snowDate}` : slfState.snow),
    slfState.bulletin && 'b',
    slfState.stations && `s~${slfState.stations}`,
    slfState.avalanches && 'a',
    slfState.guru && 'g',
  ].filter(Boolean);
  const pad = (n: number) => String(n).padStart(2, '0');
  const t = sun.time;
  writeHash({
    base: layers.baseId ?? 'none',
    ov: layers.serializeOverlays() || null,
    slf: slfParts.join(',') || null,
    sac: [...sac.enabled].join(',') || null,
    terrain:
      terrain.exaggeration !== 1 || terrain.hillshade !== 0.35 || terrain.colorRelief || !terrain.water || terrain.peaks || terrain.colorReliefOpacity !== 0.5
        ? `${terrain.exaggeration}~${terrain.hillshade}~${terrain.colorRelief ? 1 : 0}~${terrain.water ? 1 : 0}~${terrain.peaks ? 1 : 0}~${terrain.colorReliefOpacity}`
        : null,
    // local wall-clock time, so a shared link shows the same hour on the slider
    sun: sun.enabled ? `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}` : null,
  });
}

map.once('load', async () => {
  const panel = new Panel(document.getElementById('panel')!, map, layers, slf, guru, sac, slfState, terrain, saveState);
  const sunControls = new SunControls(document.getElementById('sunbar')!, sun, () => {
    panel.setReliefScale(sun.enabled ? 0.4 : 1);
    saveState();
  }, map);
  panel.applyTerrain();
  const peaks = new PeakLabels(map, look);
  const weather = new Weather(map);
  weather.onChange = saveWeather;
  panel.onWeather = (on) => {
    weather.setEnabled(on);
    saveWeather();
  };
  function saveWeather(): void {
    writeHash({ wx: weather.enabled ? String(weather.day) : null });
  }
  if (hash.get('wx') !== null) {
    weather.day = Math.min(7, Math.max(0, Number(hash.get('wx')) || 0));
    panel.weatherBox.checked = true;
    weather.setEnabled(true);
  }
  panel.onPeaks = (on) => peaks.setEnabled(on);
  if (terrain.peaks) peaks.setEnabled(true);
  const tracks = enableTrackDrop(map, document.getElementById('panel')!);
  const planner = new Planner(map, { network: () => sac.routable(), snow: () => slf.snowSampler(),
    danger: () => slf.dangerSampler(),
    requestSnow: () => {
      if (!slfState.snow) slfState.snow = 'hs';
      void slf.setSnowMap(slfState.snow, slfState.snowDate || undefined, slfState.snowOpacity);
      panel.syncSlf();
      saveState();
    },
    requestDanger: () => {
      slfState.bulletin = true;
      void slf.setBulletin(true, slfState.bulletinOpacity);
      panel.syncSlf();
      saveState();
    }, onSave: (name, coords) => tracks.add(name, coords), onUpdate: (id, name, coords) => tracks.update(id, name, coords),
    onShare: (name, coords) => void shareTrack(name, coords),
    // A shared track belongs to the link it came with, not to the map view left behind.
    onClose: () => writeHash({ track: null, tn: null, gpx: null }),
  });
  tracks.onShare = (name, coords) => void shareTrack(name, coords);
  void openSharedTrack(planner);
  tracks.onEdit = (id, name, coords) => planner.load(name, coords, id);
  tracks.onView = (id, name, coords, recorded) => planner.view(name, coords, id, recorded);
  slf.onSnowChange = () => planner.refresh();
  slf.onBulletinChange = () => planner.refresh();
  enableContextMenu(map, slf.popup, planner, look);
  enableSearch(map);
  Object.assign(window, { planner });
  panel.onPlan = () => (planner.isOpen ? planner.close() : planner.open());

  const baseParam = hash.get('base') ?? DEFAULT_BASE;
  const [baseId, baseValue] = baseParam.split('~');
  await layers.setBase(baseId === 'none' ? null : byId.has(baseId) ? baseId : DEFAULT_BASE, baseValue);
  panel.syncBase();
  await layers.restoreOverlays(hash.get('ov') ?? '');
  panel.syncAllOverlays();

  if (slfState.snow) void slf.setSnowMap(slfState.snow, slfState.snowDate || undefined, slfState.snowOpacity);
  if (slfState.bulletin) void slf.setBulletin(true, slfState.bulletinOpacity);
  if (slfState.stations) void slf.setStations(slfState.stations);
  if (slfState.avalanches) void slf.setAvalanches(true);
  // Unofficial data only if this browser's user opted in: a link from someone else must not switch it on.
  if (!unofficial.enabled) slfState.guru = false;
  if (slfState.guru) void guru.setEnabled(true);
  if (unofficial.enabled) sac.setDisciplines((hash.get('sac') ?? '').split(',').filter((d): d is SacDiscipline => d in SAC_DISCIPLINES));
  panel.syncSac();
  if (hash.get('sun')) sunControls.setEnabled(true);

  const mapyLogo = h('a', { class: 'mapy-logo', href: 'https://mapy.com/', target: '_blank', rel: 'noopener', title: 'Map by Mapy.com' }, h('img', { src: 'https://api.mapy.com/img/api/logo.svg', alt: 'Mapy.com' }));
  mapyLogo.hidden = true;
  document.body.append(mapyLogo);
  const showMapyLogo = () => (mapyLogo.hidden = !layers.baseId?.startsWith('mapy-'));
  showMapyLogo();
  layers.onChange = () => {
    showMapyLogo();
    panel.syncBase();
    saveState();
  };
  saveState();
});

map.on('error', (e) => {
  // Missing tiles are routine (layers end at borders); only report real failures.
  const message = e.error?.message ?? '';
  if (!/404|aborted|AbortError|Failed to fetch|NetworkError|status 4/i.test(message)) console.warn('[map]', message);
});

/** Copies a link to the current view that also carries the given track. */
async function shareTrack(name: string, coords: [number, number][]): Promise<void> {
  saveState();
  const params = readHash();
  for (const key of ['track', 'tn', 'gpx', 's']) params.delete(key);
  const view = [...params.entries()].map(([k, v]) => `${k}=${k === 'map' ? v : encodeURIComponent(v)}`).join('&');
  // Map position, layers and track are compressed together into one parameter.
  const packed = await encodeShare({ hash: view, name, coords });
  const link = `${location.origin}${location.pathname}#s=${packed.text}`;
  const size = link.length < 1000 ? `${link.length} characters` : `${(link.length / 1000).toFixed(1)} kB`;
  const accuracy = `track accurate to about ${Math.round(packed.tolerance)} m`;
  try {
    await navigator.clipboard.writeText(link);
    toast(`Link copied (${size}, ${accuracy}). Anyone opening it sees this view and track.`, 'info');
  } catch {
    window.prompt(`Copy this link (${size}, ${accuracy}):`, link); // clipboard not available
  }
}

/** A link may carry a track (`track=`) or point at a track file elsewhere (`gpx=`): show it. */
async function openSharedTrack(planner: Planner): Promise<void> {
  if (sharedError) toast(`Shared link could not be opened: ${sharedError}`);
  const packed = hash.get('track');
  const file = hash.get('gpx');
  if (!sharedView?.coords && !packed && !file) return;
  try {
    let coords: [number, number][];
    let name = hash.get('tn') ?? 'Shared track';
    if (sharedView?.coords) {
      coords = sharedView.coords;
      name = sharedView.name || name;
      // Keep the track in the address in the long form, so a reload still shows it.
      writeHash({ track: (await encodeTrack(coords)).text, tn: name });
    } else if (packed) coords = await decodeTrack(packed);
    else {
      const response = await fetch(file!);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      coords = parseTrack(file!, await response.arrayBuffer()).flat();
      if (!hash.get('tn')) name = decodeURIComponent(file!.split(/[?#]/)[0].split('/').pop() ?? name);
    }
    if (coords.length < 2) throw new Error('no track points found');
    planner.view(name, coords);
    // A link without a map position (hand-made) gets the track centred.
    if (!hash.get('map')) {
      const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
      map.fitBounds(bounds, { padding: { top: 80, bottom: 300, left: 340, right: 80 }, maxZoom: 15, duration: 0 });
    }
  } catch (error) {
    const reason = error instanceof TypeError ? 'that site does not allow other pages to read the file' : (error as Error).message;
    toast(`Shared track could not be opened: ${reason}`);
  }
}

// Handy for debugging from the console.
Object.assign(window, { map, layers, slf, sun, guru, sac, look });
