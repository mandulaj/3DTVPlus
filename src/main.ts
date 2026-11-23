import './ui/style.css';
import { createMap, readHash, writeHash } from './map';
import { enableLookAround } from './lookAround';
import { enableTrackDrop } from './tracks';
import { DEFAULT_BASE, byId } from './layers/catalog';
import { LayerManager } from './layers/manager';
import { SNOW_PRODUCTS, STATION_TYPES, SlfLayers, type SnowProduct, type StationType } from './layers/slf';
import { SunController } from './sun/sun';
import { Panel, type SlfState, type TerrainState } from './ui/panel';
import { SunControls } from './ui/sunControls';
import { toast } from './ui/dom';

const map = createMap('map');
const look = enableLookAround(map);
const layers = new LayerManager(map);
const slf = new SlfLayers(map);
const sun = new SunController(map);
sun.turnTo = look.turnTo;
layers.onError = toast;
slf.onError = toast;

// ── state restored from the URL hash ──
const hash = readHash();

const slfState: SlfState = { snow: '', snowDate: '', snowOpacity: 0.75, bulletin: false, bulletinOpacity: 0.3, stations: '', avalanches: false };
for (const part of (hash.get('slf') ?? '').split(',').filter(Boolean)) {
  const [key, value] = part.split('~');
  if (key === 'b') slfState.bulletin = true;
  else if (key === 'a') slfState.avalanches = true;
  else if (key === 's' && value in STATION_TYPES) slfState.stations = value as StationType;
  else if (key in SNOW_PRODUCTS) {
    slfState.snow = key as SnowProduct;
    slfState.snowDate = value ?? '';
  }
}

const terrain: TerrainState = { exaggeration: 1, hillshade: 0.35, colorRelief: false, water: true };
const [exaggeration, hillshade, relief, water] = (hash.get('terrain') ?? '').split('~');
if (Number(exaggeration) >= 1 && Number(exaggeration) <= 3) terrain.exaggeration = Number(exaggeration);
if (hillshade !== undefined && hillshade !== '' && Number(hillshade) >= 0 && Number(hillshade) <= 1) terrain.hillshade = Number(hillshade);
terrain.colorRelief = relief === '1';
terrain.water = water !== '0';

const sunTime = hash.get('sun') ? new Date(hash.get('sun')!) : null;
if (sunTime && !Number.isNaN(sunTime.getTime())) sun.time = sunTime;

function saveState(): void {
  const slfParts = [
    slfState.snow && (slfState.snowDate ? `${slfState.snow}~${slfState.snowDate}` : slfState.snow),
    slfState.bulletin && 'b',
    slfState.stations && `s~${slfState.stations}`,
    slfState.avalanches && 'a',
  ].filter(Boolean);
  const pad = (n: number) => String(n).padStart(2, '0');
  const t = sun.time;
  writeHash({
    base: layers.baseId ?? 'none',
    ov: layers.serializeOverlays() || null,
    slf: slfParts.join(',') || null,
    terrain:
      terrain.exaggeration !== 1 || terrain.hillshade !== 0.35 || terrain.colorRelief || !terrain.water
        ? `${terrain.exaggeration}~${terrain.hillshade}~${terrain.colorRelief ? 1 : 0}~${terrain.water ? 1 : 0}`
        : null,
    // local wall-clock time, so a shared link shows the same hour on the slider
    sun: sun.enabled ? `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}T${pad(t.getHours())}:${pad(t.getMinutes())}` : null,
  });
}

map.once('load', async () => {
  const panel = new Panel(document.getElementById('panel')!, map, layers, slf, slfState, terrain, saveState);
  const sunControls = new SunControls(document.getElementById('sunbar')!, sun, () => {
    panel.setReliefScale(sun.enabled ? 0.4 : 1);
    saveState();
  });
  panel.applyTerrain();
  enableTrackDrop(map, document.getElementById('panel')!);

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
  if (hash.get('sun')) sunControls.setEnabled(true);

  layers.onChange = () => {
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

// Handy for debugging from the console.
Object.assign(window, { map, layers, slf, sun });
