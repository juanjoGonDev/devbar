import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The right-hand buttons of a tray row used to shift while a script ran
 * (worst on Windows): every button was glyph advance + padding, ■ and ▶ have
 * different advances and resolved in different fonts, and the uptime/error
 * badge appearing squeezed the shrinkable branch selector, sliding the logs
 * button along. These rules are the fix; a static-source contract over the
 * shipped CSS, like drag-row-css-contract.test.ts.
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

const ROW_BUTTONS = [
  '.group-row .group-logs-btn',
  '.caret-btn',
  '.cmd-sub-btn',
  '.action-logs-btn',
  // The pipeline controls live in the header, whose `button.ghost` rule
  // (padding 3px 9px) would otherwise out-rank a bare class selector.
  '.tray-header button.ghost.prescripts-trigger',
  '.tray-header button.ghost.prestep-cancel',
  '.tray-header button.ghost.prestep-logs-btn',
];

describe('tray row layout (renderer/styles.css)', () => {
  it('gives every row icon button one fixed square box, whatever its state', () => {
    const shared = rule(ROW_BUTTONS.join(',\n'));
    expect(shared.width).toMatch(/^\d+px$/);
    expect(shared.height).toBe(shared.width);
    expect(shared['min-width']).toBe(shared.width);
    expect(shared.padding).toBe('0');
    expect(shared.flex).toBe('0 0 auto');
    expect(shared.display).toBe('inline-flex');
    expect(shared['justify-content']).toBe('center');
  });

  it('strips the bezel the base button rule would otherwise add', () => {
    const shared = rule(ROW_BUTTONS.join(',\n'));
    expect(shared['box-shadow']).toBe('none');
    expect(shared['font-weight']).toBe('400');
  });

  it('keeps the branch selector a fixed slot that never shrinks', () => {
    for (const selector of ['.combobox', '.branch-select']) {
      expect(rule(selector).flex, selector).toBe('0 0 110px');
    }
  });

  it('lets the group name absorb the squeeze by truncating', () => {
    const name = rule('.group-name');
    expect(name['min-width']).toBe('0');
    expect(name['flex-shrink']).toBe('1');
    expect(name['text-overflow']).toBe('ellipsis');
    expect(name['white-space']).toBe('nowrap');
  });

  it('reserves the uptime width so ticking 59s → 1m 0s does not jitter', () => {
    const uptime = rule('.uptime');
    expect(uptime['min-width']).toMatch(/^\d+(\.\d+)?ch$/);
    expect(uptime['font-variant-numeric']).toBe('tabular-nums');
  });

  it('draws the actions divider rules in CSS instead of box-drawing text', () => {
    expect(rule('.actions-divider').display).toBe('flex');
    expect(
      rule('.actions-divider::before,\n.actions-divider::after').flex,
    ).toBe('1');
  });
});
