// Sun disc drawn in the sky: a DOM element positioned where the sun's direction
// falls on screen for the current camera.
import type * as maplibregl from 'maplibre-gl';

const RAD = Math.PI / 180;
const MIN_ZOOM = 4; // on the far-out globe "sky at the map centre" has no meaning

export class SunDisc {
  private element: HTMLDivElement;
  private azimuth = 0;
  private altitude = -90;
  private active = false;
  private occluded = false;
  private x = 0;
  private y = 0;

  constructor(private map: maplibregl.Map) {
    this.element = document.createElement('div');
    this.element.className = 'sun-disc';
    this.element.style.display = 'none';
    map.getCanvasContainer().appendChild(this.element);
    map.on('move', () => this.place());
    map.on('resize', () => this.place());
    // Reading terrain under a pixel stalls the GPU: only when the view has settled.
    map.on('idle', () => this.checkOcclusion());
  }

  /** Sun direction in degrees: azimuth clockwise from north, altitude above the horizon. */
  set(azimuth: number, altitude: number): void {
    this.azimuth = azimuth;
    this.altitude = altitude;
    this.active = true;
    this.place();
    this.checkOcclusion();
  }

  hide(): void {
    this.active = false;
    this.element.style.display = 'none';
  }

  private place(): void {
    if (!this.active) return;
    const map = this.map;
    const { clientWidth: width, clientHeight: height } = map.getCanvas();
    const bearing = map.getBearing() * RAD;
    const pitch = map.getPitch() * RAD;
    const az = this.azimuth * RAD;
    const alt = this.altitude * RAD;

    // Local east/north/up frame at the map centre.
    const sun = [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)];
    const forward = [Math.sin(bearing) * Math.sin(pitch), Math.cos(bearing) * Math.sin(pitch), -Math.cos(pitch)];
    const right = [Math.cos(bearing), -Math.sin(bearing), 0];
    const up = [Math.sin(bearing) * Math.cos(pitch), Math.cos(bearing) * Math.cos(pitch), Math.sin(pitch)];
    const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const depth = dot(sun, forward);

    const focal = height / 2 / Math.tan((map.getVerticalFieldOfView() * RAD) / 2);
    this.x = width / 2 + (focal * dot(sun, right)) / depth;
    this.y = height / 2 - (focal * dot(sun, up)) / depth;
    const margin = 150;
    const visible =
      depth > 0.05 && this.altitude > -1.5 && map.getZoom() >= MIN_ZOOM &&
      this.x > -margin && this.x < width + margin && this.y > -margin && this.y < height + margin;

    const style = this.element.style;
    style.display = visible ? '' : 'none';
    if (!visible) return;
    style.transform = `translate(${this.x}px, ${this.y}px)`;
    // One degree of sky in pixels: the disc is drawn about three times its true 0.53° so it reads clearly.
    const size = Math.max(14, focal * Math.tan(1.6 * RAD));
    style.setProperty('--size', `${size}px`);
    // Low sun is redder and dimmer.
    const low = Math.min(1, Math.max(0, 1 - this.altitude / 15));
    style.setProperty('--core', `rgb(255, ${Math.round(250 - 70 * low)}, ${Math.round(225 - 150 * low)})`);
    style.setProperty('--glow', `rgba(255, ${Math.round(225 - 85 * low)}, ${Math.round(150 - 110 * low)}, 0.55)`);
    style.opacity = this.occluded ? '0' : '1';
  }

  /** Hide the disc when terrain covers its position on screen. */
  private checkOcclusion(): void {
    if (!this.active || this.element.style.display === 'none') return;
    let hit = false;
    try {
      const terrain = this.map.terrain as unknown as { pointCoordinate?: (p: { x: number; y: number }) => unknown } | null;
      const { clientWidth: width, clientHeight: height } = this.map.getCanvas();
      if (terrain?.pointCoordinate && this.x >= 0 && this.y >= 0 && this.x < width && this.y < height) {
        hit = terrain.pointCoordinate({ x: this.x, y: this.y }) != null;
      }
    } catch {
      hit = false; // internal API: if it changes, the disc simply stays visible
    }
    if (hit !== this.occluded) {
      this.occluded = hit;
      this.element.style.opacity = hit ? '0' : '1';
    }
  }
}
