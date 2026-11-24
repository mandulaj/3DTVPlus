// Sunlight mode: sun position drives relief shading, sky colour, cast shadows and the night side.
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource, RasterTileSource } from 'maplibre-gl';
import * as SunCalc from 'suncalc';
import { SLOT } from '../map';
import { registerShadowProtocol, shadowStats } from './shadowProtocol';
import { SunDisc } from './sunDisc';
import { nightPolygon } from './terminator';

const SHADOW_SOURCE = 'sun-shadow';
const NIGHT_SOURCE = 'sun-night';
const SHADOW_MIN_ZOOM = 7;
const SHADOW_MAX_ZOOM = 15;

export interface SunInfo {
  azimuth: number; // degrees clockwise from north
  altitude: number; // degrees above horizon
  sunrise: Date | null;
  sunset: Date | null;
}

type RGB = [number, number, number];
const mix = (a: RGB, b: RGB, t: number): string => {
  const k = Math.min(1, Math.max(0, t));
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * k)).join(',')})`;
};
const SKY = { day: [91, 155, 217] as RGB, dusk: [56, 76, 128] as RGB, night: [8, 12, 30] as RGB };
const HORIZON = { day: [223, 234, 242] as RGB, dusk: [245, 170, 100] as RGB, night: [22, 30, 56] as RGB };

export class SunController {
  /** Shadow tile count and total compute time, for diagnostics. */
  readonly stats = shadowStats;
  enabled = false;
  time = new Date();
  shadowOpacity = 0.75;
  onUpdate: (info: SunInfo) => void = () => {};

  private registered = false;
  private busy = false;
  private dirty = false;
  private lastSet = 0;
  private timer: number | undefined;
  private shownToken = -1;
  private disc: SunDisc;
  private applied = { azimuth: NaN, altitude: NaN };

  constructor(private map: maplibregl.Map) {
    this.disc = new SunDisc(map);
    map.on('moveend', () => {
      if (this.enabled) this.applyCheap(false);
    });
    map.on('sourcedata', (e) => {
      if (e.sourceId === SHADOW_SOURCE && this.busy && map.isSourceLoaded(SHADOW_SOURCE)) {
        this.busy = false;
        this.pump();
      }
    });
  }

  info(): SunInfo {
    const { lng, lat } = this.map.getCenter();
    const pos = SunCalc.getPosition(this.time, lat, lng);
    const times = SunCalc.getTimes(this.time, lat, lng);
    // suncalc 2: degrees, azimuth clockwise from north, altitude refraction-corrected
    return { azimuth: pos.azimuth, altitude: pos.altitude, sunrise: times.sunrise, sunset: times.sunset };
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.ensureLayers();
    for (const id of [SHADOW_SOURCE, NIGHT_SOURCE]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    }
    if (on) {
      this.applyCheap();
      this.requestShadows();
    } else {
      this.applied = { azimuth: NaN, altitude: NaN };
      this.resetRelief();
      this.disc.hide();
    }
  }

  setTime(time: Date): void {
    this.time = time;
    if (!this.enabled) return;
    this.applyCheap();
    this.requestShadows();
  }

  setShadowOpacity(opacity: number): void {
    this.shadowOpacity = opacity;
    if (this.map.getLayer(SHADOW_SOURCE)) this.map.setPaintProperty(SHADOW_SOURCE, 'raster-opacity', this.opacityExpression());
  }

  private opacityExpression() {
    return ['interpolate', ['linear'], ['zoom'], SHADOW_MIN_ZOOM, 0, SHADOW_MIN_ZOOM + 1, this.shadowOpacity] as never;
  }

  private tileUrl(): string {
    return `shadow://{z}/{x}/{y}?t=${this.token()}`;
  }

  /** Shadows are recomputed per whole minute. */
  private token(): number {
    return Math.floor(this.time.getTime() / 60000) * 60000;
  }

  private ensureLayers(): void {
    if (!this.registered) {
      registerShadowProtocol();
      this.registered = true;
    }
    if (!this.map.getSource(NIGHT_SOURCE)) {
      this.map.addSource(NIGHT_SOURCE, { type: 'geojson', data: nightPolygon(this.time) });
      this.map.addLayer(
        {
          id: NIGHT_SOURCE,
          type: 'fill',
          source: NIGHT_SOURCE,
          maxzoom: SHADOW_MIN_ZOOM + 1, // fully faded out above: do not load or draw it there
          paint: {
            'fill-color': '#060a1e',
            // Hands over to per-pixel terrain shadows once those are available.
            'fill-opacity': ['interpolate', ['linear'], ['zoom'], SHADOW_MIN_ZOOM, 0.55, SHADOW_MIN_ZOOM + 1, 0],
            'fill-antialias': false,
          },
        },
        SLOT.shadow,
      );
    }
    if (!this.map.getSource(SHADOW_SOURCE)) {
      this.shownToken = this.token();
      this.map.addSource(SHADOW_SOURCE, {
        type: 'raster',
        tiles: [this.tileUrl()],
        tileSize: 512,
        minzoom: SHADOW_MIN_ZOOM,
        maxzoom: SHADOW_MAX_ZOOM,
      });
      this.map.addLayer(
        {
          id: SHADOW_SOURCE,
          type: 'raster',
          source: SHADOW_SOURCE,
          minzoom: SHADOW_MIN_ZOOM,
          paint: { 'raster-opacity': this.opacityExpression(), 'raster-fade-duration': 0 },
        },
        SLOT.shadow,
      );
      // Coarser shadow tiles toward the horizon than for map imagery (MapLibre's default is 9.3, 3;
      // a higher first value lets detail fall off faster with distance).
      this.map.setSourceTileLodParams(12, 2, SHADOW_SOURCE);
    }
  }

  /** Instant updates: relief shading direction, sky colour, night polygon. */
  private applyCheap(timeChanged = true): void {
    const info = this.info();
    const map = this.map;
    this.disc.set(info.azimuth, info.altitude);
    // The sun's direction also shifts as the map centre moves, but only slowly: skip style
    // updates (each forces the draped terrain to be redrawn) until it is noticeable.
    const moved = Math.abs(info.azimuth - this.applied.azimuth) > 0.5 || Math.abs(info.altitude - this.applied.altitude) > 0.25;
    if (!timeChanged && !moved) return;
    this.applied = { azimuth: info.azimuth, altitude: info.altitude };
    map.setPaintProperty('hillshade', 'hillshade-illumination-direction', info.azimuth);
    map.setPaintProperty('hillshade', 'hillshade-highlight-color', '#fff1cf'); // warm sunlit slopes

    // 1 = full day, 0 = sun on horizon, -1 = night (end of nautical twilight)
    const a = info.altitude;
    const sky = a >= 0 ? mix(SKY.dusk, SKY.day, a / 12) : mix(SKY.dusk, SKY.night, -a / 10);
    const horizon = a >= 0 ? mix(HORIZON.dusk, HORIZON.day, a / 12) : mix(HORIZON.dusk, HORIZON.night, -a / 10);
    map.setSky({ 'sky-color': sky, 'horizon-color': horizon, 'fog-color': horizon });

    if (timeChanged) (map.getSource(NIGHT_SOURCE) as GeoJSONSource | undefined)?.setData(nightPolygon(this.time));
    this.onUpdate(info);
  }

  /** Set by the app: turns the camera in place. */
  turnTo: (bearing: number, pitch: number) => void = (bearing, pitch) => this.map.jumpTo({ bearing, pitch: Math.min(pitch, this.map.getMaxPitch()) });

  /** Turn the camera toward the sun, aiming a little below it so the sun sits in the upper part of the view. */
  lookAtSun(): void {
    const info = this.info();
    this.turnTo(info.azimuth, 90 + info.altitude - 9);
  }

  private resetRelief(): void {
    const map = this.map;
    map.setPaintProperty('hillshade', 'hillshade-illumination-direction', 315);
    map.setPaintProperty('hillshade', 'hillshade-highlight-color', '#ffffff');
    map.setSky({ 'sky-color': mix(SKY.day, SKY.day, 0), 'horizon-color': mix(HORIZON.day, HORIZON.day, 0), 'fog-color': mix(HORIZON.day, HORIZON.day, 0) });
  }

  /** Throttled: a new set of shadow tiles is requested only once the previous set has arrived. */
  private requestShadows(): void {
    this.dirty = true;
    this.pump();
  }

  private pump(): void {
    if (!this.dirty || !this.enabled) return;
    const now = performance.now();
    if (this.busy && now - this.lastSet < 2500) {
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.pump(), 300);
      return;
    }
    this.dirty = false;
    const token = this.token();
    if (token === this.shownToken) return;
    this.shownToken = token;
    this.lastSet = now;
    this.busy = true;
    (this.map.getSource(SHADOW_SOURCE) as RasterTileSource | undefined)?.setTiles([this.tileUrl()]);
  }
}
