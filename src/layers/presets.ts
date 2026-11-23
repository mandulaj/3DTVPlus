// One-click layer combinations. Ids refer to catalog.ts and the SLF layers.
import type { SnowProduct, StationType } from './slf';

export interface Preset {
  id: string;
  name: string;
  base: string;
  overlays: { id: string; opacity?: number }[];
  slf?: { snow?: SnowProduct; bulletin?: boolean; stations?: StationType; avalanches?: boolean };
}

export const PRESETS: Preset[] = [
  {
    id: 'ski-touring-ch',
    name: 'Ski touring CH',
    base: 'ch-map-winter',
    overlays: [{ id: 'ch-slope30', opacity: 0.5 }, { id: 'ch-wildlife' }, { id: 'ch-skitouren' }],
    slf: { bulletin: true },
  },
  {
    id: 'snowshoe-ch',
    name: 'Snowshoe CH',
    base: 'ch-map-winter',
    overlays: [{ id: 'ch-slope30', opacity: 0.5 }, { id: 'ch-wildlife' }, { id: 'ch-snowshoe' }],
    slf: { bulletin: true },
  },
  {
    id: 'avalanche-terrain-ch',
    name: 'Avalanche terrain CH',
    base: 'ch-map-winter',
    overlays: [{ id: 'ch-slope-classes', opacity: 0.6 }, { id: 'ch-protect-forest' }],
    slf: { bulletin: true, avalanches: true },
  },
  {
    id: 'snow-conditions-ch',
    name: 'Snow conditions CH',
    base: 'ch-map-grey',
    overlays: [],
    slf: { snow: 'hs', stations: 'SNOW_HEIGHT', bulletin: true },
  },
  { id: 'hiking-ch', name: 'Hiking CH', base: 'ch-map', overlays: [{ id: 'ch-hiking' }] },
  { id: 'biking-ch', name: 'Biking CH', base: 'ch-map', overlays: [{ id: 'ch-veloland' }, { id: 'ch-mtbland' }] },
  { id: 'pistes', name: 'Ski pistes (worldwide)', base: 'opentopo', overlays: [{ id: 'osm-pistes' }] },
  { id: 'aerial-ch', name: 'Aerial CH', base: 'ch-ortho', overlays: [] },
];
