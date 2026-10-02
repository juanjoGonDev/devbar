/**
 * Everything the remote-control server will ever read from disk, as an
 * explicit whitelist keyed by the exact request path. A lookup in this map is
 * the whole resolution: no path is ever joined from request input, so there
 * is nothing to traverse.
 *
 * The phone page is native ES modules (the renderer build does not bundle),
 * so each module it imports must be listed here too —
 * tests/main-remote-static-files.test.ts fails when one is missing.
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
  // The shell: the page decides which view to show from /api/me.
  ['/', { file: 'remote.html', type: HTML }],
  ['/pair', { file: 'remote.html', type: HTML }],
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
  ...[
    'api',
    'app',
    'branch-sheet',
    'confirm-dialog',
    'connection',
    'context',
    'elements',
    'env',
    'format',
    'glyphs',
    'groups-tab',
    'logs-tab',
    'notices-tab',
    'panel',
    'settings-tab',
    'view',
    'wire',
  ].map((name): [string, StaticAsset] => [
    `/remote/${name}.js`,
    { file: `remote/${name}.js`, type: JS },
  ]),
]);

/** Every distinct file the server may serve. */
export const STATIC_FILES: readonly string[] = [
  ...new Set([...ASSETS.values()].map((asset) => asset.file)),
];

export function staticAsset(pathname: string): StaticAsset | null {
  return ASSETS.get(pathname) ?? null;
}
