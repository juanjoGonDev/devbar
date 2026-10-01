import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every window used to carry its own macOS-only font stack. On Windows the
 * first installed match was 'Segoe UI Emoji', so all body text rendered in an
 * emoji font. The stacks now live once, as custom properties in emoji.css
 * (linked by every window), and name a real text font for each OS.
 */
const RENDERER = path.resolve(import.meta.dirname, '../renderer');
const read = (file: string): string =>
  readFileSync(path.join(RENDERER, file), 'utf8');

function declared(name: string): string {
  const match = read('emoji.css').match(
    new RegExp(`${name}:\\s*([^;]+);`, 's'),
  );
  expect(match, `${name} declared in emoji.css`).not.toBeNull();
  return (match?.[1] ?? '').replace(/\s+/g, ' ');
}

const sources = [
  ...readdirSync(RENDERER)
    .filter((file) => /\.(css|html)$/.test(file))
    .filter((file) => file !== 'emoji.css'),
  'tooltip.ts',
];

describe('renderer font stacks', () => {
  it('names a text font for every OS before the emoji fallbacks', () => {
    const ui = declared('--font-ui');
    for (const family of ['system-ui', "'Segoe UI'", 'Ubuntu', 'Cantarell'])
      expect(ui).toContain(family);
    expect(ui.indexOf("'Segoe UI'")).toBeLessThan(
      ui.indexOf("'Segoe UI Emoji'"),
    );
    expect(ui.trimEnd().endsWith('sans-serif')).toBe(true);
  });

  it('gives the monospace stack a Windows and a Linux font', () => {
    const mono = declared('--font-mono');
    for (const family of ["'Cascadia Mono'", 'Consolas', "'DejaVu Sans Mono'"])
      expect(mono).toContain(family);
    expect(mono.indexOf('Consolas')).toBeLessThan(
      mono.indexOf("'Segoe UI Emoji'"),
    );
    expect(mono.trimEnd().endsWith('monospace')).toBe(true);
  });

  it('keeps every other stylesheet on the shared stacks', () => {
    for (const file of sources) {
      // Inline styles in TS end at the closing quote instead of a ';'.
      const stacks =
        read(file).match(/font-family:\s*[^;"`]+?(?=;|'(?:,|\]|\s*$))/gm) ?? [];
      for (const stack of stacks)
        expect(stack.trim(), file).toMatch(
          /^font-family:\s*(var\(--font-(ui|mono)\)|(inherit|'lucide')( !important)?)$/,
        );
    }
  });

  it('keeps hinting on for log text', () => {
    expect(read('logs.css')).not.toContain('geometricPrecision');
  });
});
