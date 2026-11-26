// Glacier outlines of the Alps in 2015 (Paul et al., Sentinel-2 inventory, CC BY 4.0), from the
// copy made by scripts/fetch-glaciers.mjs.
import type * as maplibregl from 'maplibre-gl';
import { SLOT } from '../map';
import { toast } from '../ui/dom';

const DATA = './data/glaciers/alps-2015.json';
const SOURCE = 'glaciers-2015';
const LAYERS = [SOURCE, `${SOURCE}-line`];

export class Glaciers {
  enabled = false;
  private added = false;

  constructor(private map: maplibregl.Map) {}

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.added) {
      this.added = true;
      // The map fetches the file itself; a missing file shows as a map error.
      const failed = (event: { sourceId?: string }) => {
        if (event.sourceId !== SOURCE) return;
        this.map.off('error', failed as never);
        toast('Glacier outlines could not be loaded (they are stored next to the page: not available when it is opened as a single file).');
      };
      this.map.on('error', failed as never);
      this.map.addSource(SOURCE, { type: 'geojson', data: DATA, attribution: 'Glaciers 2015: <a href="https://doi.org/10.1594/PANGAEA.909133" target="_blank">Paul et al.</a>, CC BY 4.0' });
      this.map.addLayer({ id: LAYERS[0], type: 'fill', source: SOURCE, paint: { 'fill-color': '#7fd3f7', 'fill-opacity': 0.45 } }, SLOT.top);
      this.map.addLayer({ id: LAYERS[1], type: 'line', source: SOURCE, paint: { 'line-color': '#0b7fb8', 'line-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 13, 1.8] } }, SLOT.top);
    }
    for (const id of LAYERS) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }
}
