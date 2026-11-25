// Filtering routes on the map by difficulty and by height gain.

/** Grade scales, easiest first. A grade may carry "+" or "-" (WS+, T4-). */
export const SCALES = {
  hiking: ['T1', 'T2', 'T3', 'T4', 'T5', 'T6'],
  alpine: ['L', 'WS', 'ZS', 'S', 'SS', 'AS', 'EX'], // SAC mountaineering and ski touring
  snowshoe: ['WT1', 'WT2', 'WT3', 'WT4', 'WT5', 'WT6'],
  ferrata: ['K1', 'K2', 'K3', 'K4', 'K5', 'K6'],
  french: ['F', 'PD', 'AD', 'D', 'TD', 'ED'], // Camptocamp's overall grade
} as const;
export type Scale = keyof typeof SCALES;

export interface RouteFilter {
  /** Index into the scale of the easiest and hardest grade wanted; null = no limit. */
  gradeMin: number | null;
  gradeMax: number | null;
  /** Metres of ascent. */
  upMin: number | null;
  upMax: number | null;
}

export const NO_FILTER: RouteFilter = { gradeMin: null, gradeMax: null, upMin: null, upMax: null };
export const filtersGrade = (f: RouteFilter) => f.gradeMin !== null || f.gradeMax !== null;
export const filtersClimb = (f: RouteFilter) => f.upMin !== null || f.upMax !== null;
export const isActive = (f: RouteFilter | undefined): f is RouteFilter => !!f && (filtersGrade(f) || filtersClimb(f));

/**
 * Where a grade sits on its scale: the grade's index, a third higher or lower for "+" and "-"
 * ("WS+" lies between WS and ZS). A span such as "K3-4" counts as its easier end. Null if the
 * text is not a grade of this scale.
 */
export function gradeRank(scale: Scale, text: string | null | undefined): number | null {
  if (!text) return null;
  const grade = text.trim().toUpperCase();
  // Longest name first: "WS" before "S", "SS" before "S".
  const names = [...SCALES[scale]].map((name, index) => ({ name, index })).sort((a, b) => b.name.length - a.name.length);
  const hit = names.find(({ name }) => grade.startsWith(name));
  if (!hit) return null;
  const rest = grade.slice(hit.name.length);
  return hit.index + (rest === '+' ? 1 / 3 : rest === '-' ? -1 / 3 : 0);
}

/**
 * Whether a route is shown. `rank` and `up` are null when the route has no such value (then a
 * limit on it hides the route) and undefined while the value is still being looked up (shown
 * for now).
 */
export function passes(filter: RouteFilter, rank: number | null | undefined, up: number | null | undefined): boolean {
  if (filtersGrade(filter) && rank !== undefined) {
    if (rank === null) return false;
    // "+" and "-" belong to their grade: WS+ passes "up to WS".
    if (filter.gradeMin !== null && rank < filter.gradeMin - 0.4) return false;
    if (filter.gradeMax !== null && rank > filter.gradeMax + 0.4) return false;
  }
  if (filtersClimb(filter) && up !== undefined) {
    if (up === null) return false;
    if (filter.upMin !== null && up < filter.upMin) return false;
    if (filter.upMax !== null && up > filter.upMax) return false;
  }
  return true;
}

/** "1~3~500~" (grade from, grade to, ascent from, ascent to; empty = no limit) for the page address. */
export function encodeFilter(f: RouteFilter): string {
  return [f.gradeMin, f.gradeMax, f.upMin, f.upMax].map((v) => (v === null ? '' : String(v))).join('~');
}

export function decodeFilter(text: string): RouteFilter {
  const [gradeMin, gradeMax, upMin, upMax] = text.split('~').map((part) => (part === '' || part === undefined || !Number.isFinite(Number(part)) ? null : Number(part)));
  return { gradeMin: gradeMin ?? null, gradeMax: gradeMax ?? null, upMin: upMin ?? null, upMax: upMax ?? null };
}
