// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import { iconText } from './helpers/icon-text.js';
import type { UpdateStatus } from '../src/ipc-contract.js';
import { tipOf } from './helpers/tip.js';

/**
 * The slim strips under the tray header row (renderer/tray/strip.ts,
 * update-chip.ts), driven through the real tray window.
 * Split from tray-window.test.ts, which covers the rest of the popover.
 */

function updateStatus(version: string | null): UpdateStatus {
  return {
    available: version
      ? {
          version,
          url: `https://example.invalid/${version}`,
          dmgUrl: null,
          zipUrl: null,
          setupUrl: null,
          appImageUrl: null,
          debUrl: null,
        }
      : null,
    staged: null,
    lastCheckAt: null,
    currentVersion: '0.0.0',
    phase: { state: 'idle' },
  };
}

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}

function click(el: Element): void {
  el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
}

/**
 * A strip's visible pieces, one word-group per child: `[download] Descargando
 * 42 %`. Its children are separate spans, so plain text would run together.
 */
function stripText(strip: HTMLElement): string {
  return Array.from(strip.children, (child) =>
    child instanceof HTMLElement && child.matches('.icon[data-icon]')
      ? `[${child.dataset.icon}]`
      : iconText(child),
  )
    .filter(Boolean)
    .join(' ');
}

describe('renderer/tray.ts status strips', () => {
  let tray: RendererWindow | null = null;

  afterEach(() => {
    tray?.close();
    tray = null;
  });

  async function openTray(
    values: Readonly<Record<string, unknown>> = {},
  ): Promise<RendererWindow> {
    tray = await loadRendererWindow({
      html: 'tray.html',
      load: () => import('../renderer/tray.js'),
      values: { platform: 'macos', ...values },
    });
    return tray;
  }

  describe('the update strip', () => {
    const strip = () => byId('update-strip');
    const strips = () => byId('tray-strips');
    const failed = {
      state: 'download-failed',
      version: '9.9.9',
      reason: 'net::ERR_CONNECTION_RESET',
    } as const;

    it('starts hidden, with the whole strip area collapsed', async () => {
      await openTray();
      expect(strip().hidden).toBe(true);
      expect(strips().hidden).toBe(true);
    });

    it('keeps the header row free of update text', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', {
        state: 'downloading',
        version: '9.9.9',
        received: 42,
        total: 100,
      });
      expect(document.getElementById('update-progress-label')).toBeNull();
      expect(
        document.querySelector('.tray-header-row')?.textContent,
      ).not.toContain('Descargando');
    });

    it('shows the download percentage with a progress bar under the header row', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', {
        state: 'downloading',
        version: '9.9.9',
        received: 42,
        total: 100,
      });
      expect(strip().hidden).toBe(false);
      expect(strips().hidden).toBe(false);
      expect(stripText(strip())).toBe('[download] Descargando 42 %');
      expect(tipOf(strip())).toBe('Descargando v9.9.9');
      const bar = strip().querySelector<HTMLElement>('.strip-progress');
      expect(bar?.style.width).toBe('42%');
      expect(bar?.classList.contains('indeterminate')).toBe(false);
    });

    it('shows a download of unknown size without a number', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', {
        state: 'downloading',
        version: '9.9.9',
        received: 42,
        total: null,
      });
      expect(stripText(strip())).toBe('[download] Descargando…');
      expect(
        strip()
          .querySelector('.strip-progress')
          ?.classList.contains('indeterminate'),
      ).toBe(true);
      expect(
        strip().querySelector<HTMLElement>('.strip-progress')?.style
          .animationDelay,
      ).toMatch(/^-[\d.]+ms$/);
    });

    it('names the step that is running', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', {
        state: 'installing',
        version: '9.9.9',
      });
      expect(stripText(strip())).toBe('[package] Instalando…');
      await win.push('onUpdatePhase', { state: 'verifying', version: '9.9.9' });
      expect(stripText(strip())).toBe('[shield-check] Verificando…');
    });

    it('flags a failure with its reason beside it', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', {
        state: 'install-failed',
        version: '9.9.9',
        reason: 'autenticación cancelada',
        path: '/tmp/a.deb',
        command: null,
      });
      expect(strip().querySelector('.strip-title')?.textContent).toBe(
        'Actualización fallida',
      );
      const detail = strip().querySelector<HTMLElement>('.strip-detail');
      expect(detail?.textContent).toBe('autenticación cancelada');
      expect(tipOf(detail)).toBe('autenticación cancelada');
      expect(stripText(strip())).toContain('[triangle-alert]');
    });

    it('retries a failed download through the existing update call', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', failed);
      click(strip().querySelector('.strip-text-btn') ?? strip());
      expect(win.callCount('applyUpdate')).toBe(1);
      expect(win.callCount('checkForUpdates')).toBe(0);
    });

    it('retries a failed check by checking again', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', {
        state: 'check-failed',
        reason: 'sin red',
      });
      const retry = strip().querySelector('.strip-text-btn');
      expect(retry?.textContent).toBe('Reintentar');
      click(retry ?? strip());
      expect(win.callCount('checkForUpdates')).toBe(1);
      expect(win.callCount('applyUpdate')).toBe(0);
    });

    it('says so when the retry itself is refused', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', failed);
      click(strip().querySelector('.strip-text-btn') ?? strip());
      await win.settle('applyUpdate', { ok: false, error: 'sin red' });
      expect(byId('toast').textContent).toBe('No se pudo actualizar: sin red');
    });

    it('can be dismissed until the update moves on', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', failed);
      const dismiss = strip().querySelector('.prestep-cancel');
      expect(dismiss?.getAttribute('aria-label')).toBe('Descartar');
      click(dismiss ?? strip());
      expect(strip().hidden).toBe(true);
      expect(strips().hidden).toBe(true);
      // The same failure pushed again stays dismissed…
      await win.push('onUpdatePhase', failed);
      expect(strip().hidden).toBe(true);
      // …but a new phase shows up again.
      await win.push('onUpdatePhase', { state: 'verifying', version: '9.9.9' });
      expect(strip().hidden).toBe(false);
    });

    it('hides once nothing is happening', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', { state: 'verifying', version: '9.9.9' });
      await win.push('onUpdatePhase', { state: 'idle' });
      expect(strip().hidden).toBe(true);
      expect(strips().hidden).toBe(true);
    });

    it('shows the phase from the initial read when nothing was pushed', async () => {
      const win = await openTray();
      await win.settle('getUpdateStatus', {
        ...updateStatus('9.9.9'),
        phase: { state: 'verifying', version: '9.9.9' },
      });
      expect(stripText(strip())).toBe('[shield-check] Verificando…');
    });
  });
});
