'use strict';

/**
 * changelog.js — shared in-window changelog modal for the tray and config
 * windows. Exposes window.openChangelog(currentVersion): fetches the last
 * GitHub releases and shows them in a .modal <dialog> as collapsible panels
 * (see changelog-view.js), with the notes rendered as HTML (md-mini.js).
 * Uses the shared modal chrome (honest ×, Esc, backdrop) via wireModal.
 *
 * Idempotent: safe to call any number of times. It reuses the one dialog,
 * re-renders content each call, and never double-opens.
 */

let dialog = null;

function build() {
  dialog = document.createElement('dialog');
  dialog.className = 'modal modal-changelog';
  dialog.innerHTML = `
    <header class="modal-header">
      <h2>Changelog</h2>
      <span class="spacer"></span>
      <button type="button" class="small-btn" data-github>Ver en GitHub ↗</button>
      <button type="button" class="modal-close" data-close aria-label="Cerrar">×</button>
    </header>
    <div class="modal-body" data-body></div>
  `;
  document.body.appendChild(dialog);
  wireModal(dialog);
  // Route every rendered link/button with data-href through the OS browser
  // (CSP blocks in-window navigation).
  dialog.addEventListener('click', (e) => {
    const el = e.target.closest('[data-href]');
    if (el) {
      e.preventDefault();
      window.api.openExternal(el.dataset.href);
    }
  });
  return dialog;
}

window.openChangelog = async function openChangelog(current) {
  if (!dialog) build();
  const body = dialog.querySelector('[data-body]');
  body.innerHTML = '<p class="cl-empty">Cargando…</p>';
  if (!dialog.open) dialog.showModal(); // guard: showModal throws if already open

  const { releases = [], repoUrl } = (await window.api.getChangelog()) || {};
  body.innerHTML = window.changelogView.buildReleasesHtml(releases, current, {
    renderMarkdown: window.mdMini.renderMarkdown,
    escapeHtml: window.mdMini.escapeHtml,
  });
  dialog.querySelector('[data-github]').onclick = () =>
    window.api.openExternal(
      repoUrl || 'https://github.com/juanjoGonDev/devbar',
    );
};
