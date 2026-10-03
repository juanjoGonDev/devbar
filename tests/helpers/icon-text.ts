/// <reference lib="dom" />
/**
 * An element's text with every Lucide icon spelled `[name]`, so a test reads
 * `[play]` instead of a private-use codepoint: `iconText(btn)` of a button
 * holding `icon('triangle-alert')` and " 5" is "[triangle-alert] 5".
 * Whitespace is collapsed and trimmed, so markup indentation never counts.
 */
export function iconText(el: Element | null | undefined): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as Element;
  for (const glyph of clone.querySelectorAll<HTMLElement>('.icon[data-icon]')) {
    glyph.replaceWith(`[${glyph.dataset.icon}]`);
  }
  return (clone.textContent ?? '').replace(/\s+/g, ' ').trim();
}
