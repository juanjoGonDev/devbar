/// <reference lib="dom" />
/**
 * The tooltip text of an element. `renderer/tooltip.ts` moves every `title`
 * into `data-tip` as soon as its MutationObserver sees it (so the hovered
 * element never changes under the pointer), which means a test reading the
 * text after an `await` finds it in `data-tip`, and one reading it in the
 * same task still finds the `title`. This reads whichever is there.
 */
export function tipOf(el: Element | null | undefined): string | null {
  if (!el) return null;
  return el.getAttribute('title') ?? el.getAttribute('data-tip');
}

/** A selector matching an element by its tooltip text, wherever it lives. */
export function byTip(text: string): string {
  const quoted = JSON.stringify(text);
  return `[title=${quoted}], [data-tip=${quoted}]`;
}
