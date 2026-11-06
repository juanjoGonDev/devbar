import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The MCP confirmation dialog (renderer/config/mcp-confirm.ts) types no diff
 * marker into the DOM: the minus and plus come from CSS pseudo-content, and
 * every colour of the dialog is a token of its own block, redefined for
 * dark. A static-source contract over the shipped CSS, like
 * workflows-toolbar-css-contract.test.ts.
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

/** Every `--mcp-*` custom property a rule body declares. */
const tokens = (body: string): string[] =>
  [...body.matchAll(/(--mcp-[\w-]+)\s*:/g)].map((match) => match[1] ?? '');

describe('MCP confirm dialog (renderer/styles.css)', () => {
  it('draws the removal and addition markers as pseudo-content', () => {
    expect(
      declarations(".mcp-confirm .mcp-diff-line[data-kind='del']::before"),
    ).toMatch(/content:\s*'\\2212'/);
    expect(
      declarations(".mcp-confirm .mcp-diff-line[data-kind='add']::before"),
    ).toMatch(/content:\s*'\\002B'/);
  });

  it('scopes every diff rule to its own dialog or log, so neither restyles the other', () => {
    const unscoped = [
      ...css.matchAll(/(?:^|\n|})\s*(\.mcp-diff[^{,]*)\{/g),
    ].map((match) => match[1]?.trim());

    expect(unscoped).toEqual([]);
  });

  it('redefines the diff colours for the dark theme', () => {
    const dark = tokens(declarations(":root[data-theme='dark'] .mcp-confirm"));

    for (const token of [
      '--mcp-diff-del-bg',
      '--mcp-diff-del-fg',
      '--mcp-diff-add-bg',
      '--mcp-diff-add-fg',
      '--mcp-diff-ctx-fg',
      '--mcp-diff-border',
    ])
      expect(dark, token).toContain(token);
  });

  it('paints the destructive «Borrar» from its own red token', () => {
    expect(
      declarations('button.primary.mcp-confirm-apply.is-destructive'),
    ).toMatch(/background:\s*var\(--mcp-danger-fill\)/);
  });
});
