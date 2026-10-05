import type { PanelContext } from './context.js';
import { UNREACHABLE } from './context.js';
import type { PanelElements } from './elements.js';
import { glyph } from './glyphs.js';
import { closeDialog, el, openDialog } from './view.js';

/**
 * «Cambiar de rama»: the group's branches, the current one marked, and a
 * switch that behaves exactly like the tray's (DevBar stops the group's
 * services, checks out and starts them again). A failed switch stays on the
 * sheet with git's reason.
 */

export interface BranchSheet {
  open(groupId: string, current: string | null): void;
}

export function createBranchSheet(
  els: PanelElements['branches'],
  ctx: PanelContext,
): BranchSheet {
  /** Bumped per opening, so a late answer cannot repaint a newer sheet. */
  let round = 0;

  const status = (message: string): void => {
    els.status.textContent = message;
    els.status.hidden = message === '';
  };

  async function pick(
    groupId: string,
    branch: string,
    buttons: HTMLButtonElement[],
  ): Promise<void> {
    for (const each of buttons) each.disabled = true;
    status(`Cambiando a ${branch}…`);
    const answer = await ctx.client
      .call('branch', { groupId, branch })
      .catch(() => null);
    for (const each of buttons) each.disabled = false;
    if (answer?.status === 401) {
      ctx.unlinked();
      return;
    }
    if (answer?.status === 200 && answer.body.ok === true) {
      closeDialog(els.sheet);
      ctx.toast(`Ahora en ${branch}`);
      return;
    }
    const error = answer?.body.error;
    if (!answer) status(UNREACHABLE);
    else
      status(
        typeof error === 'string' && error
          ? error
          : 'No se pudo cambiar de rama.',
      );
  }

  function paint(groupId: string, branches: string[], current: string | null) {
    const buttons = branches.map((branch) => {
      const item = el('button', 'branch-option');
      item.type = 'button';
      item.append(el('span', 'mono', branch));
      if (branch === current) {
        item.setAttribute('aria-current', 'true');
        item.append(glyph('check'));
      }
      return item;
    });
    for (const [index, item] of buttons.entries())
      item.addEventListener(
        'click',
        () => void pick(groupId, branches[index] ?? '', buttons),
      );
    els.list.replaceChildren(
      ...buttons.map((item) => {
        const li = el('li');
        li.append(item);
        return li;
      }),
    );
  }

  els.close.addEventListener('click', () => closeDialog(els.sheet));

  return {
    open: (groupId, current) => {
      const mine = ++round;
      els.list.replaceChildren();
      status('Cargando ramas…');
      openDialog(els.sheet);
      ctx.client.branches(groupId).then(
        (answer) => {
          if (mine !== round) return;
          if (!answer.ok) {
            status(answer.error || 'No se pudieron leer las ramas.');
            return;
          }
          status('');
          paint(groupId, answer.branches, current);
        },
        () => {
          if (mine === round) status(UNREACHABLE);
        },
      );
    },
  };
}
