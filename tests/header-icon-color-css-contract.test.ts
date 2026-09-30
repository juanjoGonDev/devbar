import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Icon-only chrome buttons (tray header: pipeline trigger, logs, settings,
 * power; the config panes' collapse toggle) used to be emoji, which ignore
 * `color`. Once they became font glyphs they picked up the ghost button's
 * accent colour and turned blue. They must read in the neutral text colour,
 * like the power button; the accent is reserved for meaning (primary
 * buttons, links, selected state, focus rings). The amber warning count
 * keeps its own colour. Static-source contract, like
 * tray-row-css-contract.test.ts.
 */

const css = readFileSync(
  path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    '../renderer/styles.css',
  ),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, '');

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
      .split(';')
      .map((decl) => decl.split(':').map((part) => part.trim()))
      .filter((pair): pair is [string, string] => pair.length >= 2)
      .map(([prop, ...value]) => [prop, value.join(':')]),
  );
}

/** Every rule whose selector list mentions `fragment`, as [selector, body]. */
function rulesMentioning(fragment: string): [string, string][] {
  return [...css.matchAll(/([^{}]+){([^}]*)}/g)]
    .map((m): [string, string] => [m[1]?.trim() ?? '', m[2] ?? ''])
    .filter(([selector]) => selector.includes(fragment));
}

const ACCENT = /var\(--accent(?:-strong)?\)|0,\s*122,\s*255|#007aff/i;

describe('neutral icon chrome CSS contract', () => {
  it('renders header ghost buttons in the inherited text colour', () => {
    expect(rule('.tray-header button.ghost').color).toBe('inherit');
  });

  it('uses a neutral hover surface on header ghost buttons', () => {
    const hover = rule('.tray-header button.ghost:hover');
    expect(hover.background).toBe('var(--bg-row-hover)');
  });

  it('never paints a non-danger header ghost button with the accent', () => {
    const offenders = rulesMentioning('.tray-header button.ghost').filter(
      ([selector, body]) =>
        selector
          .split(',')
          .some(
            (s) =>
              s.includes('.tray-header button.ghost') && !s.includes('danger'),
          ) && ACCENT.test(body),
    );
    expect(offenders).toEqual([]);
  });

  it('keeps the power button neutral with a red hover', () => {
    expect(rule('.tray-header button.ghost.danger.icon-only').color).toBe(
      'inherit',
    );
    expect(rule('.tray-header button.ghost.danger.icon-only:hover').color).toBe(
      'var(--error)',
    );
  });

  it('keeps the pane collapse toggle neutral on hover', () => {
    const hover = rule('.pane-collapse:hover');
    expect(hover.color).toBe('inherit');
    expect(hover.background).toBe('var(--bg-row-hover)');
  });

  it('keeps the warning count amber', () => {
    expect(rule('.alerts-summary .warn-count').color).toBe('#b58105');
  });

  it('keeps the accent where it carries meaning', () => {
    expect(rule('.small-btn.theme-opt.is-on').background).toBe(
      'var(--accent-strong)',
    );
    expect(rule('.cl-notes a').color).toBe('var(--accent)');
    expect(rule('.nav-card.selected .nav-name').color).toBe('var(--accent)');
  });
});
