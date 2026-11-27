// Sun disc rendered directly inside MapLibre's WebGL pass with depth testing so 3D mountain
// ridges naturally occlude and partially eclipse the sun at 60 fps with zero GPU readbacks.
import type * as maplibregl from 'maplibre-gl';

const RAD = Math.PI / 180;
const MIN_ZOOM = 4; // on the far-out globe "sky at the map centre" has no meaning
const LAYER_ID = 'sun-disc-webgl';

const VERT = `
attribute vec2 a_pos;
varying vec2 v_uv;
uniform vec2 u_center;
uniform vec2 u_radius;
void main() {
  v_uv = a_pos;
  // Place on the far clip plane (z = 0.99999) so terrain depth naturally eclipses the sun.
  gl_Position = vec4(u_center + a_pos * u_radius, 0.99999, 1.0);
}
`;

const FRAG = `
precision mediump float;
varying vec2 v_uv;
uniform vec3 u_core;
uniform vec3 u_glow;
uniform float u_alpha;
void main() {
  float r = length(v_uv);
  if (r > 1.0) discard;
  float core = 1.0 - smoothstep(0.14, 0.24, r);
  float halo = pow(max(0.0, 1.0 - r), 2.4) * 0.65;
  float a = clamp(core + halo, 0.0, 1.0) * u_alpha;
  vec3 col = mix(u_glow, u_core, clamp(core * 1.4, 0.0, 1.0));
  gl_FragColor = vec4(col * a, a);
}
`;

export class SunDisc {
  private azimuth = 0;
  private altitude = -90;
  private active = false;
  private added = false;

  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private aPos = -1;
  private uCenter: WebGLUniformLocation | null = null;
  private uRadius: WebGLUniformLocation | null = null;
  private uCore: WebGLUniformLocation | null = null;
  private uGlow: WebGLUniformLocation | null = null;
  private uAlpha: WebGLUniformLocation | null = null;

  constructor(private map: maplibregl.Map) {}

  /** Sun direction in degrees: azimuth clockwise from north, altitude above the horizon. */
  set(azimuth: number, altitude: number): void {
    this.azimuth = azimuth;
    this.altitude = altitude;
    this.active = true;
    this.ensureLayer();
    this.map.triggerRepaint();
  }

  hide(): void {
    this.active = false;
    this.map.triggerRepaint();
  }

  private ensureLayer(): void {
    if (this.added && this.map.getLayer(LAYER_ID)) return;
    this.added = true;
    const layer: maplibregl.CustomLayerInterface = {
      id: LAYER_ID,
      type: 'custom',
      renderingMode: '3d',
      onAdd: (_map, gl) => {
        const vs = gl.createShader(gl.VERTEX_SHADER)!;
        gl.shaderSource(vs, VERT);
        gl.compileShader(vs);
        const fs = gl.createShader(gl.FRAGMENT_SHADER)!;
        gl.shaderSource(fs, FRAG);
        gl.compileShader(fs);
        const program = gl.createProgram()!;
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        this.program = program;
        this.aPos = gl.getAttribLocation(program, 'a_pos');
        this.uCenter = gl.getUniformLocation(program, 'u_center');
        this.uRadius = gl.getUniformLocation(program, 'u_radius');
        this.uCore = gl.getUniformLocation(program, 'u_core');
        this.uGlow = gl.getUniformLocation(program, 'u_glow');
        this.uAlpha = gl.getUniformLocation(program, 'u_alpha');

        this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      },
      render: (gl) => {
        if (!this.active || !this.program || !this.buffer) return;
        const map = this.map;
        if (map.getZoom() < MIN_ZOOM || this.altitude < -2) return;

        const { clientWidth: width, clientHeight: height } = map.getCanvas();
        if (!width || !height) return;
        const bearing = map.getBearing() * RAD;
        const pitch = map.getPitch() * RAD;
        const az = this.azimuth * RAD;
        const alt = this.altitude * RAD;

        const sun = [Math.sin(az) * Math.cos(alt), Math.cos(az) * Math.cos(alt), Math.sin(alt)];
        const forward = [Math.sin(bearing) * Math.sin(pitch), Math.cos(bearing) * Math.sin(pitch), -Math.cos(pitch)];
        const right = [Math.cos(bearing), -Math.sin(bearing), 0];
        const up = [Math.sin(bearing) * Math.cos(pitch), Math.cos(bearing) * Math.cos(pitch), Math.sin(pitch)];
        const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        const depth = dot(sun, forward);
        if (depth <= 0.05) return;

        const focal = height / 2 / Math.tan((map.getVerticalFieldOfView() * RAD) / 2);
        const sx = width / 2 + (focal * dot(sun, right)) / depth;
        const sy = height / 2 - (focal * dot(sun, up)) / depth;
        const quadPx = Math.max(48, focal * Math.tan(4.8 * RAD));
        if (sx < -quadPx || sx > width + quadPx || sy < -quadPx || sy > height + quadPx) return;

        const ndcX = (sx / width) * 2 - 1;
        const ndcY = 1 - (sy / height) * 2;
        const rx = (quadPx / width) * 2;
        const ry = (quadPx / height) * 2;

        // Low sun shifts into warm golden-orange / deep crimson.
        const low = Math.min(1, Math.max(0, 1 - this.altitude / 15));
        const fade = Math.min(1, Math.max(0, (this.altitude + 1.8) / 2.2));
        const coreR = 1.0;
        const coreG = (252 - 90 * low) / 255;
        const coreB = (232 - 175 * low) / 255;
        const glowR = 1.0;
        const glowG = (210 - 105 * low) / 255;
        const glowB = (135 - 105 * low) / 255;

        const prevDepthTest = gl.isEnabled(gl.DEPTH_TEST);
        const prevDepthMask = gl.getParameter(gl.DEPTH_WRITEMASK);
        const prevDepthFunc = gl.getParameter(gl.DEPTH_FUNC);
        const prevBlend = gl.isEnabled(gl.BLEND);

        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(false);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

        gl.useProgram(this.program);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.enableVertexAttribArray(this.aPos);
        gl.vertexAttribPointer(this.aPos, 2, gl.FLOAT, false, 0, 0);
        gl.uniform2f(this.uCenter, ndcX, ndcY);
        gl.uniform2f(this.uRadius, rx, ry);
        gl.uniform3f(this.uCore, coreR, coreG, coreB);
        gl.uniform3f(this.uGlow, glowR, glowG, glowB);
        gl.uniform1f(this.uAlpha, fade);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        gl.depthMask(prevDepthMask);
        gl.depthFunc(prevDepthFunc);
        if (!prevDepthTest) gl.disable(gl.DEPTH_TEST);
        if (!prevBlend) gl.disable(gl.BLEND);
      },
      onRemove: (_map, gl) => {
        if (this.program) gl.deleteProgram(this.program);
        if (this.buffer) gl.deleteBuffer(this.buffer);
        this.program = null;
        this.buffer = null;
        this.added = false;
      },
    };
    this.map.addLayer(layer);
  }
}
