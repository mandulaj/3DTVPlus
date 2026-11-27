// Keyboard: W/A/S/D move over the terrain, Q/E turn, R/F tilt (hold Shift to go faster),
// N puts north up, L switches look mode. The arrow keys keep MapLibre's own behaviour.
import type * as maplibregl from 'maplibre-gl';
import { isTyping } from './interaction';

const MOVE = 520; // pixels of map per second
const TURN = 70; // degrees per second
const TILT = 45;
const HELD = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'KeyR', 'KeyF'];

export function enableKeys(map: maplibregl.Map, actions: { toggleLookMode: () => void }): void {
  const down = new Set<string>();
  let fast = false;
  let last = 0;
  let running = false;

  function frame(now: number): void {
    if (!down.size) {
      running = false;
      return;
    }
    const dt = Math.min(0.05, (now - last) / 1000) * (fast ? 3 : 1);
    last = now;
    const axis = (plus: string, minus: string) => Number(down.has(plus)) - Number(down.has(minus));
    const forward = axis('KeyW', 'KeyS');
    const right = axis('KeyD', 'KeyA');
    const { clientWidth: width, clientHeight: height } = map.getCanvas();
    const options: maplibregl.JumpToOptions = {};
    // The point that should come to the screen centre. Steeply tilted, "up the screen" is far away: go gently.
    if (forward || right) options.center = map.unproject([width / 2 + right * MOVE * dt, height / 2 - forward * MOVE * dt * Math.cos((map.getPitch() * Math.PI) / 180) ** 0.5]);
    const turn = axis('KeyE', 'KeyQ');
    if (turn) options.bearing = map.getBearing() + turn * TURN * dt;
    const tilt = axis('KeyF', 'KeyR');
    if (tilt) options.pitch = Math.min(map.getMaxPitch(), Math.max(0, map.getPitch() + tilt * TILT * dt));
    map.jumpTo(options);
    requestAnimationFrame(frame);
  }

  window.addEventListener('keydown', (event) => {
    fast = event.shiftKey;
    if (event.ctrlKey || event.metaKey || event.altKey || isTyping(event.target)) return;
    if (HELD.includes(event.code)) {
      event.preventDefault();
      down.add(event.code);
      if (!running) {
        running = true;
        last = performance.now();
        map.stop();
        requestAnimationFrame(frame);
      }
    } else if (event.code === 'KeyN' && !event.repeat) {
      map.easeTo({ bearing: 0, duration: 500 });
    } else if (event.code === 'KeyL' && !event.repeat) {
      actions.toggleLookMode();
    }
  });
  window.addEventListener('keyup', (event) => {
    fast = event.shiftKey;
    down.delete(event.code);
  });
  // Keys released while the window is elsewhere never report it.
  window.addEventListener('blur', () => down.clear());
}
