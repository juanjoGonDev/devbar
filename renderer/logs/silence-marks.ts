/**
 * Where a previewed silence rule bites, painted inside a drawn log line.
 *
 * The row is tinted as a whole (`would-silence`); this marks the exact runs
 * the rule matched, so a rule that catches more than meant shows it at a
 * glance. A drawn line is split into colour spans, so a match can straddle
 * several text nodes: each piece is wrapped in its own `<mark>`, and taking
 * the marks off puts the text nodes back together as they were drawn.
 */
import type { PatternMatcher } from './silence-preview.js';

const MARK_CLASS = 'sil-hit';

function textNodes(root: Node): Text[] {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    nodes.push(node as Text);
  return nodes;
}

/** Wrap `[start, end)` of `node`'s own text in a mark. */
function wrap(node: Text, start: number, end: number): void {
  const hit = start > 0 ? node.splitText(start) : node;
  if (end - start < hit.length) hit.splitText(end - start);
  const mark = document.createElement('mark');
  mark.className = MARK_CLASS;
  hit.replaceWith(mark);
  mark.appendChild(hit);
}

export function markMatches(body: HTMLElement, matcher: PatternMatcher): void {
  const ranges = matcher.ranges(body.textContent ?? '');
  if (!ranges.length) return;
  // Offsets are taken before any split, then applied last node first, so a
  // split never moves text a later range still points at.
  const pieces: Array<[Text, number, number]> = [];
  let offset = 0;
  for (const node of textNodes(body)) {
    const from = offset;
    const to = offset + node.length;
    offset = to;
    for (const [start, end] of ranges) {
      const a = Math.max(start, from);
      const b = Math.min(end, to);
      if (a < b) pieces.push([node, a - from, b - from]);
    }
  }
  for (let i = pieces.length - 1; i >= 0; i -= 1) {
    const [node, start, end] = pieces[i] as [Text, number, number];
    wrap(node, start, end);
  }
}

export function unmarkMatches(root: HTMLElement): void {
  const marks = root.querySelectorAll(`mark.${MARK_CLASS}`);
  if (!marks.length) return;
  for (const mark of Array.from(marks)) mark.replaceWith(...mark.childNodes);
  root.normalize();
}
