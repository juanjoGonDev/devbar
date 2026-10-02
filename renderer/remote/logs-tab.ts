import type {
  RemoteLogLine,
  RemoteStateView,
} from '../../src/ipc-contract/remote-wire.js';
import type { PanelContext } from './context.js';
import type { PanelElements } from './elements.js';
import { clockTime } from './format.js';
import { el } from './view.js';

/**
 * «Logs»: one process at a time. Opening it reads the tail (300 lines) and
 * subscribes the event stream to that process; live lines are appended after
 * the last one already shown (by position, so a line in both the tail and the
 * stream appears once). The view follows the end until the user scrolls up,
 * and offers «Ir al final» until they come back.
 */

type Filter = 'all' | 'warn' | 'error';
const TAIL = 300;
const KEEP = 1000;
/** Within this many pixels of the end still counts as "at the end". */
const END_SLACK_PX = 24;

interface Target {
  processId: string;
  groupId: string;
  id: string;
  kind: 'command' | 'action';
  status: string;
}

export interface LogsTab {
  render(state: RemoteStateView): void;
  /** The tab came on screen. */
  show(): void;
  /** The process whose lines the stream should carry. */
  selected(): string | null;
  /** The process the next `show` opens on. */
  prefer(processId: string): void;
  append(batch: { id: string; lines: RemoteLogLine[] }): void;
}

function targets(state: RemoteStateView | null): Target[] {
  return (state?.groups ?? []).flatMap((group) => [
    ...group.commands.map((c) => ({
      processId: c.processId,
      groupId: group.id,
      id: c.id,
      kind: 'command' as const,
      status: c.status,
    })),
    ...group.actions.map((a) => ({
      processId: a.processId,
      groupId: group.id,
      id: a.id,
      kind: 'action' as const,
      status: a.status,
    })),
  ]);
}

export function createLogsTab(
  els: PanelElements['logs'],
  ctx: PanelContext,
  onWatch: (processId: string) => void,
): LogsTab {
  let selected: string | null = null;
  let lines: RemoteLogLine[] = [];
  let lastSeq = 0;
  let filter: Filter = 'all';
  let following = true;
  let failed = false;
  /** Bumped per load: an answer for a process no longer shown is dropped. */
  let loadRound = 0;

  const target = (): Target | undefined =>
    targets(ctx.state()).find((t) => t.processId === selected);
  const running = (): boolean => {
    const status = target()?.status ?? 'stopped';
    return status === 'running' || status === 'starting';
  };

  function emptyText(shown: number): string {
    if (failed) return 'No se pudieron leer los logs.';
    if (shown > 0) return '';
    if (lines.length === 0)
      return running()
        ? 'Todavía no hay líneas.'
        : 'Proceso detenido. Inícialo para ver sus logs.';
    return filter === 'error'
      ? 'Sin errores en este proceso.'
      : 'Sin warnings en este proceso.';
  }

  function paint(): void {
    const visible = lines.filter((l) => filter === 'all' || l.level === filter);
    els.countAll.textContent = String(lines.length);
    els.countWarn.textContent = String(
      lines.filter((l) => l.level === 'warn').length,
    );
    els.countError.textContent = String(
      lines.filter((l) => l.level === 'error').length,
    );
    els.panel.replaceChildren(
      ...visible.map((line) => {
        const row = el(
          'div',
          `log-line${line.level ? ` is-${line.level}` : ''}`,
        );
        row.append(
          el('span', 'ts', clockTime(line.ts)),
          el('span', 'msg', line.line),
        );
        return row;
      }),
    );
    const message = emptyText(visible.length);
    els.empty.textContent = message;
    els.empty.hidden = message === '';
    if (following) els.panel.scrollTop = els.panel.scrollHeight;
    els.follow.hidden = following;
  }

  function paintActions(): void {
    els.toggle.textContent = running() ? 'Detener' : 'Iniciar';
    els.toggle.classList.toggle('is-danger', running());
    els.restart.disabled = selected === null;
    els.toggle.disabled = selected === null;
  }

  function fillSelect(state: RemoteStateView): void {
    const groups = state.groups.map((group) => {
      const optgroup = el('optgroup');
      optgroup.label = group.name;
      for (const item of [...group.commands, ...group.actions]) {
        const option = el('option', '', item.name);
        option.value = item.processId;
        optgroup.append(option);
      }
      return optgroup;
    });
    els.process.replaceChildren(...groups);
    if (selected !== null) els.process.value = selected;
  }

  async function load(): Promise<void> {
    const processId = selected;
    if (processId === null) return;
    const round = ++loadRound;
    lines = [];
    lastSeq = 0;
    failed = false;
    following = true;
    paint();
    try {
      const tail = await ctx.client.logs(processId, TAIL);
      if (round !== loadRound) return;
      lines = tail.lines;
      lastSeq = Math.max(tail.seq, lines.at(-1)?.seq ?? 0);
    } catch {
      if (round !== loadRound) return;
      failed = true;
    }
    paint();
  }

  function select(processId: string): void {
    selected = processId;
    els.process.value = processId;
    paintActions();
    onWatch(processId);
    void load();
  }

  const pickDefault = (): string | null => {
    const all = targets(ctx.state());
    const commands = all.filter((t) => t.kind === 'command');
    return (
      commands.find((t) => t.status === 'running')?.processId ??
      commands[0]?.processId ??
      all[0]?.processId ??
      null
    );
  };

  async function restart(): Promise<void> {
    const current = target();
    if (!current) return;
    if (current.kind === 'action') {
      await ctx.run('/api/actions/run', {
        groupId: current.groupId,
        actionId: current.id,
      });
      return;
    }
    const body = { processId: current.processId };
    const stopped = await ctx.run('/api/process/stop', body);
    if (stopped?.status === 200 && stopped.body.ok === true)
      await ctx.run('/api/process/start', body, {
        pending: 'Pendiente de confirmación',
      });
  }

  async function toggle(): Promise<void> {
    const current = target();
    if (!current) return;
    if (running())
      await ctx.run('/api/process/stop', { processId: current.processId });
    else if (current.kind === 'action')
      await ctx.run('/api/actions/run', {
        groupId: current.groupId,
        actionId: current.id,
      });
    else
      await ctx.run(
        '/api/process/start',
        { processId: current.processId },
        {
          pending: 'Pendiente de confirmación',
        },
      );
  }

  els.process.addEventListener('change', () => select(els.process.value));
  for (const control of document.querySelectorAll<HTMLButtonElement>(
    '[data-filter]',
  ))
    control.addEventListener('click', () => {
      filter = (control.dataset.filter as Filter | undefined) ?? 'all';
      for (const each of document.querySelectorAll('[data-filter]'))
        each.setAttribute('aria-pressed', String(each === control));
      paint();
    });
  els.panel.addEventListener('scroll', () => {
    const { scrollTop, scrollHeight, clientHeight } = els.panel;
    following = scrollTop + clientHeight >= scrollHeight - END_SLACK_PX;
    els.follow.hidden = following;
  });
  els.follow.addEventListener('click', () => {
    following = true;
    els.panel.scrollTop = els.panel.scrollHeight;
    els.follow.hidden = true;
  });
  els.restart.addEventListener('click', () => void restart());
  els.toggle.addEventListener('click', () => void toggle());

  return {
    render: (state) => {
      fillSelect(state);
      paintActions();
      if (lines.length === 0) paint();
    },
    show: () => {
      const processId = selected ?? pickDefault();
      if (processId !== null) select(processId);
    },
    selected: () => selected,
    prefer: (processId) => {
      selected = processId;
    },
    append: (batch) => {
      if (batch.id !== selected) return;
      const fresh = batch.lines.filter((line) => line.seq > lastSeq);
      if (fresh.length === 0) return;
      lastSeq = fresh.at(-1)?.seq ?? lastSeq;
      lines = [...lines, ...fresh].slice(-KEEP);
      paint();
    },
  };
}
