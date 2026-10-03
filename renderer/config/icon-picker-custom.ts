import { customIconRef } from '../../src/custom-icons.js';
import type { CustomIcon } from '../../src/domain-types.js';
import type {
  CustomIconAddResult,
  CustomIconUploadResult,
} from '../../src/ipc-contract.js';
import { customIconList, icon, iconButton, setCustomIcons } from '../icon.js';
import { rasterizeSvg } from './svg-rasterize.js';

/**
 * The picker's "Mis iconos" tab: the uploaded images, an upload button, and
 * a delete button on each image. Upload and delete run in main (the file
 * dialog, the confirmation); what comes back is applied to this window's
 * library straight away, so the grid never waits for the change push.
 *
 * An SVG comes back from main as text: it is rasterized here (see
 * svg-rasterize.ts) and the PNG is sent back to main to be stored.
 */

export interface CustomIconPanelDeps {
  /** Builds the clickable cell that picks `value` (shared with the other
   *  tabs, so picking, recents and closing behave the same). */
  makeCell(value: string, label: string): HTMLButtonElement;
  /** Picks a freshly uploaded icon, as if its cell had been clicked. */
  select(value: string): void;
  /** Re-renders the panel after the library changed. */
  rerender(): void;
}

/** Settles an upload: a raster one as is, an SVG once rasterized. */
async function storedUpload(
  res: CustomIconUploadResult,
): Promise<CustomIconAddResult> {
  if (!res.ok || !('svg' in res)) return res;
  const raster = await rasterizeSvg(res.svg.text);
  if (!raster.ok) return { ok: false, error: raster.error };
  return window.api.addRasterizedCustomIcon({
    name: res.svg.name,
    dataUrl: raster.dataUrl,
  });
}

function upsert(added: CustomIcon): void {
  const icons = customIconList();
  if (!icons.some((existing) => existing.id === added.id))
    setCustomIcons([...icons, added]);
}

function remove(id: string): void {
  setCustomIcons(customIconList().filter((item) => item.id !== id));
}

function customCell(item: CustomIcon, deps: CustomIconPanelDeps): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'icon-cell-wrap';
  const cell = deps.makeCell(customIconRef(item.id), item.name);
  const del = iconButton('x', `Eliminar «${item.name}»`, 'icon-cell-delete');
  del.addEventListener('click', async (event) => {
    event.stopPropagation();
    const res = await window.api.deleteCustomIcon(item.id);
    if (!res.ok) return;
    remove(item.id);
    deps.rerender();
  });
  wrap.append(cell, del);
  return wrap;
}

export function renderCustomIconPanel(
  host: HTMLElement,
  deps: CustomIconPanelDeps,
): void {
  const bar = document.createElement('div');
  bar.className = 'icon-custom-bar';
  const upload = document.createElement('button');
  upload.type = 'button';
  upload.className = 'small-btn icon-upload-btn with-icon';
  upload.append(icon('upload'), 'Subir imagen…');
  const status = document.createElement('span');
  status.className = 'icon-custom-status muted small';
  upload.addEventListener('click', async () => {
    upload.disabled = true;
    status.textContent = '';
    try {
      const res = await storedUpload(await window.api.uploadCustomIcon());
      if (res.ok) {
        upsert(res.icon);
        deps.select(customIconRef(res.icon.id));
      } else if (!res.canceled) {
        status.textContent = res.error ?? 'No se pudo subir la imagen';
      }
    } catch {
      status.textContent = 'No se pudo subir la imagen';
    } finally {
      upload.disabled = false;
    }
  });
  bar.append(upload, status);

  const icons = customIconList();
  const body = document.createElement('div');
  if (icons.length) {
    body.className = 'icon-grid';
    for (const item of icons) body.append(customCell(item, deps));
  } else {
    body.className = 'icon-custom-empty muted small';
    body.textContent =
      'PNG, JPG o SVG, hasta 5 MB (1 MB si es SVG). Se reduce a 64 px.';
  }
  host.append(bar, body);
}
