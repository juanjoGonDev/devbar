// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  loadRendererWindow,
  type RendererWindow,
} from './helpers/renderer-dom.js';
import { iconText } from './helpers/icon-text.js';
import type { PipelineState, UpdateStatus } from '../src/ipc-contract.js';

/**
 * The slim strips under the tray header row (renderer/tray/strip.ts,
 * update-chip.ts, pipeline-strip.ts), driven through the real tray window.
 * Split from tray-window.test.ts, which covers the rest of the popover.
 */

function pipelineState(overrides: Partial<PipelineState> = {}): PipelineState {
  return {
    status: 'idle',
    currentStep: null,
    totalSteps: 0,
    lastError: null,
    lastRunId: null,
    startedAt: null,
    ...overrides,
  };
}

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
      expect(strip().title).toBe('Descargando v9.9.9');
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
      expect(detail?.title).toBe('autenticación cancelada');
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

    it('sits above the pipeline strip when both are up', async () => {
      const win = await openTray();
      await win.push('onUpdatePhase', { state: 'verifying', version: '9.9.9' });
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'running', currentStep: 1, totalSteps: 2 }),
      );
      expect(
        Array.from(strips().children)
          .filter((el) => !(el as HTMLElement).hidden)
          .map((el) => el.id),
      ).toEqual(['update-strip', 'pipeline-strip']);
    });
  });

  describe('the pipeline strip', () => {
    const strip = () => byId('pipeline-strip');
    const strips = () => byId('tray-strips');

    it('stays hidden while the pipeline is idle', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ totalSteps: 2, lastRunId: 'run-1' }),
      );
      expect(strip().hidden).toBe(true);
      expect(strips().hidden).toBe(true);
    });

    it('stays hidden when no pipeline is configured', async () => {
      const win = await openTray();
      await win.push('onPipelineUpdate', pipelineState());
      expect(strip().hidden).toBe(true);
    });

    it('shows the step and the elapsed time while it runs', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({
          status: 'running',
          currentStep: 2,
          totalSteps: 3,
          startedAt: Date.now() - 5000,
        }),
      );
      expect(strip().hidden).toBe(false);
      expect(strips().hidden).toBe(false);
      const step = strip().querySelector<HTMLElement>('.strip-title');
      expect(step?.textContent).toBe('Paso 2/3');
      expect(step?.title).toBe('Pipeline: paso 2/3');
      const elapsed = strip().querySelector<HTMLElement>(
        '.uptime[data-started-at]',
      );
      expect(elapsed?.textContent).toBe('5s');
    });

    it('fills a progress bar as the steps go by', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'running', currentStep: 2, totalSteps: 4 }),
      );
      expect(
        strip().querySelector<HTMLElement>('.strip-progress')?.style.width,
      ).toBe('37.5%');
    });

    it('offers to cancel a run in flight', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'running', currentStep: 1, totalSteps: 2 }),
      );
      const cancel = strip().querySelector('.prestep-cancel');
      expect(iconText(cancel)).toBe('[x]');
      expect(cancel?.getAttribute('aria-label')).toBe('Cancelar pipeline');
      click(cancel ?? strip());
      expect(win.callCount('cancelPreScripts')).toBe(1);
    });

    it('opens the log of the run in flight', async () => {
      const openLogs = vi.fn();
      const win = await openTray({ openLogs });
      await win.push(
        'onPipelineUpdate',
        pipelineState({
          status: 'running',
          currentStep: 1,
          totalSteps: 2,
          lastRunId: 'run-7',
        }),
      );
      const logs = strip().querySelector('.prestep-logs-btn');
      expect(iconText(logs)).toBe('[scroll-text]');
      click(logs ?? strip());
      expect(openLogs).toHaveBeenCalledWith('pre-pipeline:run-7');
    });

    it('ticks a finished run', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'done', totalSteps: 2 }),
      );
      expect(stripText(strip())).toBe('[check] Pipeline completado 2 pasos');
      expect(
        strip().querySelector<HTMLElement>('.strip-progress')?.style.width,
      ).toBe('100%');
    });

    it('keeps a finished run reviewable through its log', async () => {
      const openLogs = vi.fn();
      const win = await openTray({ openLogs });
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'done', totalSteps: 1, lastRunId: 'run-7' }),
      );
      click(strip().querySelector('.prestep-logs-btn') ?? strip());
      expect(openLogs).toHaveBeenCalledWith('pre-pipeline:run-7');
    });

    it('names the step that failed', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({
          status: 'error',
          totalSteps: 3,
          lastError: 'step_2_failed',
        }),
      );
      expect(stripText(strip())).toContain('[x] Falló el paso 2/3');
    });

    it('shows what a failure said when it is not a step', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({
          status: 'error',
          totalSteps: 2,
          lastError: 'migración falló',
        }),
      );
      expect(strip().querySelector('.strip-title')?.textContent).toBe(
        'Error en el pipeline',
      );
      expect(strip().querySelector('.strip-detail')?.textContent).toBe(
        'migración falló',
      );
    });

    it('opens the log of a failed run', async () => {
      const openLogs = vi.fn();
      const win = await openTray({ openLogs });
      await win.push(
        'onPipelineUpdate',
        pipelineState({
          status: 'error',
          totalSteps: 2,
          lastError: 'step_1_failed',
          lastRunId: 'run-9',
        }),
      );
      const logs = strip().querySelector('.strip-text-btn');
      expect(logs?.textContent).toBe('Ver logs');
      click(logs ?? strip());
      expect(openLogs).toHaveBeenCalledWith('pre-pipeline:run-9');
    });

    it('lets a failure be dismissed before it clears on its own', async () => {
      const win = await openTray();
      const failure = pipelineState({
        status: 'error',
        totalSteps: 2,
        lastError: 'step_1_failed',
        lastRunId: 'run-9',
      });
      await win.push('onPipelineUpdate', failure);
      click(strip().querySelector('.prestep-cancel') ?? strip());
      expect(strip().hidden).toBe(true);
      await win.push('onPipelineUpdate', failure);
      expect(strip().hidden).toBe(true);
      await win.push(
        'onPipelineUpdate',
        pipelineState({
          status: 'running',
          currentStep: 1,
          totalSteps: 2,
          lastRunId: 'run-10',
        }),
      );
      expect(strip().hidden).toBe(false);
    });

    it('renders the initial read when no push has landed', async () => {
      const win = await openTray();
      await win.settle(
        'getPipelineState',
        pipelineState({ status: 'done', totalSteps: 1 }),
      );
      expect(stripText(strip())).toContain('[check]');
    });

    it('keeps a pushed state that landed before that read resolved', async () => {
      const win = await openTray();
      await win.push(
        'onPipelineUpdate',
        pipelineState({ status: 'error', totalSteps: 1 }),
      );
      await win.settle(
        'getPipelineState',
        pipelineState({ status: 'done', totalSteps: 1 }),
      );
      expect(strip().querySelector('.strip-err')).not.toBeNull();
    });
  });
});
