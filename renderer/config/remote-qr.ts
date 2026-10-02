import type { RemoteQrMatrix } from '../../src/ipc-contract/remote-api.js';

/**
 * Draws the module matrix main encoded. Built node by node with
 * createElementNS — no markup string is ever parsed — and always black on
 * white whatever the theme: a scanner needs the contrast, and the four-module
 * quiet zone around it, to find the code.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const QUIET_ZONE = 4;

export function qrSvg(qr: RemoteQrMatrix): SVGSVGElement {
  const span = qr.size + QUIET_ZONE * 2;
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${span} ${span}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('aria-hidden', 'true');

  const background = document.createElementNS(SVG_NS, 'rect');
  background.setAttribute('width', String(span));
  background.setAttribute('height', String(span));
  background.setAttribute('fill', '#fff');

  // One path for the whole code: a square per dark module.
  let d = '';
  qr.modules.forEach((dark, index) => {
    if (!dark) return;
    const x = (index % qr.size) + QUIET_ZONE;
    const y = Math.floor(index / qr.size) + QUIET_ZONE;
    d += `M${x} ${y}h1v1h-1z`;
  });
  const modules = document.createElementNS(SVG_NS, 'path');
  modules.setAttribute('d', d);
  modules.setAttribute('fill', '#000');

  svg.append(background, modules);
  return svg;
}
