// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { openConfigWindow } from './helpers/config-window.js';
import type { RendererWindow } from './helpers/renderer-dom.js';

async function openReport(): Promise<{
  win: RendererWindow;
  dlg: HTMLDialogElement;
}> {
  const win = await openConfigWindow();
  document
    .getElementById('report-issue')
    ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  const dlg = document.querySelector(
    'dialog.modal-report',
  ) as HTMLDialogElement;
  return { win, dlg };
}

const summary = (dlg: HTMLDialogElement): string =>
  dlg.querySelector('[data-summary]')?.textContent ?? '';

describe('renderer/report-modal.ts', () => {
  let win: RendererWindow | null = null;

  afterEach(() => {
    win?.close();
    win = null;
  });

  it('says how many recent errors and warnings the report carries', async () => {
    const opened = await openReport();
    win = opened.win;
    expect(win.callCount('reportPreview')).toBe(1);
    await win.settle('reportPreview', {
      ok: true,
      text: 'REPORT BODY',
      errors: 3,
      warnings: 5,
    });
    expect(summary(opened.dlg)).toBe(
      'Se incluirán 3 errores y 5 avisos recientes',
    );
  });

  it('uses the singular for one of each', async () => {
    const opened = await openReport();
    win = opened.win;
    await win.settle('reportPreview', {
      ok: true,
      text: '',
      errors: 1,
      warnings: 1,
    });
    expect(summary(opened.dlg)).toBe(
      'Se incluirán 1 error y 1 aviso recientes',
    );
  });

  it('says so when there is nothing to include', async () => {
    const opened = await openReport();
    win = opened.win;
    await win.settle('reportPreview', {
      ok: true,
      text: '',
      errors: 0,
      warnings: 0,
    });
    expect(summary(opened.dlg)).toBe('No hay errores ni avisos recientes');
  });

  it('lets the user read the report before sending it', async () => {
    const opened = await openReport();
    win = opened.win;
    const preview = opened.dlg.querySelector('details[data-preview]');
    expect(preview?.querySelector('summary')?.textContent).toContain(
      'Ver el informe',
    );
    await win.settle('reportPreview', {
      ok: true,
      text: '### Entorno\n- DevBar: 0.10.0',
      errors: 0,
      warnings: 0,
    });
    expect(preview?.querySelector('pre')?.textContent).toBe(
      '### Entorno\n- DevBar: 0.10.0',
    );
  });

  it('stays usable when the preview cannot be built', async () => {
    const opened = await openReport();
    win = opened.win;
    await win.settle('reportPreview', { ok: false, error: 'disk gone' });
    expect(summary(opened.dlg)).toBe('');
    expect(
      opened.dlg.querySelector<HTMLElement>('details[data-preview]')?.hidden,
    ).toBe(true);
    opened.dlg.querySelector<HTMLButtonElement>('[data-copy]')?.click();
    await win.settle('copyReport', { ok: true });
    expect(win.callCount('copyReport')).toBe(1);
  });

  it('ignores a rejected preview', async () => {
    const opened = await openReport();
    win = opened.win;
    await win.fail('reportPreview', new Error('ipc gone'));
    expect(summary(opened.dlg)).toBe('');
  });
});
