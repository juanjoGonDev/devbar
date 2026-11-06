import type { McpAuditSelection } from '../../src/ipc-contract/mcp-api.js';
import { DAY_MS } from '../../src/mcp-audit-labels.js';
import { latestWins } from '../latest-wins.js';
import { deletedToast, plural, type BulkDeps } from './mcp-activity-bulk.js';
import { localInput, timeWindow } from './mcp-activity-model.js';
import { NUMBER } from './mcp-activity-pager.js';
import { midnight } from './mcp-range-dates.js';
import { createRangeView, rangePicker } from './mcp-range-picker.js';
import { errorMessage } from './toast.js';

/**
 * «Eliminar por fechas», from «Limpiar»: a few ready windows — «Más de 7
 * días», «Más de 1 día», «Hoy» — or «Rango…», which brings up the same themed
 * picker as the «Hora» column (Desde / Hasta, a calendar that stops at the
 * oldest day kept, and the time). Below, how many entries the window holds,
 * counted by main as it changes; the red «Eliminar N» deletes them, and is
 * off while there are none.
 */

type Preset = 'older7' | 'older1' | 'today' | 'custom';

const PRESETS: readonly (readonly [Preset, string])[] = [
  ['older7', 'Más de 7 días'],
  ['older1', 'Más de 1 día'],
  ['today', 'Hoy'],
  ['custom', 'Rango…'],
];

export interface RangeDeleteDeps extends BulkDeps {
  now(): number;
  retentionDays(): number;
}

/** The time window a preset (or the picked range) covers at `now`. */
function presetWindow(
  preset: Preset,
  range: { from: string; to: string },
  now: number,
): McpAuditSelection {
  switch (preset) {
    case 'older7':
      return { kind: 'range', to: now - 7 * DAY_MS };
    case 'older1':
      return { kind: 'range', to: now - DAY_MS };
    case 'today':
      return { kind: 'range', from: midnight(now) };
    case 'custom':
      return {
        kind: 'range',
        ...timeWindow({ when: 'custom', ...range }, now),
      };
  }
}

/** Opens the dialog; true once entries were deleted. */
export async function deleteByDates(deps: RangeDeleteDeps): Promise<boolean> {
  const now = deps.now();
  let preset: Preset = 'older7';
  let range = {
    from: localInput(midnight(now - 7 * DAY_MS)),
    to: localInput(now),
  };
  const view = createRangeView();
  const counts = latestWins();
  let total = 0;
  const count = document.createElement('p');
  count.className = 'range-count';
  count.setAttribute('aria-live', 'polite');

  const selection = (): McpAuditSelection => presetWindow(preset, range, now);

  async function recount(): Promise<void> {
    counts.invalidate();
    const current = counts.claim();
    deps.dialog.setOk('Eliminar', true);
    try {
      const info = await window.api.getMcpAuditSelectionInfo(selection());
      if (!current()) return;
      total = info.total;
      const strong = document.createElement('b');
      strong.textContent = plural(total, 'entrada', 'entradas');
      count.replaceChildren('Se eliminarán ', strong, '.');
      deps.dialog.setOk(
        total > 0 ? `Eliminar ${NUMBER.format(total)}` : 'Eliminar',
        total === 0,
      );
    } catch (err) {
      if (current()) count.textContent = `Error: ${errorMessage(err)}`;
    }
  }

  function chips(): HTMLElement {
    const box = document.createElement('div');
    box.className = 'xf-chips';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Qué eliminar');
    for (const [key, label] of PRESETS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'xf-chip';
      chip.textContent = label;
      chip.setAttribute('aria-pressed', String(preset === key));
      chip.addEventListener('click', () => {
        preset = key;
        paint();
        // The chips were rebuilt: focus stays on the one just pressed.
        body
          .querySelector<HTMLElement>(".xf-chip[aria-pressed='true']")
          ?.focus();
      });
      box.append(chip);
    }
    return box;
  }

  const body = document.createElement('div');
  body.className = 'range-del';

  function paint(): void {
    const parts: HTMLElement[] = [chips()];
    if (preset === 'custom')
      parts.push(
        rangePicker({
          value: range,
          now,
          retentionDays: deps.retentionDays(),
          view,
          change: (next) => {
            range = next;
            void recount();
          },
        }),
      );
    parts.push(count);
    body.replaceChildren(...parts);
    void recount();
  }

  const answer = deps.dialog.ask({
    title: 'Eliminar por fechas',
    body: [body],
    ok: 'Eliminar',
    icon: 'calendar-range',
    tone: 'danger',
  });
  paint();
  if (!(await answer)) return false;
  try {
    const { deleted } = await window.api.deleteMcpAudit(selection());
    deletedToast(deps, deleted);
    return true;
  } catch (err) {
    deps.showToast(`Error: ${errorMessage(err)}`, 'error');
    return false;
  }
}
