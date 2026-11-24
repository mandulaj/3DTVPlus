// Route planner: click points on the map, legs follow paths where a path is close enough and run
// straight otherwise. A bottom widget shows distance, ascent, descent and an elevation profile,
// and exports GPX. Dropped tracks can be opened in it and edited the same way.
import * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { elevations } from './elevation';
import { simplify } from './geometry';
import { interaction } from './interaction';
import { SLOT } from './map';
import { Network } from './network';
import type { SnowSampler } from './layers/slf';
import { placeName } from './places';
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

/**
 * Travel modes for the time estimate. Each has a speed on flat ground (adjustable) and a rule
 * for how slope changes it; the route is timed stretch by stretch with the local slope.
 */
const MODES = {
  hiking: {
    name: 'Hiking',
    flat: 4.5,
    // Tobler's hiking function, scaled so that level ground gives the chosen speed: fastest on a
    // gentle descent (about 5 %), slower the steeper it gets either way.
    factor: (slope: number) => Math.exp(-3.5 * Math.abs(slope + 0.05)) / Math.exp(-3.5 * 0.05),
  },
  running: {
    name: 'Running',
    flat: 12,
    // Same effort as on the flat: speed follows the energy cost of running on a slope
    // (Minetti et al. 2002). Gentle descents are faster, steep ones slower again.
    factor: (slope: number) => {
      const i = Math.min(0.45, Math.max(-0.45, slope));
      const cost = 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
      return Math.min(1.25, 3.6 / cost);
    },
  },
  skitouring: {
    name: 'Ski touring',
    flat: 4,
    // Skinning up: as hiking, but never more than about 400 m of climb per hour (at 4 km/h flat speed).
    // Skiing down: several times faster, most on moderate slopes, held back on very steep ones.
    factor: (slope: number) => {
      if (slope >= -0.03) return Math.min(Math.exp(-3.5 * slope), slope > 0 ? 0.1 / slope : Infinity);
      const steepness = -slope;
      return steepness < 0.35 ? 1 + 12 * steepness : Math.max(2, 5.2 - 8 * (steepness - 0.35));
    },
  },
} as const;
type Mode = keyof typeof MODES;
const SPEED_KEY = 'terrain-viewer.planner.speeds';
const RAD = Math.PI / 180;

function metres(a: Point, b: Point): number {
  const s = Math.sin(((b[1] - a[1]) * RAD) / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(((b[0] - a[0]) * RAD) / 2) ** 2;
  return 2 * 6371008 * Math.asin(Math.sqrt(s));
}
const lengthOf = (coords: Point[]) => coords.reduce((sum, c, i) => (i ? sum + metres(coords[i - 1], c) : 0), 0);

/** A path between two points along OpenStreetMap trails, or null unless both lie within `reach` metres of one. */
async function routed(a: Point, b: Point, reach: number): Promise<Point[] | null> {
  try {
    const response = await fetch(`${ROUTER}?lonlats=${a.join(',')}|${b.join(',')}&profile=${PROFILE}&alternativeidx=0&format=geojson`);
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
    return null;
  }
}

export interface PlannerOptions {
  /** Route lines currently drawn on the map (SAC routes): legs follow these before anything else. */
  network: () => Point[][];
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
  private hover = new maplibregl.Marker({ element: h('div', { class: 'plan-hover' }) });
  private profile: { coords: Point[]; distance: number[]; height: number[] } | null = null;
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
  private gradient = false;

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
    const gradientBox = h('input', {
      type: 'checkbox',
      onchange: () => {
        this.gradient = gradientBox.checked;
        this.render();
      },
    });
    this.root.append(
      h(
        'div',
        { class: 'plan-bar' },
        this.nameInput,
        h('label', { class: 'plan-snap edit', title: 'Legs follow the SAC routes shown on the map, or hiking paths, when you click on one; clicks beside a path run straight' }, snapBox, 'Follow paths'),
        h('label', { class: 'plan-snap' }, modeSelect, speedInput, 'km/h'),
        h('label', { class: 'plan-snap', title: 'Colour the profile and the route on the map by slope: blue downhill, green flat, red uphill' }, gradientBox, 'Gradient'),
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
    this.chart.addEventListener('mousedown', (event) => this.onChartDown(event));
    this.chart.addEventListener('mousedown', (event) => this.onChartPan(event));
    this.chart.addEventListener('auxclick', (event) => event.preventDefault()); // no paste / autoscroll on middle click
    this.chart.addEventListener('wheel', (event) => this.onChartWheel(event), { passive: false });
    this.chart.addEventListener('dblclick', () => {
      if (!this.zoom) return;
      this.zoom = null;
      this.render();
    });
    this.chart.addEventListener('mousemove', (event) => this.onChartHover(event));
    this.chart.addEventListener('mouseleave', () => this.hover.remove());
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
    if (this.readonly) this.link(null);
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
    if (fresh) this.link(null);
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
  view(name: string, coords: Point[], trackId: string | null = null): void {
    this.link(trackId);
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
    const coords = this.coords();
    if (coords.length > 1) this.load(this.nameInput.value, coords, this.trackId);
  }

  private readonly = false;
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
    // Evenly spaced samples, so straight legs get heights along their whole length too.
    const coords: Point[] = [line[0]];
    const distance: number[] = [0];
    let total = 0;
    for (let i = 1; i < line.length; i++) {
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
      if (token !== this.profileToken) return;
      this.profile = { coords, distance, height };
      this.selection = null;
      this.zoom = null;
    } catch (error) {
      if (token !== this.profileToken) return;
      this.profile = { coords, distance, height: [] };
      toast(`Elevation profile unavailable: ${(error as Error).message}`);
    }
    this.render();
  }

  /** Totals for the part of the profile between two sample indices. */
  private summarise(from: number, to: number): { distance: number; up: number; down: number; lowest: number; highest: number; hours: number } {
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
    return { distance, up, down, lowest, highest, hours };
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
    ];
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
      window.removeEventListener('mousemove', move);
      this.chart.style.cursor = '';
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up, { once: true });
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
    const move = (e: MouseEvent) => {
      if (Math.abs(e.clientX - event.clientX) > 3) moved = true;
      if (!moved) return;
      const other = at(e);
      this.select({ from: Math.min(fixed, other), to: Math.max(fixed, other) });
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      if (!moved) this.select(null);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up, { once: true });
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
      if (!this.gradient) continue;
      let d = `M${x(p.distance[i]).toFixed(1)},${height}`;
      for (let k = i; k <= j; k++) d += `L${point(k)}`;
      area += `<path d="${d}L${x(p.distance[j]).toFixed(1)},${height}Z" fill="${colour}" fill-opacity="0.85"/>`;
      pieces.push({ type: 'Feature', properties: { colour }, geometry: { type: 'LineString', coordinates: p.coords.slice(i, j + 1) } });
    }
    (this.map.getSource(GRADE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: pieces });

    // Snow along the route, from the snow map shown on the map: the area under the curve takes the
    // map's colours, grey where there is no snow (or no data). The gradient colouring, if on, wins.
    const snow = this.options.snow();
    this.snow = [];
    let snowArea = '';
    if (snow) {
      const colourAt = (i: number) => {
        const hit = snow.at(p.coords[i][0], p.coords[i][1]);
        this.snow[i] = hit ? hit.value : null;
        return hit && !(snow.unit === 'cm' && hit.value <= 0) ? hit.colour : '#9aa3ad';
      };
      let from = 0;
      let current = colourAt(0);
      for (let i = 1; i < p.coords.length; i++) {
        const colour = colourAt(i);
        if (colour === current && i < p.coords.length - 1) continue;
        // One piece per run of equal colour, from the curve down to the axis.
        let d = `M${x(p.distance[from]).toFixed(1)},${height}`;
        for (let k = from; k <= i; k++) d += `L${point(k)}`;
        snowArea += `<path d="${d}L${x(p.distance[i]).toFixed(1)},${height}Z" fill="${current}" fill-opacity="0.9"/>`;
        from = i;
        current = colour;
      }
    }
    const coloured = this.gradient ? area : snowArea;

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
      h('span', { class: 'plan-readout' }),
    );
    if (snow && !this.gradient) this.chart.append(h('span', { class: 'plan-snow-label', title: 'From the snow map shown on the map; grey: no snow or no data' }, `${snow.name} (${snow.unit})`));
    if (this.gradient) {
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
    const readout = this.chart.querySelector<HTMLElement>('.plan-readout')!;
    const slope = this.slopes[i] ?? 0;
    const sampler = this.options.snow();
    const snowValue = this.snow[i];
    const snowText = !sampler ? '' : snowValue === null || snowValue === undefined ? ' · snow: no data' : ` · snow ${Math.round(snowValue)} ${sampler.unit}`;
    readout.textContent = `${(p.distance[i] / 1000).toFixed(2)} km · ${Math.round(p.height[i])} m · ${slope >= 0 ? '+' : '−'}${Math.abs(Math.round(slope * 100))}%${snowText}`;
    readout.style.left = `${Math.min(88, Math.max(2, fraction * 100))}%`;
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
    const points = p.coords
      .map((c, i) => `      <trkpt lat="${c[1].toFixed(6)}" lon="${c[0].toFixed(6)}">${p.height.length ? `<ele>${p.height[i].toFixed(1)}</ele>` : ''}</trkpt>`)
      .join('\n');
    const gpx =
      `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="3D Terrain Viewer" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      `  <metadata><name>${escape(this.name())}</name></metadata>\n  <trk>\n    <name>${escape(this.name())}</name>\n    <trkseg>\n${points}\n    </trkseg>\n  </trk>\n</gpx>\n`;
    const link = h('a', { href: URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' })), download: `${this.name().replace(/[\\/:*?"<>|]+/g, '_')}.gpx` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  }
}

/**
 * Indices of control points for an imported track: where it bends (Douglas–Peucker), plus enough
 * in between that no stretch is very long, without drowning the map in markers.
 */
function controlPoints(coords: Point[]): number[] {
  const scale = Math.cos(coords[0][1] * RAD) * 111320;
  const xy = coords.map((c): [number, number] => [c[0] * scale, c[1] * 111320]);
  const MOST = 40;
  let tolerance = 60;
  let keep = simplify(coords, tolerance);
  while (keep.length > MOST) keep = simplify(coords, (tolerance *= 1.6));
  // Long straight stretches still get a point now and then.
  const along = [0];
  for (let i = 1; i < xy.length; i++) along.push(along[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const spacing = Math.max(1500, along[along.length - 1] / MOST);
  const result = [0];
  for (let k = 1; k < keep.length; k++) {
    let last = result[result.length - 1];
    for (let i = last + 1; i < keep[k]; i++) {
      if (along[i] - along[last] >= spacing && along[keep[k]] - along[i] >= spacing / 2) {
        result.push(i);
        last = i;
      }
    }
    result.push(keep[k]);
  }
  return result;
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
