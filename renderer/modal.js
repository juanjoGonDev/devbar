'use strict';
/* exported wireModal */

/**
 * modal.js — shared behaviour for every in-window modal (.modal <dialog>).
 * There is no native macOS traffic light for an HTML <dialog>, so instead of
 * faking one, every modal closes the honest way: an "×" button (any element
 * with [data-close]), a click on the backdrop, or Esc (native to <dialog>).
 *
 * Markup contract (see styles.css .modal*):
 *   <dialog class="modal">
 *     <header class="modal-header">…<button class="modal-close" data-close>×</button></header>
 *     <div class="modal-body">…</div>
 *     <div class="modal-actions">…optional footer buttons…</div>
 *   </dialog>
 */
function wireModal(dialog) {
  dialog
    .querySelectorAll('[data-close]')
    .forEach((b) => b.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close(); // click outside the content
  });
}
