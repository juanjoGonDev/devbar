import type {
  McpAuditFilter,
  McpAuditPage,
} from '../../src/ipc-contract/mcp-api.js';
import { DAY_MS, retentionDays } from '../../src/mcp-audit-labels.js';
import { latestWins } from '../latest-wins.js';
import { confirmDelete, deletedToast, plural } from './mcp-activity-bulk.js';
import { NUMBER } from './mcp-activity-pager.js';
import { placeMenu } from './mcp-activity-place.js';
import {
  deleteByDates,
  type RangeDeleteDeps,
} from './mcp-activity-range-delete.js';
import { wireNumberStepper } from './number-stepper.js';
import { errorMessage } from './toast.js';

/**
 * «Limpiar», at the end of the row over «Actividad»: a popover (the look of
 * the column menus) to delete entries — what the filters and the search
 * match, a range of dates, or the whole log — and to choose after how many
 * days entries go on their own («Borrado automático», 1–365 days).
 *
 * The days are a draft until «Listo» saves them; Escape or a click outside
 * leaves the setting as it was. The hint under them says how many entries
 * there are and since when, or — in the warning colour — how many saving
 * would delete right away because they are already older.
 */

export interface McpCleanElements {
  button: HTMLButtonElement;
  pop: HTMLElement;
  filtered: HTMLButtonElement;
  filteredCount: HTMLElement;
  range: HTMLButtonElement;
  all: HTMLButtonElement;
  allCount: HTMLElement;
  days: HTMLInputElement;
  hint: HTMLElement;
  done: HTMLButtonElement;
}

export interface CleanDeps extends RangeDeleteDeps {
  page(): McpAuditPage | null;
  /** A search or a column filter narrows the log. */
  narrows(): boolean;
  filter(): McpAuditFilter;
  /** Entries went (or the days changed): read the log again. */
  reload(): void;
}

const SHORT_DAY = new Intl.DateTimeFormat('es-ES', {
  day: 'numeric',
  month: 'short',
});

export function createActivityClean(
  els: McpCleanElements,
  deps: CleanDeps,
): void {
  const stepper = wireNumberStepper(els.days);
  const hints = latestWins();

  const isOpen = (): boolean => !els.pop.hidden;
  const saved = (): number => deps.page()?.retentionDays ?? 30;
  const draft = (): number => retentionDays(Number(els.days.value) || saved());

  async function paintHint(): Promise<void> {
    hints.invalidate();
    const current = hints.claim();
    const days = draft();
    try {
      const [all, older] = await Promise.all([
        window.api.getMcpAuditSelectionInfo({ kind: 'all' }),
        window.api.getMcpAuditSelectionInfo({
          kind: 'range',
          to: deps.now() - days * DAY_MS - 1,
        }),
      ]);
      if (!current()) return;
      const goes = older.total;
      els.hint.classList.toggle('is-warn', goes > 0);
      if (goes > 0)
        els.hint.textContent = `Al guardar se eliminarán ${plural(goes, 'entrada', 'entradas')} que ya superan ${plural(days, 'día', 'días')}.`;
      else if (all.oldest === null)
        els.hint.textContent = 'Se revisa cada día. Ahora no hay entradas.';
      else
        els.hint.textContent = `Se revisa cada día. Ahora hay ${plural(all.total, 'entrada', 'entradas')}; la más antigua es del ${SHORT_DAY.format(all.oldest)}.`;
    } catch (err) {
      if (current()) els.hint.textContent = `Error: ${errorMessage(err)}`;
    }
  }

  function paintItems(): void {
    const page = deps.page();
    const narrows = deps.narrows();
    els.filtered.disabled = !narrows || (page?.total ?? 0) === 0;
    els.filteredCount.textContent = narrows
      ? NUMBER.format(page?.total ?? 0)
      : '';
    els.all.disabled = (page?.retained ?? 0) === 0;
    els.allCount.textContent = NUMBER.format(page?.retained ?? 0);
  }

  function open(): void {
    paintItems();
    els.days.value = String(saved());
    stepper.refresh();
    els.hint.classList.remove('is-warn');
    els.hint.textContent = '';
    els.pop.hidden = false;
    els.button.setAttribute('aria-expanded', 'true');
    placeMenu(els.pop);
    void paintHint();
    els.pop.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  }

  function close(refocus: boolean): void {
    if (!isOpen()) return;
    hints.invalidate();
    els.pop.hidden = true;
    els.button.setAttribute('aria-expanded', 'false');
    if (refocus) els.button.focus();
  }

  /** Closes the popover, then runs a flow that may delete entries. */
  function then(flow: () => Promise<boolean>): void {
    close(false);
    void flow().then((changed) => {
      if (changed) deps.reload();
    });
  }

  async function save(): Promise<void> {
    const days = draft();
    close(true);
    if (days === saved()) return;
    try {
      const { deleted } = await window.api.setMcpAuditRetention(days);
      if (deleted > 0) deletedToast(deps, deleted);
      deps.reload();
    } catch (err) {
      deps.showToast(`Error: ${errorMessage(err)}`, 'error');
    }
  }

  els.button.addEventListener('click', () => {
    if (isOpen()) close(false);
    else open();
  });
  els.filtered.addEventListener('click', () =>
    then(() => confirmDelete(deps, { kind: 'query', query: deps.filter() })),
  );
  els.range.addEventListener('click', () => then(() => deleteByDates(deps)));
  els.all.addEventListener('click', () =>
    then(() => confirmDelete(deps, { kind: 'all' })),
  );
  els.days.addEventListener('change', () => void paintHint());
  els.done.addEventListener('click', () => void save());

  document.addEventListener('click', (event) => {
    if (!isOpen()) return;
    const path = event.composedPath();
    if (path.includes(els.pop) || path.includes(els.button)) return;
    close(false);
  });
  document.addEventListener('keydown', (event) => {
    if (!isOpen() || event.key !== 'Escape') return;
    event.preventDefault();
    close(true);
  });
}
