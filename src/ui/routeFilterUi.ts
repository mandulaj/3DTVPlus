// The small "Filter" control under a kind of route: a range of grades and a range of ascent.
import { isActive, NO_FILTER, SCALES, type RouteFilter, type Scale } from '../layers/routeFilter';
import { h } from './dom';

export interface RouteFilterUi {
  /** Button that opens and closes the controls; lit while a filter is set. */
  toggle: HTMLButtonElement;
  body: HTMLElement;
  /** Show another filter (e.g. restored from a link). */
  set(filter: RouteFilter | null): void;
}

export function routeFilterUi(scale: Scale, initial: RouteFilter | null, climbNote: string, onChange: (filter: RouteFilter | null) => void): RouteFilterUi {
  const grades = SCALES[scale];
  const gradeSelect = (label: string) =>
    h('select', { title: label, 'aria-label': label, onchange: () => changed() }, h('option', { value: '' }, 'any'), ...grades.map((grade, index) => h('option', { value: String(index) }, grade)));
  const metres = (label: string, placeholder: string) => h('input', { type: 'number', min: '0', step: '100', placeholder, title: label, 'aria-label': label, onchange: () => changed() });
  const gradeMin = gradeSelect('Easiest grade shown');
  const gradeMax = gradeSelect('Hardest grade shown');
  const upMin = metres('Least ascent in metres', 'min');
  const upMax = metres('Most ascent in metres', 'max');
  const clear = h('button', { type: 'button', class: 'route-filter-clear', title: 'Show all again', onclick: () => { set(null); onChange(null); } }, 'Clear');
  const body = h(
    'div',
    { class: 'route-filter', hidden: true },
    h('div', {}, h('span', { class: 'muted' }, 'Grade'), gradeMin, '–', gradeMax),
    h('div', { title: climbNote }, h('span', { class: 'muted' }, 'Ascent'), upMin, '–', upMax, h('span', { class: 'muted' }, 'm'), clear),
  );
  let open = false;
  const toggle = h(
    'button',
    {
      type: 'button',
      class: 'route-filter-toggle',
      title: 'Show only routes of some grades or height gain',
      onclick: () => {
        open = !open;
        show();
      },
    },
    'Filter',
  );

  const number = (field: HTMLInputElement | HTMLSelectElement) => (field.value === '' || !Number.isFinite(Number(field.value)) ? null : Number(field.value));
  function read(): RouteFilter {
    const filter = { gradeMin: number(gradeMin), gradeMax: number(gradeMax), upMin: number(upMin), upMax: number(upMax) };
    // A range entered the wrong way round is taken as meant.
    if (filter.gradeMin !== null && filter.gradeMax !== null && filter.gradeMin > filter.gradeMax) [filter.gradeMin, filter.gradeMax] = [filter.gradeMax, filter.gradeMin];
    if (filter.upMin !== null && filter.upMax !== null && filter.upMin > filter.upMax) [filter.upMin, filter.upMax] = [filter.upMax, filter.upMin];
    return filter;
  }
  function show(): void {
    const active = isActive(read());
    toggle.classList.toggle('on', active);
    body.hidden = !open && !active;
    clear.hidden = !active;
  }
  function changed(): void {
    const filter = read();
    set(filter); // shows a swapped range the right way round
    onChange(isActive(filter) ? filter : null);
  }
  function set(filter: RouteFilter | null): void {
    const f = filter ?? NO_FILTER;
    const text = (value: number | null) => (value === null ? '' : String(value));
    gradeMin.value = text(f.gradeMin);
    gradeMax.value = text(f.gradeMax);
    upMin.value = text(f.upMin);
    upMax.value = text(f.upMax);
    show();
  }
  set(initial);
  return { toggle, body, set };
}
