import { describe, expect, it } from 'vitest';
import {
  iconForEmoji,
  isIconNameShaped,
  migrateIcons,
} from '../src/groups/icon-migration.js';
import { EMOJI_COLORS, EMOJI_TO_ICON } from '../src/groups/emoji-icons.js';
import { normalizeIconColor } from '../src/icon-color.js';
import { normalizeGroup } from '../src/groups/normalize.js';
import { planStoreMigration } from '../src/groups/migrations.js';
import { validateImportedConfig } from '../src/config-io.js';
import { ICON_CODEPOINTS } from '../renderer/icon-codepoints.js';
import type { Group } from '../src/domain-types.js';

/**
 * Stored icons move from raw emoji to Lucide names. The migration must map
 * what it knows, default what it does not, keep every original, and be a
 * no-op on its own output — it runs on every load.
 */

function group(overrides: Record<string, unknown> = {}): Group {
  return normalizeGroup({
    id: 'g1',
    name: 'api',
    icon: '🚀',
    commands: [{ id: 'c1', name: 'dev', command: 'pnpm dev', icon: '🐳' }],
    actions: [{ id: 'a1', name: 'seed', command: 'pnpm seed', icon: '🌱' }],
    ...overrides,
  });
}

describe('src/groups/icon-migration.ts', () => {
  describe('the emoji table', () => {
    it('only points at icons the bundled font actually draws', () => {
      const missing = Object.entries(EMOJI_TO_ICON).filter(
        ([, name]) => !Object.hasOwn(ICON_CODEPOINTS, name),
      );
      expect(missing).toEqual([]);
    });

    it('covers a real spread of the emoji developers pick', () => {
      expect(Object.keys(EMOJI_TO_ICON).length).toBeGreaterThanOrEqual(150);
      expect(iconForEmoji('📦')).toBe('package');
      expect(iconForEmoji('💡')).toBe('lightbulb');
      expect(iconForEmoji('🤖')).toBe('bot');
      expect(iconForEmoji('🏠')).toBe('house');
      expect(iconForEmoji('🛒')).toBe('shopping-cart');
      expect(iconForEmoji('🔧')).toBe('wrench');
      expect(iconForEmoji('🐳')).toBe('container');
      expect(iconForEmoji('🔒')).toBe('lock');
      expect(iconForEmoji('🚀')).toBe('rocket');
      expect(iconForEmoji('🧪')).toBe('flask-conical');
      // Colour is not a shape: both dots become a circle.
      expect(iconForEmoji('🟢')).toBe('circle');
      expect(iconForEmoji('🔴')).toBe('circle');
    });

    it('looks past presentation selectors, skin tones and ZWJ sequences', () => {
      expect(iconForEmoji('⚙️')).toBe('settings');
      expect(iconForEmoji('🛠️')).toBe('hammer');
      expect(iconForEmoji('👍🏽')).toBe('thumbs-up');
      expect(iconForEmoji('👩‍💻')).toBe('user');
      expect(iconForEmoji(' 🔥 ')).toBe('flame');
    });

    it('has no mapping for what it does not know', () => {
      expect(iconForEmoji('🦄')).toBeNull();
      expect(iconForEmoji('A')).toBeNull();
    });
  });

  it('recognises values that already are icon names', () => {
    expect(isIconNameShaped('package')).toBe(true);
    expect(isIconNameShaped('git-branch')).toBe(true);
    expect(isIconNameShaped('a-arrow-down')).toBe(true);
    expect(isIconNameShaped('📦')).toBe(false);
    expect(isIconNameShaped('Package')).toBe(false);
    expect(isIconNameShaped('two--dashes')).toBe(false);
    expect(isIconNameShaped('')).toBe(false);
  });

  it('converts group, command and action icons and keeps the originals', () => {
    const result = migrateIcons([group()]);
    expect(result.changed).toBe(true);
    expect(result.groups[0]?.icon).toBe('rocket');
    expect(result.groups[0]?.commands[0]?.icon).toBe('container');
    expect(result.groups[0]?.actions[0]?.icon).toBe('sprout');
    expect(result.backup).toEqual({
      'group:g1': '🚀',
      'command:g1/c1': '🐳',
      'action:g1/a1': '🌱',
    });
  });

  it('defaults what it cannot map: the package for a group, the kind default for the rest', () => {
    const result = migrateIcons([
      group({
        icon: '🦄',
        commands: [{ id: 'c1', name: 'dev', command: 'x', icon: '🦄' }],
        actions: [],
      }),
    ]);
    expect(result.groups[0]?.icon).toBe('package');
    expect(result.groups[0]?.commands[0]?.icon).toBeNull();
    // The unknown emoji survives in the backup.
    expect(result.backup['group:g1']).toBe('🦄');
    expect(result.backup['command:g1/c1']).toBe('🦄');
  });

  it('leaves Lucide names and empty command icons alone', () => {
    const clean = group({
      icon: 'rocket',
      commands: [{ id: 'c1', name: 'dev', command: 'x', icon: null }],
      actions: [{ id: 'a1', name: 'seed', command: 'x', icon: 'sprout' }],
    });
    const result = migrateIcons([clean]);
    expect(result.changed).toBe(false);
    expect(result.backup).toEqual({});
    expect(result.groups).toEqual([clean]);
  });

  it('is a no-op on its own output', () => {
    const once = migrateIcons([group()]);
    const twice = migrateIcons(once.groups);
    expect(twice.changed).toBe(false);
    expect(twice.groups).toEqual(once.groups);
  });

  it('gives a new group the package default', () => {
    expect(normalizeGroup({}).icon).toBe('package');
  });

  describe('in the store migration plan', () => {
    const canonical = (icon: string) => ({
      id: 'g1',
      name: 'api',
      icon,
      path: '/api',
      mode: 'multi',
      order: 0,
      silenceWarnings: false,
      silenceErrors: false,
      env: [],
      commands: [],
      actions: [],
      preScripts: [],
      waitForPipeline: true,
    });

    it('rewrites an otherwise canonical v4 store that still holds emoji', () => {
      const plan = planStoreMigration({
        version: 4,
        groups: [canonical('🐳')],
        preSteps: [],
        globalSettings: {},
      });
      expect(plan.changed).toBe(true);
      expect(plan.groups[0]?.icon).toBe('container');
      expect(plan.iconsBackup).toEqual({ 'group:g1': '🐳' });
    });

    it('merges into an earlier backup without overwriting what it holds', () => {
      const plan = planStoreMigration({
        version: 4,
        groups: [canonical('🐳')],
        preSteps: [],
        globalSettings: {},
        _icons_pre_lucide_backup: { 'group:g1': '🚀', 'group:gone': '📦' },
      });
      expect(plan.iconsBackup).toEqual({
        'group:g1': '🚀',
        'group:gone': '📦',
      });
    });

    it('asks for no write once every icon is a name', () => {
      const plan = planStoreMigration({
        version: 4,
        groups: [canonical('container')],
        preSteps: [],
        globalSettings: {},
      });
      expect(plan.changed).toBe(false);
      expect(plan.iconsBackup).toBeNull();
    });
  });

  it('converts the emoji of an imported (older) export', () => {
    const result = validateImportedConfig({
      version: 4,
      groups: [
        {
          id: 'g1',
          name: 'api',
          icon: '🛒',
          path: '/api',
          commands: [{ id: 'c1', name: 'dev', command: 'x', icon: '🔧' }],
          actions: [],
        },
      ],
      preSteps: [],
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.payload.groups[0]?.icon).toBe('shopping-cart');
    expect(result.payload.groups[0]?.commands[0]?.icon).toBe('wrench');
  });

  describe('colour emoji', () => {
    it('carries the colour a coloured emoji meant onto the icon', () => {
      const result = migrateIcons([
        group({
          icon: '🟢',
          commands: [{ id: 'c1', name: 'dev', command: 'x', icon: '🟥' }],
          actions: [{ id: 'a1', name: 'seed', command: 'x', icon: '💙' }],
        }),
      ]);
      const g = result.groups[0];
      expect(g?.icon).toBe('circle');
      expect(g?.iconColor).toBe('#22c55e');
      expect(g?.commands[0]?.icon).toBe('square');
      expect(g?.commands[0]?.iconColor).toBe('#ef4444');
      expect(g?.actions[0]?.icon).toBe('heart');
      expect(g?.actions[0]?.iconColor).toBe('#3b82f6');
    });

    it('recognises the colour past a presentation selector', () => {
      const result = migrateIcons([group({ icon: '❤️' })]);
      expect(result.groups[0]?.iconColor).toBe('#ef4444');
    });

    it('leaves black and white to the text colour', () => {
      for (const emoji of ['⚫', '⬛', '🖤', '⚪', '⬜', '🤍']) {
        const result = migrateIcons([group({ icon: emoji })]);
        expect(result.groups[0]?.iconColor).toBeNull();
      }
    });

    it('never overwrites a colour the user already chose', () => {
      const result = migrateIcons([
        group({ icon: '🔴', iconColor: '#aabbcc' }),
      ]);
      expect(result.groups[0]?.iconColor).toBe('#aabbcc');
    });

    it('colours nothing when the value was not converted', () => {
      const result = migrateIcons([group({ icon: 'circle' })]);
      expect(result.groups[0]?.iconColor).toBeNull();
    });

    it('only uses valid colours, each pointing at a mapped emoji', () => {
      for (const [emoji, color] of Object.entries(EMOJI_COLORS)) {
        expect(normalizeIconColor(color)).toBe(color);
        expect(iconForEmoji(emoji)).not.toBeNull();
      }
    });
  });

  it('never mistakes an uploaded image reference for an emoji', () => {
    const clean = group({
      icon: 'img:0123456789ab',
      commands: [{ id: 'c1', name: 'dev', command: 'x', icon: 'img:abc' }],
      actions: [],
    });
    const result = migrateIcons([clean]);
    expect(result.changed).toBe(false);
    expect(result.groups[0]?.icon).toBe('img:0123456789ab');
  });
});
