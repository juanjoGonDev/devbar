/**
 * Group/Command/Action icons used to be raw emoji; they are now Lucide icon
 * names painted from the bundled font (renderer/icon.ts). This converts the
 * old values: the closest Lucide icon for a common emoji, a default for
 * anything else, and the originals kept aside so nothing is lost.
 *
 * Content-based and idempotent — a value already shaped like an icon name is
 * left alone — so it runs on every store load and on every import (an old
 * export still carries emoji) without a schema-version bump that would make
 * new exports unreadable by older builds.
 */
import type { Group } from '../domain-types.js';
import { EMOJI_COLORS, EMOJI_TO_ICON } from './emoji-icons.js';

/** The default a group gets when it has no icon, or one that maps to none. */
export const DEFAULT_GROUP_ICON = 'package';

/** Lucide names are lowercase words joined by single dashes. */
const ICON_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isIconNameShaped(value: string): boolean {
  return ICON_NAME.test(value);
}

/**
 * Emoji spellings vary: the same pictograph may arrive with or without the
 * emoji presentation selector (U+FE0F), a skin tone, or a text-style keycap
 * joiner. Strip those before the lookup.
 */
function canonicalEmoji(value: string): string {
  return value
    .trim()
    .replace(/[\u{FE0E}\u{FE0F}]/gu, '')
    .replace(/[\u{1F3FB}-\u{1F3FF}]/gu, '');
}

/** The Lucide icon for a stored emoji, or null when there is no mapping. */
export function iconForEmoji(value: string): string | null {
  return (
    EMOJI_TO_ICON[value] ??
    EMOJI_TO_ICON[canonicalEmoji(value)] ??
    // A ZWJ sequence (👨‍💻) keeps its base pictograph's meaning.
    EMOJI_TO_ICON[canonicalEmoji(value).split('‍')[0] ?? ''] ??
    null
  );
}

/** The colour a coloured emoji (🟢, 🟥, 💙…) stood for, or null. */
function colorForEmoji(value: string): string | null {
  return EMOJI_COLORS[value] ?? EMOJI_COLORS[canonicalEmoji(value)] ?? null;
}

/** `img:<id>` points at an uploaded image; it is not an emoji to convert. */
function isImageRef(value: string): boolean {
  return value.startsWith('img:');
}

export interface IconMigration {
  changed: boolean;
  groups: Group[];
  /** Original values of every icon that was converted, keyed
   *  `group:<id>`, `command:<groupId>/<id>` or `action:<groupId>/<id>`. */
  backup: Record<string, string>;
}

export function migrateIcons(groups: readonly Group[]): IconMigration {
  const backup: Record<string, string> = {};
  let changed = false;

  /** The converted icon and colour of one entity. The colour only follows a
   *  conversion, and never replaces one the entity already has. */
  const convert = <T extends { icon: string | null; iconColor: string | null }>(
    entity: T,
    key: string,
    fallback: string | null,
  ): { icon: string | null; iconColor: string | null } => {
    const value = entity.icon;
    if (
      value === null ||
      value === '' ||
      isIconNameShaped(value) ||
      isImageRef(value)
    )
      return { icon: value, iconColor: entity.iconColor };
    changed = true;
    backup[key] = value;
    return {
      icon: iconForEmoji(value) ?? fallback,
      iconColor: entity.iconColor ?? colorForEmoji(value),
    };
  };

  const migrated = groups.map((group) => {
    const own = convert(group, `group:${group.id}`, DEFAULT_GROUP_ICON);
    return {
      ...group,
      icon: own.icon ?? DEFAULT_GROUP_ICON,
      iconColor: own.iconColor,
      // null means "the kind's default icon" — the right landing spot for an
      // emoji with no Lucide counterpart.
      commands: group.commands.map((command) => ({
        ...command,
        ...convert(command, `command:${group.id}/${command.id}`, null),
      })),
      actions: group.actions.map((action) => ({
        ...action,
        ...convert(action, `action:${group.id}/${action.id}`, null),
      })),
    };
  });
  return { changed, groups: changed ? migrated : [...groups], backup };
}
