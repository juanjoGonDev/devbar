import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * «Nuevo workflow» sits in the list's toolbar, not inside a list: it is a
 * normal toolbar button. The dashed outline is reserved for the add buttons
 * that stand in a list as its next entry (Nuevo grupo, Nuevo pre-script).
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

/** Declarations of every rule whose selector list is exactly `selector`. */
function declarations(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const matches = [
    ...css.matchAll(new RegExp(`(?:^|\\n|})\\s*${escaped}\\s*{([^}]*)}`, 'g')),
  ];
  if (matches.length === 0) throw new Error(`no rule for ${selector}`);
  return matches.map((match) => match[1] ?? '').join(';');
}

describe('workflows list toolbar (renderer/styles.css)', () => {
  it('draws «Nuevo workflow» as a solid toolbar button, never dashed', () => {
    const body = declarations('.wf-new');
    expect(body).not.toMatch(/dashed/);
    expect(body).toMatch(/border:\s*1px solid var\(--wf-border\)/);
    expect(body).toMatch(/background:\s*var\(--wf-surface\)/);
  });

  it('keeps the dashed outline on the in-list add buttons', () => {
    expect(declarations('.add-group-btn')).toMatch(/dashed/);
  });
});
