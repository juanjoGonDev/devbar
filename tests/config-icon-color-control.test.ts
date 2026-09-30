// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createIconColorControl } from '../renderer/config/icon-color-control.js';
import { ICON_COLOR_PRESETS } from '../src/icon-color.js';

function mount(options: { inDom?: boolean } = {}) {
  const changes: (string | null)[] = [];
  const iconBtn = document.createElement('button');
  iconBtn.className = 'icon-btn';
  const host = document.createElement('div');
  document.body.replaceChildren(host);
  if (options.inDom) host.append(iconBtn);
  const control = createIconColorControl(iconBtn, (value) =>
    changes.push(value),
  );
  if (!options.inDom) host.append(control.el);
  const q = <T extends Element>(sel: string) =>
    control.el.querySelector<T>(sel);
  const trigger = q<HTMLButtonElement>('.icon-color-trigger');
  const popover = q<HTMLElement>('.icon-color-popover');
  if (!trigger || !popover) throw new Error('split button not built');
  const swatches = [
    ...control.el.querySelectorAll<HTMLButtonElement>('.icon-color-swatch'),
  ];
  const pressed = () =>
    swatches
      .filter((s) => s.getAttribute('aria-pressed') === 'true')
      .map((s) => s.title);
  return {
    control,
    changes,
    iconBtn,
    host,
    trigger,
    popover,
    swatches,
    dot: q<HTMLElement>('.icon-color-dot'),
    custom: q<HTMLInputElement>('input.icon-color-custom'),
    customBtn: q<HTMLButtonElement>('.icon-color-custom-btn'),
    reset: q<HTMLButtonElement>('.icon-color-reset'),
    pressed,
  };
}

const key = (target: EventTarget, k: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

describe('renderer/config/icon-color-control.ts', () => {
  it('joins the icon button and a colour segment into one control', () => {
    const h = mount();
    expect(h.control.el.classList.contains('icon-split')).toBe(true);
    expect(h.control.el.firstElementChild).toBe(h.iconBtn);
    expect(h.trigger.getAttribute('aria-label')).toBe('Color del icono');
    expect(h.trigger.getAttribute('aria-haspopup')).toBe('true');
    expect(h.trigger.querySelector('.icon[data-icon="chevron-down"]')).not.toBe(
      null,
    );
    expect(h.dot).not.toBe(null);
  });

  it('takes the place of an icon button already in the page', () => {
    const h = mount({ inDom: true });
    expect(h.host.firstElementChild).toBe(h.control.el);
    expect(h.iconBtn.parentElement).toBe(h.control.el);
  });

  it('keeps the palette closed until the segment is clicked', () => {
    const h = mount();
    expect(h.popover.hidden).toBe(true);
    expect(h.trigger.getAttribute('aria-expanded')).toBe('false');
    h.trigger.click();
    expect(h.popover.hidden).toBe(false);
    expect(h.trigger.getAttribute('aria-expanded')).toBe('true');
    h.trigger.click();
    expect(h.popover.hidden).toBe(true);
  });

  it('offers every preset, then "Sin color" and "Personalizado"', () => {
    const h = mount();
    const cells = [...h.popover.querySelectorAll('button')].map((b) => b.title);
    expect(cells).toEqual([
      ...ICON_COLOR_PRESETS.map((p) => p.label),
      'Sin color',
      'Personalizado',
    ]);
    expect(h.reset?.querySelector('.icon[data-icon="ban"]')).not.toBe(null);
    expect(h.customBtn?.querySelector('.icon[data-icon="plus"]')).not.toBe(
      null,
    );
    expect(h.custom?.type).toBe('color');
  });

  it('paints each preset swatch with its own colour, gradient-free', () => {
    const h = mount();
    const probe = document.createElement('span');
    for (const [i, preset] of ICON_COLOR_PRESETS.entries()) {
      const swatch = h.swatches[i];
      if (!swatch) throw new Error(`no swatch for ${preset.label}`);
      probe.style.color = preset.value;
      const expected = probe.style.color;
      expect(swatch.style.backgroundColor).toBe(expected);
      expect(getComputedStyle(swatch).backgroundColor).toBe(expected);
      // The shorthand also clears the inherited button gradient inline.
      expect(swatch.style.backgroundImage).toBe('none');
    }
  });

  it('reports a picked swatch, marks it and closes the palette', () => {
    const h = mount();
    h.trigger.click();
    h.swatches[3]?.click();
    expect(h.changes).toEqual(['#22c55e']);
    expect(h.pressed()).toEqual(['Verde']);
    expect(h.reset?.getAttribute('aria-pressed')).toBe('false');
    expect(h.popover.hidden).toBe(true);
    expect(h.dot?.style.backgroundColor).toBe('rgb(34, 197, 94)');
    expect(h.dot?.classList.contains('is-empty')).toBe(false);
  });

  it('opens the native picker from "Personalizado" and takes its colour', () => {
    const h = mount();
    if (!h.custom || !h.customBtn) throw new Error('no custom');
    const opened = vi.spyOn(h.custom, 'click');
    h.trigger.click();
    h.customBtn.click();
    expect(opened).toHaveBeenCalledOnce();
    h.custom.value = '#123456';
    h.custom.dispatchEvent(new Event('input'));
    expect(h.changes).toEqual(['#123456']);
    expect(h.pressed()).toEqual([]);
    expect(h.customBtn.getAttribute('aria-pressed')).toBe('true');
    expect(h.dot?.style.backgroundColor).toBe('rgb(18, 52, 86)');
    // The native input is never part of the palette grid itself.
    expect(h.popover.contains(h.custom)).toBe(false);
  });

  it('resets to no colour, showing a neutral dot', () => {
    const h = mount();
    h.control.set('#ef4444');
    h.trigger.click();
    h.reset?.click();
    expect(h.changes).toEqual([null]);
    expect(h.pressed()).toEqual([]);
    expect(h.reset?.getAttribute('aria-pressed')).toBe('true');
    expect(h.dot?.classList.contains('is-empty')).toBe(true);
    expect(h.dot?.style.backgroundColor).toBe('');
    expect(h.popover.hidden).toBe(true);
  });

  it('reflects a value set from outside without reporting it', () => {
    const h = mount();
    h.control.set('#3B82F6');
    expect(h.pressed()).toEqual(['Azul']);
    expect(h.control.value()).toBe('#3b82f6');
    expect(h.dot?.style.backgroundColor).toBe('rgb(59, 130, 246)');
    h.control.set('not a colour');
    expect(h.control.value()).toBeNull();
    expect(h.changes).toEqual([]);
  });

  it('closes on Escape, handing focus back to the segment', () => {
    const h = mount();
    h.trigger.click();
    key(h.swatches[0] ?? h.popover, 'Escape');
    expect(h.popover.hidden).toBe(true);
    expect(document.activeElement).toBe(h.trigger);
  });

  it('closes on a click outside, but not on one inside', () => {
    const h = mount();
    h.trigger.click();
    h.popover.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.popover.hidden).toBe(false);
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(h.popover.hidden).toBe(true);
  });

  it('closes when focus leaves the control', () => {
    const h = mount();
    const outside = document.createElement('input');
    document.body.append(outside);
    h.trigger.click();
    h.swatches[0]?.focus();
    h.swatches[1]?.focus();
    expect(h.popover.hidden).toBe(false);
    outside.focus();
    expect(h.popover.hidden).toBe(true);
  });

  it('focuses the selected colour on open and moves with the arrows', () => {
    const h = mount();
    h.control.set('#22c55e');
    h.trigger.click();
    expect(document.activeElement).toBe(h.swatches[3]);
    key(h.swatches[3] ?? h.popover, 'ArrowRight');
    expect(document.activeElement).toBe(h.swatches[4]);
    key(h.swatches[4] ?? h.popover, 'ArrowDown');
    expect(document.activeElement).toBe(h.reset);
    key(h.reset ?? h.popover, 'ArrowUp');
    expect(document.activeElement).toBe(h.swatches[4]);
    key(h.swatches[4] ?? h.popover, 'ArrowLeft');
    expect(document.activeElement).toBe(h.swatches[3]);
  });

  it('hides the segment for an image icon, which a colour cannot tint', () => {
    const h = mount();
    h.trigger.click();
    h.control.setImage(true);
    expect(h.trigger.hidden).toBe(true);
    expect(h.popover.hidden).toBe(true);
    expect(h.control.el.classList.contains('is-image')).toBe(true);
    expect(h.iconBtn.hidden).toBe(false);
    h.control.setImage(false);
    expect(h.trigger.hidden).toBe(false);
    expect(h.control.el.classList.contains('is-image')).toBe(false);
  });
});
