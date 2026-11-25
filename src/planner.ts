// Route planner: click points on the map, legs follow paths where a path is close enough and run
// straight otherwise. A bottom widget shows distance, ascent, descent and an elevation profile,
// and exports GPX. Dropped tracks can be opened in it and edited the same way.
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { elevations } from './elevation';
import { interaction } from './interaction';
import { SLOT } from './map';
import { Network } from './network';
import type { DangerSampler, SnowSampler } from './layers/slf';
import { placeName } from './places';
import type { Recorded } from './tracks';
import { MODES, controlPoints, type Mode } from './routeMath';
import { h, toast } from './ui/dom';

type Point = [lng: number, lat: number];

interface Waypoint {
  at: Point;
  marker: maplibregl.Marker;
}
interface Leg {
  coords: Point[];
}
/** A state of the route to go back (or forward) to. */
interface Snapshot {
  points: Point[];
  legs: Point[][];
  name: string;
  nameEdited: boolean;
}

const SOURCE = 'plan';
const LINE = 'plan-line';
const ROUTER = 'https://brouter.de/brouter';
const PROFILE = 'hiking-mountain';
const COLOUR = '#ff2d6f';
const STEP = 30; // metres between profile samples
const HYSTERESIS = 5; // metres of height change ignored as noise when summing ascent
const SNAP_PIXELS = 14; // a click closer than this to a path follows it; further away the leg runs straight
const SNAP_MIN_METRES = 20;
// OpenStreetMap paths rarely sit exactly where the map image draws them: allow more slack.
const OSM_SNAP_PIXELS = 24;
const OSM_SNAP_MIN_METRES = 40;
const PREVIEW = 'plan-preview';
const GRADE = 'plan-grade';
const SELECT = 'plan-select';
/** Slope classes (rise over run) and their colours: blue downhill, green flat, red uphill. */
const GRADES: [upTo: number, colour: string][] = [
  [-0.28, '#123a85'],
  [-0.18, '#2563c9'],
  [-0.1, '#5e9bea'],
  [-0.04, '#a9c8f5'],
  [0.04, '#3fbf5a'],
  [0.1, '#f7a58f'],
  [0.18, '#ee6a4d'],
  [0.28, '#d32f2f'],
  [Infinity, '#8e0f1f'],
];
const gradeColour = (slope: number) => GRADES.find(([upTo]) => slope < upTo)![1];

/** Terrain steepness classes as on avalanche terrain maps (degrees), and their colours. */
const ANGLES: [upTo: number, colour: string, label: string][] = [
  [30, '#cdd5dc', '<30°'],
  [35, '#ffe14d', '30–35°'],
  [40, '#ff9800', '35–40°'],
  [45, '#f44336', '40–45°'],
  [Infinity, '#9c27b0', '>45°'],
];
const angleColour = (degrees: number) => ANGLES.find(([upTo]) => degrees < upTo)![1];
const ANGLE_REACH = 15; // metres either side of a point over which its slope is measured

type ColourBy = 'auto' | 'gradient' | 'snow' | 'angle' | 'danger' | 'speed';
/** Speed classes relative to the track's typical moving speed, slow to fast. */
const SPEEDS: [upTo: number, colour: string, label: string][] = [
  [0.5, '#2563c9', 'much slower'],
  [0.8, '#5e9bea', 'slower'],
  [1.25, '#3fbf5a', 'typical'],
  [1.7, '#f59b2b', 'faster'],
  [Infinity, '#d32f2f', 'much faster'],
];
const PAUSE_SPEED = 0.3; // m/s: slower than this over a stretch counts as standing
const MAX_RECORDED_SAMPLES = 3000;

const SPEED_KEY = 'terrain-viewer.planner.speeds';
const RAD = Math.PI / 180;

function metres(a: Point, b: Point): number {
  const s = Math.sin(((b[1] - a[1]) * RAD) / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(((b[0] - a[0]) * RAD) / 2) ** 2;
  return 2 * 6371008 * Math.asin(Math.sqrt(s));
}
const lengthOf = (coords: Point[]) => coords.reduce((sum, c, i) => (i ? sum + metres(coords[i - 1], c) : 0), 0);

/** A path between two points along OpenStreetMap trails, or null unless both lie within `reach` metres of one. */
let routerNotice = 0;
/** Says once in a while that the path service is not answering, so straight legs are no surprise. */
function routerDown(): void {
  if (Date.now() - routerNotice < 120000) return;
  routerNotice = Date.now();
  toast('Path lookup (BRouter) is not answering: legs run straight for now. SAC routes on the map still work.', 'info');
}

async function routed(a: Point, b: Point, reach: number): Promise<Point[] | null> {
  try {
    const response = await fetch(`${ROUTER}?lonlats=${a.join(',')}|${b.join(',')}&profile=${PROFILE}&alternativeidx=0&format=geojson`);
    if (response.status >= 500 || response.status === 429) routerDown();
    if (!response.ok) return null; // e.g. no path within reach of a point
    const coords = ((await response.json()).features?.[0]?.geometry?.coordinates ?? []) as number[][];
    if (coords.length < 2) return null;
    const path = coords.map((c): Point => [c[0], c[1]]);
    // The router starts from the nearest path however far away it is. Clicking well beside a path
    // means "go here", not "go to that path".
    if (metres(a, path[0]) > reach || metres(b, path[path.length - 1]) > reach) return null;
    // A long detour is not what a click on the map asks for either.
    if (lengthOf(path) > 6 * metres(a, b) + 500) return null;
    return path;
  } catch {
    routerDown(); // no connection to the service
    return null;
  }
}

export interface PlannerOptions {
  /** Route lines currently drawn on the map (SAC routes): legs follow these before anything else. */
  network: () => Point[][];
  /** Switch the snow map / the avalanche bulletin on in the viewer (a profile colouring was chosen that needs it). */
  requestSnow: () => void;
  requestDanger: () => void;
  /** The avalanche bulletin shown on the map, if any. */
  danger: () => DangerSampler | null;
  /** The snow map shown on the map, if any: drawn along the bottom of the profile. */
  snow: () => SnowSampler | null;
  /** Keep the finished route in the track list. */
  onSave: (name: string, coords: Point[]) => string;
  /** Make a link that carries this route and copy it. */
  onShare: (name: string, coords: Point[]) => void;
  /** The planner was closed. */
  onClose: () => void;
  /** Write changes back to the track being edited. False if that track is gone. */
  onUpdate: (id: string, name: string, coords: Point[]) => boolean;
}

export class Planner {
  private root = h('div', { id: 'planner' });
  private points: Waypoint[] = [];
  private legs: Leg[] = [];
  private drawing: 'end' | 'start' | null = null;
  private snap = true;
  private opened = false;
  private nameEdited = false;
  private nameInput = h('input', { type: 'text', class: 'plan-name', value: 'New route', title: 'Route name (click to rename)', oninput: () => {
    this.nameEdited = true;
    this.storeSoon();
  } });
  private stats = h('div', { class: 'plan-stats' });
  private chart = h('div', { class: 'plan-chart' });
  private hint = h('div', { class: 'muted plan-hint' });
  /** Values under the cursor, on a line of their own above the profile so they cover nothing. */
  private readout = h('span', { class: 'plan-readout' });
  private readoutRow = h('div', { class: 'plan-readout-row' }, this.readout);
  private hover = new maplibregl.Marker({ element: h('div', { class: 'plan-hover' }) });
  /** `angle`: terrain steepness in degrees at each sample (empty if unknown). */
  private profile: { coords: Point[]; distance: number[]; height: number[]; terrain: number[]; angle: number[]; recEle: number[] | null; time: (number | null)[] | null } | null = null;
  private profileToken = 0;
  private profileTimer: number | undefined;
  private lastClick = { time: 0, x: 0, y: 0 };
  private graph: { lines: Point[][]; network: Network } | null = null;
  /** `settled`: the path lookup for this leg has answered, so `coords` is what a click should add. */
  private preview: { from: Point; to: Point; coords: Point[]; settled: boolean } | null = null;
  private previewTimer: number | undefined;
  private previewToken = 0;
  private dragging = false;
  private mode: Mode = 'hiking';
  private speeds: Record<Mode, number> = { hiking: MODES.hiking.flat, running: MODES.running.flat, skitouring: MODES.skitouring.flat };
  private history: Snapshot[] = [];
  private future: Snapshot[] = [];
  private colourBy: ColourBy = 'auto';
  private colourSelect!: HTMLSelectElement;

  constructor(
    private map: maplibregl.Map,
    private options: PlannerOptions,
  ) {
    document.body.append(this.root);
    // `edit` controls are hidden while a track is only being viewed.
    const button = (label: string, title: string, onclick: () => void, kind = 'edit') => h('button', { type: 'button', class: kind, title, onclick }, label);
    const snapBox = h('input', { type: 'checkbox', checked: true, onchange: () => (this.snap = snapBox.checked) });
    try {
      Object.assign(this.speeds, JSON.parse(localStorage.getItem(SPEED_KEY) ?? '{}'));
    } catch {
      /* defaults */
    }
    const speedInput = h('input', {
      type: 'number',
      class: 'plan-speed',
      min: '0.5',
      max: '40',
      step: '0.5',
      value: String(this.speeds[this.mode]),
      title: 'Speed on flat ground in km/h. Slopes are timed slower or faster by a model for the chosen activity.',
      onchange: () => {
        const value = Number(speedInput.value);
        if (!(value > 0)) return;
        this.speeds[this.mode] = value;
        try {
          localStorage.setItem(SPEED_KEY, JSON.stringify(this.speeds));
        } catch {
          /* kept for this session */
        }
        this.render();
      },
    });
    const modeSelect = h('select', {
      title: 'Activity for the time estimate',
      onchange: () => {
        this.mode = modeSelect.value as Mode;
        speedInput.value = String(this.speeds[this.mode]);
        this.render();
      },
    });
    for (const [id, mode] of Object.entries(MODES)) modeSelect.append(h('option', { value: id }, mode.name));
    this.colourSelect = h('select', {
      title: 'What the colours of the profile (and of the route on the map) show. Slope angle and danger are for orientation only, not a risk assessment.',
      onchange: () => {
        this.colourBy = this.colourSelect.value as ColourBy;
        // Choosing a colouring switches on the layer it reads from; it shows as soon as that has loaded.
        if (this.colourBy === 'snow' && !this.options.snow()?.shown) this.options.requestSnow();
        if (this.colourBy === 'danger' && !this.options.danger()) this.options.requestDanger();
        this.render();
      },
    });
    for (const [value, label] of [['auto', 'Colour: automatic'], ['gradient', 'Colour: gradient'], ['snow', 'Colour: snow map'], ['angle', 'Colour: slope angle'], ['danger', 'Colour: avalanche danger'], ['speed', 'Colour: recorded speed']]) {
      this.colourSelect.append(h('option', { value }, label));
    }
    this.root.append(
      h(
        'div',
        { class: 'plan-bar' },
        this.nameInput,
        h('label', { class: 'plan-snap edit', title: 'Legs follow the SAC routes shown on the map, or hiking paths, when you click on one; clicks beside a path run straight' }, snapBox, 'Follow paths'),
        h('label', { class: 'plan-snap' }, modeSelect, speedInput, 'km/h'),
        this.colourSelect,
        h('label', { class: 'plan-snap recorded-only', title: 'Profile and statistics from the heights the device recorded instead of the terrain model' }, this.recordedHeights, 'Recorded heights'),
        button('✓ Done', 'Finish adding points (Enter or double-click)', () => this.finish(), 'drawing-only'),
        button('↶', 'Undo (Ctrl+Z)', () => this.undo()),
        button('↷', 'Redo (Ctrl+Y)', () => this.redo()),
        button('Reverse', 'Swap start and finish', () => this.reverse()),
        button('Clear', 'Remove all points', () => this.clear()),
        button('Save', 'Add this route to the track list (kept after reload); later changes are saved to it', () => this.save(), 'edit unlinked'),
        button('Copy', 'Save a separate copy to the track list; you keep editing this track', () => this.copy(), 'edit linked'),
        button('✎ Edit', 'Change this track: move, add and remove points', () => this.edit(), 'view'),
        button('Save to my tracks', 'Add this track to your own track list (kept after reload)', () => this.save(), 'view unlinked'),
        button('🔗 Share', 'Copy a link that shows this route to others', () => this.share(), 'always'),
        button('Export GPX', 'Download the route as a GPX file', () => this.exportGpx(), 'always'),
        button('✕', 'Close the planner', () => this.close(), 'always'),
      ),
      this.readoutRow,
      h('div', { class: 'plan-body' }, this.stats, this.chart),
      this.hint,
    );

    map.on('click', (event) => this.onClick(event));
    map.on('mousemove', (event) => this.onMove(event));
    map.on('mouseout', () => this.clearPreview());
    map.on('dblclick', (event) => {
      if (!this.opened || !this.drawing) return;
      event.preventDefault();
      this.finish();
    });
    window.addEventListener('keydown', (event) => {
      if (!this.opened || event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return;
      const key = event.key.toLowerCase();
      if (this.drawing && (key === 'escape' || key === 'enter')) this.finish();
      else if (key === 'escape' && this.selection) this.select(null);
      else if (this.readonly) return;
      else if ((event.ctrlKey || event.metaKey) && key === 'z' && !event.shiftKey) {
        event.preventDefault();
        this.undo();
      } else if ((event.ctrlKey || event.metaKey) && (key === 'y' || (key === 'z' && event.shiftKey))) {
        event.preventDefault();
        this.redo();
      }
    });
    // Pointer events cover mouse, pen and touch alike.
    this.chart.addEventListener('pointerdown', (event) => {
      if (this.trackPinch(event)) return; // second finger: zooming, not selecting
      this.onChartDown(event);
      this.onChartPan(event);
    });
    // The planner's height varies (statistics, wrapping toolbar): tell the page, so the sun bar
    // and the layer panel can stay clear of it.
    new ResizeObserver(() => document.documentElement.style.setProperty('--planner-height', `${this.root.offsetHeight}px`)).observe(this.root);
    this.chart.addEventListener('auxclick', (event) => event.preventDefault()); // no paste / autoscroll on middle click
    this.chart.addEventListener('wheel', (event) => this.onChartWheel(event), { passive: false });
    this.chart.addEventListener('dblclick', () => {
      if (!this.zoom) return;
      this.zoom = null;
      this.render();
    });
    this.chart.addEventListener('pointermove', (event) => this.onChartHover(event));
    this.chart.addEventListener('pointerleave', () => {
      this.hover.remove();
      this.readout.textContent = '';
    });
  }

  /** Redraw statistics and profile (something they depend on changed outside). */
  refresh(): void {
    if (this.opened) this.render();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** Open with an empty route, ready to click points. */
  open(): void {
    if (this.readonly) {
      this.link(null);
      this.recorded = null;
    }
    this.setReadonly(false);
    this.show();
    if (!this.points.length) this.setDrawing('end');
  }

  /** Put a point here: the next point of the route being edited, or the first of a new route if the planner was closed. */
  startAt(at: Point): void {
    // With the planner closed this means a new route; the previous one stays reachable with undo.
    const fresh = !this.opened || this.readonly;
    this.setReadonly(false);
    this.show();
    this.checkpoint();
    if (fresh) {
      this.link(null);
      this.recorded = null;
    }
    if (fresh && this.points.length) {
      this.reset();
      this.nameEdited = false;
      this.nameInput.value = 'New route';
    }
    this.setDrawing('end');
    this.add(at, 'end');
  }

  get hasRoute(): boolean {
    return this.points.length > 0;
  }

  /** Open an existing track for viewing and editing. */
  /** Show a track with its profile and statistics, without edit handles. "Edit" switches to editing. */
  view(name: string, coords: Point[], trackId: string | null = null, recorded: Recorded | null = null): void {
    this.link(trackId);
    // Only usable if it lines up with the points point for point.
    this.recorded = recorded && [recorded.ele, recorded.time].every((list) => !list || list.length === coords.length) ? recorded : null;
    this.recordedHeights.checked = false;
    this.show();
    this.reset();
    this.history = [];
    this.future = [];
    if (coords.length < 2) return;
    this.setReadonly(true);
    this.nameInput.value = name.replace(/\.(gpx|tcx|fit)$/i, '');
    this.nameEdited = true;
    this.points = [this.waypoint(coords[0]), this.waypoint(coords[coords.length - 1])];
    for (const point of this.points) point.marker.setDraggable(false);
    this.legs = [{ coords: coords.slice() }];
    this.setDrawing(null);
    this.changed();
  }

  /** From viewing to editing the same track. */
  private edit(): void {
    if (this.recorded) toast('Editing turns this recording into a plain route: recorded times and heights no longer apply.', 'info');
    const coords = this.coords();
    if (coords.length > 1) this.load(this.nameInput.value, coords, this.trackId);
  }

  private readonly = false;
  /** Heights and times a device recorded for the track being viewed (unedited tracks only). */
  private recorded: Recorded | null = null;
  private recordedHeights = h('input', { type: 'checkbox', onchange: () => this.render() });
  /** Track in the list that this route is: edits are written back to it. */
  private trackId: string | null = null;
  private storeTimer: number | undefined;

  private link(trackId: string | null): void {
    clearTimeout(this.storeTimer);
    this.trackId = trackId;
    this.root.classList.toggle('linked', trackId !== null);
  }

  /** Editing a track from the list changes that track: written back shortly after each change. */
  private storeSoon(): void {
    clearTimeout(this.storeTimer);
    if (!this.trackId || this.readonly) return;
    this.storeTimer = window.setTimeout(() => {
      const coords = this.coords();
      if (!this.trackId || this.readonly || coords.length < 2) return;
      if (!this.options.onUpdate(this.trackId, this.name(), coords)) this.link(null); // removed from the list meanwhile
    }, 700);
  }

  private setReadonly(on: boolean): void {
    this.readonly = on;
    this.root.classList.toggle('readonly', on);
    this.nameInput.readOnly = on;
  }

  load(name: string, coords: Point[], trackId: string | null = null): void {
    this.link(trackId);
    this.recorded = null;
    this.setReadonly(false);
    this.show();
    this.checkpoint();
    this.reset();
    if (coords.length < 2) return;
    this.nameInput.value = name.replace(/\.(gpx|tcx|fit)$/i, '');
    this.nameEdited = true;
    // Control points along the track, so any part can be dragged without disturbing the rest.
    // The legs between them keep the recorded line exactly.
    const keep = controlPoints(coords);
    this.points = keep.map((i) => this.waypoint(coords[i]));
    this.legs = keep.slice(1).map((end, k) => ({ coords: coords.slice(keep[k], end + 1) }));
    this.setDrawing(null);
    this.changed();
    const bounds = coords.reduce((b, c) => b.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    this.map.fitBounds(bounds, { padding: { top: 80, bottom: 280, left: 340, right: 80 }, maxZoom: 15 });
  }

  close(): void {
    const wasOpen = this.opened;
    this.opened = false;
    this.setDrawing(null);
    if (wasOpen) this.options.onClose();
    this.root.classList.remove('open');
    document.body.classList.remove('planner-open');
    this.map.doubleClickZoom.enable();
    this.hover.remove();
    for (const marker of this.selectEnds) marker.remove();
    for (const point of this.points) point.marker.remove();
    for (const id of [LINE, `${LINE}-casing`, GRADE, SELECT, PREVIEW]) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', 'none');
  }

  private show(): void {
    this.opened = true;
    this.root.classList.add('open');
    document.body.classList.add('planner-open');
    this.map.doubleClickZoom.disable(); // double click ends the route instead
    if (!this.map.getSource(SOURCE)) {
      this.map.addSource(SOURCE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      const line = { type: 'line' as const, source: SOURCE, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const } };
      this.map.addLayer({ ...line, id: `${LINE}-casing`, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 } }, SLOT.plan);
      this.map.addLayer({ ...line, id: LINE, paint: { 'line-color': COLOUR, 'line-width': 4.5 } }, SLOT.plan);
      // Part of the route selected on the profile: a wide band under the line.
      this.map.addSource(SELECT, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({ ...line, id: SELECT, source: SELECT, paint: { 'line-color': '#ffd60a', 'line-width': 16, 'line-opacity': 0.75 } }, `${LINE}-casing`);
      // The same line cut into stretches coloured by steepness ("Gradient" option).
      this.map.addSource(GRADE, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({ ...line, id: GRADE, source: GRADE, paint: { 'line-color': ['get', 'colour'], 'line-width': 4.5 } }, SLOT.plan);
      // What the next click would add, while drawing.
      this.map.addSource(PREVIEW, { type: 'geojson', data: { type: 'FeatureCollection', features: [] } });
      this.map.addLayer({ id: PREVIEW, type: 'line', source: PREVIEW, layout: { 'line-join': 'round' }, paint: { 'line-color': COLOUR, 'line-width': 3, 'line-dasharray': [1.2, 1.6] } }, SLOT.plan);
    }
    for (const id of [LINE, `${LINE}-casing`, GRADE, SELECT, PREVIEW]) this.map.setLayoutProperty(id, 'visibility', 'visible');
    for (const point of this.points) point.marker.addTo(this.map);
    this.changed();
  }

  // ── editing ──

  private setDrawing(mode: 'end' | 'start' | null): void {
    this.drawing = this.opened ? mode : null;
    interaction.drawing = this.drawing !== null;
    if (!this.drawing) this.clearPreview();
    this.map.getCanvas().style.cursor = this.drawing ? 'crosshair' : '';
    this.root.classList.toggle('drawing', this.drawing !== null);
    this.hint.textContent = this.drawing
      ? 'Adding points: the dotted line shows what the next click adds. Click on a path to follow it, beside it to go straight. Double-click or Enter to finish.'
      : this.readonly
        ? 'Viewing a saved track. Drag across the profile to measure a part of it. "Edit" lets you change it.'
        : this.points.length
        ? (this.trackId ? 'Editing this track: changes are saved to it. ' : '') + 'Click the start or finish to continue from there, click the line to add a point, drag points to move them, right-click a point to delete it.'
        : '';
  }

  private finish(): void {
    this.setDrawing(null);
    void this.suggestName();
  }

  private onClick(event: maplibregl.MapMouseEvent): void {
    if (!this.opened || this.readonly) return;
    const now = performance.now();
    const repeat = now - this.lastClick.time < 350 && Math.hypot(event.point.x - this.lastClick.x, event.point.y - this.lastClick.y) < 6;
    this.lastClick = { time: now, x: event.point.x, y: event.point.y };
    const at: Point = [event.lngLat.lng, event.lngLat.lat];

    if (this.drawing) {
      if (repeat) return; // second click of a double click
      // The hover preview already shows the leg for this spot: use it as it is.
      const ready = this.preview?.settled && metres(this.preview.to, at) < this.reach() / 4 ? this.preview.coords : undefined;
      this.clearPreview();
      this.checkpoint();
      this.add(at, this.drawing, ready);
      return;
    }
    // Not drawing: a click on the line inserts a point there.
    if (!this.map.getLayer(LINE)) return;
    const { x, y } = event.point;
    if (this.map.queryRenderedFeatures([[x - 7, y - 7], [x + 7, y + 7]], { layers: [`${LINE}-casing`] }).length) {
      this.checkpoint();
      this.insert(at);
    }
  }

  private waypoint(at: Point): Waypoint {
    const element = h('div', { class: 'plan-point' });
    const marker = new maplibregl.Marker({ element, draggable: true }).setLngLat(at);
    if (this.opened) marker.addTo(this.map);
    const point: Waypoint = { at, marker };
    const placed = performance.now();
    // Markers sit above the map canvas: their clicks never reach the map's own click handler.
    element.addEventListener('click', (event) => {
      event.stopPropagation();
      if (this.readonly) return;
      const index = this.points.indexOf(point);
      if (this.drawing) {
        // Clicking the point just placed takes it back; any other point ends the drawing.
        const active = this.drawing === 'end' ? this.points.length - 1 : 0;
        if (index !== active) return this.finish();
        // The second click of a double click lands on the new point's marker: that means "finish".
        if (performance.now() - placed < 700) return this.finish();
        this.checkpoint();
        this.remove(index);
        if (!this.points.length) this.setDrawing('end');
        return;
      }
      if (index === this.points.length - 1) this.setDrawing('end');
      else if (index === 0) this.setDrawing('start');
    });
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.readonly) return;
      this.checkpoint();
      this.remove(this.points.indexOf(point));
    });
    // An end point being dragged: its leg disappears and the dotted preview shows what releasing
    // it here would give, exactly as when placing a new point.
    const endLeg = (): { leg: number; neighbour: Point } | null => {
      const index = this.points.indexOf(point);
      if (this.points.length < 2) return null;
      if (index === this.points.length - 1) return { leg: index - 1, neighbour: this.points[index - 1].at };
      if (index === 0) return { leg: 0, neighbour: this.points[1].at };
      return null;
    };
    marker.on('dragstart', () => {
      this.checkpoint();
      this.dragging = true;
      const end = endLeg();
      if (end) {
        this.legs[end.leg].coords = [];
        this.drawLine();
      }
    });
    marker.on('drag', () => {
      const end = endLeg();
      const { lng, lat } = marker.getLngLat();
      if (end) this.previewLeg(end.neighbour, [lng, lat]);
    });
    marker.on('dragend', () => {
      this.dragging = false;
      const { lng, lat } = marker.getLngLat();
      point.at = [lng, lat];
      const index = this.points.indexOf(point);
      const end = endLeg();
      const ready = end && this.preview?.settled && metres(this.preview.to, point.at) < 1 ? this.preview.coords : null;
      this.clearPreview();
      if (end && ready) {
        // Previews run from the neighbour to the dragged point.
        const inner = ready.slice(1, -1);
        this.legs[end.leg].coords = index === 0 ? [point.at, ...inner.reverse(), end.neighbour] : [end.neighbour, ...inner, point.at];
      } else {
        if (index > 0) void this.connect(index - 1);
        if (index < this.points.length - 1) void this.connect(index);
      }
      this.changed();
    });
    return point;
  }

  private add(at: Point, where: 'end' | 'start', ready?: Point[]): void {
    const point = this.waypoint(at);
    if (where === 'end') {
      this.points.push(point);
      if (this.points.length > 1) {
        const from = this.points[this.points.length - 2].at;
        this.legs.push({ coords: ready ? [from, ...ready.slice(1, -1), at] : [from, at] });
        if (!ready) void this.connect(this.legs.length - 1);
      }
    } else {
      this.points.unshift(point);
      if (this.points.length > 1) {
        const to = this.points[1].at;
        // Previews are drawn from the existing point outward: turn it round for a new start.
        this.legs.unshift({ coords: ready ? [at, ...ready.slice(1, -1).reverse(), to] : [at, to] });
        if (!ready) void this.connect(0);
      }
    }
    if (this.points.length === 1) void this.suggestName();
    this.changed();
  }

  /** Replace leg `index` by a path between its two points (straight at once, routed when the answer arrives). */
  private async connect(index: number): Promise<void> {
    const leg = this.legs[index];
    const a = this.points[index].at;
    const b = this.points[index + 1].at;
    leg.coords = [a, b];
    this.changed();
    if (!this.snap) return;
    const local = this.alongNetwork(a, b);
    const path = local ?? (await routed(a, b, this.osmReach()));
    // The route may have been edited while waiting.
    if (!path || this.legs[index] !== leg || this.points[index]?.at !== a || this.points[index + 1]?.at !== b) return;
    leg.coords = join(a, path, b);
    this.changed();
  }

  /** How close (metres) a click must be to a path to follow it: a few pixels at the current zoom. */
  private reach(pixels = SNAP_PIXELS, least = SNAP_MIN_METRES): number {
    const metresPerPixel = (40075016.686 * Math.cos(this.map.getCenter().lat * RAD)) / (512 * 2 ** this.map.getZoom());
    return Math.max(least, pixels * metresPerPixel);
  }

  private osmReach(): number {
    return this.reach(OSM_SNAP_PIXELS, OSM_SNAP_MIN_METRES);
  }

  /** Along the SAC routes drawn on the map, when both points are on one. Instant: no request needed. */
  private alongNetwork(a: Point, b: Point): Point[] | null {
    const lines = this.options.network();
    if (this.graph?.lines !== lines) this.graph = { lines, network: new Network(lines) };
    if (this.graph.network.isEmpty) return null;
    const path = this.graph.network.route(a, b, this.reach());
    return path && lengthOf(path) <= 6 * metres(a, b) + 500 ? path : null;
  }

  // ── preview of the next leg ──

  private onMove(event: maplibregl.MapMouseEvent): void {
    if (!this.opened || !this.drawing || !this.points.length || this.dragging) return;
    const from = (this.drawing === 'end' ? this.points[this.points.length - 1] : this.points[0]).at;
    this.previewLeg(from, [event.lngLat.lng, event.lngLat.lat]);
  }

  /** Dotted line for the leg from `from` to `to`: along a path if both are on one, else straight. */
  private previewLeg(from: Point, to: Point): void {
    const token = ++this.previewToken;
    const local = this.snap ? this.alongNetwork(from, to) : null;
    // Straight for now; settled only if no path lookup is still to come.
    this.showPreview(from, to, local ? join(from, local, to) : [from, to], !this.snap || local !== null);
    clearTimeout(this.previewTimer);
    if (!this.snap || local) return;
    // OpenStreetMap paths need a request: ask once the cursor rests.
    this.previewTimer = window.setTimeout(async () => {
      const path = await routed(from, to, this.osmReach());
      if (token !== this.previewToken || !(this.drawing || this.dragging)) return;
      this.showPreview(from, to, path ? join(from, path, to) : [from, to], true);
    }, 300);
  }

  private showPreview(from: Point, to: Point, coords: Point[], settled: boolean): void {
    this.preview = { from, to, coords, settled };
    (this.map.getSource(PREVIEW) as GeoJSONSource | undefined)?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: coords } });
  }

  private clearPreview(): void {
    this.previewToken++;
    clearTimeout(this.previewTimer);
    this.preview = null;
    (this.map.getSource(PREVIEW) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
  }

  /** New point on the existing line: the leg is split there, its shape kept. */
  private insert(at: Point): void {
    let best = { leg: -1, segment: 0, distance: Infinity, on: at };
    this.legs.forEach((leg, l) => {
      for (let i = 1; i < leg.coords.length; i++) {
        const on = nearestOnSegment(at, leg.coords[i - 1], leg.coords[i]);
        const d = metres(at, on);
        if (d < best.distance) best = { leg: l, segment: i, distance: d, on };
      }
    });
    if (best.leg < 0) return;
    const leg = this.legs[best.leg];
    const first: Leg = { coords: [...leg.coords.slice(0, best.segment), best.on] };
    const second: Leg = { coords: [best.on, ...leg.coords.slice(best.segment)] };
    this.legs.splice(best.leg, 1, first, second);
    this.points.splice(best.leg + 1, 0, this.waypoint(best.on));
    this.changed();
  }

  private remove(index: number): void {
    if (index < 0) return;
    this.points[index].marker.remove();
    this.points.splice(index, 1);
    if (!this.legs.length) return this.changed();
    if (index === 0) this.legs.shift();
    else if (index === this.points.length) this.legs.pop();
    else {
      this.legs.splice(index - 1, 2, { coords: [this.points[index - 1].at, this.points[index].at] });
      void this.connect(index - 1);
    }
    this.changed();
  }

  // ── undo / redo ──

  private snapshot(): Snapshot {
    return { points: this.points.map((p) => p.at), legs: this.legs.map((leg) => leg.coords.slice()), name: this.nameInput.value, nameEdited: this.nameEdited };
  }

  /** Call before every change the user makes. */
  private checkpoint(): void {
    this.history.push(this.snapshot());
    if (this.history.length > 100) this.history.shift();
    this.future = [];
  }

  private restore(state: Snapshot): void {
    this.reset();
    this.points = state.points.map((at) => this.waypoint(at));
    this.legs = state.legs.map((coords) => ({ coords: coords.slice() }));
    this.nameInput.value = state.name;
    this.nameEdited = state.nameEdited;
    this.clearPreview();
    if (!this.points.length) this.setDrawing('end');
    this.changed();
  }

  private undo(): void {
    const state = this.history.pop();
    if (!state) return;
    this.future.push(this.snapshot());
    this.restore(state);
  }

  private redo(): void {
    const state = this.future.pop();
    if (!state) return;
    this.history.push(this.snapshot());
    this.restore(state);
  }

  private reverse(): void {
    this.checkpoint();
    this.points.reverse();
    this.legs.reverse();
    for (const leg of this.legs) leg.coords.reverse();
    this.changed();
  }

  private reset(): void {
    for (const point of this.points) point.marker.remove();
    this.points = [];
    this.legs = [];
    this.profile = null;
  }

  private clear(): void {
    this.checkpoint();
    this.link(null); // an emptied planner is a new route, not the old track
    this.reset();
    this.nameEdited = false;
    this.nameInput.value = 'New route';
    this.setDrawing('end');
    this.changed();
  }

  // ── derived data ──

  private coords(): Point[] {
    return this.legs.flatMap((leg, i) => (i ? leg.coords.slice(1) : leg.coords));
  }

  private changed(): void {
    this.points.forEach((point, i) => {
      const element = point.marker.getElement();
      element.classList.toggle('start', i === 0);
      element.classList.toggle('finish', i === this.points.length - 1 && i > 0);
      element.title = i === 0 ? 'Start' : i === this.points.length - 1 ? 'Finish' : 'Drag to move, right-click to delete';
    });
    this.drawLine();
    if (!this.drawing) this.setDrawing(null); // refresh the hint
    clearTimeout(this.profileTimer);
    this.profileTimer = window.setTimeout(() => void this.updateProfile(), 250);
    this.storeSoon();
  }

  private drawLine(): void {
    (this.map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData({
      type: 'Feature',
      properties: {},
      geometry: { type: 'MultiLineString', coordinates: this.legs.map((leg) => leg.coords).filter((c) => c.length > 1) },
    });
  }

  private async updateProfile(): Promise<void> {
    const token = ++this.profileToken;
    const line = this.coords();
    if (line.length < 2) {
      this.profile = null;
      this.render();
      return;
    }
    const coords: Point[] = [line[0]];
    const distance: number[] = [0];
    let total = 0;
    let recEle: number[] | null = null;
    let time: (number | null)[] | null = null;
    const recorded = this.readonly && this.recorded && (this.recorded.ele ?? this.recorded.time)?.length === line.length ? this.recorded : null;
    if (recorded) {
      // A recording is sampled at its own points (thinned if there are very many), so that
      // recorded heights and times stay attached to the right places.
      const every = Math.ceil(line.length / MAX_RECORDED_SAMPLES);
      const kept = [0];
      for (let i = 1; i < line.length; i++) {
        total += metres(line[i - 1], line[i]);
        if (i % every === 0 || i === line.length - 1) {
          kept.push(i);
          coords.push(line[i]);
          distance.push(total);
        }
      }
      if (recorded.ele) {
        // Gaps take the last known height.
        let last = recorded.ele.find((z) => z !== null) ?? 0;
        recEle = kept.map((i) => (last = recorded.ele![i] ?? last));
      }
      if (recorded.time) time = kept.map((i) => recorded.time![i]);
    }
    // Otherwise evenly spaced samples, so straight legs get heights along their whole length too.
    for (let i = 1; !recorded && i < line.length; i++) {
      const d = metres(line[i - 1], line[i]);
      const parts = Math.max(1, Math.ceil(d / STEP));
      for (let k = 1; k <= parts; k++) {
        const t = k / parts;
        coords.push([line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t]);
        distance.push(total + d * t);
      }
      total += d;
    }
    try {
      const height = await elevations(coords);
      // Steepness of the ground itself (not of the route): from heights a little east, west, north and south.
      const around: Point[] = [];
      for (const [lng, lat] of coords) {
        const dLat = ANGLE_REACH / 111320;
        const dLng = dLat / Math.cos(lat * RAD);
        around.push([lng + dLng, lat], [lng - dLng, lat], [lng, lat + dLat], [lng, lat - dLat]);
      }
      const near = await elevations(around);
      if (token !== this.profileToken) return;
      const angle = coords.map((_, i) => {
        const dzdx = (near[i * 4] - near[i * 4 + 1]) / (2 * ANGLE_REACH);
        const dzdy = (near[i * 4 + 2] - near[i * 4 + 3]) / (2 * ANGLE_REACH);
        return Math.atan(Math.hypot(dzdx, dzdy)) / RAD;
      });
      this.profile = { coords, distance, height, terrain: height, angle, recEle, time };
      this.selection = null;
      this.zoom = null;
    } catch (error) {
      if (token !== this.profileToken) return;
      this.profile = { coords, distance, height: [], terrain: [], angle: [], recEle, time };
      toast(`Elevation profile unavailable: ${(error as Error).message}`);
    }
    this.render();
  }

  /** Totals for the part of the profile between two sample indices. */
  private summarise(from: number, to: number): { distance: number; up: number; down: number; lowest: number; highest: number; hours: number; steep: number; steepest: number } {
    const p = this.profile!;
    const distance = p.distance[to] - p.distance[from];
    let up = 0;
    let down = 0;
    let lowest = Infinity;
    let highest = -Infinity;
    if (p.height.length) {
      // Sum climbs and descents between turning points, ignoring wiggles smaller than the threshold.
      let anchor = p.height[from];
      for (let i = from; i <= to; i++) {
        const z = p.height[i];
        if (z < lowest) lowest = z;
        if (z > highest) highest = z;
        if (z - anchor >= HYSTERESIS) {
          up += z - anchor;
          anchor = z;
        } else if (anchor - z >= HYSTERESIS) {
          down += anchor - z;
          anchor = z;
        }
      }
    }
    // Time: every stretch at the flat speed times the mode's factor for its slope.
    const stretch = this.stretch();
    const mode = MODES[this.mode];
    let hours = 0;
    for (let i = from; i < to; i += stretch) {
      const j = Math.min(to, i + stretch);
      const run = p.distance[j] - p.distance[i];
      const slope = p.height.length ? (p.height[j] - p.height[i]) / Math.max(1, run) : 0;
      hours += run / 1000 / (this.speeds[this.mode] * Math.max(0.05, mode.factor(slope)));
    }
    // Ground steeper than 30 degrees, the usual threshold for avalanche terrain.
    let steep = 0;
    let steepest = 0;
    for (let i = from; i <= to && i < p.angle.length; i++) {
      if (p.angle[i] > steepest) steepest = p.angle[i];
      if (p.angle[i] >= 30 && i > from) steep += p.distance[i] - p.distance[i - 1];
    }
    return { distance, up, down, lowest, highest, hours, steep, steepest };
  }

  /** Samples per stretch of roughly 90 m (longer on long routes): the unit for slope and time. */
  private stretch(): number {
    const p = this.profile!;
    return Math.max(2, Math.round(Math.max(90, p.distance[p.distance.length - 1] / 160) / STEP));
  }

  private indexAt(distance: number): number {
    const p = this.profile!;
    const i = p.distance.findIndex((d) => d >= distance);
    return i < 0 ? p.distance.length - 1 : i;
  }

  /** Statistics box: the selected part of the profile if there is one, else the whole route. */
  private renderStats(): void {
    const p = this.profile;
    if (!p) return;
    const selected = this.selection;
    const from = selected ? this.indexAt(selected.from) : 0;
    const to = selected ? this.indexAt(selected.to) : p.distance.length - 1;
    const s = this.summarise(from, to);
    const known = p.height.length > 0;
    const stat = (label: string, value: string) => h('div', { class: 'plan-stat' }, h('b', {}, value), h('span', {}, label));
    const gradient = known && s.distance > 0 ? ((p.height[to] - p.height[from]) / s.distance) * 100 : 0;
    // Two columns: distance and height range, then ascent and descent, then time and gradient.
    const items = [
      stat('distance', `${(s.distance / 1000).toFixed(s.distance < 10000 ? 2 : 1)} km`),
      stat('lowest / highest', known ? `${Math.round(s.lowest)} / ${Math.round(s.highest)} m` : '–'),
      stat('ascent', known ? `↑ ${Math.round(s.up)} m` : '–'),
      stat('descent', known ? `↓ ${Math.round(s.down)} m` : '–'),
      stat(`time, ${MODES[this.mode].name.toLowerCase()}`, `${Math.floor(s.hours + 1 / 120)} h ${String(Math.round(s.hours * 60) % 60).padStart(2, '0')}`),
      stat('average gradient', known ? `${gradient >= 0 ? '+' : '−'}${Math.abs(gradient).toFixed(1)}%` : '–'),
      stat('ground over 30°', p.angle.length ? `${(s.steep / 1000).toFixed(2)} km` : '–'),
      stat('steepest ground', p.angle.length ? `${Math.round(s.steepest)}°` : '–'),
    ];
    if (p.time) {
      // What was actually recorded on this stretch: elapsed time, time on the move, speed while moving.
      let elapsed = 0;
      let moving = 0;
      let movingDistance = 0;
      for (let i = from + 1; i <= to; i++) {
        const t0 = p.time[i - 1];
        const t1 = p.time[i];
        if (t0 === null || t1 === null || t1 <= t0) continue;
        const dt = (t1 - t0) / 1000;
        const d = p.distance[i] - p.distance[i - 1];
        elapsed += dt;
        if (d / dt >= PAUSE_SPEED) {
          moving += dt;
          movingDistance += d;
        }
      }
      const clock = (seconds: number) => `${Math.floor(seconds / 3600)} h ${String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')}`;
      items.push(
        stat('recorded time', clock(elapsed)),
        stat('time moving', clock(moving)),
        stat('speed while moving', moving ? `${((movingDistance / moving) * 3.6).toFixed(1)} km/h` : '–'),
        stat('pace while moving', moving && movingDistance ? `${Math.floor(moving / 60 / (movingDistance / 1000))}:${String(Math.round((moving / (movingDistance / 1000)) % 60)).padStart(2, '0')} /km` : '–'),
      );
    }
    this.stats.classList.toggle('many', items.length > 8);
    if (selected) {
      items.unshift(
        h('div', { class: 'plan-stats-title' }, 'Selection', h('button', { type: 'button', title: 'Back to the whole route (Esc)', onclick: () => this.select(null) }, '✕')),
      );
    }
    this.stats.replaceChildren(...items);
  }

  // ── selecting part of the profile ──

  private selection: { from: number; to: number } | null = null;
  /** Part of the route the chart shows (metres along it); null: all of it. Changed with the mouse wheel. */
  private zoom: { from: number; to: number } | null = null;

  private window(): { from: number; to: number; span: number } {
    const p = this.profile;
    const total = p ? p.distance[p.distance.length - 1] : 0;
    const from = this.zoom?.from ?? 0;
    const to = this.zoom?.to ?? total;
    return { from, to, span: Math.max(1, to - from) };
  }

  /** Horizontal position in the chart, in percent, of a distance along the route. */
  private percent(distance: number): number {
    const view = this.window();
    return ((distance - view.from) / view.span) * 100;
  }

  /** Distance along the route under a mouse position on the chart. */
  private distanceAt(event: MouseEvent, box: DOMRect): number {
    const view = this.window();
    return view.from + Math.min(1, Math.max(0, (event.clientX - box.left) / box.width)) * view.span;
  }

  /** Middle button drag: slide the zoomed chart along the route. */
  private onChartPan(event: MouseEvent): void {
    const p = this.profile;
    const svg = this.chart.querySelector('svg');
    if (event.button !== 1 || !p?.height.length || !svg) return;
    event.preventDefault(); // otherwise the browser starts its own scroll mode
    if (!this.zoom) return; // the whole route is in view: nothing to slide
    const total = p.distance[p.distance.length - 1];
    const width = svg.getBoundingClientRect().width;
    const start = { x: event.clientX, from: this.zoom.from, span: this.zoom.to - this.zoom.from };
    this.chart.style.cursor = 'grabbing';
    const move = (e: MouseEvent) => {
      // The route follows the hand: dragging left shows what lies further along.
      const from = Math.min(total - start.span, Math.max(0, start.from - ((e.clientX - start.x) / width) * start.span));
      this.zoom = { from, to: from + start.span };
      this.render();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      this.chart.style.cursor = '';
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  // ── touch: two fingers on the chart zoom and slide it ──

  private fingers = new Map<number, number>(); // pointer id → x
  private pinch: { span: number; anchor: number; gap: number; total: number } | null = null;
  private pinched = false;

  /** Follows touch points on the chart. True when this pointer makes it a two-finger gesture. */
  private trackPinch(event: PointerEvent): boolean {
    if (event.pointerType !== 'touch') return false;
    const p = this.profile;
    const svg = this.chart.querySelector('svg');
    if (!p?.height.length || !svg) return false;
    this.fingers.set(event.pointerId, event.clientX);
    if (this.fingers.size === 1) {
      const move = (e: PointerEvent) => {
        if (!this.fingers.has(e.pointerId)) return;
        this.fingers.set(e.pointerId, e.clientX);
        if (!this.pinch || this.fingers.size < 2) return;
        const [x0, x1] = [...this.fingers.values()];
        const box = svg.getBoundingClientRect();
        // Fingers apart: less of the route fills the chart. The spot between them stays under them.
        const span = Math.min(this.pinch.total, Math.max(Math.min(this.pinch.total, 200), (this.pinch.span * this.pinch.gap) / Math.max(20, Math.abs(x1 - x0))));
        const middle = Math.min(1, Math.max(0, ((x0 + x1) / 2 - box.left) / box.width));
        const from = Math.min(this.pinch.total - span, Math.max(0, this.pinch.anchor - middle * span));
        this.zoom = span >= this.pinch.total - 1 ? null : { from, to: from + span };
        this.render();
      };
      const end = (e: PointerEvent) => {
        this.fingers.delete(e.pointerId);
        if (this.fingers.size < 2) this.pinch = null;
        if (this.fingers.size) return;
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', end);
        window.removeEventListener('pointercancel', end);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', end);
      window.addEventListener('pointercancel', end);
      return false;
    }
    if (this.fingers.size === 2) {
      const [x0, x1] = [...this.fingers.values()];
      const box = svg.getBoundingClientRect();
      const view = this.window();
      const middle = Math.min(1, Math.max(0, ((x0 + x1) / 2 - box.left) / box.width));
      this.pinch = { span: view.span, anchor: view.from + middle * view.span, gap: Math.max(20, Math.abs(x1 - x0)), total: p.distance[p.distance.length - 1] };
      this.pinched = true;
    }
    return true;
  }

  /** Wheel: zoom in or out around the cursor. Shift+wheel or sideways scroll: move along the route. */
  private onChartWheel(event: WheelEvent): void {
    const p = this.profile;
    const svg = this.chart.querySelector('svg');
    if (!p?.height.length || !svg) return;
    event.preventDefault();
    const total = p.distance[p.distance.length - 1];
    const view = this.window();
    let from: number;
    let span: number;
    if (event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
      span = view.span;
      from = view.from + ((event.deltaX || event.deltaY) / 600) * span;
    } else {
      const anchor = this.distanceAt(event, svg.getBoundingClientRect());
      span = Math.min(total, Math.max(Math.min(total, 200), view.span * Math.exp(event.deltaY / 400)));
      from = anchor - ((anchor - view.from) / view.span) * span;
    }
    from = Math.min(total - span, Math.max(0, from));
    this.zoom = span >= total - 1 ? null : { from, to: from + span };
    this.render();
    this.onChartHover(event);
  }

  private selectEnds = [0, 1].map(() => new maplibregl.Marker({ element: h('div', { class: 'plan-select-end' }) }));

  private select(range: { from: number; to: number } | null): void {
    const p = this.profile;
    this.selection = range && p && range.to - range.from > 1 ? range : null;
    this.renderStats();
    this.drawSelection();
  }

  /** Band and handles on the chart, highlighted stretch on the map. */
  private drawSelection(): void {
    const p = this.profile;
    for (const old of this.chart.querySelectorAll('.plan-select-band, .plan-select-handle')) old.remove();
    const source = this.map.getSource(SELECT) as GeoJSONSource | undefined;
    if (!p || !this.selection || !this.opened) {
      source?.setData({ type: 'FeatureCollection', features: [] });
      for (const marker of this.selectEnds) marker.remove();
      return;
    }
    const { from, to } = this.selection;
    const band = h('div', { class: 'plan-select-band' });
    // Clipped to the part of the route the chart shows.
    const left = Math.max(0, this.percent(from));
    const right = Math.min(100, this.percent(to));
    band.style.left = `${left}%`;
    band.style.width = `${Math.max(0, right - left)}%`;
    const handles = [from, to].map((d, which) => {
      const handle = h('div', { class: 'plan-select-handle', title: 'Drag to adjust', 'data-handle': String(which) });
      handle.style.left = `${this.percent(d)}%`;
      handle.hidden = this.percent(d) < -0.5 || this.percent(d) > 100.5;
      return handle;
    });
    if (right > left) this.chart.append(band);
    this.chart.append(...handles);
    const i0 = this.indexAt(from);
    const i1 = this.indexAt(to);
    source?.setData({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: p.coords.slice(i0, i1 + 1) } });
    this.selectEnds[0].setLngLat(p.coords[i0]).addTo(this.map);
    this.selectEnds[1].setLngLat(p.coords[i1]).addTo(this.map);
  }

  /** Drag across the chart to select; drag a handle to adjust; a plain click clears. */
  private onChartDown(event: MouseEvent): void {
    const p = this.profile;
    const svg = this.chart.querySelector('svg');
    if (event.button !== 0 || this.drawing || !p?.distance.length || !svg) return;
    event.preventDefault();
    const box = svg.getBoundingClientRect();
    const at = (e: MouseEvent) => this.distanceAt(e, box);
    const handle = (event.target as HTMLElement).dataset?.handle;
    // The end that stays put: the other handle, or where the drag began.
    const fixed = handle !== undefined && this.selection ? (handle === '0' ? this.selection.to : this.selection.from) : at(event);
    let moved = handle !== undefined;
    const before = this.selection;
    const move = (e: MouseEvent) => {
      if (this.pinch) return; // a second finger arrived: this is a zoom gesture
      if (Math.abs(e.clientX - event.clientX) > 3) moved = true;
      if (!moved) return;
      const other = at(e);
      this.select({ from: Math.min(fixed, other), to: Math.max(fixed, other) });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointercancel', up);
      if (this.pinch || this.pinched) this.select(before); // the drag was the start of a pinch
      else if (!moved) this.select(null);
      this.pinched = false;
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    window.addEventListener('pointercancel', up, { once: true });
  }

  private render(): void {
    const p = this.profile;
    if (!p) {
      this.stats.replaceChildren(h('div', { class: 'muted' }, 'No route yet'));
      this.chart.replaceChildren();
      this.selection = null;
      this.zoom = null;
      this.drawSelection();
      (this.map.getSource(GRADE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    const total = p.distance[p.distance.length - 1];
    // Recorded heights instead of the terrain model, if asked for and available.
    this.root.classList.toggle('has-recorded-heights', !!p.recEle);
    p.height = this.recordedHeights.checked && p.recEle ? p.recEle : p.terrain;
    // Recorded speed around each sample (over about a stretch either side), metres per second.
    this.speed = [];
    if (p.time) {
      const reach = this.stretch();
      for (let i = 0; i < p.time.length; i++) {
        const a = Math.max(0, i - reach);
        const b = Math.min(p.time.length - 1, i + reach);
        const t0 = p.time[a];
        const t1 = p.time[b];
        this.speed[i] = t0 !== null && t1 !== null && t1 > t0 ? (p.distance[b] - p.distance[a]) / ((t1 - t0) / 1000) : null;
      }
    }
    // Heights are scaled to the part of the route in view.
    const view = this.window();
    const firstShown = Math.max(0, this.indexAt(view.from) - 1);
    const lastShown = this.indexAt(view.to);
    const { lowest, highest } = this.summarise(firstShown, lastShown);
    this.renderStats();
    this.chart.replaceChildren();
    if (!p.height.length) return;

    const width = 1000;
    const height = 120;
    const span = Math.max(40, highest - lowest);
    const base = lowest - span * 0.1;
    const top = highest + span * 0.22;
    const x = (d: number) => ((d - view.from) / view.span) * width;
    const y = (z: number) => height - ((z - base) / (top - base)) * height;
    const point = (i: number) => `${x(p.distance[i]).toFixed(1)},${y(p.height[i]).toFixed(1)}`;
    const outline = p.height.map((_, i) => `${i ? 'L' : 'M'}${point(i)}`).join('');
    const hairline = 'stroke="currentColor" stroke-width="1" vector-effect="non-scaling-stroke"';

    // Grid: a round step that gives a handful of lines each way.
    const step = (range: number, choices: number[], most: number) => choices.find((c) => range / c <= most) ?? choices[choices.length - 1];
    const kmStep = step(view.span / 1000, [0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100], 12);
    const mStep = step(top - base, [10, 20, 50, 100, 200, 500, 1000, 2000], 4);
    const labels: HTMLElement[] = [];
    let grid = '';
    for (let km = Math.ceil(view.from / 1000 / kmStep + 0.25) * kmStep; km < view.to / 1000 - kmStep * 0.25; km += kmStep) {
      grid += `<line x1="${x(km * 1000)}" x2="${x(km * 1000)}" y1="0" y2="${height}" ${hairline} opacity="0.16"/>`;
      const label = h('span', { class: 'plan-tick x' }, `${+km.toFixed(2)} km`);
      label.style.left = `${this.percent(km * 1000)}%`;
      labels.push(label);
    }
    for (let m = Math.ceil(base / mStep) * mStep; m < top; m += mStep) {
      grid += `<line x1="0" x2="${width}" y1="${y(m)}" y2="${y(m)}" ${hairline} opacity="0.16"/>`;
      const label = h('span', { class: 'plan-tick y' }, `${m} m`);
      label.style.top = `${(y(m) * 100) / height}%`;
      labels.push(label);
    }

    // What the colours show. Options that need a layer which is not on fall back to the plain route.
    const snow = this.options.snow();
    const danger = this.options.danger();
    for (const option of this.colourSelect.options) option.disabled = option.value === 'speed' && !p.time; // only a recording has speeds
    let mode: ColourBy | 'route' = this.colourBy === 'auto' ? (snow?.shown ? 'snow' : 'route') : this.colourBy;
    if ((mode === 'snow' && !snow) || (mode === 'danger' && !danger) || (mode === 'angle' && !p.angle.length) || (mode === 'speed' && !p.time)) mode = 'route';

    // Steepness per stretch of roughly 90 m: for the coloured profile, the map line and the readout.
    const stretch = this.stretch();
    this.slopes = [];
    let area = '';
    const pieces: GeoJSON.Feature[] = [];
    for (let i = 0; i < p.height.length - 1; i += stretch) {
      const j = Math.min(p.height.length - 1, i + stretch);
      const slope = (p.height[j] - p.height[i]) / Math.max(1, p.distance[j] - p.distance[i]);
      const colour = gradeColour(slope);
      for (let k = i; k < j; k++) this.slopes[k] = slope;
      this.slopes[j] = slope;
      if (mode !== 'gradient') continue;
      let d = `M${x(p.distance[i]).toFixed(1)},${height}`;
      for (let k = i; k <= j; k++) d += `L${point(k)}`;
      area += `<path d="${d}L${x(p.distance[j]).toFixed(1)},${height}Z" fill="${colour}" fill-opacity="0.85"/>`;
      pieces.push({ type: 'Feature', properties: { colour }, geometry: { type: 'LineString', coordinates: p.coords.slice(i, j + 1) } });
    }
    // Snow, slope angle and danger are known per sample: one colour per sample, drawn as runs of
    // equal colour. Snow values and danger levels are kept for the readout whatever the colours show.
    this.snow = [];
    this.danger = [];
    for (let i = 0; i < p.coords.length; i++) {
      this.snow[i] = snow ? (snow.at(p.coords[i][0], p.coords[i][1])?.value ?? null) : null;
      this.danger[i] = danger ? danger.at(p.coords[i][0], p.coords[i][1]) : null;
    }
    const NEUTRAL = '#9aa3ad';
    let colourAt: ((i: number) => string) | null = null;
    let opacityAt: (i: number) => number = () => 0.9;
    if (mode === 'snow' && snow) {
      colourAt = (i) => {
        const hit = snow.at(p.coords[i][0], p.coords[i][1]);
        return hit && !(snow.unit === 'cm' && hit.value <= 0) ? hit.colour : NEUTRAL;
      };
    } else if (mode === 'angle') {
      colourAt = (i) => angleColour(p.angle[i]);
    } else if (mode === 'speed') {
      // Relative to this track's own typical moving speed, so it works for walking and cycling alike.
      const moving = this.speed.filter((v): v is number => v !== null && v >= PAUSE_SPEED).sort((a, b) => a - b);
      const typical = moving[Math.floor(moving.length / 2)] || 1;
      colourAt = (i) => {
        const v = this.speed[i];
        return v === null || v === undefined || v < PAUSE_SPEED ? NEUTRAL : SPEEDS.find(([upTo]) => v / typical < upTo)![1];
      };
    } else if (mode === 'danger') {
      colourAt = (i) => this.danger[i]?.colour ?? NEUTRAL;
      // Paler outside the altitudes the bulletin's avalanche problems are described for.
      opacityAt = (i) => {
        const hit = this.danger[i];
        return !hit || !hit.bands.length || hit.bands.some((b) => p.height[i] >= b.from && p.height[i] <= b.to) ? 0.9 : 0.4;
      };
    }
    if (colourAt) {
      let from = 0;
      let current = `${colourAt(0)}|${opacityAt(0)}`;
      for (let i = 1; i < p.coords.length; i++) {
        const next = `${colourAt(i)}|${opacityAt(i)}`;
        if (next === current && i < p.coords.length - 1) continue;
        const [colour, opacity] = current.split('|');
        // One piece per run, from the curve down to the axis.
        let d = `M${x(p.distance[from]).toFixed(1)},${height}`;
        for (let k = from; k <= i; k++) d += `L${point(k)}`;
        area += `<path d="${d}L${x(p.distance[i]).toFixed(1)},${height}Z" fill="${colour}" fill-opacity="${opacity}"/>`;
        // The snow map itself is on the map already; slope angle and danger colour the route line.
        if (mode !== 'snow') pieces.push({ type: 'Feature', properties: { colour }, geometry: { type: 'LineString', coordinates: p.coords.slice(from, i + 1) } });
        from = i;
        current = next;
      }
    }
    (this.map.getSource(GRADE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pieces });
    const coloured = area;

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.innerHTML =
      (coloured || `<path d="${outline}L${width},${height}L0,${height}Z" fill="${COLOUR}" fill-opacity="0.22"/>`) +
      grid +
      `<path d="${outline}" fill="none" stroke="${coloured ? 'currentColor' : COLOUR}" stroke-width="${coloured ? 1.2 : 2}" vector-effect="non-scaling-stroke"/>` +
      `<line class="plan-cursor" x1="0" x2="0" y1="0" y2="${height}" ${hairline} visibility="hidden"/>`;

    // Highest and lowest point, marked on the curve.
    const extreme = (index: number, mark: string, className: string) => {
      const label = h('span', { class: `plan-extreme ${className}` }, `${mark} ${Math.round(p.height[index])} m`);
      label.style.left = `${Math.min(94, Math.max(6, this.percent(p.distance[index])))}%`;
      label.style.top = `${(y(p.height[index]) * 100) / height}%`;
      return label;
    };
    this.chart.append(
      svg,
      ...labels,
      extreme(p.height.indexOf(highest, firstShown), '▲', 'high'),
      extreme(p.height.indexOf(lowest, firstShown), '▼', 'low'),
    );
    if (mode === 'snow' && snow) this.chart.append(h('span', { class: 'plan-snow-label', title: 'From the snow map shown on the map; grey: no snow or no data' }, `${snow.name} (${snow.unit})`));
    if (mode === 'danger') this.chart.append(h('span', { class: 'plan-snow-label', title: 'Danger level of the bulletin region; paler outside the altitudes its avalanche problems are described for. Orientation only.' }, 'Avalanche danger (bulletin)'));
    if (mode === 'speed') {
      const legend = h('span', { class: 'plan-grades', title: 'Recorded speed compared with the typical moving speed of this track; grey: standing' });
      for (const [, colour, label] of SPEEDS) {
        const swatch = h('i', {}, label);
        swatch.style.background = colour;
        swatch.style.color = colour === '#3fbf5a' || colour === '#f59b2b' || colour === '#5e9bea' ? '#111' : '#fff';
        legend.append(swatch);
      }
      this.chart.append(legend);
    }
    if (mode === 'angle') {
      const legend = h('span', { class: 'plan-grades', title: 'Steepness of the ground at the route (not of the route itself). Orientation only: computed from the elevation model.' });
      for (const [, colour, label] of ANGLES) {
        const swatch = h('i', {}, label);
        swatch.style.background = colour;
        swatch.style.color = colour === '#9c27b0' || colour === '#f44336' ? '#fff' : '#111';
        legend.append(swatch);
      }
      this.chart.append(legend);
    }
    if (mode === 'gradient') {
      const legend = h('span', { class: 'plan-grades', title: 'Slope: blue downhill, green flat, red uphill' });
      let from = -Infinity;
      for (const [upTo, colour] of GRADES) {
        const pct = (v: number) => `${v > 0 ? '+' : ''}${Math.round(v * 100)}`;
        const text = !Number.isFinite(from) ? `<${pct(upTo)}%` : !Number.isFinite(upTo) ? `>${pct(from)}%` : `${pct(from)}…${pct(upTo)}%`;
        const swatch = h('i', {}, text);
        swatch.style.background = colour;
        swatch.style.color = Math.abs(from) >= 0.18 || upTo <= -0.18 ? '#fff' : '#111';
        legend.append(swatch);
        from = upTo;
      }
      this.chart.append(legend);
    }
    this.drawSelection();
  }
  private slopes: number[] = [];
  /** Snow map value at each profile sample (null: no data), when a snow map is shown. */
  private snow: (number | null)[] = [];
  /** Recorded speed at each profile sample in m/s (null: unknown), for recordings with times. */
  private speed: (number | null)[] = [];
  private danger: ReturnType<DangerSampler['at']>[] = [];

  private onChartHover(event: MouseEvent): void {
    const p = this.profile;
    const svg = this.chart.querySelector('svg');
    if (!p?.height.length || !svg) return;
    const box = svg.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
    const i = this.indexAt(this.distanceAt(event, box));
    const cursor = svg.querySelector('.plan-cursor')!;
    cursor.setAttribute('x1', String(fraction * 1000));
    cursor.setAttribute('x2', String(fraction * 1000));
    cursor.setAttribute('visibility', 'visible');
    const readout = this.readout;
    const slope = this.slopes[i] ?? 0;
    const sampler = this.options.snow();
    const snowValue = this.snow[i];
    let snowText = !sampler ? '' : snowValue === null || snowValue === undefined ? ' · snow: no data' : ` · snow ${Math.round(snowValue)} ${sampler.unit}`;
    if (p.angle.length) snowText += ` · ground ${Math.round(p.angle[i])}°`;
    const hit = this.danger[i];
    if (hit) snowText += ` · danger ${hit.level} (${hit.name})`;
    const when = p.time?.[i];
    if (when != null) {
      const v = this.speed[i];
      snowText += ` · ${new Date(when).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}${v != null ? ` · ${(v * 3.6).toFixed(1)} km/h` : ''}`;
    }
    readout.textContent = `${(p.distance[i] / 1000).toFixed(2)} km · ${Math.round(p.height[i])} m · ${slope >= 0 ? '+' : '−'}${Math.abs(Math.round(slope * 100))}%${snowText}`;
    // Above the cursor, kept inside the row.
    const row = this.readoutRow.getBoundingClientRect();
    const half = readout.offsetWidth / 2;
    readout.style.left = `${Math.min(row.width - half, Math.max(half, box.left - row.left + fraction * box.width))}px`;
    this.hover.setLngLat(p.coords[i]).addTo(this.map);
  }

  // ── name, save, export ──

  /** "Start place – finish place" from OpenStreetMap, unless the user typed a name. */
  private async suggestName(): Promise<void> {
    if (this.nameEdited || !this.points.length) return;
    const place = placeName;
    const start = await place(this.points[0].at);
    const finish = this.points.length > 1 ? await place(this.points[this.points.length - 1].at) : null;
    if (this.nameEdited || !start) return;
    this.nameInput.value = finish && finish !== start ? `${start} – ${finish}` : this.points.length > 1 ? `${start} round trip` : `Route from ${start}`;
  }

  private name(): string {
    return this.nameInput.value.trim() || 'Route';
  }

  private save(): void {
    const coords = this.coords();
    if (coords.length < 2) return toast('Add at least two points first.');
    this.link(this.options.onSave(this.name(), coords));
  }

  private share(): void {
    const coords = this.coords();
    if (coords.length < 2) return toast('Add at least two points first.');
    this.options.onShare(this.name(), coords);
  }

  private copy(): void {
    const coords = this.coords();
    if (coords.length < 2) return;
    this.options.onSave(`${this.name()} (copy)`, coords);
    toast('Copy added to the track list.', 'info');
  }

  private exportGpx(): void {
    const p = this.profile;
    if (!p || p.coords.length < 2) return toast('Add at least two points first.');
    const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!);
    const line = this.coords();
    const recorded = this.readonly && this.recorded && (this.recorded.ele ?? this.recorded.time)?.length === line.length ? this.recorded : null;
    const points = recorded
      ? // An unedited recording goes out as it came in: every point with its recorded height and time.
        line
          .map((c, i) => {
            const z = recorded.ele?.[i];
            const t = recorded.time?.[i];
            return `      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${z != null ? `<ele>${z.toFixed(1)}</ele>` : ''}${t != null ? `<time>${new Date(t).toISOString()}</time>` : ''}</trkpt>`;
          })
          .join('\n')
      : p.coords.map((c, i) => `      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${p.terrain.length ? `<ele>${p.terrain[i].toFixed(1)}</ele>` : ''}</trkpt>`).join('\n');
    const gpx =
      `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="3D Terrain Viewer" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      `  <metadata><name>${escape(this.name())}</name></metadata>\n  <trk>\n    <name>${escape(this.name())}</name>\n    <trkseg>\n${points}\n    </trkseg>\n  </trk>\n</gpx>\n`;
    const link = h('a', { href: URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' })), download: `${this.name().replace(/[\\/:*?"<>|]+/g, '_')}.gpx` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }
}

/** From the clicked point straight to where the path begins, along it, then straight to the next point. */
function join(a: Point, path: Point[], b: Point): Point[] {
  return [a, ...path, b].filter((c, i, all) => i === 0 || metres(all[i - 1], c) > 0.5);
}

function nearestOnSegment(p: Point, a: Point, b: Point): Point {
  // Flat approximation around the segment: fine at the scale of a map click.
  const scale = Math.cos(a[1] * RAD);
  const ax = a[0] * scale;
  const bx = b[0] * scale;
  const px = p[0] * scale;
  const dx = bx - ax;
  const dy = b[1] - a[1];
  const length = dx * dx + dy * dy;
  const t = length ? Math.min(1, Math.max(0, ((px - ax) * dx + (p[1] - a[1]) * dy) / length)) : 0;
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}
