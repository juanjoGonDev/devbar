/**
 * The optional colour of a user icon (Group/Command/Action.iconColor).
 * `null` means "inherit the text colour", which is what every icon did before
 * colours existed. No imports: the renderer reads the presets from here too.
 */

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

/** A `#rrggbb` colour, lowercased; anything else is `null`. */
export function normalizeIconColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return HEX_COLOR.test(trimmed) ? trimmed.toLowerCase() : null;
}

export interface IconColorPreset {
  label: string;
  value: string;
}

/**
 * Mid-tone hues: saturated enough to tell apart on the light theme's white
 * and still readable on the dark theme's near-black, so one stored colour
 * works under both.
 */
export const ICON_COLOR_PRESETS: readonly IconColorPreset[] = [
  { label: 'Rojo', value: '#ef4444' },
  { label: 'Naranja', value: '#f97316' },
  { label: 'Amarillo', value: '#eab308' },
  { label: 'Verde', value: '#22c55e' },
  { label: 'Turquesa', value: '#14b8a6' },
  { label: 'Azul', value: '#3b82f6' },
  { label: 'Morado', value: '#a855f7' },
  { label: 'Rosa', value: '#ec4899' },
  { label: 'Marrón', value: '#a16207' },
  { label: 'Gris', value: '#6b7280' },
];
