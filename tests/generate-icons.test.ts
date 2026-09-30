import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  buildIconModules,
  readLucideMetadata,
} from '../scripts/generate-icons.js';
import { ICON_CODEPOINTS } from '../renderer/icon-codepoints.js';
import { ICON_BATTERY } from '../src/icon-battery.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

describe('scripts/generate-icons.ts', () => {
  const info = {
    'a-arrow-down': { encodedCode: '\\e585' },
    package: { encodedCode: '\\e0a1' },
    // An alias: in the font, but not a canonical (tagged) icon.
    'package-2': { encodedCode: '\\e0a2' },
  };
  const tags = {
    package: ['box', 'container'],
    'a-arrow-down': ['letter', 'font size'],
    // Tagged but no longer in the font (a removed brand icon).
    github: ['logo'],
  };

  it('maps every glyph the font carries to its codepoint, sorted', () => {
    const { codepoints } = buildIconModules(info, tags, '9.9.9');
    expect(codepoints).toContain('lucide-static@9.9.9');
    expect(codepoints).toContain("  'a-arrow-down': 0xe585,\n");
    expect(codepoints).toContain("  'package-2': 0xe0a2,\n");
    expect(codepoints.indexOf("'a-arrow-down'")).toBeLessThan(
      codepoints.indexOf("'package'"),
    );
  });

  it('lists only canonical icons the font carries, with their tags', () => {
    const { battery } = buildIconModules(info, tags, '9.9.9');
    expect(battery).toContain(
      "  { name: 'package', tags: ['box', 'container'] },\n",
    );
    expect(battery).not.toContain('github');
    expect(battery).not.toContain("'package-2'");
  });

  it('escapes quotes and backslashes in tags', () => {
    const { battery } = buildIconModules(
      info,
      { package: ["it's", 'a\\b'] },
      '1.0.0',
    );
    expect(battery).toContain("tags: ['it\\'s', 'a\\\\b']");
  });

  it('rejects a codepoint it cannot parse', () => {
    expect(() =>
      buildIconModules({ bad: { encodedCode: 'zz' } }, {}, '1.0.0'),
    ).toThrow(/bad/);
  });

  it('keeps the checked-in modules in sync with the pinned lucide-static', () => {
    // Bumping lucide-static without re-running `pnpm generate:icons` would
    // ship names the font no longer has (or miss new ones).
    const meta = readLucideMetadata(root);
    const { codepoints, battery } = buildIconModules(
      meta.info,
      meta.tags,
      meta.version,
    );
    expect(
      readFileSync(path.join(root, 'renderer', 'icon-codepoints.ts'), 'utf8'),
    ).toBe(codepoints);
    expect(
      readFileSync(path.join(root, 'src', 'icon-battery.ts'), 'utf8'),
    ).toBe(battery);
  });

  it('exposes the generated data as importable modules', () => {
    expect(ICON_CODEPOINTS['package']).toBeGreaterThanOrEqual(0xe000);
    expect(ICON_BATTERY.length).toBeGreaterThan(1000);
    expect(ICON_BATTERY.every((item) => item.name in ICON_CODEPOINTS)).toBe(
      true,
    );
  });
});
