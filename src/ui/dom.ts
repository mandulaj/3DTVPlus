type Child = Node | string | null | undefined | false;
type Attrs = Record<string, unknown>;

/** Tiny hyperscript helper: h('div', { class: 'x', onclick: fn }, child, …). */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el && key !== 'list') (el as Record<string, unknown>)[key] = value;
    else el.setAttribute(key, String(value));
  }
  for (const child of children) if (child) el.append(child);
  return el;
}

export function slider(value: number, min: number, max: number, step: number, oninput: (value: number) => void, title = ''): HTMLInputElement {
  return h('input', {
    type: 'range',
    min: String(min),
    max: String(max),
    step: String(step),
    value: String(value),
    title,
    oninput: (e: Event) => oninput(Number((e.target as HTMLInputElement).value)),
  });
}

let toastTimer: number | undefined;
export function toast(message: string, kind: 'error' | 'info' = 'error'): void {
  const el = document.getElementById('toast')!;
  el.textContent = message;
  el.classList.toggle('info', kind === 'info');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('show'), 5000);
}

/** A small (i) that shows an explanation on hover, focus or tap, instead of text taking up room. */
export function info(text: string): HTMLElement {
  const el = h('span', { class: 'info', tabindex: '0', role: 'note', 'aria-label': text, 'data-tip': text }, 'ⓘ');
  // Inside a label or a section heading a click must not also tick the box or fold the section.
  el.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    el.focus();
  });
  return el;
}
