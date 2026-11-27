import { describe, expect, it } from 'vitest';
import { interaction, isTyping } from '../src/interaction';

describe('isTyping', () => {
  it('treats text inputs, textareas and selects as typing', () => {
    const text = document.createElement('input');
    text.type = 'text';
    expect(isTyping(text)).toBe(true);
    expect(isTyping(document.createElement('textarea'))).toBe(true);
    expect(isTyping(document.createElement('select'))).toBe(true);
  });

  it('allows map shortcuts when focus is on checkboxes or range sliders', () => {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    const range = document.createElement('input');
    range.type = 'range';
    expect(isTyping(checkbox)).toBe(false);
    expect(isTyping(range)).toBe(false);
    expect(isTyping(document.createElement('div'))).toBe(false);
    expect(isTyping(null)).toBe(false);
  });
});

describe('interaction mode and hover cursor', () => {
  const fakeMap = () => {
    const canvas = { style: { cursor: '' } };
    return { canvas, map: { getCanvas: () => canvas } as any };
  };

  it('tracks overlapping hovered layers without clobbering pointer cursor', () => {
    interaction.setMode('explore');
    const { canvas, map } = fakeMap();
    interaction.setHover(map, 'layer-a', true);
    expect(canvas.style.cursor).toBe('pointer');
    interaction.setHover(map, 'layer-b', true);
    interaction.setHover(map, 'layer-a', false);
    expect(canvas.style.cursor).toBe('pointer');
    interaction.setHover(map, 'layer-b', false);
    expect(canvas.style.cursor).toBe('');
  });

  it('does not overwrite crosshair cursor while drawing', () => {
    const { canvas, map } = fakeMap();
    interaction.setMode('draw-area');
    expect(interaction.drawing).toBe(true);
    canvas.style.cursor = 'crosshair';
    interaction.setHover(map, 'layer-a', true);
    interaction.setHover(map, 'layer-a', false);
    expect(canvas.style.cursor).toBe('crosshair');
    interaction.setMode('explore');
    expect(interaction.drawing).toBe(false);
  });
});
