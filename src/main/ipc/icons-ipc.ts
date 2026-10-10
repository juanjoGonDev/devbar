import type { IpcMainInvokeEvent } from 'electron';
import { customIconName, isPngDataUrl } from '../../custom-icons.js';
import type { CustomIcon } from '../../domain-types.js';
import { contentId, type CustomIconUpload } from '../custom-icon-upload.js';
import {
  errorMessage,
  ipcStringField,
  type IpcRegistrar,
} from '../ipc-validators.js';

/**
 * The uploaded-image icon library: list, upload, delete. Every change is
 * pushed to all windows (`customIcons:changed`), since the tray, the logs
 * and the config window all paint `img:<id>` references.
 *
 * An SVG upload is two calls: `customIcons:upload` answers the SVG text
 * (nothing stored), the config renderer rasterizes it to a PNG and sends that
 * on `customIcons:addRasterized`. Both paths store only what passes
 * `isPngDataUrl`, so the library never holds an SVG whatever a renderer
 * sends.
 */

export interface IconsIpcDeps {
  configStore: {
    listCustomIcons(): CustomIcon[];
    addCustomIcon(icon: CustomIcon): { icon: CustomIcon; added: boolean };
    deleteCustomIcon(id: string): void;
  };
  /** Dialog → read → decode → PNG (src/main/custom-icon-upload.ts). */
  pickCustomIcon(): Promise<CustomIconUpload>;
  confirm(options: {
    type: 'question' | 'warning';
    buttons: string[];
    defaultId: number;
    cancelId: number;
    message: string;
    detail: string;
  }): Promise<{ response: number }>;
  customIconsChanged(icons: CustomIcon[]): void;
}

export function registerIconsIpc(ipc: IpcRegistrar, deps: IconsIpcDeps): void {
  const { configStore } = deps;
  const changed = (): void =>
    deps.customIconsChanged(configStore.listCustomIcons());

  ipc.handle('customIcons:list', () => configStore.listCustomIcons());

  const store = (candidate: CustomIcon) => {
    // The store drops what it would not keep; say so instead of answering a
    // success for an icon that silently never lands.
    if (!isPngDataUrl(candidate.dataUrl))
      return { ok: false, error: 'La imagen resultante no es válida' };
    try {
      const { icon, added } = configStore.addCustomIcon(candidate);
      if (added) changed();
      return { ok: true, icon };
    } catch (err) {
      return { ok: false, error: errorMessage(err) };
    }
  };

  ipc.handle('customIcons:upload', async () => {
    const upload = await deps.pickCustomIcon();
    if (!upload.ok || 'svg' in upload) return upload;
    return store(upload.icon);
  });

  ipc.handle(
    'customIcons:addRasterized',
    (_e: IpcMainInvokeEvent, payload: unknown) => {
      const name = customIconName(ipcStringField(payload, 'name'));
      const dataUrl = ipcStringField(payload, 'dataUrl');
      // Ided by the PNG bytes: the same SVG rasterizes to the same pixels,
      // so uploading it twice lands on the same icon.
      const pixels = Buffer.from(
        dataUrl.slice(dataUrl.indexOf(',') + 1),
        'base64',
      );
      return store({ id: contentId(pixels), name, dataUrl });
    },
  );

  ipc.handle(
    'customIcons:delete',
    async (_e: IpcMainInvokeEvent, payload: unknown) => {
      const id = ipcStringField(payload, 'id');
      const icon = configStore.listCustomIcons().find((i) => i.id === id);
      if (!icon) return { ok: true };
      const res = await deps.confirm({
        type: 'warning',
        buttons: ['Cancelar', 'Eliminar'],
        defaultId: 0,
        cancelId: 0,
        message: `¿Eliminar el icono «${icon.name}»?`,
        detail:
          'Los grupos, comandos y acciones que lo usan volverán a su icono por defecto.',
      });
      if (res.response !== 1) return { ok: false, canceled: true };
      configStore.deleteCustomIcon(id);
      changed();
      return { ok: true };
    },
  );
}
