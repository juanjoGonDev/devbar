import type { CustomIcon } from '../domain-types.js';
import { MAX_CUSTOM_ICONS } from '../custom-icons.js';
import { readCustomIcons, writeCustomIcons } from './store.js';

/**
 * The uploaded-image library. Deleting an icon does not touch the groups that
 * point at it: an unknown `img:<id>` renders the kind's default icon, and
 * since the id is a hash of the file, uploading the same image again brings
 * every reference back.
 */

export function listCustomIcons(): CustomIcon[] {
  return readCustomIcons();
}

/** Adds `icon`, or answers the stored one when the same image is there. */
export function addCustomIcon(icon: CustomIcon): {
  icon: CustomIcon;
  added: boolean;
} {
  const icons = readCustomIcons();
  const existing = icons.find((candidate) => candidate.id === icon.id);
  if (existing) return { icon: existing, added: false };
  if (icons.length >= MAX_CUSTOM_ICONS)
    throw new Error(
      `Ya tienes ${MAX_CUSTOM_ICONS} iconos personalizados — borra alguno antes de subir otro`,
    );
  writeCustomIcons([...icons, icon]);
  return { icon, added: true };
}

export function deleteCustomIcon(id: string): void {
  writeCustomIcons(readCustomIcons().filter((icon) => icon.id !== id));
}
