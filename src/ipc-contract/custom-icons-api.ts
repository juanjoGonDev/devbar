import type { CustomIcon } from '../domain-types.js';

/** A stored upload, or why there is none. */
export type CustomIconAddResult =
  | { ok: true; icon: CustomIcon }
  | { ok: false; canceled?: boolean; error?: string };

/**
 * What the upload dialog answers. A PNG/JPEG is stored straight away; an SVG
 * comes back as text, stored only once the renderer has rasterized it and
 * sent the PNG to `addRasterizedCustomIcon`.
 */
export type CustomIconUploadResult =
  CustomIconAddResult | { ok: true; svg: { name: string; text: string } };

/** The uploaded-image icon library calls of the window API (part of `DevBarApi`). */
export interface CustomIconsApi {
  listCustomIcons(): Promise<CustomIcon[]>;
  /** Opens the file dialog in main. */
  uploadCustomIcon(): Promise<CustomIconUploadResult>;
  /** Stores the PNG data URL rasterized from an SVG upload. */
  addRasterizedCustomIcon(png: {
    name: string;
    dataUrl: string;
  }): Promise<CustomIconAddResult>;
  /** Asks for confirmation in main before deleting. */
  deleteCustomIcon(id: string): Promise<{ ok: boolean; canceled?: boolean }>;
  onCustomIconsChanged(callback: (icons: CustomIcon[]) => void): () => void;
}
