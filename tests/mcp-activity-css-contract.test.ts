import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Only the rows of Settings › MCP › «Actividad» scroll: while that tab is on
 * screen the settings content stops scrolling and hands its height down, the
 * list between the column header and the pager is the one scroller, and the
 * day separators stick to its top. «Servidor» scrolls the content as every
 * other section does. jsdom has no layout, so this is a static-source
 * contract over the shipped CSS, like mcp-confirm-css-contract.test.ts.
 */

const raw = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../renderer/styles.css',
  ),
  'utf8',
);

/** The CSS on one line, so a selector wrapped by Prettier still matches. */
const css = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/\s+/g, ' ')
  .replace(/\(\s+/g, '(')
  .replace(/\s+\)/g, ')');

/** Declarations of every rule whose selector list is exactly `selector`. */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [
    ...css.matchAll(new RegExp(`(?:^|})\\s*${escaped}\\s*{([^}]*)}`, 'g')),
  ];
  if (matches.length === 0) throw new Error(`no rule for ${selector}`);
  return matches.map((match) => match[1] ?? '').join(';');
}

const ACTIVITY_SHOWN = '#mcp-activity:not([hidden])';

describe('«Actividad» scrolling (renderer/styles.css)', () => {
  it('stops the settings content scrolling only while «Actividad» is shown', () => {
    expect(
      declarations(
        `.config-content:has(> .config-section[data-section='mcp'].active > ${ACTIVITY_SHOWN})`,
      ),
    ).toMatch(/overflow: hidden/);
    expect(
      declarations(
        `.config-section[data-section='mcp'].active:has(> ${ACTIVITY_SHOWN})`,
      ),
    ).toMatch(/height: 100%/);
    // No rule stops it for the whole section, which would freeze «Servidor».
    expect(css).not.toMatch(
      /\.config-content:has\(> \.config-section\[data-section='mcp'\]\.active\)/,
    );
  });

  it('hands the height down to the rows, which are the one scroller', () => {
    expect(declarations('#mcp-activity')).toMatch(/min-height: 0/);
    const log = declarations('.mcp-log');
    expect(log).toMatch(/flex-direction: column/);
    expect(log).toMatch(/min-height: 0/);
    const list = declarations('.mcp-log-rows');
    expect(list).toMatch(/flex: 1/);
    expect(list).toMatch(/min-height: 0/);
    expect(list).toMatch(/overflow-y: auto/);
    expect(list).toMatch(/overscroll-behavior: contain/);
    expect(declarations('.mcp-log-head, .act-pager')).toMatch(/flex-shrink: 0/);
  });

  it('never clips the card, so the column menus can cover the rows', () => {
    expect(declarations('.mcp-log')).toMatch(/overflow: visible/);
  });

  it('keeps each day on top of its rows, on an opaque background', () => {
    const day = declarations('.act-day');
    expect(day).toMatch(/position: sticky/);
    expect(day).toMatch(/top: 0/);
    expect(day).toMatch(/var\(--mcp-surface\)/);
  });

  it('shades the top of the rows only once they are scrolled', () => {
    expect(declarations('.mcp-log-rows::before')).toMatch(/opacity: 0/);
    expect(declarations('.mcp-log-rows.is-scrolled::before')).toMatch(
      /opacity: 1/,
    );
  });

  it('lets a column menu scroll inside itself instead of being cut off', () => {
    const box = declarations('.xf');
    expect(box).toMatch(/overflow-y: auto/);
    expect(box).toMatch(/overscroll-behavior: contain/);
  });

  it('pins the «Rango…» flyout to the window, where nothing around it can clip it', () => {
    const fly = declarations('.xf-fly');
    expect(fly).toMatch(/position: fixed/);
    expect(fly).toMatch(/width: 284px/);
    // These would make a box around it the flyout's frame instead of the
    // window, and the settings content or the menu would clip it again.
    const traps =
      /(?:^|;)\s*(?:transform|filter|backdrop-filter|perspective|contain|will-change):/;
    for (const around of [
      '.config-content',
      '.config-section',
      ".config-section[data-section='mcp'].active",
      '.mcp-view',
      '.mcp-card',
      '.mcp-log',
      '.mcp-log-head',
      '.xh',
      '.xf',
    ])
      expect(declarations(around), around).not.toMatch(traps);
  });

  it('keeps the search compact, wider while it is being used', () => {
    expect(declarations('.act-search')).toMatch(/flex: 0 0 240px/);
    expect(declarations('.act-search:focus-within')).toMatch(
      /flex-basis: 300px/,
    );
  });
});
