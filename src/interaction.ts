// Shared map interaction state: tool mode (explore / route / area), cursor ref-counting,
// and keyboard input guards.
import type * as maplibregl from 'maplibre-gl';

export type ToolMode = 'explore' | 'draw-route' | 'draw-area';

const NON_TEXT_INPUTS = new Set(['checkbox', 'radio', 'range', 'button', 'submit', 'reset', 'color', 'file']);

/** True when `target` is a text-entry control where single-letter map shortcuts should not fire. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return true;
  if (target instanceof HTMLInputElement) return !NON_TEXT_INPUTS.has(target.type.toLowerCase());
  return false;
}

class InteractionState {
  private _mode: ToolMode = 'explore';
  private hovered = new Set<string>();

  get mode(): ToolMode {
    return this._mode;
  }

  setMode(mode: ToolMode): void {
    this._mode = mode;
    if (mode !== 'explore') this.hovered.clear();
  }

  /** True while a route or analysis area is actively being drawn on the map. */
  get drawing(): boolean {
    return this._mode !== 'explore';
  }

  set drawing(on: boolean) {
    this.setMode(on ? 'draw-route' : 'explore');
  }

  /** Tracks hovered interactive layers so leaving one never clobbers crosshair or another layer's pointer. */
  setHover(map: maplibregl.Map, layerId: string, entering: boolean): void {
    if (entering) this.hovered.add(layerId);
    else this.hovered.delete(layerId);
    if (this.drawing) return;
    map.getCanvas().style.cursor = this.hovered.size > 0 ? 'pointer' : '';
  }
}

export const interaction = new InteractionState();
