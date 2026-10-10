import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Once the popover hits its height cap, the group list — and only the list —
 * scrolls under a fixed header. The list's old `max-height: calc(100vh -
 * 56px)` guessed the header at 56px while the real header plus the body's
 * bottom padding is taller, so the BODY overflowed too: two scrollbars on
 * Windows' classic scrollbars, the outer one scrolling the header away.
 * A static-source contract over the shipped CSS, like
 * tray-row-css-contract.test.ts.
 */

const css = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../renderer/styles.css',
  ),
  'utf8',
);

/** Declarations of the LAST rule whose selector list is exactly `selector`. */
function rule(selector: string): Record<string, string> {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [
    ...css.matchAll(new RegExp(`(?:^|\\n|})\\s*${escaped}\\s*{([^}]*)}`, 'g')),
  ];
  const body = matches.at(-1)?.[1];
  if (body === undefined) throw new Error(`no rule for ${selector}`);
  return Object.fromEntries(
    body
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split(';')
      .map((decl) => decl.split(':').map((part) => part.trim()))
      .filter((pair): pair is [string, string] => pair.length >= 2)
      .map(([prop, ...value]) => [prop, value.join(':')]),
  );
}

describe('tray popover scrolling (renderer/styles.css)', () => {
  it('pins the body to the window so it never scrolls itself', () => {
    const body = rule('body.tray');
    expect(body.height).toBe('100vh');
    expect(body.overflow).toBe('hidden');
    expect(body.display).toBe('flex');
    expect(body['flex-direction']).toBe('column');
  });

  it('keeps the header out of the shrinking', () => {
    expect(rule('.tray-header.sticky')['flex-shrink']).toBe('0');
  });

  it('scrolls the list vertically only, at its natural height below the cap', () => {
    const list = rule('.groups-list');
    // Not stretched to the window: a stretched list would report the window
    // height as its scrollHeight, and the popover could never shrink.
    expect(list.flex).toBe('0 1 auto');
    expect(list['min-height']).toBe('0');
    expect(list['overflow-y']).toBe('auto');
    expect(list['overflow-x']).toBe('hidden');
    expect(list['max-height']).toBeUndefined();
  });
});
