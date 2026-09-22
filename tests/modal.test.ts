// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';

import { wireModal } from '../renderer/modal.js';

/**
 * `renderer/modal.ts` is the two ways out of every dialog in the app: the
 * controls that say so, and the backdrop. jsdom ships `<dialog>` with its
 * `open` property but none of its methods, so `close()` is installed here with
 * `open` as the single source of truth.
 */
function stubDialogClose(): void {
  const proto = window.HTMLDialogElement.prototype as HTMLDialogElement & {
    close?: () => void;
  };
  proto.close = function close(this: HTMLDialogElement) {
    this.open = false;
  };
}

describe('renderer/modal.ts', () => {
  let dialog: HTMLDialogElement;

  beforeEach(() => {
    stubDialogClose();
    document.body.innerHTML = `
      <dialog id="d" open>
        <div id="inside">
          <button id="save" type="button">Guardar</button>
          <button id="cancel" type="button" data-close>Cancelar</button>
          <button id="x" type="button" data-close>✕</button>
        </div>
      </dialog>`;
    dialog = document.getElementById('d') as HTMLDialogElement;
    wireModal(dialog);
  });

  describe('wireModal', () => {
    it('closes from a control that says it closes', () => {
      document.getElementById('cancel')?.click();
      expect(dialog.open).toBe(false);
    });

    it('wires every such control, not only the first', () => {
      document.getElementById('x')?.click();
      expect(dialog.open).toBe(false);
    });

    it('leaves the controls that do something else alone', () => {
      document.getElementById('save')?.click();
      expect(dialog.open).toBe(true);
    });

    it('closes when the click landed on the backdrop', () => {
      // A click whose target is the dialog ITSELF never reached its content,
      // so it fell on the backdrop around it.
      dialog.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(dialog.open).toBe(false);
    });

    it('stays open for a click inside the dialog body', () => {
      document
        .getElementById('inside')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      expect(dialog.open).toBe(true);
    });
  });
});
