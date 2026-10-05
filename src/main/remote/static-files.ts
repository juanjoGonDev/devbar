/**
 * Everything the remote-control server will ever read from disk, as an
 * explicit whitelist keyed by the exact request path. A lookup in this map is
 * the whole resolution: no path is ever joined from request input, so there
 * is nothing to traverse.
 *
 * The phone page's script is ONE file: scripts/build.ts bundles
 * renderer/remote.ts with everything it imports (the @noble crypto of
 * devbar-rc/1 included) into remote.js, so no module is listed one by one.
 */

interface StaticAsset {
  /** Relative to the built renderer directory. */
  file: string;
  type: string;
}

const HTML = 'text/html; charset=utf-8';
const CSS = 'text/css; charset=utf-8';
const JS = 'text/javascript; charset=utf-8';

const ASSETS = new Map<string, StaticAsset>([
  // The shell: the page decides its view from the path, the keys it holds
  // and what DevBar answers. /pair and /verify are the two QR links.
  ['/', { file: 'remote.html', type: HTML }],
  ['/pair', { file: 'remote.html', type: HTML }],
  ['/verify', { file: 'remote.html', type: HTML }],
  ['/remote.css', { file: 'remote.css', type: CSS }],
  // The shared font stacks (--font-ui) every window's CSS builds on.
  ['/emoji.css', { file: 'emoji.css', type: CSS }],
  ['/remote.js', { file: 'remote.js', type: JS }],
  // "Add to Home Screen": over plain HTTP there is no service worker, so
  // this buys an icon and a standalone window, not offline use.
  [
    '/remote.webmanifest',
    { file: 'remote.webmanifest', type: 'application/manifest+json' },
  ],
  ...[192, 512].map((size): [string, StaticAsset] => [
    `/remote-icon-${size}.png`,
    { file: `remote-icon-${size}.png`, type: 'image/png' },
  ]),
]);

/** Every distinct file the server may serve. */
export const STATIC_FILES: readonly string[] = [
  ...new Set([...ASSETS.values()].map((asset) => asset.file)),
];

export function staticAsset(pathname: string): StaticAsset | null {
  return ASSETS.get(pathname) ?? null;
}
