// One-click layer combinations. Ids refer to catalog.ts and the SLF layers.
import type { SacDiscipline } from './sac';
import type { SnowProduct, StationType } from './slf';

export interface Preset {
  id: string;
  name: string;
  base: string;
  overlays: { id: string; opacity?: number }[];
  /** SAC route portal disciplines to draw. */
  sac?: SacDiscipline[];
  /** Stored route collections to draw (ids from routeSources.ts). */
  routes?: string[];
  /** Mountain huts (refuges.info). */
  huts?: boolean;
  /** Menu section the preset belongs to: opened when it is applied. */
  topic?: string;
  slf?: { snow?: SnowProduct; snowOpacity?: number; bulletin?: boolean; bulletinOpacity?: number; stations?: StationType; avalanches?: boolean };
}

/** A preset switches on everything that belongs to its activity, and everything else off. */
export const PRESETS: Preset[] = [
  {
    id: 'ski-touring-ch',
    name: '⛷️ Ski touring',
    base: 'ch-map-winter',
    overlays: [{ id: 'ch-slope30', opacity: 0.25 }, { id: 'ch-wildlife' }, { id: 'ch-skitouren' }],
    sac: ['ski_tour'],
    routes: ['stg-ch', 'stg-at', 'stg-fr', 'c2c'],
    huts: true,
    topic: 'ski',
    slf: { snow: 'hs', snowOpacity: 0.5, bulletin: true, bulletinOpacity: 0.15 },
  },
  {
    id: 'snowshoe-ch',
    name: '❄️ Snowshoe',
    base: 'ch-map-winter',
    overlays: [{ id: 'ch-slope30', opacity: 0.5 }, { id: 'ch-wildlife' }, { id: 'ch-snowshoe' }],
    sac: ['snowshoe_tour'],
    routes: ['ch-snowshoe'],
    topic: 'ski',
    slf: { snow: 'hs', snowOpacity: 0.4, bulletin: true, bulletinOpacity: 0.15 },
  },
  {
    id: 'avalanche-terrain-ch',
    name: '⚠️ Avalanche terrain',
    base: 'ch-map-winter',
    overlays: [{ id: 'ch-slope-classes', opacity: 0.6 }, { id: 'ch-protect-forest' }],
    topic: 'snow',
    slf: { bulletin: true, avalanches: true },
  },
  {
    id: 'snow-conditions-ch',
    name: '🌨️ Snow conditions',
    base: 'ch-map-grey',
    overlays: [],
    topic: 'snow',
    slf: { snow: 'hs', stations: 'SNOW_HEIGHT', bulletin: true },
  },
  { id: 'mountaineering-ch', name: '🧗 Mountaineering', base: 'ch-map', overlays: [{ id: 'ch-hiking' }], sac: ['mountain_hiking', 'alpine_tour', 'via_ferrata', 'climbing'], huts: true, topic: 'hiking' },
  { id: 'hiking-ch', name: '🥾 Hiking', base: 'ch-map', overlays: [{ id: 'ch-hiking' }, { id: 'ch-wanderland' }, { id: 'wmt-hiking', opacity: 0.7 }], sac: ['mountain_hiking'], huts: true, topic: 'hiking' },
  { id: 'biking-ch', name: '🚲 Biking', base: 'ch-map', overlays: [{ id: 'ch-veloland' }, { id: 'ch-mtbland' }, { id: 'wmt-cycling', opacity: 0.7 }, { id: 'wmt-mtb', opacity: 0.7 }], topic: 'cycling' },
  { id: 'pistes', name: '🎿 Ski pistes (worldwide)', base: 'opentopo', overlays: [{ id: 'osm-pistes' }], topic: 'ski' },
  { id: 'aerial-ch', name: '🛰️ Aerial CH', base: 'ch-ortho', overlays: [] },
  { id: 'historic-photos-ch', name: '🕰️ Historic photos CH (1946)', base: 'ch-map', overlays: [{ id: 'ch-photos' }], topic: 'more' },
];
