// Avalanche terrain check on the map: pick an area (drawn, or a strip along the route in the
// planner), choose the danger level (today's SLF bulletin, or by hand) and see every 10 m cell
// classed after the Graphical Reduction Method, with the ground avalanches from above could reach.
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, ImageSource } from 'maplibre-gl';
import { heightGrid } from '../elevation';
import { interaction } from '../interaction';
import type { SlfLayers } from '../layers/slf';
import { SLOT } from '../map';
import { h, info, toast } from '../ui/dom';
import { RISK, RUNOUT, type Conditions, type Grid, type Result } from './terrainCheck';
import type { CheckRequest } from './terrainCheck.worker';
import CheckWorker from './terrainCheck.worker?worker&inline';

type Point = [lng: number, lat: number];
const CELL = 10; // metres
const MARGIN = 200; // metres of terrain loaded around the area: slopes above it and their runout count
const CORRIDOR = 150; // metres either side of a route
const MAX_CELLS = 1_500_000; // about 12 x 12 km
const SOURCE = 'terrain-check';
const AREA = 'terrain-check-area';
const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const LEVELS = ['', '1 Low', '2 Moderate', '3 Considerable', '4 High'];
const COLOURS = { low: [70, 170, 80, 70], elevated: [255, 160, 0, 190], high: [215, 25, 30, 205], reach: [60, 110, 225, 130] } as const;
const STEEP: [number, number[]][] = [
  [45, [125, 60, 180, 200]],
  [40, [215, 25, 30, 200]],
  [35, [245, 130, 30, 195]],
  [30, [250, 215, 60, 185]],
];

interface Run {
  west: number;
  south: number;
  east: number;
  north: number;
  grid: Grid;
  result: Result;
  route: Point[] | null;
}

export class TerrainCheck {
  readonly element: HTMLDetailsElement;
  private level = h('select', { title: 'Danger level the terrain is checked against' }, h('option', { value: '0' }, 'From SLF bulletin'), ...[1, 2, 3, 4].map((n) => h('option', { value: String(n) }, LEVELS[n])));
  private sectorBoxes = SECTORS.map((name) => h('input', { type: 'checkbox', checked: true, title: `${name}-facing slopes are critical` }));
  private above = h('input', { type: 'number', min: '0', step: '100', placeholder: 'all heights', title: 'Critical only above this height (metres)' });
  private manual = h('div', { class: 'check-manual', hidden: true });
  private view = h('select', { title: 'What the colours show', onchange: () => this.paint() }, h('option', { value: 'risk' }, 'Risk class'), h('option', { value: 'steep' }, 'Steepness that counted'), h('option', { value: 'slope' }, 'Slope angle'));
  private status = h('div', { class: 'muted' });
  private summary = h('div', { class: 'check-summary' });
  private legend = h('div', { class: 'check-legend' });
  private drawButton: HTMLButtonElement;
  private outline: Point[] = [];
  private run: Run | null = null;
  private busy = false;

  constructor(
    private map: maplibregl.Map,
    private slf: SlfLayers,
    /** The route in the planner, if any. */
    private route: () => Point[],
  ) {
    this.drawButton = h('button', { type: 'button', class: 'plan-button', title: 'Click the corners of an area on the map; double-click or Enter to finish, Esc to cancel', onclick: () => (interaction.drawing && this.outline ? this.finishDrawing(false) : this.startDrawing()) }, '▱ Draw area');
    const along = h('button', { type: 'button', class: 'plan-button', title: `A strip ${CORRIDOR} m either side of the route open in the route planner`, onclick: () => void this.alongRoute() }, '〰 Along route');
    const clear = h('button', { type: 'button', class: 'plan-button', onclick: () => this.clear() }, 'Clear');
    this.level.addEventListener('change', () => (this.manual.hidden = this.level.value === '0'));
    this.manual.append(
      h('div', { class: 'check-sectors' }, h('span', { class: 'muted' }, 'Critical aspects'), ...SECTORS.map((name, i) => h('label', {}, this.sectorBoxes[i], name))),
      h('label', { class: 'row' }, h('span', { class: 'muted' }, 'above'), this.above, h('span', { class: 'muted' }, 'm')),
    );
    this.element = h(
      'details',
      { class: 'section' },
      h(
        'summary',
        {},
        'Avalanche terrain check',
        info(
          'Classes the terrain in an area after the Graphical Reduction Method (SLF/SAC): danger level against slope steepness, one level lower outside the critical aspects and heights. ' +
            'From "moderate" the steepest ground within 20 m counts. Blue: gentler ground that avalanches from critical slopes above could reach (a 25° line from their top); from "considerable" that matters as much as the ground underfoot. ' +
            'It reads only the shape of the terrain (10 m elevation data) and the danger level: it knows nothing about the snowpack, and steep spots smaller than the data are missed. A planning aid, not a decision.',
        ),
      ),
      h(
        'div',
        { class: 'section-body' },
        h('label', { class: 'row' }, h('span', {}, 'Danger'), this.level),
        this.manual,
        h('div', { class: 'plan-row' }, this.drawButton, along),
        h('div', { class: 'plan-row' }, this.view, clear),
        this.status,
        this.summary,
        this.legend,
      ),
    );

    map.on('click', (event) => {
      if (!this.drawing) return;
      this.outline.push([event.lngLat.lng, event.lngLat.lat]);
      this.showOutline();
    });
    map.on('dblclick', (event) => {
      if (!this.drawing) return;
      event.preventDefault();
      this.finishDrawing(true);
    });
    window.addEventListener('keydown', (event) => {
      if (!this.drawing) return;
      if (event.key === 'Escape') this.finishDrawing(false);
      else if (event.key === 'Enter') this.finishDrawing(true);
    });
  }

  private drawing = false;

  private startDrawing(): void {
    if (this.busy || interaction.drawing) return;
    this.drawing = true;
    interaction.setMode('draw-area'); // clicks belong to this tool now, not to popups
    this.outline = [];
    this.map.doubleClickZoom.disable();
    this.map.getCanvas().style.cursor = 'crosshair';
    this.drawButton.textContent = '✓ Finish area';
    this.status.textContent = 'Click the corners of the area; double-click the last one.';
    this.showOutline();
  }

  private finishDrawing(compute: boolean): void {
    if (!this.drawing) return;
    this.drawing = false;
    interaction.setMode('explore');
    this.map.getCanvas().style.cursor = '';
    this.drawButton.textContent = '▱ Draw area';
    window.setTimeout(() => this.map.doubleClickZoom.enable(), 300); // after this double click
    // A double click adds its point twice.
    const corners = this.outline.filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1][0], p[1] - all[i - 1][1]) > 1e-6);
    if (!compute || corners.length < 3) {
      this.status.textContent = compute ? 'An area needs at least three corners.' : '';
      this.outline = [];
      this.showOutline();
      return;
    }
    this.outline = corners;
    this.showOutline(true);
    void this.compute(corners, null);
  }

  private async alongRoute(): Promise<void> {
    const line = this.route();
    if (line.length < 2) {
      this.status.textContent = 'Open a route in the route planner first (plan one, or click a track).';
      return;
    }
    this.outline = [];
    this.showOutline();
    await this.compute(null, line);
  }

  private runToken = 0;
  private worker: Worker | null = null;

  clear(): void {
    this.runToken++;
    this.worker?.terminate();
    this.worker = null;
    this.busy = false;
    this.finishDrawing(false);
    this.run = null;
    this.outline = [];
    this.showOutline();
    if (this.map.getLayer(SOURCE)) this.map.removeLayer(SOURCE);
    if (this.map.getSource(SOURCE)) this.map.removeSource(SOURCE);
    this.status.textContent = '';
    this.summary.replaceChildren();
    this.legend.replaceChildren();
  }

  private showOutline(closed = false): void {
    const coordinates = closed && this.outline.length > 2 ? [...this.outline, this.outline[0]] : this.outline;
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: coordinates.length > 1 ? [{ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }] : coordinates.map((c) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: c } })) };
    const source = this.map.getSource(AREA) as GeoJSONSource | undefined;
    if (source) return void source.setData(data);
    this.map.addSource(AREA, { type: 'geojson', data });
    this.map.addLayer({ id: AREA, type: 'line', source: AREA, paint: { 'line-color': '#111', 'line-width': 2, 'line-dasharray': [2, 1.5] } }, SLOT.plan);
    this.map.addLayer({ id: `${AREA}-points`, type: 'circle', source: AREA, filter: ['==', ['geometry-type'], 'Point'], paint: { 'circle-radius': 4, 'circle-color': '#111' } }, SLOT.plan);
  }

  /** Runs the check for a drawn area or for a strip along a line. */
  private async compute(polygon: Point[] | null, line: Point[] | null): Promise<void> {
    if (this.busy) return;
    const shape = polygon ?? line!;
    const midLat = shape.reduce((sum, p) => sum + p[1], 0) / shape.length;
    const perLng = 111320 * Math.cos((midLat * Math.PI) / 180);
    const perLat = 110540;
    const margin = MARGIN + (line ? CORRIDOR : 0);
    const west = Math.min(...shape.map((p) => p[0])) - margin / perLng;
    const east = Math.max(...shape.map((p) => p[0])) + margin / perLng;
    const south = Math.min(...shape.map((p) => p[1])) - margin / perLat;
    const north = Math.max(...shape.map((p) => p[1])) + margin / perLat;
    const width = Math.ceil(((east - west) * perLng) / CELL);
    const height = Math.ceil(((north - south) * perLat) / CELL);
    if (width * height > MAX_CELLS) {
      this.status.textContent = `Too large: ${((width * height * CELL * CELL) / 1e6).toFixed(0)} km² (at most ${((MAX_CELLS * CELL * CELL) / 1e6).toFixed(0)} km² with its surroundings). Pick a smaller area or a shorter route.`;
      return;
    }
    const token = ++this.runToken;
    this.busy = true;
    this.status.textContent = 'Loading elevation data…';
    try {
      const heights = await heightGrid(west, south, east, north, width, height);
      if (token !== this.runToken) return;
      const grid: Grid = { width, height, cell: CELL, heights };
      const cellAt = (p: Point): [number, number] => [((p[0] - west) / (east - west)) * width, ((north - p[1]) / (north - south)) * height];

      // Which cells are asked about.
      const mask = new Uint8Array(width * height);
      if (polygon) {
        const ring = polygon.map(cellAt);
        for (let y = 0; y < height; y++) {
          for (let x = 0; x < width; x++) {
            let inside = false;
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              const [xi, yi] = ring[i];
              const [xj, yj] = ring[j];
              if (yi > y + 0.5 !== yj > y + 0.5 && x + 0.5 < ((xj - xi) * (y + 0.5 - yi)) / (yj - yi) + xi) inside = !inside;
            }
            if (inside) mask[y * width + x] = 1;
          }
        }
      } else {
        const r = CORRIDOR / CELL;
        const stamp = (cx: number, cy: number) => {
          for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(height - 1, Math.ceil(cy + r)); y++) {
            for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(width - 1, Math.ceil(cx + r)); x++) {
              if ((x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2 <= r * r) mask[y * width + x] = 1;
            }
          }
        };
        for (let i = 1; i < line!.length; i++) {
          const [ax, ay] = cellAt(line![i - 1]);
          const [bx, by] = cellAt(line![i]);
          const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (r / 3)));
          for (let s = 0; s <= steps; s++) stamp(ax + ((bx - ax) * s) / steps, ay + ((by - ay) * s) / steps);
        }
      }

      const conditions = await this.conditions(grid, west, south, east, north);
      if (!conditions || token !== this.runToken) return;
      this.status.textContent = 'Checking terrain…';
      const result = await new Promise<Result>((resolve, reject) => {
        const worker = (this.worker = new CheckWorker());
        worker.onmessage = (event: MessageEvent<Result>) => {
          worker.terminate();
          if (this.worker === worker) this.worker = null;
          resolve(event.data);
        };
        worker.onerror = (event) => {
          worker.terminate();
          if (this.worker === worker) this.worker = null;
          reject(new Error(event.message || 'the check failed'));
        };
        worker.onmessageerror = () => {
          worker.terminate();
          if (this.worker === worker) this.worker = null;
          reject(new Error('worker message error'));
        };
        const request: CheckRequest = { grid, conditions, mask };
        worker.postMessage(request);
      });
      if (token !== this.runToken) return;
      this.run = { west, south, east, north, grid, result, route: line };
      this.paint();
      this.summarise(mask);
      this.status.textContent = this.conditionsNote;
    } catch (error) {
      if (token !== this.runToken) return;
      this.status.textContent = '';
      toast(`Terrain check: ${(error as Error).message}`);
    } finally {
      if (token === this.runToken) this.busy = false;
    }
  }

  private conditionsNote = '';

  /** Danger level and critical aspects for every cell: from the bulletin, or as entered. */
  private async conditions(grid: Grid, west: number, south: number, east: number, north: number): Promise<Conditions | null> {
    const n = grid.width * grid.height;
    const conditions: Conditions = { level: new Uint8Array(n), aspects: new Uint8Array(n), above: new Int16Array(n) };
    const chosen = Number(this.level.value);
    if (chosen) {
      const bits = this.sectorBoxes.reduce((sum, box, i) => sum | (box.checked ? 1 << i : 0), 0);
      const above = this.above.value === '' ? -1 : Math.max(0, Number(this.above.value));
      conditions.level.fill(chosen);
      conditions.aspects.fill(bits);
      conditions.above.fill(above);
      const names = bits === 255 ? 'all aspects' : SECTORS.filter((_, i) => (bits >> i) & 1).join(' ') || 'no aspects';
      this.conditionsNote = `Checked against ${LEVELS[chosen]}, critical: ${names}${above >= 0 ? ` above ${above} m` : ''}.`;
      return conditions;
    }
    this.status.textContent = 'Loading the avalanche bulletin…';
    await this.slf.bulletinAt((west + east) / 2, (south + north) / 2).catch(() => null);
    const sampler = this.slf.dangerSampler();
    // The bulletin is the same over large regions: look it up on a coarse lattice.
    const STEP = 16;
    const seen = new Map<string, number>();
    let known = 0;
    for (let y = 0; y < grid.height; y += STEP) {
      for (let x = 0; x < grid.width; x += STEP) {
        const hit = sampler?.at(west + ((x + STEP / 2) / grid.width) * (east - west), north - ((y + STEP / 2) / grid.height) * (north - south)) ?? null;
        if (!hit) continue;
        known++;
        seen.set(`${hit.level} ${hit.name} (${hit.region})`, hit.level);
        for (let yy = y; yy < Math.min(grid.height, y + STEP); yy++) {
          const row = yy * grid.width;
          conditions.level.fill(hit.level, row + x, row + Math.min(grid.width, x + STEP));
          conditions.aspects.fill(hit.core.aspects, row + x, row + Math.min(grid.width, x + STEP));
          conditions.above.fill(hit.core.above, row + x, row + Math.min(grid.width, x + STEP));
        }
      }
    }
    if (!known) {
      this.status.textContent = 'No SLF bulletin for this area (or none issued today): choose a danger level by hand.';
      return null;
    }
    this.conditionsNote = `Checked against today's SLF bulletin: ${[...seen.keys()].slice(0, 3).join('; ')}.`;
    return conditions;
  }

  /** Draws the result in the colours of the chosen view. */
  private paint(): void {
    const run = this.run;
    if (!run) return;
    const { width, height } = run.grid;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d')!;
    const image = context.createImageData(width, height);
    const mode = this.view.value;
    const { risk, steepness, slope } = run.result;
    for (let i = 0; i < risk.length; i++) {
      const cls = risk[i] & 3;
      if (!cls) continue; // outside the area
      let colour: readonly number[] | null = null;
      if (mode === 'risk') colour = cls === RISK.HIGH ? COLOURS.high : cls === RISK.ELEVATED ? COLOURS.elevated : risk[i] & RUNOUT ? COLOURS.reach : COLOURS.low;
      else {
        const angle = mode === 'steep' ? steepness[i] : slope[i];
        colour = STEEP.find(([from]) => angle >= from)?.[1] ?? null;
      }
      if (!colour) continue;
      image.data.set(colour, i * 4);
    }
    context.putImageData(image, 0, 0);
    const url = canvas.toDataURL('image/png');
    const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[run.west, run.north], [run.east, run.north], [run.east, run.south], [run.west, run.south]];
    const source = this.map.getSource(SOURCE) as ImageSource | undefined;
    if (source) source.updateImage({ url, coordinates });
    else {
      this.map.addSource(SOURCE, { type: 'image', url, coordinates });
      this.map.addLayer({ id: SOURCE, type: 'raster', source: SOURCE, paint: { 'raster-opacity': 0.8, 'raster-fade-duration': 0, 'raster-resampling': 'nearest' } }, SLOT.area);
    }
    const swatch = (colour: readonly number[], label: string) => {
      const box = h('i', { class: 'swatch' });
      box.style.background = `rgba(${colour[0]},${colour[1]},${colour[2]},${Math.max(0.5, colour[3] / 255)})`;
      return h('span', {}, box, label);
    };
    this.legend.replaceChildren(
      ...(mode === 'risk'
        ? [swatch(COLOURS.low, 'low'), swatch(COLOURS.elevated, 'elevated'), swatch(COLOURS.high, 'high'), swatch(COLOURS.reach, 'in reach from above')]
        : [swatch(STEEP[3][1], '30–35°'), swatch(STEEP[2][1], '35–40°'), swatch(STEEP[1][1], '40–45°'), swatch(STEEP[0][1], '> 45°')]),
    );
  }

  /** Shares of the area per class; for a route, kilometres of it per class. */
  private summarise(mask: Uint8Array): void {
    const run = this.run!;
    const { risk } = run.result;
    const lines: string[] = [];
    if (run.route) {
      const km = [0, 0, 0, 0];
      let reach = 0;
      const perLng = 111320 * Math.cos((((run.south + run.north) / 2) * Math.PI) / 180);
      for (let i = 1; i < run.route.length; i++) {
        const a = run.route[i - 1];
        const b = run.route[i];
        const length = Math.hypot((b[0] - a[0]) * perLng, (b[1] - a[1]) * 110540);
        const steps = Math.max(1, Math.ceil(length / CELL));
        for (let s = 0; s < steps; s++) {
          const lng = a[0] + ((b[0] - a[0]) * (s + 0.5)) / steps;
          const lat = a[1] + ((b[1] - a[1]) * (s + 0.5)) / steps;
          const x = Math.min(run.grid.width - 1, Math.max(0, Math.floor(((lng - run.west) / (run.east - run.west)) * run.grid.width)));
          const y = Math.min(run.grid.height - 1, Math.max(0, Math.floor(((run.north - lat) / (run.north - run.south)) * run.grid.height)));
          const value = risk[y * run.grid.width + x];
          km[value & 3] += length / steps / 1000;
          if (value & RUNOUT && (value & 3) === RISK.LOW) reach += length / steps / 1000;
        }
      }
      lines.push(`Along the route: ${km[RISK.HIGH].toFixed(1)} km high · ${km[RISK.ELEVATED].toFixed(1)} km elevated · ${km[RISK.LOW].toFixed(1)} km low`);
      if (reach >= 0.05) lines.push(`${reach.toFixed(1)} km of the low part lies in reach of slopes above.`);
    } else {
      const count = [0, 0, 0, 0];
      let total = 0;
      for (let i = 0; i < risk.length; i++) {
        if (!mask[i] || !(risk[i] & 3)) continue;
        count[risk[i] & 3]++;
        total++;
      }
      const share = (n: number) => `${total ? Math.round((n / total) * 100) : 0} %`;
      lines.push(`${((total * CELL * CELL) / 1e6).toFixed(1)} km²: ${share(count[RISK.HIGH])} high · ${share(count[RISK.ELEVATED])} elevated · ${share(count[RISK.LOW])} low`);
    }
    this.summary.replaceChildren(...lines.map((text) => h('div', {}, text)));
  }
}
