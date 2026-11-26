// Right-click on the map: what is here (coordinates, height, place) and what to do from here.
import type * as maplibregl from 'maplibre-gl';
import { elevations } from './elevation';
import { interaction } from './interaction';
import { vectorLayers } from './map';
import { toLv95 } from './swissGrid';
import type { LookAround } from './lookAround';
import { placeName } from './places';
import type { Planner } from './planner';

const RAD = Math.PI / 180;
export function enableContextMenu(map: maplibregl.Map, popup: maplibregl.Popup, planner: Planner, look: LookAround, onWeather: (spot: { key: string; name: string; at: [number, number] }) => void = () => {}): void {
  let here: { lng: number; lat: number; height: number | null } | null = null;
  let request = 0;

  // A right press and release on the same spot. (The browser's own menu event comes at different
  // moments on different systems, and the right button also rotates the map when dragged.)
  const canvas = map.getCanvas();
  let press: { x: number; y: number; time: number } | null = null;
  canvas.addEventListener('mousedown', (event) => {
    press = event.button === 2 ? { x: event.clientX, y: event.clientY, time: performance.now() } : null;
  });
  window.addEventListener('mouseup', (event) => {
    const down = press;
    press = null;
    if (!down || event.button !== 2 || interaction.drawing) return; // while drawing, right-click belongs to the route
    if (Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4 || performance.now() - down.time > 700) return;
    const box = canvas.getBoundingClientRect();
    open(map.unproject([event.clientX - box.left, event.clientY - box.top]));
  });
  canvas.addEventListener('contextmenu', (event) => event.preventDefault());

  // Touch: a long press on one spot does the same. The popup opens when the finger lifts: lifting
  // also counts as a tap on the map, which would close a popup opened earlier.
  let hold: number | undefined;
  let held: { x: number; y: number; long: boolean } | null = null;
  const cancel = () => {
    clearTimeout(hold);
    held = null;
  };
  canvas.addEventListener(
    'touchstart',
    (event) => {
      cancel();
      if (event.touches.length !== 1 || interaction.drawing) return;
      const press = { x: event.touches[0].clientX, y: event.touches[0].clientY, long: false };
      held = press;
      hold = window.setTimeout(() => {
        press.long = true;
        navigator.vibrate?.(15); // a nudge that the press registered, where supported
      }, 550);
    },
    { passive: true },
  );
  canvas.addEventListener(
    'touchmove',
    (event) => {
      if (held && Math.hypot(event.touches[0].clientX - held.x, event.touches[0].clientY - held.y) > 8) cancel();
    },
    { passive: true },
  );
  canvas.addEventListener('touchend', () => {
    const press = held;
    cancel();
    if (!press?.long) return;
    const box = canvas.getBoundingClientRect();
    const lngLat = map.unproject([press.x - box.left, press.y - box.top]);
    window.setTimeout(() => open(lngLat), 120);
  });
  canvas.addEventListener('touchcancel', cancel);

  function open(lngLat: maplibregl.LngLat): void {
    const token = ++request;
    const { lng, lat } = lngLat;
    here = { lng, lat, height: null };
    const [east, north] = toLv95(lng, lat);
    const inSwitzerland = east > 2480000 && east < 2840000 && north > 1070000 && north < 1300000;
    const swiss = inSwitzerland ? `<tr><td class="muted">LV95</td><td>${Math.round(east).toLocaleString('de-CH')} / ${Math.round(north).toLocaleString('de-CH')}</td></tr>` : '';
    popup
      .setLngLat(lngLat)
      .setHTML(
        `<div class="popup context"><h3 data-field="place">Location</h3>` +
          `<table><tr><td class="muted">Height</td><td data-field="height">…</td></tr>` +
          `<tr><td class="muted">WGS84</td><td>${lat.toFixed(5)}, ${lng.toFixed(5)}</td></tr>${swiss}` +
          `<tr data-field="peak-row" hidden><td class="muted">Near</td><td data-field="peak"></td></tr></table>` +
          `<div class="popup-links">` +
          `<button type="button" data-context="route">${planner.isOpen && planner.hasRoute ? 'Add to route' : 'Start route here'}</button>` +
          `<button type="button" data-context="view">View from here</button>` +
          `<button type="button" data-context="weather">Weather here</button>` +
          `<button type="button" data-context="copy">Copy coordinates</button></div></div>`,
      )
      .addTo(map);
    const field = (name: string) => popup.getElement()?.querySelector<HTMLElement>(`[data-field="${name}"]`) ?? null;

    void elevations([[lng, lat]])
      .then(([height]) => {
        if (token !== request || !here) return;
        here.height = height;
        const cell = field('height');
        if (cell) cell.textContent = `${Math.round(height)} m`;
      })
      .catch(() => {
        const cell = field('height');
        if (token === request && cell) cell.textContent = 'unknown';
      });
    void placeName([lng, lat]).then((name) => {
      const title = field('place');
      if (token === request && name && title) title.textContent = name;
    });

    // Nearest named summit, if the peak data happens to be loaded.
    try {
      let best: { name: string; ele: number; distance: number } | null = null;
      for (const feature of map.querySourceFeatures('water', { sourceLayer: vectorLayers.peak })) {
        if (feature.geometry.type !== 'Point') continue;
        const [x, y] = feature.geometry.coordinates;
        const distance = Math.hypot((x - lng) * Math.cos(lat * RAD) * 111320, (y - lat) * 111320);
        const name = feature.properties?.['name:latin'] ?? feature.properties?.name;
        if (name && distance < 2000 && (!best || distance < best.distance)) best = { name, ele: Number(feature.properties?.ele), distance };
      }
      const row = field('peak-row');
      const cell = field('peak');
      if (best && row && cell) {
        row.hidden = false;
        cell.textContent = `${best.name}${Number.isFinite(best.ele) ? `, ${Math.round(best.ele)} m` : ''} (${best.distance < 950 ? `${Math.round(best.distance / 10) * 10} m` : `${(best.distance / 1000).toFixed(1)} km`})`;
      }
    } catch {
      /* no peak data: leave the row out */
    }
  }

  document.addEventListener('click', async (event) => {
    const button = (event.target as HTMLElement | null)?.closest<HTMLElement>('[data-context]');
    if (!button || !here) return;
    const { lng, lat } = here;
    switch (button.dataset.context) {
      case 'route':
        popup.remove();
        planner.startAt([lng, lat]);
        break;
      case 'view': {
        popup.remove();
        const height = here.height ?? (await elevations([[lng, lat]]).catch(() => [0]))[0];
        const exaggeration = map.getTerrain()?.exaggeration ?? 1;
        // Eye height: a little above the ground, so the terrain right underfoot does not fill the view.
        look.standAt([lng, lat], height * exaggeration + 3, map.getBearing(), 80);
        break;
      }
      case 'weather': {
        const name = popup.getElement()?.querySelector('[data-field="place"]')?.textContent || 'Location';
        popup.remove();
        onWeather({ key: `${lng.toFixed(3)},${lat.toFixed(3)}`, name: name === 'Location' ? `${lat.toFixed(3)}°N ${lng.toFixed(3)}°E` : name, at: [lng, lat] });
        break;
      }
      case 'copy': {
        const text = `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = 'Copied';
        } catch {
          button.textContent = text; // clipboard not available: show it for manual copying
        }
        break;
      }
    }
  });
}
