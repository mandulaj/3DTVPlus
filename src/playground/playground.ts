// Playground: paint snow on a mountainside and let it go. A toy for seeing how terrain steers a
// flow (src/playground/flow.ts); nothing here says anything about real avalanche danger.
import type * as maplibregl from 'maplibre-gl';
import type { ImageSource } from 'maplibre-gl';
import { heightGrid } from '../elevation';
import { interaction } from '../interaction';
import { SLOT } from '../map';
import { Glaciers } from './glaciers';
import { h, info, slider, toast } from '../ui/dom';
import type { FlowGrid } from './flow';
import type { FlowFrame, FlowMessage } from './flow.worker';
import FlowWorker from './flow.worker?worker&inline';

const CELL = 10; // metres
const SIZE = 420; // cells each way: a 4.2 km square around the first brush stroke
const SOURCE = 'playground-snow';
const STROKE = 0.5; // metres of snow added per pass of the brush
const MAX_DEPTH = 4;

interface Area {
  west: number;
  south: number;
  east: number;
  north: number;
  grid: FlowGrid;
}

export class Playground {
  readonly element: HTMLDetailsElement;
  private area: Area | null = null;
  private loading: Promise<Area | null> | null = null;
  private snow: Float32Array = new Float32Array(SIZE * SIZE);
  private painting = false;
  private brush = 60; // metres radius
  private mu = 0.25;
  private worker: Worker | null = null;
  private running = false;
  private paintButton: HTMLButtonElement;
  private releaseButton: HTMLButtonElement;
  private status = h('div', { class: 'muted' }, 'Paint snow on a slope, then release it.');
  private canvas = document.createElement('canvas');
  private drawQueued = false;

  constructor(private map: maplibregl.Map) {
    this.canvas.width = SIZE;
    this.canvas.height = SIZE;
    this.paintButton = h('button', { type: 'button', class: 'plan-button', title: 'Drag on the map to lay down snow (the map does not move while this is on)', onclick: () => this.setPainting(!this.painting) }, '🖌 Paint snow');
    this.releaseButton = h('button', { type: 'button', class: 'plan-button', title: 'Let the painted snow slide', onclick: () => (this.running ? this.stop() : this.release()) }, '▶ Release');
    const glaciers = new Glaciers(map);
    const glacierBox = h('input', { type: 'checkbox', onchange: () => glaciers.setEnabled(glacierBox.checked) });
    const reset = h('button', { type: 'button', class: 'plan-button', onclick: () => this.reset() }, 'Clear');
    this.element = h(
      'details',
      { class: 'section' },
      h('summary', {}, 'Playground', info('Experiments. Avalanche toy: snow flows over the terrain as a thin layer with friction (a simple Voellmy model on 10 m elevation data, within a 4 km square around where you start painting). It shows how gullies, benches and valley floors steer and stop a flow. It is not a simulation of real avalanches and says nothing about danger.')),
      h(
        'div',
        { class: 'section-body' },
        h('div', { class: 'group-title' }, 'Avalanche toy'),
        h('div', { class: 'plan-row' }, this.paintButton, this.releaseButton, reset),
        h('label', { class: 'row' }, h('span', {}, 'Brush'), slider(this.brush, 20, 200, 10, (value) => (this.brush = value), 'Brush radius in metres')),
        h(
          'label',
          { class: 'row' },
          h('span', {}, 'Friction'),
          slider(this.mu, 0.1, 0.5, 0.01, (value) => {
            this.mu = value;
            this.worker?.postMessage({ type: 'params', params: this.params() } satisfies FlowMessage);
          }, 'Dry friction: higher stops the flow on steeper ground'),
        ),
        this.status,
        h('div', { class: 'group-title' }, 'Glaciers'),
        h('label', { class: 'row' }, glacierBox, h('span', {}, 'Glacier extent 2015'), info('Outlines of all glaciers of the Alps larger than 0.02 km², mapped from Sentinel-2 satellite pictures of 2015 (Paul et al., CC BY 4.0). Compare with the glaciers drawn on the map or seen on recent aerial pictures.')),
      ),
    );

    // Painting: the brush follows the pointer while a button or finger is down.
    const container = map.getCanvasContainer();
    let down = false;
    const at = (event: PointerEvent) => {
      const box = map.getCanvas().getBoundingClientRect();
      const lngLat = map.unproject([event.clientX - box.left, event.clientY - box.top]);
      void this.stroke(lngLat.lng, lngLat.lat);
    };
    container.addEventListener(
      'pointerdown',
      (event) => {
        if (!this.painting || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        down = true;
        at(event);
      },
      true,
    );
    window.addEventListener('pointermove', (event) => {
      if (down && this.painting) at(event);
    });
    window.addEventListener('pointerup', () => (down = false));
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && this.painting) this.setPainting(false);
    });
  }

  private params() {
    return { mu: this.mu, xi: 1500 };
  }

  private setPainting(on: boolean): void {
    if (on && interaction.drawing) return; // another tool has the clicks
    if (on && this.running) this.stop();
    this.painting = on;
    interaction.drawing = on;
    this.paintButton.classList.toggle('on', on);
    this.paintButton.textContent = on ? '✓ Done painting' : '🖌 Paint snow';
    this.map.getCanvas().style.cursor = on ? 'crosshair' : '';
    // The map stays put while painting.
    for (const handler of [this.map.dragPan, this.map.dragRotate, this.map.touchZoomRotate, this.map.doubleClickZoom]) on ? handler.disable() : handler.enable();
    if (on) this.status.textContent = this.area ? 'Drag on the map to add snow.' : 'Drag on a slope to add snow. The play area is the 4 km around your first stroke.';
  }

  /** The play area: fixed by the first stroke, with its terrain loaded once. */
  private ensureArea(lng: number, lat: number): Promise<Area | null> {
    if (this.area) return Promise.resolve(this.area);
    this.loading ??= (async () => {
      const half = (SIZE * CELL) / 2;
      const dLng = half / (111320 * Math.cos((lat * Math.PI) / 180));
      const dLat = half / 110540;
      const [west, east, south, north] = [lng - dLng, lng + dLng, lat - dLat, lat + dLat];
      this.status.textContent = 'Loading terrain…';
      try {
        const ground = await heightGrid(west, south, east, north, SIZE, SIZE);
        this.area = { west, south, east, north, grid: { width: SIZE, height: SIZE, cell: CELL, ground } };
        this.status.textContent = 'Drag on the map to add snow.';
        return this.area;
      } catch (error) {
        toast(`Playground: ${(error as Error).message}`);
        this.loading = null;
        return null;
      }
    })();
    return this.loading;
  }

  private async stroke(lng: number, lat: number): Promise<void> {
    const area = await this.ensureArea(lng, lat);
    if (!area || !this.painting) return;
    const cx = ((lng - area.west) / (area.east - area.west)) * SIZE;
    const cy = ((area.north - lat) / (area.north - area.south)) * SIZE;
    const r = this.brush / CELL;
    if (cx < -r || cy < -r || cx > SIZE + r || cy > SIZE + r) {
      this.status.textContent = 'Outside the play area (4 km around the first stroke). "Clear" starts a new one.';
      return;
    }
    for (let y = Math.max(1, Math.floor(cy - r)); y <= Math.min(SIZE - 2, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(1, Math.floor(cx - r)); x <= Math.min(SIZE - 2, Math.ceil(cx + r)); x++) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy) / r;
        if (d > 1) continue;
        const i = y * SIZE + x;
        // Soft-edged brush; a spot fills up to the brush's own depth, more with repeated passes.
        this.snow[i] = Math.min(MAX_DEPTH, this.snow[i] + STROKE * (1 - d * d) * 0.35);
      }
    }
    this.draw(this.snow, null);
  }

  private release(): void {
    if (!this.area || !this.snow.some((d) => d > 0.02)) {
      this.status.textContent = 'Paint some snow first.';
      return;
    }
    this.setPainting(false);
    this.worker ??= new FlowWorker();
    this.worker.onmessage = (event: MessageEvent<FlowFrame>) => {
      const frame = event.data;
      if (!this.running) return;
      this.draw(frame.depth, frame.speed, 0.01);
      this.status.textContent = `${frame.seconds.toFixed(0)} s · fastest ${Math.round(frame.fastest * 3.6)} km/h`;
      if (frame.final) {
        // Where it came to rest is the snow for the next release.
        this.snow = frame.final;
        this.running = false;
        this.releaseButton.textContent = '▶ Release';
        this.status.textContent = `Came to rest after ${frame.seconds.toFixed(0)} s.`;
      }
    };
    this.running = true;
    this.releaseButton.textContent = '■ Stop';
    this.worker.postMessage({ type: 'start', grid: this.area.grid, depth: this.snow, params: this.params() } satisfies FlowMessage);
  }

  private stop(): void {
    this.running = false;
    this.worker?.postMessage({ type: 'stop' } satisfies FlowMessage);
    this.releaseButton.textContent = '▶ Release';
    this.draw(this.snow, null); // back to the snow as painted
    this.status.textContent = 'Stopped: the snow is back where it was painted.';
  }

  private reset(): void {
    this.stop();
    this.setPainting(false);
    this.snow = new Float32Array(SIZE * SIZE);
    this.area = null;
    this.loading = null;
    if (this.map.getLayer(SOURCE)) this.map.removeLayer(SOURCE);
    if (this.map.getSource(SOURCE)) this.map.removeSource(SOURCE);
    this.status.textContent = 'Paint snow on a slope, then release it.';
  }

  /** Shows snow depths (in metres, or in `unit` metres per count) on the terrain; moving snow is tinted. */
  private draw(depth: ArrayLike<number>, speed: Uint8Array | null, unit = 1): void {
    const area = this.area;
    if (!area) return;
    const context = this.canvas.getContext('2d')!;
    const image = context.createImageData(SIZE, SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const d = depth[i] * unit;
      if (d < 0.02) continue;
      const moving = speed ? Math.min(1, speed[i] / 25) : 0;
      const o = i * 4;
      // Resting snow pale blue (white would vanish on a winter map); the faster it moves, the more orange.
      image.data[o] = 120 + 135 * moving;
      image.data[o + 1] = 190 - 60 * moving;
      image.data[o + 2] = 255 - 215 * moving;
      image.data[o + 3] = Math.min(245, 185 + d * 90);
    }
    context.putImageData(image, 0, 0);
    if (this.drawQueued) return;
    this.drawQueued = true;
    requestAnimationFrame(() => {
      this.drawQueued = false;
      const url = this.canvas.toDataURL('image/png');
      const coordinates: [[number, number], [number, number], [number, number], [number, number]] = [[area.west, area.north], [area.east, area.north], [area.east, area.south], [area.west, area.south]];
      const source = this.map.getSource(SOURCE) as ImageSource | undefined;
      if (source) source.updateImage({ url, coordinates });
      else {
        this.map.addSource(SOURCE, { type: 'image', url, coordinates });
        this.map.addLayer({ id: SOURCE, type: 'raster', source: SOURCE, paint: { 'raster-opacity': 0.95, 'raster-fade-duration': 0 } }, SLOT.top);
      }
    });
  }
}
